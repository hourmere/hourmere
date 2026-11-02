import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { mailCatalogueProblems, mailCatalogues } from './catalogue.ts'
import { createLogMailer, type MailMessage } from './index.ts'
import { waitlistNotificationEmail, waitlistVerificationEmail } from './waitlist.ts'

// Deliberately synthetic, fixed capabilities; never use live credentials in test output.
const token = `019a278e-3ff2-7a91-8fe0-1846a52d0b22.${'v'.repeat(43)}`
const removalToken = `019a278e-3ff2-7a91-8fe0-1846a52d0b22.${'m'.repeat(43)}`
const options = {
  to: 'waiting@example.test',
  publicUrl: 'https://calendar.example.test',
  eventTitle: 'Intro call',
  token,
  removalToken,
  expiresAt: '2026-10-31T16:30:00.000Z',
}
const notification = {
  ...options,
  token: removalToken,
  bookingPath: '/ada/intro',
  timeZone: 'America/Los_Angeles',
  slots: [
    { start: '2026-11-01T08:30:00.000Z', end: '2026-11-01T08:45:00.000Z' },
    { start: '2026-11-01T09:30:00.000Z', end: '2026-11-01T09:45:00.000Z' },
  ],
}
const removeUrl = `${options.publicUrl}/waitlist/remove#${removalToken}`
const verifyUrl = `${options.publicUrl}/waitlist/verify#token=${token}&management=${removalToken}`

