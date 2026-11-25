// Booking details for invitee links and reschedule slots shared by invitees and hosts.
// Invitee reads go through getManagedBooking, while host slots use getHostBooking so the
// same availability rules retain each caller's authorization boundary.
import {
  checkSlotRange,
  hasBookablePart,
  intersectSlots,
  type SlotView,
  selectDurationMinutes,
  toIso,
} from './availability.ts'
import {
  assertBookingLocallyManaged,
  assertInviteeRescheduleAllowed,
  assertPaidRescheduleDuration,
  type Booking,
  getHostBooking,
  getManagedBooking,
  type ManagedBookingSelector,
  type ManagedRescheduleRequestState,
  managedLinkRescheduleRequest,
} from './bookings.ts'
import { getPublicBranding, type PublicBranding } from './branding.ts'
import {
  assertInviteeChangeOpen,
  changeDeadline,
  cutoffsOf,
  effectiveRescheduleCutoff,
} from './change-deadlines.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { bookingHostIds, resolvedBookingHosts } from './hosts.ts'
import { readManagedRoutingAnswers } from './routing-booking.ts'

/** The booking behind a manage token, with what the invitee needs to recognize it. */
export interface ManagedBooking extends Booking {
  branding?: PublicBranding
  /** The current event type, with the purchased duration for paid bookings. */
  eventType: { title: string; durationMinutes: number; allowedDurationsMinutes?: number[] } | null
  /** The people the invitee meets: each host's name (their handle if they have no name). */
  hosts: { name: string }[]
  /** The invitee's original answers with the saved labels, in question order. */
  routingAnswers?: { label: string; answer: string }[]
  /** Only for a reschedule request email's link: what became of that request. */
  rescheduleRequest?: { id: string; state: ManagedRescheduleRequestState }
  /**
   * The invitee's change deadlines this booking keeps (the ones that applied when it was
   * booked): from these instants on, the invitee can no longer reschedule or cancel it
   * through this link. null = until the meeting starts.
   */
  changeDeadlines: { rescheduleBy: string | null; cancelBy: string | null }
}

