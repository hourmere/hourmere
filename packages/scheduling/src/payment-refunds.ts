import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import type { PaymentMode } from './payment-provider.ts'

const MAX_ATTEMPTS = 6
const BATCH_SIZE = 5
const LEASE_SECONDS = 30
// Stripe v1 can prune idempotency keys after 24 hours. Leave room for clock skew and
// transport delays. An expired operation stays in the ledger for operator reconciliation.
const RETRY_HOURS = 23

interface RefundBinding {
  accountId: string
  mode: string
}

interface RefundPayment extends RefundBinding {
  paymentReference: string
  amountMinor: number
  currency: string
}

export interface StripeRefundObservation extends Omit<RefundPayment, keyof RefundBinding> {
  id: string
  obligationId: string | null
  state: 'pending' | 'succeeded' | 'failed'
}

export interface PaymentRefundProvider extends RefundBinding {
  mode: PaymentMode
  createRefund(
    input: RefundPayment & {
      obligationId: string
      idempotencyKey: string
      canDispatch: () => Promise<boolean>
    },
  ): Promise<StripeRefundObservation>
}

/** Provider errors are deliberately encoded without SDK details or request data. */
export class PaymentRefundProviderError extends Error {
  readonly transient: boolean

  constructor(transient: boolean) {
    super(transient ? 'Stripe refund temporarily unavailable' : 'Stripe refund rejected')
    this.transient = transient
  }
}

/** Shared by authorized cancellation and by a fully bound late-payment observation. */
export async function ensurePaymentRefund(trx: Db, input: RefundPayment & { attemptId: string }) {
  await trx
    .insertInto('payment_refund_obligations')
    .values({
      attempt_id: input.attemptId,
      account_id: input.accountId,
      mode: input.mode,
      payment_reference: input.paymentReference,
      amount_minor: input.amountMinor,
      currency: input.currency,
    })
    .onConflict((conflict) => conflict.column('attempt_id').doNothing())
    .execute()
}

/** Failed provider refunds stay failed even if a delayed success or pending snapshot arrives. */
export async function applyStripeRefundObservation(
  trx: Db,
  binding: RefundBinding,
  refund: StripeRefundObservation,
  leaseToken?: string,
) {
  let update = trx
    .updateTable('payment_refund_obligations')
    .set({
      state: refund.state,
      stripe_refund_id: refund.id,
      lease_token: null,
      lease_expires_at: null,
      last_error: refund.state === 'failed' ? 'provider_refund_failed' : null,
    })
    .where('account_id', '=', binding.accountId)
    .where('mode', '=', binding.mode)
    .where('payment_reference', '=', refund.paymentReference)
    .where('amount_minor', '=', refund.amountMinor)
    .where('currency', '=', refund.currency)
    .where('first_attempted_at', 'is not', null)
    .where((eb) =>
      eb.or([eb('stripe_refund_id', 'is', null), eb('stripe_refund_id', '=', refund.id)]),
    )
  update = refund.obligationId
    ? update.where('id', '=', refund.obligationId)
    : update.where('stripe_refund_id', '=', refund.id)
  if (leaseToken) update = update.where('lease_token', '=', leaseToken)
  // Stripe can fail a refund after reporting success. A local API failure with no bound
  // Stripe refund ID can still be resolved by a subsequent verified observation.
  if (refund.state !== 'failed')
    update = update.where((eb) =>
      eb.or([eb('state', '!=', 'failed'), eb('stripe_refund_id', 'is', null)]),
    )
  if (refund.state === 'pending') update = update.where('state', '!=', 'succeeded')
  return Boolean(await update.returning('id').executeTakeFirst())
}

