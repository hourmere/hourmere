import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'
import { mailMessage } from './catalogue.ts'
import { formatMailDateTime } from './date-time.ts'
import type { MailMessage } from './index.ts'
import { emailLayout, emailLinkStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine, subjectLine } from './text.ts'

interface MeetingPollEmailOptions {
  to: string
  pollTitle: string
  timeZone: string
  language?: unknown
  defaultLanguage?: unknown
}

interface MeetingPollVotingLinkOptions extends MeetingPollEmailOptions {
  publicUrl: string
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
  publicUrl: string
  organizationId: string
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
  const subject = subjectLine(subjectText).toWellFormed()
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
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  if (!uuid.test(options.pollId)) throw new Error('Invalid meeting poll ID')
  if (!uuid.test(options.organizationId)) throw new Error('Invalid meeting poll organization ID')
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
      url: `${origin}/app/meeting-polls/${options.pollId}?organizationId=${options.organizationId}`,
    },
  ])
}

export interface MeetingPollOutcomeEmailOptions extends MeetingPollEmailOptions {
  kind: 'selected' | 'rescheduled' | 'cancelled'
  startAt: Date
  endAt: Date
}

function outcomeTime(date: Date, timeZone: string, language: InterfaceLanguage): string {
  try {
    const time = Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone)
    const formatted = formatMailDateTime(
      time,
      {
        dateStyle: 'full',
        timeStyle: 'short',
        ...(language === 'zh-CN' ? { hourCycle: 'h23' } : {}),
      },
      language,
    )
    return (
      formatted +
      mailMessage(language, 'format.zone', {
        name: timeZone.replaceAll('_', ' '),
        offset: `GMT${time.offset}`,
      })
    )
  } catch {
    throw new Error('Invalid meeting poll display time')
  }
}

/** Informational poll outcome for a voter outside the booking's attendee list. */
export function meetingPollOutcomeEmail(options: MeetingPollOutcomeEmailOptions): MailMessage {
  const language = mailLanguage(options)
  const subject = mailMessage(language, `poll.outcome.${options.kind}.subject`, {
    poll: singleLine(options.pollTitle),
  })
  const body = mailMessage(language, `poll.outcome.${options.kind}.body`)
  const when = mailMessage(language, 'format.timeRange', {
    start: outcomeTime(options.startAt, options.timeZone, language),
    end: outcomeTime(options.endAt, options.timeZone, language),
    zone: '',
  })
  return pollMail(options.to, language, subject, [{ text: body }, { text: when }])
}
