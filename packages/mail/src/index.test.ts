import { createServer, type Server, type Socket } from 'node:net'
import addressparser from 'nodemailer/lib/addressparser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createLogMailer,
  createSmtpMailer,
  icsAttachment,
  MailRejectedError,
  magicLinkEmail,
  smtpTransportOptions,
} from './index.ts'

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
  it('puts the link in the text and, escaped, in the HTML', () => {
    const m = magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 })
    expect(m).toMatchObject({ to: 'ada@example.com', subject: 'Sign in to Hourmere' })
    expect(m.text).toContain(url)
    expect(m.text).toContain('5 minutes')
    // The link opens a page; its button signs in.
    expect(m.text).toContain('then press "Sign in to Hourmere" on the page it opens')
    expect(m.html).toContain('then "Sign in to Hourmere" on the page it opens')
    expect(m.html).toContain(`href="${url.replace('&', '&amp;')}"`)
    expect(m.html).not.toContain('token=abc&callbackURL')
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
      links: [url],
    })
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

/**
 * Just enough of an SMTP server to accept one message with AUTH PLAIN. `rcptReplies` answers
 * RCPT TO for an address with something other than 250; with `hangOnData` it never answers
 * DATA, like a server that stalls.
 */
function fakeSmtpServer() {
  const received: {
    auth?: string
    from?: string
    to: string[]
    data?: string
    rcptReplies: Map<string, string>
    hangOnData: boolean
    dataReply?: string
  } = { to: [], rcptReplies: new Map(), hangOnData: false }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let inData = false
    socket.write('220 localhost ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) return
          received.data = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write(`${received.dataReply ?? '250 queued'}\r\n`)
          continue
        }
        const eol = buffer.indexOf('\r\n')
        if (eol === -1) return
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        const verb = line.split(' ')[0]?.toUpperCase()
        if (verb === 'EHLO') socket.write('250-localhost\r\n250 AUTH PLAIN\r\n')
        else if (verb === 'AUTH') {
          received.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8')
          socket.write('235 ok\r\n')
        } else if (verb === 'MAIL') {
          received.from = line
          socket.write('250 ok\r\n')
        } else if (verb === 'RCPT') {
          received.to.push(line)
          const address = line.match(/<([^>]*)>/)?.[1] ?? ''
          socket.write(`${received.rcptReplies.get(address) ?? '250 ok'}\r\n`)
        } else if (verb === 'DATA') {
          if (received.hangOnData) continue
          inData = true
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        // Like a server without TLS support.
        else if (verb === 'STARTTLS') socket.write('502 5.5.1 STARTTLS not supported\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  return { server, received, sockets }
}

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
  ])('rejects a Reply-To list or header injection as one unsafe mailbox', async (email) => {
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
    ).rejects.toThrow('Reply-To must be one valid mailbox')
    expect(received.to).toEqual([])
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
