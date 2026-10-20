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
const bookingUrl = 'https://cal.example.com/app/bookings/019a1234-5678-7000-8000-000000000001'

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
            { attachment: invitation(kind === 'cancelled' ? 'CANCEL' : 'REQUEST'), bookingUrl },
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

describe('booking email layout and action hierarchy', () => {
  const joinUrl = `https://teams.microsoft.com/l/meetup-join/${'a'.repeat(240)}?context=fixture&tenant=example`
  const longMeeting = {
    ...meeting,
    eventName: `Intro-${'unbroken'.repeat(50)}`,
    location: { kind: 'link', label: 'Microsoft Teams', url: joinUrl } as const,
  }

  for (const locale of languages) {
    for (const kind of [...kinds, 'reminder', 'conference_failed'] as const) {
      for (const role of roles) {
        it(`${locale} ${kind} ${role} keeps details readable and actions in order`, () => {
          const attachment = ['confirmed', 'rescheduled'].includes(kind)
            ? invitation('REQUEST')
            : kind === 'cancelled'
              ? invitation('CANCEL')
              : undefined
          const message = bookingEmail(
            kind,
            longMeeting,
            { ...recipients[role], locale },
            { attachment, bookingUrl },
          )
          const html = message.html ?? ''
          expect(html).toContain('<meta charset="utf-8">')
          expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"')
          expect(html).toContain('name="color-scheme" content="light"')
          expect(html).toContain('name="supported-color-schemes" content="light"')
          expect(html).toMatch(
            /<table[^>]+width="600"[^>]+align="center"[^>]+bgcolor="#ffffff"[^>]+max-width: 600px/,
          )
          expect(html).toContain(
            '-apple-system,&quot;Segoe UI&quot;,&quot;PingFang SC&quot;,&quot;Microsoft YaHei&quot;,Roboto,Helvetica,Arial,sans-serif',
          )
          expect(html).toContain('>Hourmere</p>')
          expect(message.text.startsWith('Hourmere\n\n')).toBe(true)
          expect(html).not.toMatch(/<(img|script|iframe)\b/i)
          const detailRows = [
            ...html.matchAll(
              /<tr><td style="([^"]*)">([^<]*)<\/td><td style="([^"]*)">([\s\S]*?)<\/td><\/tr>/g,
            ),
          ]
          expect(detailRows.length).toBeGreaterThanOrEqual(4)
          for (const row of detailRows) {
            expect(row[1]).toContain('white-space: nowrap;')
            expect(row[1]).toContain('width: 1%;')
            expect(row[3]).toContain('overflow-wrap: anywhere;')
            expect(row[3]).toContain('word-break: break-word;')
          }
          const details =
            html.match(/<table role="presentation" width="100%"[^>]*>([\s\S]*?)<\/table>/)?.[0] ??
            ''
          expect(details).toContain('width: 100%;')
          expect(details).toContain(longMeeting.eventName)
          expect(details).not.toContain(joinUrl)

          const openLabel = locale === 'en' ? 'Open in Hourmere' : '在 Hourmere 中打开'
          expect(html.includes(`>${openLabel}</a>`)).toBe(role === 'host')
          expect(message.text.includes(bookingUrl)).toBe(role === 'host')
          if (role === 'host') {
            expect(html).toContain(`href="${bookingUrl}"`)
          } else {
            expect(html).not.toContain(bookingUrl)
          }
          const joinLabel = locale === 'en' ? 'Join Teams meeting' : '加入 Teams 会议'
          if (kind === 'cancelled' || kind === 'conference_failed') {
            expect(html).not.toContain(joinUrl.replaceAll('&', '&amp;'))
            expect(message.text).not.toContain(joinUrl)
            expect(html).not.toContain(`>${joinLabel}</a>`)
          } else {
            expect(html.indexOf(`>${joinLabel}</a>`)).toBeGreaterThan(html.indexOf(details))
            expect(message.text.indexOf(`${joinLabel}\n${joinUrl}`)).toBeGreaterThan(
              message.text.indexOf(locale === 'en' ? 'Host:' : '主持人：') === -1
                ? message.text.indexOf(locale === 'en' ? 'Invitee:' : '预约人：')
                : message.text.indexOf(locale === 'en' ? 'Host:' : '主持人：'),
            )
            const urlParagraph = html.match(
              /<p style="([^"]*)"><a href="[^"]*" style="([^"]*)">https:\/\/teams\.microsoft\.com[^<]*<\/a><\/p>/,
            )
            expect(urlParagraph?.[1]).toContain('font-size: 13px;')
            expect(urlParagraph?.[1]).toContain('overflow-wrap: anywhere;')
            expect(urlParagraph?.[1]).toContain('word-break: break-word;')
            expect(urlParagraph?.[2]).toContain('color: #1f4fd8;')
          }
          if (role === 'invitee' && kind !== 'cancelled') {
            const actionLabel = locale === 'en' ? 'Need to make a change?' : '需要更改预约吗？'
            const fallbackLabel =
              locale === 'en'
                ? 'If the buttons do not work, copy a link into your browser:'
                : '如果按钮无法使用，请将链接复制到浏览器中：'
            expect(html.indexOf(actionLabel)).toBeGreaterThan(html.indexOf(details))
            expect(message.text.indexOf(actionLabel)).toBeGreaterThan(
              message.text.indexOf(locale === 'en' ? 'Host:' : '主持人：'),
            )
            if (kind !== 'conference_failed') {
              expect(html.indexOf(actionLabel)).toBeGreaterThan(html.indexOf(`>${joinLabel}</a>`))
              expect(message.text.indexOf(actionLabel)).toBeGreaterThan(
                message.text.indexOf(joinUrl),
              )
            }
            const fallback = [...html.matchAll(/<p style="([^"]*)">([^<]*)<br>/g)].find(
              (match) => match[2] === fallbackLabel,
            )
            expect(fallback?.[1]).toContain('overflow-wrap: anywhere;')
            expect(fallback?.[1]).toContain('word-break: break-word;')
            const cancelLabel = locale === 'en' ? 'Cancel' : '取消'
            const cancel = [
              ...html.matchAll(
                /<td bgcolor="([^"]*)" style="([^"]*)"><a href="([^"]*)" style="([^"]*)">([^<]*)<\/a>/g,
              ),
            ].find((match) => match[5] === cancelLabel)
            expect(cancel?.[1]).toBe('#ffffff')
            expect(cancel?.[2]).toContain('border: 1px solid #1f4fd8;')
            expect(cancel?.[2]).toContain('mso-padding-alt:')
            const padding = Number(cancel?.[4]?.match(/padding: (\d+)px/)?.[1] ?? 0)
            const lineHeight = Number(cancel?.[4]?.match(/line-height: (\d+)px/)?.[1] ?? 0)
            expect(padding * 2 + lineHeight).toBeGreaterThanOrEqual(44)
            if (attachment?.contentType.includes('method=REQUEST')) {
              const hint = calendarGuidance[locale].invitee
              expect(html.indexOf(hint)).toBeGreaterThan(html.indexOf(`>${cancelLabel}</a>`))
              expect(html.indexOf(hint)).toBeLessThan(html.indexOf(fallbackLabel))
              expect(message.text).toContain(
                `${locale === 'en' ? 'Reschedule / Cancel' : '改期 / 取消'}\n${hint}\n${fallbackLabel}`,
              )
            }
          } else {
            expect(html).not.toContain('token=')
            expect(message.text).not.toContain('token=')
          }
          if (kind === 'rescheduled') {
            const previous = detailRows.find(
              (row) => row[2] === (locale === 'en' ? 'Was' : '原时间'),
            )
            expect(previous?.[3]).toContain('color: #777;')
            expect(previous?.[3]).toContain('text-decoration: line-through;')
          }
          const reason =
            locale === 'en'
              ? 'You received this email about a booking with Grace Hopper via Hourmere.'
              : '你收到此邮件，是因为通过 Hourmere 与 Grace Hopper 预约了会议。'
          expect(html).toContain(reason)
          expect(message.text.endsWith(`${reason}\n`)).toBe(true)
          if (attachment) expect(message.attachments?.[0]).toBe(attachment)
        })
      }
    }
  }

  it.each([
    ['https://us02web.zoom.us/j/123?pwd=fixture', 'Join Zoom meeting', '加入 Zoom 会议'],
    ['https://meet.google.com/abc-defg-hij', 'Join Google Meet meeting', '加入 Google Meet 会议'],
    ['https://teams.microsoft.com/l/meetup-join/fixture', 'Join Teams meeting', '加入 Teams 会议'],
    ['https://video.example.com/meeting', 'Join meeting', '加入会议'],
  ])('uses a short provider action for %s', (url, english, chinese) => {
    for (const locale of languages) {
      const message = bookingEmail(
        'confirmed',
        { ...meeting, location: { kind: 'link', url } },
        { ...recipients.invitee, locale },
      )
      const label = locale === 'en' ? english : chinese
      expect(message.html).toContain(`>${label}</a>`)
      expect(message.text).toContain(`${label}\n${url}`)
    }
  })

  it('does not turn invalid meeting or admin URLs into actions', () => {
    const message = bookingEmail(
      'confirmed',
      {
        ...meeting,
        location: { kind: 'link', url: 'javascript:alert(1)', label: '<b>Unsafe</b>' },
      },
      recipients.host,
      { bookingUrl: 'javascript:alert(1)' },
    )
    expect(message.html).not.toContain('href=')
    expect(message.html).toContain('&lt;b&gt;Unsafe&lt;/b&gt;')
    expect(message.text).not.toContain('javascript:')
  })
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
              // The hint stays beside the action labels, after details and before raw URLs.
              expect(message.text).toContain(
                `${locale === 'en' ? 'Reschedule / Cancel' : '改期 / 取消'}\n${sentence}\n`,
              )
              expect(message.text.indexOf(sentence)).toBeGreaterThan(
                message.text.indexOf(locale === 'en' ? 'What:' : '活动：'),
              )
              expect(message.html?.indexOf(sentence.replaceAll("'", '&#39;'))).toBeGreaterThan(
                message.html?.indexOf('width="100%"') ?? -1,
              )
              expect(message.html).toContain(`</table>\n<p lang="${locale}"`)
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
