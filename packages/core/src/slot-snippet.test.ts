import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { interfaceLanguage } from './language.ts'
import { type InterfaceLanguage, localeRegistry } from './locales.ts'
import { isPublicTeamSlug, isReservedName } from './reserved.ts'
import {
  buildSlotSnippetBookingUrl,
  buildSlotSnippetLink,
  formatSlotLabel,
  formatSlotSnippet,
  resolveSnippetLocale,
  resolveSnippetTimeZone,
  type SlotSnippet,
  type SlotSnippetInput,
  snippetTimeZone,
} from './slot-snippet.ts'

const BASE: SlotSnippetInput = {
  publicUrl: 'https://hourmere.example.com',
  address: { kind: 'personal', handle: 'ada', slug: 'intro-call' },
  title: 'Intro call',
  durationMinutes: 30,
  starts: ['2027-06-15T14:30:00.000Z'],
  locale: 'en',
  displayTimeZone: 'UTC',
}

/** Stable shared renderer contract for the later REST, MCP and CLI implementation. */
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/slot-snippet.json', import.meta.url), 'utf8'),
) as { input: SlotSnippetInput; expected: SlotSnippet }[]

type Renderer = typeof formatSlotSnippet
type Replacement = readonly [string, string]

function sourceCopy(replacements: readonly Replacement[] = []): Renderer {
  let source = readFileSync(new URL('./slot-snippet.ts', import.meta.url), 'utf8')
  for (const replacement of replacements) {
    expect(source.includes(replacement[0]), 'source-copy replacement must match').toBe(true)
    source = source.replace(...replacement)
  }
  source = source.replace(/^import .*\n/gm, '')
  return new Function(
    'interfaceLanguage',
    'localeRegistry',
    'isPublicTeamSlug',
    'isReservedName',
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return formatSlotSnippet`,
  )(interfaceLanguage, localeRegistry, isPublicTeamSlug, isReservedName) as Renderer
}

function verifyCount(format: Renderer) {
  expect(() => format({ ...BASE, starts: [] })).toThrow('invalid_slots')
  expect(() =>
    format({
      ...BASE,
      starts: Array.from(
        { length: 11 },
        (_, i) => `2027-06-15T${String(i).padStart(2, '0')}:00:00Z`,
      ),
    }),
  ).toThrow('invalid_slots')
}

function verifyDuplicates(format: Renderer) {
  expect(() =>
    format({ ...BASE, starts: ['2027-06-15T14:30:00Z', '2027-06-15T16:30:00+02:00'] }),
  ).toThrow('invalid_slots')
}

function verifyOrder(format: Renderer) {
  expect(
    format({ ...BASE, starts: ['2027-06-16T14:30:00Z', '2027-06-15T14:30:00Z'] }).slots.map(
      (slot) => slot.start,
    ),
  ).toEqual(['2027-06-15T14:30:00.000Z', '2027-06-16T14:30:00.000Z'])
}

function verifyEscaping(format: Renderer) {
  const result = format({ ...BASE, title: `A <img src=x onerror=alert(1)> & "quoted" 'value'` })
  const document = new JSDOM(result.html).window.document
  expect(document.querySelectorAll('img,script,style,iframe,form,[onerror]')).toHaveLength(0)
  expect(document.querySelector('p')?.textContent).toContain(`<img src=x onerror=alert(1)>`)
  expect(result.html).toContain('&amp;durationMinutes=30')
  expect(result.html).toContain('&quot;quoted&quot; &#39;value&#39;')
  expect(document.querySelector('a')?.getAttribute('href')).toBe(result.slots[0]?.url)
}

function verifyHrefEscaping(format: Renderer) {
  expect(format(BASE).html).toContain('&amp;durationMinutes=30')
}

function verifyLabelEscaping(format: Renderer) {
  const markup = `<img src=x onerror=alert(1)> & "quoted" 'label'`
  // Feed markup through the real label formatter, without widening the public renderer input.
  const formatter = vi
    .spyOn(Intl.DateTimeFormat.prototype, 'format', 'get')
    .mockImplementation(() => () => markup)
  try {
    const result = format(BASE)
    const document = new JSDOM(result.html).window.document
    const link = document.querySelector('a')
    expect(result.slots[0]?.label).toContain(markup)
    expect(link?.textContent).toBe(result.slots[0]?.label)
    expect(link?.children).toHaveLength(0)
    expect(document.querySelectorAll('img,[onerror]')).toHaveLength(0)
    expect(result.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp;')
    expect(result.html).toContain('&quot;quoted&quot; &#39;label&#39;')
    expect(result.text).toContain(result.slots[0]?.label)
  } finally {
    formatter.mockRestore()
  }
}

const proofreadNotices = {
  en: 'These times are not reserved and may no longer be available. Each link opens the booking page with that time selected. Confirm your booking there if the time is still available.',
  'zh-CN':
    '这些时间不会被预留，打开链接时可能已不可约。每个链接都会打开预约页面，并预选对应的时间。若该时间仍可约，请在页面上确认预约。',
  de: 'Diese Termine sind nicht reserviert und möglicherweise nicht mehr verfügbar. Jeder Link führt zur Buchungsseite, auf der der entsprechende Termin vorausgewählt ist. Bestätigen Sie Ihre Buchung dort, wenn der Termin noch verfügbar ist.',
  fr: 'Ces créneaux ne sont pas réservés et peuvent ne plus être disponibles. Chaque lien ouvre la page de réservation avec le créneau correspondant présélectionné. Confirmez votre réservation sur cette page si le créneau est toujours disponible.',
  es: 'Estos horarios no están reservados y es posible que ya no estén disponibles. Cada enlace abre la página de reservas con el horario correspondiente preseleccionado. Confirme su reserva en esa página si el horario sigue disponible.',
  'pt-BR':
    'Estes horários não estão reservados e podem não estar mais disponíveis. Cada link abre a página de agendamento com o horário correspondente já selecionado. Confirme seu agendamento nessa página se o horário ainda estiver disponível.',
} satisfies Record<InterfaceLanguage, string>

function verifyProofreadNotices(format: Renderer) {
  for (const [locale, notice] of Object.entries(proofreadNotices)) {
    const result = format({ ...BASE, locale: locale as InterfaceLanguage })
    const document = new JSDOM(result.html).window.document
    expect(result.text.endsWith(`\n\n${notice}`)).toBe(true)
    expect(document.querySelector('div')?.lastElementChild?.textContent).toBe(notice)
  }
}

function verifyTitleNormalization(format: Renderer) {
  const result = format({ ...BASE, title: 'A\r\nB\tC\u0085D\u2028E\u2029F\u202eG\u2066H\u0000I' })
  expect(result.text.split('\n')[0]).toBe('Available times for A B C D E FGHI (30 minutes)')
  expect(() => format({ ...BASE, title: 'broken\ud800value' })).toThrow('invalid_title')
  expect(() => format({ ...BASE, title: 'a'.repeat(201) })).toThrow('invalid_title')
}

function verifyStrictInstants(format: Renderer) {
  for (const start of [
    '2027-02-30T14:30:00Z',
    '2027-06-15T14:30Z',
    '2027-06-15T14:30:00',
    '2027-06-15T14:30:60Z',
    '2027-06-15T24:00:00Z',
    '2027-06-15T14:30:00.0001Z',
    '0000-06-15T14:30:00Z',
    '0001-01-01T00:00:00+01:00',
    '9999-12-31T23:45:00Z',
  ]) {
    expect(() => format({ ...BASE, starts: [start] })).toThrow('invalid_slots')
  }
}

function verifyDuration(format: Renderer) {
  for (const durationMinutes of [0, -1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => format({ ...BASE, durationMinutes })).toThrow('invalid_duration')
  }
}

function verifyLocaleZone(format: Renderer) {
  for (const locale of ['en-US', 'zh', 'unknown', '__proto__']) {
    expect(() => format({ ...BASE, locale: locale as InterfaceLanguage })).toThrow('invalid_locale')
  }
  for (const displayTimeZone of ['-05:00', '+01', 'EST', 'EST5EDT', 'CST', 'GMT', 'invalid/zone']) {
    expect(() => format({ ...BASE, displayTimeZone })).toThrow('invalid_time_zone')
  }
}

function verifyAddressIsolation(format: Renderer) {
  for (const address of [
    { kind: 'personal', handle: 'book', slug: 'token' },
    { kind: 'personal', handle: 'embed', slug: 'intro' },
    { kind: 'personal', handle: 'ada', slug: 'intro', oneTimeToken: 'private' },
    { kind: 'personal', handle: 'ada', slug: 'intro?hostId=private' },
    { kind: 'personal', handle: 'Ada', slug: 'intro' },
    { kind: 'team', teamSlug: 'admin', slug: 'intro' },
    { kind: 'oneTimeLink', token: 'private' },
  ]) {
    expect(() => format({ ...BASE, address: address as SlotSnippetInput['address'] })).toThrow(
      'invalid_address',
    )
  }
  expect(() => format({ ...BASE, oneTimeToken: 'private' } as SlotSnippetInput)).toThrow(
    'invalid_input',
  )
}

function verifyDst(format: Renderer) {
  const result = format({
    ...BASE,
    starts: ['2027-03-14T06:30:00Z'],
    durationMinutes: 60,
    displayTimeZone: 'America/New_York',
  })
  expect(result.slots[0]?.end).toBe('2027-03-14T07:30:00.000Z')
  expect(result.slots[0]?.label).toBe(
    'Sun, March 14, 2027, 1:30 AM (UTC-05:00) – 3:30 AM (UTC-04:00) [America/New_York]',
  )
}

function verifyMidnight(format: Renderer) {
  const result = format({ ...BASE, durationMinutes: 60, displayTimeZone: 'Asia/Tokyo' })
  expect(result.slots[0]?.label).toBe(
    'Tue, June 15, 2027, 11:30 PM – Wed, June 16, 2027, 12:30 AM [Asia/Tokyo, UTC+09:00]',
  )
}

function verifyChineseLabels(format: Renderer) {
  for (const [start, durationMinutes, displayTimeZone, expected] of [
    ['2027-06-15T14:30:00Z', 60, 'UTC', '2027年6月15日周二，14:30至15:30［UTC，UTC+00:00］'],
    [
      '2027-06-15T14:30:00Z',
      60,
      'Asia/Tokyo',
      '2027年6月15日周二，23:30至2027年6月16日周三，0:30［Asia/Tokyo，UTC+09:00］',
    ],
    [
      '2027-03-14T06:30:00Z',
      60,
      'America/New_York',
      '2027年3月14日周日，1:30（UTC-05:00）至3:30（UTC-04:00）［America/New_York］',
    ],
    [
      '2027-03-14T04:30:00Z',
      180,
      'America/New_York',
      '2027年3月13日周六，23:30（UTC-05:00）至2027年3月14日周日，3:30（UTC-04:00）［America/New_York］',
    ],
  ] as const) {
    const result = format({
      ...BASE,
      starts: [start],
      locale: 'zh-CN',
      durationMinutes,
      displayTimeZone,
    })
    expect(result.slots[0]?.label).toBe(expected)
    expect(result.text).toContain(expected)
    expect(new JSDOM(result.html).window.document.querySelector('a')?.textContent).toBe(expected)
  }
}

function verifyUrlLimit(format: Renderer) {
  expect(() => format({ ...BASE, publicUrl: `https://${'a'.repeat(1970)}.example` })).toThrow(
    'snippet_too_large',
  )
}

