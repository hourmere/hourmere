import { domainToASCII } from 'node:url'
import type { InterfaceLanguage } from '@hourmere/core/language'
import nodemailer from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser'
import SMTPTransport from 'nodemailer/lib/smtp-transport'
import { mailMessage } from './catalogue.ts'
import { emailButton, emailLayout, emailLinkStyle, emailWrapStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine } from './text.ts'

export function scimMappingEmail(
  to: string,
  language: InterfaceLanguage,
  action: 'linked' | 'unlinked' | 'suspended',
  mappingId: string,
): MailMessage {
  return {
    sensitive: true,
    to,
    subject: mailMessage(language, 'scimMapping.subject'),
    text: mailMessage(language, `scimMapping.${action}`, { mappingId }),
  }
}

export * from './booking.ts'
export * from './branding.ts'
export * from './departure-handoff.ts'
export * from './ics.ts'
export { emailLayout } from './layout.ts'
export * from './team-invitation.ts'
export { escapeHtml, formatChineseTemplate, multiLine, singleLine, subjectLine } from './text.ts'
export * from './waitlist.ts'

export interface MailAttachment {
  /** File name shown to the recipient, e.g. `invite.ics`. */
  filename: string
  /** Media type with its parameters, e.g. `text/calendar; method=REQUEST; charset=UTF-8`. */
  contentType: string
  content: string
  /** Inline uploaded logo bytes, never a remote URL or local file path. */
  encoding?: 'base64'
  cid?: string
}

export interface MailMessage {
  /** Private message content and capabilities must never appear in the development log mailer. */
  sensitive?: boolean | undefined
  /** One address. It is never parsed as a list, so a comma in it cannot add recipients. */
  to: string
  /** People a human email reply should reach; never overrides the configured From. */
  replyTo?: { name: string; email: string } | readonly { name: string; email: string }[] | undefined
  /** An application-generated Message-ID, stable across attempts for the same intent. */
  messageId?: string
  subject: string
  text: string
  html?: string
  attachments?: readonly MailAttachment[]
}

export interface SendOptions {
  /**
   * Stops waiting for the mail server: send() then rejects with the signal's reason. The SMTP
   * exchange already under way is not cut off and may still finish in the background.
   */
  signal?: AbortSignal | undefined
}

/**
 * Sends transactional email. Implementations: SMTP, the server log, and test doubles. A send
 * the mail server refuses with a reply (rather than failing to reach it) rejects with a
 * MailRejectedError.
 */
export interface Mailer {
  /** One configured SMTP sender mailbox, used to align iMIP's organizer and email From. */
  readonly senderEmail?: string | undefined
  send(message: MailMessage, options?: SendOptions): Promise<void>
  /** One SMTP exchange, with no transport-level requeue. */
  sendWorkflowAttempt?(message: MailMessage): Promise<WorkflowSmtpAttemptOutcome>
}

export type WorkflowSmtpAttemptOutcome = 'sent' | 'known_not_sent' | 'rejected' | 'delivery_unknown'

/** Only an SMTP-aware mailer can report acceptance or positively classify a safe retry. */
export async function sendWorkflowSmtpAttempt(
  mailer: Mailer,
  message: MailMessage,
): Promise<WorkflowSmtpAttemptOutcome> {
  try {
    return (await mailer.sendWorkflowAttempt?.(message)) ?? 'delivery_unknown'
  } catch {
    return 'delivery_unknown'
  }
}

export interface MailRefusal {
  /** The SMTP reply code, e.g. 550. */
  responseCode?: number | undefined
  /** The RFC 3463 enhanced status code, e.g. `5.1.1`. */
  enhancedCode?: string | undefined
  /** Refused at RCPT TO (this address), rather than at DATA (the message). */
  atRecipient: boolean
}

/**
 * The mail server refused this message or its recipient with a reply, as opposed to a failed
 * connection, TLS or sign-in. The message carries the reply codes only, never the reply
 * text, which usually repeats the address.
 *
 * Most refusals say nothing about the address: relaying or policy (5.7.x), quotas and rate
 * limits (5.2.2, 5.4.x, 5.5.x), a refused message at DATA. They can change, and they hit every
 * recipient alike, so callers should treat them like an unreachable server: stop and retry.
 */
