import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import {
  type AttendeeRecipient,
  type BookingEmailMeeting,
  bookingEmail,
  bookingLocationForRecipient,
} from './booking.ts'
import { mailCatalogues, mailMessage } from './catalogue.ts'
import { icsAttachment } from './ics.ts'
import { escapeHtml, subjectLine } from './text.ts'

const start = Temporal.Instant.from('2026-10-20T08:00:00Z')
const original: BookingEmailMeeting = {
  eventName: 'Intro call',
  hostName: 'Grace',
  inviteeName: 'Ada',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'UTC',
  start,
  end: start.add({ minutes: 30 }),
  location: { kind: 'microsoft_teams', status: 'join_url_pending' },
}
const replacement = { ...original, hostName: 'Katherine' }
const booker: AttendeeRecipient = {
  role: 'attendee',
  email: original.inviteeEmail,
  timeZone: 'UTC',
}
const guest: AttendeeRecipient = { ...booker, email: 'guest@example.test' }

describe('booking handoff mail', () => {
  it.each(registeredLocales)(
    'marks both notices in $code for the booker and guests',
    ({ code }) => {
      for (const [kind, handoff, meeting] of [
        ['cancelled', 'source', original],
        ['confirmed', 'replacement', replacement],
      ] as const) {
        const notice = mailCatalogues[code]?.[`bookingHandoff.${handoff}`] ?? ''
        expect(notice).toBeTruthy()
        for (const attendee of [booker, guest]) {
          const recipient = { ...attendee, locale: code }
          const ordinary = bookingEmail(kind, meeting, recipient)
          const mail = bookingEmail(kind, meeting, recipient, { handoff })
          expect(mail.subject).toBe(
            subjectLine(mailMessage(code, 'bookingHandoff.subject', { subject: ordinary.subject })),
          )
          expect(mail.subject).not.toBe(ordinary.subject)
          expect(mail.text).toContain(notice)
          expect(mail.html).toContain(escapeHtml(notice))
          expect(ordinary.text).not.toContain(notice)
        }
      }
    },
  )

  it('renders an original cancellation as text only when its calendar organizer is unknown', () => {
    const mail = bookingEmail('cancelled', original, booker, {
      handoff: 'source',
      plainText: true,
    })
    expect(mail).not.toHaveProperty('html')
    expect(mail).not.toHaveProperty('attachments')
    expect(`${mail.subject}\n\n${mail.text.trimEnd()}`).toMatchInlineSnapshot(`
      "Host changed · Cancelled: Intro call with Grace on Tue, Oct 20, 8:00 AM (UTC, GMT+00:00)

      Hourmere

      Your meeting with Grace has been cancelled.

      The host has changed. The original booking was cancelled. Attendees receive a separate email about the replacement.

      What: Intro call
      When: Tuesday, October 20, 2026, 8:00 AM – 8:30 AM (UTC, GMT+00:00)
      Where: Microsoft Teams
        The Teams link for the original booking was still pending at cancellation.
      Host: Grace

      You received this email because you booked a meeting with Grace via Hourmere."
    `)
  })

  it('renders the replacement notice with its own calendar invitation', () => {
    const attachment = icsAttachment({
      method: 'REQUEST',
      uid: 'replacement@hourmere',
      sequence: 0,
      stamp: start.subtract({ hours: 1 }),
      start,
      end: replacement.end,
      summary: replacement.eventName,
      organizer: { name: replacement.hostName, email: 'katherine@example.test' },
      attendees: [{ name: replacement.inviteeName, email: replacement.inviteeEmail }],
    })
    const mail = bookingEmail('confirmed', replacement, guest, {
      handoff: 'replacement',
      attachment,
    })
    expect(mail.attachments).toEqual([attachment])
    expect(`${mail.subject}\n\n${mail.text.trimEnd()}`).toMatchInlineSnapshot(`
      "Host changed · Confirmed: Intro call with Katherine on Tue, Oct 20, 8:00 AM (UTC, GMT+00:00)

      Hourmere

      Your meeting with Katherine is booked.

      The host has changed. This booking replaces the original booking.

      What: Intro call
      When: Tuesday, October 20, 2026, 8:00 AM – 8:30 AM (UTC, GMT+00:00)
      Where: Microsoft Teams
        The Teams link will appear in the booking details when it’s ready.
      Host: Katherine

      Accepting or declining this calendar invitation does not cancel the booking. To cancel, contact the person who booked or the host."
    `)
  })

  it.each([
    ['join_url_pending', 'bookingHandoff.sourceTeamsPending', 'teams.linkPending'],
    ['teams_unavailable', 'bookingHandoff.sourceTeamsUnavailable', 'teams.unavailable'],
    ['writeback_failed', 'bookingHandoff.sourceTeamsWritebackFailed', 'teams.writebackFailed'],
  ] as const)(
    'shows each chain’s own Teams status %s without a join URL',
    (status, oldKey, newKey) => {
      for (const [role, recipient] of [
        ['invitee', booker],
        ['guest', guest],
      ] as const) {
        const location = bookingLocationForRecipient(
          { kind: 'microsoft_teams', status },
          false,
          role,
          'en',
          true,
        )
        const cancel = bookingEmail('cancelled', { ...original, location }, recipient, {
          handoff: 'source',
        })
        const confirm = bookingEmail('confirmed', { ...replacement, location }, recipient, {
          handoff: 'replacement',
        })
        for (const [mail, expected, unexpected] of [
          [cancel, oldKey, newKey],
          [confirm, newKey, oldKey],
        ] as const) {
          const notice = mailMessage('en', expected)
          expect(mail.text).toContain(notice)
          expect(mail.html).toContain(escapeHtml(notice))
          expect(mail.text).not.toContain(mailMessage('en', unexpected))
          expect(JSON.stringify(mail)).not.toContain('https://')
        }
      }
    },
  )

  it('continues to withhold a ready Teams URL from a handoff guest', () => {
    const location = bookingLocationForRecipient(
      {
        kind: 'microsoft_teams',
        status: 'ready',
        url: 'https://teams.microsoft.com/l/meetup-join/example',
      },
      false,
      'guest',
      'en',
      true,
    )
    expect(location).toEqual({ kind: 'custom', text: 'Microsoft Teams' })
  })
})
