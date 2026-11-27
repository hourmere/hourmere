import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isPaidEventSupported } from '@hourmere/core/payment'
import type { Db } from '@hourmere/db'
import { type NotNull, sql } from 'kysely'
import { findPublicEventType, selectDurationMinutes, toIso } from './availability.ts'
import {
  type CreateBookingInput,
  canonicalJson,
  insertBooking,
  lockHosts,
  prepareBookingAttendees,
  requireOfferedSlot,
  resolveBookingLocation,
  sha256,
  validateInvitee,
} from './bookings.ts'
import { cutoffsOf } from './change-deadlines.ts'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { selectLocationOption } from './location-options.ts'
import { createNotificationSnapshot } from './notification-settings.ts'
import { expirePaymentHolds } from './payment-expiry.ts'
import {
  type CheckoutOperation,
  type CheckoutSession,
  checkoutSessionExpiry,
  PAYMENT_HOLD_MINUTES,
  type PaymentMode,
  type PaymentProvider,
} from './payment-provider.ts'
import {
  applyStripeRefundObservation,
  ensurePaymentRefund,
  type StripeRefundObservation,
} from './payment-refunds.ts'
import { validateResponses } from './questions.ts'
import {
  type BookingSuccessRedirect,
  bookingSuccessRedirect,
  validateSuccessRedirect,
} from './success-redirect.ts'

export { PAYMENT_HOLD_MINUTES }
export interface PaymentContext extends PublicContext {
  paidBookingsEnabled?: boolean | undefined
  paymentProvider?: PaymentProvider | undefined
}

export interface PaymentPrice {
  amountMinor: number
  currency: string
}

interface PublicPaymentContext extends PaymentContext {
  paymentStatusSecret?: string | undefined
}

const disabled = () =>
  new DomainError('conflict', 'paid_bookings_disabled', 'Paid bookings are disabled')