export class MailRejectedError extends Error {
  override name = 'MailRejectedError'
  readonly responseCode: number | undefined
  readonly enhancedCode: string | undefined
  readonly atRecipient: boolean
  /**
   * The refusal is about this address only, so other recipients may still be sent to: at
   * RCPT TO, with a mailbox or domain status (x.1.x, x.2.x), or without an enhanced code a
   * 450, 550, 551, 552 or 553.
   */
  readonly recipientOnly: boolean
  /**
   * The address itself will never take mail: a recipient-only refusal with 5.1.x (no such
   * mailbox or domain) or 5.2.1 (mailbox disabled), or without an enhanced code 550, 551 or
   * 553. A full mailbox (5.2.2, 552) may empty, so it is not permanent.
   */
  readonly permanent: boolean

  constructor({ responseCode, enhancedCode, atRecipient }: MailRefusal) {
    const codes = [responseCode, enhancedCode].filter(Boolean).join(' ')
    super(
      `the mail server refused the ${atRecipient ? 'recipient' : 'message'}${codes ? ` (${codes})` : ''}`,
    )
    this.responseCode = responseCode
    this.enhancedCode = enhancedCode
    this.atRecipient = atRecipient
    this.recipientOnly =
      atRecipient &&
      (enhancedCode
        ? /^[45]\.[12]\.\d{1,3}$/.test(enhancedCode)
        : [450, 550, 551, 552, 553].includes(responseCode ?? 0))
    this.permanent =
      this.recipientOnly &&
      (enhancedCode
        ? /^5\.1\.\d{1,3}$/.test(enhancedCode) || enhancedCode === '5.2.1'
        : [550, 551, 553].includes(responseCode ?? 0))
  }
}

/**
 * A nodemailer error for a refused recipient (RCPT TO) or message (DATA), as our error. Only
 * the numeric codes are read from the reply.
 */
function refusal(err: unknown): MailRejectedError | undefined {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown
    command?: unknown
    responseCode?: unknown
    response?: unknown
  }
  const atRecipient = e.code === 'EENVELOPE' && e.command === 'RCPT TO'
  if (!atRecipient && !(e.code === 'EMESSAGE' && e.command === 'DATA')) return undefined
  const enhancedCode =
    typeof e.response === 'string'
      ? e.response.match(/^\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})(?:\s|$)/)?.[1]
      : undefined
  return new MailRejectedError({
    responseCode: typeof e.responseCode === 'number' ? e.responseCode : undefined,
    enhancedCode,
    atRecipient,
  })
}

/** Use only positive pre-envelope evidence. Nodemailer also uses CONN for post-DATA errors. */
function workflowSmtpFailure(err: unknown): Exclude<WorkflowSmtpAttemptOutcome, 'sent'> {
  const { code, command, message, responseCode, syscall, timeoutType } = (
    typeof err === 'object' && err !== null ? err : {}
  ) as {
    code?: unknown
    command?: unknown
    message?: unknown
    responseCode?: unknown
    syscall?: unknown
    timeoutType?: unknown
  }
  if (
    code === 'EAUTH' ||
    (code === 'ECONNECTION' && command === 'EHLO') ||
    (code === 'EPROTOCOL' && (command === 'HELO' || command === 'LHLO')) ||
    (code === 'ETLS' && command === 'STARTTLS') ||
    (command === 'CONN' &&
      (code === 'EDNS' ||
        ((code === 'ESOCKET' || code === 'ECONNECTION') && syscall === 'connect') ||
        (code === 'ETIMEDOUT' &&
          (timeoutType === 'CONNECT_TIMEOUT' ||
            timeoutType === 'GREETING_TIMEOUT' ||
            timeoutType === 'UPGRADE_TIMEOUT')) ||
        (code === 'EPROTOCOL' &&
          typeof message === 'string' &&
          message.startsWith('Invalid greeting. response='))))
  )
    return 'known_not_sent'
  if (
    typeof responseCode === 'number' &&
    responseCode >= 500 &&
    responseCode < 600 &&
    ((code === 'EENVELOPE' && (command === 'MAIL FROM' || command === 'RCPT TO')) ||
      ((code === 'EENVELOPE' || code === 'EMESSAGE') && command === 'DATA'))
  )
    return 'rejected'
  return 'delivery_unknown'
}

