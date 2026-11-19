import { EVENT_TYPE_RULE_BOUNDS, validateTimeZone } from '@hourmere/core'
import { DomainError } from './errors.ts'
import { engineValidation } from './internal.ts'

export const MIN_RECURRING_OCCURRENCES = 2
export const MAX_RECURRING_OCCURRENCES = 12
export const MAX_RECURRING_HORIZON_DAYS = 366

type MonthlyOrdinal = 1 | 2 | 3 | 4 | 'last'

export type RecurringRule =
  | { pattern: 'weekly' | 'fortnightly'; count: number }
  | { pattern: 'monthly_weekday'; count: number; ordinal: MonthlyOrdinal; weekday: number }

export interface RecurringExpansionInput {
  rule: unknown
  firstLocalStart: string
  /** The event's saved IANA time zone. */
  timeZone: string
  durationMinutes: number
  now: Temporal.Instant
}

export type RecurringOccurrence = { ordinal: number; localStart: string } & (
  | { start: Temporal.Instant; end: Temporal.Instant; offset: string }
  | { start: null; end: null; offset: null; reason: 'nonexistent_local_time' }
)

const invalidRecurrence = (message: string) =>
  new DomainError('invalid', 'invalid_recurrence', message)

export function normalizeRecurringRule(input: unknown): RecurringRule {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidRecurrence('Select a recurrence rule.')
  }
  const { pattern, count, ordinal, weekday } = input as Record<string, unknown>
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < MIN_RECURRING_OCCURRENCES ||
    count > MAX_RECURRING_OCCURRENCES
  ) {
    throw invalidRecurrence(
      `Select between ${MIN_RECURRING_OCCURRENCES} and ${MAX_RECURRING_OCCURRENCES} occurrences.`,
    )
  }

  const keys = Object.keys(input)
  switch (pattern) {
    case 'weekly':
    case 'fortnightly':
      if (keys.some((key) => key !== 'pattern' && key !== 'count')) {
        throw invalidRecurrence('Weekly and fortnightly rules only accept a pattern and count.')
      }
      return { pattern, count }
    case 'monthly_weekday':
      if (keys.some((key) => !['pattern', 'count', 'ordinal', 'weekday'].includes(key))) {
        throw invalidRecurrence('Monthly rules only accept a pattern, count, ordinal and weekday.')
      }
      if (ordinal !== 1 && ordinal !== 2 && ordinal !== 3 && ordinal !== 4 && ordinal !== 'last') {
        throw invalidRecurrence('Select the first, second, third, fourth or last weekday.')
      }
      if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
        throw invalidRecurrence('Select a weekday from 1 (Monday) to 7 (Sunday).')
      }
      return { pattern, count, ordinal, weekday }
    default:
      throw invalidRecurrence('Select a weekly, fortnightly or monthly weekday pattern.')
  }
}

// Require an explicit numeric offset and a local ISO date/time without zone or calendar annotations.
const FIRST_LOCAL_START =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,9})?)?)[+-]\d{2}:\d{2}$/

export function resolveFirstStart(value: string, timeZone: string): Temporal.ZonedDateTime {
  const local = typeof value === 'string' ? FIRST_LOCAL_START.exec(value)?.[1] : undefined
  if (local === undefined) {
    throw invalidRecurrence(
      'The first start must include a local date, time and numeric UTC offset.',
    )
  }
  try {
    // Resolve the supplied offset first so either fold can be selected. Round-tripping the
    // local time rejects offsets that do not identify a real slot in the event zone.
    const start = Temporal.Instant.from(value).toZonedDateTimeISO(timeZone)
    if (start.toPlainDateTime().equals(Temporal.PlainDateTime.from(local))) return start
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
  throw invalidRecurrence(
    'The first start must be a valid local time and offset in the event time zone.',
  )
}

function occurrenceDate(firstDate: Temporal.PlainDate, rule: RecurringRule, index: number) {
  if (rule.pattern !== 'monthly_weekday') {
    return firstDate.add({ weeks: index * (rule.pattern === 'fortnightly' ? 2 : 1) })
  }
  const month = firstDate.with({ day: 1 }).add({ months: index })
  if (rule.ordinal === 'last') {
    const end = month.with({ day: month.daysInMonth })
    return end.subtract({ days: (end.dayOfWeek - rule.weekday + 7) % 7 })
  }
  const daysToWeekday = (rule.weekday - month.dayOfWeek + 7) % 7
  return month.add({ days: daysToWeekday + (rule.ordinal - 1) * 7 })
}

/** Expands dates in the event zone before availability or host selection. A gap keeps its ordinal. */
export function expandRecurringRule(input: RecurringExpansionInput): RecurringOccurrence[] {
  const rule = normalizeRecurringRule(input.rule)
  const timeZone = engineValidation('invalid_recurrence', () => validateTimeZone(input.timeZone))
  const { durationMinutes } = input
  const { min, max } = EVENT_TYPE_RULE_BOUNDS.durationMinutes
  if (!Number.isInteger(durationMinutes) || durationMinutes < min || durationMinutes > max) {
    throw invalidRecurrence(`Duration must be a whole number of minutes from ${min} to ${max}.`)
  }

  const first = resolveFirstStart(input.firstLocalStart, timeZone)
  const firstDate = first.toPlainDate()
  if (!firstDate.equals(occurrenceDate(firstDate, rule, 0))) {
    throw invalidRecurrence('The first date must match the recurrence rule.')
  }
  const horizon = input.now
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .add({ days: MAX_RECURRING_HORIZON_DAYS })
  if (Temporal.PlainDate.compare(occurrenceDate(firstDate, rule, rule.count - 1), horizon) > 0) {
    throw invalidRecurrence(
      `The last date must be within ${MAX_RECURRING_HORIZON_DAYS} local days.`,
    )
  }

  const time = first.toPlainTime()
  return Array.from({ length: rule.count }, (_, index): RecurringOccurrence => {
    const local = occurrenceDate(firstDate, rule, index).toPlainDateTime(time)
    const ordinal = index + 1
    const localStart = local.toString()
    const zoned =
      index === 0 ? first : local.toZonedDateTime(timeZone, { disambiguation: 'earlier' })
    if (!zoned.toPlainDateTime().equals(local)) {
      return {
        ordinal,
        localStart,
        start: null,
        end: null,
        offset: null,
        reason: 'nonexistent_local_time',
      }
    }
    const start = zoned.toInstant()
    return {
      ordinal,
      localStart,
      start,
      end: start.add({ minutes: durationMinutes }),
      offset: zoned.offset,
    }
  })
}
