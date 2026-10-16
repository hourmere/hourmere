import type {
  AvailabilityInput,
  EventTypeRules,
  InstantInterval,
  WallClockInterval,
  Weekday,
  WeeklyHours,
} from './types.ts'

/** Thrown when `getAvailableSlots` receives input it cannot interpret. */
export class AvailabilityInputError extends Error {
  override readonly name = 'AvailabilityInputError'
}

/** Wall-clock interval as minutes since local midnight: [start, end), 0 <= start < end <= 1440. */
export interface MinuteInterval {
  readonly start: number
  readonly end: number
}

/** An existing booking with its buffers defaulted. */
export interface NormalizedBooking extends InstantInterval {
  readonly bufferBeforeMinutes: number
  readonly bufferAfterMinutes: number
}

/** Input after validation, with defaults applied and wall-clock times parsed. */
export interface NormalizedInput {
  readonly timeZone: string
  /** Keyed by ISO weekday: 1 = Monday … 7 = Sunday. Sorted, touching intervals joined. */
  readonly weeklyHours: ReadonlyMap<number, readonly MinuteInterval[]>
  /** Keyed by `"YYYY-MM-DD"`. Sorted, touching intervals joined; empty = unavailable. */
  readonly dateOverrides: ReadonlyMap<string, readonly MinuteInterval[]>
  readonly durationMinutes: number
  readonly slotStepMinutes: number
  readonly bufferBeforeMinutes: number
  readonly bufferAfterMinutes: number
  readonly minimumNoticeMinutes: number
  readonly maxBookingsPerDay: number | undefined
  readonly bookingWindowDays: number | undefined
  readonly busy: readonly InstantInterval[]
  readonly bookings: readonly NormalizedBooking[]
  readonly rangeStart: Temporal.Instant
  readonly rangeEnd: Temporal.Instant
  readonly now: Temporal.Instant
}

const WEEKDAYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

const MINUTES_PER_DAY = 24 * 60
const NS_PER_DAY = 86_400_000_000_000n

/**
 * Bounds of each event type rule (inclusive). Besides rejecting nonsense, they keep every
 * Temporal calculation inside its supported range, so bad input always ends in an
 * AvailabilityInputError rather than a RangeError. The database CHECKs on `event_types`
 * mirror them, so a stored event type always passes validation.
 */
export const EVENT_TYPE_RULE_BOUNDS = {
  durationMinutes: { min: 1, max: MINUTES_PER_DAY },
  slotStepMinutes: { min: 1, max: MINUTES_PER_DAY },
  bufferBeforeMinutes: { min: 0, max: MINUTES_PER_DAY },
  bufferAfterMinutes: { min: 0, max: MINUTES_PER_DAY },
  minimumNoticeMinutes: { min: 0, max: 365 * MINUTES_PER_DAY },
  maxBookingsPerDay: { min: 1, max: 1000 },
  bookingWindowDays: { min: 1, max: 3650 },
} as const satisfies Record<keyof EventTypeRules, { min: number; max: number }>

/** The engine visits every local day in the range. */
const MAX_RANGE_DAYS = 400

/** `now`, `rangeStart` and `rangeEnd` must lie in years 0001–9999. */
const EARLIEST_QUERY_INSTANT = Temporal.Instant.from('0001-01-01T00:00:00Z')
const LATEST_QUERY_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999999999Z')

