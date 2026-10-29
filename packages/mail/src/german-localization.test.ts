import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import {
  type BookingEmailKind,
  type BookingEmailRecipient,
  bookingAnswerText,
  bookingEmail,
  bookingHostName,
  formatMeetingTime,
} from './booking.ts'
import {
  calendarBookingDescription,
  calendarResponseDescription,
  calendarSummary,
  icsAttachment,
} from './ics.ts'
import { magicLinkEmail } from './index.ts'

const at = (value: string) => Temporal.Instant.from(value)
const meeting = {
  eventName: 'Intro {other}',
  hostName: 'Grace',
  inviteeName: 'Ada',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Berlin',
  start: at('2026-10-20T08:00:00Z'),
  end: at('2026-10-20T08:30:00Z'),
  previous: { start: at('2026-10-19T08:00:00Z'), end: at('2026-10-19T08:30:00Z') },
  location: { kind: 'link' as const, url: 'https://meet.google.com/fixture' },
}
const recipients: BookingEmailRecipient[] = [
  {
    role: 'attendee',
    email: meeting.inviteeEmail,
    timeZone: 'Europe/Berlin',
    manageLinks: {
      reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
      cancel: 'https://example.test/booking#token=fixture&action=cancel',
    },
  },
  { role: 'attendee', email: 'guest@example.test', timeZone: 'Europe/Berlin' },
  { role: 'host', email: 'grace@example.test', timeZone: 'Europe/Berlin', answers: [] },
]
const kinds: BookingEmailKind[] = [
  'confirmed',
  'rescheduled',
  'cancelled',
  'reminder',
  'conference_failed',
]

