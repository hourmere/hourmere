import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type BookingEmailKind,
  type BookingEmailMeeting,
  type BookingEmailRecipient,
  bookingEmail,
  formatMeetingTime,
} from './booking.ts'
import { icsAttachment } from './ics.ts'

const at = (iso: string) => Temporal.Instant.from(iso)
const languages = ['en', 'zh-CN'] as const
const kinds = ['confirmed', 'rescheduled', 'cancelled'] as const
const roles = ['invitee', 'host', 'guest'] as const

const meeting: BookingEmailMeeting = {
  eventName: 'Intro call',
  hostName: 'Grace Hopper',
  inviteeName: 'Ada Lovelace',
  inviteeEmail: 'ada@example.com',
  guests: [{ name: 'Charles Babbage', email: 'charles@example.com' }],
  start: at('2026-10-20T08:00:00Z'),
  end: at('2026-10-20T08:30:00Z'),
  location: { kind: 'link', label: 'Google Meet', url: 'https://meet.example.com/abc' },
  previous: { start: at('2026-10-19T08:00:00Z'), end: at('2026-10-19T08:30:00Z') },
  cancelReason: 'A scheduling conflict.\nPlease book another time.',
}

const recipients: Record<(typeof roles)[number], BookingEmailRecipient> = {
  invitee: {
    role: 'attendee',
    email: 'ada@example.com',
    timeZone: 'Europe/Berlin',
    manageLinks: {
      reschedule: 'https://cal.example.com/booking#token=fixture&action=reschedule',
      cancel: 'https://cal.example.com/booking#token=fixture&action=cancel',
    },
  },
  host: {
    role: 'host',
    email: 'grace@example.com',
    timeZone: 'America/New_York',
    answers: [
      { question: 'What should we discuss?', answer: 'Analytical engines.\nA short demo.' },
    ],
  },
  guest: { role: 'attendee', email: 'charles@example.com', timeZone: 'Europe/Berlin' },
}

function invitation(method: 'REQUEST' | 'CANCEL') {
  return icsAttachment({
    method,
    uid: 'localization@hourmere',
    sequence: method === 'CANCEL' ? 2 : 1,
    stamp: at('2026-10-18T08:00:00Z'),
    start: meeting.start,
    end: meeting.end,
    summary: 'Intro call',
    organizer: { name: meeting.hostName, email: 'grace@example.com' },
    attendees: [{ name: meeting.inviteeName, email: meeting.inviteeEmail }],
  })
}

describe('booking email language goldens', () => {
  for (const locale of languages) {
    for (const kind of kinds) {
      for (const role of roles) {
        it(`${locale} ${kind} ${role}`, () => {
          const message = bookingEmail(
            kind,
            meeting,
            { ...recipients[role], locale },
            { attachment: invitation(kind === 'cancelled' ? 'CANCEL' : 'REQUEST') },
          )
          expect({
            subject: message.subject,
            text: message.text,
            html: message.html,
          }).toMatchSnapshot()
          expect(message.html).toContain(`<html lang="${locale}">`)
          if (role !== 'invitee' || kind === 'cancelled') {
            expect(message.text).not.toContain('token=')
            expect(message.html).not.toContain('token=')
          }
        })
      }
    }
  }
})

describe('calendar-decline footer', () => {
  for (const locale of languages) {
    for (const role of roles) {
      it(`${locale} ${role} only explains declines with an actual REQUEST`, () => {
        const recipient = { ...recipients[role], locale }
        for (const kind of [...kinds, 'reminder', 'conference_failed'] as const) {
          for (const attachment of [undefined, invitation('REQUEST'), invitation('CANCEL')]) {
            const message = bookingEmail(kind, meeting, recipient, { attachment })
            const expected =
              (kind === 'confirmed' || kind === 'rescheduled') &&
              attachment?.contentType.includes('method=REQUEST') === true
            expect(message.text.includes('Declining this invitation')).toBe(
              expected && locale === 'en',
            )
            expect(message.html?.includes('Declining this invitation')).toBe(
              expected && locale === 'en',
            )
            expect(message.text.includes('在日历中拒绝')).toBe(expected && locale === 'zh-CN')
            expect(message.html?.includes('在日历中拒绝')).toBe(expected && locale === 'zh-CN')
          }
        }
      })
    }
  }

  it('checks the calendar MIME part and its method rather than the file name alone', () => {
    for (const attachment of [
      { ...invitation('REQUEST'), contentType: 'text/plain' },
      { ...invitation('REQUEST'), content: invitation('CANCEL').content },
      { ...invitation('REQUEST'), content: 'This is not an invitation.' },
    ]) {
      const message = bookingEmail('confirmed', meeting, recipients.invitee, { attachment })
      expect(message.text).not.toContain('Declining this invitation')
      expect(message.html).not.toContain('Declining this invitation')
    }
  })
})

