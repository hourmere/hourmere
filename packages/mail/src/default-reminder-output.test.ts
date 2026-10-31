import { createHash } from 'node:crypto'
import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { type BookingEmailRecipient, bookingEmail } from './booking.ts'
import { icsAttachment } from './ics.ts'

const meeting = {
  eventName: 'Intro {other} & <research>',
  hostName: 'Grace 霍',
  inviteeName: 'Ada 艾',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Paris',
  start: Temporal.Instant.from('2026-10-25T01:30:00Z'),
  end: Temporal.Instant.from('2026-10-25T02:00:00Z'),
  location: { kind: 'link' as const, url: 'https://meet.example.test/fixture' },
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
    answers: [{ question: 'Question <literal>', answer: 'Answer & {host}\nSecond line' }],
  },
]
const attachment = icsAttachment({
  method: 'REQUEST',
  uid: 'reminder@hourmere',
  sequence: 0,
  stamp: Temporal.Instant.from('2026-10-24T12:00:00Z'),
  start: meeting.start,
  end: meeting.end,
  summary: meeting.eventName,
  organizer: { name: meeting.hostName, email: recipients[2]?.email ?? '' },
  attendees: [{ name: meeting.inviteeName, email: meeting.inviteeEmail }],
})

describe('default reminder output before follow-up templates', () => {
  // Captured from the unchanged renderer before adding follow-up content. The digest
  // covers all subject, text, HTML and calendar bytes for all three recipient roles.
  it.each(registeredLocales)('preserves every $code reminder byte', ({ code }) => {
    const messages = [undefined, attachment].flatMap((calendar) =>
      recipients.map((recipient) =>
        bookingEmail(
          'reminder',
          meeting,
          { ...recipient, locale: code },
          { attachment: calendar, bookingUrl: 'https://example.test/app/bookings/fixture' },
        ),
      ),
    )
    expect(createHash('sha256').update(JSON.stringify(messages)).digest('hex')).toMatchSnapshot()
  })
})
