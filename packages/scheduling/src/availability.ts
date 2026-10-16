// Availability: public event pages, offered slots, and the mapping from the database to
// the availability engine (@hourmere/core). Every path that needs slots (the public page,
// creating and rescheduling bookings, later the MCP server) goes through
// buildAvailabilityInput, so they all see the same rules.
import {
  type AvailabilityInput,
  type DateOverride,
  type ExistingBooking,
  getAvailableSlots,
  type InstantInterval,
  type Slot,
  type WeeklyHours,
} from '@hourmere/core'
import type { Db, Json } from '@hourmere/db'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { parseQuestions, type Question } from './questions.ts'

/** Longest range one public slots request may cover. */
export const MAX_SLOT_RANGE_DAYS = 62

// The engine accepts instants in years 0001–9999; nothing bookable lies near either end.
const LATEST_RANGE_END = Temporal.Instant.from('9999-12-01T00:00:00Z')

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** RFC 3339 in UTC with milliseconds, e.g. `2026-10-15T09:30:00.000Z` (docs/api-conventions.md). */
export function toIso(instant: Temporal.Instant): string {
  return instant.toString({ fractionalSecondDigits: 3 })
}

/** A timestamptz as node-postgres returns it. */
export function toInstant(date: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
}

const later = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) >= 0 ? a : b
const earlier = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) <= 0 ? a : b

// --- Locations (JSON column of event_types and bookings) ---------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const LOCATION_KINDS = ['google_meet', 'zoom', 'phone', 'in_person', 'link'] as const
export type LocationKind = (typeof LOCATION_KINDS)[number]

/**
 * Where a meeting happens: `event_types.location` as configured, `bookings.location` as
 * resolved for one booking. Details (`number`, `address`, `url`) depend on the kind.
 */
export interface Location {
  kind: LocationKind
  [detail: string]: unknown
}

export function parseLocation(value: Json | null): Location | null {
  if (!isRecord(value) || !LOCATION_KINDS.includes(value.kind as LocationKind)) return null
  return value as Location
}

// --- Public event types ----------------------------------------------------------------

/** A bookable personal event type, as the public page and the booking path need it. */
export interface PublicEventTypeRecord {
  id: string
  organizationId: string
  /** The owner, who hosts every booking of a personal event type. */
  hostUserId: string
  handle: string
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  location: Location | null
  questions: Question[]
  hostName: string
  hostTimeZone: string
}

/**
 * Finds the active, non-deleted personal event type at /{handle}/{slug}. The owner must
 * have a profile and still belong to the event type's organization.
 */
export async function findPublicEventType(
  db: Db,
  handle: string,
  slug: string,
): Promise<PublicEventTypeRecord | undefined> {
  const h = handle.toLowerCase()
  const s = slug.toLowerCase()
  if (!HANDLE.test(h) || !SLUG.test(s)) return undefined
  const row = await db
    .selectFrom('profiles as p')
    .innerJoin('auth.user as u', 'u.id', 'p.user_id')
    .innerJoin('event_types as et', 'et.owner_user_id', 'p.user_id')
    .innerJoin('auth.member as m', (join) =>
      join.onRef('m.userId', '=', 'p.user_id').onRef('m.organizationId', '=', 'et.organization_id'),
    )
    .select([
      'et.id',
      'et.organization_id',
      'et.slug',
      'et.title',
      'et.description',
      'et.duration_minutes',
      'et.location',
      'et.questions',
      'p.user_id',
      'p.handle',
      'p.time_zone',
      'u.name',
    ])
    .where('p.handle', '=', h)
    .where('et.slug', '=', s)
    .where('et.is_active', '=', true)
    .where('et.deleted_at', 'is', null)
    .executeTakeFirst()
  if (!row) return undefined
  return {
    id: row.id,
    organizationId: row.organization_id,
    hostUserId: row.user_id,
    handle: row.handle,
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    location: parseLocation(row.location),
    questions: parseQuestions(row.questions),
    hostName: row.name.trim() || row.handle,
    hostTimeZone: row.time_zone,
  }
}

export function eventTypeNotFound(): DomainError {
  return new DomainError('not_found', 'event_type_not_found', 'No such event type')
}

/** What a public booking page shows. Location details are only revealed once booked. */
export interface PublicEventType {
  handle: string
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  location: { kind: LocationKind } | null
  questions: Question[]
  host: { name: string; timeZone: string }
}

export async function getPublicEventType(
  ctx: PublicContext,
  { handle, slug }: { handle: string; slug: string },
): Promise<PublicEventType> {
  const et = await findPublicEventType(ctx.db, handle, slug)
  if (!et) throw eventTypeNotFound()
  return {
    handle: et.handle,
    slug: et.slug,
    title: et.title,
    description: et.description,
    durationMinutes: et.durationMinutes,
    location: et.location && { kind: et.location.kind },
    questions: et.questions,
    host: { name: et.hostName, timeZone: et.hostTimeZone },
  }
}