export function normalizeInput(input: AvailabilityInput): NormalizedInput {
  if (typeof input !== 'object' || input === null) fail('input must be an object')
  const { schedule, eventType } = input
  if (typeof schedule !== 'object' || schedule === null) fail('schedule must be an object')
  if (typeof eventType !== 'object' || eventType === null) fail('eventType must be an object')

  const durationMinutes = bounded(eventType.durationMinutes, 'eventType', 'durationMinutes')
  const rangeStart = queryInstant(input.rangeStart, 'rangeStart')
  const rangeEnd = queryInstant(input.rangeEnd, 'rangeEnd')
  if (Temporal.Instant.compare(rangeEnd, rangeStart) <= 0) {
    fail(`rangeEnd (${rangeEnd}) must be after rangeStart (${rangeStart})`)
  }
  if (
    rangeEnd.epochNanoseconds - rangeStart.epochNanoseconds >
    BigInt(MAX_RANGE_DAYS) * NS_PER_DAY
  ) {
    fail(
      `rangeEnd (${rangeEnd}) must be at most ${MAX_RANGE_DAYS} days after rangeStart (${rangeStart})`,
    )
  }

  return {
    timeZone: timeZone(schedule.timeZone, 'schedule.timeZone'),
    weeklyHours: weeklyHours(schedule.weeklyHours, 'schedule.weeklyHours'),
    dateOverrides: dateOverrides(schedule.dateOverrides),
    ...optionalRules(eventType, 'eventType', durationMinutes),
    durationMinutes,
    busy: input.busy === undefined ? [] : list(input.busy, 'busy', instantInterval),
    bookings: input.bookings === undefined ? [] : list(input.bookings, 'bookings', existingBooking),
    rangeStart,
    rangeEnd,
    now: queryInstant(input.now, 'now'),
  }
}

/** The optional event type rules, with defaults applied. */
function optionalRules(eventType: EventTypeRules, path: string, durationMinutes: number) {
  const rule = (name: keyof EventTypeRules) => (v: unknown) => bounded(v, path, name)
  return {
    slotStepMinutes: optional(eventType.slotStepMinutes, durationMinutes, rule('slotStepMinutes')),
    bufferBeforeMinutes: optional(eventType.bufferBeforeMinutes, 0, rule('bufferBeforeMinutes')),
    bufferAfterMinutes: optional(eventType.bufferAfterMinutes, 0, rule('bufferAfterMinutes')),
    minimumNoticeMinutes: optional(eventType.minimumNoticeMinutes, 0, rule('minimumNoticeMinutes')),
    maxBookingsPerDay: optional(eventType.maxBookingsPerDay, undefined, rule('maxBookingsPerDay')),
    bookingWindowDays: optional(eventType.bookingWindowDays, undefined, rule('bookingWindowDays')),
  }
}

// Validators for data that is stored and later handed to the engine (schedules, date
// overrides, event types), so it is checked by exactly the rules the engine applies. Each
// throws AvailabilityInputError with a message naming the offending field under `path`.

/**
 * Checks an IANA time zone name the engine accepts (not a UTC offset) and returns its
 * normalized id, e.g. `"europe/berlin"` → `"Europe/Berlin"`.
 */
export function validateTimeZone(value: unknown, path = 'timeZone'): string {
  return timeZone(value, path)
}

/** Checks weekly hours: weekday keys, `"HH:MM"` times, end after start, no overlaps. */
export function validateWeeklyHours(
  value: unknown,
  path = 'weeklyHours',
): asserts value is WeeklyHours {
  weeklyHours(value, path)
}

/** Checks the intervals of one day (a date override): the same rules as one weekday. */
export function validateDayIntervals(
  value: unknown,
  path = 'intervals',
): asserts value is readonly WallClockInterval[] {
  dayIntervals(value, path)
}

/** Checks a calendar date `"YYYY-MM-DD"` and returns it normalized. */
export function validateDate(value: unknown, path = 'date'): string {
  return plainDate(value, path)
}

/**
 * Checks event type rules against `EVENT_TYPE_RULE_BOUNDS`; omitted optional rules are fine.
 * Messages name each rule under `path`, or alone when `path` is ''.
 */
export function validateEventTypeRules(
  value: unknown,
  path = 'eventType',
): asserts value is EventTypeRules {
  if (!isPlainObject(value)) fail(`${path || 'rules'} must be a plain object, got ${show(value)}`)
  const rules = value as unknown as EventTypeRules
  optionalRules(rules, path, bounded(rules.durationMinutes, path, 'durationMinutes'))
}

