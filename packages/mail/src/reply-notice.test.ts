import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import {
  type BookingEmailMeeting,
  bookingEmail,
  followUpEmail,
  rescheduleRequestEmail,
} from './booking.ts'
import { mailCatalogues } from './catalogue.ts'

// A collective booking's invitee and guests get no host Reply-To, so their emails say that
// replies do not reach the hosts, and point the invitee to the management links.

const meeting: BookingEmailMeeting = {
  eventName: 'Team intro',
  hostName: 'Grace Hopper',
  hostNames: ['Grace Hopper', 'Alan Turing'],
  inviteeName: 'Ada Lovelace',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Berlin',
  start: Temporal.Instant.from('2026-11-20T08:00:00Z'),
  end: Temporal.Instant.from('2026-11-20T08:30:00Z'),
  location: null,
}
const manageLinks = {
  reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
  cancel: 'https://example.test/booking#token=fixture&action=cancel',
}

describe('collective reply notice', () => {
  it.each(registeredLocales.map((l) => l.code))('is translated for %s', (locale) => {
    const catalogue = mailCatalogues[locale] ?? {}
    expect(catalogue['replyNotice.plain']).toBeTruthy()
    expect(catalogue['replyNotice.manageLinks']).toBeTruthy()
    const invitee = {
      role: 'attendee' as const,
      email: meeting.inviteeEmail,
      timeZone: 'UTC',
      locale,
      manageLinks,
      repliesNotDelivered: true,
    }
    const confirmed = bookingEmail('confirmed', meeting, invitee)
    expect(confirmed.text).toContain(catalogue['replyNotice.manageLinks'])
    expect(confirmed.html).toContain('#token=fixture')
    // Without management links (cancellation, follow-up), the notice does not mention them.
    const cancelled = bookingEmail('cancelled', meeting, invitee)
    expect(cancelled.text).toContain(catalogue['replyNotice.plain'])
    expect(cancelled.text).not.toContain(catalogue['replyNotice.manageLinks'])
    expect(followUpEmail(meeting, invitee).text).toContain(catalogue['replyNotice.plain'])
    const request = rescheduleRequestEmail(meeting, invitee, {
      expiresAt: Temporal.Instant.from('2026-11-19T08:00:00Z'),
    })
    expect(request.text).toContain(catalogue['replyNotice.manageLinks'])
    if (locale !== 'en')
      expect(catalogue['replyNotice.plain']).not.toBe(mailCatalogues.en?.['replyNotice.plain'])
  })

  it('is absent unless requested, and never shown to hosts', () => {
    const plain = mailCatalogues.en?.['replyNotice.plain'] as string
    const invitee = { role: 'attendee' as const, email: 'ada@example.test', timeZone: 'UTC' }
    expect(bookingEmail('confirmed', meeting, invitee).text).not.toContain(plain)
    const host = {
      role: 'host' as const,
      email: 'grace@example.test',
      timeZone: 'UTC',
      answers: [],
      repliesNotDelivered: true,
    }
    expect(bookingEmail('confirmed', meeting, host).text).not.toContain(plain)
  })
})
