import { formattingLocale, interfaceLanguage } from '@hourmere/core/language'
import { mailMessage } from './catalogue.ts'
import type { MailMessage } from './index.ts'
import { emailLayout, emailLinkStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine, subjectLine } from './text.ts'

export interface MeetingPollCredentialEmailOptions {
  to: string
  publicUrl: string
  pollTitle: string
  token: string
  purpose: 'verification' | 'voting'
  optOutToken?: string | undefined
  expiresAt: Date
  timeZone: string
  language?: unknown
  defaultLanguage?: unknown
}
/** No account lookup or account-dependent wording. Links preview; confirmation is explicit. */
export function meetingPollCredentialEmail(
  options: MeetingPollCredentialEmailOptions,
): MailMessage {
  const language =
    interfaceLanguage(options.language) ?? interfaceLanguage(options.defaultLanguage) ?? 'en'
  let origin: string
  try {
    const url = new URL(options.publicUrl)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      ![url.origin, `${url.origin}/`].includes(options.publicUrl)
    )
      throw new Error()
    origin = url.origin
  } catch {
    throw new Error('Invalid meeting poll origin')
  }
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(options.token) ||
    (options.optOutToken && !/^[A-Za-z0-9_-]{43}$/.test(options.optOutToken))
  )
    throw new Error('Invalid meeting poll capability')
  if (!options.to || singleLine(options.to) !== options.to)
    throw new Error('Invalid meeting poll recipient')
  let expiry: string
  try {
    expiry = new Intl.DateTimeFormat(formattingLocale(language), {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: options.timeZone,
    }).format(options.expiresAt)
  } catch {
    throw new Error('Invalid meeting poll display time')
  }
  const values = { poll: singleLine(options.pollTitle), expiry: `${expiry} (${options.timeZone})` }
  const t = (key: Parameters<typeof mailMessage>[1]) => mailMessage(language, key, values)
  const subject = subjectLine(
    t(options.purpose === 'verification' ? 'poll.verify.subject' : 'poll.vote.subject'),
  )
  const parts = [
    {
      text: t(options.purpose === 'verification' ? 'poll.verify.body' : 'poll.vote.body'),
      url: `${origin}/poll/voter#${options.token}`,
    },
    { text: t('poll.expiry') },
    { text: t('poll.confirm') },
  ]
  if (options.optOutToken)
    parts.push({
      text: t('poll.optout'),
      url: `${origin}/poll/reminder-opt-out#${options.optOutToken}`,
    })
  return {
    sensitive: true,
    to: options.to,
    subject,
    text: `Hourmere\n\n${parts.map((p) => `${p.text}${p.url ? `\n${p.url}` : ''}`).join('\n\n')}\n`,
    html: emailLayout(
      language,
      subject,
      parts
        .map(
          (p) =>
            `<p>${emailText(p.text, language)}${p.url ? `<br><a href="${escapeHtml(p.url)}" style="${emailLinkStyle}" rel="noreferrer">${emailText(p.url, language)}</a>` : ''}</p>`,
        )
        .join('\n'),
    ),
  }
}
