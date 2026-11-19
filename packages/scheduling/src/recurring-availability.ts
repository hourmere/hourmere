import {
  checkExplicitStarts,
  type ExplicitStartCounts,
  type InstantInterval,
  type Slot,
} from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { type Expression, sql } from 'kysely'
import {
  activeGroupBookings,
  activeHostBookings,
  assertCachedCalendarSync,
  availabilityFactWindow,
  availabilityRules,
  availabilitySchedule,
  bookingFact,
  boundedDate,
  cachedConflictCalendars,
  calendarBusyFacts,
  calendarBusyIntervals,
  eventTypeNotFound,
  occupyingGroupBookings,
  occupyingHostBookings,
  selectDurationMinutes,
} from './availability.ts'
import { DomainError } from './errors.ts'
import { eligibleHostIds, hasValidHostShape } from './hosts.ts'
import {
  type RecurringAvailabilityBudget,
  type RecurringAvailabilityMetrics,
  withRecurringAvailabilityBudget,
} from './recurring-availability-budget.ts'
import {
  MAX_RECURRING_HORIZON_DAYS,
  MAX_RECURRING_OCCURRENCES,
  MIN_RECURRING_OCCURRENCES,
  type RecurringOccurrence,
} from './recurring-rules.ts'

export interface RecurringAvailabilityInput {
  eventTypeId: string
  organizationId: string
  occurrences: readonly RecurringOccurrence[]
  now: Temporal.Instant
  durationMinutes?: number
}

interface OccurrenceAvailability {
  ordinal: number
  available: boolean
  reason?: 'unavailable' | 'outside_booking_window' | 'nonexistent_local_time'
}

export interface RecurringAvailabilityResult {
  canBook: boolean
  occurrences: OccurrenceAvailability[]
  seriesReason?: 'no_common_host'
  /** Internal assignment candidates. Only the occurrence results are safe for invitees. */
  hostUserIds: string[]
  metrics: RecurringAvailabilityMetrics
}

const invalidRecurrence = () =>
  new DomainError('invalid', 'invalid_recurrence', 'The requested series dates are invalid.')

const unavailableCalendar = () =>
  new DomainError(
    'conflict',
    'calendar_sync_unavailable',
    'The host calendars are temporarily unavailable. Try again shortly.',
  )

/** Cache-only check for normalized dates. Caller owns event authorization and later assignment. */
export async function checkRecurringAvailability(
  db: Db,
  input: RecurringAvailabilityInput,
): Promise<RecurringAvailabilityResult> {
  if (
    input.occurrences.length < MIN_RECURRING_OCCURRENCES ||
    input.occurrences.length > MAX_RECURRING_OCCURRENCES
  )
    throw invalidRecurrence()

  const starts: Slot[] = []
  const range = { start: null as Temporal.Instant | null, end: null as Temporal.Instant | null }
  for (const [index, occurrence] of input.occurrences.entries()) {
    if (occurrence.ordinal !== index + 1) throw invalidRecurrence()
    const { start, end } = occurrence
    if (start === null) continue
    if (
      Temporal.Instant.compare(start, end) >= 0 ||
      end.since(start).total('minutes') > 1440 ||
      start.toZonedDateTimeISO('UTC').year < 1 ||
      end.toZonedDateTimeISO('UTC').year > 9999
    )
      throw invalidRecurrence()
    starts.push({ start, end })
    if (!range.start || Temporal.Instant.compare(start, range.start) < 0) range.start = start
    if (!range.end || Temporal.Instant.compare(end, range.end) > 0) range.end = end
  }
  // A local-calendar year plus the duration and offset changes can exceed 366 elapsed days.
  if (
    !range.start ||
    !range.end ||
    range.end.since(range.start).total('hours') > (MAX_RECURRING_HORIZON_DAYS + 2) * 24
  )
    throw invalidRecurrence()
  const span = { start: range.start, end: range.end }
  return withRecurringAvailabilityBudget(db, (connection, budget) =>
    checkBatch(connection, budget, input, starts, span),
  )
}

