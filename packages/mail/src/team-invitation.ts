// Rendering only. Invitation business state and eventual mail delivery belong to callers.
import { interfaceLanguage } from '@hourmere/core/language'
import { mailMessage } from './catalogue.ts'
import type { MailMessage } from './index.ts'
import { emailButton, emailLayout, emailLinkStyle, emailWrapStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine, subjectLine } from './text.ts'

export interface TeamInvitationEmailOptions {
  /** The exact invited address; never substitute an alias or the inviter's address. */
  to: string
  /** Trusted instance configuration (PUBLIC_URL), never a request URL or callback. */
  publicUrl: string
  invitationId: string
  teamName: string
  /** Display name only; an empty name uses a generic localized label, never an email. */
  inviterName: string
  /** Better Auth returns Date objects directly and ISO timestamps over HTTP. */
  expiresAt: Date | string
  /** Explicit inviter choice, then instance default, then English. No URL negotiation. */
  language?: unknown
  defaultLanguage?: unknown
}

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

function expiryText(expiresAt: Date | string): string {
  try {
    const instant = Temporal.Instant.from(
      expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
    )
    return instant.toString().replace('T', ' ').replace(/Z$/, ' UTC')
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
  inviterName,
  expiresAt,
  language: chosenLanguage,
  defaultLanguage,
}: TeamInvitationEmailOptions): MailMessage {
  const language = interfaceLanguage(chosenLanguage) ?? interfaceLanguage(defaultLanguage) ?? 'en'
  const url = acceptUrl(publicUrl, invitationId)
  const expiry = expiryText(expiresAt)
  if (!to || safeText(to) !== to) throw new Error('Invalid invitation recipient')
  const team = safeText(teamName) || mailMessage(language, 'teamInvitation.defaultTeam')
  const inviter = safeText(inviterName) || mailMessage(language, 'teamInvitation.defaultInviter')
  const t = (key: Parameters<typeof mailMessage>[1]) =>
    mailMessage(language, key, { team, inviter, email: to, expiry })
  const words = {
    subject: t('teamInvitation.subject'),
    introduction: t('teamInvitation.introduction'),
    identity: t('teamInvitation.identity'),
    acceptance: t('teamInvitation.acceptance'),
    expiry: t('teamInvitation.expiry'),
    button: t('teamInvitation.button'),
    fallback: t('teamInvitation.fallback'),
    footer: t('teamInvitation.footer'),
  }
  // The shared header limit counts UTF-16 units and can split an astral character.
  const subject = subjectLine(words.subject).toWellFormed()
  const facts = [words.introduction, words.identity, words.acceptance, words.expiry]
  return {
    sensitive: true,
    to,
    subject,
    text: `Hourmere\n\n${facts.join('\n\n')}\n\n${words.button}\n${url}\n\n${words.footer}\n`,
    html: emailLayout(
      language,
      subject,
      `${facts.map((fact) => `<p>${emailText(fact, language)}</p>`).join('\n')}
${emailButton(words.button, url, false, language)}
<p style="color: #555; font-size: 13px; ${emailWrapStyle}">${emailText(words.fallback, language)}<br><a href="${escapeHtml(url)}" style="${emailLinkStyle}">${emailText(url, language)}</a></p>
<p style="margin-top: 24px; border-top: 1px solid #ddd; padding-top: 16px; color: #555; font-size: 13px;">${emailText(words.footer, language)}</p>`,
    ),
  }
}
