import type { Db, Json } from '@hourmere/db'
import { sql } from 'kysely'
import {
  findSlots,
  type PublicEventTypeRecord,
  parseLocation,
  selectBookableLocationOption,
} from './availability.ts'
import { DomainError } from './errors.ts'
import { createNotificationSnapshot, type NotificationSnapshot } from './notification-settings.ts'
import { expirePaymentHolds } from './payment-expiry.ts'

export const groupUnavailable = () =>
  new DomainError('conflict', 'slot_unavailable', 'This time is not available')

/** Caller holds the organization's and pinned host's locks before taking any seat locks. */
export async function lockGroupBooking(
  db: Db,
  bookingId: string,
  start?: Temporal.Instant,
  durationMinutes?: number,
  organizationId?: string,
): Promise<void> {
  const seat = await db
    .selectFrom('bookings')
    .select(['group_slot_id', 'start_at', 'end_at'])
    .where('id', '=', bookingId)
    .$if(organizationId !== undefined, (q) => q.where('organization_id', '=', organizationId!))
    .executeTakeFirst()
  if (!seat?.group_slot_id) return
  const slot = await db
    .selectFrom('group_slots')
    .select(['host_user_id', 'original_event_type_id'])
    .where('id', '=', seat.group_slot_id)
    .executeTakeFirstOrThrow()
  await sql`select pg_advisory_xact_lock(hashtextextended(${`booking-host:${slot.host_user_id}`},0))`.execute(
    db,
  )
  const end = start?.add({
    minutes: durationMinutes ?? (seat.end_at.getTime() - seat.start_at.getTime()) / 60_000,
  })
  // Lock all known source/destination generations in canonical order before the seat.
  // Missing destinations are serialized by the shared pinned-host advisory lock.
  await db
    .selectFrom('group_slots')
    .select('id')
    .where((eb) =>
      eb.or([
        eb('id', '=', seat.group_slot_id),
        ...(start && end
          ? [
              eb.and([
                eb('original_event_type_id', '=', slot.original_event_type_id),
                eb('start_at', '=', new Date(start.epochMilliseconds)),
                eb('end_at', '=', new Date(end.epochMilliseconds)),
              ]),
            ]
          : []),
      ]),
    )
    .orderBy('id')
    .forUpdate()
    .execute()
}

