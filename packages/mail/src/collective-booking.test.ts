import { describe, expect, it } from 'vitest'
import {
  type BookingEmailMeeting,
  bookingEmail,
  bookingHostNames,
  followUpEmail,
} from './booking.ts'

const meeting: BookingEmailMeeting = {
  eventName: 'Global Sync',
  hostName: 'Liam LA',
  hostNames: ['Liam LA', 'Berta Berlin'],
  inviteeName: 'Ivy Invitee',
  inviteeEmail: 'ivy@example.test',
  inviteeTimeZone: 'Asia/Shanghai',
  start: Temporal.Instant.from('2026-11-03T17:00Z'),
  end: Temporal.Instant.from('2026-11-03T17:30Z'),
  location: null,
}
const attendee = {
  role: 'attendee' as const,
  email: meeting.inviteeEmail,
  timeZone: 'Asia/Shanghai',
}
const host = {
  role: 'host' as const,
  email: 'liam@example.test',
  timeZone: 'America/Los_Angeles',
  answers: [],
  coHostNames: ['Berta Berlin'],
}
const locales = [
  ['en', 'Liam LA and Berta Berlin', 'Co-hosts', '5 others'],
  ['zh-CN', 'Liam LA和Berta Berlin', '共同主持人', '其他 5 位主持人'],
  ['de', 'Liam LA und Berta Berlin', 'Weitere gastgebende Personen', '5 weitere Personen'],
  ['fr', 'Liam LA et Berta Berlin', 'Autres hôtes', '5 autres personnes'],
  ['es', 'Liam LA y Berta Berlin', 'Otros anfitriones', '5 personas más'],
  ['pt-BR', 'Liam LA e Berta Berlin', 'Outros anfitriões', 'mais 5 pessoas'],
] as const
const kinds = ['confirmed', 'rescheduled', 'cancelled', 'reminder'] as const

describe('collective booking mail', () => {
  it.each(locales)('%s names all required hosts in every invitee message', (locale, names) => {
    expect(bookingHostNames(meeting.hostNames ?? [], locale)).toBe(names)
    for (const kind of kinds) {
      const message = bookingEmail(kind, meeting, { ...attendee, locale })
      expect(message.subject).toContain(names)
      expect(message.text.split(names).length).toBeGreaterThanOrEqual(4)
      expect(message.html).toContain(names)
      expect(message.text).not.toContain('Co-hosts')
    }
    const followUp = followUpEmail(meeting, { ...attendee, locale })
    expect(followUp.text.split(names).length).toBeGreaterThanOrEqual(4)
  })

  it.each(locales)('%s lists co-host names only in host messages', (locale, _names, label) => {
    for (const kind of kinds) {
      const message = bookingEmail(kind, meeting, { ...host, locale })
      expect(message.text).toContain(
        `${label}${locale === 'zh-CN' ? '：' : locale === 'fr' ? '\u00a0: ' : ': '}Berta Berlin`,
      )
      expect(message.html).toContain(label)
      expect(message.html).toContain('Berta Berlin')
      expect(message.text).not.toContain('liam@example.test')
      expect(message.text).not.toContain('berta@example.test')
    }
    const followUp = followUpEmail(meeting, { ...host, locale })
    expect(followUp.text).toContain(
      `${label}${locale === 'zh-CN' ? '：' : locale === 'fr' ? '\u00a0: ' : ': '}Berta Berlin`,
    )
    expect(followUp.html).toContain(label)
  })

  it.each(locales)(
    '%s shortens long subject lists while retaining every name in bodies',
    (locale, _names, _label, more) => {
      const hostNames = Array.from({ length: 8 }, (_, index) => `Host ${index + 1}`)
      const message = bookingEmail('confirmed', { ...meeting, hostNames }, { ...attendee, locale })
      expect(message.subject).toContain(more)
      expect(message.subject).toContain('Host 1')
      expect(message.subject).toContain('Host 3')
      expect(message.subject).not.toContain('Host 4')
      for (const name of hostNames) expect(message.text).toContain(name)
      expect(message.subject.length).toBeLessThanOrEqual(200)
      const four = bookingEmail(
        'confirmed',
        { ...meeting, hostNames: hostNames.slice(0, 4) },
        { ...attendee, locale },
      )
      const oneMore = {
        en: '1 other',
        'zh-CN': '其他 1 位主持人',
        de: '1 weitere Person',
        fr: '1 autre personne',
        es: '1 persona más',
        'pt-BR': 'mais 1 pessoa',
      }[locale]
      expect(four.subject).toContain(oneMore)
      expect(bookingHostNames(hostNames.slice(0, 4), locale, true).endsWith(oneMore)).toBe(true)
      expect(four.text).toContain('Host 4')
    },
  )

  it.each(locales)(
    '%s preserves single-host and assigned round-robin output snapshots',
    (locale) => {
      const single = { ...meeting, hostNames: undefined }
      const recipient = { ...host, coHostNames: undefined, locale }
      const messages = kinds.flatMap((kind) => [
        bookingEmail(kind, single, { ...attendee, locale }),
        bookingEmail(kind, single, recipient),
      ])
      expect(messages.map(({ subject, text }) => ({ subject, text }))).toMatchSnapshot()
      for (const kind of kinds) {
        expect(
          bookingEmail(kind, { ...single, hostNames: [single.hostName] }, { ...attendee, locale }),
        ).toEqual(bookingEmail(kind, single, { ...attendee, locale }))
        expect(bookingEmail(kind, { ...single, hostNames: [single.hostName] }, recipient)).toEqual(
          bookingEmail(kind, single, recipient),
        )
      }
    },
  )

  it.each([
    ['en', 'Host'],
    ['zh-CN', '主持人'],
    ['de', 'Gastgebende Person'],
    ['fr', 'Hôte'],
    ['es', 'Anfitrión'],
    ['pt-BR', 'Anfitrião'],
  ])('%s localizes unavailable host labels without exposing an email', (locale, label) => {
    const unnamed = { ...meeting, hostNames: ['Liam LA', ''] }
    const invitee = bookingEmail('confirmed', unnamed, { ...attendee, locale })
    const hostMail = bookingEmail('confirmed', unnamed, { ...host, coHostNames: [''], locale })
    for (const message of [invitee, hostMail]) {
      expect(message.text).toContain(label)
      expect(message.html).toContain(label)
    }
    expect(bookingHostNames([''], locale)).toBe(label)
  })

  it('cleans every host name and escapes markup in the full and co-host lists', () => {
    const hostile = '<b>Berta</b>\r\nBcc: hidden@example.test'
    const message = bookingEmail(
      'confirmed',
      { ...meeting, hostNames: ['Liam', hostile] },
      { ...host, coHostNames: [hostile] },
    )
    expect(message.html).toContain('&lt;b&gt;Berta&lt;/b&gt;')
    expect(message.html).not.toContain('<b>')
    expect(message.text).not.toMatch(/^Bcc:/m)
  })
})