/** Internal only. The optional price comes from trusted server code, never booking input. */
export async function createPaymentHold(
  ctx: PaymentContext,
  input: CreateBookingInput,
  trustedPrice?: PaymentPrice,
  publicCheckoutSecret?: string,
): Promise<{
  id: string
  status: string
  expiresAt: string
  checkout?: { sessionId: string; url: string }
}> {
  if (ctx.paidBookingsEnabled !== true) throw disabled()
  const provider = ctx.paymentProvider
  const price = trustedPrice && {
    amountMinor: trustedPrice.amountMinor,
    currency: trustedPrice.currency,
  }
  if (price) {
    if (!provider) throw new DomainError('conflict', 'payment_provider_unavailable')
    if (
      !Number.isInteger(price.amountMinor) ||
      price.amountMinor < 1 ||
      price.amountMinor > 99_999_999 ||
      !/^[a-z]{3}$/.test(price.currency)
    )
      throw new DomainError('invalid', 'invalid_payment_price')
  }
  if (!input.idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey))
    throw new DomainError('invalid', 'invalid_idempotency_key')
  if (input.waitlistToken || input.guests?.length)
    throw new DomainError('invalid', 'payment_flow_unsupported')
  const invitee = publicCheckoutSecret
    ? prepareBookingAttendees(input).invitee
    : validateInvitee(input.invitee)
  const event = await findPublicEventType(ctx.db, input.handle, input.slug, {
    scimResourcesEnabled: ctx.scimResourcesEnabled,
  })
  if (!event) throw new DomainError('not_found', 'event_type_not_found')
  const key = input.idempotencyKey
  const bookingInput = { ...input, start: input.start.toString() }
  const fingerprint = createHash('sha256')
    .update(canonicalJson(price ? { bookingInput, price } : bookingInput))
    .digest()
  const hold = await ctx.db.transaction().execute(async (trx) => {
    await lockOrganization(trx, event.organizationId)
    await lockHosts(trx, event.hostUserIds)
    for (const hostUserId of event.hostUserIds) await expirePaymentHolds({ db: trx, hostUserId })
    const existing = await trx
      .selectFrom('bookings')
      .select(['id', 'status', 'payment_hold_expires_at', 'idempotency_fingerprint'])
      .where('organization_id', '=', event.organizationId)
      .where('payment_idempotency_key', '=', key)
      .where('api_key_id', 'is', null)
      .where('oauth_consent_id', 'is', null)
      .forUpdate()
      .executeTakeFirst()
    if (existing) {
      if (
        !existing.payment_hold_expires_at ||
        !existing.idempotency_fingerprint?.equals(fingerprint)
      )
        throw new DomainError('conflict', 'idempotency_key_reused')
      // The bounded sweep can skip this row while another transaction holds it.
      // Decide its deadline again after acquiring the replay row lock.
      const expiredReplay =
        existing.status === 'pending_payment'
          ? await trx
              .updateTable('bookings')
              .set({ status: 'expired' })
              .where('id', '=', existing.id)
              .where('status', '=', 'pending_payment')
              .where('payment_hold_expires_at', '<=', sql<Date>`clock_timestamp()`)
              .returning('status')
              .executeTakeFirst()
          : undefined
      return {
        id: existing.id,
        status: expiredReplay?.status ?? existing.status,
        expiresAt: existing.payment_hold_expires_at.toISOString(),
      }
    }
    const current = await findPublicEventType(trx, input.handle, input.slug, {
      lock: true,
      scimResourcesEnabled: ctx.scimResourcesEnabled,
    })
    if (
      !current ||
      current.id !== event.id ||
      current.hostUserIds.join() !== event.hostUserIds.join()
    )
      throw new DomainError('conflict', 'event_type_unavailable')
    const model = await trx
      .selectFrom('event_types')
      .select([
        'booking_mode',
        'notifications',
        'reschedule_cutoff_minutes',
        'cancel_cutoff_minutes',
        'recurrence',
      ])
      .where('id', '=', current.id)
      .executeTakeFirstOrThrow()
    if (
      current.schedulingType !== 'individual' ||
      current.hostUserIds.length !== 1 ||
      model.booking_mode !== 'individual'
    )
      throw new DomainError('invalid', 'payment_flow_unsupported')
    if (publicCheckoutSecret) {
      if (!current.payment) throw new DomainError('conflict', 'payment_price_changed')
      if (input.smsConsent && !(ctx.smsRemindersAvailable && current.smsRemindersEnabled))
        throw new DomainError('invalid', 'payment_flow_unsupported')
      const personal = await trx
        .selectFrom('personal_organizations')
        .select('organization_id')
        .where('organization_id', '=', current.organizationId)
        .where('user_id', '=', current.hostUserId)
        .executeTakeFirst()
      if (
        !isPaidEventSupported({
          personal: Boolean(personal),
          schedulingType: current.schedulingType,
          bookingMode: model.booking_mode,
          hostCount: current.hostUserIds.length,
          allowGuests: current.allowGuests,
          waitlistEnabled: current.waitlistEnabled,
          recurringEnabled: model.recurrence !== null,
          locationKinds: (current.locations ?? []).map((location) => location.kind),
        })
      )
        throw new DomainError('invalid', 'payment_flow_unsupported')
    }
    // Gate the option this hold would store: the invitee's choice, or the default without one.
    const chosen = selectLocationOption(current.locations, input.locationOptionId)
    if (chosen?.kind === 'google_meet' || chosen?.kind === 'zoom' || chosen?.kind === 'phone')
      throw new DomainError('invalid', 'payment_flow_unsupported')
    const responses = validateResponses(current.questions, input.responses ?? {})
    const duration = selectDurationMinutes(current, input.durationMinutes)
    let charge = price
    if (publicCheckoutSecret) {
      const amount = current.payment?.prices.find(
        (entry) => entry.durationMinutes === duration,
      )?.amountMinor
      const currency = current.payment?.currency
      if (
        !price ||
        !amount ||
        !currency ||
        price.currency !== currency ||
        price.amountMinor !== amount
      )
        throw new DomainError('conflict', 'payment_price_changed')
      charge = { amountMinor: amount, currency }
    }
    const end = input.start.add({ minutes: duration })
    const now = Temporal.Instant.from((await checkoutClock(trx)).toISOString())
    const hasFullPaymentWindow =
      Temporal.Instant.compare(input.start, now.add({ minutes: PAYMENT_HOLD_MINUTES })) >= 0
    if (!hasFullPaymentWindow)
      throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
    await requireOfferedSlot(trx, {
      eventTypeId: current.id,
      hostUserId: current.hostUserId,
      start: input.start,
      end,
      now,
      durationMinutes: duration,
    })
    const choice = await resolveBookingLocation(ctx, trx, current, current.hostUserIds, input)
    const expiresAt = now
      .add({ minutes: PAYMENT_HOLD_MINUTES })
      .toString({ smallestUnit: 'millisecond' })
    const { id } = await insertBooking(trx, {
      organizationId: current.organizationId,
      eventTypeId: current.id,
      start: input.start,
      end,
      title: `${current.title} with ${invitee.name}`,
      location: choice.location,
      locationOption: choice.locationOption,
      responses,
      source: 'web',
      apiKeyId: null,
      hostUserIds: current.hostUserIds,
      hostsUseDefaultSchedule: false,
      attendees: [invitee],
      notificationSnapshot: createNotificationSnapshot(model.notifications),
      changeCutoffs: cutoffsOf(model),
      manageTokenHash: null,
      successRedirect: publicCheckoutSecret
        ? paymentSuccessRedirect(ctx, current, invitee, input.start, end)
        : undefined,
      paymentHoldExpiresAt: expiresAt,
    })
    await trx
      .updateTable('bookings')
      .set({
        payment_idempotency_key: key,
        idempotency_fingerprint: fingerprint,
        ...(publicCheckoutSecret && {
          manage_token_hash: sha256(checkoutManageToken(publicCheckoutSecret, id, key)),
        }),
      })
      .where('id', '=', id)
      .execute()
    if (charge && provider) {
      const attemptId = randomUUID()
      await trx
        .insertInto('payment_checkout_attempts')
        .values({
          id: attemptId,
          booking_id: id,
          account_id: provider.accountId,
          mode: provider.mode,
          amount_minor: charge.amountMinor,
          currency: charge.currency,
          idempotency_key: `hourmere_checkout_${attemptId}`,
        })
        .execute()
    }
    return { id, status: 'pending_payment', expiresAt }
  })
  if (price && hold.status === 'pending_payment') {
    try {
      return { ...hold, checkout: await createPaymentCheckout(ctx, hold.id) }
    } catch (error) {
      // The browser can poll the protected local outcome if the provider completed
      // before an exact replay arrived. An ambiguous create can still be retried.
      if (
        publicCheckoutSecret &&
        error instanceof DomainError &&
        error.code === 'payment_hold_inactive'
      )
        return hold
      throw error
    }
  }
  return hold
}

