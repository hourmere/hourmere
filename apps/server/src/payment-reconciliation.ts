import type { Db } from '@hourmere/db'
import { checkoutSessionExpiry } from '@hourmere/scheduling'
import { latestBookingId } from '@hourmere/scheduling/booking-chain'
import { type NotNull, sql } from 'kysely'
import { z } from 'zod'
import {
  StripeReconciliationError,
  type StripeReconciliationProvider,
} from './stripe-reconciliation.ts'

const DEFAULT_BATCH_SIZE = 20
const MAX_BATCH_SIZE = 50
const STRIPE_CONCURRENCY = 4
const eventId = z.string().regex(/^evt_[A-Za-z0-9_]{1,200}$/)

interface ReconciliationOptions {
  limit?: number
  after?: string
}

export function paymentReconciliationPage(options: ReconciliationOptions) {
  const limit = z
    .int()
    .min(1)
    .max(MAX_BATCH_SIZE)
    .parse(options.limit ?? DEFAULT_BATCH_SIZE)
  let cursor: { type: 'booking' | 'event'; id: string } | undefined
  if (options.after?.startsWith('booking:'))
    cursor = { type: 'booking', id: z.uuid().parse(options.after.slice('booking:'.length)) }
  else if (options.after?.startsWith('event:'))
    cursor = { type: 'event', id: eventId.parse(options.after.slice('event:'.length)) }
  else if (options.after !== undefined) throw new Error('Invalid payment reconciliation cursor')
  return { limit, cursor }
}

interface Finding {
  code: string
  bookingId?: string
  obligationId?: string
  eventId?: string
  sessionId?: string
  paymentReference?: string
  refundId?: string
  reason?: string
  resource?: 'checkout' | 'payment_intent' | 'refunds'
}

function localBookings(db: Db, after: string | undefined, limit: number) {
  let query = db
    .selectFrom('bookings as root')
    .leftJoin('payment_checkout_attempts as attempt', 'attempt.booking_id', 'root.id')
    .leftJoin('bookings as current', 'current.id', 'attempt.current_booking_id')
    .leftJoin('payment_refund_obligations as refund', 'refund.attempt_id', 'attempt.id')
    .select([
      'root.id',
      'root.status',
      'root.payment_hold_expires_at',
      'root.payment_reference',
      'root.payment_confirmed_at',
      'root.payment_refund_required',
      'attempt.id as attempt_id',
      'attempt.started_at',
      'attempt.session_id',
      'attempt.account_id',
      'attempt.mode',
      'attempt.amount_minor',
      'attempt.currency',
      'attempt.current_booking_id',
      'current.status as current_status',
      'refund.id as obligation_id',
      'refund.state as refund_state',
      'refund.stripe_refund_id',
      'refund.last_error as refund_error',
      'refund.account_id as refund_account_id',
      'refund.mode as refund_mode',
      'refund.payment_reference as refund_payment_reference',
      'refund.amount_minor as refund_amount_minor',
      'refund.currency as refund_currency',
    ])
    .select([
      sql<boolean>`root.payment_hold_expires_at <= clock_timestamp()`.as('deadline_passed'),
      sql<boolean>`root.organization_id = current.organization_id AND
        root.event_type_id IS NOT DISTINCT FROM current.event_type_id AND
        root.end_at - root.start_at = current.end_at - current.start_at`.as('same_booking_terms'),
      sql<boolean>`${latestBookingId(sql.ref('root.id'))} = coalesce(current.id, root.id)`.as(
        'current_matches_chain',
      ),
    ])
    .where('root.payment_hold_expires_at', 'is not', null)
    .$narrowType<{ payment_hold_expires_at: NotNull }>()
    .orderBy('root.id')
    .limit(limit)
  if (after !== undefined) query = query.where('root.id', '>', after)
  return query.execute()
}

type LocalBooking = Awaited<ReturnType<typeof localBookings>>[number]
type ReportFinding = (code: string, details?: Partial<Finding>) => void

function safeReadError(error: unknown) {
  if (error instanceof StripeReconciliationError) return error.code
  throw error
}