async function claimRefund(db: Db, provider: PaymentRefundProvider) {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('payment_refund_obligations')
      .selectAll()
      .select(
        sql<boolean>`first_attempted_at <= clock_timestamp() - ${RETRY_HOURS} * interval '1 hour'`.as(
          'retry_window_elapsed',
        ),
      )
      .where('account_id', '=', provider.accountId)
      .where('mode', '=', provider.mode)
      .where('state', '=', 'requested')
      .where('next_attempt_at', '<=', sql<Date>`clock_timestamp()`)
      .where((eb) =>
        eb.or([
          eb('lease_expires_at', 'is', null),
          eb('lease_expires_at', '<=', sql<Date>`clock_timestamp()`),
        ]),
      )
      .orderBy('next_attempt_at')
      .orderBy('id')
      .forUpdate()
      .skipLocked()
      .limit(1)
      .executeTakeFirst()
    if (!row) return null
    if (row.retry_window_elapsed || row.attempts >= MAX_ATTEMPTS) {
      await trx
        .updateTable('payment_refund_obligations')
        .set({
          state: 'failed',
          lease_token: null,
          lease_expires_at: null,
          last_error: row.retry_window_elapsed ? 'retry_window_elapsed' : 'retry_exhausted',
        })
        .where('id', '=', row.id)
        .execute()
      return { kind: 'failed' as const }
    }

    const token = randomUUID()
    const attempt = row.attempts + 1
    await trx
      .updateTable('payment_refund_obligations')
      .set({
        attempts: attempt,
        first_attempted_at: sql`coalesce(first_attempted_at, clock_timestamp())`,
        lease_token: token,
        lease_expires_at: sql`clock_timestamp() + ${LEASE_SECONDS} * interval '1 second'`,
      })
      .where('id', '=', row.id)
      .execute()
    return { kind: 'claimed' as const, row, token, attempt }
  })
}

async function canDispatchRefund(db: Db, id: string, token: string, signal?: AbortSignal) {
  if (signal?.aborted) return false
  const active = await db
    .selectFrom('payment_refund_obligations')
    .select('id')
    .where('id', '=', id)
    .where('lease_token', '=', token)
    .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
    .where(
      'first_attempted_at',
      '>',
      sql<Date>`clock_timestamp() - ${RETRY_HOURS} * interval '1 hour'`,
    )
    .executeTakeFirst()
  return Boolean(active) && !signal?.aborted
}

/** The refund ledger is the queue. No DB lock or connection is held during Stripe I/O. */
export async function runPaymentRefunds(
  db: Db,
  provider: PaymentRefundProvider,
  signal?: AbortSignal,
) {
  const report = { attempted: 0, failed: 0 }
  for (let i = 0; i < BATCH_SIZE && !signal?.aborted; i++) {
    const claim = await claimRefund(db, provider)
    if (!claim) break
    if (claim.kind === 'failed') {
      report.failed++
      continue
    }
    const { row, token, attempt } = claim
    report.attempted++
    let refund: StripeRefundObservation
    try {
      refund = await provider.createRefund({
        obligationId: row.id,
        accountId: row.account_id,
        mode: row.mode,
        paymentReference: row.payment_reference,
        amountMinor: row.amount_minor,
        currency: row.currency,
        idempotencyKey: `hourmere-refund-${row.id}`,
        canDispatch: () => canDispatchRefund(db, row.id, token, signal),
      })
    } catch (error) {
      const transient = error instanceof PaymentRefundProviderError && error.transient
      const retry = transient && attempt < MAX_ATTEMPTS
      const saved = await db
        .updateTable('payment_refund_obligations')
        .set({
          state: retry ? 'requested' : 'failed',
          lease_token: null,
          lease_expires_at: null,
          next_attempt_at: sql`clock_timestamp() + ${2 ** (attempt - 1)} * interval '1 minute'`,
          last_error: retry
            ? 'provider_unavailable'
            : transient
              ? 'retry_exhausted'
              : 'provider_rejected',
        })
        .where('id', '=', row.id)
        .where('lease_token', '=', token)
        .returning('id')
        .executeTakeFirst()
      if (!retry && saved) report.failed++
      continue
    }
    const saved = await applyStripeRefundObservation(db, provider, refund, token)
    if (saved && refund.state === 'failed') report.failed++
  }
  return report
}