describe('German mail catalogue', () => {
  for (const kind of kinds) {
    it(`renders ${kind} subject, text and HTML for the invitee, guest and host`, () => {
      for (const recipient of recipients) {
        const message = bookingEmail(kind, meeting, { ...recipient, locale: 'de' })
        const isHost = recipient.role === 'host'
        const prefix = {
          confirmed: isHost ? 'Neue Buchung:' : 'Bestätigt:',
          rescheduled: 'Verschoben:',
          cancelled: 'Storniert:',
          reminder: 'Erinnerung:',
          conference_failed: 'Problem mit dem Meetinglink:',
        }[kind]
        expect(message.subject.startsWith(prefix)).toBe(true)
        if (kind === 'rescheduled') expect(message.subject).toContain(', neu am Di., 20. Okt.')
        expect(message.html).toContain('<html lang="de">')
        expect(message.text).toContain('Termin: Intro {other}')
        expect(message.html).toContain('>Termin</td>')
        for (const content of [message.text, message.html ?? '']) {
          expect(content).toContain('Intro {other}')
          expect(content).toContain('Dienstag, 20. Oktober 2026')
          expect(content).toContain('10:00 – 10:30')
          expect(content).toContain('Sie erhalten diese E-Mail, weil')
          expect(content).not.toMatch(/Your meeting|What:|When:|You received this email/)
          if (kind === 'conference_failed') {
            expect(content).toContain('keine endgültige Kalendereinladung versendet')
            if (!isHost) expect(content).toContain('Google-Meet-Link')
          } else if (kind !== 'cancelled') {
            expect(content).toContain('Mit Google Meet teilnehmen')
          }
        }
        expect(message.text.includes('token=fixture')).toBe(
          recipient.role === 'attendee' && Boolean(recipient.manageLinks) && kind !== 'cancelled',
        )
      }
    })
  }

  it('maps German regional preferences and retains English for unknown languages', () => {
    const recipient = recipients[0] as BookingEmailRecipient
    const german = bookingEmail('confirmed', meeting, { ...recipient, locale: 'de' })
    for (const locale of ['de-AT', 'de-CH']) {
      expect(bookingEmail('confirmed', meeting, { ...recipient, locale })).toEqual(german)
    }
    expect(bookingEmail('confirmed', meeting, { ...recipient, locale: 'unknown' })).toEqual(
      bookingEmail('confirmed', meeting, { ...recipient, locale: 'en' }),
    )
  })

  it('allows the long host email time-zone label to wrap beside the value', () => {
    const message = bookingEmail('confirmed', meeting, {
      role: 'host',
      email: 'grace@example.test',
      timeZone: 'America/New_York',
      locale: 'de',
      answers: [],
    })
    const labelCell = message.html?.match(
      /<td style="([^"]*)">Ortszeit der buchenden Person<\/td>/,
    )?.[1]
    expect(labelCell).toContain('white-space: normal;')
    expect(labelCell).toContain('width: 35%;')
    expect(labelCell).toContain('overflow-wrap: anywhere;')
    expect(message.text).toContain('Ortszeit der buchenden Person:')
  })

  it('formats German dates and 24-hour times through DST and across midnight', () => {
    expect(formatMeetingTime(meeting.start, meeting.end, 'Europe/Berlin', 'de')).toBe(
      'Dienstag, 20. Oktober 2026, 10:00 – 10:30 (Europe/Berlin, GMT+02:00)',
    )
    expect(
      formatMeetingTime(
        at('2026-10-25T01:30:00Z'),
        at('2026-10-25T02:00:00Z'),
        'Europe/Berlin',
        'de',
      ),
    ).toBe('Sonntag, 25. Oktober 2026, 2:30 – 3:00 (Europe/Berlin, GMT+01:00)')
    expect(
      formatMeetingTime(
        at('2026-10-20T21:30:00Z'),
        at('2026-10-20T22:30:00Z'),
        'Europe/Berlin',
        'de',
      ),
    ).toBe(
      'Dienstag, 20. Oktober 2026, 23:30 – Mittwoch, 21. Oktober 2026, 0:30 (Europe/Berlin, GMT+02:00)',
    )
  })

  it('localizes calendar text without altering literal names, instants or identity', () => {
    const attachment = icsAttachment({
      method: 'REQUEST',
      uid: 'german-fixture@hourmere',
      sequence: 1,
      stamp: at('2026-10-19T08:00:00Z'),
      start: meeting.start,
      end: meeting.end,
      summary: calendarSummary(meeting.eventName, meeting.hostName, 'de'),
      description: `${calendarBookingDescription(meeting.hostName, 'de')}\n${calendarResponseDescription('invitee', 'de')}`,
      organizer: { name: 'Grace', email: 'grace@example.test' },
      attendees: [{ name: 'Ada', email: meeting.inviteeEmail }],
    })
    const event = new ICAL.Component(ICAL.parse(attachment.content)).getFirstSubcomponent('vevent')
    expect(event?.getFirstPropertyValue('summary')).toBe('Intro {other} mit Grace')
    expect(event?.getFirstPropertyValue('description')).toContain(
      'Über Hourmere mit Grace gebucht.',
    )
    expect(event?.getFirstPropertyValue('description')).toContain(
      'Bestätigungs-E-Mail von Hourmere',
    )
    expect(event?.getFirstPropertyValue('uid')).toBe('german-fixture@hourmere')
    expect(attachment.content).toContain('DTSTART:20261020T080000Z')
    expect(attachment.content).not.toContain('token=')
  })

  it('renders German sign-in messages and generated answers', () => {
    const message = magicLinkEmail({
      to: meeting.inviteeEmail,
      url: 'https://example.test/sign-in#token=fixture',
      expiresInMinutes: 7,
      language: 'de',
    })
    expect(message.subject).toBe('Bei Hourmere anmelden')
    expect(message.html).toContain('<html lang="de">')
    for (const content of [message.text, message.html ?? '']) {
      expect(content).toContain('Der Link ist 7 Minuten lang gültig')
      expect(content).toContain('kann nur einmal verwendet werden')
    }
    expect(bookingHostName('de')).toBe('Gastgebende Person')
    expect(bookingAnswerText(true, 'de')).toBe('Ja')
    expect(bookingAnswerText(false, 'de')).toBe('Nein')
    expect(bookingAnswerText(['Literal {other}', 'Antwort'], 'de')).toBe('Literal {other}, Antwort')
  })
})