async function checkBatch(
  db: Db,
  budget: RecurringAvailabilityBudget,
  input: RecurringAvailabilityInput,
  starts: readonly Slot[],
  span: InstantInterval,
): Promise<RecurringAvailabilityResult> {
  const { eventTypeId, organizationId, now } = input
  const [event] = await budget.read(
    db
      .selectFrom('event_types as et')
      .select([
        'et.scheduling_type',
        'et.booking_mode',
        'et.duration_minutes',
        'et.allowed_durations_minutes',
        'et.slot_step_minutes',
        'et.buffer_before_minutes',
        'et.buffer_after_minutes',
        'et.minimum_notice_minutes',
        'et.booking_window_days',
        'et.max_bookings_per_day',
        'et.max_bookings_per_week',
        'et.max_bookings_per_month',
      ])
      .where('et.id', '=', eventTypeId)
      .where('et.organization_id', '=', organizationId)
      .where('et.is_active', '=', true)
      .where('et.deleted_at', 'is', null)
      .where(({ eb, exists, or, selectFrom }) =>
        or([
          eb('et.scheduling_type', '!=', 'round_robin'),
          exists(
            selectFrom('round_robin_state as rr')
              .select('rr.event_type_id')
              .whereRef('rr.event_type_id', '=', 'et.id')
              .where('rr.enabled', '=', true),
          ),
        ]),
      ),
  )
  if (!event) throw eventTypeNotFound()
  if (event.booking_mode === 'group')
    throw new DomainError(
      'invalid',
      'recurrence_not_supported',
      'This event does not support a series.',
    )

  const durationMinutes = selectDurationMinutes(
    {
      durationMinutes: event.duration_minutes,
      allowedDurationsMinutes: event.allowed_durations_minutes,
    },
    input.durationMinutes,
  )
  if (starts.some(({ start, end }) => !start.add({ minutes: durationMinutes }).equals(end)))
    throw invalidRecurrence()

  const mode = event.scheduling_type
  const configuredUser = sql<string>`coalesce(et.owner_user_id, h.user_id)`
  const hostRows = await budget.read(
    db
      .selectFrom('event_types as et')
      // A personal event uses its owner, even without a selected schedule assignment.
      .leftJoin('event_type_hosts as h', (join) =>
        join
          .onRef('h.event_type_id', '=', 'et.id')
          .on((eb) =>
            eb.or([
              eb('et.owner_user_id', 'is', null),
              eb('et.owner_user_id', '=', eb.ref('h.user_id')),
            ]),
          ),
      )
      // Missing verification/membership stays visible as ineligible for a required host set.
      .innerJoin('auth.user as u', (join) => join.on('u.id', '=', configuredUser))
      .leftJoin('schedules as s', (join) =>
        join
          .onRef('s.user_id', '=', 'u.id')
          .on((eb) =>
            mode !== 'individual'
              ? eb('s.is_default', '=', true)
              : eb.or([
                  eb('s.id', '=', eb.ref('h.schedule_id')),
                  eb.and([eb('h.schedule_id', 'is', null), eb('s.is_default', '=', true)]),
                ]),
          ),
      )
      .select([
        'u.id as user_id',
        'u.emailVerified',
        's.id as schedule_id',
        's.time_zone',
        's.weekly_hours',
      ])
      .select(({ exists, selectFrom }) =>
        exists(
          selectFrom('auth.member as m')
            .select('m.id')
            .whereRef('m.userId', '=', 'u.id')
            .whereRef('m.organizationId', '=', 'et.organization_id'),
        ).as('is_member'),
      )
      .where('et.id', '=', eventTypeId)
      .where('et.organization_id', '=', organizationId)
      .orderBy('u.id')
      .limit(9),
  )
  const configured = hostRows.map((host) => host.user_id)
  if (!hasValidHostShape(mode, configured)) throw eventTypeNotFound()
  const eligible = new Set(
    eligibleHostIds(
      organizationId,
      configured,
      hostRows.map((host) => ({ id: host.user_id, emailVerified: host.emailVerified === true })),
      hostRows.flatMap((host) =>
        host.is_member ? [{ userId: host.user_id, organizationId }] : [],
      ),
    ),
  )
  if (!eligible.size || (mode !== 'round_robin' && configured.length !== eligible.size))
    throw eventTypeNotFound()

  const hosts = hostRows.filter((host) => eligible.has(host.user_id))
  const scheduled = hosts.flatMap((host) =>
    host.schedule_id && host.time_zone && host.weekly_hours
      ? [
          {
            userId: host.user_id,
            scheduleId: host.schedule_id,
            timeZone: host.time_zone,
            weeklyHours: host.weekly_hours,
            dates: starts.map(({ start }) =>
              start.toZonedDateTimeISO(host.time_zone as string).toPlainDate(),
            ),
          },
        ]
      : [],
  )
  const rules = availabilityRules(event, durationMinutes)
  const windows = starts.map(availabilityFactWindow)
  const window = availabilityFactWindow(span)
  const facts = scheduled.length
    ? await loadFacts(db, budget, scheduled, windows, window)
    : undefined
  const periodCounts = await loadPeriodCounts(db, budget, scheduled, rules, eventTypeId)

  const results = hosts.map((host) => {
    const schedule = scheduled.find((item) => item.userId === host.user_id)
    if (!schedule || !facts) {
      return {
        id: host.user_id,
        checks: starts.map(() => {
          budget.evaluate()
          return { available: false, unknown: false, outsideBookingWindow: false }
        }),
      }
    }
    const calendars = facts.calendars.filter((row) => row.user_id === schedule.userId)
    const stale = windows.map((target) => {
      try {
        assertCachedCalendarSync(calendars, now, target)
        return false
      } catch (error) {
        if (
          mode !== 'round_robin' ||
          !(error instanceof DomainError) ||
          error.code !== 'calendar_sync_unavailable'
        )
          throw error
        return true
      }
    })
    const busy = calendarBusyIntervals(
      facts.busy.filter((row) => row.user_id === schedule.userId),
      schedule.timeZone,
      window,
    )
    const bookings = facts.bookings
      .filter((row) => row.user_id === schedule.userId)
      .map(bookingFact)
    const checks = checkExplicitStarts(
      {
        schedule: availabilitySchedule(
          schedule.timeZone,
          schedule.weeklyHours,
          facts.overrides.filter((row) => row.schedule_id === schedule.scheduleId),
        ),
        eventType: rules,
        busy,
        bookings,
        rangeStart: span.start,
        rangeEnd: span.end,
        now,
      },
      starts,
      periodCounts.get(schedule.userId) ?? starts.map(() => ({})),
      { checkpoint: () => budget.evaluate(), ignoreBusy: stale },
    )
    return {
      id: schedule.userId,
      checks: checks.map((result, index) => ({
        available: result.available && !stale[index],
        unknown: result.available && !!stale[index],
        outsideBookingWindow: result.outsideBookingWindow === true,
      })),
    }
  })

  const common = results.filter(({ checks }) => checks.every((check) => check.available))
  if (
    mode === 'round_robin' &&
    !common.length &&
    results.some(({ checks }) => checks.every((check) => check.available || check.unknown))
  )
    throw unavailableCalendar()

  let index = 0
  const occurrences: OccurrenceAvailability[] = input.occurrences.map(({ ordinal, start }) => {
    if (start === null) return { ordinal, available: false, reason: 'nonexistent_local_time' }
    const checks = results.map((host) => host.checks[index])
    index++
    const available =
      mode === 'round_robin'
        ? checks.some((check) => check?.available)
        : checks.every((check) => check?.available)
    if (available) return { ordinal, available }
    if (checks.some((check) => check?.unknown)) throw unavailableCalendar()
    const outsideWindow =
      mode === 'round_robin'
        ? checks.every((check) => check?.outsideBookingWindow)
        : checks.some((check) => check?.outsideBookingWindow)
    return { ordinal, available, reason: outsideWindow ? 'outside_booking_window' : 'unavailable' }
  })
  const allDatesAvailable = occurrences.every(({ available }) => available)
  const hostUserIds = allDatesAvailable
    ? mode === 'round_robin'
      ? common.map(({ id }) => id)
      : configured
    : []
  return {
    canBook: hostUserIds.length > 0,
    occurrences,
    ...(mode === 'round_robin' &&
      allDatesAvailable &&
      !common.length && { seriesReason: 'no_common_host' }),
    hostUserIds,
    metrics: budget.metrics,
  }
}

