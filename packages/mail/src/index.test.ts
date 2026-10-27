import type { Server } from 'node:net'
import addressparser from 'nodemailer/lib/addressparser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createLogMailer,
  createSmtpMailer,
  escapeHtml,
  icsAttachment,
  MailRejectedError,
  magicLinkEmail,
  smtpTransportOptions,
} from './index.ts'
import { emailButton, emailLayout } from './layout.ts'
import { fakeSmtpServer } from './smtp-testing.ts'

/** Parse MIME structure independently of Nodemailer's options to verify the delivered message. */
function mimePart(raw: string): {
  type: string
  content: Buffer
  children: ReturnType<typeof mimePart>[]
} {
  const separator = raw.indexOf('\r\n\r\n')
  const headers = raw.slice(0, separator).replace(/\r\n[ \t]+/g, ' ')
  const body = raw.slice(separator + 4)
  const contentType = headers.match(/^Content-Type: ([^\r\n]+)/im)?.[1] ?? ''
  const boundary = contentType.match(/boundary="([^"]+)"/i)?.[1]
  const encoding = headers.match(/^Content-Transfer-Encoding: ([^\r\n]+)/im)?.[1]?.toLowerCase()
  const content =
    encoding === 'base64'
      ? Buffer.from(body, 'base64')
      : encoding === 'quoted-printable'
        ? Buffer.from(
            body
              .replace(/=\r\n/g, '')
              .replace(/=([a-f0-9]{2})/gi, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            'latin1',
          )
        : Buffer.from(body, 'utf8')
  return {
    type: contentType,
    content,
    children: boundary
      ? body
          .split(`--${boundary}`)
          .slice(1, -1)
          // The CRLF preceding a MIME boundary belongs to the delimiter, not the body.
          .map((part) => mimePart(part.replace(/^\r\n/, '').replace(/\r\n$/, '')))
      : [],
  }
}

function mailboxHeader(raw: string, name: string) {
  const headers = raw.split('\r\n\r\n')[0]?.replace(/\r\n[ \t]+/g, ' ') ?? ''
  const value = headers.match(new RegExp(`^${name}: ([^\\r\\n]+)`, 'im'))?.[1]
  return value === undefined ? [] : addressparser(value)
}

const url = 'https://cal.example.com/sign-in/confirm#token=abc&callbackURL=%2F'

const invitation = icsAttachment({
  method: 'REQUEST',
  uid: 'booking-1@cal.example.com',
  sequence: 0,
  stamp: Temporal.Instant.from('2026-10-16T10:00:00Z'),
  start: Temporal.Instant.from('2026-10-20T08:00:00Z'),
  end: Temporal.Instant.from('2026-10-20T08:30:00Z'),
  summary: 'Intro call with Grace Hopper',
  organizer: { name: 'Grace Hopper', email: 'grace@example.com' },
  attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
})