function fail(message: string): never {
  throw new AvailabilityInputError(message)
}

/**
 * Renders any input value for an error message without throwing: JSON.stringify
 * throws on BigInt and circular values, and String() throws on objects without a
 * prototype (Object.create(null)) or with a broken toString.
 */
function show(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined) return 'undefined'
  // JSON would render a Map or class instance as "{}"; name its type instead.
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isPlainObject(value)
  ) {
    return Object.prototype.toString.call(value)
  }
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // Not serializable (BigInt inside, circular); describe its type instead.
  }
  return Object.prototype.toString.call(value)
}

/** Whether `value` is a plain object literal (or Object.create(null)), not a Map, array or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optional<T, D>(value: T | undefined, fallback: D, parse: (value: T) => number) {
  return value === undefined ? fallback : parse(value)
}

/** `path` is the event type's own path; '' names the rule alone. */
function bounded(value: unknown, path: string, rule: keyof EventTypeRules): number {
  const { min, max } = EVENT_TYPE_RULE_BOUNDS[rule]
  return wholeNumber(value, path ? `${path}.${rule}` : rule, min, max)
}

function wholeNumber(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${path} must be a whole number from ${min} to ${max}, got ${show(value)}`)
  }
  return value as number
}

function timeZone(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(`${path} must be a non-empty string`)
  // Temporal also accepts fixed UTC offsets as zone ids; they ignore DST, so require a zone name.
  if (/^[+-]/.test(value)) {
    fail(`${path} must be an IANA time zone name like "Europe/Berlin", not a UTC offset (${value})`)
  }
  try {
    return new Temporal.ZonedDateTime(0n, value).timeZoneId
  } catch {
    return fail(`${path} is not a known IANA time zone: ${show(value)}`)
  }
}

function weeklyHours(value: unknown, path: string): Map<number, MinuteInterval[]> {
  if (!isPlainObject(value)) {
    fail(`${path} must be a plain object keyed by weekday, got ${show(value)}`)
  }
  const result = new Map<number, MinuteInterval[]>()
  for (const [key, intervals] of Object.entries(value)) {
    const index = WEEKDAYS.indexOf(key as Weekday)
    if (index === -1) {
      fail(`${path} has unknown weekday ${show(key)}; use one of ${WEEKDAYS.join(', ')}`)
    }
    if (intervals === undefined) continue
    result.set(index + 1, dayIntervals(intervals, `${path}.${key}`))
  }
  return result
}

function dateOverrides(value: unknown): Map<string, MinuteInterval[]> {
  const path = 'schedule.dateOverrides'
  const result = new Map<string, MinuteInterval[]>()
  if (value === undefined) return result
  list(value, path, (override, itemPath) => {
    if (!isPlainObject(override)) fail(`${itemPath} must be a plain object, got ${show(override)}`)
    const key = plainDate(override.date, `${itemPath}.date`)
    if (result.has(key)) fail(`${itemPath}.date ${key} appears more than once`)
    result.set(key, dayIntervals(override.intervals, `${itemPath}.intervals`))
  })
  return result
}

function plainDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${path} must be a date like "2026-03-08", got ${show(value)}`)
  }
  try {
    return Temporal.PlainDate.from(value).toString()
  } catch {
    return fail(`${path} is not a valid calendar date: ${value}`)
  }
}

/**
 * Parses one day's intervals, rejects overlaps, and joins touching intervals, so
 * 09:00–10:30 plus 10:30–12:00 behaves exactly like 09:00–12:00.
 */