async function lockCheckoutHold(db: Db, id: string) {
  const hold = await db
    .selectFrom('bookings')
    .select(['status', 'payment_hold_expires_at', 'manage_token_hash'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!hold?.payment_hold_expires_at) throw new DomainError('not_found', 'booking_not_found')
  return {
    status: hold.status,
    deadline: hold.payment_hold_expires_at,
    publicReturn: hold.manage_token_hash !== null,
  }
}

async function checkoutClock(db: Db) {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)
  return (rows[0] as { now: Date }).now
}

/** Internal only. The booking row serializes the one durable submission and all hold transitions. */
export async function createPaymentCheckout(ctx: PaymentContext, id: string) {
  if (ctx.paidBookingsEnabled !== true) throw disabled()
  const provider = ctx.paymentProvider
  if (!provider) throw new DomainError('conflict', 'payment_provider_unavailable')
  const { operation, shouldCreate, sessionId } = await ctx.db.transaction().execute(async (trx) => {
    const hold = await lockCheckoutHold(trx, id)
    const now = await checkoutClock(trx)
    if (hold.status !== 'pending_payment' || hold.deadline <= now)
      throw new DomainError('conflict', 'payment_hold_inactive')
    const attempt = await trx
      .selectFrom('payment_checkout_attempts')
      .selectAll()
      .where('booking_id', '=', id)
      .executeTakeFirst()
    if (!attempt) throw new DomainError('conflict', 'payment_checkout_not_prepared')
    if (attempt.account_id !== provider.accountId || attempt.mode !== provider.mode)
      throw new DomainError('conflict', 'payment_provider_binding_mismatch')
    if (!attempt.started_at)
      await trx
        .updateTable('payment_checkout_attempts')
        .set({ started_at: now })
        .where('id', '=', attempt.id)
        .execute()
    const operation: CheckoutOperation = {
      attemptId: attempt.id,
      bookingId: id,
      accountId: attempt.account_id,
      mode: provider.mode,
      amountMinor: attempt.amount_minor,
      currency: attempt.currency,
      expiresAt: hold.deadline.toISOString(),
      idempotencyKey: attempt.idempotency_key,
      startedAt: (attempt.started_at ?? now).toISOString(),
      ...(hold.publicReturn && { publicReturn: true as const }),
    }
    return { operation, shouldCreate: attempt.started_at === null, sessionId: attempt.session_id }
  })

  // The committed marker survives process loss and Stripe's idempotency-cache expiry.
  // Only its owner submits a POST. A retry can reconcile even if that POST is still in flight.
  let session: CheckoutSession | null
  try {
    if (sessionId) session = await provider.retrieveCheckout(operation, sessionId)
    else if (shouldCreate) session = await provider.createCheckout(operation)
    else session = await provider.findCheckout(operation)
  } catch {
    throw new DomainError('conflict', 'payment_checkout_unavailable')
  }
  if (!session) throw new DomainError('conflict', 'payment_checkout_unresolved')
  const { sessionId: observedId, url } = session
  const active = await ctx.db.transaction().execute(async (trx) => {
    const hold = await lockCheckoutHold(trx, id)
    const attempt = await trx
      .selectFrom('payment_checkout_attempts')
      .select('session_id')
      .where('id', '=', operation.attemptId)
      .executeTakeFirstOrThrow()
    if (attempt.session_id && attempt.session_id !== observedId)
      throw new DomainError('conflict', 'payment_checkout_session_mismatch')
    // Retain the Session binding even if cancellation won during provider I/O.
    if (!attempt.session_id)
      await trx
        .updateTable('payment_checkout_attempts')
        .set({ session_id: observedId })
        .where('id', '=', operation.attemptId)
        .execute()
    return hold.status === 'pending_payment' && hold.deadline > (await checkoutClock(trx))
  })
  if (!active) throw new DomainError('conflict', 'payment_hold_inactive')
  if (!url) throw new DomainError('conflict', 'payment_checkout_unavailable')
  return { sessionId: observedId, url }
}