async function compareCheckout(
  provider: StripeReconciliationProvider,
  row: LocalBooking,
  report: ReportFinding,
) {
  if (!row.attempt_id || !row.started_at) return null
  try {
    const expiresAt = row.payment_hold_expires_at.toISOString()
    const session = row.session_id
      ? await provider.retrieveCheckout(row.session_id)
      : await provider.findCheckout({
          attemptId: row.attempt_id,
          startedAt: row.started_at.toISOString(),
          expiresAt,
        })
    if (!session) {
      report('stripe_checkout_missing')
      return null
    }
    const details = { sessionId: session.id }
    if (
      session.livemode !== (provider.mode === 'live') ||
      session.mode !== 'payment' ||
      (session.ui_mode !== 'hosted_page' && session.ui_mode !== 'hosted') ||
      session.amount_total !== row.amount_minor ||
      session.currency !== row.currency ||
      session.expires_at !== checkoutSessionExpiry(expiresAt) ||
      session.client_reference_id !== row.attempt_id ||
      session.metadata?.hourmere_checkout_attempt_id !== row.attempt_id ||
      session.metadata?.hourmere_booking_id !== row.id ||
      (row.session_id !== null && session.id !== row.session_id)
    ) {
      report('stripe_checkout_binding_mismatch', {
        ...details,
        paymentReference: session.payment_intent ?? undefined,
      })
      return null
    }
    if (!row.session_id) report('local_checkout_session_missing', details)
    const paid = session.status === 'complete' && session.payment_status === 'paid'
    if (paid && session.payment_intent && !row.payment_reference) {
      report(
        row.status === 'pending_payment' && !row.deadline_passed
          ? 'stripe_payment_unconfirmed'
          : 'stripe_payment_after_release',
        { ...details, paymentReference: session.payment_intent },
      )
    }
    if (
      (session.status === 'complete' && (!paid || !session.payment_intent)) ||
      (row.payment_reference !== null &&
        (!paid || session.payment_intent !== row.payment_reference))
    )
      report('stripe_checkout_payment_mismatch', details)
    if (session.status === 'open' && (row.status !== 'pending_payment' || row.deadline_passed))
      report('stripe_checkout_open_after_release', details)
    if (session.status === 'expired' && row.status === 'pending_payment' && !row.deadline_passed)
      report('stripe_checkout_expired_before_deadline', details)
    return { paymentReference: session.payment_intent, paid }
  } catch (error) {
    report(safeReadError(error), { resource: 'checkout' })
    return null
  }
}

async function compareRefunds(
  provider: StripeReconciliationProvider,
  row: LocalBooking,
  paymentReference: string,
  report: ReportFinding,
) {
  try {
    const { refunds, complete } = await provider.listRefunds(paymentReference)
    const matching = refunds.filter(
      (refund) =>
        refund.id === row.stripe_refund_id ||
        (refund.obligationId === row.obligation_id && row.obligation_id !== null),
    )
    const details = { paymentReference }
    if (!complete) report('stripe_refund_scan_incomplete', details)
    if (matching.length > 1) report('stripe_refund_multiple_matches', details)
    if (refunds.length > matching.length) report('stripe_external_refund', details)
    for (const refund of matching) {
      const refundDetails = { ...details, refundId: refund.id }
      if (
        refund.amountMinor !== row.amount_minor ||
        refund.currency !== row.currency ||
        refund.obligationId !== row.obligation_id ||
        (row.stripe_refund_id !== null && refund.id !== row.stripe_refund_id)
      )
        report('stripe_refund_binding_mismatch', refundDetails)
      else {
        if (row.stripe_refund_id === null) report('local_stripe_refund_id_missing', refundDetails)
        if (refund.state !== row.refund_state) report('stripe_refund_state_mismatch', refundDetails)
      }
    }
    if (complete && row.stripe_refund_id && matching.length === 0)
      report('stripe_refund_missing', details)
  } catch (error) {
    report(safeReadError(error), { paymentReference, resource: 'refunds' })
  }
}

