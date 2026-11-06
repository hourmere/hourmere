import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { rescheduleRequestEmail } from './booking.ts'
import { mailCatalogueProblems, mailCatalogues } from './catalogue.ts'

const time = Temporal.Instant.from('2026-11-03T09:00Z')
const meeting = {
  eventName: 'Intro',
  hostName: 'Grace',
  inviteeName: 'Ada',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Berlin',
  start: time,
  end: time.add({ minutes: 30 }),
  location: null,
}
const recipient = {
  role: 'attendee' as const,
  email: meeting.inviteeEmail,
  timeZone: 'Europe/Berlin',
  manageLinks: {
    reschedule: 'https://example.test/booking#token=private&action=reschedule',
    cancel: 'https://example.test/booking#token=private&action=cancel',
  },
}

describe('reschedule request emails', () => {
  const verify = (render: typeof rescheduleRequestEmail) => {
    const rendered = render(meeting, recipient, {
      expiresAt: time,
      hostNote: `Private <script>note</script>\r\nBcc: victim@example.test\u202e${'x'.repeat(2100)}SUFFIX`,
    })
    expect(rendered.subject).not.toMatch(/Private|Bcc|victim/)
    expect(rendered.html).not.toContain('<script>')
    expect(rendered.text).not.toContain('SUFFIX')
    expect(rendered.text).not.toContain('\u202e')
    expect(rendered.sensitive).toBe(true)
    const expired = render(meeting, recipient, {
      expiresAt: time,
      expired: true,
      hostNote: 'Private note',
    })
    expect(expired.text).not.toMatch(/Private note|token=/)
  }
  it('checks note protections on the real renderer', () => verify(rescheduleRequestEmail))
  it.each<[string, string, string]>([
    [
      'note header separation',
      "subject: t(expired ? 'rescheduleRequest.expiredSubject' : 'rescheduleRequest.subject', {",
      "subject: (options.hostNote ?? '') + t(expired ? 'rescheduleRequest.expiredSubject' : 'rescheduleRequest.subject', {",
    ],
    [
      'note length bound',
      "normalizeFollowUpHostNote(options.hostNote ?? '')",
      "options.hostNote ?? ''",
    ],
    ['note HTML escaping', `\${htmlLines(c.hostNote.text, c.language)}`, `\${c.hostNote.text}`],
    ['expired note omission', 'hostNote: !expired && note ?', 'hostNote: note ?'],
    [
      'expired capability omission',
      "manageLinks: !expired && recipient.role === 'attendee'",
      "manageLinks: recipient.role === 'attendee'",
    ],
    [
      'sensitive log marker',
      '...render(recipient.email, content), sensitive: true',
      '...render(recipient.email, content), sensitive: false',
    ],
  ])('detects removal of %s with a source-copy assertion', async (_name, before, after) => {
    const render = (await sourceCopy(
      new URL('./booking.ts', import.meta.url),
      'rescheduleRequestEmail',
      [[before, after]],
    )) as typeof rescheduleRequestEmail
    expect(() => verify(render)).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })

  it.each(registeredLocales)('localizes request and expiry in $code', ({ code }) => {
    const request = rescheduleRequestEmail(
      meeting,
      { ...recipient, locale: code },
      {
        expiresAt: time,
        hostNote: 'Private <script>note</script>\r\nBcc: victim@example.test\u202e',
      },
    )
    expect(request.subject).not.toMatch(/Private|Bcc|victim|\r|\n/)
    expect(request.text).toContain('Private <script>note</script>\nBcc: victim@example.test')
    expect(request.html).toContain('&lt;script&gt;note&lt;/script&gt;')
    expect(request.html).not.toContain('<script>')
    expect(request.text).not.toContain('\u202e')
    expect(request.text).toContain(recipient.manageLinks.reschedule)
    expect(request.text).toContain(recipient.manageLinks.cancel)
    expect(request.attachments).toBeUndefined()
    expect(request.sensitive).toBe(true)
    const expiry = rescheduleRequestEmail(
      meeting,
      {
        role: 'host',
        email: 'grace@example.test',
        timeZone: 'Europe/Berlin',
        answers: [],
        locale: code,
      },
      {
        expiresAt: time,
        expired: true,
        hostNote: 'Private note',
        bookingUrl: 'https://example.test/app/bookings/1',
      },
    )
    expect(expiry.text).not.toMatch(/Private note|token=/)
    expect(expiry.text).toContain('https://example.test/app/bookings/1')
    const catalogue = mailCatalogues[code] ?? {}
    expect(mailCatalogueProblems(catalogue)).toEqual([])
    for (const key of [
      'rescheduleRequest.subject',
      'rescheduleRequest.introduction',
      'rescheduleRequest.expiredSubject',
      'rescheduleRequest.expiredIntroduction',
    ] as const) {
      expect(catalogue[key]).toBeTypeOf('string')
      if (code !== 'en') expect(catalogue[key]).not.toBe(mailCatalogues.en?.[key])
    }
  })
})

async function sourceCopy(url: URL, exported: string, replacements: [string, string][]) {
  let source = readFileSync(url, 'utf8')
  for (const [before, after] of replacements) {
    expect(source.includes(before)).toBe(true)
    source = source.replaceAll(before, after)
  }
  source = stripTypeScriptTypes(source)
  const dependencies: Record<string, unknown> = {}
  for (const item of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  source = source.replace(/\bexport /g, '')
  return new Function(...Object.keys(dependencies), `${source}; return ${exported}`)(
    ...Object.values(dependencies),
  )
}
