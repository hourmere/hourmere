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
  isReservedName,
  type Slot,
  type WeeklyHours,
} from '@hourmere/core'
import type { Db, Json } from '@hourmere/db'
import { type Expression, type ExpressionBuilder, sql } from 'kysely'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { parseQuestions, type Question } from './questions.ts'

/** Longest range one public slots request may cover. */
export const MAX_SLOT_RANGE_DAYS = 62

/**
 * Most candidate start times (bookable minutes / slot step) one public slots request may
 * make the engine check, so that 1-minute steps cannot keep a core busy. Only the part of
 * the range that can be booked counts (from now plus the minimum notice to the end of the
 * booking window): with a 30-minute step any 62 days fit, with a 1-minute step about 13
 * bookable days.
 */
export const MAX_SLOT_CANDIDATES = 20_000

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
  /** Distance between candidate starts (the duration unless set). */
  slotStepMinutes: number
  minimumNoticeMinutes: number
  bookingWindowDays: number | null
  location: Location | null
  questions: Question[]
  hostName: string
  hostTimeZone: string
}

/**
 * The handle as stored (lowercase), or undefined when no public page can have it: not a
 * handle, or a reserved name. A stored handle that became reserved after it was chosen is not
 * served, so nobody keeps a page at a path the app or the product now uses (/support, …).
 */
function servedHandle(handle: string): string | undefined {
  const h = handle.toLowerCase()
  return HANDLE.test(h) && !isReservedName(h) ? h : undefined
}

/**
 * Finds the active, non-deleted personal event type at /{handle}/{slug}. The owner must
 * have a profile with a handle that is not reserved, and still belong to the event type's
 * organization.
 */
