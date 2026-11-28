import { interfaceLanguage } from '@hourmere/core/language'
import { mailMessage } from './catalogue.ts'
import type { MailMessage } from './index.ts'
import { emailLayout, emailLinkStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine } from './text.ts'

export function departureHandoffEmail(input: {
  to: string
  publicUrl: string
  recipientId: string
  secret: string
  locale: string | null | undefined
}): MailMessage {
  const origin = new URL(input.publicUrl)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    ![origin.origin, `${origin.origin}/`].includes(input.publicUrl) ||
    !input.to ||
    singleLine(input.to) !== input.to ||
    !/^[a-f0-9-]{36}$/.test(input.recipientId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.secret)
  )
    throw new Error('handoff_email_invalid_input')
  const language = interfaceLanguage(input.locale) ?? 'en'
  const subject = mailMessage(language, 'departureHandoff.subject')
  const introduction = mailMessage(language, 'departureHandoff.introduction')
  const privacy = mailMessage(language, 'departureHandoff.privacy')
  const link = mailMessage(language, 'departureHandoff.review')
  const url = `${origin.origin}/booking/handoff#token=${input.recipientId}.${input.secret}`
  return {
    to: input.to,
    sensitive: true,
    subject,
    text: `Hourmere\n\n${introduction}\n\n${privacy}\n\n${link}\n${url}\n`,
    html: emailLayout(
      language,
      subject,
      `<p>${emailText(introduction, language)}</p><p>${emailText(privacy, language)}</p><p><a href="${escapeHtml(url)}" style="${emailLinkStyle}" rel="noreferrer">${emailText(link, language)}</a></p>`,
    ),
  }
}