/** Settles like `promise`, or rejects with the signal's reason as soon as it is aborted. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export interface SmtpMailerOptions {
  /**
   * `smtps://user:password@host:465` (TLS) or `smtp://user:password@host:587` (STARTTLS).
   * Special characters in the user or password must be percent-encoded.
   */
  url: string
  /** One sender mailbox, e.g. `Hourmere <hourmere@example.com>`. */
  from: string
}

/** An unquoted mailbox safe in both a structured email header and a calendar mailto URI. */
function isMailbox(address: string): boolean {
  const parts = address.split('@')
  const [local, domain] = parts
  if (parts.length !== 2 || !local || !domain || address.length > 254 || local.length > 64) {
    return false
  }
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) {
    return false
  }
  // domainToASCII uses URL host parsing, which can silently discard a path or controls.
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(domain)) return false
  const ascii = domainToASCII(domain)
  return (
    ascii.length > 0 &&
    ascii.length <= 253 &&
    ascii.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
}

/** Reject addressparser's recovery of malformed lists: MAIL_FROM must mean exactly one mailbox. */
function senderMailbox(from: string): string {
  const entries = addressparser(from)
  const entry = entries[0]
  // Only a bare address or one optional display name followed by <address> is supported.
  // A quoted display name can contain commas; unquoted separators and comments are refused.
  const value = from.trim()
  const opening = value.lastIndexOf('<')
  const displayName = value.slice(0, opening).trimEnd()
  // Split before validating either segment so whitespace cannot be redistributed between
  // overlapping regex repetitions during a failed match.
  const validName =
    /^"(?:[^"\\]|\\.)*"$/u.test(displayName) || !/["<>@,;:()[\]\\]/u.test(displayName)
  const angleAddress =
    opening !== -1 && value.endsWith('>') && validName ? value.slice(opening + 1, -1) : undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject header and display controls
  const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
  if (
    controls.test(from) ||
    entries.length !== 1 ||
    !entry?.address ||
    entry.group ||
    !isMailbox(entry.address) ||
    (value !== entry.address && angleAddress !== entry.address)
  ) {
    throw new Error('MAIL_FROM must contain one valid mailbox')
  }
  return entry.address
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
  const senderEmail = senderMailbox(from)
  const transport = nodemailer.createTransport(smtpTransportOptions(url), { from })
  const privateUrl = new URL(url)
  const logsEnabled = privateUrl.searchParams.has('logger')
  for (const key of ['logger', 'debug', 'transactionLog']) privateUrl.searchParams.delete(key)
  let privateTransport: typeof transport | undefined
  let workflowTransport: typeof transport | undefined
  function sendSmtp(
    smtp: typeof transport,
    { to, replyTo, messageId, subject, text, html, attachments }: MailMessage,
  ) {
    // Reply-To is optional user input. A booking may accept an address SMTP cannot
    // represent here; omit it rather than preventing every recipient's notification.
    const safeReplyTo = (Array.isArray(replyTo) ? replyTo : replyTo ? [replyTo] : [])
      .filter((person) => isMailbox(person.email))
      .filter(
        (person, index, people) =>
          people.findIndex((p) => p.email.toLowerCase() === person.email.toLowerCase()) === index,
      )
      .map((person) => ({ name: singleLine(person.name), address: person.email }))
    const calendar = attachments?.find((a) =>
      /^text\/calendar; method=(REQUEST|CANCEL); charset=UTF-8$/.test(a.contentType),
    )
    const calendarMethod = calendar?.contentType.match(/method=(REQUEST|CANCEL);/)?.[1]
    const files = attachments?.filter((a) => a !== calendar)
    return smtp.sendMail({
      // An address object is taken as one address; a string would be parsed as a list.
      to: { name: '', address: to },
      ...(safeReplyTo.length && { replyTo: safeReplyTo }),
      ...(messageId !== undefined && { messageId }),
      // nodemailer folds long headers but would keep a line break; a subject is one line.
      subject: subject.replace(/[\r\n]+/g, ' '),
      text,
      ...(html !== undefined && { html }),
      // iMIP clients need the calendar alternative. Nodemailer also emits an application/ics
      // attachment for clients that import files, while retaining our text and HTML bodies.
      ...(calendar && {
        icalEvent: {
          filename: calendar.filename,
          content: calendar.content,
          method: calendarMethod,
        },
      }),
      ...(files?.length && {
        attachments: files.map(({ filename, contentType, content, encoding, cid }) => ({
          filename,
          contentType,
          content,
          ...(encoding && { encoding }),
          ...(cid && { cid }),
        })),
      }),
    })
  }
  return {
    senderEmail,
    async send(message, { signal } = {}) {
      signal?.throwIfAborted()
      // SMTP debugging can print the full MIME body. Sensitive mail shares the same
      // sender and transport settings with protocol logging disabled.
      let smtp = transport
      if (logsEnabled && message.sensitive) {
        privateTransport ??= nodemailer.createTransport(smtpTransportOptions(privateUrl.href), {
          from,
        })
        smtp = privateTransport
      }
      await abortable(
        sendSmtp(smtp, message).catch((err: unknown) => {
          throw refusal(err) ?? err
        }),
        signal,
      )
    },
    async sendWorkflowAttempt(message) {
      try {
        if (!workflowTransport) {
          // SMTP_URL can request a pool that automatically requeues a disconnected send.
          // Pick the single-exchange transport explicitly and keep protocol logs private.
          const workflowUrl = new URL(privateUrl)
          workflowUrl.searchParams.delete('lmtp')
          workflowTransport = nodemailer.createTransport(
            new SMTPTransport(smtpTransportOptions(workflowUrl.toString())),
            { from },
          )
        }
        await sendSmtp(workflowTransport, message)
        return 'sent'
      } catch (err) {
        return workflowSmtpFailure(err)
      }
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
    async send({ to, subject, text, attachments, sensitive }, { signal } = {}) {
      signal?.throwIfAborted()
      if (sensitive) {
        print(`[mail] ${JSON.stringify({ notSent: 'SMTP_URL is not set', sensitive: true })}`)
        return
      }
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

/**
 * A mailbox proof link for an SSO attempt (docs/sso.md, Mailbox proof). One template for every
 * recipient: it names no account, team or provider, so the message is the same whether or not
 * the address belongs to a Hourmere account.
 */
export function mailboxProofEmail({
  to,
  url,
  expiresInMinutes,
  language = 'en',
}: {
  to: string
  url: string
  expiresInMinutes: number
  language?: InterfaceLanguage | undefined
}): MailMessage {
  const t = (key: Parameters<typeof mailMessage>[1]) =>
    mailMessage(language, key, { minutes: String(expiresInMinutes) })
  const words = {
    subject: t('mailboxProof.subject'),
    instruction: t('mailboxProof.instruction'),
    htmlInstruction: t('mailboxProof.htmlInstruction'),
    button: t('mailboxProof.button'),
    expiry: t('mailboxProof.expiry'),
    fallback: t('mailboxProof.fallback'),
    footer: t('mailboxProof.footer'),
  }
  const link = escapeHtml(url)
  // The link opens an inert page whose button confirms, so a mail scanner opening it does not.
  return {
    to,
    subject: words.subject,
    text: `Hourmere\n\n${words.instruction}\n\n${url}\n\n${words.expiry}\n\n${words.footer}\n`,
    html: emailLayout(
      language,
      words.subject,
      `<p>${emailText(words.htmlInstruction, language)}</p>
${emailButton(words.button, url, false, language)}
<p style="color: #555;">${emailText(words.expiry, language)}</p>
<p style="color: #555; font-size: 13px; ${emailWrapStyle}">${emailText(words.fallback, language)}<br><a href="${link}" style="${emailLinkStyle}">${emailText(url, language)}</a></p>
<p style="margin-top: 24px; border-top: 1px solid #ddd; padding-top: 16px; color: #555; font-size: 13px;">${emailText(words.footer, language)}</p>`,
    ),
  }
}

/** Notice to the affected account's verified login mailbox after an SSO link is retired. */
export function ssoLinkRemovalEmail(to: string, language: InterfaceLanguage): MailMessage {
  const subject = mailMessage(language, 'ssoLinkRemoval.subject')
  const message = mailMessage(language, 'ssoLinkRemoval.message')
  return { to, subject, text: `Hourmere\n\n${message}\n`, sensitive: true }
}

/** Recovery notices use verified login mailboxes and contain no team metadata. */
export function ssoRecoveryEnrollmentEmail(
  to: string,
  language: InterfaceLanguage,
  nominationLink?: URL,
): MailMessage {
  const kind = nominationLink ? 'nominated' : 'enrolled'
  const subject = mailMessage(language, `ssoRecovery.${kind}.subject`)
  const message = mailMessage(language, `ssoRecovery.${kind}.message`)
  const link = nominationLink ? `\n\n${nominationLink.href}` : ''
  return { to, subject, text: `Hourmere\n\n${message}${link}\n`, sensitive: true }
}

/** Recovery activity notice for current team owners. */
export function ssoRecoveryUseEmail(to: string, language: InterfaceLanguage): MailMessage {
  const subject = mailMessage(language, 'ssoRecovery.used.subject')
  const message = mailMessage(language, 'ssoRecovery.used.message')
  return { to, subject, text: `Hourmere\n\n${message}\n`, sensitive: true }
}

/** Security notice after an instance operator turns off team SSO enforcement. */
export function ssoOperatorRecoveryEmail(to: string, language: InterfaceLanguage): MailMessage {
  const subject = mailMessage(language, 'ssoRecovery.operator.subject')
  const message = mailMessage(language, 'ssoRecovery.operator.message')
  return { to, subject, text: `Hourmere\n\n${message}\n`, sensitive: true }
}

export function ownershipTransferEmail({
  to,
  language,
  kind,
  teamName,
  link,
}: {
  to: string
  language: InterfaceLanguage
  kind: 'offered' | 'confirmed'
  teamName: string
  link: URL
}): MailMessage {
  const subject = mailMessage(language, `ownershipTransfer.${kind}.subject`)
  const message = mailMessage(language, `ownershipTransfer.${kind}.message`, {
    team: singleLine(teamName),
  })
  return { to, subject, text: `Hourmere\n\n${message}\n\n${link.href}\n`, sensitive: true }
}

export function magicLinkEmail({
  to,
  url,
  expiresInMinutes,
  language = 'en',
}: {
  to: string
  url: string
  expiresInMinutes: number
  language?: InterfaceLanguage | undefined
}): MailMessage {
  const t = (key: Parameters<typeof mailMessage>[1]) =>
    mailMessage(language, key, { minutes: String(expiresInMinutes) })
  const words = {
    subject: t('signIn.subject'),
    instruction: t('signIn.instruction'),
    htmlInstruction: t('signIn.htmlInstruction'),
    button: t('signIn.button'),
    expiry: t('signIn.expiry'),
    fallback: t('signIn.fallback'),
    footer: t('signIn.footer'),
  }
  const link = escapeHtml(url)
  // The link opens a page whose button signs in (so that mail scanners opening the link do
  // not use it up).
  return {
    to,
    subject: words.subject,
    text: `Hourmere\n\n${words.instruction}\n\n${url}\n\n${words.expiry}\n\n${words.footer}\n`,
    html: emailLayout(
      language,
      words.subject,
      `<p>${emailText(words.htmlInstruction, language)}</p>
${emailButton(words.button, url, false, language)}
<p style="color: #555;">${emailText(words.expiry, language)}</p>
<p style="color: #555; font-size: 13px; ${emailWrapStyle}">${emailText(words.fallback, language)}<br><a href="${link}" style="${emailLinkStyle}">${emailText(url, language)}</a></p>
<p style="margin-top: 24px; border-top: 1px solid #ddd; padding-top: 16px; color: #555; font-size: 13px;">${emailText(words.footer, language)}</p>`,
    ),
  }
}

export * from './meeting-polls.ts'
