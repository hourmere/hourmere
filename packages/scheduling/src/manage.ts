// Booking details for invitee links and reschedule slots shared by invitees and hosts.
// Invitee reads go through getManagedBooking, while host slots use getHostBooking so the
// same availability rules retain each caller's authorization boundary.
import { checkSlotRange, hasBookablePart, intersectSlots, type SlotView } from './availability.ts'
import { type Booking, getHostBooking, getManagedBooking } from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { bookingHostIds } from './hosts.ts'

/** The booking behind a manage token, with what the invitee needs to recognize it. */
export interface ManagedBooking extends Booking {
  /** The event type as it is now; null once it is deleted (or for a booking without one). */
  eventType: { title: string; durationMinutes: number } | null
  /** The people the invitee meets: each host's name (their handle if they have no name). */
  hosts: { name: string }[]
}

/** getManagedBooking plus the event type and the hosts' names. */
export async function getManagedBookingDetails(
  ctx: PublicContext,
  token: string | undefined,
): Promise<ManagedBooking> {
  const booking = await getManagedBooking(ctx, token)
  const [eventType, hosts] = await Promise.all([
    booking.eventTypeId === null
      ? undefined
      : ctx.db
          .selectFrom('event_types')
          .select(['title', 'duration_minutes'])
          .where('id', '=', booking.eventTypeId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
    ctx.db
      .selectFrom('booking_hosts as bh')
      .innerJoin('auth.user as u', 'u.id', 'bh.user_id')
      .leftJoin('profiles as p', 'p.user_id', 'bh.user_id')
      .select(['u.name', 'p.handle'])
      .where('bh.booking_id', '=', booking.id)
      .orderBy('bh.user_id')
      .execute(),
  ])
  return {
    ...booking,
    eventType: eventType
      ? { title: eventType.title, durationMinutes: eventType.duration_minutes }
      : null,
    hosts: hosts.map((h) => ({ name: h.name.trim() || h.handle || '' })),
  }
}

/**
 * The times the booking behind `token` can be rescheduled to within [start, end]: the slots
 * every host offers for its event type with this booking itself ignored, which is what
 * rescheduleManagedBooking accepts (so the new time may overlap the old one). The same range
 * rules as public slots (`invalid_range`, `range_too_long`); `booking_cancelled`,
 * `booking_in_past`, `event_type_unavailable` and `booking_has_no_host` as for rescheduling.
 */
export async function listManagedSlots(
  ctx: PublicContext,
  token: string | undefined,
  { start, end }: { start: Temporal.Instant; end: Temporal.Instant },
): Promise<SlotView[]> {
  checkSlotRange(start, end)
  const booking = await getManagedBooking(ctx, token)
  return listBookingSlots(ctx, booking, { start, end })
}

/** The same reschedule slots, scoped to a booking the caller hosts in their organization. */
export async function listHostBookingSlots(
  ctx: ServiceContext,
  id: string,
  { start, end }: { start: Temporal.Instant; end: Temporal.Instant },
): Promise<SlotView[]> {
  checkSlotRange(start, end)
  const booking = await getHostBooking(ctx, id)
  return listBookingSlots(ctx, booking, { start, end })
}

async function listBookingSlots(
  ctx: PublicContext,
  booking: Booking,
  { start, end }: { start: Temporal.Instant; end: Temporal.Instant },
): Promise<SlotView[]> {
  const now = ctx.now()
  if (booking.status === 'cancelled') {
    throw new DomainError('conflict', 'booking_cancelled', 'This booking is already cancelled')
  }
  if (Temporal.Instant.compare(Temporal.Instant.from(booking.start), now) <= 0) {
    throw new DomainError('conflict', 'booking_in_past', 'This booking has already started')
  }
  const eventType =
    booking.eventTypeId === null
      ? undefined
      : await ctx.db
          .selectFrom('event_types')
          .select([
            'id',
            'duration_minutes',
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
  )
  const rules = {
    minimumNoticeMinutes: eventType.minimum_notice_minutes,
    bookingWindowDays: eventType.booking_window_days,
    slotStepMinutes: eventType.slot_step_minutes ?? eventType.duration_minutes,
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
  )
}