async function compareBooking(
  provider: StripeReconciliationProvider,
  row: LocalBooking,
  stripeError: string | null,
) {
  const findings: Finding[] = []
  const report: ReportFinding = (code, details) =>
    findings.push({
      code,
      bookingId: row.id,
      obligationId: row.obligation_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      paymentReference: row.payment_reference ?? undefined,
      refundId: row.stripe_refund_id ?? undefined,
      ...details,
    })
  const status = row.current_status ?? row.status
  if (row.status === 'pending_payment' && row.deadline_passed) report('local_hold_overdue')
  if (
    !row.current_matches_chain ||
    (row.current_booking_id &&
      (!row.same_booking_terms ||
        row.status !== 'cancelled' ||
        !row.payment_confirmed_at ||
        (status !== 'confirmed' && status !== 'cancelled')))
  )
    report('local_payment_association_mismatch')
  const refundExpected =
    row.payment_refund_required || (row.payment_confirmed_at && status === 'cancelled')
  if (refundExpected && !row.obligation_id) report('local_refund_obligation_missing')
  if (row.obligation_id) {
    if (!refundExpected) report('local_refund_obligation_unexpected')
    if (
      row.refund_account_id !== row.account_id ||
      row.refund_mode !== row.mode ||
      row.refund_payment_reference !== row.payment_reference ||
      row.refund_amount_minor !== row.amount_minor ||
      row.refund_currency !== row.currency
    )
      report('local_refund_binding_mismatch')
  }
  if (row.refund_state === 'failed') {
    const error = row.refund_error
    const reason = [
      'provider_rejected',
      'provider_refund_failed',
      'retry_exhausted',
      'retry_window_elapsed',
    ].find((code) => code === error)
    report('local_refund_failed', { reason })
  }
  if (!row.attempt_id) {
    report('local_checkout_attempt_missing')
    return findings
  }
  if (row.account_id !== provider.accountId || row.mode !== provider.mode) {
    report('local_stripe_account_or_mode_mismatch')
    return findings
  }
  if (stripeError) return findings
  const checkout = await compareCheckout(provider, row, report)
  const reference = row.payment_reference ?? checkout?.paymentReference
  if (!reference) return findings

  let captured = false
  try {
    const intent = await provider.retrievePaymentIntent(reference)
    if (!intent) report('stripe_payment_intent_missing', { paymentReference: reference })
    else {
      captured = intent.status === 'succeeded'
      if (
        intent.id !== reference ||
        intent.livemode !== (provider.mode === 'live') ||
        intent.amount !== row.amount_minor ||
        intent.currency !== row.currency ||
        (captured && intent.amount_received !== row.amount_minor) ||
        ((row.payment_reference !== null || checkout?.paid) && !captured)
      )
        report('stripe_payment_intent_mismatch', { paymentReference: reference })
      if (captured && checkout && !checkout.paid && !row.payment_reference)
        report('stripe_payment_unconfirmed', { paymentReference: reference })
    }
  } catch (error) {
    report(safeReadError(error), { paymentReference: reference, resource: 'payment_intent' })
  }
  if (captured || row.payment_reference || checkout?.paid)
    await compareRefunds(provider, row, reference, report)
  return findings
}

/** Operator audit. Each page releases its database connection before any Stripe calls. */
export async function reconcileStripePayments(
  db: Db,
  provider: StripeReconciliationProvider,
  options: ReconciliationOptions = {},
) {
  const { limit, cursor } = paymentReconciliationPage(options)
  const local = cursor?.type === 'event' ? [] : await localBookings(db, cursor?.id, limit + 1)
  const bookings = local.slice(0, limit)
  const eventLimit = limit - bookings.length
  const events =
    local.length > limit
      ? []
      : await db
          .selectFrom('payment_stripe_events')
          .select(['event_id', 'session_id', 'payment_reference'])
          .where('finding', 'is not', null)
          .where('account_id', '=', provider.accountId)
          .where('mode', '=', provider.mode)
          .$if(cursor?.type === 'event', (query) => query.where('event_id', '>', cursor?.id ?? ''))
          .orderBy('event_id')
          .limit(eventLimit + 1)
          .execute()

  let stripeError: string | null = null
  if (
    bookings.some(
      (row) =>
        row.account_id === provider.accountId &&
        row.mode === provider.mode &&
        (row.started_at || row.payment_reference),
    )
  ) {
    try {
      await provider.verifyAccount()
    } catch (error) {
      stripeError = safeReadError(error)
    }
  }
  const findings: Finding[] = []
  for (let first = 0; first < bookings.length; first += STRIPE_CONCURRENCY) {
    const group = await Promise.all(
      bookings
        .slice(first, first + STRIPE_CONCURRENCY)
        .map((booking) => compareBooking(provider, booking, stripeError)),
    )
    findings.push(...group.flat())
  }
  const webhookFindings = events.slice(0, eventLimit)
  for (const event of webhookFindings)
    findings.push({
      code: 'signed_paid_checkout_binding_mismatch',
      eventId: event.event_id,
      sessionId: event.session_id ?? undefined,
      paymentReference: event.payment_reference ?? undefined,
    })
  const lastEvent = webhookFindings.at(-1)
  const lastBooking = bookings.at(-1)
  let nextCursor: string | null = null
  if (events.length > eventLimit && lastEvent) nextCursor = `event:${lastEvent.event_id}`
  else if ((local.length > limit || events.length > eventLimit) && lastBooking)
    nextCursor = `booking:${lastBooking.id}`

  return {
    checkedBookings: bookings.length,
    checkedWebhookFindings: webhookFindings.length,
    stripeError,
    nextCursor,
    findings,
  }
}
