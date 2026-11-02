// Render only. The delivery worker owns eligibility, capabilities and mail accounting.
import { formattingLocale, interfaceLanguage } from '@hourmere/core/language'
import { mailMessage } from './catalogue.ts'
import type { MailMessage } from './index.ts'
import { emailLayout, emailLinkStyle } from './layout.ts'
import { emailText, escapeHtml, singleLine, subjectLine } from './text.ts'

interface WaitlistEmailOptions {
  to: string
  /** Trusted canonical PUBLIC_URL origin, never a request or callback URL. */
  publicUrl: string
  eventTitle: string
  /** A separate, purpose-bound management capability, valid through the entry deadline. */
  removalToken: string
  expiresAt: Date | string
  language?: unknown
  defaultLanguage?: unknown
}

export interface WaitlistVerificationEmailOptions extends WaitlistEmailOptions {
  /** Verification capability; it cannot substitute for the management capability. */
  token: string
}

export interface WaitlistNotificationEmailOptions extends WaitlistEmailOptions {
  /** Current ordinary public route: /{handle}/{slug} or /team/{teamSlug}/{slug}. */
  bookingPath: string
  /** Management capability also used for optional ordinary-booking attribution. */
  token: string
  timeZone: string
  slots: readonly { start: string; end: string }[]
}

function origin(value: string): string {
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (value !== url.origin && value !== `${url.origin}/`)
    ) {
      throw new Error()
    }
    return url.origin
  } catch {
    // URL/Temporal errors can echo their inputs; expose only fixed messages to callers.
    throw new Error('Invalid waitlist instance origin')
  }
}

function capability(value: string): string {
  if (!/^[a-f\d-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Invalid waitlist capability')
  }
  return value
}

function instant(value: Date | string): Temporal.Instant {
  try {
    return Temporal.Instant.from(value instanceof Date ? value.toISOString() : value)
  } catch {
    throw new Error('Invalid waitlist time')
  }
}

type Language = NonNullable<ReturnType<typeof interfaceLanguage>>
type MessageKey = Parameters<typeof mailMessage>[1]
type Part = { text: string; url?: string }

function context(options: WaitlistEmailOptions) {
  const language =
    interfaceLanguage(options.language) ?? interfaceLanguage(options.defaultLanguage) ?? 'en'
  const publicOrigin = origin(options.publicUrl)
  const to = options.to
  if (!to || singleLine(to.toWellFormed()) !== to) throw new Error('Invalid waitlist recipient')
  const event =
    singleLine(options.eventTitle.toWellFormed()) || mailMessage(language, 'waitlist.event')
  const removeUrl = `${publicOrigin}/waitlist/remove#${capability(options.removalToken)}`
  const expiry = instant(options.expiresAt)
  const t = (key: MessageKey, values: Record<string, string> = {}) =>
    mailMessage(language, key, { event, ...values })
  return { language, publicOrigin, to, removeUrl, expiry, t }
}

function render(to: string, language: Language, title: string, parts: Part[]): MailMessage {
  const subject = subjectLine(title).toWellFormed()
  return {
    sensitive: true,
    to,
    subject,
    text: `Hourmere\n\n${parts.map((part) => `${part.text}${part.url ? `\n${part.url}` : ''}`).join('\n\n')}\n`,
    html: emailLayout(
      language,
      subject,
      parts
        .map(
          (part) =>
            `<p>${emailText(part.text, language)}${part.url ? `<br><a href="${escapeHtml(part.url)}" style="${emailLinkStyle}" rel="noreferrer">${emailText(part.url, language)}</a>` : ''}</p>`,
        )
        .join('\n'),
    ),
  }
}

/** Opening the link only previews confirmation; activation requires an explicit POST. */
export function waitlistVerificationEmail(options: WaitlistVerificationEmailOptions): MailMessage {
  const { language, publicOrigin, to, removeUrl, expiry, t } = context(options)
  const verifyUrl = `${publicOrigin}/waitlist/verify#token=${capability(options.token)}&management=${capability(options.removalToken)}`
  return render(to, language, t('waitlist.verify.subject'), [
    { text: t('waitlist.verify.introduction') },
    { text: t('waitlist.verify.action'), url: verifyUrl },
    {
      text: t('waitlist.verify.expiry', {
        expiry: expiry.toString().replace('T', ' ').replace(/Z$/, ' UTC'),
      }),
    },
    { text: t('waitlist.broadcast') },
    { text: t('waitlist.remove'), url: removeUrl },
    { text: t('waitlist.verify.footer') },
  ])
}

/** Every endpoint prints its own date-specific UTC offset, including a DST-crossing slot. */
function displayTime(value: Temporal.Instant, timeZone: string, language: Language): string {
  try {
    const zoned = value.toZonedDateTimeISO(timeZone)
    const date = new Intl.DateTimeFormat(formattingLocale(language), {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
      ...(language === 'zh-CN' ? { hourCycle: 'h23' } : {}),
    })
      .format(value.epochMilliseconds)
      .replace(/[\u00a0\u202f]/g, ' ')
    return `${date}${mailMessage(language, 'format.zone', { name: timeZone.replaceAll('_', ' '), offset: `GMT${zoned.offset}` })}`
  } catch {
    throw new Error('Invalid waitlist display time zone')
  }
}

/** Suggested times are ordinary booking links; no capability grants a hold or priority. */
export function waitlistNotificationEmail(options: WaitlistNotificationEmailOptions): MailMessage {
  const { language, publicOrigin, to, removeUrl, expiry, t } = context(options)
  if (!/^\/(?:[A-Za-z0-9-]+\/|team\/[A-Za-z0-9-]+\/)[a-z0-9-]+$/.test(options.bookingPath)) {
    throw new Error('Invalid waitlist booking path')
  }
  if (options.slots.length < 1 || options.slots.length > 3) {
    throw new Error('Invalid waitlist suggestions')
  }
  const token = capability(options.token)
  const slots = options.slots
    .map((slot) => ({ start: instant(slot.start), end: instant(slot.end) }))
    .sort(
      (a, b) =>
        Temporal.Instant.compare(a.start, b.start) || Temporal.Instant.compare(a.end, b.end),
    )
  const identities = new Set<string>()
  const suggestions = slots.map((slot): Part => {
    const start = slot.start.toString({ smallestUnit: 'millisecond' })
    const identity = `${start}/${slot.end.toString()}`
    if (Temporal.Instant.compare(slot.start, slot.end) >= 0 || identities.has(identity)) {
      throw new Error('Invalid waitlist suggestions')
    }
    identities.add(identity)
    return {
      text: t('waitlist.slot', {
        start: displayTime(slot.start, options.timeZone, language),
        end: displayTime(slot.end, options.timeZone, language),
      }),
      // Capabilities belong in path segments, never query strings or redirect parameters.
      url: `${publicOrigin}${options.bookingPath}/waitlist/${token}/${encodeURIComponent(start)}/${expiry.epochMilliseconds}`,
    }
  })
  return render(to, language, t('waitlist.notice.subject'), [
    { text: t('waitlist.notice.introduction') },
    { text: t('waitlist.broadcast') },
    ...suggestions,
    {
      text: t('waitlist.notice.expiry', {
        expiry: displayTime(expiry, options.timeZone, language),
      }),
    },
    { text: t('waitlist.notice.page'), url: `${publicOrigin}${options.bookingPath}` },
    { text: t('waitlist.notice.waiting') },
    { text: t('waitlist.remove'), url: removeUrl },
    { text: t('waitlist.notice.footer') },
  ])
}
