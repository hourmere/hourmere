// Availability: public event pages, offered slots, and the mapping from the database to
// the availability engine (@hourmere/core). Every path that needs slots (the public page,
// creating and rescheduling bookings, later the MCP server) goes through
// buildAvailabilityInput, so they all see the same rules.
import {
  type AvailabilityInput,
  AvailabilityInputError,
  type DateOverride,
  type ExistingBooking,
  getAvailableSlots,
  type InstantInterval,
  isPublicTeamSlug,
  isReservedName,
  resolveDurationMinutes,
  type Slot,
  type WeeklyHours,
} from '@hourmere/core'
import { publicAvatarImage } from '@hourmere/core/public-avatar'
import type { Db, Json } from '@hourmere/db'
import { type Expression, type ExpressionBuilder, sql } from 'kysely'
import {
  automaticMeet,
  automaticZoom,
  eligibleMeetHosts,
  meetOrganizer,
  requireMeetDestination,
  requireZoomConnection,
} from './conferences.ts'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { assertHosts, hasValidHostShape } from './hosts.ts'
import { parseQuestions, type Question } from './questions.ts'
import { eligibleRoundRobinHosts } from './round-robin.ts'

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

/** RFC 3339 in UTC with milliseconds, e.g. `2026-10-15T09:30:00.000Z` (https://hourmere.com/docs/api-conventions). */
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

/** A bookable single-host event type, as the public page and booking path need it. */
export interface PublicEventTypeRecord {
  id: string
  organizationId: string
  /** The assigned host, or the owner on a personal page. */
  hostUserId: string
  hostUserIds: string[]
  eligibleHostUserIds: string[]
  zoomConnectionId?: string | null
  conferenceOrganizerUserId: string | null
  schedulingType: 'individual' | 'collective' | 'round_robin'
  hosts: { name: string; timeZone: string }[]
  handle: string
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  allowedDurationsMinutes: number[]
  /** Distance between candidate starts (the duration unless set). */
  slotStepMinutes: number
  configuredSlotStepMinutes: number | null
  minimumNoticeMinutes: number
  bookingWindowDays: number | null
  location: Location | null
  questions: Question[]
  allowGuests: boolean
  hostName: string
  hostImage?: string
  hostTimeZone: string
  team?: { name: string; slug: string }
}

/**
 * The handle as stored (lowercase), or undefined when no public page can have it: not a
 * handle, or a reserved name. A stored handle that became reserved after it was chosen is not
 * served, so nobody keeps a page at a path the app or the product now uses (/support, …).
 */
export function servedHandle(handle: string): string | undefined {
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
  options: { lock?: boolean } = {},
): Promise<PublicEventTypeRecord | undefined> {
  const h = servedHandle(handle)
  const s = slug.toLowerCase()
  if (h === undefined || !SLUG.test(s)) return undefined
  let query = db
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
      'et.allowed_durations_minutes',
      'et.slot_step_minutes',
      'et.minimum_notice_minutes',
      'et.booking_window_days',
      'et.location',
      'et.zoom_connection_id',
      'et.questions',
      'et.allow_guests',
      'p.user_id',
      'p.handle',
      'p.time_zone',
      'u.name',
      'u.image',
    ])
    .where('p.handle', '=', h)
    .where('et.slug', '=', s)
    .where('et.is_active', '=', true)
    .where('et.deleted_at', 'is', null)
  // Serialize host settings changes with approval of a new booking.
  if (options.lock) query = query.forShare('et')
  const row = await query.executeTakeFirst()
  if (!row) return undefined
  const image = publicAvatarImage(row.image)
  return {
    id: row.id,
    organizationId: row.organization_id,
    hostUserId: row.user_id,
    hostUserIds: [row.user_id],
    eligibleHostUserIds: [row.user_id],
    conferenceOrganizerUserId: null,
    zoomConnectionId: row.zoom_connection_id,
    schedulingType: 'individual',
    hosts: [{ name: row.name.trim() || row.handle, timeZone: row.time_zone }],
    handle: row.handle,
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    allowedDurationsMinutes: row.allowed_durations_minutes,
    slotStepMinutes: row.slot_step_minutes ?? row.duration_minutes,
    configuredSlotStepMinutes: row.slot_step_minutes,
    minimumNoticeMinutes: row.minimum_notice_minutes,
    bookingWindowDays: row.booking_window_days,
    location: parseLocation(row.location),
    questions: parseQuestions(row.questions),
    allowGuests: row.allow_guests,
    hostName: row.name.trim() || row.handle,
    ...(image && { hostImage: image }),
    hostTimeZone: row.time_zone,
  }
}