/** getManagedBooking plus the event type, the hosts' names and the link's own request. */
export async function getManagedBookingDetails(
  ctx: PublicContext,
  token: ManagedBookingSelector,
): Promise<ManagedBooking> {
  // One decision time for the request deadline in both reads (they are separate statements,
  // so a write committing between them can still show a moment apart).
  const now = ctx.now()
  const at = { ...ctx, now: () => now }
  const booking = await getManagedBooking(at, token)
  const [eventType, hosts, rescheduleRequest, cutoffs] = await Promise.all([
    booking.eventTypeId === null
      ? undefined
      : ctx.db
          .selectFrom('event_types')
          .select(['title', 'duration_minutes', 'allowed_durations_minutes'])
          .where('id', '=', booking.eventTypeId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
    ctx.db
      .selectFrom(resolvedBookingHosts(ctx.db).as('bh'))
      .innerJoin('auth.user as u', 'u.id', 'bh.user_id')
      .leftJoin('profiles as p', 'p.user_id', 'bh.user_id')
      .select(['u.name', 'p.handle'])
      .where('bh.booking_id', '=', booking.id)
      .orderBy('bh.user_id')
      .execute(),
    typeof token !== 'object' ? managedLinkRescheduleRequest(at, token, booking.id) : undefined,
    ctx.db
      .selectFrom('bookings as booking')
      .leftJoin('payment_checkout_attempts as moved', 'moved.current_booking_id', 'booking.id')
      .select([
        'booking.organization_id',
        'booking.reschedule_cutoff_minutes',
        'booking.cancel_cutoff_minutes',
        'booking.has_routing_snapshot',
        'booking.payment_hold_expires_at',
        'moved.current_booking_id',
      ])
      .where('booking.id', '=', booking.id)
      .executeTakeFirstOrThrow(),
  ])
  const branding = await getPublicBranding(ctx.db, cutoffs.organization_id)
  // Keep the same statements for ordinary bookings. Recurring member selectors have
  // their own authority, including guest links, and do not carry routing answers.
  const routingAnswers =
    typeof token === 'string' && cutoffs.has_routing_snapshot
      ? await readManagedRoutingAnswers(ctx.db, booking.id, cutoffs.organization_id)
      : undefined
  const start = Temporal.Instant.from(booking.start)
  const paid = cutoffs.payment_hold_expires_at || cutoffs.current_booking_id
  const durationOptions =
    !paid && eventType && eventType.allowed_durations_minutes.length > 1
      ? {
          allowedDurationsMinutes: [...eventType.allowed_durations_minutes].sort((a, b) => a - b),
        }
      : {}
  const instant = (minutes: number | null) => {
    const deadline = changeDeadline(start, minutes)
    return deadline && toIso(deadline)
  }
  return {
    ...booking,
    ...(branding && { branding }),
    eventType: eventType
      ? {
          title: eventType.title,
          durationMinutes: paid
            ? Temporal.Instant.from(booking.end).since(start).total('minutes')
            : eventType.duration_minutes,
          ...durationOptions,
        }
      : null,
    hosts: hosts.map((h) => ({ name: h.name.trim() || h.handle || '' })),
    ...(rescheduleRequest && { rescheduleRequest }),
    changeDeadlines: {
      rescheduleBy: instant(effectiveRescheduleCutoff(cutoffsOf(cutoffs))),
      cancelBy: instant(cutoffs.cancel_cutoff_minutes),
    },
    ...(routingAnswers && { routingAnswers }),
  }
}

/**
 * The times the booking behind `token` can be rescheduled to within [start, end]: the slots
 * every host offers for its event type with this booking itself ignored, which is what
 * rescheduleManagedBooking accepts (so the new time may overlap the old one). The same range
 * rules as public slots (`invalid_range`, `range_too_long`); `booking_cancelled`,
 * `booking_in_past`, `booking_reschedule_limit`, `event_type_unavailable` and
 * `booking_has_no_host` as for rescheduling.
 */
export async function listManagedSlots(
  ctx: PublicContext,
  token: ManagedBookingSelector,
  {
    start,
    end,
    durationMinutes,
  }: { start: Temporal.Instant; end: Temporal.Instant; durationMinutes?: number },
): Promise<SlotView[]> {
  checkSlotRange(start, end)
  const booking = await getManagedBooking(ctx, token)
  return listBookingSlots(ctx, booking, { start, end, durationMinutes }, true)
}

/** The same reschedule slots, scoped to a booking the caller hosts in their organization. */
export async function listHostBookingSlots(
  ctx: ServiceContext,
  id: string,
  {
    start,
    end,
    durationMinutes,
  }: { start: Temporal.Instant; end: Temporal.Instant; durationMinutes?: number },
): Promise<SlotView[]> {
  checkSlotRange(start, end)
  const booking = await getHostBooking(ctx, id)
  return listBookingSlots(ctx, booking, { start, end, durationMinutes })
}

async function listBookingSlots(
  ctx: PublicContext,
  booking: Booking,
  {
    start,
    end,
    durationMinutes,
  }: { start: Temporal.Instant; end: Temporal.Instant; durationMinutes?: number },
  asInvitee = false,
): Promise<SlotView[]> {
  const paid = await assertBookingLocallyManaged(ctx.db, booking.id, true)
  const now = ctx.now()
  if (booking.status === 'cancelled') {
    throw new DomainError('conflict', 'booking_cancelled', 'This booking is already cancelled')
  }
  if (Temporal.Instant.compare(Temporal.Instant.from(booking.start), now) <= 0) {
    throw new DomainError('conflict', 'booking_in_past', 'This booking has already started')
  }
  if (asInvitee) {
    const cutoffs = await ctx.db
      .selectFrom('bookings')
      .select(['reschedule_cutoff_minutes', 'cancel_cutoff_minutes'])
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow()
    assertInviteeChangeOpen(
      'reschedule',
      Temporal.Instant.from(booking.start),
      cutoffsOf(cutoffs),
      now,
    )
    await assertInviteeRescheduleAllowed(ctx, booking.id)
  }
  const eventType =
    booking.eventTypeId === null
      ? undefined
      : await ctx.db
          .selectFrom('event_types')
          .select([
            'id',
            'duration_minutes',
            'allowed_durations_minutes',
            'slot_step_minutes',
            'minimum_notice_minutes',
            'booking_window_days',
          ])
          .where('id', '=', booking.eventTypeId)
          .where('is_active', '=', true)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
  if (!eventType) {
    throw new DomainError(
      'conflict',
      'event_type_unavailable',
      'This event type no longer takes bookings',
    )
  }
  const snapshot = await ctx.db
    .selectFrom('bookings')
    .select(['organization_id', 'required_host_user_ids', 'hosts_use_default_schedule'])
    .where('id', '=', booking.id)
    .executeTakeFirstOrThrow()
  const hostIds = await bookingHostIds(
    ctx.db,
    booking.id,
    snapshot.organization_id,
    snapshot.required_host_user_ids,
    false,
    ctx.scimResourcesEnabled === true,
  )
  const originalDuration = Temporal.Instant.from(booking.end)
    .since(Temporal.Instant.from(booking.start))
    .total('minutes')
  if (paid) assertPaidRescheduleDuration(originalDuration, durationMinutes)
  const selectedDuration =
    paid || durationMinutes === undefined
      ? originalDuration
      : selectDurationMinutes(
          {
            durationMinutes: eventType.duration_minutes,
            allowedDurationsMinutes: eventType.allowed_durations_minutes,
          },
          durationMinutes,
        )
  const rules = {
    minimumNoticeMinutes: eventType.minimum_notice_minutes,
    bookingWindowDays: eventType.booking_window_days,
    slotStepMinutes: eventType.slot_step_minutes ?? selectedDuration,
  }
  if (!hasBookablePart(rules, start, end, now, hostIds.length)) return []

  return intersectSlots(
    ctx.db,
    eventType.id,
    hostIds,
    start,
    end,
    now,
    booking.id,
    snapshot.hosts_use_default_schedule,
    paid ? undefined : durationMinutes,
  )
}
