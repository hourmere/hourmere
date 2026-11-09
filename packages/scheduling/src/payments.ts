import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import { findPublicEventType, selectDurationMinutes } from './availability.ts'
import {
  type CreateBookingInput,
  canonicalJson,
  insertBooking,
  lockHosts,
  requireOfferedSlot,
  resolveBookingLocation,
  validateInvitee,
} from './bookings.ts'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { selectLocationOption } from './location-options.ts'
import { createNotificationSnapshot } from './notification-settings.ts'
import { expirePaymentHolds } from './payment-expiry.ts'
import { validateResponses } from './questions.ts'

export const PAYMENT_HOLD_MINUTES = 30
export interface PaymentContext extends PublicContext {
  paidBookingsEnabled?: boolean
}
const disabled = () =>
  new DomainError('conflict', 'paid_bookings_disabled', 'Paid bookings are disabled')

/** Internal only: no route, provider call, manage token or notification at hold creation. */
export async function createPaymentHold(ctx: PaymentContext, input: CreateBookingInput) {
  if (ctx.paidBookingsEnabled !== true) throw disabled()
  if (!input.idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey))
    throw new DomainError('invalid', 'invalid_idempotency_key')
  if (input.waitlistToken || input.guests?.length)
    throw new DomainError('invalid', 'payment_flow_unsupported')
  const invitee = validateInvitee(input.invitee)
  const event = await findPublicEventType(ctx.db, input.handle, input.slug)
  if (!event) throw new DomainError('not_found', 'event_type_not_found')
  const key = input.idempotencyKey
  const fingerprint = createHash('sha256')
    .update(canonicalJson({ ...input, start: input.start.toString() }))
    .digest()
  return ctx.db.transaction().execute(async (trx) => {
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
        expiresAt: existing.payment_hold_expires_at?.toISOString(),
      }
    }
    const current = await findPublicEventType(trx, input.handle, input.slug, { lock: true })
    if (
      !current ||
      current.id !== event.id ||
      current.hostUserIds.join() !== event.hostUserIds.join()
    )
      throw new DomainError('conflict', 'event_type_unavailable')
    const model = await trx
      .selectFrom('event_types')
      .select(['booking_mode', 'notifications'])
      .where('id', '=', current.id)
      .executeTakeFirstOrThrow()
    if (
      current.schedulingType !== 'individual' ||
      current.hostUserIds.length !== 1 ||
      model.booking_mode !== 'individual'
    )
      throw new DomainError('invalid', 'payment_flow_unsupported')
    // Gate the option this hold would store: the invitee's choice, or the default without one.
    const chosen = selectLocationOption(current.locations, input.locationOptionId)
    if (chosen?.kind === 'google_meet' || chosen?.kind === 'zoom' || chosen?.kind === 'phone')
      throw new DomainError('invalid', 'payment_flow_unsupported')
    const responses = validateResponses(current.questions, input.responses ?? {})
    const duration = selectDurationMinutes(current, input.durationMinutes)
    const end = input.start.add({ minutes: duration })
    const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
    const now = Temporal.Instant.from((rows[0] as { now: Date }).now.toISOString())
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
    const expiresAt = now.add({ minutes: PAYMENT_HOLD_MINUTES }).toString()
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
      manageTokenHash: null,
      paymentHoldExpiresAt: expiresAt,
    })
    await trx
      .updateTable('bookings')
      .set({ payment_idempotency_key: key, idempotency_fingerprint: fingerprint })
      .where('id', '=', id)
      .execute()
    return { id, status: 'pending_payment', expiresAt }
  })
}

/** Verified provider success only. Late success records durable refund intent, never resurrects. */
export async function confirmPaymentHold(
  ctx: PaymentContext,
  id: string,
  paymentReference: string,
): Promise<{ id: string; outcome: 'confirmed' | 'refund_required' }> {
  if (!/^pi_[A-Za-z0-9_]{1,200}$/.test(paymentReference))
    throw new DomainError('invalid', 'invalid_payment_reference')
  return ctx.db
    .transaction()
    .execute(async (trx) => {
      const row = await trx
        .selectFrom('bookings')
        .selectAll()
        .where('id', '=', id)
        .where('payment_hold_expires_at', 'is not', null)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new DomainError('not_found', 'booking_not_found')
      if (row.payment_reference && row.payment_reference !== paymentReference)
        throw new DomainError('conflict', 'payment_reference_mismatch')
      const { rows } = await sql<{
        active: boolean
      }>`SELECT ${row.payment_hold_expires_at}::timestamptz > clock_timestamp() AS active`.execute(
        trx,
      )
      const confirm =
        row.status === 'confirmed' || (row.status === 'pending_payment' && rows[0]?.active)
      await trx
        .updateTable('bookings')
        .set({
          status: confirm ? 'confirmed' : row.status === 'cancelled' ? 'cancelled' : 'expired',
          payment_reference: paymentReference,
          payment_refund_required: !confirm,
        })
        .where('id', '=', id)
        .execute()
      if (confirm && row.status !== 'confirmed')
        await ctx.notify?.(
          trx,
          {
            type: 'created',
            bookingId: id,
            start: Temporal.Instant.from(row.start_at.toISOString()),
          },
          ctx.now(),
        )
      return { id, outcome: confirm ? ('confirmed' as const) : ('refund_required' as const) }
    })
    .catch((error: unknown) => {
      // The authoritative trigger can observe the deadline just after our read.
      // Roll back that attempt, then persist refund intent against the expired hold.
      if (
        typeof error === 'object' &&
        error !== null &&
        'constraint' in error &&
        error.constraint === 'bookings_payment_confirmation'
      )
        return confirmPaymentHold(ctx, id, paymentReference)
      throw error
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