function visibleText(html: string): string {
  return html
    .replace(/<head>[\s\S]*?<\/head>/i, '')
    .replace(/<\/?span\b[^>]*>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
function equivalent(message: MailMessage) {
  expect(normalize(visibleText(message.html ?? ''))).toBe(normalize(message.text))
}
function links(message: MailMessage): string[] {
  return [...(message.html ?? '').matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) =>
    (match[1] ?? '').replaceAll('&amp;', '&'),
  )
}

const expected = {
  en: {
    verify: 'Confirm your waitlist request: Intro call',
    notice: 'Suggested times for Intro call',
    broadcast: 'Nothing is reserved; the first successful booking wins.',
    waiting: 'you stay on the waitlist until your original deadline',
  },
  'zh-CN': {
    verify: '确认候补申请：Intro call',
    notice: '候补时段建议：Intro call',
    broadcast: '不会为任何人保留；以最先成功完成的预约为准。',
    waiting: '你仍会留在候补名单中，直到最初的到期时间',
  },
  de: {
    verify: 'Wartelistenanfrage bestätigen: Intro call',
    notice: 'Terminvorschläge für Intro call',
    broadcast:
      'Es wird nichts reserviert; die erste erfolgreich abgeschlossene Buchung erhält den Termin.',
    waiting: 'bleiben Sie bis zum ursprünglichen Ablaufdatum auf der Warteliste',
  },
  fr: {
    verify: 'Confirmez votre demande de liste d’attente\u00a0: Intro call',
    notice: 'Créneaux proposés pour Intro call',
    broadcast:
      'Aucun créneau n’est réservé\u00a0; la première réservation réussie obtient le créneau.',
    waiting: 'vous restez sur la liste d’attente jusqu’à l’échéance initiale',
  },
  es: {
    verify: 'Confirme su solicitud de lista de espera: Intro call',
    notice: 'Horarios sugeridos para Intro call',
    broadcast:
      'No se reserva ningún horario; lo obtiene la primera reserva completada correctamente.',
    waiting: 'seguirá en la lista de espera hasta la fecha de vencimiento original',
  },
  'pt-BR': {
    verify: 'Confirme sua solicitação de lista de espera: Intro call',
    notice: 'Horários sugeridos para Intro call',
    broadcast:
      'Nenhum horário fica reservado; a primeira reserva concluída com sucesso fica com o horário.',
    waiting: 'você continuará na lista de espera até o prazo original',
  },
}

type Renderers = {
  verify: typeof waitlistVerificationEmail
  notice: typeof waitlistNotificationEmail
}
const production = { verify: waitlistVerificationEmail, notice: waitlistNotificationEmail }
type Replacement = readonly [string, string]

/** Evaluate an isolated source copy, leaving the production module and its cache intact. */
async function rendererCopy(replacements: Replacement[] = []): Promise<Renderers> {
  const url = new URL('./waitlist.ts', import.meta.url)
  let source = readFileSync(url, 'utf8')
  for (const replacement of replacements) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
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
  return new Function(
    ...Object.keys(dependencies),
    `${source}; return { verify: waitlistVerificationEmail, notice: waitlistNotificationEmail }`,
  )(...Object.values(dependencies)) as Renderers
}

function verifyLinks(render = production) {
  const verification = render.verify(options)
  expect(links(verification)).toEqual([verifyUrl, removeUrl])
  expect(verification.text.match(/https?:\/\/\S+/g)).toEqual([verifyUrl, removeUrl])
  const notice = render.notice(notification)
  const expectedLinks = notification.slots.map(
    (slot) =>
      `${options.publicUrl}/ada/intro/waitlist/${removalToken}/${encodeURIComponent(slot.start)}/${new Date(notification.expiresAt).getTime()}`,
  )
  expectedLinks.push(`${options.publicUrl}/ada/intro`, removeUrl)
  expect(links(notice)).toEqual(expectedLinks)
  expect(notice.text.match(/https?:\/\/\S+/g)).toEqual(expectedLinks)
  for (const message of [verification, notice]) {
    for (const link of links(message)) expect(new URL(link).search).toBe('')
    equivalent(message)
  }
}

function verifyOrigin(render = production) {
  for (const publicUrl of [
    'https://calendar.example.test/private',
    'https://calendar.example.test?token=private',
    'https://calendar.example.test#private',
    'https://user:password@calendar.example.test',
    'javascript:alert(1)',
    'https://calendar.example.test\n',
  ]) {
    for (const send of [
      () => render.verify({ ...options, publicUrl }),
      () => render.notice({ ...notification, publicUrl }),
    ]) {
      expect(send).toThrow('Invalid waitlist instance origin')
    }
  }
}

function verifyCapabilities(render = production) {
  for (const value of ['private?token=fixture', `${token}&query=fixture`, '', `${token}\n`]) {
    expect(() => render.verify({ ...options, token: value })).toThrow('Invalid waitlist capability')
    expect(() => render.verify({ ...options, removalToken: value })).toThrow(
      'Invalid waitlist capability',
    )
    expect(() => render.notice({ ...notification, token: value })).toThrow(
      'Invalid waitlist capability',
    )
  }
}

function verifyBookingPath(render = production) {
  for (const bookingPath of [
    '//outside.example.test/intro',
    '/ada/intro?token=fixture',
    '/ada/intro#fixture',
    '/ada/../intro',
    '/ada/%2fintro',
  ]) {
    expect(() => render.notice({ ...notification, bookingPath })).toThrow(
      'Invalid waitlist booking path',
    )
  }
}

function verifyEscaping(render = production) {
  for (const message of [
    render.verify({
      ...options,
      eventTitle: '<script>“Read” & book</script>\r\nBcc: person@example.test\ud800',
    }),
    render.notice({
      ...notification,
      eventTitle: '<script>“Read” & book</script>\r\nBcc: person@example.test\ud800',
    }),
  ]) {
    expect(message.subject).not.toMatch(/[\r\n]/)
    expect(message.html).not.toContain('<script>')
    expect(message.html).toContain(
      '&lt;script&gt;“Read” &amp; book&lt;/script&gt; Bcc: person@example.test�',
    )
    expect(message.text).toContain('<script>“Read” & book</script> Bcc: person@example.test�')
    equivalent(message)
  }
}

function verifySuggestionBound(render = production) {
  expect(() => render.notice({ ...notification, slots: [] })).toThrow(
    'Invalid waitlist suggestions',
  )
  expect(() =>
    render.notice({ ...notification, slots: [...notification.slots, ...notification.slots] }),
  ).toThrow('Invalid waitlist suggestions')
}

function verifySafeErrors(render = production) {
  const cases: [() => unknown, string][] = [
    [
      () => render.notice({ ...notification, timeZone: 'private-zone' }),
      'Invalid waitlist display time zone',
    ],
    [() => render.verify({ ...options, expiresAt: 'private-time' }), 'Invalid waitlist time'],
    [
      () => render.verify({ ...options, to: 'private@example.test\r\nBcc: other@example.test' }),
      'Invalid waitlist recipient',
    ],
  ]
  for (const [invoke, expected] of cases) {
    let caught: unknown
    try {
      invoke()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(expected)
  }
}

function verifyIntervals(render = production) {
  const first = notification.slots[0] as { start: string; end: string }
  for (const slots of [
    [first, first],
    [{ start: first.end, end: first.start }],
    [{ start: first.start, end: first.start }],
  ]) {
    expect(() => render.notice({ ...notification, slots })).toThrow('Invalid waitlist suggestions')
  }
}

function verifyDst(render = production) {
  const la = render.notice(notification)
  for (const body of [la.text, visibleText(la.html ?? '')]) {
    expect(body).toContain('GMT-07:00')
    expect(body).toContain('GMT-08:00')
    expect(body).toContain('America/Los Angeles')
    expect(body).toContain('1:30 AM')
  }
  const berlin = render.notice({
    ...notification,
    timeZone: 'Europe/Berlin',
    slots: [
      { start: '2026-10-25T00:30:00Z', end: '2026-10-25T00:45:00Z' },
      { start: '2026-10-25T01:30:00Z', end: '2026-10-25T01:45:00Z' },
    ],
  })
  for (const body of [berlin.text, visibleText(berlin.html ?? '')]) {
    expect(body).toContain('GMT+02:00')
    expect(body).toContain('GMT+01:00')
    expect(body).toContain('Europe/Berlin')
    expect(body).toContain('2:30 AM')
  }
}

async function verifyLogRedaction(render = production) {
  const lines: string[] = []
  const mailer = createLogMailer((line) => lines.push(line))
  await mailer.send(render.verify(options))
  await mailer.send(render.notice(notification))
  expect(lines).toHaveLength(2)
  expect(
    lines.every((line) => !/waiting@example|Intro call|https:|waitlist|v{43}|m{43}/.test(line)),
  ).toBe(true)
}

describe('waitlist email templates', () => {
  it.each(registeredLocales)(
    'renders complete, equivalent $code verification and suggestion emails',
    ({ code }) => {
      const copy = expected[code]
      const verification = waitlistVerificationEmail({ ...options, language: code })
      const notice = waitlistNotificationEmail({ ...notification, language: code })
      expect(verification.subject).toBe(copy.verify)
      expect(notice.subject).toBe(copy.notice)
      for (const message of [verification, notice]) {
        expect(message.to).toBe(options.to)
        expect(message.sensitive).toBe(true)
        expect(message.html).toContain(`<html lang="${code}">`)
        expect(message.html).toContain('max-width: 600px')
        expect(normalize(message.text)).toContain(normalize(copy.broadcast))
        expect(message.attachments).toBeUndefined()
        expect(links(message)).toContain(removeUrl)
        equivalent(message)
        if (code !== 'en') {
          expect(message.text).not.toMatch(
            /Nothing is reserved|You received this email|Open the link|Suggested times|To leave the waitlist/,
          )
        }
      }
      expect(notice.text).toContain(copy.waiting)
      expect(verification.text).toContain('2026-10-31 16:30:00 UTC')
      expect(verification.text).toContain('30')
    },
  )

  it('keeps every waitlist catalogue key complete and placeholder-compatible', () => {
    for (const { code } of registeredLocales) {
      const catalogue = mailCatalogues[code] ?? {}
      for (const key of Object.keys(mailCatalogues.en ?? {}).filter((key) =>
        key.startsWith('waitlist.'),
      )) {
        const value = catalogue[key as keyof typeof catalogue]
        expect(value).toBeTypeOf('string')
        if (code !== 'en' && key !== 'waitlist.slot')
          expect(value).not.toBe(mailCatalogues.en?.[key as keyof typeof catalogue])
      }
      expect(mailCatalogueProblems(catalogue)).toEqual([])
    }
  })

  it('uses only path booking tokens and independent fragment confirmation capabilities', () =>
    verifyLinks())
  it('refuses request-controlled origins without echoing private inputs', () => verifyOrigin())
  it('refuses malformed capabilities rather than allowing query or fragment injection', () =>
    verifyCapabilities())
  it('accepts only ordinary relative personal or team booking paths', () => {
    verifyBookingPath()
    const team = waitlistNotificationEmail({
      ...notification,
      bookingPath: '/team/Research-Team/intro',
    })
    expect(links(team).every((url) => !url.includes('/ada/intro'))).toBe(true)
    expect(links(team)[0]).toContain('/team/Research-Team/intro/waitlist/')
  })
  it('escapes names, keeps headers single-line and repairs malformed Unicode', () =>
    verifyEscaping())
  it('requires one to three suggestions', () => verifySuggestionBound())
  it('rejects duplicate and non-positive intervals', () => verifyIntervals())
  it('sorts exact suggestions without manufacturing extra DST occurrences', () => {
    expect(
      waitlistNotificationEmail({ ...notification, slots: [...notification.slots].reverse() }),
    ).toEqual(waitlistNotificationEmail(notification))
    expect(
      links(waitlistNotificationEmail(notification)).filter((url) => url.includes('/waitlist/')),
    ).toHaveLength(3)
  })
  it('renders both offsets of repeated LA/Berlin local times without changing UTC links', () =>
    verifyDst())
  it.each([
    {
      timeZone: 'America/Los_Angeles',
      start: '2026-03-08T09:45:00Z',
      end: '2026-03-08T10:15:00Z',
      labels: ['1:45 AM', '3:15 AM'],
      offsets: ['GMT-08:00', 'GMT-07:00'],
    },
    {
      timeZone: 'Europe/Berlin',
      start: '2026-03-29T00:45:00Z',
      end: '2026-03-29T01:15:00Z',
      labels: ['1:45 AM', '3:15 AM'],
      offsets: ['GMT+01:00', 'GMT+02:00'],
    },
    {
      timeZone: 'America/Los_Angeles',
      start: '2026-11-01T08:45:00Z',
      end: '2026-11-01T09:15:00Z',
      labels: ['1:45 AM', '1:15 AM'],
      offsets: ['GMT-07:00', 'GMT-08:00'],
    },
    {
      timeZone: 'Europe/Berlin',
      start: '2026-10-25T00:45:00Z',
      end: '2026-10-25T01:15:00Z',
      labels: ['2:45 AM', '2:15 AM'],
      offsets: ['GMT+02:00', 'GMT+01:00'],
    },
  ])(
    'disambiguates both endpoints across the $timeZone transition at $start',
    ({ timeZone, start, end, labels, offsets }) => {
      const message = waitlistNotificationEmail({
        ...notification,
        timeZone,
        slots: [{ start, end }],
      })
      for (const label of [...labels, ...offsets]) expect(message.text).toContain(label)
      equivalent(message)
    },
  )
  it.each(registeredLocales)('keeps DST offsets explicit in $code', ({ code }) => {
    for (const timeZone of ['America/Los_Angeles', 'Europe/Berlin']) {
      const message = waitlistNotificationEmail({ ...notification, language: code, timeZone })
      expect(message.text).toContain(timeZone.replaceAll('_', ' '))
      expect(message.text).toMatch(/GMT[+-]\d\d:\d\d/)
      equivalent(message)
    }
  })
  it('fails closed on invalid display zones, times and recipients with fixed safe errors', () =>
    verifySafeErrors())
  it('uses registered language fallback and safe default meeting names', () => {
    for (const language of [undefined, null, 'pt-PT', 'zh-TW', 'qaa'])
      expect(waitlistVerificationEmail({ ...options, language })).toEqual(
        waitlistVerificationEmail(options),
      )
    expect(waitlistVerificationEmail({ ...options, language: 'de-CH' })).toEqual(
      waitlistVerificationEmail({ ...options, language: 'de' }),
    )
    expect(
      waitlistVerificationEmail({ ...options, language: 'qaa', defaultLanguage: 'zh-CN' }),
    ).toEqual(waitlistVerificationEmail({ ...options, language: 'zh-CN' }))
    expect(waitlistVerificationEmail({ ...options, eventTitle: '\r\n\u0000' }).subject).toBe(
      'Confirm your waitlist request: Your meeting',
    )
    expect(waitlistVerificationEmail({ ...options, publicUrl: `${options.publicUrl}/` })).toEqual(
      waitlistVerificationEmail(options),
    )
  })
  it('redacts recipients, tokens, links and event names from the development mail log', () =>
    verifyLogRedaction())
  it('passes the same assertions for an unchanged isolated source copy', async () => {
    const render = await rendererCopy()
    verifyLinks(render)
    verifyOrigin(render)
    verifyCapabilities(render)
    verifyBookingPath(render)
    verifyEscaping(render)
    verifySuggestionBound(render)
    verifyIntervals(render)
    verifyDst(render)
    verifySafeErrors(render)
    await verifyLogRedaction(render)
  })
  it.each<[string, Replacement, (render: Renderers) => void | Promise<void>]>([
    ['private mail log redaction', ['sensitive: true,', 'sensitive: false,'], verifyLogRedaction],
    [
      'path-only booking capabilities',
      [
        `\${options.bookingPath}/waitlist/\${token}/\${encodeURIComponent(start)}`,
        `\${options.bookingPath}?token=\${token}&start=\${encodeURIComponent(start)}`,
      ],
      verifyLinks,
    ],
    [
      'fragment-only verification capability',
      ['/waitlist/verify#token=', '/waitlist/verify?token='],
      verifyLinks,
    ],
    [
      'independent self-removal link',
      ["{ text: t('waitlist.remove'), url: removeUrl },", "{ text: t('waitlist.remove') },"],
      verifyLinks,
    ],
    [
      'trusted origin validation',
      [
        `!['http:', 'https:'].includes(url.protocol) ||\n      (value !== url.origin && value !== \`\${url.origin}/\`)`,
        'false',
      ],
      verifyOrigin,
    ],
    [
      'capability validation',
      ['if (!/^[a-f\\d-]{36}\\.[A-Za-z0-9_-]{43}$/.test(value))', 'if (false)'],
      verifyCapabilities,
    ],
    [
      'ordinary booking path validation',
      [
        'if (!/^\\/(?:[A-Za-z0-9-]+\\/|team\\/[A-Za-z0-9-]+\\/)[a-z0-9-]+$/.test(options.bookingPath))',
        'if (false)',
      ],
      verifyBookingPath,
    ],
    [
      'user-text HTML escaping',
      [`\${emailText(part.text, language)}`, `\${part.text}`],
      verifyEscaping,
    ],
    [
      'user-text normalization',
      ['singleLine(options.eventTitle.toWellFormed())', 'options.eventTitle'],
      verifyEscaping,
    ],
    [
      'safe invalid-time errors',
      [
        "throw new Error('Invalid waitlist time')",
        "throw new Error('Invalid waitlist time: ' + value)",
      ],
      verifySafeErrors,
    ],
    [
      'suggestion count bound',
      ['if (options.slots.length < 1 || options.slots.length > 3)', 'if (false)'],
      verifySuggestionBound,
    ],
    [
      'positive intervals',
      ['Temporal.Instant.compare(slot.start, slot.end) >= 0', 'false'],
      verifyIntervals,
    ],
    ['duplicate suggestion rejection', ['identities.has(identity)', 'false'], verifyIntervals],
    [
      'date-specific display zones',
      [
        'displayTime(slot.start, options.timeZone, language)',
        "displayTime(slot.start, 'UTC', language)",
      ],
      verifyDst,
    ],
  ])(
    'detects removal of %s through a real assertion failure',
    async (_name, replacement, verify) => {
      const render = await rendererCopy([replacement])
      await expect(Promise.resolve().then(() => verify(render))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
