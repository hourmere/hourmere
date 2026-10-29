import { interfaceLanguage } from '@hourmere/core/language'
import ICAL from 'ical.js'
import { describe, expect, it, vi } from 'vitest'
import { bookingAnswerText, bookingEmail, formatMeetingTime } from './booking.ts'
import {
  calendarBookingDescription,
  calendarResponseDescription,
  calendarSummary,
  icsAttachment,
} from './ics.ts'
import { magicLinkEmail, teamInvitationEmail } from './index.ts'

// A catalogue file plus one registry entry exercises the real loaders and renderers.
// Neither this language nor its deliberately partial catalogue is shipped to customers.
vi.mock('@hourmere/core/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/core/locales')>()
  return {
    ...actual,
    localeRegistry: {
      ...actual.localeRegistry,
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture',
        fallbacks: ['en'],
        formatLocale: 'fr-FR',
        direction: 'ltr',
      },
    },
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      const files = Reflect.apply(actual.readdirSync, actual, args)
      return String(args[0]).endsWith('/mail/src/catalogues/') ? [...files, 'qaa.json'] : files
    },
    readFileSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith('/mail/src/catalogues/qaa.json'))
        return actual.readFileSync(new URL('./fixtures/locale-qaa.json', import.meta.url), 'utf8')
      return Reflect.apply(actual.readFileSync, actual, args)
    },
  }
})

const at = (value: string) => Temporal.Instant.from(value)
const meeting = {
  eventName: 'Intro {other}',
  hostName: 'Grace',
  inviteeName: 'Ada',
  inviteeEmail: 'ada@example.com',
  inviteeTimeZone: 'America/New_York',
  start: at('2026-11-01T06:30:00Z'),
  end: at('2026-11-01T06:45:00Z'),
  previous: { start: at('2026-11-01T05:30:00Z'), end: at('2026-11-01T05:45:00Z') },
  location: null,
}
const recipient = {
  role: 'attendee' as const,
  email: 'ada@example.com',
  timeZone: 'America/New_York',
  locale: 'qaa',
  manageLinks: {
    reschedule: 'https://example.com/booking#token=fixture&action=reschedule',
    cancel: 'https://example.com/booking#token=fixture&action=cancel',
  },
}
const date = (value: Temporal.Instant, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: recipient.timeZone })
    .format(value.epochMilliseconds)
    .replace(/[\u00a0\u202f]/g, ' ')

