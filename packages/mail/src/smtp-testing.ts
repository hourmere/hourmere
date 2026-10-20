import { createServer, type Socket } from 'node:net'

/**
 * Just enough of an SMTP server to accept one message with AUTH PLAIN. `rcptReplies` answers
 * RCPT TO for an address with something other than 250; with `hangOnData` it never answers
 * DATA, like a server that stalls.
 */
export function fakeSmtpServer() {
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
