import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogMailer, createSmtpMailer, magicLinkEmail } from './index.ts'

const url = 'https://cal.example.com/api/auth/magic-link/verify?token=abc&callbackURL=%2F'

describe('magicLinkEmail', () => {
  it('puts the link in the text and, escaped, in the HTML', () => {
    const m = magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 })
    expect(m).toMatchObject({ to: 'ada@example.com', subject: 'Sign in to Hourmere' })
    expect(m.text).toContain(url)
    expect(m.text).toContain('5 minutes')
    expect(m.html).toContain(`href="${url.replace('&', '&amp;')}"`)
    expect(m.html).not.toContain('token=abc&callbackURL')
  })
})

describe('createLogMailer', () => {
  it('prints the whole message, including the link', async () => {
    const lines: string[] = []
    await createLogMailer((l) => lines.push(l)).send(
      magicLinkEmail({ to: 'ada@example.com', url, expiresInMinutes: 5 }),
    )
    expect(lines.join('\n')).toContain('To: ada@example.com')
    expect(lines.join('\n')).toContain(url)
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
})
