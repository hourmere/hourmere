// Calendar invitations (iCalendar, RFC 5545; methods from iTIP, RFC 5546) attached to booking
// emails, so the meeting lands in the recipient's calendar and later updates replace it.
import { interfaceLanguage } from '@hourmere/core/language'
import type { MailAttachment } from './index.ts'

/** Public guidance only: calendar entries may be shared, so they never get manage links. */
export function calendarResponseDescription(locale?: string | null): string {
  return interfaceLanguage(locale) === 'zh-CN'
    ? '日历回应不会取消此预约。如需取消，请使用 Hourmere 原邮件中的取消链接。'
    : 'Calendar responses do not cancel this booking. Use the cancellation link in the original Hourmere email.'
}

export interface IcsPerson {
  name: string
  email: string
}

export interface IcsAttendee extends IcsPerson {
  role?: 'CHAIR' | 'REQ-PARTICIPANT' | undefined
  partstat?: 'NEEDS-ACTION' | 'ACCEPTED' | undefined
  rsvp?: boolean | undefined
}

export interface IcsEvent {
  /** REQUEST adds or updates the event; CANCEL removes it. */
  method: 'REQUEST' | 'CANCEL'
  /** The same for every version of one meeting, e.g. `<first booking id>@<instance host>`. */
  uid: string
  /** 0 for the first version, higher for each later one (reschedule, cancellation). */
  sequence: number
  /** When this version was made (DTSTAMP). */
  stamp: Temporal.Instant
  start: Temporal.Instant
  end: Temporal.Instant
  summary: string
  description?: string | undefined
  location?: string | undefined
  organizer: IcsPerson & { sentBy?: string | undefined }
  attendees: readonly IcsAttendee[]
}

// Control characters other than tab, which TEXT values may not contain (RFC 5545 3.3.11),
// plus the Unicode line separators and bidi controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const NOT_TAB = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** A TEXT value: backslash, semicolon and comma escaped, line breaks as `\n`. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n?|\n|\u0085|\u2028|\u2029/g, '\n')
    .split('\n')
    .map((line) => line.replace(NOT_TAB, '').replace(/[\\;,]/g, (c) => `\\${c}`))
    .join('\\n')
}

/**
 * A parameter value such as CN, always quoted. Quoted values may not contain DQUOTE or
 * control characters (RFC 5545 3.1), so those are replaced rather than escaped.
 */
function quotedParam(value: string): string {
  return `"${value.replace(NOT_TAB, ' ').replace(/[\t"]/g, (c) => (c === '"' ? "'" : ' '))}"`
}

// RFC 6068: mailbox punctuation such as #, ? and % must not become URI fragments, headers
// or pre-existing escapes. Keep @ and + readable; both are legal in mailto's addr-spec.
const mailto = (email: string) =>
  `mailto:${encodeURIComponent(email.replace(NOT_TAB, '').replace(/\s/g, ''))
    .replace(/%40/g, '@')
    .replace(/%2B/g, '+')}`

/** `20261020T080000Z` */
function utc(instant: Temporal.Instant): string {
  return instant.toString({ smallestUnit: 'second' }).replace(/[-:]/g, '')
}

const utf8Length = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4

/**
 * Folds a content line into lines of at most 75 octets (RFC 5545 3.1): the first carries 75,
 * each continuation a space and 74. Splits only between code points, never inside a UTF-8
 * sequence.
 */
export function foldIcsLine(line: string): string {
  const parts: string[] = []
  let current = ''
  let octets = 0
  let limit = 75
  for (const char of line) {
    const size = utf8Length(char.codePointAt(0) as number)
    if (octets + size > limit) {
      parts.push(current)
      current = ''
      octets = 0
      limit = 74
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

/** An iCalendar object with one VEVENT, CRLF line endings, lines folded. */
export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hourmere//Hourmere//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.method}`,
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`,
    `DTSTAMP:${utc(event.stamp)}`,
    `DTSTART:${utc(event.start)}`,
    `DTEND:${utc(event.end)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    ...(event.description ? [`DESCRIPTION:${escapeIcsText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeIcsText(event.location)}`] : []),
    `ORGANIZER;CN=${quotedParam(event.organizer.name)}${event.organizer.sentBy ? `;SENT-BY=${quotedParam(mailto(event.organizer.sentBy))}` : ''}:${mailto(event.organizer.email)}`,
    ...event.attendees.map(
      (a) =>
        `ATTENDEE;CN=${quotedParam(a.name)};ROLE=${a.role ?? 'REQ-PARTICIPANT'};PARTSTAT=${a.partstat ?? 'ACCEPTED'};RSVP=${a.rsvp ? 'TRUE' : 'FALSE'}:${mailto(a.email)}`,
    ),
    `STATUS:${event.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`
}

/** The invitation as an email attachment. */
export function icsAttachment(event: IcsEvent): MailAttachment {
  return {
    filename: event.method === 'CANCEL' ? 'cancel.ics' : 'invite.ics',
    contentType: `text/calendar; method=${event.method}; charset=UTF-8`,
    content: buildIcs(event),
  }
}