function paymentSuccessRedirect(
  ctx: PublicContext,
  event: NonNullable<Awaited<ReturnType<typeof findPublicEventType>>>,
  invitee: ReturnType<typeof validateInvitee>,
  start: Temporal.Instant,
  end: Temporal.Instant,
) {
  try {
    return bookingSuccessRedirect(
      validateSuccessRedirect(event.successRedirect, ctx.successRedirectPolicy),
      {
        eventTypeSlug: event.slug,
        start: toIso(start),
        end: toIso(end),
        timeZone: invitee.timeZone,
        hostName: event.hostName,
        inviteeName: invitee.name,
        inviteeEmail: invitee.email,
      },
    )
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'invalid_success_redirect') throw error
    return undefined
  }
}

function checkoutDigest(secret: string, purpose: 'status' | 'manage', id: string, key: string) {
  return createHmac('sha256', secret).update(`paid-checkout:${purpose}:${id}:${key}`).digest()
}

function checkoutManageToken(secret: string, id: string, key: string) {
  return checkoutDigest(secret, 'manage', id, key).toString('base64url')
}

const publicCheckoutNotFound = () => new DomainError('not_found', 'payment_checkout_not_found')
const PUBLIC_CHECKOUT_TOKEN = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** The caller's quote is a precondition. The locked event determines the price. */
export async function startPublicCheckout(
  ctx: PublicPaymentContext,
  input: CreateBookingInput,
  quote: PaymentPrice,
) {
  const secret = ctx.paymentStatusSecret
  if (!secret || !ctx.paymentProvider) throw disabled()
  const key = input.idempotencyKey
  if (!key || !UUID.test(key)) throw new DomainError('invalid', 'invalid_idempotency_key')
  const scopedKey = `checkout:v1:${key}`
  const hold = await createPaymentHold(ctx, { ...input, idempotencyKey: scopedKey }, quote, secret)
  const attempt = await ctx.db
    .selectFrom('payment_checkout_attempts')
    .select('id')
    .where('booking_id', '=', hold.id)
    .executeTakeFirstOrThrow()
  return {
    statusToken: `${attempt.id}.${checkoutDigest(secret, 'status', attempt.id, scopedKey).toString('base64url')}`,
    expiresAt: hold.expiresAt,
    ...(hold.checkout && { checkoutUrl: hold.checkout.url }),
  }
}

