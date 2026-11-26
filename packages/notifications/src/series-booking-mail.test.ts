import {
  createLogMailer,
  formatMeetingTime,
  icsAttachment,
  seriesBookingEmail,
  seriesMemberDescription,
} from '@hourmere/mail'
import { type MailKey, mailCatalogues, mailMessage } from '@hourmere/mail/catalogue'
import ICAL from 'ical.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerValues, rawMailCapture } from './testing/raw-mime.ts'

type Series = Parameters<typeof seriesBookingEmail>[1]
type Member = Series['members'][number]

const publicUrl = 'https://hourmere.example.test'
const booker = {
  role: 'booker',
  email: 'ada@attendees.example.test',
  timeZone: 'Europe/Berlin',
  token: ['booker', 'fixture', 'capability'].join('-'),
} as const
const guest = {
  role: 'guest',
  email: 'bea@attendees.example.test',
  timeZone: booker.timeZone,
  token: ['guest', 'fixture', 'capability'].join('-'),
} as const
const host = {
  role: 'host',
  email: 'mira@hosts.example.test',
  timeZone: 'America/New_York',
  locale: 'en',
  seriesUrl: `${publicUrl}/app/booking-series/fixture`,
} as const

const joinUrl = (number: number) =>
  `https://meet.example.test/occurrence-${String(number).padStart(2, '0')}`
const fixtureStart = Temporal.Instant.from('2026-10-22T15:00:00Z')
const members: Member[] = Array.from({ length: 12 }, (_, index) => {
  const start = fixtureStart.add({ hours: 168 * index })
  return {
    start,
    end: start.add({ minutes: 45 }),
    state: 'confirmed',
    conference: { state: 'ready', url: joinUrl(index + 1) },
  }
})

const series: Series = {
  publicUrl,
  locale: 'en',
  eventName: 'Studio hours',
  hostName: 'Mira',
  inviteeName: 'Ada',
  members: members.map((member, index): Member => {
    if (index === 1) return { ...member, conference: { state: 'pending' } }
    if (index === 2) return { ...member, conference: { state: 'failed' } }
    if (index === 3) return { ...member, state: 'updated_separately' }
    if (index === 4) return { ...member, state: 'started' }
    if (index === 5) return { ...member, state: 'cancelled' }
    if (index === 6) return { start: member.start, end: member.end, state: 'confirmed' }
    return member
  }),
}
const cancellation: Series = {
  ...series,
  cancelReason: 'The studio is closed for maintenance.',
  members: series.members.map((member, index) =>
    index >= 7 ? { ...member, state: 'cancelled', affected: true } : member,
  ),
}
const update: Series = {
  ...series,
  members: members.map((member, index) =>
    index === 11 ? { ...member, conference: { state: 'failed' } } : member,
  ),
}

const kindFixtures = [
  ['confirmed', series],
  ['cancelled', cancellation],
  ['link_update', update],
] as const