/**
 * A team link has its own namespace, /team/{teamSlug}/{slug}. Organization slugs use exact
 * stored case (their unique constraint is case-sensitive), unlike lowercase personal handles.
 * Only existing individual types with exactly one current team member as host are served.
 */
export async function findPublicTeamEventType(
  db: Db,
  teamSlug: string,
  slug: string,
  options: { lock?: boolean } = {},
): Promise<PublicEventTypeRecord | undefined> {
  const s = slug.toLowerCase()
  if (!isPublicTeamSlug(teamSlug) || !SLUG.test(s)) return undefined
  let query = db
    .selectFrom('auth.organization as o')
    .innerJoin('event_types as et', 'et.organization_id', 'o.id')
    .selectAll('et')
    .select(['o.slug as team_slug', 'o.name as team_name'])
    .where('o.slug', '=', teamSlug)
    .where('o.id', 'not in', (eb) =>
      eb.selectFrom('personal_organizations').select('organization_id'),
    )
    .where('et.slug', '=', s)
    .where('et.owner_user_id', 'is', null)
    .where('et.is_active', '=', true)
    .where('et.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('et.scheduling_type', 'in', ['individual', 'collective']),
        eb.and([
          eb('et.scheduling_type', '=', 'round_robin'),
          eb.exists(
            eb
              .selectFrom('round_robin_state as rr')
              .select('rr.event_type_id')
              .whereRef('rr.event_type_id', '=', 'et.id')
              .where('rr.enabled', '=', true),
          ),
        ]),
      ]),
    )
  if (options.lock) query = query.forShare('et')
  const row = await query.executeTakeFirst()
  if (!row) return undefined
  const hosts = await db
    .selectFrom('event_type_hosts as h')
    .innerJoin('auth.user as u', 'u.id', 'h.user_id')
    .leftJoin('profiles as p', 'p.user_id', 'h.user_id')
    .leftJoin('schedules as sc', (join) =>
      join
        .onRef('sc.user_id', '=', 'h.user_id')
        .on((eb) =>
          eb.or([
            eb('sc.id', '=', eb.ref('h.schedule_id')),
            eb.and([eb('h.schedule_id', 'is', null), eb('sc.is_default', '=', true)]),
          ]),
        ),
    )
    .select([
      'h.user_id',
      'u.name',
      sql<string>`coalesce(p.time_zone, sc.time_zone, 'UTC')`.as('time_zone'),
    ])
    .where('h.event_type_id', '=', row.id)
    .orderBy('h.user_id')
    .limit(9)
    .execute()
  const hostUserIds = hosts.map((h) => h.user_id)
  if (!hasValidHostShape(row.scheduling_type, hostUserIds)) return undefined
  let eligibleHostUserIds = hostUserIds
  if (row.scheduling_type === 'round_robin') {
    eligibleHostUserIds = await eligibleRoundRobinHosts(
      db,
      row.organization_id,
      hostUserIds,
      options.lock,
    )
    if (!eligibleHostUserIds.length) return undefined
    if (options.lock) {
      const current = await db
        .selectFrom('event_type_hosts')
        .select('user_id')
        .where('event_type_id', '=', row.id)
        .orderBy('user_id')
        .execute()
      if (current.map((host) => host.user_id).join() !== hostUserIds.join())
        throw new DomainError('conflict', 'booking_changed', 'The host pool changed; try again')
    }
  } else {
    try {
      await assertHosts(db, row.organization_id, hostUserIds, options.lock)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'invalid_hosts') return undefined
      throw error
    }
  }
  const views = hosts.map((h) => ({ name: h.name.trim() || row.team_name, timeZone: h.time_zone }))
  return {
    id: row.id,
    organizationId: row.organization_id,
    hostUserId: hostUserIds[0] as string,
    hostUserIds,
    eligibleHostUserIds,
    conferenceOrganizerUserId: row.conference_organizer_user_id,
    zoomConnectionId: row.zoom_connection_id,
    schedulingType: row.scheduling_type as PublicEventTypeRecord['schedulingType'],
    hosts: views,
    handle: row.team_slug,
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    allowedDurationsMinutes: row.allowed_durations_minutes,
    slotStepMinutes: row.slot_step_minutes ?? row.duration_minutes,
    configuredSlotStepMinutes: row.slot_step_minutes,
    minimumNoticeMinutes: row.minimum_notice_minutes,
    bookingWindowDays: row.booking_window_days,
    location: parseLocation(row.location),
    questions: parseQuestions(row.questions),
    allowGuests: row.allow_guests,
    hostName:
      row.scheduling_type === 'round_robin' ? row.team_name : views.map((h) => h.name).join(', '),
    hostTimeZone: views[0]?.timeZone ?? 'UTC',
    team: { name: row.team_name, slug: row.team_slug },
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
  allowGuests: boolean
  host: { name: string; timeZone?: string; image?: string }
  /** Every required host, without private identities or availability. */
  hosts?: { name: string; timeZone: string }[]
  schedulingType?: 'round_robin'
  team?: { name: string; slug: string }
}

