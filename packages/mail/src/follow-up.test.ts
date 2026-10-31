import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import {
  type BookingEmailMeeting,
  type BookingEmailRecipient,
  followUpEmail,
  formatMeetingTime,
} from './booking.ts'
import { mailCatalogueProblems, mailCatalogues } from './catalogue.ts'
import { createLogMailer, type MailMessage } from './index.ts'

const meeting: BookingEmailMeeting = {
  eventName: 'Intro call',
  hostName: 'Grace Hopper',
  inviteeName: 'Ada Lovelace',
  inviteeEmail: 'ada@example.test',
  inviteeTimeZone: 'Europe/Berlin',
  start: Temporal.Instant.from('2026-10-20T08:00:00Z'),
  end: Temporal.Instant.from('2026-10-20T08:30:00Z'),
  location: { kind: 'link', label: 'Google Meet', url: 'https://meet.example.test/meeting' },
  guests: [{ name: 'Charles', email: 'charles@example.test' }],
}
const recipients: BookingEmailRecipient[] = [
  {
    role: 'attendee',
    email: meeting.inviteeEmail,
    timeZone: 'Europe/Berlin',
    manageLinks: {
      reschedule: 'https://example.test/booking#token=fixture&action=reschedule',
      cancel: 'https://example.test/booking#token=fixture&action=cancel',
    },
  },
  { role: 'attendee', email: 'charles@example.test', timeZone: 'Asia/Shanghai' },
  {
    role: 'host',
    email: 'grace@example.test',
    timeZone: 'America/New_York',
    answers: [{ question: 'Private question', answer: 'Private answer' }],
  },
]
const invitee = recipients[0] as BookingEmailRecipient
const host = recipients[2] as BookingEmailRecipient
const bookingUrl = 'https://example.test/app/bookings/fixture'
const attachment = {
  filename: 'invite.ics',
  contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
  content: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR',
}
const copy = {
  en: {
    subject: 'Scheduled meeting time ended: Intro call',
    intro: 'The scheduled time for your meeting with Grace Hopper has ended.',
    note: 'Note from the host',
  },
  'zh-CN': {
    subject: '预约时段已结束：Intro call',
    intro: '你与 Grace Hopper 的会议预约时段已结束。',
    note: '主持人留言',
  },
  de: {
    subject: 'Geplanter Zeitraum abgelaufen: Intro call',
    intro: 'Der für Ihren Termin mit Grace Hopper vorgesehene Zeitraum ist abgelaufen.',
    note: 'Nachricht der gastgebenden Person',
  },
  fr: {
    subject: 'Fin du créneau prévu\u00a0: Intro call',
    intro: 'Le créneau prévu pour votre réunion avec Grace Hopper est terminé.',
    note: 'Message de l’hôte',
  },
  es: {
    subject: 'Fin del horario programado: Intro call',
    intro: 'El horario programado para su reunión con Grace Hopper ha finalizado.',
    note: 'Nota del anfitrión',
  },
  'pt-BR': {
    subject: 'Fim do horário agendado: Intro call',
    intro: 'O horário agendado para sua reunião com Grace Hopper terminou.',
    note: 'Mensagem do anfitrião',
  },
}

/** Decode visible HTML independently of the production escaping helpers. */
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
const normalized = (text: string) => text.replace(/[:：]/g, ' ').replace(/\s+/g, ' ').trim()
function equivalent(message: MailMessage) {
  expect(normalized(visibleText(message.html ?? ''))).toBe(normalized(message.text))
}

type Render = typeof followUpEmail
type Replacement = readonly [string, string]

/** Evaluate an isolated source copy; the production source and module cache stay intact. */
async function rendererCopy(replacements: Replacement[] = []): Promise<Render> {
  const url = new URL('./booking.ts', import.meta.url)
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
  return new Function(...Object.keys(dependencies), `${source}; return followUpEmail`)(
    ...Object.values(dependencies),
  ) as Render
}