export async function findPublicEventType(
  db: Db,
  handle: string,
  slug: string,
): Promise<PublicEventTypeRecord | undefined> {
  const h = servedHandle(handle)
  const s = slug.toLowerCase()
  if (h === undefined || !SLUG.test(s)) return undefined
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
      'et.slot_step_minutes',
      'et.minimum_notice_minutes',
      'et.booking_window_days',
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
    slotStepMinutes: row.slot_step_minutes ?? row.duration_minutes,
    minimumNoticeMinutes: row.minimum_notice_minutes,
    bookingWindowDays: row.booking_window_days,
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

/** One event type as the host's page (/{handle}) lists it. */
export interface PublicEventTypeSummary {
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  location: { kind: LocationKind } | null
}

/** What the host's page at /{handle} shows: who they are and what can be booked. */
export interface PublicHost {
  handle: string
  host: { name: string; timeZone: string }
  eventTypes: PublicEventTypeSummary[]
}

/**
 * The host at /{handle} and their bookable personal event types (active, not deleted, in an
 * organization they still belong to), in the order they arranged them. `host_not_found` for
 * an unknown or reserved handle; a host with nothing to book has an empty list.
 */
export async function getPublicHost(
  ctx: PublicContext,
  { handle }: { handle: string },
): Promise<PublicHost> {
  const h = servedHandle(handle)
  const profile =
    h === undefined
      ? undefined
      : await ctx.db
          .selectFrom('profiles as p')
          .innerJoin('auth.user as u', 'u.id', 'p.user_id')
          .select(['p.user_id', 'p.handle', 'p.time_zone', 'u.name'])
          .where('p.handle', '=', h)
          .executeTakeFirst()
  if (!profile) throw new DomainError('not_found', 'host_not_found', 'No such booking page')
  const rows = await ctx.db
    .selectFrom('event_types as et')
    .innerJoin('auth.member as m', (join) =>
      join
        .onRef('m.organizationId', '=', 'et.organization_id')
        .on('m.userId', '=', profile.user_id),
    )
    .select(['et.slug', 'et.title', 'et.description', 'et.duration_minutes', 'et.location'])
    .where('et.owner_user_id', '=', profile.user_id)
    .where('et.is_active', '=', true)
    .where('et.deleted_at', 'is', null)
    .orderBy('et.position')
    .orderBy('et.id')
    .execute()
  return {
    handle: profile.handle,
    host: { name: profile.name.trim() || profile.handle, timeZone: profile.time_zone },
    eventTypes: rows.map((row) => {
      const location = parseLocation(row.location)
      return {
        slug: row.slug,
        title: row.title,
        description: row.description,
        durationMinutes: row.duration_minutes,
        location: location && { kind: location.kind },
      }
    }),
  }
}

export interface SlotView {
  start: string
  end: string
}

/**
 * Checks a public slots request's range before anything is looked up: `invalid_range` when
 * end is not after start, `range_too_long` beyond MAX_SLOT_RANGE_DAYS.
 */
export function checkSlotRange(start: Temporal.Instant, end: Temporal.Instant): void {
  if (Temporal.Instant.compare(end, start) <= 0) {
    throw new DomainError('invalid', 'invalid_range', 'end must be after start')
  }
  if (end.since(start).total('hours') > MAX_SLOT_RANGE_DAYS * 24) {
    throw new DomainError(
      'invalid',
      'range_too_long',
      `The range may span at most ${MAX_SLOT_RANGE_DAYS} days`,
    )
  }
}

/**
 * Whether [start, end] has a part that can still be booked under these rules (from now plus
 * the minimum notice to the end of the booking window). Throws `range_too_long` when that
 * part holds more than MAX_SLOT_CANDIDATES start times at the slot step.
 */
export function hasBookablePart(
  rules: {
    minimumNoticeMinutes: number
    bookingWindowDays: number | null
    slotStepMinutes: number
  },
  start: Temporal.Instant,
  end: Temporal.Instant,
  now: Temporal.Instant,
): boolean {
  // Nothing before now plus the minimum notice, nothing after the booking window (calendar
  // days in the host's zone, so one spare day here).
  const bookableStart = later(start, now.add({ minutes: rules.minimumNoticeMinutes }))
  const bookableEnd =
    rules.bookingWindowDays === null
      ? end
      : earlier(end, now.add({ hours: (rules.bookingWindowDays + 1) * 24 }))
  if (Temporal.Instant.compare(bookableEnd, bookableStart) <= 0) return false
  if (
    bookableEnd.since(bookableStart).total('minutes') / rules.slotStepMinutes >
    MAX_SLOT_CANDIDATES
  ) {
    throw new DomainError(
      'invalid',
      'range_too_long',
      'This event type offers too many start times in that range; ask for a shorter one',
    )
  }
  return true
}

/**
 * The slots a public page offers in [start, end]. Throws `invalid_range` when end is not
 * after start, and `range_too_long` for more than MAX_SLOT_RANGE_DAYS or more than
 * MAX_SLOT_CANDIDATES candidate starts at the event type's step in the bookable part.
 */
export async function listPublicSlots(
  ctx: PublicContext,
  input: { handle: string; slug: string; start: Temporal.Instant; end: Temporal.Instant },
): Promise<SlotView[]> {
  checkSlotRange(input.start, input.end)
  const et = await findPublicEventType(ctx.db, input.handle, input.slug)
  if (!et) throw eventTypeNotFound()
  const now = ctx.now()
  if (!hasBookablePart(et, input.start, input.end, now)) return []
  const slots = await findSlots(ctx.db, {
    eventTypeId: et.id,
    hostUserId: et.hostUserId,
    rangeStart: input.start,
    rangeEnd: input.end,
    now,
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
 * - busy: intervals mirrored from the host's calendars that have `check_conflicts` on,
 *   clipped to the window around the range (so unbounded and infinite ones work), except
 *   the calendar event mirrored from `excludeBookingId` itself.
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
  const googleCalendars = await db
    .selectFrom('calendars as c')
    .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
    .select(['cc.status', 'c.last_synced_at', 'c.sync_state', 'c.sync_error'])
    .where('cc.user_id', '=', hostUserId)
    .where('cc.provider', '=', 'google')
    .where('c.check_conflicts', '=', true)
    .execute()
  for (const calendar of googleCalendars) {
    const unavailable = () =>
      new DomainError(
        'conflict',
        'calendar_sync_unavailable',
        'The host calendar is temporarily unavailable. Try again shortly.',
      )
    if (
      calendar.status !== 'active' ||
      calendar.sync_error ||
      !calendar.last_synced_at ||
      calendar.last_synced_at.getTime() > now.epochMilliseconds + 60_000 ||
      now.epochMilliseconds - calendar.last_synced_at.getTime() > 10 * 60_000
    )
      throw unavailable()
    const state = calendar.sync_state
    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      state.version !== 1 ||
      typeof state.start !== 'string' ||
      typeof state.end !== 'string'
    )
      throw unavailable()
    try {
      if (
        Temporal.Instant.compare(Temporal.Instant.from(state.start), window.start) > 0 ||
        Temporal.Instant.compare(Temporal.Instant.from(state.end), window.end) < 0
      )
        throw unavailable()
    } catch {
      throw unavailable()
    }
  }
  const windowRange = <DB, TB extends keyof DB>(eb: ExpressionBuilder<DB, TB>) =>
    eb.fn<string>('tstzrange', [eb.val(window.start.toString()), eb.val(window.end.toString())])
  // Postgres keeps microseconds, node-postgres Dates milliseconds: blocked time is widened to
  // whole milliseconds in SQL (start down, end up), so converting it never shrinks or empties
  // it (e.g. a range clipped to [10:00:00, 10:00:00.0005)).
  const floorMs = <DB, TB extends keyof DB>(
    eb: ExpressionBuilder<DB, TB>,
    instant: Expression<unknown>,
  ) => eb.fn<Date>('date_trunc', [eb.val('milliseconds'), instant])
  const ceilMs = <DB, TB extends keyof DB>(
    eb: ExpressionBuilder<DB, TB>,
    instant: Expression<unknown>,
  ) =>
    eb.fn<Date>('date_trunc', [
      eb.val('milliseconds'),
      sql`${instant} + interval '999 microseconds'`,
    ])

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
      // Clipped to the window in SQL: a period may be unbounded or reach ±infinity, which
      // node-postgres would return as null or a number instead of a Date.
      .select((eb) => {
        const clipped = eb('cb.period', '*', windowRange(eb))
        return [
          floorMs(eb, eb.fn('lower', [clipped])).as('start'),
          ceilMs(eb, eb.fn('upper', [clipped])).as('end'),
        ]
      })
      .where('cc.user_id', '=', hostUserId)
      .where('c.check_conflicts', '=', true)
      .where((eb) => eb('cb.period', '&&', windowRange(eb)))
      // The moved booking's own event in the host's calendar must not block its new time.
      .$if(excludeBookingId !== undefined, (q) =>
        q.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('booking_calendar_events as bce')
                .select('bce.booking_id')
                .where(sql<boolean>`bce.booking_id IN (
                  WITH RECURSIVE ancestors(id,rescheduled_from_id) AS (
                    SELECT id,rescheduled_from_id FROM bookings WHERE id=${excludeBookingId as string}::uuid
                    UNION ALL SELECT b.id,b.rescheduled_from_id FROM bookings b JOIN ancestors a ON b.id=a.rescheduled_from_id
                  ) CYCLE id SET is_cycle USING path SELECT id FROM ancestors WHERE NOT is_cycle
                )`)
                .whereRef('bce.calendar_id', '=', 'cb.calendar_id')
                .whereRef('bce.external_event_id', '=', 'cb.external_event_id'),
            ),
          ),
        ),
      )
      .execute(),
    db
      .selectFrom('booking_hosts as bh')
      .innerJoin('bookings as b', 'b.id', 'bh.booking_id')
      .leftJoin('event_types as bet', 'bet.id', 'b.event_type_id')
      .select((eb) => [
        floorMs(eb, eb.ref('b.start_at')).as('start_at'),
        ceilMs(eb, eb.ref('b.end_at')).as('end_at'),
        'b.event_type_id',
        'bet.buffer_before_minutes',
        'bet.buffer_after_minutes',
      ])
      .where('bh.user_id', '=', hostUserId)
      .where('bh.active', '=', true)
      .where((eb) => eb('bh.period', '&&', windowRange(eb)))
      .$if(excludeBookingId !== undefined, (q) => q.where('b.id', '<>', excludeBookingId as string))
      .execute(),
  ])

  const busyIntervals: InstantInterval[] = busy
    .map((row) => ({ start: toInstant(row.start), end: toInstant(row.end) }))
    // Cannot happen after widening; the engine refuses empty intervals, so never pass one.
    .filter((i) => Temporal.Instant.compare(i.end, i.start) > 0)
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