interface ScheduledHost {
  userId: string
  scheduleId: string
  timeZone: string
  dates: readonly Temporal.PlainDate[]
}

function union<Row>(queries: readonly Expression<Row>[]): Expression<Row> {
  return sql<Row>`(${sql.join(queries, sql` union all `)})`
}

function overlap<Range>(column: Expression<Range>, windows: readonly InstantInterval[]) {
  const ranges = windows.map(
    ({ start, end }) =>
      sql`tstzrange(${start.toString()}::timestamptz, ${end.toString()}::timestamptz)`,
  )
  return sql<boolean>`${column} && any(array[${sql.join(ranges)}])`
}

async function loadFacts(
  db: Db,
  budget: RecurringAvailabilityBudget,
  hosts: readonly ScheduledHost[],
  windows: readonly InstantInterval[],
  window: InstantInterval,
) {
  const calendars = await budget.read(
    cachedConflictCalendars(db)
      .select('cc.user_id')
      .where(
        'cc.user_id',
        'in',
        hosts.map(({ userId }) => userId),
      ),
  )
  const overrides = await budget.read(
    union(
      hosts.map((host) =>
        db
          .selectFrom('schedule_overrides')
          .select(['schedule_id', 'date', 'intervals'])
          .where('schedule_id', '=', host.scheduleId)
          .where('date', 'in', [...new Set(host.dates.map((date) => date.toString()))]),
      ),
    ),
  )
  const busy = await budget.read(
    union(
      hosts.map(({ userId, timeZone }) =>
        calendarBusyFacts(db, window)
          .select('cc.user_id')
          .where('cc.user_id', '=', userId)
          .where(({ eb, or, and, ref }) =>
            or([
              overlap(ref('cb.period'), windows),
              ...windows.map((target) =>
                and([
                  eb('cb.all_day_start', '<=', boundedDate(target.end, timeZone)),
                  eb('cb.all_day_end', '>', boundedDate(target.start, timeZone)),
                ]),
              ),
            ]),
          ),
      ),
    ),
  )
  const bookings = await budget.read(
    union(
      hosts.flatMap(({ userId }) => [
        activeHostBookings(db)
          .select('bh.user_id')
          .where('bh.user_id', '=', userId)
          .where(({ ref }) => overlap(ref('bh.period'), windows)),
        activeGroupBookings(db)
          .select('gh.user_id')
          .where('gh.user_id', '=', userId)
          .where(({ ref }) => overlap(ref('gh.period'), windows)),
      ]),
    ),
  )
  return { calendars, overrides, busy, bookings }
}

