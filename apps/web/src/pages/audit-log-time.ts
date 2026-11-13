// Local calendar days of the audit log filter, as UTC instants. Browsers do not all ship
// Temporal yet, so this uses Intl only.

const DAY_MS = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string) {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, format)
  }
  return format
}

/** The zone's wall clock at `at`, read as if it were UTC (milliseconds, whole seconds). */
function wallClock(at: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((value) => value.type === type)?.value)
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  )
}

const localDate = (at: number, timeZone: string) =>
  new Date(wallClock(at, timeZone)).toISOString().slice(0, 10)

function parseDate(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const value = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
  if (Number.isNaN(value) || new Date(value).toISOString().slice(0, 10) !== date)
    throw new RangeError(`Not a calendar date: ${date}`)
  return value
}

/** True for an existing YYYY-MM-DD calendar date. */
export function isCalendarDate(date: string): boolean {
  try {
    parseDate(date)
    return true
  } catch {
    return false
  }
}

/** The calendar date after `date` (both YYYY-MM-DD). */
export function nextCalendarDate(date: string): string {
  return new Date(parseDate(date) + DAY_MS).toISOString().slice(0, 10)
}

/**
 * The first instant of local calendar day `date` (YYYY-MM-DD) in IANA zone `timeZone`, as an
 * RFC 3339 UTC instant. When the zone skips midnight that day (a clock change at 00:00), the
 * day starts at the first instant that exists; when midnight happens twice, at the first one.
 */
export function startOfLocalDay(date: string, timeZone: string): string {
  const wall = parseDate(date)
  // Offsets in force around that day; a day sees at most one clock change in practice.
  const offsets = [
    ...new Set([wall - DAY_MS, wall, wall + DAY_MS].map((at) => wallClock(at, timeZone) - at)),
  ]
  const candidates = offsets.map((offset) => wall - offset)
  const exact = candidates.filter((at) => wallClock(at, timeZone) === wall)
  let start: number
  if (exact.length) start = Math.min(...exact)
  else {
    // Midnight does not exist: find the clock change, the first instant on that date.
    let low = Math.min(...candidates)
    let high = Math.max(...candidates)
    while (high - low > 1000) {
      const middle = low + Math.floor((high - low) / 2000) * 1000
      if (localDate(middle, timeZone) >= date) high = middle
      else low = middle
    }
    start = high
  }
  return new Date(start).toISOString().replace('.000Z', 'Z')
}
