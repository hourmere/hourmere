import { describe, expect, it } from 'vitest'
import { type BookingEmailMeeting, bookingEmail, followUpEmail } from './booking.ts'
import {
  type MailMessage,
  meetingPollCredentialEmail,
  teamInvitationEmail,
  waitlistVerificationEmail,
} from './index.ts'

const publicUrl = 'https://calendar.example.test'
const eventName = '📅 42 مراجعة (Review) & צוות'
const hostName = 'נועה (Noa) [12]'
const inviteeName = 'ليلى (Layla)'
const inviteeEmail = 'layla+booking@example.test'
const address = 'شارع النور (Oak St), Room 42'
const meetingLinkLabel = 'חדר וידאו (Video room)'
const meetingUrl = 'https://video.example.test/room?team=42&layout=grid'
const note = `للاطلاع (${meetingUrl}) وللتواصل <${inviteeEmail}>\n\nFollow up: שלום`
const answer = note.replace('\n\n', '\n')
const manage = {
  reschedule: `${publicUrl}/booking#token=fixture&action=reschedule`,
  cancel: `${publicUrl}/booking#token=fixture&action=cancel`,
}
const meeting: BookingEmailMeeting = {
  eventName,
  hostName,
  hostNames: [hostName, 'عمر (Omar)', '王安'],
  inviteeName,
  inviteeEmail,
  inviteeTimeZone: 'UTC',
  guests: [{ name: 'יעל (Yael)', email: 'yael@example.test' }],
  start: Temporal.Instant.from('2026-11-20T10:00:00Z'),
  end: Temporal.Instant.from('2026-11-20T10:30:00Z'),
  location: { kind: 'custom', text: address },
}
const attendee = {
  role: 'attendee',
  email: inviteeEmail,
  timeZone: 'UTC',
  manageLinks: manage,
} as const

// Preserve the HTML lines where direction and label order matter. The shared email
// layout has its own snapshots for presentation styles and Outlook table wrappers.
function snapshotContent(message: MailMessage, locale: string) {
  expect(message.html).toContain(`<html lang="${locale}">`)
  expect(`${message.subject}\n${message.text}`).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u)
  return {
    subject: message.subject,
    text: message.text,
    html: message.html
      ?.split('\n')
      .filter((line) => line.includes('<bdi') || line.includes('<a '))
      .map((line) =>
        line
          .replaceAll(/ style="[^"]*"/g, '')
          .replaceAll(/<table[^>]*><tr><td[^>]*>|<\/td><\/tr><\/table>/g, ''),
      )
      .join('\n'),
  }
}

