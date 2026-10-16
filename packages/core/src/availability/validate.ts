import type { AvailabilityInput, InstantInterval, WallClockInterval, Weekday } from './types.ts'

/** Thrown when `getAvailableSlots` receives input it cannot interpret. */
export class AvailabilityInputError extends Error {
  override readonly name = 'AvailabilityInputError'
}

/** Wall-clock interval as minutes since local midnight: [start, end), 0 <= start < end <= 1440. */
export interface MinuteInterval {
  readonly start: number
  readonly end: number
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
  readonly bookings: readonly InstantInterval[]
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
 * Upper bounds for numeric input. Besides rejecting nonsense, they keep every
 * Temporal calculation inside its supported range, so bad input always ends in
 * an AvailabilityInputError rather than a RangeError.
 */
const LIMITS = {
  durationMinutes: MINUTES_PER_DAY,
  slotStepMinutes: MINUTES_PER_DAY,
  bufferMinutes: MINUTES_PER_DAY,
  minimumNoticeMinutes: 365 * MINUTES_PER_DAY,
  bookingWindowDays: 3650,
  maxBookingsPerDay: 1000,
  /** The engine visits every local day in the range. */
  rangeDays: 400,
}

/** `now`, `rangeStart` and `rangeEnd` must lie in years 0001–9999. */
const EARLIEST_QUERY_INSTANT = Temporal.Instant.from('0001-01-01T00:00:00Z')
const LATEST_QUERY_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999999999Z')

export function normalizeInput(input: AvailabilityInput): NormalizedInput {
  if (typeof input !== 'object' || input === null) fail('input must be an object')
  const { schedule, eventType } = input
  if (typeof schedule !== 'object' || schedule === null) fail('schedule must be an object')
  if (typeof eventType !== 'object' || eventType === null) fail('eventType must be an object')

  const durationMinutes = wholeNumber(
    eventType.durationMinutes,
    'eventType.durationMinutes',
    1,
    LIMITS.durationMinutes,
  )
  const rangeStart = queryInstant(input.rangeStart, 'rangeStart')
  const rangeEnd = queryInstant(input.rangeEnd, 'rangeEnd')
  if (Temporal.Instant.compare(rangeEnd, rangeStart) <= 0) {
    fail(`rangeEnd (${rangeEnd}) must be after rangeStart (${rangeStart})`)
  }
  if (
    rangeEnd.epochNanoseconds - rangeStart.epochNanoseconds >
    BigInt(LIMITS.rangeDays) * NS_PER_DAY
  ) {
    fail(
      `rangeEnd (${rangeEnd}) must be at most ${LIMITS.rangeDays} days after rangeStart (${rangeStart})`,
    )
  }

  return {
    timeZone: timeZone(schedule.timeZone),
    weeklyHours: weeklyHours(schedule.weeklyHours),
    dateOverrides: dateOverrides(schedule.dateOverrides),
    durationMinutes,
    slotStepMinutes: optional(eventType.slotStepMinutes, durationMinutes, (v) =>
      wholeNumber(v, 'eventType.slotStepMinutes', 1, LIMITS.slotStepMinutes),
    ),
    bufferBeforeMinutes: optional(eventType.bufferBeforeMinutes, 0, (v) =>
      wholeNumber(v, 'eventType.bufferBeforeMinutes', 0, LIMITS.bufferMinutes),
    ),
    bufferAfterMinutes: optional(eventType.bufferAfterMinutes, 0, (v) =>
      wholeNumber(v, 'eventType.bufferAfterMinutes', 0, LIMITS.bufferMinutes),
    ),
    minimumNoticeMinutes: optional(eventType.minimumNoticeMinutes, 0, (v) =>
      wholeNumber(v, 'eventType.minimumNoticeMinutes', 0, LIMITS.minimumNoticeMinutes),
    ),
    maxBookingsPerDay: optional(eventType.maxBookingsPerDay, undefined, (v) =>
      wholeNumber(v, 'eventType.maxBookingsPerDay', 1, LIMITS.maxBookingsPerDay),
    ),
    bookingWindowDays: optional(eventType.bookingWindowDays, undefined, (v) =>
      wholeNumber(v, 'eventType.bookingWindowDays', 1, LIMITS.bookingWindowDays),
    ),
    busy: instantIntervals(input.busy, 'busy'),
    bookings: instantIntervals(input.bookings, 'bookings'),
    rangeStart,
    rangeEnd,
    now: queryInstant(input.now, 'now'),
  }
}

function fail(message: string): never {
  throw new AvailabilityInputError(message)
}

function optional<T, D>(value: T | undefined, fallback: D, parse: (value: T) => number) {
  return value === undefined ? fallback : parse(value)
}

function wholeNumber(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${path} must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`)
  }
  return value as number
}

function timeZone(value: unknown): string {
  const path = 'schedule.timeZone'
  if (typeof value !== 'string' || value === '') fail(`${path} must be a non-empty string`)
  // Temporal also accepts fixed UTC offsets as zone ids; they ignore DST, so require a zone name.
  if (/^[+-]/.test(value)) {
    fail(`${path} must be an IANA time zone name like "Europe/Berlin", not a UTC offset (${value})`)
  }
  try {
    return new Temporal.ZonedDateTime(0n, value).timeZoneId
  } catch {
    return fail(`${path} is not a known IANA time zone: ${JSON.stringify(value)}`)
  }
}

function weeklyHours(value: unknown): Map<number, MinuteInterval[]> {
  const path = 'schedule.weeklyHours'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object keyed by weekday`)
  }
  const result = new Map<number, MinuteInterval[]>()
  for (const [key, intervals] of Object.entries(value)) {
    const index = WEEKDAYS.indexOf(key as Weekday)
    if (index === -1) {
      fail(`${path} has unknown weekday ${JSON.stringify(key)}; use one of ${WEEKDAYS.join(', ')}`)
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
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  value.forEach((override: unknown, i) => {
    const itemPath = `${path}[${i}]`
    if (typeof override !== 'object' || override === null) fail(`${itemPath} must be an object`)
    const { date, intervals } = override as { date?: unknown; intervals?: unknown }
    const key = plainDate(date, `${itemPath}.date`)
    if (result.has(key)) fail(`${itemPath}.date ${key} appears more than once`)
    result.set(key, dayIntervals(intervals, `${itemPath}.intervals`))
  })
  return result
}

function plainDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${path} must be a date like "2026-03-08", got ${JSON.stringify(value)}`)
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
  const parsed = value.map((interval: unknown, i) => {
    const itemPath = `${path}[${i}]`
    if (typeof interval !== 'object' || interval === null) fail(`${itemPath} must be an object`)
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
    fail(`${path} must be a time "HH:MM" from ${allowed}, got ${JSON.stringify(value)}`)
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

function instantIntervals(value: unknown, path: string): InstantInterval[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  return value.map((interval: unknown, i) => {
    const itemPath = `${path}[${i}]`
    if (typeof interval !== 'object' || interval === null) fail(`${itemPath} must be an object`)
    const { start, end } = interval as { start?: unknown; end?: unknown }
    const startInstant = instant(start, `${itemPath}.start`)
    const endInstant = instant(end, `${itemPath}.end`)
    if (Temporal.Instant.compare(endInstant, startInstant) <= 0) {
      fail(`${itemPath}.end (${endInstant}) must be after start (${startInstant})`)
    }
    return { start: startInstant, end: endInstant }
  })
}