export interface SlotView {
  start: string
  end: string
}

/**
 * The slots a public page offers in [start, end] (at most MAX_SLOT_RANGE_DAYS long).
 * Throws `invalid_range` when end is not after start and `range_too_long` beyond the cap.
 */
export async function listPublicSlots(
  ctx: PublicContext,
  input: { handle: string; slug: string; start: Temporal.Instant; end: Temporal.Instant },
): Promise<SlotView[]> {
  if (Temporal.Instant.compare(input.end, input.start) <= 0) {
    throw new DomainError('invalid', 'invalid_range', 'end must be after start')
  }
  if (input.end.since(input.start).total('hours') > MAX_SLOT_RANGE_DAYS * 24) {
    throw new DomainError(
      'invalid',
      'range_too_long',
      `The range may span at most ${MAX_SLOT_RANGE_DAYS} days`,
    )
  }
  const et = await findPublicEventType(ctx.db, input.handle, input.slug)
  if (!et) throw eventTypeNotFound()
  const slots = await findSlots(ctx.db, {
    eventTypeId: et.id,
    hostUserId: et.hostUserId,
    rangeStart: input.start,
    rangeEnd: input.end,
    now: ctx.now(),
  })
  return slots.map((s) => ({ start: toIso(s.start), end: toIso(s.end) }))
}

// --- The database → engine mapping ------------------------------------------------------

export interface AvailabilityQuery {
  /** The event type whose rules (duration, step, buffers, notice, window, limit) apply. */
  eventTypeId: string
  /** The host whose time is checked. */
  hostUserId: string
  /**
   * Slots must lie fully inside [rangeStart, rangeEnd]. buildAvailabilityInput passes the
   * range on unchanged, so it must meet the engine's contract (at most 400 days, years
   * 0001–9999); findSlots trims it to what can be booked first. Public callers cap it far
   * lower (MAX_SLOT_RANGE_DAYS).
   */
  rangeStart: Temporal.Instant
  rangeEnd: Temporal.Instant
  now: Temporal.Instant
  /** A booking that must not block, e.g. the one being rescheduled. */
  excludeBookingId?: string | undefined
}

/**
 * Builds the availability engine's input for one host and event type from the database:
 *
 * - schedule: the host's schedule for this event type (`event_type_hosts.schedule_id`), or
 *   the host's default schedule; with neither, there is nothing to offer (`undefined`).
 *   Date overrides near the range are included.
 * - busy: intervals mirrored from the host's calendars that have `check_conflicts` on.
 * - bookings: the host's active bookings (`booking_hosts.active`, in any organization),
 *   each with the buffers of its own event type (0 when it has none). Bookings of this
 *   event type are passed as `bookings`, so they count toward `max_bookings_per_day`;
 *   bookings of other event types block the same time (widened by their own buffers) but
 *   are passed as busy time, so the daily limit counts this event type only.
 * - eventType: the rules of the event type.
 *
 * Works on a transaction too. Throws `event_type_not_found` for an unknown event type.
 */
