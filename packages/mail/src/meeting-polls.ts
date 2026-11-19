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

export interface MeetingPollOutcomeEmailOptions {
  to: string
  pollTitle: string
  kind: 'selected' | 'rescheduled' | 'cancelled'
  startAt: Date
  endAt: Date
  timeZone: string
  language?: unknown
  defaultLanguage?: unknown
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
  const language =
    interfaceLanguage(options.language) ?? interfaceLanguage(options.defaultLanguage) ?? 'en'
  if (!options.to || singleLine(options.to) !== options.to)
    throw new Error('Invalid meeting poll recipient')
  const subject = subjectLine(
    mailMessage(language, `poll.outcome.${options.kind}.subject`, {
      poll: singleLine(options.pollTitle),
    }),
  ).toWellFormed()
  const body = mailMessage(language, `poll.outcome.${options.kind}.body`)
  const when = mailMessage(language, 'format.timeRange', {
    start: outcomeTime(options.startAt, options.timeZone, language),
    end: outcomeTime(options.endAt, options.timeZone, language),
    zone: '',
  })
  return {
    sensitive: true,
    to: options.to,
    subject,
    text: `Hourmere\n\n${body}\n\n${when}\n`,
    html: emailLayout(
      language,
      subject,
      `<p>${emailText(body, language)}</p>\n<p>${emailText(when, language)}</p>`,
    ),
  }
}