type CheckoutStatus = 'pending_payment' | 'expired' | 'cancelled' | 'paid'
type CheckoutRefundStatus = 'requested' | 'pending' | 'succeeded' | 'failed'

export interface PublicCheckoutStatus {
  status: CheckoutStatus
  refundStatus?: CheckoutRefundStatus
  latePayment?: true
  manageToken?: string
  successRedirect?: BookingSuccessRedirect
}

async function publicCheckoutRow(ctx: PublicPaymentContext, token: string, lock: boolean) {
  const secret = ctx.paymentStatusSecret
  const [, id, hash] = PUBLIC_CHECKOUT_TOKEN.exec(token) ?? []
  if (!secret || !id || !UUID.test(id) || !hash) throw publicCheckoutNotFound()
  const query = ctx.db
    .selectFrom('bookings as b')
    .innerJoin('payment_checkout_attempts as attempt', 'attempt.booking_id', 'b.id')
    .leftJoin('bookings as successor', 'successor.id', 'attempt.current_booking_id')
    .leftJoin('payment_refund_obligations as refund', 'refund.attempt_id', 'attempt.id')
    .select([
      'b.id as id',
      'b.payment_idempotency_key as key',
      'b.payment_hold_expires_at as deadline',
      'b.payment_confirmed_at as confirmedAt',
      'b.payment_refund_required as latePayment',
      'b.success_redirect as successRedirect',
      'attempt.current_booking_id as currentBookingId',
      'refund.state as refundStatus',
    ])
    .select(sql<string>`coalesce(successor.status, b.status)`.as('status'))
    .select(
      sql<Buffer | null>`case when successor.id is null then b.manage_token_hash else successor.manage_token_hash end`.as(
        'manageTokenHash',
      ),
    )
    .select(sql<boolean>`b.payment_hold_expires_at <= clock_timestamp()`.as('due'))
    .where('attempt.id', '=', id)
  const row = await (lock ? query.forUpdate('b') : query).executeTakeFirst()
  if (
    !row?.key ||
    !row.deadline ||
    !timingSafeEqual(checkoutDigest(secret, 'status', id, row.key), Buffer.from(hash, 'base64url'))
  )
    throw publicCheckoutNotFound()
  return { secret, ...row, key: row.key, deadline: row.deadline }
}