/** Resolve one immutable slot snapshot; the seat INSERT trigger alone takes capacity. */
export async function admitGroupSlot(
  db: Db,
  q: {
    event: PublicEventTypeRecord
    start: Temporal.Instant
    end: Temporal.Instant
    now: Temporal.Instant
    snapshot: NotificationSnapshot
    bookerEmail: string
    preserveDurationBookingId?: string | undefined
    sourceSlotId?: string | undefined
    locationOptionId?: string | undefined
    expectedSlotId?: string | undefined
  },
) {
  const config = await db
    .selectFrom('event_types')
    .selectAll()
    .where('id', '=', q.event.id)
    .executeTakeFirstOrThrow()
  if (config.booking_mode !== 'group') return undefined
  if (
    q.event.schedulingType !== 'individual' ||
    q.event.hostUserIds.length !== 1 ||
    config.group_capacity === null
  )
    throw groupUnavailable()
  const hostId = q.event.hostUserIds[0] as string
  const host = await db
    .selectFrom('event_type_hosts as h')
    .leftJoin('profiles as p', 'p.user_id', 'h.user_id')
    .select([
      'h.schedule_id',
      'h.destination_calendar_id',
      'p.destination_calendar_id as profile_calendar_id',
    ])
    .where('h.event_type_id', '=', config.id)
    .where('h.user_id', '=', hostId)
    .executeTakeFirstOrThrow()
  const options = config.locations as unknown as
    | { id: string; isDefault?: boolean; kind: string }[]
    | null
  const option = options?.find((o) => o.isDefault) ?? options?.[0] ?? null
  const prior = await db
    .selectFrom('group_slots')
    .selectAll()
    .where('original_event_type_id', '=', config.id)
    .where('start_at', '=', new Date(q.start.epochMilliseconds))
    .where('end_at', '=', new Date(q.end.epochMilliseconds))
    .where('state', 'in', ['open', 'host_cancelled'])
    .orderBy('id')
    .forUpdate()
    .execute()
  if (prior.some((s) => s.state === 'host_cancelled')) throw groupUnavailable()
  const slot = prior.find((s) => s.state === 'open')
  if (q.expectedSlotId !== undefined && slot?.id !== q.expectedSlotId)
    throw new DomainError(
      'conflict',
      'group_slot_changed',
      'This slot changed; choose a time again',
    )
  if (slot && slot.active_seats >= slot.capacity)
    throw Object.assign(
      new DomainError('conflict', 'slot_taken', 'Someone else just booked this time'),
      { errorAlias: 'group_slot_full' },
    )
  // Reject caller-selected logistics before looking up mailbox membership.
  if (
    slot &&
    q.locationOptionId !== undefined &&
    (slot.location_option as { id?: string } | null)?.id !== q.locationOptionId
  )
    throw new DomainError(
      'conflict',
      'location_unavailable',
      'Group seats share the configured location.',
    )
  if (
    slot &&
    (await db
      .selectFrom('bookings')
      .select('id')
      .where('group_slot_id', '=', slot.id)
      .where('status', '=', 'confirmed')
      .where('group_booker_key', '=', sql<string>`normalize_group_booker_key(${q.bookerEmail})`)
      .executeTakeFirst())
  )
    throw groupUnavailable()
  if (slot && slot.host_user_id !== hostId) throw groupUnavailable()
  const duration = q.end.since(q.start).total({ unit: 'minutes' })
  if (slot && !q.preserveDurationBookingId && !config.allowed_durations_minutes.includes(duration))
    throw groupUnavailable()
  if (slot) {
    // This interval already reserves the host. Logistics edits govern new occurrences,
    // not additional seats in an immutable existing occurrence.
    if (
      Temporal.Instant.compare(q.start, q.now.add({ minutes: config.minimum_notice_minutes })) <
        0 ||
      (config.booking_window_days !== null &&
        Temporal.Instant.compare(
          q.start,
          q.now
            .toZonedDateTimeISO(slot.host_time_zone)
            .add({ days: config.booking_window_days })
            .toInstant(),
        ) > 0)
    )
      throw groupUnavailable()
    return {
      existing: true,
      id: slot.id,
      location: parseLocation(slot.location),
      locationOption: slot.location_option,
    }
  }
  selectBookableLocationOption(q.event, q.locationOptionId)
  const source = q.sourceSlotId
    ? await db
        .selectFrom('group_slots')
        .select(['id', 'state'])
        .where('id', '=', q.sourceSlotId)
        .executeTakeFirst()
    : undefined
  const exclusions = [...(source?.state === 'retired' ? [source.id] : [])]
  await expirePaymentHolds({ db, hostUserId: hostId })
  const offered = await findSlots(db, {
    eventTypeId: config.id,
    hostUserId: hostId,
    rangeStart: q.start,
    rangeEnd: q.end,
    now: q.now,
    durationMinutes: q.preserveDurationBookingId ? undefined : duration,
    excludeBookingId: q.preserveDurationBookingId,
    excludeGroupSlotIds: exclusions,
  })
  if (!offered.some((s) => s.start.equals(q.start) && s.end.equals(q.end))) throw groupUnavailable()
  const created = await db
    .insertInto('group_slots')
    .values({
      organization_id: config.organization_id,
      event_type_id: config.id,
      original_event_type_id: config.id,
      host_user_id: hostId,
      host_schedule_id: host.schedule_id,
      host_schedule_uses_default: host.schedule_id === null,
      host_time_zone: q.event.hostTimeZone,
      organizer_user_id: hostId,
      destination_calendar_id: host.destination_calendar_id ?? host.profile_calendar_id,
      conference_organizer_user_id: hostId,
      zoom_connection_id: config.zoom_connection_id,
      start_at: q.start.toString(),
      end_at: q.end.toString(),
      capacity: config.group_capacity,
      title: config.title,
      location_option: option === null ? null : JSON.stringify(option),
      location: config.location === null ? null : JSON.stringify(config.location),
      buffer_before_minutes: config.buffer_before_minutes,
      buffer_after_minutes: config.buffer_after_minutes,
      host_notification_settings: JSON.stringify(createNotificationSnapshot(config.notifications)),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('booking_hosts')
    .values({ group_slot_id: created.id, user_id: hostId })
    .execute()
  return {
    existing: false,
    id: created.id,
    location: parseLocation(config.location),
    locationOption: option as Json | null,
  }
}
