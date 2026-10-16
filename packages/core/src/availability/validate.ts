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
  /** Keyed by ISO weekday: 1 = Monday … 7 = Sunday. Intervals sorted by start. */
  readonly weeklyHours: ReadonlyMap<number, readonly MinuteInterval[]>
  /** Keyed by `"YYYY-MM-DD"`. Intervals sorted by start; empty = unavailable. */
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

export function normalizeInput(input: AvailabilityInput): NormalizedInput {
  if (typeof input !== 'object' || input === null) fail('input must be an object')
  const { schedule, eventType } = input
  if (typeof schedule !== 'object' || schedule === null) fail('schedule must be an object')
  if (typeof eventType !== 'object' || eventType === null) fail('eventType must be an object')

  const durationMinutes = positiveInteger(eventType.durationMinutes, 'eventType.durationMinutes')
  const rangeStart = instant(input.rangeStart, 'rangeStart')
  const rangeEnd = instant(input.rangeEnd, 'rangeEnd')
  if (Temporal.Instant.compare(rangeEnd, rangeStart) <= 0) {
    fail(`rangeEnd (${rangeEnd}) must be after rangeStart (${rangeStart})`)
  }

  return {
    timeZone: timeZone(schedule.timeZone),
    weeklyHours: weeklyHours(schedule.weeklyHours),
    dateOverrides: dateOverrides(schedule.dateOverrides),
    durationMinutes,
    slotStepMinutes:
      eventType.slotStepMinutes === undefined
        ? durationMinutes
        : positiveInteger(eventType.slotStepMinutes, 'eventType.slotStepMinutes'),
    bufferBeforeMinutes: optionalNonNegativeInteger(
      eventType.bufferBeforeMinutes,
      'eventType.bufferBeforeMinutes',
    ),
    bufferAfterMinutes: optionalNonNegativeInteger(
      eventType.bufferAfterMinutes,
      'eventType.bufferAfterMinutes',
    ),
    minimumNoticeMinutes: optionalNonNegativeInteger(
      eventType.minimumNoticeMinutes,
      'eventType.minimumNoticeMinutes',
    ),
    maxBookingsPerDay:
      eventType.maxBookingsPerDay === undefined
        ? undefined
        : positiveInteger(eventType.maxBookingsPerDay, 'eventType.maxBookingsPerDay'),
    bookingWindowDays:
      eventType.bookingWindowDays === undefined
        ? undefined
        : positiveInteger(eventType.bookingWindowDays, 'eventType.bookingWindowDays'),
    busy: instantIntervals(input.busy, 'busy'),
    bookings: instantIntervals(input.bookings, 'bookings'),
    rangeStart,
    rangeEnd,
    now: instant(input.now, 'now'),
  }
}

function fail(message: string): never {
  throw new AvailabilityInputError(message)
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

/** Parses one day's intervals, sorted by start, and rejects overlaps. */
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
  for (let i = 1; i < parsed.length; i++) {
    const previous = parsed[i - 1]
    const current = parsed[i]
    if (previous && current && current.start < previous.end) {
      fail(`${path} has overlapping intervals ${previous.label} and ${current.label}`)
    }
  }
  return parsed.map(({ start, end }) => ({ start, end }))
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

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${path} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return value as number
}

function optionalNonNegativeInteger(value: unknown, path: string): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${path} must be a whole number of 0 or more, got ${JSON.stringify(value)}`)
  }
  return value as number
}