/** Status reads only our database. A return URL or Stripe object ID confers no authority. */
export async function getPublicCheckoutStatus(
  ctx: PublicPaymentContext,
  token: string,
): Promise<PublicCheckoutStatus> {
  const row = await publicCheckoutRow(ctx, token, false)
  const status: CheckoutStatus =
    row.status === 'confirmed'
      ? 'paid'
      : row.status === 'cancelled'
        ? 'cancelled'
        : row.status === 'expired' || row.due
          ? 'expired'
          : 'pending_payment'
  const manageToken = row.confirmedAt && checkoutManageToken(row.secret, row.id, row.key)
  return {
    status,
    ...(row.refundStatus && { refundStatus: row.refundStatus as CheckoutRefundStatus }),
    ...(row.latePayment && { latePayment: true as const }),
    ...(manageToken && row.manageTokenHash?.equals(sha256(manageToken)) && { manageToken }),
    ...(status === 'paid' &&
      !row.currentBookingId &&
      row.successRedirect && {
        successRedirect: row.successRedirect as unknown as BookingSuccessRedirect,
      }),
  }
}

/** Cancellation races the signed payment observation on the same booking lock. */
export async function cancelPublicCheckout(
  ctx: PublicPaymentContext,
  token: string,
): Promise<PublicCheckoutStatus> {
  await ctx.db.transaction().execute(async (db) => {
    const row = await publicCheckoutRow({ ...ctx, db }, token, true)
    if (row.status !== 'pending_payment') return
    const now = await checkoutClock(db)
    const expired = row.deadline <= now
    await db
      .updateTable('bookings')
      .set({
        status: expired ? 'expired' : 'cancelled',
        cancelled_at: expired ? null : now,
      })
      .where('id', '=', row.id)
      .execute()
  })
  return getPublicCheckoutStatus(ctx, token)
}

async function lockPaymentHold(db: Db, id: string) {
  return db
    .selectFrom('bookings')
    .select([
      'id',
      'status',
      'start_at',
      'payment_hold_expires_at',
      'payment_reference',
      'payment_confirmed_at',
    ])
    .where('id', '=', id)
    .where('payment_hold_expires_at', 'is not', null)
    .$narrowType<{ payment_hold_expires_at: NotNull }>()
    .forUpdate()
    .executeTakeFirst()
}

async function paymentTransaction<T>(db: Db, apply: (trx: Db) => Promise<T>): Promise<T> {
  const run = () => db.transaction().execute(apply)
  try {
    return await run()
  } catch (error) {
    // Retry the receipt transaction if the confirmation deadline or another attempt's
    // unique binding changed after the read. The next pass sees the committed state.
    if (
      typeof error === 'object' &&
      error !== null &&
      'constraint' in error &&
      (error.constraint === 'bookings_payment_confirmation' ||
        error.constraint === 'bookings_payment_reference' ||
        error.constraint === 'payment_checkout_attempts_session_id_key')
    )
      return run()
    throw error
  }
}

async function confirmLockedPaymentHold(
  trx: Db,
  ctx: Pick<PublicContext, 'notify' | 'now'>,
  row: NonNullable<Awaited<ReturnType<typeof lockPaymentHold>>>,
  paymentReference: string,
): Promise<'confirmed' | 'refund_required'> {
  if (row.payment_reference) {
    if (row.payment_reference !== paymentReference)
      throw new DomainError('conflict', 'payment_reference_mismatch')
    return row.payment_confirmed_at ? 'confirmed' : 'refund_required'
  }
  const { rows } = await sql<{
    active: boolean
  }>`SELECT ${row.payment_hold_expires_at}::timestamptz > clock_timestamp() AS active`.execute(trx)
  const confirm = row.status === 'pending_payment' && rows[0]?.active
  await trx
    .updateTable('bookings')
    .set({
      status: confirm ? 'confirmed' : row.status === 'cancelled' ? 'cancelled' : 'expired',
      payment_reference: paymentReference,
      payment_refund_required: !confirm,
    })
    .where('id', '=', row.id)
    .execute()
  if (confirm)
    await ctx.notify?.(
      trx,
      {
        type: 'created',
        bookingId: row.id,
        start: Temporal.Instant.from(row.start_at.toISOString()),
      },
      ctx.now(),
    )
  return confirm ? 'confirmed' : 'refund_required'
}

