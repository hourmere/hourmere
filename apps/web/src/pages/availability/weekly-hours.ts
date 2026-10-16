// Schedules in the form: weekly hours as days with intervals, checked with the availability
// engine's rules (packages/core: "HH:MM" times, end after start, no overlaps within a day;
// touching intervals are fine, the server joins them).
//
// Times are edited in time inputs, which cannot show 24:00, so an end of "00:00" stands for
// midnight at the end of the day and is sent as "24:00" (and "24:00" is shown as "00:00").
import type { Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { Schedule } from '../../api/resources.ts'
import type { FieldErrors } from '../../components/forms.tsx'
import { isKnownTimeZone } from '../../format.ts'
import { SCHEDULE } from '../../limits.ts'
import { singleLineProblem } from '../../text.ts'

export type Weekday = keyof Schemas['WeeklyHours']
export type Interval = Schemas['WallClockInterval']

export const WEEKDAYS: { day: Weekday; label: string; short: string }[] = [
  { day: 'monday', label: 'Monday', short: 'Mon' },
  { day: 'tuesday', label: 'Tuesday', short: 'Tue' },
  { day: 'wednesday', label: 'Wednesday', short: 'Wed' },
  { day: 'thursday', label: 'Thursday', short: 'Thu' },
  { day: 'friday', label: 'Friday', short: 'Fri' },
  { day: 'saturday', label: 'Saturday', short: 'Sat' },
  { day: 'sunday', label: 'Sunday', short: 'Sun' },
]

export interface IntervalDraft {
  /** Stable while editing, for React and field ids. */
  key: string
  /** "HH:MM" as a time input gives it ("" while incomplete). */
  start: string
  end: string
}

export interface DayDraft {
  available: boolean
  /** Kept while the day is unavailable, so switching it back restores them. */
  intervals: IntervalDraft[]
}

export interface ScheduleDraft {
  name: string
  timeZone: string
  days: Record<Weekday, DayDraft>
}

let nextKey = 0
export const intervalDraft = (start = '09:00', end = '17:00'): IntervalDraft => ({
  key: `i${++nextKey}`,
  start,
  end: end === '24:00' ? '00:00' : end,
})

/** Monday to Friday, 9 to 5: a starting point for a new schedule. */
export function newScheduleDraft(timeZone: string): ScheduleDraft {
  const days = Object.fromEntries(
    WEEKDAYS.map(({ day }) => {
      const weekday = day !== 'saturday' && day !== 'sunday'
      return [day, { available: weekday, intervals: weekday ? [intervalDraft()] : [] }]
    }),
  ) as Record<Weekday, DayDraft>
  return { name: 'Working hours', timeZone, days }
}

export function draftFromSchedule(schedule: Schedule): ScheduleDraft {
  const days = Object.fromEntries(
    WEEKDAYS.map(({ day }) => {
      const intervals = schedule.weeklyHours[day] ?? []
      return [
        day,
        {
          available: intervals.length > 0,
          intervals: intervals.map((i) => intervalDraft(i.start, i.end)),
        },
      ]
    }),
  ) as Record<Weekday, DayDraft>
  return { name: schedule.name, timeZone: schedule.timeZone, days }
}

/** What decides whether there are unsaved changes (not React keys). */
export function comparable(draft: ScheduleDraft): string {
  return JSON.stringify({
    name: draft.name,
    timeZone: draft.timeZone,
    days: WEEKDAYS.map(({ day }) => {
      const d = draft.days[day]
      return d.available ? d.intervals.map((i) => [i.start, i.end]) : []
    }),
  })
}

/** Minutes since midnight; an end of 00:00 is the end of the day. */
function minutes(time: string, isEnd: boolean): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return null
  const value = Number(match[1]) * 60 + Number(match[2])
  if (Number(match[2]) > 59 || value > 1439) return null
  return isEnd && value === 0 ? 1440 : value
}

export const toApiTime = (time: string, isEnd: boolean) =>
  isEnd && time === '00:00' ? '24:00' : time

// Field ids, which are also the keys of FieldErrors.
export const intervalField = (prefix: string, i: IntervalDraft, part: 'start' | 'end') =>
  `${prefix}-${i.key}-${part}`

/**
 * The problems with one day's intervals, keyed by field id (times) and by `prefix` (the day
 * as a whole: overlaps). Used for weekdays and date overrides alike.
 */
