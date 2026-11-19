import { createServer, type Socket } from 'node:net'

/**
 * A loopback SMTP server with AUTH PLAIN. Reply overrides exercise rejections at each phase.
 * `hangOnData` stalls before the message body, and `disconnectAfterData` drops the connection
 * after receiving the entire body without saying whether the message was accepted.
 */
export function fakeSmtpServer() {
  const received: {
    auth?: string
    from?: string
    to: string[]
    data?: string
    connections: number
    messages: string[]
    greetingReply?: string
    authReply?: string
    mailReply?: string
    rcptReplies: Map<string, string>
    dataStartReply?: string
    hangOnData: boolean
    disconnectAfterData: boolean
    dataReply?: string
  } = {
    to: [],
    connections: 0,
    messages: [],
    rcptReplies: new Map(),
    hangOnData: false,
    disconnectAfterData: false,
  }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    received.connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let inData = false
    socket.write(`${received.greetingReply ?? '220 localhost ESMTP'}\r\n`)
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) return
          received.data = buffer.slice(0, end)
          received.messages.push(received.data)
          buffer = buffer.slice(end + 5)
          inData = false
          if (received.disconnectAfterData) {
            socket.destroy()
            return
          }
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
          socket.write(`${received.authReply ?? '235 ok'}\r\n`)
        } else if (verb === 'MAIL') {
          received.from = line
          socket.write(`${received.mailReply ?? '250 ok'}\r\n`)
        } else if (verb === 'RCPT') {
          received.to.push(line)
          const address = line.match(/<([^>]*)>/)?.[1] ?? ''
          socket.write(`${received.rcptReplies.get(address) ?? '250 ok'}\r\n`)
        } else if (verb === 'DATA') {
          if (received.hangOnData) continue
          const reply = received.dataStartReply ?? '354 go'
          inData = reply.startsWith('354')
          socket.write(`${reply}\r\n`)
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        // Like a server without TLS support.
        else if (verb === 'STARTTLS') socket.write('502 5.5.1 STARTTLS not supported\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  return { server, received, sockets }
}