function verifyEscaping(render: Render = followUpEmail) {
  const note = '<a href="https://note.example.test/">Read & reply</a>\n<script>alert(1)</script>'
  const message = render(meeting, invitee, { hostNote: note })
  expect(message.text).toContain(note)
  expect(message.html).toContain(
    '&lt;a href=&quot;https://note.example.test/&quot;&gt;Read &amp; reply&lt;/a&gt;',
  )
  expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(message.html).not.toMatch(/<a\b|<script\b/i)
  equivalent(message)
}

function verifyNormalization(render: Render = followUpEmail) {
  const message = render(meeting, invitee, {
    hostNote: 'First\r\nBcc: victim@example.test\rLast\u0000\u202e\tline\ud800',
  })
  expect(message.text).toContain('First\nBcc: victim@example.test\nLast\tline�')
  expect(message.html).toContain('First<br>Bcc: victim@example.test<br>Last\tline�')
  expect(message.subject).toBe(copy.en.subject)
  expect(message.to).toBe(meeting.inviteeEmail)
  expect(message.replyTo).toBeUndefined()
  for (const body of [message.text, message.html ?? '']) {
    expect(body).not.toContain('\r')
    expect(body).not.toContain('\u0000')
    expect(body).not.toContain('\u202e')
    expect(body.isWellFormed()).toBe(true)
  }
  equivalent(message)
  const long = render(meeting, invitee, {
    hostNote: `${'x'.repeat(1999)}🙂${'LAST_NOTE_SUFFIX'.repeat(10_000)}`,
  })
  expect(long.text).toContain('x'.repeat(1999))
  expect(long.text).not.toContain('🙂')
  expect(long.text).not.toContain('LAST_NOTE_SUFFIX')
  expect(long.text.isWellFormed()).toBe(true)
  expect(long.text.length).toBeLessThan(3000)
  equivalent(long)
}

function verifyPrivacy(render: Render = followUpEmail) {
  for (const recipient of recipients) {
    // Extra runtime options cannot turn a follow-up into a calendar invitation.
    const options = { attachment, bookingUrl }
    const message = render(meeting, recipient, options)
    expect(message.attachments).toBeUndefined()
    for (const body of [message.text, message.html ?? '']) {
      expect(body).not.toMatch(/meet\.example|Google Meet|token=|Private question|Private answer/)
      expect(body).not.toContain('charles@example.test')
      expect(body.includes(bookingUrl)).toBe(recipient.role === 'host')
    }
  }
}

function verifyBookingLinks(render: Render = followUpEmail) {
  const message = render(meeting, host, { bookingUrl })
  expect(message.text).toContain(bookingUrl)
  expect(message.html).toContain(`href="${bookingUrl}"`)
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,test', '//outside.example.test']) {
    const rejected = render(meeting, host, { bookingUrl: unsafe })
    expect(rejected.text).not.toContain(unsafe)
    expect(rejected.html).not.toContain(unsafe)
  }
  for (const recipient of recipients.filter((recipient) => recipient.role === 'attendee')) {
    expect(render(meeting, recipient, { bookingUrl })).toEqual(render(meeting, recipient))
  }
}

async function verifyLogRedaction(render: Render = followUpEmail) {
  const logged: unknown[] = []
  await createLogMailer((...args) => logged.push(args)).send(
    render(meeting, invitee, { hostNote: 'Private host note' }),
  )
  expect(JSON.stringify(logged)).not.toMatch(/Private host note|Intro call|ada@example/)
  expect(logged).toHaveLength(1)
}

function verifyHeaders(render: Render = followUpEmail) {
  const message = render(meeting, invitee, { hostNote: 'Host note\r\nBcc: victim@example.test' })
  expect(message.subject).toBe(copy.en.subject)
  expect(message.subject).not.toMatch(/[\r\n]/)
  expect(message.to).toBe(meeting.inviteeEmail)
  expect(message.replyTo).toBeUndefined()
  expect(message.text).toContain('Host note\nBcc: victim@example.test')
}