describe('localized dates and generated copy', () => {
  it('uses Chinese dates and 24-hour time in the recipient zone, including overnight and DST', () => {
    expect(formatMeetingTime(meeting.start, meeting.end, 'Europe/Berlin', 'zh-CN')).toBe(
      '2026年10月20日星期二，10:00 至 10:30（Europe/Berlin）',
    )
    expect(formatMeetingTime(meeting.start, meeting.end, 'America/New_York', 'zh-CN')).toBe(
      '2026年10月20日星期二，04:00 至 04:30（America/New_York）',
    )
    expect(
      formatMeetingTime(
        at('2026-10-20T21:30:00Z'),
        at('2026-10-20T22:30:00Z'),
        'Europe/Berlin',
        'zh-CN',
      ),
    ).toBe('2026年10月20日星期二，23:30 至 2026年10月21日星期三，00:30（Europe/Berlin）')
    expect(
      formatMeetingTime(
        at('2026-10-26T08:00:00Z'),
        at('2026-10-26T08:30:00Z'),
        'Europe/Berlin',
        'zh-CN',
      ),
    ).toBe('2026年10月26日星期一，09:00 至 09:30（Europe/Berlin）')
    expect(formatMeetingTime(meeting.start, meeting.end, 'invalid/zone', 'zh-CN')).toBe(
      '2026年10月20日星期二，08:00 至 08:30（UTC）',
    )
  })

  it('falls back to the complete English email for unsupported preferences', () => {
    const expected = bookingEmail('confirmed', meeting, { ...recipients.invitee, locale: 'en' })
    for (const locale of [undefined, null, 'fr', 'zh-TW', 'not_a_locale']) {
      expect(bookingEmail('confirmed', meeting, { ...recipients.invitee, locale })).toEqual(
        expected,
      )
    }
  })

  it.each(['reminder', 'conference_failed'] satisfies BookingEmailKind[])(
    'localizes %s emails for every role',
    (kind) => {
      for (const role of roles) {
        const message = bookingEmail(kind, meeting, { ...recipients[role], locale: 'zh-CN' })
        expect(
          message.subject.startsWith(kind === 'reminder' ? '提醒：' : '会议链接需要处理：'),
        ).toBe(true)
        expect(message.text).toContain(
          kind === 'reminder' ? '即将开始。' : '最终日历邀请尚未发送。',
        )
        expect(message.text).toContain('时间：2026年10月20日星期二')
        expect(message.html).toContain('<html lang="zh-CN">')
        expect(message.text).not.toMatch(/Your |What:|When:|Need to make a change/)
      }
    },
  )

  it('localizes phone locations without translating or changing user content', () => {
    const message = bookingEmail(
      'confirmed',
      { ...meeting, location: { kind: 'phone', number: '+1 555 0100' } },
      { ...recipients.invitee, locale: 'zh-CN' },
    )
    expect(message.text).toContain('地点：电话 +1 555 0100')
    expect(message.html).toContain('电话 +1 555 0100')
  })

  it('uses Chinese punctuation in every Chinese copy string', () => {
    // Inspect literal copy, excluding URLs, addresses, markup and Intl numeric time separators.
    const source = readFileSync(new URL('./booking.ts', import.meta.url), 'utf8')
    const copy = [...source.matchAll(/(['"])((?:\\.|(?!\1)[^\r\n\\])*)\1/g)]
      .map((match) => match[2] ?? '')
      .filter((literal) => /\p{Script=Han}/u.test(literal))
    expect(copy.length).toBeGreaterThan(25)
    for (const text of copy) expect(text).not.toMatch(/[.!?,:;()"']/)
  })

  it('escapes translated HTML substitutions and keeps untrusted placeholders literal', () => {
    const message = bookingEmail(
      'cancelled',
      {
        ...meeting,
        eventName: '<script>{host}</script> & "intro"',
        hostName: '<b>Ada</b>',
        cancelReason: '<img src=x onerror=alert(1)>',
      },
      { ...recipients.invitee, locale: 'zh-CN' },
    )
    expect(message.subject).toContain('<script>{host}</script>')
    expect(message.html).not.toMatch(/<script|<b>|<img/i)
    expect(message.html).toContain('&lt;script&gt;{host}&lt;/script&gt; &amp; &quot;intro&quot;')
    expect(message.html).toContain('&lt;b&gt;Ada&lt;/b&gt;')
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