describe('magicLinkEmail', () => {
  it('widens Chinese instruction quotes without changing plain text or link attributes', () => {
    const link = 'https://cal.example.com/sign-in/confirm#label=“引用”&token=fixture'
    const message = magicLinkEmail({
      to: 'ada@example.com',
      url: link,
      expiresInMinutes: 5,
      language: 'zh-CN',
    })
    expect(message.html).toContain(
      '点击<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: \'fwid\';">“</span>登录 Hourmere<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: \'fwid\';">”</span>。',
    )
    expect(message.html).toContain(
      'href="https://cal.example.com/sign-in/confirm#label=“引用”&amp;token=fixture"',
    )
    expect(message.text).toContain(
      '如需登录 Hourmere，请打开此链接，然后在打开的页面上点击“登录 Hourmere”：',
    )
    expect(message.text).toContain(link)
    expect(message.text).not.toContain('<span')
    expect(magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 }).html).not.toContain(
      'cjk-quote',
    )
  })

  it.each(['en', 'zh-CN'] as const)('matches the complete %s sign-in email', (language) => {
    const message = magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5, language })
    expect(message.html).toContain(`<html lang="${language}">`)
    if (language === 'zh-CN') {
      // Links and markup have protocol punctuation; the translated prose must use Chinese punctuation.
      const prose = [
        message.subject,
        message.text.replace(url, ''),
        ...Array.from(
          message.html?.split('<body')[1]?.matchAll(/>([^<>]*)</g) ?? [],
          (match) => match[1],
        ).filter((text) => text !== escapeHtml(url)),
      ].join('\n')
      expect(prose).not.toMatch(/[.,:;!?"'()]/)
    }
    expect(message).toMatchSnapshot()
  })

  it('defaults legacy callers to the English template', () => {
    const input = { to: 'ada@example.com', url, expiresInMinutes: 5 }
    expect(magicLinkEmail(input)).toEqual(magicLinkEmail({ ...input, language: 'en' }))
  })

  it('puts the link in the text and, escaped, in the HTML', () => {
    const m = magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 })
    expect(m).toMatchObject({ to: 'ada@example.com', subject: 'Sign in to Hourmere' })
    expect(m.text).toContain(url)
    expect(m.text).toContain('5 minutes')
    // The link opens a page; its button signs in.
    expect(m.text).toContain('then press "Sign in to Hourmere" on the page it opens')
    expect(m.html).toContain('then &quot;Sign in to Hourmere&quot; on the page it opens')
    // Explicit expected markup keeps this assertion independent of the escaping function.
    expect(m.html).toContain(
      'href="https://cal.example.com/sign-in/confirm#token=abc&amp;callbackURL=%2F"',
    )
    expect(m.html).not.toContain('token=abc&callbackURL')
  })

  it('escapes every ampersand in a sign-in link without changing its plain text', () => {
    const link =
      'https://cal.example.com/sign-in/confirm#token=abc&callbackURL=%2F&errorCallbackURL=%2Fsign-in'
    const message = magicLinkEmail({ to: 'ada@example.com', url: link, expiresInMinutes: 5 })
    expect(message.text).toContain(link)
    expect(message.html).toContain(
      'href="https://cal.example.com/sign-in/confirm#token=abc&amp;callbackURL=%2F&amp;errorCallbackURL=%2Fsign-in"',
    )
  })

  it.each(['en', 'zh-CN'] as const)('includes a complete localized %s head', (language) => {
    const message = magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5, language })
    expect(message.html).toMatch(/^<!doctype html>\n<html lang="[^"]+">\n<head>/)
    const head = message.html?.match(/<head>([\s\S]*?)<\/head>/)?.[1]
    expect(head).toContain('<meta charset="utf-8">')
    expect(head).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(head).toContain(`<title>${message.subject}</title>`)
  })

  it.each(['en', 'zh-CN'] as const)(
    'keeps long fallback links breakable and brand blue in %s',
    (language) => {
      const longUrl = `https://cal.example.com/sign-in/confirm#token=${'a'.repeat(512)}&callbackURL=%2F`
      const message = magicLinkEmail({
        to: 'ada@example.com',
        url: longUrl,
        expiresInMinutes: 5,
        language,
      })
      const fallback = message.html?.match(
        /<p style="[^"]*font-size: 13px;[^>]*>[^<]*<br>[\s\S]*?<\/p>/,
      )?.[0]
      expect(fallback).toMatch(/<p style="[^"]*overflow-wrap: anywhere; word-break: break-word;/)
      expect(fallback).toContain(`>${escapeHtml(longUrl)}</a>`)
      expect(fallback).toMatch(
        /<a [^>]*style="color: #1f4fd8; overflow-wrap: anywhere; word-break: break-word;/,
      )
      expect(message.text).toContain(longUrl)
    },
  )

  it.each([
    [
      'en',
      'You received this email because a sign-in link was requested for your Hourmere account.',
    ],
    ['zh-CN', '你收到此邮件是因为有人为你的 Hourmere 账号申请了登录链接。'],
  ] as const)(
    'explains the sign-in email in %s with an image-free wordmark',
    (language, footer) => {
      const message = magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5, language })
      expect(message.text.startsWith('Hourmere\n\n')).toBe(true)
      expect(message.html).toMatch(/<p [^>]*>Hourmere<\/p>/)
      expect(message.html).toContain(footer)
      expect(message.text).toContain(footer)
      expect(message.html).not.toMatch(/<img\b/i)
    },
  )
})