describe('mixed-direction transactional mail', () => {
  it.each(['en', 'zh-CN'])(
    'preserves booking names, address and private answers in %s',
    (locale) => {
      const message = bookingEmail('confirmed', meeting, {
        role: 'host',
        email: 'noa@example.test',
        timeZone: 'UTC',
        locale,
        answers: [{ question: 'מה הנושא? (Topic)', answer }],
      })
      expect(message.html).toContain(
        `<bdi>${inviteeName}</bdi> &lt;<bdi dir="ltr">${inviteeEmail}</bdi>&gt;`,
      )
      expect(message.html).toContain(`<bdi>${address}</bdi>`)
      expect(message.text).toContain(answer.replaceAll('\n', '\n  '))
      expect(snapshotContent(message, locale)).toMatchSnapshot()
    },
  )

  it.each(['en', 'zh-CN'])(
    'keeps meeting and management actions distinct from their displayed text in %s',
    (locale) => {
      const message = bookingEmail(
        'confirmed',
        { ...meeting, location: { kind: 'link', label: meetingLinkLabel, url: meetingUrl } },
        { ...attendee, locale },
      )
      expect(message.html).toContain(`<bdi>${meetingLinkLabel}</bdi>`)
      expect(message.html).toContain(`<bdi dir="ltr">${meetingUrl.replace('&', '&amp;')}</bdi></a>`)
      expect(message.text).toContain(meetingUrl)
      expect(snapshotContent(message, locale)).toMatchSnapshot()
    },
  )

  it('renders a multiline follow-up note without turning embedded contact text into links', () => {
    const locale = 'en'
    const message = followUpEmail(meeting, { ...attendee, locale }, { hostNote: note })
    expect(message.text).toContain(note)
    expect(message.html).toContain('</bdi><br><br><bdi>Follow up: שלום</bdi>')
    expect(message.html).not.toContain('<a ')
    expect(message.attachments).toBeUndefined()
    expect(snapshotContent(message, locale)).toMatchSnapshot()
  })

  it('keeps cancellation details isolated and leaves out the old join and manage links', () => {
    const locale = 'zh-CN'
    const message = bookingEmail(
      'cancelled',
      {
        ...meeting,
        location: { kind: 'link', label: meetingLinkLabel, url: meetingUrl },
        cancelReason: 'تم التأجيل (Postponed)\nצרו קשר (Contact us)',
      },
      { ...attendee, locale },
    )
    expect(message.html).toContain(
      '<bdi>تم التأجيل (Postponed)</bdi><br><bdi>צרו קשר (Contact us)</bdi>',
    )
    expect(message.html).not.toContain('<a ')
    expect(message.text).not.toContain('token=')
    expect(message.text).not.toContain(meetingUrl)
    expect(snapshotContent(message, locale)).toMatchSnapshot()
  })

  it('preserves the inviter and team name order around the invitation button and fallback URL', () => {
    const locale = 'zh-CN'
    const invitationId = '019a278e-3ff2-7a91-8fe0-1846a52d0b22'
    const message = teamInvitationEmail({
      to: inviteeEmail,
      publicUrl,
      invitationId,
      teamName: 'فريق التصميم (Design) & צוות',
      inviterName: hostName,
      expiresAt: '2026-11-21T10:00:00Z',
      language: locale,
    })
    const href = `${publicUrl}/app/join?invitationId=${invitationId}`
    expect(message.html?.match(/<a href="[^"]+"/g)).toEqual([
      `<a href="${href}"`,
      `<a href="${href}"`,
    ])
    expect(message.html).toContain(`<bdi dir="ltr">${href}</bdi>`)
    expect(snapshotContent(message, locale)).toMatchSnapshot()
  })

  it('isolates a mixed poll title and leaves the voting and opt-out URLs in their original order', () => {
    const locale = 'en'
    const message = meetingPollCredentialEmail({
      to: inviteeEmail,
      publicUrl,
      pollTitle: eventName,
      purpose: 'voting',
      token: 'v'.repeat(43),
      optOutToken: 'o'.repeat(43),
      expiresAt: new Date('2026-11-21T10:00:00Z'),
      timeZone: 'UTC',
      language: locale,
    })
    expect(message.html).toContain('<bdi>📅 42 مراجعة (Review) &amp; צוות</bdi>')
    expect(message.text).toContain(eventName)
    expect(snapshotContent(message, locale)).toMatchSnapshot()
  })

  it('keeps a mixed waitlist title and escaped verification URL intact in both alternatives', () => {
    const locale = 'zh-CN'
    const entryId = '019a278e-3ff2-7a91-8fe0-1846a52d0b22'
    const token = `${entryId}.${'v'.repeat(43)}`
    const removalToken = `${entryId}.${'m'.repeat(43)}`
    const message = waitlistVerificationEmail({
      to: inviteeEmail,
      publicUrl,
      eventTitle: eventName,
      token,
      removalToken,
      expiresAt: '2026-11-21T10:00:00Z',
      timeZone: 'UTC',
      language: locale,
    })
    const href = `${publicUrl}/booking/waitlist/verify#token=${token}&management=${removalToken}`
    const escaped = href.replace('&', '&amp;')
    expect(message.html).toContain(`href="${escaped}"`)
    expect(message.html).toContain(`<bdi dir="ltr">${escaped}</bdi>`)
    expect(message.text).toContain(href)
    expect(snapshotContent(message, locale)).toMatchSnapshot()
  })
})
