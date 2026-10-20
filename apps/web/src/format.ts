// Formatting for people: durations, and instants shown in a named time zone.
import { formatTimeRange } from './public/time.ts'

/** "30 min", "1 h", "1 h 30 min", "2 days", "1 day 4 h". */
export function formatMinutes(total: number, locale = 'en'): string {
  if (locale.startsWith('zh')) {
    if (total === 0) return '0 分钟'
    const parts = []
    const days = Math.floor(total / 1440),
      hours = Math.floor((total % 1440) / 60),
      minutes = total % 60
    if (days) parts.push(`${days} 天`)
    if (hours) parts.push(`${hours} 小时`)
    if (minutes) parts.push(`${minutes} 分钟`)
    return parts.join(' ')
  }
  if (total === 0) return '0 min'
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const minutes = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`)
  if (hours) parts.push(`${hours} h`)
  if (minutes) parts.push(`${minutes} min`)
  return parts.join(' ')
}

/** The time zone the browser is set to, e.g. "Europe/Berlin". */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The browser's language as a canonical BCP 47 tag, e.g. "en-US". */
export function browserLocale(): string {
  try {
    return Intl.getCanonicalLocales(navigator.language || 'en')[0] ?? 'en'
  } catch {
    return 'en'
  }
}

/** Whether `timeZone` is one the browser knows (the server is the authority). */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone || /^[+-]/.test(timeZone)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Formats instants in one time zone, e.g. the host's. */
export function zoned(timeZone: string, locale?: string) {
  const zone = isKnownTimeZone(timeZone) ? timeZone : 'UTC'
  const chinese = locale?.startsWith('zh') ?? false
  const separator = chinese ? '–' : ' – '
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    calendar: 'gregory',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const longDate = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    calendar: 'gregory',
    dateStyle: 'full',
  })
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    calendar: 'gregory',
    hour: chinese ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(chinese && { hourCycle: 'h23' }),
  })
  const dateTime = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    calendar: 'gregory',
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(chinese && { hourCycle: 'h23' }),
  })
  return {
    timeZone: zone,
    calendar: 'gregory',
    /** "Mon, 2 Nov 2026" */
    date: (iso: string) => date.format(new Date(iso)),
    /** "Monday, 2 November 2026" */
    longDate: (iso: string) => longDate.format(new Date(iso)),
    /** "09:00" or "9:00 AM", as the browser's language writes it. */
    time: (iso: string) => time.format(new Date(iso)),
    /** "2 Nov 2026, 09:00" */
    dateTime: (iso: string) => dateTime.format(new Date(iso)),
    /** Includes each endpoint's date, so a range across midnight is unambiguous. */
    dateTimeRange: (start: string, end: string) =>
      `${dateTime.format(new Date(start))}${separator}${dateTime.format(new Date(end))}`,
    /** "09:00 – 09:30", including the end date when it falls on another local day. */
    timeRange: (start: string, end: string) => {
      const from = new Date(start)
      const to = new Date(end)
      if (chinese && date.format(from) === date.format(to)) {
        return formatTimeRange(from.getTime(), to.getTime(), zone, locale ?? 'zh-CN')
      }
      const until = date.format(from) === date.format(to) ? time.format(to) : dateTime.format(to)
      return `${time.format(from)}${separator}${until}`
    },
  }
}

/** "GMT+2" for a zone at the given moment (default now), or "" if unknown. */
export function utcOffset(timeZone: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(at)
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