describe('follow-up email templates', () => {
  it.each(registeredLocales)(
    'renders complete, equivalent $code alternatives for every role',
    ({ code }) => {
      expect(copy).toHaveProperty(code)
      for (const recipient of recipients) {
        const message = followUpEmail(
          meeting,
          { ...recipient, locale: code },
          {
            hostNote: 'Please reply with any questions.\n“Notes” & <literal text>',
          },
        )
        const expected = copy[code]
        expect(message.to).toBe(recipient.email)
        expect(message.sensitive).toBe(true)
        expect(message.subject).toBe(expected.subject)
        if (recipient.role === 'attendee') expect(message.text).toContain(expected.intro)
        for (const body of [message.text, visibleText(message.html ?? '')]) {
          expect(body).toContain(expected.note)
          expect(body).toContain(meeting.eventName)
          expect(body).toContain(
            formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, code),
          )
          expect(body).toContain('“Notes” & <literal text>')
          expect(body).not.toMatch(
            /Thank you for (?:attending|joining)|Thanks for (?:attending|joining)/i,
          )
          if (code !== 'en')
            expect(body).not.toMatch(
              /The scheduled time|Note from the host|You received this email/,
            )
        }
        expect(message.html).toContain(`<html lang="${code}">`)
        expect(message.html).toContain('max-width: 600px')
        equivalent(message)
      }
    },
  )

  it('keeps follow-up catalogue keys complete, localized and placeholder-compatible', () => {
    for (const { code } of registeredLocales) {
      const catalogue = mailCatalogues[code] ?? {}
      for (const key of [
        'followUp.subject',
        'followUp.introduction',
        'followUp.hostNote',
      ] as const) {
        expect(catalogue[key]).toBeTypeOf('string')
        if (code !== 'en') expect(catalogue[key]).not.toBe(mailCatalogues.en?.[key])
      }
      expect(mailCatalogueProblems(catalogue)).toEqual([])
    }
  })

  it('omits an absent or empty note without an empty heading', () => {
    const baseline = followUpEmail(meeting, invitee)
    for (const hostNote of [undefined, '', ' \r\n\t ', '\u0000\u202e']) {
      expect(followUpEmail(meeting, invitee, { hostNote })).toEqual(baseline)
    }
    expect(baseline.text).not.toContain(copy.en.note)
    expect(baseline.html).not.toContain(copy.en.note)
  })

  it('escapes host-note markup without rendering links', () => verifyEscaping())
  it('normalizes CRLF and controls, repairs Unicode and bounds extremely long notes', () =>
    verifyNormalization())
  it('keeps host notes out of headers and transport addresses', () => verifyHeaders())
  it('never includes join links, locations, private answers, manage links, guests or calendar attachments', () =>
    verifyPrivacy())

  it('keeps note URLs as text in every locale', () => {
    for (const { code } of registeredLocales) {
      const message = followUpEmail(
        meeting,
        { ...invitee, locale: code },
        {
          hostNote: 'https://note.example.test/path?x=1&y=2\n[Read](https://note.example.test/)',
        },
      )
      expect(message.html).not.toMatch(/<a\b/i)
      expect(message.text).toContain('https://note.example.test/path?x=1&y=2')
      equivalent(message)
    }
  })

  it('omits non-link locations as well as meeting URLs', () => {
    for (const location of [
      { kind: 'phone' as const, number: '+1 555 0199' },
      { kind: 'address' as const, address: 'Private address' },
      { kind: 'custom' as const, text: 'Private location' },
    ]) {
      const message = followUpEmail({ ...meeting, location }, invitee)
      expect(message.text).not.toMatch(/0199|Private address|Private location/)
      expect(message.html).not.toMatch(/0199|Private address|Private location/)
    }
  })

  it('allows only an HTTP(S) booking link for authenticated hosts', () => verifyBookingLinks())

  it('keeps untrusted names single-line in headers and escapes body substitutions', () => {
    const message = followUpEmail(
      {
        ...meeting,
        eventName: '<img src=x>\r\nBcc: other@example.test',
        hostName: '<b>{other}</b>',
      },
      invitee,
    )
    expect(message.subject).not.toMatch(/[\r\n]/)
    expect(message.html).toContain('&lt;img src=x&gt; Bcc: other@example.test')
    expect(message.html).toContain('&lt;b&gt;{other}&lt;/b&gt;')
    expect(message.html).not.toMatch(/<img|<b>/)
  })

  it('falls back to English for unsupported locale preferences', () => {
    for (const locale of [undefined, null, 'qaa', 'zh-TW', 'pt-PT', 'not_a_locale']) {
      expect(followUpEmail(meeting, { ...invitee, locale })).toEqual(
        followUpEmail(meeting, invitee),
      )
    }
  })

  it('redacts private note and booking content from the development mail log', () =>
    verifyLogRedaction())

  it('evaluates an unchanged source copy against the same rendering assertions', async () => {
    const render = await rendererCopy()
    verifyEscaping(render)
    verifyNormalization(render)
    verifyPrivacy(render)
    verifyBookingLinks(render)
    verifyHeaders(render)
    await verifyLogRedaction(render)
  })

  it.each<[string, Replacement, (render: Render) => void | Promise<void>]>([
    [
      'note HTML escaping',
      [`\${htmlLines(c.hostNote.text, c.language)}`, `\${c.hostNote.text}`],
      verifyEscaping,
    ],
    [
      'note normalization and length bound',
      ["normalizeFollowUpHostNote(options.hostNote ?? '')", "options.hostNote ?? ''"],
      verifyNormalization,
    ],
    [
      'join-link omission',
      [
        'answers: [],\n    bookingUrl,',
        "answers: [],\n    join: meeting.location?.kind === 'link' ? { label: 'Join meeting', url: meeting.location.url } : undefined,\n    bookingUrl,",
      ],
      verifyPrivacy,
    ],
    [
      'location omission',
      [
        "field(t('Host'), host),\n    ],",
        "field(t('Host'), host),\n      field(t('Where'), meeting.location ? meetingLocationText(meeting.location) : ''),\n    ],",
      ],
      verifyPrivacy,
    ],
    [
      'manage-link omission',
      [
        'answers: [],\n    bookingUrl,',
        "answers: [],\n    manageLinks: recipient.role === 'attendee' ? recipient.manageLinks : undefined,\n    bookingUrl,",
      ],
      verifyPrivacy,
    ],
    [
      'private-answer omission',
      [
        'answers: [],\n    bookingUrl,',
        "answers: recipient.role === 'host' ? recipient.answers : [],\n    bookingUrl,",
      ],
      verifyPrivacy,
    ],
    [
      'calendar-attachment omission',
      [
        'return { ...render(recipient.email, content), sensitive: true }',
        'return { ...render(recipient.email, content), attachments: [attachment], sensitive: true }',
      ],
      verifyPrivacy,
    ],
    [
      'host-only booking link',
      [
        'isHost && options.bookingUrl ? linkableUrl(options.bookingUrl) : undefined',
        'options.bookingUrl ? linkableUrl(options.bookingUrl) : undefined',
      ],
      verifyPrivacy,
    ],
    [
      'safe booking URL scheme',
      [
        'isHost && options.bookingUrl ? linkableUrl(options.bookingUrl) : undefined',
        'isHost ? options.bookingUrl : undefined',
      ],
      verifyBookingLinks,
    ],
    [
      'private-content log redaction',
      [
        'return { ...render(recipient.email, content), sensitive: true }',
        'return render(recipient.email, content)',
      ],
      verifyLogRedaction,
    ],
    [
      'note/header separation',
      [
        "subject: t('followUp.subject', { event }),",
        "subject: options.hostNote ?? t('followUp.subject', { event }),",
      ],
      verifyHeaders,
    ],
  ])('detects removal of %s with a real assertion failure', async (_name, replacement, verify) => {
    const mutation: Replacement = replacement[1].includes('attachments: [attachment]')
      ? [replacement[0], replacement[1].replace('[attachment]', `[${JSON.stringify(attachment)}]`)]
      : replacement
    const render = await rendererCopy([mutation])
    await expect(Promise.resolve().then(() => verify(render))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})