export async function buildAvailabilityInput(
  db: Db,
  query: AvailabilityQuery,
): Promise<AvailabilityInput | undefined> {
  const { eventTypeId, hostUserId, rangeStart, rangeEnd, now, excludeBookingId } = query
  const eventType = await db
    .selectFrom('event_types as et')
    .leftJoin('event_type_hosts as h', (join) =>
      join.onRef('h.event_type_id', '=', 'et.id').on('h.user_id', '=', hostUserId),
    )
    .select([
      'et.duration_minutes',
      'et.slot_step_minutes',
      'et.buffer_before_minutes',
      'et.buffer_after_minutes',
      'et.minimum_notice_minutes',
      'et.booking_window_days',
      'et.max_bookings_per_day',
      'h.schedule_id',
    ])
    .where('et.id', '=', eventTypeId)
    .executeTakeFirst()
  if (!eventType) throw eventTypeNotFound()

  const schedule = await db
    .selectFrom('schedules')
    .select(['id', 'time_zone', 'weekly_hours'])
    .where('user_id', '=', hostUserId)
    .$if(eventType.schedule_id !== null, (q) => q.where('id', '=', eventType.schedule_id as string))
    .$if(eventType.schedule_id === null, (q) => q.where('is_default', '=', true))
    .executeTakeFirst()
  if (!schedule) return undefined

  // Wide enough for anything that can affect a slot in the range: the engine visits one
  // extra local day on each side (UTC offsets stay within ±14 hours), and a booking's
  // buffers plus the new slot's reach at most 2 × 1440 minutes.
  const window = { start: rangeStart.subtract({ hours: 72 }), end: rangeEnd.add({ hours: 72 }) }

  const [overrides, busy, bookings] = await Promise.all([
    db
      .selectFrom('schedule_overrides')
      .select(['date', 'intervals'])
      .where('schedule_id', '=', schedule.id)
      .where('date', '>=', utcDate(window.start))
      .where('date', '<=', utcDate(window.end))
      .orderBy('date')
      .execute(),
    db
      .selectFrom('calendar_busy as cb')
      .innerJoin('calendars as c', 'c.id', 'cb.calendar_id')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .select((eb) => [
        eb.fn<Date | null>('lower', ['cb.period']).as('start'),
        eb.fn<Date | null>('upper', ['cb.period']).as('end'),
      ])
      .where('cc.user_id', '=', hostUserId)
      .where('c.check_conflicts', '=', true)
      .where((eb) =>
        eb(
          'cb.period',
          '&&',
          eb.fn<string>('tstzrange', [
            eb.val(window.start.toString()),
            eb.val(window.end.toString()),
          ]),
        ),
      )
      .execute(),
    db
      .selectFrom('booking_hosts as bh')
      .innerJoin('bookings as b', 'b.id', 'bh.booking_id')
      .leftJoin('event_types as bet', 'bet.id', 'b.event_type_id')
      .select([
        'b.start_at',
        'b.end_at',
        'b.event_type_id',
        'bet.buffer_before_minutes',
        'bet.buffer_after_minutes',
      ])
      .where('bh.user_id', '=', hostUserId)
      .where('bh.active', '=', true)
      .where((eb) =>
        eb(
          'bh.period',
          '&&',
          eb.fn<string>('tstzrange', [
            eb.val(window.start.toString()),
            eb.val(window.end.toString()),
          ]),
        ),
      )
      .$if(excludeBookingId !== undefined, (q) => q.where('b.id', '<>', excludeBookingId as string))
      .execute(),
  ])

  const busyIntervals: InstantInterval[] = busy.map((row) => ({
    // An unbounded busy range blocks everything on that side of the window.
    start: row.start ? toInstant(row.start) : window.start,
    end: row.end ? toInstant(row.end) : window.end,
  }))
  const ownBookings: ExistingBooking[] = []
  for (const row of bookings) {
    const booking = {
      start: toInstant(row.start_at),
      end: toInstant(row.end_at),
      bufferBeforeMinutes: row.buffer_before_minutes ?? 0,
      bufferAfterMinutes: row.buffer_after_minutes ?? 0,
    }
    if (row.event_type_id === eventTypeId) {
      ownBookings.push(booking)
    } else {
      busyIntervals.push({
        start: booking.start.subtract({ minutes: booking.bufferBeforeMinutes }),
        end: booking.end.add({ minutes: booking.bufferAfterMinutes }),
      })
    }
  }

  return {
    schedule: {
      timeZone: schedule.time_zone,
      // Validated by the owner-side API when stored, and again by the engine.
      weeklyHours: schedule.weekly_hours as WeeklyHours,
      dateOverrides: overrides.map(
        (o): DateOverride => ({
          date: o.date,
          intervals: o.intervals as unknown as DateOverride['intervals'],
        }),
      ),
    },
    eventType: {
      durationMinutes: eventType.duration_minutes,
      slotStepMinutes: eventType.slot_step_minutes ?? undefined,
      bufferBeforeMinutes: eventType.buffer_before_minutes,
      bufferAfterMinutes: eventType.buffer_after_minutes,
      minimumNoticeMinutes: eventType.minimum_notice_minutes,
      maxBookingsPerDay: eventType.max_bookings_per_day ?? undefined,
      bookingWindowDays: eventType.booking_window_days ?? undefined,
    },
    busy: busyIntervals,
    bookings: ownBookings,
    rangeStart,
    rangeEnd,
    now,
  }
}

/** `YYYY-MM-DD` of an instant in UTC, kept inside the years Postgres and the engine accept. */
function utcDate(instant: Temporal.Instant): string {
  const date = instant.toZonedDateTimeISO('UTC').toPlainDate()
  if (date.year < 1) return '0001-01-01'
  if (date.year > 9999) return '9999-12-31'
  return date.toString()
}

/**
 * The slots one host offers for an event type in [rangeStart, rangeEnd], computed from the
 * database by the engine. The range is first trimmed to what can still be booked (nothing
 * before `now`); an empty range or a host without a schedule offers nothing.
 */
export async function findSlots(db: Db, query: AvailabilityQuery): Promise<Slot[]> {
  const rangeStart = later(query.rangeStart, query.now)
  const rangeEnd = earlier(query.rangeEnd, LATEST_RANGE_END)
  if (Temporal.Instant.compare(rangeEnd, rangeStart) <= 0) return []
  const input = await buildAvailabilityInput(db, { ...query, rangeStart, rangeEnd })
  return input ? getAvailableSlots(input) : []
}