type Period = keyof ExplicitStartCounts

interface RequestedPeriod {
  start: Temporal.PlainDate
  end: Temporal.PlainDate
  kind: Period
}

/** Count only the requested local dates or complete Monday weeks/calendar months. */
function requestedPeriods(
  date: Temporal.PlainDate,
  rules: ReturnType<typeof availabilityRules>,
): RequestedPeriod[] {
  const week = date.subtract({ days: date.dayOfWeek - 1 })
  const month = date.with({ day: 1 })
  return [
    ...(rules.maxBookingsPerDay !== undefined
      ? [{ kind: 'day' as const, start: date, end: date.add({ days: 1 }) }]
      : []),
    ...(rules.maxBookingsPerWeek !== undefined
      ? [{ kind: 'week' as const, start: week, end: week.add({ weeks: 1 }) }]
      : []),
    ...(rules.maxBookingsPerMonth !== undefined
      ? [{ kind: 'month' as const, start: month, end: month.add({ months: 1 }) }]
      : []),
  ]
}

/** Map a local period to indexable UTC pieces, including its repeated date at a midnight rollback. */
function periodRanges(period: RequestedPeriod, timeZone: string): InstantInterval[] {
  const nominalStart = period.start.toZonedDateTime('UTC').toInstant()
  const nominalEnd = period.end.toZonedDateTime('UTC').toInstant()
  let cursor = nominalStart.subtract({ hours: 24 })
  const stop = nominalEnd.add({ hours: 24 })
  const ranges: InstantInterval[] = []
  while (Temporal.Instant.compare(cursor, stop) < 0) {
    const zoned = cursor.toZonedDateTimeISO(timeZone)
    const transition = zoned.getTimeZoneTransition('next')?.toInstant()
    const next = transition && Temporal.Instant.compare(transition, stop) < 0 ? transition : stop
    const offset = BigInt(zoned.offsetNanoseconds)
    const lower = Temporal.Instant.fromEpochNanoseconds(nominalStart.epochNanoseconds - offset)
    const upper = Temporal.Instant.fromEpochNanoseconds(nominalEnd.epochNanoseconds - offset)
    const start = Temporal.Instant.compare(lower, cursor) > 0 ? lower : cursor
    const end = Temporal.Instant.compare(upper, next) < 0 ? upper : next
    if (Temporal.Instant.compare(start, end) < 0) ranges.push({ start, end })
    cursor = next
  }
  return ranges
}