const relaxedTitle: Replacement = [
  "if (!title || title.length > 200) throw new SlotSnippetError('invalid_title')",
  "if (!title) throw new SlotSnippetError('invalid_title')",
]

function verifyTextLimit(format: Renderer) {
  expect(() => format({ ...BASE, title: 'é'.repeat(16385) })).toThrow('snippet_too_large')
}

function verifyHtmlLimit(format: Renderer) {
  expect(() => format({ ...BASE, title: '<'.repeat(17000) })).toThrow('snippet_too_large')
}

describe('portable slot snippet renderer', () => {
  it.each(fixtures)(
    'matches reusable text and HTML fixtures in $input.locale',
    ({ input, expected }) => {
      expect(formatSlotSnippet(input)).toEqual(expected)
      const document = new JSDOM(expected.html).window.document
      expect(document.querySelector('div')?.lang).toBe(input.locale)
      const links = [...document.querySelectorAll('li a')]
      expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual(
        expected.slots.map((slot) => [slot.label, slot.url]),
      )
      expect(links.every((link) => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true)
      for (const { url, label } of expected.slots) {
        expect(expected.text).toContain(`${label}\n${url}`)
        expect([...new URL(url).searchParams.keys()]).toEqual(['start', 'durationMinutes'])
      }
    },
  )

  it('normalizes profile preferences but rejects unsupported explicit options', () => {
    expect(resolveSnippetLocale('fr-CA')).toBe('fr')
    expect(resolveSnippetLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(resolveSnippetLocale('pt-PT')).toBe('en')
    expect(resolveSnippetLocale('zh-TW')).toBe('en')
    expect(resolveSnippetLocale(undefined)).toBe('en')
    expect(resolveSnippetLocale('zz')).toBe('en')
    expect(resolveSnippetTimeZone(undefined)).toBe('UTC')
    expect(resolveSnippetTimeZone('EST')).toBe('UTC')
    expect(resolveSnippetTimeZone('america/new_york')).toBe('America/New_York')
    expect(snippetTimeZone('america/new_york')).toBe('America/New_York')
    expect(() => snippetTimeZone('EST5EDT')).toThrow('invalid_time_zone')
    expect(() => snippetTimeZone('invalid/zone')).toThrow('invalid_time_zone')
    verifyLocaleZone(formatSlotSnippet)
  })

  it('bounds selection without silently deduplicating or truncating and sorts exact instants', () => {
    verifyCount(formatSlotSnippet)
    verifyDuplicates(formatSlotSnippet)
    verifyOrder(formatSlotSnippet)
    expect(formatSlotSnippet(BASE).slots).toHaveLength(1)
    const starts = Array.from(
      { length: 10 },
      (_, i) => `2027-06-15T${String(i).padStart(2, '0')}:00:00Z`,
    )
    expect(formatSlotSnippet({ ...BASE, starts }).slots).toHaveLength(10)
  })

  it('strictly parses offsets, real dates, supported years and elapsed durations', () => {
    verifyStrictInstants(formatSlotSnippet)
    verifyDuration(formatSlotSnippet)
    expect(formatSlotSnippet({ ...BASE, starts: ['2027-06-15T16:30:00+02:00'] }).slots[0]).toEqual(
      formatSlotSnippet(BASE).slots[0],
    )
    expect(formatSlotSnippet({ ...BASE, starts: ['0001-01-01T00:00:00Z'] }).slots[0]?.start).toBe(
      '0001-01-01T00:00:00.000Z',
    )
    expect(formatSlotSnippet({ ...BASE, durationMinutes: 1440 }).slots[0]?.end).toBe(
      '2027-06-16T14:30:00.000Z',
    )
    expect(formatSlotSnippet({ ...BASE, durationMinutes: 1 }).text).toContain('(1 minute)')
    expect(formatSlotSnippet({ ...BASE, title: '{duration} $&' }).text).toContain(
      'Available times for {duration} $& (30 minutes)',
    )
  })

  it('normalizes and escapes plain text without permitting HTML or private selectors', () => {
    verifyEscaping(formatSlotSnippet)
    verifyTitleNormalization(formatSlotSnippet)
    verifyAddressIsolation(formatSlotSnippet)
    for (const publicUrl of [
      'javascript:alert(1)',
      'https://user:password@example.test',
      'https://example.test/other',
      'https://example.test/?source=tracking',
      'https://example.test/#private',
      ' https://example.test',
    ]) {
      expect(() => formatSlotSnippet({ ...BASE, publicUrl })).toThrow('invalid_address')
    }
    expect(
      buildSlotSnippetBookingUrl('http://localhost:4001', {
        kind: 'team',
        teamSlug: 'Saved-Team',
        slug: 'intro-call',
      }),
    ).toBe('http://localhost:4001/team/Saved-Team/intro-call')
    expect(buildSlotSnippetLink(BASE.publicUrl, BASE.address, BASE.starts[0] ?? '', 30)).toBe(
      'https://hourmere.example.com/ada/intro-call?start=2027-06-15T14%3A30%3A00.000Z&durationMinutes=30',
    )
  })

  it('escapes markup produced by time label formatting without changing visible or plain text', () => {
    verifyLabelEscaping(formatSlotSnippet)
  })

  it('uses the proofread availability and booking-page notice in every email language', () => {
    verifyProofreadNotices(formatSlotSnippet)
  })

  it('uses Chinese interval punctuation while preserving dates, named zones and endpoint offsets', () => {
    verifyChineseLabels(formatSlotSnippet)
  })

  it('uses each endpoint offset and shows both full dates across midnight', () => {
    verifyDst(formatSlotSnippet)
    verifyMidnight(formatSlotSnippet)
    for (const [start, end, zone, firstOffset, lastOffset] of [
      ['2027-11-07T05:30:00Z', '2027-11-07T06:30:00Z', 'America/New_York', '-04:00', '-05:00'],
      ['2027-03-28T00:30:00Z', '2027-03-28T01:30:00Z', 'Europe/Berlin', '+01:00', '+02:00'],
      ['2027-10-31T00:30:00Z', '2027-10-31T01:30:00Z', 'Europe/Berlin', '+02:00', '+01:00'],
    ] as const) {
      const label = formatSlotLabel(start, end, 'en', zone)
      expect(label).toContain(`UTC${firstOffset}`)
      expect(label).toContain(`UTC${lastOffset}`)
      expect(label).toContain(`[${zone}]`)
    }
    const original = formatSlotSnippet(BASE)
    for (const fixture of fixtures) {
      const relabelled = formatSlotSnippet({
        ...BASE,
        locale: fixture.input.locale,
        displayTimeZone: 'Asia/Tokyo',
      })
      expect(relabelled.slots.map(({ start, end, url }) => ({ start, end, url }))).toEqual(
        original.slots.map(({ start, end, url }) => ({ start, end, url })),
      )
    }
  })

  it('enforces final UTF-8 URL, text and escaped HTML caps without clipping', () => {
    verifyUrlLimit(formatSlotSnippet)
    // Isolate output caps from the stricter saved-title envelope, so the byte guards remain tested.
    const outputCaps = sourceCopy([relaxedTitle])
    verifyTextLimit(outputCaps)
    verifyHtmlLimit(outputCaps)
  })

  it('works without a browser Temporal global', () => {
    const source = readFileSync(new URL('./slot-snippet.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bTemporal\./)
    expect(sourceCopy()(BASE)).toEqual(formatSlotSnippet(BASE))
  })
})

describe('slot snippet source-copy mutations', () => {
  it.each<{ name: string; replacement: Replacement; verify: (format: Renderer) => void }>([
    {
      name: 'minimum selection',
      replacement: ['input.starts.length < 1', 'input.starts.length < 0'],
      verify: verifyCount,
    },
    {
      name: 'maximum selection',
      replacement: ['input.starts.length > SLOT_SNIPPET_LIMITS.maxSlots', 'false'],
      verify: verifyCount,
    },
    {
      name: 'normalized duplicate rejection',
      replacement: ['new Set(starts.map((start) => iso(start))).size !== starts.length', 'false'],
      verify: verifyDuplicates,
    },
    {
      name: 'chronological ordering',
      replacement: ['.sort((a, b) => a.getTime() - b.getTime())', ''],
      verify: verifyOrder,
    },
    {
      name: 'strict instant syntax',
      replacement: [
        "typeof value !== 'string' || !INSTANT.test(value)",
        "typeof value !== 'string'",
      ],
      verify: verifyStrictInstants,
    },
    {
      name: 'real calendar dates',
      replacement: [
        'local.getUTCFullYear() !== y || local.getUTCMonth() !== m - 1 || local.getUTCDate() !== d',
        'false',
      ],
      verify: verifyStrictInstants,
    },
    {
      name: 'duration bounds',
      replacement: ['!Number.isInteger(value) || value < 1 || value > 1440', 'false'],
      verify: verifyDuration,
    },
    {
      name: 'explicit supported locale',
      replacement: ['!Object.hasOwn(localeRegistry, value)', 'false'],
      verify: verifyLocaleZone,
    },
    {
      name: 'named-zone requirement',
      replacement: [
        "!(value.toUpperCase() === 'UTC' || /^[A-Za-z_]+(?:\\/[A-Za-z0-9_+-]+)+$/.test(value))",
        'false',
      ],
      verify: verifyLocaleZone,
    },
    {
      name: 'title escaping',
      replacement: ['escapeHtml(heading)', 'heading'],
      verify: verifyEscaping,
    },
    {
      name: 'href escaping',
      replacement: ['escapeHtml(slot.url)', 'slot.url'],
      verify: verifyHrefEscaping,
    },
    {
      name: 'time label escaping',
      replacement: ['escapeHtml(slot.label)', 'slot.label'],
      verify: verifyLabelEscaping,
    },
    {
      name: 'Chinese interval punctuation',
      replacement: ["if (language === 'zh-CN') {", 'if (false) {'],
      verify: verifyChineseLabels,
    },
    ...Object.entries(proofreadNotices).map(([locale, notice]) => ({
      name: `proofread ${locale} notice`,
      replacement: [notice, 'Times are reserved.'] as Replacement,
      verify: verifyProofreadNotices,
    })),
    {
      name: 'title controls and bidi removal',
      replacement: [".replace(FORBIDDEN_CONTROLS, '')", ''],
      verify: verifyTitleNormalization,
    },
    {
      name: 'malformed Unicode rejection',
      replacement: [
        "typeof value !== 'string' || !value.isWellFormed()",
        "typeof value !== 'string'",
      ],
      verify: verifyTitleNormalization,
    },
    {
      name: 'saved title length limit',
      replacement: relaxedTitle,
      verify: verifyTitleNormalization,
    },
    {
      name: 'private address-field rejection',
      replacement: ["exactKeys(address, ['kind', 'handle', 'slug'])", 'true'],
      verify: verifyAddressIsolation,
    },
    {
      name: 'capability route isolation',
      replacement: ['!isReservedName(address.handle)', 'true'],
      verify: verifyAddressIsolation,
    },
    {
      name: 'endpoint-specific DST offsets',
      replacement: ['const endOffset = offset(last)', 'const endOffset = startOffset'],
      verify: verifyDst,
    },
    {
      name: 'elapsed-duration arithmetic',
      replacement: [
        'new Date(value.getTime() + input.durationMinutes * 60000)',
        'new Date(value.getTime() + input.durationMinutes * 1000)',
      ],
      verify: verifyDst,
    },
    {
      name: 'cross-midnight end date',
      replacement: ['const datesDiffer = startDate !== endDate', 'const datesDiffer = false'],
      verify: verifyMidnight,
    },
    {
      name: 'URL byte cap',
      replacement: ['maxUrlUtf8Bytes: 2048', 'maxUrlUtf8Bytes: 100000'],
      verify: verifyUrlLimit,
    },
  ])('detects removal of $name with a real assertion failure', ({ replacement, verify }) => {
    verify(sourceCopy())
    expect(() => verify(sourceCopy([replacement]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each<{ name: string; replacement: Replacement; verify: (format: Renderer) => void }>([
    {
      name: 'plain-text UTF-8 byte cap',
      replacement: ['SLOT_SNIPPET_LIMITS.maxPlainTextUtf8Bytes,', 'Number.MAX_SAFE_INTEGER,'],
      verify: verifyTextLimit,
    },
    {
      name: 'escaped HTML UTF-8 byte cap',
      replacement: ['SLOT_SNIPPET_LIMITS.maxHtmlUtf8Bytes,', 'Number.MAX_SAFE_INTEGER,'],
      verify: verifyHtmlLimit,
    },
  ])('detects removal of $name with a real assertion failure', ({ replacement, verify }) => {
    verify(sourceCopy([relaxedTitle]))
    expect(() => verify(sourceCopy([relaxedTitle, replacement]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
