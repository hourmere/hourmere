import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'
import { mailMessage } from './catalogue.ts'
import type { MailMessage } from './index.ts'
import { emailLayout, emailLinkStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine, subjectLine } from './text.ts'

interface MeetingPollEmailOptions {
  to: string
  publicUrl: string
  pollTitle: string
  timeZone: string
  language?: unknown
  defaultLanguage?: unknown
}

interface MeetingPollVotingLinkOptions extends MeetingPollEmailOptions {
  token: string
  expiresAt: Date
}

export interface MeetingPollCredentialEmailOptions extends MeetingPollVotingLinkOptions {
  purpose: 'verification' | 'voting'
  optOutToken?: string | undefined
}

export interface MeetingPollReminderEmailOptions extends MeetingPollVotingLinkOptions {
  optOutToken: string
}

export interface MeetingPollDeadlineEmailOptions extends MeetingPollEmailOptions {
  pollId: string
  deadlineAt: Date
  responseCount: number
}

function mailLanguage(options: MeetingPollEmailOptions): InterfaceLanguage {
  return interfaceLanguage(options.language) ?? interfaceLanguage(options.defaultLanguage) ?? 'en'
}

function pollOrigin(publicUrl: string): string {
  try {
    const url = new URL(publicUrl)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      ![url.origin, `${url.origin}/`].includes(publicUrl)
    )
      throw new Error()
    return url.origin
  } catch {
    throw new Error('Invalid meeting poll origin')
  }
}

function displayTime(at: Date, timeZone: string, language: InterfaceLanguage): string {
  try {
    const value = new Intl.DateTimeFormat(formattingLocale(language), {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(at)
    return `${value} (${timeZone})`
  } catch {
    throw new Error('Invalid meeting poll display time')
  }
}

function pollMail(
  to: string,
  language: InterfaceLanguage,
  subjectText: string,
  parts: { text: string; url?: string }[],
): MailMessage {
  if (!to || singleLine(to) !== to) throw new Error('Invalid meeting poll recipient')
  const subject = subjectLine(subjectText)
  return {
    sensitive: true,
    to,
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

function votingLinkMail(
  options: MeetingPollVotingLinkOptions & { optOutToken?: string | undefined },
  kind: 'verify' | 'vote' | 'reminder',
): MailMessage {
  const language = mailLanguage(options)
  const origin = pollOrigin(options.publicUrl)
  const capability = /^[A-Za-z0-9_-]{43}$/
  if (
    !capability.test(options.token) ||
    ((kind === 'reminder' || options.optOutToken) && !capability.test(options.optOutToken ?? ''))
  )
    throw new Error('Invalid meeting poll capability')
  const values = {
    poll: singleLine(options.pollTitle),
    expiry: displayTime(options.expiresAt, options.timeZone, language),
  }
  const t = (key: Parameters<typeof mailMessage>[1]) => mailMessage(language, key, values)
  const parts = [
    {
      text: t(`poll.${kind}.body`),
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
  return pollMail(options.to, language, t(`poll.${kind}.subject`), parts)
}

/** No account lookup or account-dependent wording. Links preview; confirmation is explicit. */
export function meetingPollCredentialEmail(
  options: MeetingPollCredentialEmailOptions,
): MailMessage {
  return votingLinkMail(options, options.purpose === 'verification' ? 'verify' : 'vote')
}

export function meetingPollReminderEmail(options: MeetingPollReminderEmailOptions): MailMessage {
  return votingLinkMail(options, 'reminder')
}

export function meetingPollDeadlineEmail(options: MeetingPollDeadlineEmailOptions): MailMessage {
  const origin = pollOrigin(options.publicUrl)
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.pollId)) {
    throw new Error('Invalid meeting poll ID')
  }
  const language = mailLanguage(options)
  const values = {
    poll: singleLine(options.pollTitle),
    deadline: displayTime(options.deadlineAt, options.timeZone, language),
    count: new Intl.NumberFormat(formattingLocale(language)).format(options.responseCount),
  }
  const t = (key: Parameters<typeof mailMessage>[1]) => mailMessage(language, key, values)
  return pollMail(options.to, language, t('poll.deadline.subject'), [
    { text: t('poll.deadline.body') },
    { text: t('poll.deadline.responses') },
    {
      text: t('poll.deadline.results'),
      url: `${origin}/api/v1/meeting-polls/${options.pollId}/results`,
    },
  ])
}
