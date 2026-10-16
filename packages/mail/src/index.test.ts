import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogMailer, createSmtpMailer, magicLinkEmail, smtpTransportOptions } from './index.ts'

const url = 'https://cal.example.com/sign-in/confirm#token=abc&callbackURL=%2F'

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
})

/** Just enough of an SMTP server to accept one message with AUTH PLAIN. */
function fakeSmtpServer() {
  const received: { auth?: string; from?: string; to: string[]; data?: string } = { to: [] }
  const server = createServer((socket) => {
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
          socket.write('250 queued\r\n')
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
          socket.write('250 ok\r\n')
        } else if (verb === 'DATA') {
          inData = true
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        // Like a server without TLS support.
        else if (verb === 'STARTTLS') socket.write('502 5.5.1 STARTTLS not supported\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  return { server, received }
}

describe('createSmtpMailer', () => {
  const { server, received } = fakeSmtpServer()
  let port: number

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
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