describe('test-only locale mail registration', () => {
  it('discovers the catalogue and falls back per key in confirmation, reschedule and cancellation', () => {
    for (const kind of ['confirmed', 'rescheduled', 'cancelled'] as const) {
      const message = bookingEmail(kind, meeting, recipient)
      expect(message.html).toContain('<html lang="qaa">')
      expect(message.text).toContain('Fixture activité: Intro {other}')
      expect(message.text).toContain('Fixture hôte: Grace')
      expect(message.text).toContain(
        kind === 'confirmed'
          ? 'Your meeting with Grace is booked.'
          : kind === 'rescheduled'
            ? 'Your meeting with Grace has moved to a new time.'
            : 'Your meeting with Grace has been cancelled.',
      )
      expect(message.text).not.toContain('format.')
      expect(message.text.includes('token=fixture')).toBe(kind !== 'cancelled')
    }
  })

  it('formats active-locale dates while retaining recipient zone and both DST offsets', () => {
    const longDate = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' } as const
    const time = { hour: 'numeric', minute: '2-digit' } as const
    expect(
      formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, recipient.locale),
    ).toBe(
      `${date(meeting.start, longDate)}, ${date(meeting.start, time)} – ${date(meeting.end, time)} (America/New York, GMT-05:00)`,
    )
    const message = bookingEmail('rescheduled', meeting, recipient)
    expect(message.text).toContain('dimanche 1 novembre 2026')
    expect(message.text).toContain('GMT-05:00')
    expect(message.text).toContain('GMT-04:00')
    expect(message.subject).toContain(
      date(meeting.start, { weekday: 'short', month: 'short', day: 'numeric' }),
    )
  })

  it('localizes ICS summary and context without changing UTC instants or calendar identity', () => {
    for (const [method, sequence] of [
      ['REQUEST', 1],
      ['CANCEL', 2],
    ] as const) {
      const attachment = icsAttachment({
        method,
        sequence,
        uid: 'fixture@hourmere',
        stamp: at('2026-10-30T12:00:00Z'),
        start: meeting.start,
        end: meeting.end,
        summary: calendarSummary(meeting.eventName, meeting.hostName, recipient.locale),
        description: `${calendarBookingDescription(meeting.hostName, recipient.locale)}\n${calendarResponseDescription('invitee', recipient.locale)}`,
        organizer: { name: 'Grace', email: 'grace@example.com' },
        attendees: [{ name: 'Ada', email: recipient.email }],
      })
      const calendar = new ICAL.Component(ICAL.parse(attachment.content))
      const event = calendar.getFirstSubcomponent('vevent')
      expect(event?.getFirstPropertyValue('summary')).toBe('Fixture Intro {other} avec Grace')
      expect(event?.getFirstPropertyValue('description')).toBe(
        'Fixture réservé avec Grace.\nFixture utiliser le courriel pour annuler.',
      )
      expect(event?.getFirstPropertyValue('uid')).toBe('fixture@hourmere')
      expect(event?.getFirstPropertyValue('sequence')).toBe(sequence)
      expect(attachment.content).toContain('DTSTART:20261101T063000Z')
      expect(attachment.content).not.toContain('token=')
    }
    expect(calendarResponseDescription('host', recipient.locale)).toContain(
      'To cancel, open the booking in Hourmere.',
    )
  })

  it('uses a partial catalogue for sign-in mail and generated answers', () => {
    const language = interfaceLanguage(recipient.locale) ?? 'en'
    expect(language).toBe('qaa')
    const message = magicLinkEmail({
      to: recipient.email,
      url: 'https://example.com/sign-in#token=fixture',
      expiresInMinutes: 7,
      language,
    })
    expect(message.subject).toBe('Fixture connexion')
    expect(message.text).toContain('The link expires in 7 minutes')
    expect(message.html).toContain('<html lang="qaa">')
    expect(bookingAnswerText(true, language)).toBe('Fixture oui')
    expect(bookingAnswerText(false, language)).toBe('No')
    expect(bookingAnswerText(['literal', 'answer'], language)).toBe('literal, answer')
  })

  it('discovers team invitation messages and falls back for untranslated facts', () => {
    const message = teamInvitationEmail({
      to: recipient.email,
      publicUrl: 'https://example.com',
      invitationId: '019a278e-3ff2-7a91-8fe0-1846a52d0b22',
      teamName: 'Orbital {inviter}',
      inviterName: 'Ada',
      expiresAt: '2026-10-29T17:30:00Z',
      language: recipient.locale,
    })
    expect(message.subject).toBe('Fixture équipe Orbital {inviter}')
    expect(message.html).toContain('<html lang="qaa">')
    expect(message.text).toContain('Ada invited you to join the team “Orbital {inviter}”')
    expect(message.text).toContain('This invitation expires at 2026-10-29 17:30:00 UTC.')
  })

  it('wraps long catalogue field labels independently of the language', () => {
    const message = bookingEmail('confirmed', meeting, {
      role: 'host',
      email: 'grace@example.com',
      timeZone: 'Europe/Berlin',
      locale: recipient.locale,
      answers: [],
    })
    const labelCell = message.html?.match(
      /<td style="([^"]*)">Fixture unusually long attendee local time label<\/td>/,
    )?.[1]
    expect(labelCell).toContain('white-space: normal;')
    expect(labelCell).toContain('overflow-wrap: anywhere;')
    expect(labelCell).toContain('width: 35%;')
  })
})