export async function getPublicEventType(
  ctx: PublicContext,
  { handle, slug }: { handle: string; slug: string },
): Promise<PublicEventType> {
  return publicEventType(await findPublicEventType(ctx.db, handle, slug))
}

export async function getPublicTeamEventType(
  ctx: PublicContext,
  { handle, slug }: { handle: string; slug: string },
): Promise<PublicEventType> {
  return publicEventType(await findPublicTeamEventType(ctx.db, handle, slug))
}

function publicEventType(et: PublicEventTypeRecord | undefined): PublicEventType {
  if (!et) throw eventTypeNotFound()
  return {
    handle: et.handle,
    slug: et.slug,
    title: et.title,
    description: et.description,
    durationMinutes: et.durationMinutes,
    location: et.location && { kind: et.location.kind },
    questions: et.questions,
    allowGuests: et.allowGuests,
    host: {
      name: et.hostName,
      ...(et.hostImage && { image: et.hostImage }),
      ...(et.schedulingType !== 'round_robin' && { timeZone: et.hostTimeZone }),
    },
    ...(et.schedulingType === 'collective' && et.hosts.length > 1 && { hosts: et.hosts }),
    ...(et.schedulingType === 'round_robin' && { schedulingType: 'round_robin' as const }),
    ...(et.team && { team: et.team }),
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
  host: { name: string; timeZone: string; image?: string }
  eventTypes: PublicEventTypeSummary[]
}

/**
 * The host at /{handle} and their listed, bookable personal event types (active, not hidden or deleted, in an
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
          .select(['p.user_id', 'p.handle', 'p.time_zone', 'u.name', 'u.image'])
          .where('p.handle', '=', h)
          .executeTakeFirst()
  if (!profile) throw new DomainError('not_found', 'host_not_found', 'No such booking page')
  const image = publicAvatarImage(profile.image)
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
    .where('et.is_hidden', '=', false)
    .where('et.deleted_at', 'is', null)
    .orderBy('et.position')
    .orderBy('et.id')
    .execute()
  return {
    handle: profile.handle,
    host: {
      name: profile.name.trim() || profile.handle,
      timeZone: profile.time_zone,
      ...(image && { image }),
    },
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
  hostCount = 1,
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
    MAX_SLOT_CANDIDATES / hostCount
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
  input: {
    handle: string
    slug: string
    start: Temporal.Instant
    end: Temporal.Instant
    durationMinutes?: number
  },
): Promise<SlotView[]> {
  return publicSlots(ctx, input, findPublicEventType)
}

export async function listPublicTeamSlots(
  ctx: PublicContext,
  input: {
    handle: string
    slug: string
    start: Temporal.Instant
    end: Temporal.Instant
    durationMinutes?: number
  },
): Promise<SlotView[]> {
  return publicSlots(ctx, input, findPublicTeamEventType)
}

async function publicSlots(
  ctx: PublicContext,
  input: {
    handle: string
    slug: string
    start: Temporal.Instant
    end: Temporal.Instant
    durationMinutes?: number
  },
  resolve: typeof findPublicEventType,
): Promise<SlotView[]> {
  checkSlotRange(input.start, input.end)
  const et = await resolve(ctx.db, input.handle, input.slug)
  if (!et) throw eventTypeNotFound()
  const durationMinutes = selectDurationMinutes(et, input.durationMinutes)
  const now = ctx.now()
  if (automaticZoom(et.location)) {
    if (et.schedulingType !== 'individual' || et.hostUserIds.length !== 1)
      throw new DomainError('conflict', 'automatic_zoom_host_policy')
    await requireZoomConnection(ctx.db, et.hostUserId, et.zoomConnectionId, ctx.automaticZoom, true)
  }
  if (automaticMeet(et.location)) {
    if (et.schedulingType === 'round_robin')
      et.eligibleHostUserIds = await eligibleMeetHosts(
        ctx.db,
        et.eligibleHostUserIds,
        et.id,
        ctx.automaticMeet,
      )
    else
      await requireMeetDestination(
        ctx.db,
        meetOrganizer(et.schedulingType, et.hostUserIds, et.conferenceOrganizerUserId) as string,
        et.id,
        ctx.automaticMeet,
      )
  }
  // Without an explicit step, each selected duration supplies its own start grid.
  const rules = { ...et, slotStepMinutes: et.configuredSlotStepMinutes ?? durationMinutes }
  if (!hasBookablePart(rules, input.start, input.end, now, et.hostUserIds.length)) return []
  if (et.schedulingType === 'round_robin')
    return unionRoundRobinSlots(
      ctx.db,
      et.id,
      et.eligibleHostUserIds,
      input.start,
      input.end,
      now,
      durationMinutes,
    )
  return intersectSlots(
    ctx.db,
    et.id,
    et.hostUserIds,
    input.start,
    input.end,
    now,
    undefined,
    et.hostUserIds.length > 1,
    durationMinutes,
  )
}

// --- The database → engine mapping ------------------------------------------------------

/** Shared service validation for an explicit selected duration or the default. */
export function selectDurationMinutes(
  eventType: { durationMinutes: number; allowedDurationsMinutes?: readonly number[] },
  selected?: number,
): number {
  try {
    return resolveDurationMinutes(eventType, selected)
  } catch (error) {
    if (!(error instanceof AvailabilityInputError)) throw error
    throw new DomainError('invalid', 'invalid_duration', error.message)
  }
}

export interface AvailabilityQuery {
  /** The event type whose rules (duration, step, buffers, notice, window, limit) apply. */
  eventTypeId: string
  /** Explicit selected duration; omitted = default, or original when rescheduling. */
  durationMinutes?: number | undefined
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
  /** Collective snapshots always use each original host’s current default schedule. */
  useDefaultSchedule?: boolean | undefined
}

export interface CachedCalendarSync {
  status: string
  last_synced_at: Date | null
  sync_state: Json | null
  sync_error: string | null
  time_zone: string | null
}

/** Cache-only metadata guard; a supplied window also requires full snapshot coverage. */
export function assertCachedCalendarSync(
  calendars: readonly CachedCalendarSync[],
  now: Temporal.Instant,
  window?: { start: Temporal.Instant; end: Temporal.Instant },
): void {
  for (const calendar of calendars) {
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
      state.version !== 2 ||
      state.timeZone !== calendar.time_zone ||
      typeof state.start !== 'string' ||
      typeof state.end !== 'string'
    )
      throw unavailable()
    try {
      const start = Temporal.Instant.from(state.start)
      const end = Temporal.Instant.from(state.end)
      if (
        Temporal.Instant.compare(start, end) >= 0 ||
        (window &&
          (Temporal.Instant.compare(start, window.start) > 0 ||
            Temporal.Instant.compare(end, window.end) < 0))
      )
        throw unavailable()
    } catch {
      throw unavailable()
    }
  }
}

