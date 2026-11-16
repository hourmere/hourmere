import { createSmtpMailer, type Mailer } from '@hourmere/mail'
import { fakeSmtpServer } from '../../../mail/src/smtp-testing.ts'

/** One message as the real SMTP mailer put it on the wire, with every part decoded. */
export interface RawMessage {
  /** The `to` the caller asked for. */
  to: string
  /** RCPT TO addresses of this SMTP transaction. */
  envelope: string[]
  raw: string
  /** Unfolded header lines of the top-level message. */
  headers: string[]
  /** The raw message plus every decoded part and encoded word, unfolded. */
  decoded: string
  /** `decoded`, lower-cased, for searching. */
  text: string
  /** The decoded text/calendar part, if any, with folded lines joined. */
  ics: string | undefined
}

/** RFC 5322 / RFC 5545 folding: a line break followed by a space or tab continues a line. */
export const unfold = (value: string) => value.replace(/\r?\n[ \t]/g, '')

export function decodeQuotedPrintable(body: string) {
  const bytes: number[] = []
  const soft = body.replace(/=\r?\n/g, '')
  for (let i = 0; i < soft.length; i++) {
    const hex = soft[i] === '=' ? soft.slice(i + 1, i + 3) : ''
    if (/^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      i += 2
    } else bytes.push(...Buffer.from(soft[i] as string, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Every MIME part's body decoded (base64, quoted-printable), plus RFC 2047 encoded words. */
export function decodeMime(raw: string): Omit<RawMessage, 'to' | 'envelope'> {
  const parts: string[] = [unfold(raw)]
  let ics: string | undefined
  const partPattern = /((?:^[^\r\n]+\r\n)+)\r\n([\s\S]*?)(?=\r\n--|$(?![\s\S]))/gm
  for (const [, head = '', body = ''] of raw.matchAll(partPattern)) {
    const unfolded = unfold(head)
    const encoding = unfolded.match(/^Content-Transfer-Encoding:\s*([\w-]+)/im)?.[1]?.toLowerCase()
    const decoded =
      encoding === 'base64'
        ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
        : encoding === 'quoted-printable'
          ? decodeQuotedPrintable(body)
          : body
    if (/^Content-Type:\s*text\/calendar/im.test(unfolded)) ics ??= unfold(decoded)
    parts.push(unfold(decoded))
  }
  for (const [, charset, kind, word = ''] of raw.matchAll(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi))
    parts.push(
      charset && kind?.toUpperCase() === 'B'
        ? Buffer.from(word, 'base64').toString('utf8')
        : decodeQuotedPrintable(word.replaceAll('_', ' ')),
    )
  return {
    raw,
    headers: unfold(raw.split('\r\n\r\n')[0] ?? '').split('\r\n'),
    decoded: parts.join('\n'),
    text: parts.join('\n').toLowerCase(),
    ics,
  }
}

/** Header values by name, case-insensitive. */
export const headerValues = (message: Pick<RawMessage, 'headers'>, name: string) =>
  message.headers
    .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    .map((line) => line.slice(name.length + 1).trim())

/**
 * The real SMTP mailer against a local fake server; every accepted message is captured raw.
 * Close it in afterAll.
 */
export async function rawMailCapture(from: string) {
  const smtp = fakeSmtpServer()
  await new Promise<void>((resolve) => smtp.server.listen(0, '127.0.0.1', resolve))
  const port = (smtp.server.address() as { port: number }).port
  const smtpMailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from })
  const sent: RawMessage[] = []
  const mailer: Mailer = {
    senderEmail: smtpMailer.senderEmail,
    async send(message, options) {
      smtp.received.data = undefined
      smtp.received.to = []
      await smtpMailer.send(message, options)
      sent.push({
        ...decodeMime(smtp.received.data ?? ''),
        to: message.to,
        envelope: smtp.received.to.map((line) => line.match(/<([^>]*)>/)?.[1] ?? line),
      })
    },
  }
  return {
    mailer,
    sent,
    async close() {
      for (const socket of smtp.sockets) socket.destroy()
      await new Promise<void>((resolve) => smtp.server.close(() => resolve()))
    },
  }
}