async function loadPeriodCounts(
  db: Db,
  budget: RecurringAvailabilityBudget,
  hosts: readonly ScheduledHost[],
  rules: ReturnType<typeof availabilityRules>,
  eventTypeId: string,
): Promise<Map<string, ExplicitStartCounts[]>> {
  const ids = new Map<string, number>()
  const ranges: { id: number; host: string; start_at: string; end_at: string }[] = []
  const ordinals = hosts.map((host) =>
    host.dates.map((date) =>
      requestedPeriods(date, rules).map((period) => {
        const key = `${host.userId}/${period.kind}/${period.start}`
        let id = ids.get(key)
        if (id === undefined) {
          id = ids.size
          ids.set(key, id)
          for (const { start, end } of periodRanges(period, host.timeZone)) {
            ranges.push({
              id,
              host: host.userId,
              start_at: start.toString(),
              end_at: end.toString(),
            })
          }
        }
        return { period: period.kind, id }
      }),
    ),
  )
  if (!ranges.length) return new Map()
  const ordinary = occupyingHostBookings(db)
    .select(sql<number>`count(*)`.as('n'))
    .where('b.event_type_id', '=', eventTypeId)
    .where('bh.user_id', '=', sql<string>`p.host`)
    .where('b.start_at', '>=', sql<Date>`p.start_at`)
    .where('b.start_at', '<', sql<Date>`p.end_at`)
  const groups = occupyingGroupBookings(db)
    .select(sql<number>`count(*)`.as('n'))
    .where('gs.event_type_id', '=', eventTypeId)
    .where('gh.user_id', '=', sql<string>`p.host`)
    .where('gs.start_at', '>=', sql<Date>`p.start_at`)
    .where('gs.start_at', '<', sql<Date>`p.end_at`)
  const rows = await budget.read(sql<{ id: number; count: number }>`(
    select p.id, least(sum(ordinary.n + groups.n), 2147483647)::int as count
    from jsonb_to_recordset(${JSON.stringify(ranges)}::jsonb)
      as p(id integer, host uuid, start_at timestamptz, end_at timestamptz)
    cross join lateral ${ordinary} as ordinary
    cross join lateral ${groups} as groups
    group by p.id
  )`)
  const countsById = new Map(rows.map((row) => [row.id, row.count]))
  return new Map(
    hosts.map(({ userId }, index) => [
      userId,
      (ordinals[index] ?? []).map((periods) =>
        Object.fromEntries(periods.map(({ period, id }) => [period, countsById.get(id) ?? 0])),
      ),
    ]),
  )
}