describe('recurring booking mail content', () => {
  it.each([
    ['confirmed', series, booker],
    ['cancelled', cancellation, guest],
    ['link_update', update, host],
  ] as const)('renders all 12 occurrences in the %s snapshot', (kind, fixture, recipient) => {
    const { subject, text, html } = seriesBookingEmail(kind, fixture, recipient)
    for (const { start, end } of fixture.members) {
      const when = formatMeetingTime(start, end, recipient.timeZone, 'en')
      expect(text).toContain(when)
      expect(html).toContain(when)
    }
    expect({ subject, text, html }).toMatchSnapshot()
  })

  it('shows confirmation markers and reserves repair instructions for hosts', () => {
    for (const recipient of [booker, guest, host]) {
      const { text, html } = seriesBookingEmail('confirmed', series, recipient)
      for (const content of [text, html]) {
        expect(content).toContain(joinUrl(1))
        for (const hidden of [2, 3, 4, 5, 6, 7]) expect(content).not.toContain(joinUrl(hidden))
        for (const label of [
          'Meeting link pending',
          'No automatic meeting link',
          'Updated separately',
          'Started',
          'Cancelled',
        ])
          expect(content).toContain(label)
        expect(content?.includes(mailMessage('en', 'series.repair'))).toBe(
          recipient.role === 'host',
        )
      }
    }
  })

  it('reports ready links to guests and also newly failed occurrences to bookers and hosts', () => {
    for (const recipient of [booker, guest, host]) {
      const { text, html } = seriesBookingEmail('link_update', series, recipient)
      for (const content of [text, html]) {
        expect(content).toContain(joinUrl(1))
        expect(content?.includes('No automatic meeting link')).toBe(recipient.role !== 'guest')
        for (const hidden of [2, 3, 4, 5, 6, 7]) expect(content).not.toContain(joinUrl(hidden))
        for (const label of ['Meeting link pending', 'Updated separately', 'Started', 'Cancelled'])
          expect(content).not.toContain(label)
      }
    }
  })

  it.each([
    ['en-GB', 'en'],
    ['zh-Hans', 'zh-CN'],
    ['de-AT', 'de'],
    ['fr-CA', 'fr'],
    ['es-MX', 'es'],
    ['pt', 'pt-BR'],
    ['pt-PT', 'en'],
  ] as const)('uses %s to select %s separately for attendees and hosts', (locale, language) => {
    const subjectKeys = {
      confirmed: 'series.confirmed.subject',
      cancelled: 'series.cancelled.subject',
      link_update: 'series.linkUpdate.subject',
    } as const
    for (const [kind, fixture] of kindFixtures) {
      const copies = [
        seriesBookingEmail(kind, { ...fixture, locale }, booker),
        seriesBookingEmail(kind, { ...fixture, locale }, guest),
        seriesBookingEmail(kind, { ...fixture, locale: 'en' }, { ...host, locale }),
      ]
      for (const { subject, html } of copies) {
        expect(subject).toBe(mailMessage(language, subjectKeys[kind], { event: series.eventName }))
        expect(html).toContain(`<html lang="${language}">`)
      }
    }
  })

  it('keeps the recurring booking keys grouped and translated in every booking-mail catalogue', () => {
    const english = Object.entries(mailCatalogues.en ?? {}).filter(([key]) =>
      key.startsWith('series.'),
    )
    expect(english.length).toBeGreaterThan(0)
    const seriesKeys = english.map(([key]) => key)
    for (const [locale, catalogue] of Object.entries(mailCatalogues)) {
      const keys = Object.keys(catalogue)
      const first = keys.findIndex((key) => key.startsWith('series.'))
      expect(first).toBeGreaterThanOrEqual(0)
      expect(keys.slice(first, first + seriesKeys.length)).toEqual(seriesKeys)
      if (locale === 'en') continue
      for (const [key, value] of english)
        expect(catalogue[key as MailKey], `${locale} ${key}`).not.toBe(value)
    }
  })

  it.each([1, 2])('localizes count %i in cancelled and link-update messages', (count) => {
    const subset = { ...update, members: update.members.slice(0, count) }
    const cancelledMembers = subset.members.map(
      (member): Member => ({ ...member, affected: true, state: 'cancelled' }),
    )
    for (const [kind, fixture, key] of [
      ['cancelled', { ...subset, members: cancelledMembers }, 'series.cancelled.body'],
      ['link_update', subset, 'series.linkUpdate.body'],
    ] as const) {
      for (const locale of ['en', 'zh-CN', 'de', 'fr', 'es', 'pt-BR'] as const) {
        const expected = mailMessage(locale, `${key}${count === 1 ? 'One' : 'Other'}`, {
          count: String(count),
        })
        const { text } = seriesBookingEmail(kind, { ...fixture, locale }, booker)
        expect(text).toContain(expected)
      }
    }
  })

  it('round-trips localized markers through the existing VEVENT description serializer', () => {
    for (const [member, label] of [
      [series.members[1], 'series.pending'],
      [series.members[2], 'series.failed'],
      [series.members[3], 'series.updatedSeparately'],
      [series.members[4], 'series.started'],
      [series.members[5], 'series.cancelled.member'],
    ] as const) {
      if (!member) throw new Error('missing fixture member')
      const file = icsAttachment({
        method: 'REQUEST',
        uid: 'description-fixture@hourmere.example.test',
        sequence: 0,
        stamp: fixtureStart,
        start: member.start,
        end: member.end,
        summary: series.eventName,
        description: seriesMemberDescription(member, 'zh-Hans'),
        organizer: { name: series.hostName, email: host.email },
        attendees: [],
      })
      const event = new ICAL.Component(ICAL.parse(file.content)).getFirstSubcomponent('vevent')
      expect(event?.getFirstPropertyValue('description')).toBe(mailMessage('zh-CN', label))
    }
  })

  it('redacts series capabilities and their URLs from the development mail log', async () => {
    const logs: string[] = []
    const mailer = createLogMailer((line) => logs.push(line))
    for (const [kind, fixture] of kindFixtures) {
      for (const recipient of [booker, guest]) {
        const message = seriesBookingEmail(kind, fixture, recipient)
        expect(message.text).toContain(`${publicUrl}/series/manage#${recipient.token}`)
        await mailer.send(message)
      }
    }
    expect(logs).toHaveLength(6)
    for (const line of logs) {
      expect(line).not.toContain(booker.token)
      expect(line).not.toContain(guest.token)
      expect(line).not.toContain(`${publicUrl}/series/manage#`)
    }
  })
})

