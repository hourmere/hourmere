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

const calendarGuidance = {
  en: {
    invitee:
      'Accepting or declining this calendar invitation does not cancel the booking. To cancel, use the “Cancel” link in this email.',
    host: 'Declining in your calendar is not synced to Hourmere; to cancel the booking, use Hourmere.',
    guest:
      'Accepting or declining this calendar invitation does not cancel the booking. To cancel, contact the person who booked or the host.',
  },
  'zh-CN': {
    invitee: '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用此邮件中的“取消”链接。',
    host: '在日历中拒绝邀请不会同步到 Hourmere；如需取消预约，请在 Hourmere 中操作。',
    guest: '在日历中接受或拒绝邀请不会取消预约。如需取消，请联系预约人或主持人。',
  },
}

describe('calendar-response guidance', () => {
  for (const locale of languages) {
    for (const role of roles) {
      for (const kind of [...kinds, 'reminder', 'conference_failed'] as const) {
        it(`${locale} ${kind} ${role} explains only an actual REQUEST invitation`, () => {
          const recipient = { ...recipients[role], locale }
          const sentence = calendarGuidance[locale][role]
          for (const attachment of [undefined, invitation('REQUEST'), invitation('CANCEL')]) {
            const message = bookingEmail(kind, meeting, recipient, { attachment })
            const expected =
              kind !== 'cancelled' &&
              kind !== 'conference_failed' &&
              attachment?.contentType.includes('method=REQUEST') === true
            expect(message.text.includes(sentence)).toBe(expected)
            expect(message.html?.includes(sentence.replaceAll("'", '&#39;'))).toBe(expected)
            if (role !== 'invitee') {
              expect(message.text.includes('token=')).toBe(false)
              expect(message.html?.includes('token=')).toBe(false)
              expect(message.text.includes('/booking#')).toBe(false)
              expect(message.html?.includes('/booking#')).toBe(false)
            } else if (expected) {
              // The note is beside the actions near the top, before meeting details.
              expect(
                message.text.includes(
                  `${recipients.invitee.role === 'attendee' ? recipients.invitee.manageLinks?.cancel : ''}\n${sentence}\n\n`,
                ),
              ).toBe(true)
              expect(message.text.indexOf(sentence)).toBeLessThan(
                message.text.indexOf(locale === 'en' ? 'What:' : '活动：'),
              )
              expect(message.html?.indexOf(sentence.replaceAll("'", '&#39;'))).toBeLessThan(
                message.html?.indexOf('<table') ?? -1,
              )
              expect(message.html).toContain(`</a></p>\n<p lang="${locale}"`)
            }
          }
        })
      }
    }
  }

  it('checks the calendar MIME part and its method rather than the file name alone', () => {
    for (const attachment of [
      { ...invitation('REQUEST'), contentType: 'text/plain' },
      { ...invitation('REQUEST'), content: invitation('CANCEL').content },
      { ...invitation('REQUEST'), content: 'This is not an invitation.' },
    ]) {
      const message = bookingEmail('confirmed', meeting, recipients.invitee, { attachment })
      expect(message.text).not.toContain(calendarGuidance.en.invitee)
      expect(message.html).not.toContain(calendarGuidance.en.invitee)
    }
  })

  it('leaves no blank template placeholder lines before the invitee email body closes', () => {
    for (const locale of languages) {
      for (const kind of [...kinds, 'reminder', 'conference_failed'] as const) {
        for (const attachment of [undefined, invitation('REQUEST'), invitation('CANCEL')]) {
          const message = bookingEmail(
            kind,
            meeting,
            { ...recipients.invitee, locale },
            { attachment },
          )
          expect(message.html).not.toMatch(/\n[\t ]*\n(?=<\/body>)/)
        }
      }
    }
  })
})

describe('localized dates and generated copy', () => {
  it('uses Intl month names in Chinese subjects with the recipient local date and time', () => {
    const overnight = {
      ...meeting,
      start: at('2026-10-27T00:30:00Z'),
      end: at('2026-10-27T01:00:00Z'),
    }
    for (const [timeZone, short, long] of [
      ['Europe/Berlin', '10月27日周二，01:30', '2026年10月27日星期二，01:30 至 02:00'],
      ['America/New_York', '10月26日周一，20:30', '2026年10月26日星期一，20:30 至 21:00'],
      ['invalid/zone', '10月27日周二，00:30', '2026年10月27日星期二，00:30 至 01:00'],
    ] as const) {
      const zone = timeZone === 'invalid/zone' ? 'UTC' : timeZone
      const message = bookingEmail('confirmed', overnight, {
        ...recipients.invitee,
        locale: 'zh-CN',
        timeZone,
      })
      expect(message.subject).toBe(`已确认：与 Grace Hopper 的 Intro call，${short}（${zone}）`)
      expect(message.text).toContain(`时间：${long}（${zone}）`)
      expect(message.html).toContain(`${long}（${zone}）`)
    }
  })

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

  it.each([
    {
      name: 'Ada Lovelace',
      event: 'Intro call',
      phrase: '与 Ada Lovelace 的 Intro call',
      attendeeIntro: '你与 Ada Lovelace 的会议',
      hostIntro: 'Ada Lovelace 预约了与你的会议。',
    },
    {
      name: '张三',
      event: '初次交流',
      phrase: '与张三的初次交流',
      attendeeIntro: '你与张三的会议',
      hostIntro: '张三预约了与你的会议。',
    },
    {
      name: 'Zoë',
      event: 'Échange',
      phrase: '与 Zoë 的 Échange',
      attendeeIntro: '你与 Zoë 的会议',
      hostIntro: 'Zoë 预约了与你的会议。',
    },
    {
      name: '李Ada',
      event: '初次Intro交流',
      phrase: '与李Ada 的初次Intro交流',
      attendeeIntro: '你与李Ada 的会议',
      hostIntro: '李Ada 预约了与你的会议。',
    },
  ])(
    'spaces Chinese email substitutions by script for $name and $event',
    ({ name, event, phrase, attendeeIntro, hostIntro }) => {
      for (const kind of [...kinds, 'reminder'] as const) {
        for (const role of roles) {
          const message = bookingEmail(
            kind,
            { ...meeting, hostName: name, inviteeName: name, eventName: event },
            { ...recipients[role], locale: 'zh-CN' },
          )
          expect(message.subject).toContain(phrase)
          expect(message.text).toContain(`活动：${event}`)
          expect(message.html).toContain(event)
          expect(message.text).toContain(
            role === 'host' && kind === 'confirmed' ? hostIntro : attendeeIntro,
          )
        }
      }
    },
  )

  it('describes retrying a failed meeting link as synchronizing again', () => {
    const message = bookingEmail('conference_failed', meeting, {
      ...recipients.host,
      locale: 'zh-CN',
    })
    expect(message.text).toContain('查看问题、重试同步或取消预约。')
    expect(message.html).toContain('查看问题、重试同步或取消预约。')
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
