// "Add to calendar" for a booking just made: an .ics file built here (no request, nothing
// secret in it: never the manage link) and Google and Outlook links. The UID matches the
// invitation the server emails for a new booking (<booking id>@hourmere, see
// https://hourmere.com/docs/notifications), so a calendar that gets both keeps one event.

export interface CalendarEvent {
  /** The booking's id. */
  id: string
  title: string
  /** Milliseconds since the epoch. */
  start: number
  end: number
  description?: string | undefined
  location?: string | undefined
}

const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')

/** RFC 5545 TEXT: backslash, semicolon and comma escaped, line breaks as \n, controls dropped. */
export function escapeText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/[\\;,]/g, (c) => `\\${c}`)
      .replace(/\n/g, '\\n')
  )
}

const encoder = new TextEncoder()

/** Folds a content line at 75 octets, never inside a UTF-8 sequence (RFC 5545 3.1). */
export function foldLine(line: string): string {
  const out: string[] = []
  let current = ''
  let octets = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    // The first line holds 75 octets; continuation lines start with a space, so 74 more.
    if (octets + size > (out.length ? 74 : 75)) {
      out.push(current)
      current = ''
      octets = 0
    }
    current += char
    octets += size
  }
  out.push(current)
  return out.join('\r\n ')
}

/** The booking as an iCalendar file (one VEVENT, times in UTC, CRLF line endings). */
export function buildIcs(event: CalendarEvent, now: number = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hourmere//Booking page//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.id}@hourmere`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(event.start)}`,
    `DTEND:${utcStamp(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

/** A data: URL for downloading the .ics file. */
export function icsDataUrl(event: CalendarEvent): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(event))}`
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${utcStamp(event.start)}/${utcStamp(event.end)}`,
  })
  if (event.description) params.set('details', event.description)
  if (event.location) params.set('location', event.location)
  return `https://calendar.google.com/calendar/render?${params}`
}

export function outlookCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: new Date(event.start).toISOString(),
    enddt: new Date(event.end).toISOString(),
  })
  if (event.description) params.set('body', event.description)
  if (event.location) params.set('location', event.location)
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params}`
}