describe('email layout', () => {
  it('centers a responsive 600px container', () => {
    const html = emailLayout('en', 'Subject', '<p>Message</p>')
    expect(html).toMatch(/<table [^>]*width="600" align="center"/)
    expect(html).toMatch(/<table [^>]*style="width: 100%; max-width: 600px; margin: 0 auto;/)
  })

  it('constrains the complete container to 600px in Outlook desktop', () => {
    const html = emailLayout('en', 'Subject', '<p>Message</p>')
    const wrapper = html.match(
      /<!--\[if mso\]>(<table[^>]*><tr><td[^>]*>)<!\[endif\]-->([\s\S]*?)<!--\[if mso\]>(<\/td><\/tr><\/table>)<!\[endif\]-->/,
    )
    expect(wrapper).not.toBeNull()
    expect(wrapper?.[1]).toMatch(/<table [^>]*width="600" align="center"/)
    expect(wrapper?.[1]).toContain('width: 600px;')
    expect(wrapper?.[2]).toMatch(/^\n<table [^>]*width="600"[\s\S]*<\/table>\n$/)
    expect(wrapper?.[2]).toContain('<p>Message</p>')
  })

  it('declares a light color scheme and white body and container backgrounds', () => {
    const html = emailLayout('en', 'Subject', '<p>Message</p>')
    expect(html).toContain('<meta name="color-scheme" content="light">')
    expect(html).toContain('<meta name="supported-color-schemes" content="light">')
    expect(html).toContain(':root { color-scheme: light; supported-color-schemes: light; }')
    expect(html).toMatch(/<body bgcolor="#ffffff" [^>]*background-color: #ffffff;/)
    expect(html).toMatch(/<table [^>]*bgcolor="#ffffff" [^>]*background-color: #ffffff;/)
  })

  it('sets the Outlook-compatible font on body, table and cell elements', () => {
    const html = emailLayout('en', 'Subject', '<p>Message</p>')
    expect(html).toContain(
      'body, table, td { font-family: -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif; }',
    )
    for (const tag of ['body', 'table', 'td']) {
      expect(html).toMatch(
        new RegExp(
          `<${tag} [^>]*style="[^"]*font-family: -apple-system,&quot;Segoe UI&quot;,&quot;PingFang SC&quot;,&quot;Microsoft YaHei&quot;,Roboto,Helvetica,Arial,sans-serif;`,
        ),
      )
    }
  })

  it('escapes titles while retaining the prepared body markup', () => {
    const html = emailLayout('en', 'A <script> & "title"', '<p>Message</p>')
    expect(html).toContain('<title>A &lt;script&gt; &amp; &quot;title&quot;</title>')
    expect(html).toContain('<p>Message</p>')
    expect(html).not.toContain('<script>')
  })

  it.each([false, true])('uses a table button with a 44px tap area (secondary=%s)', (secondary) => {
    const html = emailButton('Action', url, secondary)
    expect(html).toMatch(/^<table role="presentation"[^>]*><tr><td/)
    expect(html).toContain(`bgcolor="${secondary ? '#ffffff' : '#1f4fd8'}"`)
    expect(html).toMatch(/<td [^>]*mso-padding-alt: 12px 18px;/)
    expect(html).toMatch(/<td [^>]*font-family:[^>]*Arial,sans-serif;/)
    expect(html).toContain('border: 1px solid #1f4fd8;')
    const anchorStyle = html.match(/<a [^>]*style="([^"]*)"/)?.[1] ?? ''
    expect(anchorStyle).toContain(`color: ${secondary ? '#1f4fd8' : '#ffffff'};`)
    expect(anchorStyle).toContain('display: block;')
    const padding = Number(anchorStyle.match(/padding: (\d+)px/)?.[1])
    const lineHeight = Number(anchorStyle.match(/line-height: (\d+)px/)?.[1])
    expect(padding * 2 + lineHeight).toBeGreaterThanOrEqual(44)
  })

  it('escapes button labels and link attributes', () => {
    const html = emailButton('<button> & "label"', 'https://example.com/?a="b"&c=<d>')
    expect(html).toContain('href="https://example.com/?a=&quot;b&quot;&amp;c=&lt;d&gt;"')
    expect(html).toContain('>&lt;button&gt; &amp; &quot;label&quot;</a>')
    expect(html).not.toContain('<button>')
  })

  it('widens Chinese button quote glyphs without changing their URL', () => {
    const link = 'https://cal.example.com/?label=“引用”'
    const html = emailButton('“操作”', link, false, 'zh-CN')
    expect(html).toContain(`href="${link}"`)
    expect(html).toContain(
      '<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: \'fwid\';">“</span>操作<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: \'fwid\';">”</span>',
    )
    expect(emailButton('“Action”', link)).toContain('>“Action”</a>')
    expect(emailButton('“Action”', link)).not.toContain('cjk-quote')
  })

  it('separates stacked buttons with cell padding when Outlook ignores margins', () => {
    const html = [emailButton('Reschedule', url), emailButton('Cancel', url, true)].join('\n')
    const withoutMargins = html.replace(/margin(?:-[a-z]+)?:[^;]*;/g, '')
    const paddedButtons = Array.from(
      withoutMargins.matchAll(
        /<td style="padding: (\d+)px 0;[^>]*><table\b[\s\S]*?<a [^>]*>([^<]+)<\/a>[\s\S]*?<\/table><\/td>/g,
      ),
    )
    expect(paddedButtons.map((match) => match[2])).toEqual(['Reschedule', 'Cancel'])
    const gap = Number(paddedButtons[0]?.[1]) + Number(paddedButtons[1]?.[1])
    expect(gap).toBeGreaterThanOrEqual(16)
    expect(html).not.toMatch(/margin(?:-[a-z]+)?:/)
  })
})

describe('createLogMailer', () => {
  it('prints each message as one [mail] line with the link', async () => {
    const lines: string[] = []
    await createLogMailer((l) => lines.push(l)).send(
      magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 }),
    )
    expect(lines).toHaveLength(1)
    const line = lines[0] as string
    expect(line).not.toMatch(/[\n\r\u2028\u2029\u0085]/)
    expect(line.startsWith('[mail] {')).toBe(true)
    const record = JSON.parse(line.slice('[mail] '.length))
    expect(record).toMatchObject({
      to: 'ada@example.com',
      subject: 'Sign in to Hourmere',
      links: ['https://cal.example.com/sign-in/confirm#token=abc'],
    })
  })

  it('omits invitation callbacks from logged sign-in links while preserving the actual email', async () => {
    const invitationId = '00000000-0000-4000-8000-000000000071'
    const next = `/app/join?invitationId=${invitationId}`
    const callbackURL = `https://cal.example.com${next}`
    const errorCallbackURL = `/sign-in?${new URLSearchParams({ next })}`
    for (const delimiter of ['#', '?']) {
      const params = new URLSearchParams({
        token: 'synthetic-token',
        callbackURL,
        newUserCallbackURL: callbackURL,
        errorCallbackURL,
      })
      const message = magicLinkEmail({
        to: 'ada@example.com',
        url: `https://cal.example.com/sign-in/confirm${delimiter}${params}`,
        expiresInMinutes: 5,
      })
      const original = structuredClone(message)
      const lines: string[] = []
      await createLogMailer((line) => lines.push(line)).send(message)
      expect(lines).toHaveLength(1)
      expect(lines.every((line) => !line.includes(invitationId))).toBe(true)
      const record = JSON.parse((lines[0] as string).slice('[mail] '.length))
      const loggedUrl = new URL(record.links[0])
      expect(loggedUrl.searchParams.has('callbackURL')).toBe(false)
      const fragment = new URLSearchParams(loggedUrl.hash.slice(1))
      expect([...loggedUrl.searchParams.keys(), ...fragment.keys()]).toEqual(['token'])
      expect(loggedUrl.searchParams.get('token') ?? fragment.get('token')).toBe('synthetic-token')
      expect(message).toEqual(original)
      expect(message.text.includes(invitationId)).toBe(true)
      expect(message.html?.includes(invitationId)).toBe(true)
    }
  })

  it('names attachments and their sizes, not their contents', async () => {
    const lines: string[] = []
    await createLogMailer((l) => lines.push(l)).send({
      to: 'ada@example.com',
      subject: 'Confirmed',
      text: 'Booked.',
      attachments: [invitation],
    })
    const record = JSON.parse((lines[0] as string).slice('[mail] '.length))
    expect(record.attachments).toEqual([
      {
        filename: 'invite.ics',
        contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
        bytes: Buffer.byteLength(invitation.content),
      },
    ])
    expect(lines[0]).not.toContain('BEGIN:VCALENDAR')
  })

  it('keeps hostile characters from breaking the line', async () => {
    const lines: string[] = []
    await createLogMailer((l) => lines.push(l)).send({
      to: 'x@example.com',
      subject: 'a\u2028b\u0085c\u202ed\u2066e',
      text: 'one\r\n[mail] {"forged":true}',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/[\n\r\u2028\u0085\u202e\u2066]/)
    expect(JSON.parse((lines[0] as string).slice(7)).subject).toBe('a\u2028b\u0085c\u202ed\u2066e')
  })
})

describe('smtpTransportOptions', () => {
  it('requires STARTTLS for smtp: except on loopback; smtps: is TLS anyway', () => {
    const requireTLS = (u: string) => smtpTransportOptions(u).requireTLS
    expect(requireTLS('smtp://u:p@smtp.example.com:587')).toBe(true)
    expect(requireTLS('smtp://u:p@10.0.0.5:587')).toBe(true)
    expect(requireTLS('smtp://localhost:25')).toBe(false)
    expect(requireTLS('smtp://127.0.0.1:25')).toBe(false)
    expect(requireTLS('smtp://[::1]:25')).toBe(false)
    expect(requireTLS('smtps://u:p@smtp.example.com:465')).toBe(false)
  })

  it('gives up on an unresponsive server within seconds, not nodemailer’s minutes', () => {
    expect(smtpTransportOptions('smtp://u:p@smtp.example.com:587')).toMatchObject({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    })
  })
})

describe('MailRejectedError', () => {
  it('is permanent only when the address itself is refused', () => {
    const cases: [number | undefined, string | undefined, boolean, boolean, boolean][] = [
      // code, enhanced, at RCPT TO, recipient only, permanent
      [550, '5.1.1', true, true, true],
      [553, '5.1.3', true, true, true],
      [550, '5.2.1', true, true, true],
      [552, '5.2.2', true, true, false],
      [450, '4.2.0', true, true, false],
      [550, '5.7.1', true, false, false],
      [554, '5.7.1', true, false, false],
      [550, '5.4.5', true, false, false],
      [550, '5.5.0', true, false, false],
      [421, '4.7.0', true, false, false],
      [550, undefined, true, true, true],
      [551, undefined, true, true, true],
      [553, undefined, true, true, true],
      [552, undefined, true, true, false],
      [554, undefined, true, false, false],
      [451, undefined, true, false, false],
      [550, '5.1.1', false, false, false],
      [550, undefined, false, false, false],
      [undefined, undefined, true, false, false],
    ]
    for (const [responseCode, enhancedCode, atRecipient, recipientOnly, permanent] of cases) {
      const err = new MailRejectedError({ responseCode, enhancedCode, atRecipient })
      expect(
        { recipientOnly: err.recipientOnly, permanent: err.permanent },
        `${responseCode} ${enhancedCode} ${atRecipient}`,
      ).toEqual({ recipientOnly, permanent })
    }
  })
})

describe('createSmtpMailer', () => {
  const { server, received, sockets } = fakeSmtpServer()
  let port: number

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    // A client given up on (the abort test) keeps its connection until its own timeout.
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => (server as Server).close(resolve))
  })

  it('sends through the SMTP_URL server with percent-decoded credentials', async () => {
    const mailer = createSmtpMailer({
      url: `smtp://resend:p%40ss%2Fword%23@127.0.0.1:${port}`,
      from: 'Hourmere <hourmere@example.com>',
    })
    await mailer.send(magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 }))
    expect(received.auth).toBe('\0resend\0p@ss/word#')
    expect(received.from).toContain('<hourmere@example.com>')
    expect(received.to).toEqual([expect.stringContaining('<ada@example.com>')])
    expect(received.data).toContain('Subject: Sign in to Hourmere')
    expect(mailer.senderEmail).toBe('hourmere@example.com')
    expect(mailboxHeader(received.data ?? '', 'From')).toEqual([
      { name: 'Hourmere', address: 'hourmere@example.com' },
    ])
    expect(mailboxHeader(received.data ?? '', 'Reply-To')).toEqual([])
    expect(mailboxHeader(received.data ?? '', 'Sender')).toEqual([])
  })

  it.each(['REQUEST', 'CANCEL'] as const)(
    'delivers %s as a calendar alternative and an ICS attachment, retaining the message bodies',
    async (method) => {
      received.data = undefined
      const mailer = createSmtpMailer({
        url: `smtp://127.0.0.1:${port}`,
        from: 'Hourmere <hourmere@example.com>',
      })
      const manageUrl = 'https://cal.example.com/booking#token=synthetic-manage-marker'
      const content = invitation.content
        .replace('METHOD:REQUEST', `METHOD:${method}`)
        .replace('STATUS:CONFIRMED', `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`)
      await mailer.send({
        to: 'ada@example.com',
        subject: 'Confirmed',
        text: `Booked. Manage your booking: ${manageUrl}`,
        html: `<p>Booked. <a href="${manageUrl}">Manage your booking</a></p>`,
        attachments: [
          {
            ...invitation,
            filename: method === 'CANCEL' ? 'cancel.ics' : 'invite.ics',
            contentType: `text/calendar; method=${method}; charset=UTF-8`,
            content,
          },
          { filename: 'notes.txt', contentType: 'text/plain', content: 'Useful meeting notes' },
        ],
      })
      const data = (received.data ?? '').replace(/\r\n\s+/g, ' ')
      const message = mimePart(received.data ?? '')
      expect(message.type).toMatch(/^multipart\/mixed;/i)
      expect(message.children[0]?.type).toMatch(/^multipart\/alternative;/i)
      expect(message.children[0]?.children.map((p) => p.type.toLowerCase())).toEqual([
        'text/plain; charset=utf-8',
        'text/html; charset=utf-8',
        `text/calendar; charset=utf-8; method=${method.toLowerCase()}`,
      ])
      expect(message.children.slice(1).map((p) => p.type.split(';')[0])).toEqual([
        'text/plain',
        'application/ics',
      ])
      const alternative = message.children[0]?.children[2]?.content ?? Buffer.alloc(0)
      const attachment = message.children[2]?.content ?? Buffer.alloc(0)
      expect(alternative.equals(Buffer.from(content, 'utf8'))).toBe(true)
      expect(attachment.equals(Buffer.from(content, 'utf8'))).toBe(true)
      expect(alternative.equals(attachment)).toBe(true)
      for (const body of message.children[0]?.children.slice(0, 2) ?? []) {
        expect(body.content.toString('utf8').includes(manageUrl)).toBe(true)
      }
      expect(alternative.toString('utf8').includes('synthetic-manage-marker')).toBe(false)
      expect(attachment.toString('utf8').includes('synthetic-manage-marker')).toBe(false)
      expect(data.match(/Content-Type: text\/calendar;/g)).toHaveLength(1)
      expect(data).toContain(`METHOD:${method}`)
      expect(data).toContain('Booked.')
      expect(data).toMatch(
        new RegExp(
          `Content-Disposition: attachment; filename=${method === 'CANCEL' ? 'cancel' : 'invite'}\\.ics`,
        ),
      )
    },
  )

  it.each([
    ['"Team, Calendar" <calendar@relay.selfhosted.example>', 'calendar@relay.selfhosted.example'],
    ['calendar+bookings@selfhosted.example', 'calendar+bookings@selfhosted.example'],
    ['calendar#?%&/=+tag@selfhosted.example', 'calendar#?%&/=+tag@selfhosted.example'],
    ['Calendar <calendar@bücher.example>', 'calendar@bücher.example'],
  ])('exposes one mailbox from arbitrary MAIL_FROM %s', (from, senderEmail) => {
    expect(createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from }).senderEmail).toBe(
      senderEmail,
    )
  })

  it.each([
    '',
    'not-an-address',
    'one@example.com, two@example.com',
    'one@example.com two@example.com',
    'Calendar: one@example.com;',
    'Calendar <one@example.com',
    'Calendar <one@example.com> trailing',
    'Calendar <one@@example.com>',
    'Calendar <one..two@example.com>',
    'Calendar <one@example..com>',
    'Calendar <one@example.com/path>',
    'Calendar <one@example.com>\r\nBcc: two@example.com',
  ])('rejects ambiguous or malformed MAIL_FROM without echoing it', (from) => {
    expect(() => createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from })).toThrow(
      /^MAIL_FROM must contain one valid mailbox$/,
    )
  })

  it('rejects a long malformed sender without backtracking over display-name spaces', () => {
    const from = `Calendar${' '.repeat(100_000)}not-a-mailbox`
    const start = performance.now()
    expect(() => createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from })).toThrow(
      /^MAIL_FROM must contain one valid mailbox$/,
    )
    expect(performance.now() - start).toBeLessThan(750)
  }, 30_000)

  it('retains the configured From and routes human replies to one sanitized host mailbox', async () => {
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${port}`,
      from: '"Team, Calendar" <calendar@relay.selfhosted.example>',
    })
    await mailer.send({
      to: 'ada@example.com',
      replyTo: { name: 'Grace\r\n\u0000\u202e Hopper', email: 'grace@gmail.example' },
      subject: 'Confirmed',
      text: 'Booked.',
    })
    const data = received.data ?? ''
    expect(mailboxHeader(data, 'From')).toEqual([
      { name: 'Team, Calendar', address: 'calendar@relay.selfhosted.example' },
    ])
    expect(received.from).toBe('MAIL FROM:<calendar@relay.selfhosted.example>')
    expect(mailboxHeader(data, 'Reply-To')).toEqual([
      { name: 'Grace Hopper', address: 'grace@gmail.example' },
    ])
    expect(mailboxHeader(data, 'Sender')).toEqual([])
    expect(data).not.toMatch(/^Bcc:/im)
  })

  it.each([
    'grace@example.com, victim@example.com',
    'grace@example.com\r\nBcc: victim@example.com',
    'grace@exa\r\nmple.com',
    'grace@example.com/path',
    'Grace <grace@example.com>',
    `${'a'.repeat(65)}@example.com`,
  ])('drops an unsafe Reply-To without preventing delivery (%s)', async (email) => {
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${port}`,
      from: 'calendar@selfhosted.example',
    })
    received.to = []
    await expect(
      mailer.send({
        to: 'ada@example.com',
        replyTo: { name: 'Grace', email },
        subject: 'x',
        text: 'x',
      }),
    ).resolves.toBeUndefined()
    expect(received.to).toEqual(['RCPT TO:<ada@example.com>'])
    expect(mailboxHeader(received.data ?? '', 'Reply-To')).toEqual([])
    expect(received.data).not.toMatch(/^Bcc:/im)
  })

  it('keeps the subject on one line and the recipient a single address', async () => {
    received.data = undefined
    received.to = []
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${port}`,
      from: 'Hourmere <hourmere@example.com>',
    })
    await mailer.send({
      to: 'ada@example.com',
      subject: 'Hello\r\nBcc: victim@example.com',
      text: 'Hi',
    })
    expect(received.data).not.toMatch(/^Bcc:/im)
    expect(received.data).toMatch(/^Subject: Hello Bcc: victim@example.com$/m)
    expect(received.to).toEqual(['RCPT TO:<ada@example.com>'])

    received.to = []
    await mailer
      .send({ to: 'attacker@example.com, victim@example.com', subject: 'x', text: 'x' })
      .catch(() => {})
    expect(received.to.some((r) => r.includes('<victim@example.com>'))).toBe(false)
  })

  it('reports refusals as MailRejectedError with their codes, never the reply text', async () => {
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${port}`,
      from: 'Hourmere <hourmere@example.com>',
    })
    const send = (to: string) =>
      mailer.send({ to, subject: 'x', text: 'x' }).catch((err: unknown) => err)
    received.rcptReplies.set('gone@example.com', '550 5.1.1 <gone@example.com>: no such user')
    received.rcptReplies.set('later@example.com', '450 4.2.0 <later@example.com>: greylisted')
    received.rcptReplies.set(
      'relay@example.com',
      '554 5.7.1 <relay@example.com>: Relay access denied',
    )
    try {
      const gone = await send('gone@example.com')
      expect(gone).toBeInstanceOf(MailRejectedError)
      expect(gone).toMatchObject({
        responseCode: 550,
        enhancedCode: '5.1.1',
        atRecipient: true,
        recipientOnly: true,
        permanent: true,
      })
      // The reply text repeats the address; the error does not.
      expect((gone as Error).message).toBe('the mail server refused the recipient (550 5.1.1)')
      expect(await send('later@example.com')).toMatchObject({
        enhancedCode: '4.2.0',
        recipientOnly: true,
        permanent: false,
      })
      // Relaying refused: the server's problem, for every recipient.
      expect(await send('relay@example.com')).toMatchObject({
        enhancedCode: '5.7.1',
        recipientOnly: false,
        permanent: false,
      })
      // A daily sending limit, reported after DATA.
      received.dataReply = '550 5.4.5 Daily user sending quota exceeded'
      expect(await send('ada@example.com')).toMatchObject({
        responseCode: 550,
        enhancedCode: '5.4.5',
        atRecipient: false,
        recipientOnly: false,
        permanent: false,
      })
    } finally {
      received.rcptReplies.clear()
      received.dataReply = undefined
    }
  })

  it('stops waiting for a stalled server when the signal aborts', async () => {
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${port}`,
      from: 'Hourmere <hourmere@example.com>',
    })
    received.hangOnData = true
    try {
      const controller = new AbortController()
      const sending = mailer.send(
        { to: 'ada@example.com', subject: 'x', text: 'x' },
        {
          signal: controller.signal,
        },
      )
      await new Promise((r) => setTimeout(r, 200))
      const before = Date.now()
      controller.abort(new Error('shutting down'))
      await expect(sending).rejects.toThrow('shutting down')
      expect(Date.now() - before).toBeLessThan(1000)
      await expect(
        mailer.send(
          { to: 'ada@example.com', subject: 'x', text: 'x' },
          { signal: controller.signal },
        ),
      ).rejects.toThrow('shutting down')
    } finally {
      received.hangOnData = false
    }
  })

  it('refuses a server that does not offer STARTTLS when it is not on loopback', async () => {
    received.data = undefined
    // 0.0.0.0 reaches this machine without being a loopback name, so the mailer treats the
    // fake server like a remote one.
    const mailer = createSmtpMailer({
      url: `smtp://resend:secret@0.0.0.0:${port}`,
      from: 'Hourmere <hourmere@example.com>',
    })
    await expect(
      mailer.send(magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 })),
    ).rejects.toThrow(/TLS/)
    expect(received.data).toBeUndefined()
  })
})
