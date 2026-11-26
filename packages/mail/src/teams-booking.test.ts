import { localeRegistry } from '@hourmere/core/locales'
import { describe, expect, it } from 'vitest'
import {
  type BookingEmailMeeting,
  bookingEmail,
  meetingLocationText,
  type TeamsMeetingLocation,
} from './booking.ts'
import { mailCatalogues } from './catalogue.ts'
import { calendarTeamsDescription, escapeIcsText, icsAttachment } from './ics.ts'
import { escapeHtml } from './text.ts'

const url =
  'https://teams.microsoft.com/l/meetup-join/synthetic-booking/0?context=abc&tenant=example'
const start = Temporal.Instant.from('2026-11-03T09:00:00Z')
const end = start.add({ minutes: 30 })
const rows = [
  { kind: 'microsoft_teams', status: 'ready', url },
  { kind: 'microsoft_teams', status: 'join_url_pending' },
  { kind: 'microsoft_teams', status: 'teams_unavailable' },
  { kind: 'microsoft_teams', status: 'writeback_failed' },
] as const satisfies readonly TeamsMeetingLocation[]
const noticeKeys = {
  join_url_pending: ['teams.linkPending', 'teams.linkPendingCancelled'],
  teams_unavailable: ['teams.unavailable', 'teams.unavailableCancelled'],
  writeback_failed: ['teams.writebackFailed', 'teams.writebackFailedCancelled'],
} as const

describe.each(Object.keys(localeRegistry))('Teams booking messages in %s', (locale) => {
  describe.each(['confirmed', 'rescheduled', 'cancelled'] as const)('%s', (kind) => {
    it.each(rows)('renders $status in the email and calendar invitation', (location) => {
      const method = kind === 'cancelled' ? 'CANCEL' : 'REQUEST'
      const meeting: BookingEmailMeeting = {
        eventName: 'Intro call',
        hostName: 'Grace Hopper',
        inviteeName: 'Ada Lovelace',
        inviteeEmail: 'ada@example.test',
        inviteeTimeZone: 'UTC',
        start,
        end,
        location,
      }
      const attachment = icsAttachment({
        method,
        uid: 'teams-synthetic@hourmere',
        sequence: kind === 'confirmed' ? 0 : kind === 'rescheduled' ? 1 : 2,
        stamp: start.subtract({ hours: 1 }),
        start,
        end,
        summary: meeting.eventName,
        description: calendarTeamsDescription(location, method, locale),
        location: meetingLocationText(location),
        organizer: { name: meeting.hostName, email: 'grace@example.test' },
        attendees: [{ name: meeting.inviteeName, email: meeting.inviteeEmail }],
      })
      const email = bookingEmail(
        kind,
        meeting,
        { role: 'attendee', email: meeting.inviteeEmail, timeZone: 'UTC', locale },
        { attachment },
      )
      expect(email.html).toContain(`<html lang="${locale}">`)
      expect(email.text).toContain('Microsoft Teams')
      expect(email.html).toContain('Microsoft Teams')
      const content = email.attachments?.[0]?.content.replaceAll('\r\n ', '')
      expect(content).toContain(`METHOD:${method}`)
      const catalogue = mailCatalogues[locale]
      if (location.status === 'ready') {
        expect(email.text).toContain(url)
        expect(email.html).toContain(escapeHtml(url))
        expect(content).toContain(`LOCATION:${url}`)
        expect(content).toMatch(/DESCRIPTION:[^\r\n]+https:\/\/teams\.microsoft\.com/)
        const detail = method === 'REQUEST' ? catalogue?.['Join Teams meeting'] : 'Microsoft Teams'
        expect(detail).toBeTruthy()
        expect(content).toContain(`DESCRIPTION:${detail}`)
        if (method === 'REQUEST') expect(email.text).toContain(detail)
        else expect(email.html).not.toContain(`href="${escapeHtml(url)}"`)
      } else {
        const [scheduled, cancelled] = noticeKeys[location.status]
        const notice = catalogue?.[kind === 'cancelled' ? cancelled : scheduled]
        expect(notice).toBeTruthy()
        if (locale !== 'en') expect(notice).not.toMatch(/The Teams link|This booking/)
        expect(email.text).toContain(notice)
        expect(email.html).toContain(escapeHtml(notice ?? ''))
        expect(content).toContain('LOCATION:Microsoft Teams')
        expect(content).toContain(`DESCRIPTION:${escapeIcsText(notice ?? '')}`)
        expect(JSON.stringify(email)).not.toContain('https://teams.')
        if (location.status === 'writeback_failed') {
          expect(JSON.stringify(email)).not.toContain('Outlook')
          expect(email.text).not.toContain(catalogue?.[noticeKeys.join_url_pending[0]] ?? '')
        }
      }
    })
  })
})