/** Internal hold foundation. Priced Checkout requires a bound Session observation below. */
export async function confirmPaymentHold(
  ctx: PaymentContext,
  id: string,
  paymentReference: string,
): Promise<{ id: string; outcome: 'confirmed' | 'refund_required' }> {
  if (!/^pi_[A-Za-z0-9_]{1,200}$/.test(paymentReference))
    throw new DomainError('invalid', 'invalid_payment_reference')
  return paymentTransaction(ctx.db, async (trx) => {
    const row = await lockPaymentHold(trx, id)
    if (!row) throw new DomainError('not_found', 'booking_not_found')
    const checkout = await trx
      .selectFrom('payment_checkout_attempts')
      .select('id')
      .where('booking_id', '=', id)
      .executeTakeFirst()
    if (checkout) throw new DomainError('conflict', 'payment_provider_binding_mismatch')
    return { id, outcome: await confirmLockedPaymentHold(trx, ctx, row, paymentReference) }
  })
}

interface StripeCheckoutObservation {
  attemptId: string
  bookingId: string
  sessionId: string
  amountMinor: number
  currency: string
  expiresAtSeconds: number
  /** Only a completed, paid Session supplies a PaymentIntent. */
  paymentReference: string | null
}

interface PaidCheckoutIdentity {
  sessionId: string
  paymentReference: string
  tagged: boolean
  clientReferenceId: string | undefined
}

async function ensureCheckoutRefund(
  trx: Db,
  attempt: { id: string; account_id: string; mode: string; amount_minor: number; currency: string },
  paymentReference: string,
) {
  await ensurePaymentRefund(trx, {
    attemptId: attempt.id,
    accountId: attempt.account_id,
    mode: attempt.mode,
    amountMinor: attempt.amount_minor,
    currency: attempt.currency,
    paymentReference,
  })
}

async function recordPaidCheckoutMismatch(
  trx: Db,
  binding: { accountId: string; mode: PaymentMode },
  eventId: string,
  paid: PaidCheckoutIdentity | undefined,
) {
  if (!paid) return
  if (!paid.tagged) {
    const known = await trx
      .selectFrom('payment_checkout_attempts')
      .select('id')
      .where('account_id', '=', binding.accountId)
      .where('mode', '=', binding.mode)
      .where((eb) =>
        eb.or([
          eb('session_id', '=', paid.sessionId),
          ...(paid.clientReferenceId ? [eb('id', '=', paid.clientReferenceId)] : []),
        ]),
      )
      .executeTakeFirst()
    if (!known) return
  }
  // A mismatched observation cannot authorize a refund or a booking transition.
  await trx
    .updateTable('payment_stripe_events')
    .set({
      finding: 'paid_checkout_binding_mismatch',
      account_id: binding.accountId,
      mode: binding.mode,
      session_id: paid.sessionId,
      payment_reference: paid.paymentReference,
    })
    .where('event_id', '=', eventId)
    .execute()
}