export function validateIntervals(
  prefix: string,
  intervals: readonly IntervalDraft[],
): FieldErrors {
  const errors: FieldErrors = {}
  const parsed: { start: number; end: number; label: string }[] = []
  for (const i of intervals) {
    const start = minutes(i.start, false)
    const end = minutes(i.end, true)
    if (start === null) errors[intervalField(prefix, i, 'start')] = 'Enter a start time.'
    if (end === null) errors[intervalField(prefix, i, 'end')] = 'Enter an end time.'
    if (start === null || end === null) continue
    if (end <= start) {
      errors[intervalField(prefix, i, 'end')] = 'End after the start time.'
      continue
    }
    parsed.push({ start, end, label: `${i.start}–${toApiTime(i.end, true)}` })
  }
  parsed.sort((a, b) => a.start - b.start)
  const overlaps: string[] = []
  // Each range against the one reaching furthest so far, which any overlap must hit.
  let furthest: (typeof parsed)[number] | undefined
  for (const current of parsed) {
    if (furthest && current.start < furthest.end) {
      overlaps.push(`${furthest.label} and ${current.label}`)
    }
    if (!furthest || current.end > furthest.end) furthest = current
  }
  if (overlaps.length) errors[prefix] = `These hours overlap: ${overlaps.join('; ')}.`
  return errors
}

export const dayField = (day: Weekday) => `day-${day}`

export function validateSchedule(draft: ScheduleDraft): FieldErrors {
  const errors: FieldErrors = {}
  const name = singleLineProblem(draft.name, 'a name', SCHEDULE.nameMaxLength)
  if (name) errors.name = name
  if (!draft.timeZone.trim()) errors.timeZone = 'Choose a time zone.'
  else if (!isKnownTimeZone(draft.timeZone.trim())) {
    errors.timeZone = 'Choose a time zone from the list, e.g. Europe/Berlin.'
  }
  for (const { day } of WEEKDAYS) {
    const d = draft.days[day]
    if (d.available) Object.assign(errors, validateIntervals(dayField(day), d.intervals))
  }
  return errors
}

export const toIntervals = (intervals: readonly IntervalDraft[]): Interval[] =>
  intervals.map((i) => ({ start: i.start, end: toApiTime(i.end, true) }))

export function toScheduleBody(draft: ScheduleDraft) {
  return {
    name: draft.name.trim(),
    timeZone: draft.timeZone.trim(),
    weeklyHours: Object.fromEntries(
      WEEKDAYS.map(({ day }) => {
        const d = draft.days[day]
        return [day, d.available ? toIntervals(d.intervals) : []]
      }),
    ) as Schemas['WeeklyHoursInput'],
  }
}

/** Labels for the error summary, by field id. */
export function scheduleLabels(draft: ScheduleDraft): Record<string, string> {
  const labels: Record<string, string> = { name: 'Name', timeZone: 'Time zone' }
  for (const { day, label } of WEEKDAYS) {
    labels[dayField(day)] = label
    draft.days[day].intervals.forEach((i, n) => {
      labels[intervalField(dayField(day), i, 'start')] = `${label}, hours ${n + 1}, from`
      labels[intervalField(dayField(day), i, 'end')] = `${label}, hours ${n + 1}, until`
    })
  }
  return labels
}

/** The server's refusal as field messages (codes documented on the schedule routes). */
export function scheduleServerErrors(err: unknown): {
  fields: FieldErrors
  message: string | null
} {
  if (!(err instanceof RequestError)) return { fields: {}, message: null }
  const detail = err.message
  switch (err.code) {
    case 'invalid_schedule':
      return /^name\b/.test(detail)
        ? { fields: { name: 'Use one line of up to 100 characters.' }, message: null }
        : { fields: {}, message: detail }
    case 'invalid_time_zone':
      return {
        fields: { timeZone: 'This is not a time zone the server knows. Choose one from the list.' },
        message: null,
      }
    case 'invalid_weekly_hours': {
      // "weeklyHours.monday has overlapping intervals 09:00–12:00 and 11:00–13:00", …
      const day = /^weeklyHours\.(\w+)/.exec(detail)?.[1] as Weekday | undefined
      if (!day || !WEEKDAYS.some((w) => w.day === day)) return { fields: {}, message: detail }
      const overlap = /overlapping intervals (.+)$/.exec(detail)?.[1]
      return {
        fields: {
          [dayField(day)]: overlap
            ? `These hours overlap: ${overlap}.`
            : 'Check these hours: each must end after it starts.',
        },
        message: null,
      }
    }
    default:
      return { fields: {}, message: detail }
  }
}

/** "Mon–Fri 09:00–17:00 · Sat 10:00–12:00", or "No hours set". */
export function summarize(weeklyHours: Schemas['WeeklyHours']): string {
  const groups: { from: string; to: string; hours: string }[] = []
  for (const { day, short } of WEEKDAYS) {
    const hours = (weeklyHours[day] ?? []).map((i) => `${i.start}–${i.end}`).join(', ')
    const last = groups.at(-1)
    if (hours && last && last.hours === hours && last.to === previousShort(short)) last.to = short
    else if (hours) groups.push({ from: short, to: short, hours })
  }
  if (!groups.length) return 'No hours set'
  return groups
    .map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.hours}`)
    .join(' · ')
}

function previousShort(short: string): string | undefined {
  const index = WEEKDAYS.findIndex((w) => w.short === short)
  return index > 0 ? WEEKDAYS[index - 1]?.short : undefined
}

/** Today's date ("YYYY-MM-DD") in `timeZone`. */
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: isKnownTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
