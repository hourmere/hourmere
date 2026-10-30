import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type BookingEmailKind, type BookingEmailRecipient, bookingEmail } from './booking.ts'
import { calendarBookingDescription, calendarResponseDescription, calendarSummary } from './ics.ts'
import { magicLinkEmail, teamInvitationEmail } from './index.ts'

const meeting = {
  eventName: 'Intro {other} & <research>',
  hostName: 'Grace 霍',
  inviteeName: 'Ada 艾',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Paris',
  start: Temporal.Instant.from('2026-10-25T01:30:00Z'),
  end: Temporal.Instant.from('2026-10-25T02:00:00Z'),
  previous: {
    start: Temporal.Instant.from('2026-10-24T01:30:00Z'),
    end: Temporal.Instant.from('2026-10-24T02:00:00Z'),
  },
  location: { kind: 'link' as const, url: 'https://meet.google.com/fixture' },
  cancelReason: 'Plans changed & <literal>',
  guests: [{ name: 'Alex', email: 'alex@example.test' }],
}
const recipients: BookingEmailRecipient[] = [
  {
    role: 'attendee',
    email: meeting.inviteeEmail,
    timeZone: 'Europe/Paris',
    manageLinks: {
      reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
      cancel: 'https://example.test/booking#token=fixture&action=cancel',
    },
  },
  { role: 'attendee', email: 'alex@example.test', timeZone: 'Europe/Paris' },
  {
    role: 'host',
    email: 'grace@example.test',
    timeZone: 'America/New_York',
    answers: [{ question: 'Question <literal>', answer: 'Answer & {host}' }],
  },
]
const kinds: BookingEmailKind[] = [
  'confirmed',
  'rescheduled',
  'cancelled',
  'reminder',
  'conference_failed',
]

const existingLanguages = ['en', 'zh-CN', 'de', 'fr', 'es'] as const

describe('existing language output before Brazilian Portuguese registration', () => {
  // The digest covers complete subject/text/HTML messages, including inline styles.
  // Earlier goldens are retained; Spanish was captured from immutable main sources before pt-BR.
  it.each(existingLanguages)('preserves every rendered %s message byte', (locale) => {
    const messages = kinds.flatMap((kind) =>
      recipients.map((recipient) =>
        bookingEmail(
          kind,
          meeting,
          { ...recipient, locale },
          {
            bookingUrl: 'https://example.test/app/bookings/fixture',
          },
        ),
      ),
    )
    const output = [
      ...messages,
      teamInvitationEmail({
        to: meeting.inviteeEmail,
        publicUrl: 'https://example.test',
        invitationId: '019a278e-3ff2-7a91-8fe0-1846a52d0b22',
        teamName: 'Orbital {inviter} & <research>',
        inviterName: meeting.hostName,
        expiresAt: '2026-10-29T17:30:00Z',
        language: locale,
      }),
      magicLinkEmail({
        to: meeting.inviteeEmail,
        url: 'https://example.test/sign-in#token=fixture',
        expiresInMinutes: 7,
        language: locale,
      }),
      calendarSummary(meeting.eventName, meeting.hostName, locale),
      calendarBookingDescription(meeting.hostName, locale),
      ...(['invitee', 'host', 'guest'] as const).map((role) =>
        calendarResponseDescription(role, locale),
      ),
    ]
    expect(createHash('sha256').update(JSON.stringify(output)).digest('hex')).toMatchSnapshot()
  })
})
