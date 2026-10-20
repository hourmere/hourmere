// Dates and times in a chosen IANA time zone, with Intl only (browsers do not all have
// Temporal yet). Instants are milliseconds since the epoch; calendar dates are `YYYY-MM-DD`
// keys (see calendar.ts), which say nothing about a zone by themselves.
import { type DateKey, toDateKey } from './calendar.ts'

const cache = new Map<string, Intl.DateTimeFormat>()

/**
 * A cached Intl.DateTimeFormat: creating one is slow, and the pages format a lot. Always the
 * Gregorian calendar, whatever the locale's default (Persian for fa-IR, Buddhist for th-TH):
 * the month grid, the slots and the API's dates are Gregorian, so a label in another calendar
 * would name a different day and month than the grid shows. The locale still decides the
 * language, the order and the digits (the grid writes its day numbers with the same digits,
 * see formatDayNumber).
 */
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, calendar: 'gregory' })
    cache.set(key, f)
  }
  return f
}

/** A calendar date's day of the month, in the locale's digits (`1`, or `۱` in fa-IR). */
export function formatDayNumber(key: DateKey, locale: string): string {
  return formatDateKey(key, locale, { day: 'numeric' })
}

export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall-clock time an instant shows in `timeZone`. */
export function wallTime(ms: number, timeZone: string): WallTime {
  const parts = formatter('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/** The calendar date an instant falls on in `timeZone`. */
export function dateKeyIn(ms: number, timeZone: string): DateKey {
  const { year, month, day } = wallTime(ms, timeZone)
  return toDateKey({ year, month, day })
}

/** The zone's offset from UTC at an instant, in milliseconds (e.g. +3 600 000 for CET). */
export function offsetAt(ms: number, timeZone: string): number {
  const w = wallTime(ms, timeZone)
  const wholeSeconds = Math.floor(ms / 1000) * 1000
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - wholeSeconds
}

/**
 * The instant at which `timeZone` shows this wall-clock time. A time skipped by a daylight
 * saving change (02:30 when clocks jump from 02:00 to 03:00) gives the instant after the gap;
 * a time shown twice gives the earlier one.
 */
export function instantOf(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const before = offsetAt(wall, timeZone)
  const guess = wall - before
  const after = offsetAt(guess, timeZone)
  return after === before ? guess : wall - after
}

/** `9:30 AM` or `09:30`, as the locale writes times (12 or 24 hours). */
export function formatTime(
  ms: number,
  timeZone: string,
  locale: string,
  { withZone = false }: { withZone?: boolean } = {},
): string {
  return formatter(locale, {
    timeZone,
    hour: locale.startsWith('zh') ? '2-digit' : 'numeric',
    ...(locale.startsWith('zh') && { hourCycle: 'h23' }),
    minute: '2-digit',
    ...(withZone && { timeZoneName: 'short' }),
  }).format(ms)
}

/** `9:30 – 10:00 AM`: a start and end on one day, as the locale writes such ranges. */
export function formatTimeRange(start: number, end: number, timeZone: string, locale: string) {
  // Chinese reads 24-hour HH:mm, as formatTime writes single times.
  const format = formatter(locale, {
    timeZone,
    hour: locale.startsWith('zh') ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(locale.startsWith('zh') && { hourCycle: 'h23' }),
  })
  // Intl range patterns may pad a 24-hour hour even when a single time does not. Retain
  // the locale's range punctuation/day-period sharing, using the same hours as the slots.
  const hour = (instant: number) =>
    format.formatToParts(instant).find((p) => p.type === 'hour')?.value
  return format
    .formatRangeToParts(start, end)
    .map((part) =>
      part.type === 'hour'
        ? (hour(part.source === 'endRange' ? end : start) ?? part.value)
        : part.value,
    )
    .join('')
}

/** `Tuesday, November 3, 2026`: the date an instant falls on in `timeZone`. */
export function formatDate(ms: number, timeZone: string, locale: string): string {
  return formatter(locale, {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(ms)
}

/** A calendar date as the locale writes it, e.g. `Tuesday, November 3`. */
export function formatDateKey(
  key: DateKey,
  locale: string,
  options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' },
): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return formatter(locale, { ...options, timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d))
}

/** `November 2026`. */
export function formatMonth(year: number, month: number, locale: string): string {
  return formatter(locale, { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(
    Date.UTC(year, month - 1, 1),
  )
}

/** `GMT+01:00`, `GMT-03:30`, `GMT+00:00`: the zone's offset at an instant. */
export function offsetLabel(timeZone: string, ms: number): string {
  const part = formatter('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')
  // Engines write a zero offset as `GMT` or `GMT+00:00`; one spelling for all.
  return !part || part.value === 'GMT' ? 'GMT+00:00' : part.value
}

// Browsers name some zones by their old IANA names (CLDR keeps them as canonical): people
// look for Kolkata and Kyiv, not Calcutta and Kiev. Shown and searched by the current name;
// the API takes either.
const RENAMED: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Godthab': 'America/Nuuk',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
}

/** The zone's current IANA name, e.g. `Asia/Calcutta` → `Asia/Kolkata`. */
export function currentZoneId(timeZone: string): string {
  return RENAMED[timeZone] ?? timeZone
}

/** `America/New_York` → `America/New York`, for people rather than machines. */
export function zoneName(timeZone: string): string {
  return currentZoneId(timeZone).replaceAll('_', ' ')
}

/** `30 min`, `1 h`, `1 h 30 min`. */
export function formatDuration(minutes: number, locale = 'en'): string {
  if (locale.startsWith('zh')) {
    const hours = Math.floor(minutes / 60),
      rest = minutes % 60
    return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${minutes} 分钟`
  }
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}
