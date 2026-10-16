import nodemailer from 'nodemailer'
import { escapeHtml } from './text.ts'

export * from './booking.ts'
export * from './ics.ts'
export { escapeHtml, multiLine, singleLine, subjectLine } from './text.ts'

export interface MailAttachment {
  /** File name shown to the recipient, e.g. `invite.ics`. */
  filename: string
  /** Media type with its parameters, e.g. `text/calendar; method=REQUEST; charset=UTF-8`. */
  contentType: string
  content: string
}

export interface MailMessage {
  /** One address. It is never parsed as a list, so a comma in it cannot add recipients. */
  to: string
  subject: string
  text: string
  html?: string
  attachments?: readonly MailAttachment[]
}

/** Sends transactional email. Implementations: SMTP, the server log, and test doubles. */
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export interface SmtpMailerOptions {
  /**
   * `smtps://user:password@host:465` (TLS) or `smtp://user:password@host:587` (STARTTLS).
   * Special characters in the user or password must be percent-encoded.
   */
  url: string
  /** Sender, e.g. `Hourmere <hourmere@example.com>`. */
  from: string
}

const isLoopback = (hostname: string) => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
  )
}

/**
 * nodemailer options for SMTP_URL. `smtps:` is TLS from the first byte. `smtp:` upgrades
 * with STARTTLS, which nodemailer silently skips when a server (or someone in between) does
 * not offer it, sending the password and sign-in links in clear text; so it is required,
 * except for a relay on this machine. A `?requireTLS=false` in the URL still opts out.
 */
export function smtpTransportOptions(url: string) {
  const { protocol, hostname } = new URL(url)
  return {
    url,
    // nodemailer's defaults wait minutes for an unreachable server; a sign-in request should
    // fail within seconds. Query parameters in the URL (e.g. ?connectionTimeout=…) override.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    requireTLS: protocol === 'smtp:' && !isLoopback(hostname),
  }
}

/** Works with any SMTP provider, including Resend, Postmark and Amazon SES SMTP endpoints. */
export function createSmtpMailer({ url, from }: SmtpMailerOptions): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(url), { from })
  return {
    async send({ to, subject, text, html, attachments }) {
      await transport.sendMail({
        // An address object is taken as one address; a string would be parsed as a list.
        to: { name: '', address: to },
        // nodemailer folds long headers but would keep a line break; a subject is one line.
        subject: subject.replace(/[\r\n]+/g, ' '),
        text,
        ...(html !== undefined && { html }),
        ...(attachments?.length && {
          attachments: attachments.map(({ filename, contentType, content }) => ({
            filename,
            contentType,
            content,
          })),
        }),
      })
    },
  }
}

/**
 * Characters JSON leaves alone but terminals or log tools may treat as line breaks, and
 * bidi controls that can make a line read differently from what it contains.
 */
const LINE_BREAKING = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const unicodeEscape = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`

/**
 * Prints messages to the log instead of sending them, so a fresh self-hosted instance can
 * sign in before email is configured. Sign-in links appear in the log in full: only use it
 * where whoever can read the log may sign in as anyone.
 *
 * Each message is one line, `[mail] {json}`. Other log output has its control characters
 * escaped, so nothing a request gets into the log can imitate such a line.
 */
export function createLogMailer(print: (line: string) => void = console.log): Mailer {
  return {
    async send({ to, subject, text, attachments }) {
      const links = text.match(/https?:\/\/\S+/g) ?? []
      const record = JSON.stringify({
        notSent: 'SMTP_URL is not set',
        to,
        subject,
        links,
        text,
        // Names and sizes only: an invitation's body adds nothing a reader of the log needs.
        ...(attachments?.length && {
          attachments: attachments.map(({ filename, contentType, content }) => ({
            filename,
            contentType,
            bytes: Buffer.byteLength(content, 'utf8'),
          })),
        }),
      })
      print(`[mail] ${record.replace(LINE_BREAKING, unicodeEscape)}`)
    },
  }
}

export function magicLinkEmail({
  to,
  url,
  expiresInMinutes,
}: {
  to: string
  url: string
  expiresInMinutes: number
}): MailMessage {
  const expiry = `The link expires in ${expiresInMinutes} minutes and works once. If you did not ask to sign in, you can ignore this email.`
  const link = escapeHtml(url)
  return {
    to,
    subject: 'Sign in to Hourmere',
    text: `Sign in to Hourmere by opening this link:\n\n${url}\n\n${expiry}\n`,
    html: `<!doctype html>
<html lang="en">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
<p>Sign in to Hourmere:</p>
<p><a href="${link}" style="display: inline-block; padding: 10px 16px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">Sign in</a></p>
<p style="color: #555;">${escapeHtml(expiry)}</p>
<p style="color: #555; font-size: 13px;">If the button does not work, copy this link into your browser:<br>${link}</p>
</body>
</html>
`,
  }
}
