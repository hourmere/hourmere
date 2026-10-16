// Formatting for people: durations, and instants shown in a named time zone.

/** "30 min", "1 h", "1 h 30 min", "2 days", "1 day 4 h". */
export function formatMinutes(total: number): string {
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
export function zoned(timeZone: string) {
  const zone = isKnownTimeZone(timeZone) ? timeZone : 'UTC'
  const date = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const longDate = new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'full' })
  const time = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  })
  const dateTime = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return {
    timeZone: zone,
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
      `${dateTime.format(new Date(start))} – ${dateTime.format(new Date(end))}`,
    /** "09:00 – 09:30", including the end date when it falls on another local day. */
    timeRange: (start: string, end: string) => {
      const from = new Date(start)
      const to = new Date(end)
      const until = date.format(from) === date.format(to) ? time.format(to) : dateTime.format(to)
      return `${time.format(from)} – ${until}`
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