/**
 * Builds the availability engine's input for one host and event type from the database:
 *
 * - schedule: the host's schedule for this event type (`event_type_hosts.schedule_id`), or
 *   the host's default schedule; with neither, there is nothing to offer (`undefined`).
 *   Date overrides near the range are included.
 * - busy: intervals mirrored from the host's calendars that have `check_conflicts` on,
 *   clipped to the window around the range (so unbounded and infinite ones work), except
 *   the calendar event mirrored from `excludeBookingId` itself. All-day dates expand at
 *   local day boundaries in the schedule being evaluated, independently of calendar zone.
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
      'et.allowed_durations_minutes',
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
  let durationMinutes: number
  if (excludeBookingId !== undefined && query.durationMinutes === undefined) {
    const original = await db
      .selectFrom('bookings')
      .select(['start_at', 'end_at'])
      .where('id', '=', excludeBookingId)
      .where('event_type_id', '=', eventTypeId)
      .executeTakeFirstOrThrow()
    durationMinutes = toInstant(original.end_at)
      .since(toInstant(original.start_at))
      .total('minutes')
  } else {
    durationMinutes = selectDurationMinutes(
      {
        durationMinutes: eventType.duration_minutes,
        allowedDurationsMinutes: eventType.allowed_durations_minutes,
      },
      query.durationMinutes,
    )
  }

  const scheduleId = query.useDefaultSchedule ? null : eventType.schedule_id
  const schedule = await db
    .selectFrom('schedules')
    .select(['id', 'time_zone', 'weekly_hours'])
    .where('user_id', '=', hostUserId)
    .$if(scheduleId !== null, (q) => q.where('id', '=', scheduleId as string))
    .$if(scheduleId === null, (q) => q.where('is_default', '=', true))
    .executeTakeFirst()
  if (!schedule) return undefined

  // Wide enough for anything that can affect a slot in the range: the engine visits one
  // extra local day on each side (UTC offsets stay within ±14 hours), and a booking's
  // buffers plus the new slot's reach at most 2 × 1440 minutes.
  const window = { start: rangeStart.subtract({ hours: 72 }), end: rangeEnd.add({ hours: 72 }) }
  const googleCalendars = await db
    .selectFrom('calendars as c')
    .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
    .select(['cc.status', 'c.last_synced_at', 'c.sync_state', 'c.sync_error', 'c.time_zone'])
    .where('cc.user_id', '=', hostUserId)
    .where('cc.provider', '=', 'google')
    .where('c.check_conflicts', '=', true)
    .execute()
  assertCachedCalendarSync(googleCalendars, now, window)
  const windowRange = <DB, TB extends keyof DB>(eb: ExpressionBuilder<DB, TB>) =>
    eb.fn<string>('tstzrange', [eb.val(window.start.toString()), eb.val(window.end.toString())])
  const windowDates = {
    start: boundedDate(window.start, schedule.time_zone),
    end: boundedDate(window.end, schedule.time_zone),
  }
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
      .where('date', '>=', boundedDate(window.start))
      .where('date', '<=', boundedDate(window.end))
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
          'cb.all_day_start',
          'cb.all_day_end',
        ]
      })
      .where('cc.user_id', '=', hostUserId)
      .where('c.check_conflicts', '=', true)
      .where((eb) =>
        eb.or([
          eb('cb.period', '&&', windowRange(eb)),
          eb.and([
            eb('cb.all_day_start', '<=', windowDates.end),
            eb('cb.all_day_end', '>', windowDates.start),
          ]),
        ]),
      )
      // The moved booking's own event in the host's calendar must not block its new time.
      .$if(excludeBookingId !== undefined, (q) =>
        q.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('booking_calendar_events as bce')
                .innerJoin(
                  'calendars as written_calendar',
                  'written_calendar.id',
                  'bce.calendar_id',
                )
                .innerJoin(
                  'calendar_connections as written_connection',
                  'written_connection.id',
                  'written_calendar.connection_id',
                )
                .select('bce.booking_id')
                .where(sql<boolean>`bce.booking_id IN (
                  WITH RECURSIVE ancestors(id,rescheduled_from_id) AS (
                    SELECT id,rescheduled_from_id FROM bookings WHERE id=${excludeBookingId as string}::uuid
                    UNION ALL SELECT b.id,b.rescheduled_from_id FROM bookings b JOIN ancestors a ON b.id=a.rescheduled_from_id
                  ) CYCLE id SET is_cycle USING path SELECT id FROM ancestors WHERE NOT is_cycle
                )`)
                .where(({ or, and, eb }) =>
                  or([
                    eb('bce.calendar_id', '=', eb.ref('cb.calendar_id')),
                    and([
                      eb('cc.provider', '=', 'google'),
                      eb('written_connection.provider', '=', 'google'),
                      eb('written_connection.user_id', '=', hostUserId),
                      eb('written_calendar.external_id', '=', eb.ref('c.external_id')),
                    ]),
                  ]),
                )
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
    .map((row) => {
      if (row.all_day_start !== null && row.all_day_end !== null) {
        // Resolve both dates separately: a local day can span 23 or 25 hours across DST.
        const start = Temporal.PlainDate.from(row.all_day_start)
          .toZonedDateTime(schedule.time_zone)
          .toInstant()
        const end = Temporal.PlainDate.from(row.all_day_end)
          .toZonedDateTime(schedule.time_zone)
          .toInstant()
        return { start: later(start, window.start), end: earlier(end, window.end) }
      }
      return { start: toInstant(row.start), end: toInstant(row.end) }
    })
    // The engine refuses empty intervals, including a local date skipped by a zone change.
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
      durationMinutes,
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

/** A window's date, kept inside the years Postgres and the engine accept. */
function boundedDate(instant: Temporal.Instant, timeZone = 'UTC'): string {
  const date = instant.toZonedDateTimeISO(timeZone).toPlainDate()
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

/** Full interval intersection; all hosts share the public candidate budget. */
export async function intersectSlots(
  db: Db,
  eventTypeId: string,
  hostUserIds: readonly string[],
  rangeStart: Temporal.Instant,
  rangeEnd: Temporal.Instant,
  now: Temporal.Instant,
  excludeBookingId?: string,
  useDefaultSchedule = hostUserIds.length > 1,
  durationMinutes?: number,
): Promise<SlotView[]> {
  let offered: SlotView[] | undefined
  for (const hostUserId of hostUserIds) {
    const slots = await findSlots(db, {
      eventTypeId,
      hostUserId,
      rangeStart,
      rangeEnd,
      now,
      excludeBookingId,
      useDefaultSchedule,
      durationMinutes,
    })
    const views = slots.map((s) => ({ start: toIso(s.start), end: toIso(s.end) }))
    if (offered === undefined) offered = views
    else {
      const keys = new Set(views.map((v) => `${v.start}/${v.end}`))
      offered = offered.filter((v) => keys.has(`${v.start}/${v.end}`))
    }
  }
  return offered ?? []
}

/** Only known stale-calendar failures degrade one pool member; every other error propagates. */
export async function unionRoundRobinSlots(
  db: Db,
  eventTypeId: string,
  userIds: readonly string[],
  rangeStart: Temporal.Instant,
  rangeEnd: Temporal.Instant,
  now: Temporal.Instant,
  durationMinutes?: number,
): Promise<SlotView[]> {
  const offered = new Map<string, SlotView>()
  let stale = false
  for (const hostUserId of userIds) {
    try {
      const slots = await findSlots(db, {
        eventTypeId,
        hostUserId,
        rangeStart,
        rangeEnd,
        now,
        useDefaultSchedule: true,
        durationMinutes,
      })
      for (const slot of slots) {
        const view = { start: toIso(slot.start), end: toIso(slot.end) }
        offered.set(`${view.start}/${view.end}`, view)
      }
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'calendar_sync_unavailable') throw error
      stale = true
    }
  }
  if (!offered.size && stale)
    throw new DomainError(
      'conflict',
      'calendar_sync_unavailable',
      'The host calendars are temporarily unavailable. Try again shortly.',
    )
  return [...offered.values()].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
  )
}