function dayIntervals(value: unknown, path: string): MinuteInterval[] {
  if (!Array.isArray(value)) fail(`${path} must be an array of { start, end } intervals`)
  const parsed = list(value, path, (interval, itemPath) => {
    const { start, end } = interval as Partial<WallClockInterval>
    const startMinutes = wallClockTime(start, `${itemPath}.start`, false)
    const endMinutes = wallClockTime(end, `${itemPath}.end`, true)
    if (endMinutes <= startMinutes) {
      fail(`${itemPath}.end (${end}) must be after start (${start})`)
    }
    return { start: startMinutes, end: endMinutes, label: `${start}–${end}` }
  })
  parsed.sort((a, b) => a.start - b.start)

  const joined: { start: number; end: number }[] = []
  let previous: (typeof parsed)[number] | undefined
  for (const current of parsed) {
    if (previous && current.start < previous.end) {
      fail(`${path} has overlapping intervals ${previous.label} and ${current.label}`)
    }
    const last = joined.at(-1)
    if (last && last.end === current.start) last.end = current.end
    else joined.push({ start: current.start, end: current.end })
    previous = current
  }
  return joined
}

/** Returns minutes since local midnight. */
function wallClockTime(value: unknown, path: string, isEnd: boolean): number {
  const match = typeof value === 'string' ? /^(\d{2}):(\d{2})$/.exec(value) : null
  const hours = Number(match?.[1])
  const minutes = Number(match?.[2])
  const minutesOfDay = hours * 60 + minutes
  const valid =
    match !== null &&
    minutes < 60 &&
    (minutesOfDay < MINUTES_PER_DAY || (isEnd && minutesOfDay === MINUTES_PER_DAY))
  if (!valid) {
    const allowed = isEnd ? '"00:00" to "24:00"' : '"00:00" to "23:59"'
    fail(`${path} must be a time "HH:MM" from ${allowed}, got ${show(value)}`)
  }
  return minutesOfDay
}

function instant(value: unknown, path: string): Temporal.Instant {
  if (!(value instanceof Temporal.Instant)) fail(`${path} must be a Temporal.Instant`)
  return value
}

/** An instant the engine calculates with, so it must stay well inside Temporal's range. */
function queryInstant(value: unknown, path: string): Temporal.Instant {
  const result = instant(value, path)
  if (
    Temporal.Instant.compare(result, EARLIEST_QUERY_INSTANT) < 0 ||
    Temporal.Instant.compare(result, LATEST_QUERY_INSTANT) > 0
  ) {
    fail(`${path} must be in the years 0001 to 9999, got ${result}`)
  }
  return result
}

/**
 * Parses every element of an array. Array.from visits holes in sparse arrays as
 * `undefined`, so they fail the object check instead of being skipped.
 */
function list<T>(value: unknown, path: string, parse: (item: object, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  return Array.from(value, (item: unknown, i) => {
    const itemPath = `${path}[${i}]`
    if (typeof item !== 'object' || item === null) fail(`${itemPath} must be an object`)
    return parse(item, itemPath)
  })
}

function instantInterval(item: object, path: string): InstantInterval {
  const { start, end } = item as { start?: unknown; end?: unknown }
  const startInstant = instant(start, `${path}.start`)
  const endInstant = instant(end, `${path}.end`)
  if (Temporal.Instant.compare(endInstant, startInstant) <= 0) {
    fail(`${path}.end (${endInstant}) must be after start (${startInstant})`)
  }
  return { start: startInstant, end: endInstant }
}

function existingBooking(item: object, path: string): NormalizedBooking {
  const { bufferBeforeMinutes, bufferAfterMinutes } = item as {
    bufferBeforeMinutes?: unknown
    bufferAfterMinutes?: unknown
  }
  return {
    ...instantInterval(item, path),
    bufferBeforeMinutes: optional(bufferBeforeMinutes, 0, (v) =>
      bounded(v, path, 'bufferBeforeMinutes'),
    ),
    bufferAfterMinutes: optional(bufferAfterMinutes, 0, (v) =>
      bounded(v, path, 'bufferAfterMinutes'),
    ),
  }
}
