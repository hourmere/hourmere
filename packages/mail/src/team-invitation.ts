// Rendering only. Invitation business state and eventual mail delivery belong to callers.
import { type InterfaceLanguage, interfaceLanguage } from '@hourmere/core/language'
import { mailContent, mailMessage } from './catalogue.ts'
import { formatMailDateTime } from './date-time.ts'
import type { MailMessage } from './index.ts'
import { emailButton, emailLayout, emailLinkStyle, emailWrapStyle } from './layout.ts'
import { emailUserText, emailUserValue, escapeHtml, singleLine, subjectLine } from './text.ts'

export type TeamInvitationEmailOptions = {
  /** The exact invited address; never substitute an alias or the inviter's address. */
  to: string
  /** Trusted instance configuration (PUBLIC_URL), never a request URL or callback. */
  publicUrl: string
  invitationId: string
  teamName: string
  /** Better Auth returns Date objects directly and ISO timestamps over HTTP. */
  expiresAt: Date | string
  /** Explicit language, then instance default, then English. No URL negotiation. */
  language?: unknown
  defaultLanguage?: unknown
} & (
  | {
      scimIssued?: false
      /** Display name only; an empty name uses a generic localized label. */
      inviterName: string
    }
  | { scimIssued: true; inviterName?: never }
)

function acceptUrl(publicUrl: string, invitationId: string): string {
  let origin: string
  try {
    const url = new URL(publicUrl)
    origin = url.origin
    // Require a canonical HTTP(S) origin (an optional trailing slash is harmless).
    // Exact comparison also refuses controls, credentials, empty ?/# and URL parser repair.
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (publicUrl !== origin && publicUrl !== `${origin}/`)
    ) {
      throw new Error()
    }
  } catch {
    // URL parsing errors include the input; never let a caller log a usable link that way.
    throw new Error('Invalid invitation instance origin')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invitationId)) {
    throw new Error('Invalid invitation ID')
  }
  // Fixed page from the team-join contract. No supplied path, accept URL or callback.
  const url = new URL('/app/join', origin)
  url.searchParams.set('invitationId', invitationId)
  return url.href
}

function expiryText(expiresAt: Date | string, language: InterfaceLanguage): string {
  try {
    const instant = Temporal.Instant.from(
      expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
    )
    const time = instant.toZonedDateTimeISO('UTC')
    const date = mailMessage(language, 'format.dateTime', {
      date: formatMailDateTime(time, { dateStyle: 'long' }, language),
      time: formatMailDateTime(
        time,
        { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
        language,
      ),
    })
    return language === 'zh-CN' ? `${date}（UTC）` : `${date} UTC`
  } catch {
    throw new Error('Invalid invitation expiry')
  }
}

const safeText = (value: string) => singleLine(value.toWellFormed())

/**
 * Render a team invitation without sending or accepting it. The configured origin is the
 * only authority for links; the result must keep its sensitive flag through later delivery.
 */
export function teamInvitationEmail({
  to,
  publicUrl,
  invitationId,
  teamName,
  scimIssued,
  inviterName,
  expiresAt,
  language: chosenLanguage,
  defaultLanguage,
}: TeamInvitationEmailOptions): MailMessage {
  const language = interfaceLanguage(chosenLanguage) ?? interfaceLanguage(defaultLanguage) ?? 'en'
  const url = acceptUrl(publicUrl, invitationId)
  const expiry = expiryText(expiresAt, language)
  if (!to || safeText(to) !== to) throw new Error('Invalid invitation recipient')
  const team = safeText(teamName)
  const inviter = scimIssued ? undefined : safeText(inviterName)
  const values = {
    team: team
      ? emailUserValue(team, language)
      : mailMessage(language, 'teamInvitation.defaultTeam'),
    inviter: inviter
      ? emailUserValue(inviter, language)
      : mailMessage(language, 'teamInvitation.defaultInviter'),
    email: emailUserValue(to, language, 'ltr'),
    expiry,
  }
  const t = (key: Parameters<typeof mailMessage>[1]) => mailContent(language, key, values)
  // The shared header limit counts UTF-16 units and can split an astral character.
  const subject = subjectLine(t('teamInvitation.subject').text).toWellFormed()
  const facts = [
    t(scimIssued ? 'teamInvitation.scimIntroduction' : 'teamInvitation.introduction'),
    t('teamInvitation.identity'),
    t('teamInvitation.acceptance'),
    t('teamInvitation.expiry'),
  ]
  const button = t('teamInvitation.button').text
  const footer = t('teamInvitation.footer')
  return {
    sensitive: true,
    to,
    subject,
    text: `Hourmere\n\n${facts.map(({ text }) => text).join('\n\n')}\n\n${button}\n${url}\n\n${footer.text}\n`,
    html: emailLayout(
      language,
      subject,
      `${facts.map(({ html }) => `<p>${html}</p>`).join('\n')}
${emailButton(button, url, false, language)}
<p style="color: #555; font-size: 13px; ${emailWrapStyle}">${t('teamInvitation.fallback').html}<br><a href="${escapeHtml(url)}" style="${emailLinkStyle}">${emailUserText(url, language, 'ltr')}</a></p>
<p style="margin-top: 24px; border-top: 1px solid #ddd; padding-top: 16px; color: #555; font-size: 13px;">${footer.html}</p>`,
    ),
  }
}