/** A receipt and its local effects commit together. No provider I/O happens here. */
export async function recordStripePaymentEvent(
  ctx: Pick<PublicContext, 'db' | 'notify' | 'now'>,
  binding: { accountId: string; mode: PaymentMode },
  eventId: string,
  observations: {
    checkout?: StripeCheckoutObservation | undefined
    paidCheckout?: PaidCheckoutIdentity | undefined
    refund?: StripeRefundObservation | undefined
  } = {},
): Promise<void> {
  await paymentTransaction(ctx.db, async (trx) => {
    const receipt = await trx
      .insertInto('payment_stripe_events')
      .values({ event_id: eventId })
      .onConflict((conflict) => conflict.column('event_id').doNothing())
      .returning('event_id')
      .executeTakeFirst()
    if (!receipt) return
    const { checkout, paidCheckout, refund } = observations
    if (refund) {
      await applyStripeRefundObservation(trx, binding, refund)
      return
    }
    if (!checkout) return recordPaidCheckoutMismatch(trx, binding, eventId, paidCheckout)

    // Session creation, cancellation, expiry and confirmation serialize on the booking row.
    const hold = await lockPaymentHold(trx, checkout.bookingId)
    if (!hold) return recordPaidCheckoutMismatch(trx, binding, eventId, paidCheckout)
    const attempt = await trx
      .selectFrom('payment_checkout_attempts')
      .selectAll()
      .where('id', '=', checkout.attemptId)
      .where('booking_id', '=', hold.id)
      .executeTakeFirst()
    if (
      !attempt?.started_at ||
      attempt.account_id !== binding.accountId ||
      attempt.mode !== binding.mode ||
      attempt.amount_minor !== checkout.amountMinor ||
      attempt.currency !== checkout.currency ||
      checkout.expiresAtSeconds !==
        checkoutSessionExpiry(hold.payment_hold_expires_at.toISOString()) ||
      (attempt.session_id !== null && attempt.session_id !== checkout.sessionId) ||
      (checkout.paymentReference &&
        hold.payment_reference &&
        hold.payment_reference !== checkout.paymentReference)
    )
      return recordPaidCheckoutMismatch(trx, binding, eventId, paidCheckout)

    if (
      checkout.paymentReference &&
      !hold.payment_reference &&
      (await trx
        .selectFrom('bookings')
        .select('id')
        .where('payment_reference', '=', checkout.paymentReference)
        .where('id', '!=', hold.id)
        .executeTakeFirst())
    )
      return recordPaidCheckoutMismatch(trx, binding, eventId, paidCheckout)

    // A signed snapshot can recover the Session binding after an ambiguous create response.
    if (attempt.session_id === null) {
      const other = await trx
        .selectFrom('payment_checkout_attempts')
        .select('id')
        .where('session_id', '=', checkout.sessionId)
        .where('id', '!=', attempt.id)
        .executeTakeFirst()
      if (other) return recordPaidCheckoutMismatch(trx, binding, eventId, paidCheckout)
      await trx
        .updateTable('payment_checkout_attempts')
        .set({ session_id: checkout.sessionId })
        .where('id', '=', attempt.id)
        .execute()
    }

    if (checkout.paymentReference) {
      const outcome = await confirmLockedPaymentHold(trx, ctx, hold, checkout.paymentReference)
      if (outcome === 'refund_required')
        await ensureCheckoutRefund(trx, attempt, checkout.paymentReference)
    } else if (hold.status === 'pending_payment') {
      await trx
        .updateTable('bookings')
        .set({ status: 'expired' })
        .where('id', '=', hold.id)
        .where('payment_hold_expires_at', '<=', sql<Date>`clock_timestamp()`)
        .execute()
    }
  })
}

export async function cancelPaymentHold(ctx: PaymentContext, id: string) {
  return ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('bookings')
      .select(['status'])
      .where('id', '=', id)
      .where('payment_hold_expires_at', 'is not', null)
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw new DomainError('not_found', 'booking_not_found')
    if (row.status === 'confirmed') throw new DomainError('conflict', 'payment_already_confirmed')
    if (row.status === 'pending_payment')
      await trx
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: sql`clock_timestamp()` })
        .where('id', '=', id)
        .execute()
    return { id, status: row.status === 'pending_payment' ? 'cancelled' : row.status }
  })
}