describe('recurring booking mail on the SMTP wire', () => {
  let capture: Awaited<ReturnType<typeof rawMailCapture>>
  beforeAll(async () => {
    capture = await rawMailCapture('hourmere@sender.example.test')
  })
  afterAll(async () => {
    await capture?.close()
  })

  it.each(kindFixtures)('sends a read-only %s copy to the guest', async (kind, fixture) => {
    await capture.mailer.send(seriesBookingEmail(kind, fixture, guest))
    const message = capture.sent.at(-1)
    if (!message) throw new Error('no guest message was captured')
    const guestUrl = `${publicUrl}/series/manage#${guest.token}`
    expect(message.envelope).toEqual([guest.email])
    expect(message.decoded).toContain(`href="${guestUrl}"`)
    expect(message.decoded).toContain(mailMessage('en', 'series.view'))
    for (const privateValue of [
      booker.email,
      booker.token,
      host.email,
      host.seriesUrl,
      mailMessage('en', 'series.manage'),
      mailMessage('en', 'series.repair'),
    ])
      expect(message.decoded).not.toContain(privateValue)
    expect(message.decoded).not.toMatch(/(?:action=|\/booking#|\/conference\/retry)/)
  })

  it('normalizes hostile headers and escapes interpolated values in the HTML alternative', async () => {
    const maliciousLink = 'https://meet.example.test/room?name="<tag>"&mode=join'
    const hostileLinks = [
      maliciousLink,
      'javascript:alert("bad")',
      'https://meet.example.test/\r\nbad',
    ]
    const hostile: Series = {
      ...series,
      eventName: 'Meet <event>\r\nBcc: injected@example.test & {host}',
      hostName: 'Mira <host>\r\nBcc: host-injected@example.test',
      inviteeName: 'Ada <booker>\r\nBcc: booker-injected@example.test',
      members: hostileLinks.map((url) => ({
        start: fixtureStart,
        end: fixtureStart.add({ minutes: 45 }),
        state: 'confirmed',
        conference: { state: 'ready', url },
      })),
    }
    const rendered = seriesBookingEmail('confirmed', hostile, guest)
    expect(rendered.subject).not.toMatch(/[\r\n]/)
    expect(rendered.text).toContain('Meet <event> Bcc: injected@example.test & {host}')
    expect(rendered.text).toContain('Mira <host> Bcc: host-injected@example.test')
    expect(rendered.text).toContain('Ada <booker> Bcc: booker-injected@example.test')
    expect(rendered.text).toContain(maliciousLink)
    expect(rendered.text).not.toContain('javascript:')
    expect(rendered.text).not.toContain('meet.example.test/bad')
    await capture.mailer.send(rendered)
    const message = capture.sent.at(-1)
    if (!message) throw new Error('no hostile fixture message was captured')
    expect(headerValues(message, 'Bcc')).toEqual([])
    expect(message.envelope).toEqual([guest.email])
    expect(message.decoded).toContain('&lt;event&gt;')
    expect(message.decoded).toContain('&lt;host&gt;')
    expect(message.decoded).toContain('&lt;booker&gt;')
    expect(message.decoded).toContain(
      'href="https://meet.example.test/room?name=&quot;&lt;tag&gt;&quot;&amp;mode=join"',
    )
    expect(rendered.html).not.toMatch(/<(?:event|host|booker|tag)>|javascript:/)
  })

  it('escapes multiline cancellation reasons in the HTML copy', () => {
    const { text, html } = seriesBookingEmail(
      'cancelled',
      { ...cancellation, cancelReason: 'The room is closed\r\n<img src="unsafe"> & {event}' },
      booker,
    )
    expect(text).toContain('The room is closed')
    expect(text).toContain('<img src="unsafe"> & {event}')
    expect(text).not.toContain('\r')
    expect(html).toContain('&lt;img src=&quot;unsafe&quot;&gt; &amp; {event}')
    expect(html).not.toContain('<img')
  })
})
