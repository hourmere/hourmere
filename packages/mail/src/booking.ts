// Emails about a booking, to its attendees and its hosts: confirmed, rescheduled, cancelled
// and reminder. Plain text plus simple HTML with inline styles: no images, no external
// assets, no tracking. Everything from the booking is someone's input and is treated so.
import { normalizeFollowUpHostNote } from '@hourmere/core/follow-up-note'
import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'
import { formatPaymentAmount } from '@hourmere/core/payment'
import { type MailKey, mailContent, mailMessage as message } from './catalogue.ts'
import { formatMailDateTime } from './date-time.ts'
import type { MailAttachment, MailMessage } from './index.ts'
import { emailButton, emailLayout, emailLinkStyle, emailWrapStyle } from './layout.ts'
import {
  type EmailContent,
  emailText,
  emailUserText,
  emailUserValue,
  escapeHtml,
  linkableUrl,
  multiLine,
  singleLine,
  subjectLine,
} from './text.ts'

export type BookingEmailKind =
  | 'confirmed'
  | 'rescheduled'
  | 'cancelled'
  | 'reminder'
  | 'conference_failed'

/** Where the meeting happens, as the emails show it. */
export type MeetingLocation =
  | { kind: 'link'; url: string; label?: string | undefined }
  | { kind: 'phone'; number: string }
  | { kind: 'address'; address: string }
  | { kind: 'custom'; text: string }
  | TeamsMeetingLocation

export type TeamsMeetingLocation = { kind: 'microsoft_teams' } & (
  | { status: 'ready'; url: string }
  | { status: 'join_url_pending' | 'teams_unavailable' | 'writeback_failed' }
)

export interface BookingEmailMeeting {
  eventName: string
  hostName: string
  /** Required hosts for a collective booking, in stable booking order. */
  hostNames?: readonly string[] | undefined
  /** The invitee who booked. */
  inviteeName: string
  inviteeEmail: string
  /** The booker's stored IANA time zone, also shown to hosts in another zone. */
  inviteeTimeZone: string
  /** People the invitee added. */
  guests?: readonly { name: string; email: string }[] | undefined
  start: Temporal.Instant
  end: Temporal.Instant
  location: MeetingLocation | null
  /** For `rescheduled`: the time it had before. */
  previous?: { start: Temporal.Instant; end: Temporal.Instant } | undefined
  /** For `cancelled`: the reason given, if any. */
  cancelReason?: string | null | undefined
  payment?:
    | {
        amountMinor: number
        currency: string
        refundStatus: 'requested' | 'pending' | 'succeeded' | 'failed' | null
      }
    | undefined
}

/** Links of the invitee's manage page; the secret travels in the URL fragment. */
export interface ManageLinks {
  reschedule: string
  cancel: string
  details?: string | undefined
}

/** The invitee or a guest. Only the invitee gets manage links. */
export interface AttendeeRecipient {
  role: 'attendee'
  email: string
  /** IANA time zone the times are shown in. */
  timeZone: string
  locale?: string | null | undefined
  manageLinks?: ManageLinks | undefined
  /**
   * Replies to this email reach the instance sender, not a host (a collective booking's
   * invitee and guests get no host address); the email says so.
   */
  repliesNotDelivered?: boolean | undefined
}

export interface HostRecipient {
  role: 'host'
  email: string
  /** IANA time zone the times are shown in. */
  timeZone: string
  locale?: string | null | undefined
  /** The invitee's answers to the booking questions. */
  answers: readonly { question: string; answer: string | readonly string[] }[]
  /** Other required hosts, names only; never contact addresses. */
  coHostNames?: readonly string[] | undefined
}

export type BookingEmailRecipient = AttendeeRecipient | HostRecipient

/** A generated name for a host who is no longer available to the notification worker. */
export function bookingHostName(locale?: string | null): string {
  return message(interfaceLanguage(locale) ?? 'en', 'Host')
}

/** Locale-aware names; compact subjects retain a localized count of the remaining hosts. */
export function bookingHostNames(
  names: readonly string[],
  locale?: string | null,
  compact = false,
): string {
  const language = interfaceLanguage(locale) ?? 'en'
  const cleaned = names.map((name) => singleLine(name) || message(language, 'Host'))
  const visible = compact && cleaned.length > 3 ? cleaned.slice(0, 3) : cleaned
  const list =
    visible.length < cleaned.length
      ? [
          ...visible,
          message(
            language,
            cleaned.length - visible.length === 1 ? 'hosts.moreOne' : 'hosts.more',
            { count: String(cleaned.length - visible.length) },
          ),
        ]
      : visible
  return new Intl.ListFormat(formattingLocale(language), { type: 'conjunction' }).format(list)
}

const meetingHosts = (
  meeting: Pick<BookingEmailMeeting, 'hostName' | 'hostNames'>,
  language: InterfaceLanguage,
  compact = false,
) =>
  meeting.hostNames?.length
    ? bookingHostNames(meeting.hostNames, language, compact)
    : singleLine(meeting.hostName)

/** Keep localized separators outside each host's independent direction boundary. */
function hostListContent(names: readonly string[], language: InterfaceLanguage): EmailContent {
  const list = new Intl.ListFormat(formattingLocale(language), { type: 'conjunction' })
  const namesAndFallbacks = names.map((name) => singleLine(name) || message(language, 'Host'))
  const parts = list.formatToParts(namesAndFallbacks)
  return {
    text: parts.map(({ value }) => value).join(''),
    html: parts
      .map(({ type, value }) =>
        type === 'element' ? emailUserText(value, language) : emailText(value, language),
      )
      .join(''),
  }
}

function meetingHostContent(
  meeting: Pick<BookingEmailMeeting, 'hostName' | 'hostNames'>,
  language: InterfaceLanguage,
): EmailContent {
  return meeting.hostNames?.length
    ? hostListContent(meeting.hostNames, language)
    : emailUserValue(singleLine(meeting.hostName), language)
}

function personContent(name: string, email: string, language: InterfaceLanguage): EmailContent {
  const person = emailUserValue(singleLine(name), language)
  const address = emailUserValue(singleLine(email), language, 'ltr')
  return {
    text: `${person.text} <${address.text}>`,
    html: `${person.html} &lt;${address.html}&gt;`,
  }
}

/** Generated answer labels follow the host language; custom answers remain untouched. */
export function bookingAnswerText(value: unknown, language: InterfaceLanguage): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return message(language, value ? 'answer.yes' : 'answer.no')
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value))
    return value.filter((v) => typeof v === 'string').join(message(language, 'answer.separator'))
  return undefined
}

function bookingAnswerContent(
  answer: HostRecipient['answers'][number]['answer'],
  language: InterfaceLanguage,
): EmailContent {
  if (typeof answer === 'string') return emailUserValue(multiLine(answer), language)
  const separator = message(language, 'answer.separator')
  return {
    text: multiLine(answer.join(separator)),
    html: answer
      .map((option) => emailUserText(multiLine(option), language))
      .join(emailText(separator, language)),
  }
}

// --- Times --------------------------------------------------------------------------------

/** A valid IANA zone name, or UTC when it is not valid. Temporal preserves aliases. */
function displayZone(timeZone: string): string {
  if (timeZone === '' || /^[+-]/.test(timeZone)) return 'UTC'
  try {
    return new Temporal.ZonedDateTime(0n, timeZone).timeZoneId
  } catch {
    return 'UTC'
  }
}

/** Compare aliases without changing the zone name printed in the email. */
function comparisonZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en', { timeZone: displayZone(timeZone) }).resolvedOptions()
    .timeZone
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
}
const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
const CHINESE_TIME: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}

const format = (
  time: Temporal.ZonedDateTime,
  options: Intl.DateTimeFormatOptions,
  language: InterfaceLanguage,
) =>
  formatMailDateTime(
    time,
    language === 'zh-CN' && options === TIME ? CHINESE_TIME : options,
    language,
  )

/** The same readable zone and date-specific GMT offset used on booking pages. */
function zoneLabel(time: Temporal.ZonedDateTime, language: InterfaceLanguage): string {
  const name = time.timeZoneId.replaceAll('_', ' ')
  const offset = `GMT${time.offset}`
  return message(language, 'format.zone', { name, offset })
}

/** `Tuesday, October 20, 2026, 10:00 AM – 10:30 AM (Europe/Berlin, GMT+02:00)` */
export function formatMeetingTime(
  start: Temporal.Instant,
  end: Temporal.Instant,
  timeZone: string,
  locale?: string | null,
): string {
  const language = interfaceLanguage(locale) ?? 'en'
  const zone = displayZone(timeZone)
  const s = start.toZonedDateTimeISO(zone)
  const e = end.toZonedDateTimeISO(zone)
  const until = s.toPlainDate().equals(e.toPlainDate())
    ? format(e, TIME, language)
    : message(language, 'format.dateTime', {
        date: format(e, LONG_DATE, language),
        time: format(e, TIME, language),
      })
  return message(language, 'format.timeRange', {
    start: message(language, 'format.dateTime', {
      date: format(s, LONG_DATE, language),
      time: format(s, TIME, language),
    }),
    end: until,
    zone: zoneLabel(s, language),
  })
}

/** `Tue, Oct 20, 10:00 AM (Europe/Berlin, GMT+02:00)`, for subjects and invitee time. */
function formatShortTime(
  start: Temporal.Instant,
  timeZone: string,
  language: InterfaceLanguage,
): string {
  const zone = displayZone(timeZone)
  const s = start.toZonedDateTimeISO(zone)
  return `${message(language, 'format.dateTime', {
    date: format(s, SHORT_DATE, language),
    time: format(s, TIME, language),
  })}${zoneLabel(s, language)}`
}

// --- Locations ----------------------------------------------------------------------------

/** Guest payloads omit the invitee's collected phone number and automatic Teams links. */
export function bookingLocationForRecipient(
  location: MeetingLocation | null,
  inviteePhone: boolean,
  role: 'host' | 'invitee' | 'guest',
  locale?: string | null,
  handoff = false,
): MeetingLocation | null {
  if (
    location?.kind === 'microsoft_teams' &&
    role === 'guest' &&
    (!handoff || location.status === 'ready')
  )
    return { kind: 'custom', text: 'Microsoft Teams' }
  if (location?.kind !== 'phone') return location
  const language = interfaceLanguage(locale) ?? 'en'
  const key = inviteePhone
    ? role === 'host'
      ? 'phone.callInvitee'
      : role === 'invitee'
        ? 'phone.hostCallsYou'
        : 'phone.hostCallsInvitee'
    : role === 'host'
      ? 'phone.inviteeCallsYou'
      : 'phone.callHost'
  return { kind: 'custom', text: message(language, key, { number: location.number }) }
}

/** The location as plain text, e.g. for a calendar invitation's LOCATION. */
export function meetingLocationText(location: MeetingLocation): string {
  switch (location.kind) {
    case 'link':
      return singleLine(location.url)
    case 'phone':
      return singleLine(location.number)
    case 'address':
      return multiLine(location.address)
    case 'custom':
      return multiLine(location.text)
    case 'microsoft_teams':
      return location.status === 'ready' ? singleLine(location.url) : 'Microsoft Teams'
  }
}

export function teamsMeetingNotice(
  location: TeamsMeetingLocation,
  locale: string | null | undefined,
): string | undefined {
  const language = interfaceLanguage(locale) ?? 'en'
  if (location.status === 'join_url_pending') return message(language, 'teams.linkPending')
  if (location.status === 'teams_unavailable') return message(language, 'teams.unavailable')
  if (location.status === 'writeback_failed') return message(language, 'teams.writebackFailed')
}

function locationContent(
  location: MeetingLocation,
  language: InterfaceLanguage,
  cancelled: boolean,
  handoffSource: boolean,
): string | EmailContent {
  if (location.kind === 'microsoft_teams') {
    const label = 'Microsoft Teams'
    if (cancelled && handoffSource && location.status !== 'ready') {
      const status = {
        join_url_pending: 'bookingHandoff.sourceTeamsPending',
        teams_unavailable: 'bookingHandoff.sourceTeamsUnavailable',
        writeback_failed: 'bookingHandoff.sourceTeamsWritebackFailed',
      } as const
      return `${label}\n${message(language, status[location.status])}`
    }
    const notice = cancelled ? undefined : teamsMeetingNotice(location, language)
    return notice ? `${label}\n${notice}` : label
  }
  if (location.kind === 'link') {
    const label = singleLine(location.label ?? '')
    return label ? emailUserValue(label, language) : message(language, 'Online meeting')
  }
  if (location.kind === 'phone') {
    const label = message(language, 'Phone')
    const number = emailUserValue(singleLine(location.number), language, 'ltr')
    return { text: `${label} ${number.text}`, html: `${emailText(label, language)} ${number.html}` }
  }
  return emailUserValue(meetingLocationText(location), language)
}

function joinLabel(
  location: Extract<MeetingLocation, { kind: 'link' }>,
  language: InterfaceLanguage,
) {
  const label = singleLine(location.label ?? '').toLowerCase()
  const hostname = new URL(location.url).hostname.toLowerCase()
  if (label === 'zoom' || /(^|\.)zoom\.(us|com)$/.test(hostname))
    return message(language, 'Join Zoom meeting')
  if (label === 'google meet' || hostname === 'meet.google.com')
    return message(language, 'Join Google Meet meeting')
  if (
    label === 'teams' ||
    label === 'microsoft teams' ||
    ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(hostname)
  )
    return message(language, 'Join Teams meeting')
  return message(language, 'Join meeting')
}

// --- Layout -------------------------------------------------------------------------------

const htmlLines = (text: string, language: InterfaceLanguage) =>
  emailText(text, language).replaceAll('\n', '<br>')

/** `Label: value`, with further lines of the value indented. */
const textField = (label: string, value: string, language: InterfaceLanguage) =>
  message(language, 'format.field', { label, value: value.replaceAll('\n', '\n  ') })

interface MeetingDates {
  label: string
  dates: { when: string; status: string; join?: { label: string; url: string } }[]
}

interface Content {
  language: InterfaceLanguage
  subject: string
  intro: EmailContent
  handoffNotice?: string | undefined
  /** Label and value, already cleaned. */
  fields: { label: string; text: string; html?: string; muted?: boolean }[]
  answers: readonly { question: string; answer: EmailContent }[]
  hostNote?: { label: string; text: string } | undefined
  join?: { label: string; url: string } | undefined
  bookingUrl?: string | undefined
  manageLinks?: ManageLinks | undefined
  footer?: { language: InterfaceLanguage; text: string } | undefined
  /** Replies to this email do not reach the hosts. */
  replyNotice?: string | undefined
  receivedWhy?: EmailContent
  meetingDates?: MeetingDates[]
  seriesAction?: { label: string; url: string }
  repairNote?: string
}

function render(
  to: string,
  c: Content,
  attachment?: MailAttachment,
  plainText = false,
): MailMessage {
  const subject = subjectLine(c.subject)
  const t = (key: MailKey) => message(c.language, key)
  const htmlText = (text: string) => emailText(text, c.language)
  const actionText = c.manageLinks
    ? [
        '',
        t('Need to make a change?'),
        ...(c.footer ? [c.footer.text] : []),
        t('Use these links to change or cancel:'),
        textField(t('Reschedule'), c.manageLinks.reschedule, c.language),
        textField(t('Cancel'), c.manageLinks.cancel, c.language),
      ]
    : []
  const text = [
    'Hourmere',
    '',
    c.intro.text,
    ...(c.handoffNotice ? ['', c.handoffNotice] : []),
    '',
    ...c.fields.map((f) => textField(f.label, f.text, c.language)),
    ...(c.meetingDates ?? []).flatMap(({ label, dates }) => [
      '',
      label,
      ...dates.map(({ when, status, join }) =>
        [
          `- ${when}`,
          ...(status ? [`  ${status}`] : []),
          ...(join ? [`  ${textField(join.label, join.url, c.language)}`] : []),
        ].join('\n'),
      ),
    ]),
    ...(c.answers.length
      ? [
          '',
          t('Answers'),
          ...c.answers.map((a) => `${a.question}\n  ${a.answer.text.replaceAll('\n', '\n  ')}`),
        ]
      : []),
    ...(c.hostNote ? ['', c.hostNote.label, c.hostNote.text] : []),
    ...(c.join ? ['', c.join.label, c.join.url] : []),
    ...(c.bookingUrl ? ['', textField(t('Open in Hourmere'), c.bookingUrl, c.language)] : []),
    ...(c.repairNote ? ['', c.repairNote] : []),
    ...(c.seriesAction
      ? ['', textField(c.seriesAction.label, c.seriesAction.url, c.language)]
      : []),
    ...actionText,
    ...(c.footer && !c.manageLinks ? ['', c.footer.text] : []),
    ...(c.replyNotice ? ['', c.replyNotice] : []),
    ...(c.receivedWhy === undefined ? [] : ['', c.receivedWhy.text]),
  ].join('\n')
  if (plainText) return { to, subject, text: `${text}\n` }

  const cell = 'padding: 2px 16px 2px 0; vertical-align: top;'
  const rows = c.fields
    .map((f) => {
      // Long labels must share narrow email widths with their values. Keep compact labels
      // on one line, while longer copy can wrap at words or within a long word.
      const labelStyle =
        [...f.label].length > 20
          ? `white-space: normal; width: 35%; ${emailWrapStyle}`
          : 'white-space: nowrap; width: 1%;'
      return `<tr><td style="${cell} color: #555; ${labelStyle}">${htmlText(f.label)}</td><td style="${cell} ${emailWrapStyle}${f.muted ? ' color: #777; text-decoration: line-through;' : ''}">${f.html ?? htmlLines(f.text, c.language)}</td></tr>`
    })
    .join('\n')
  const answers = c.answers.length
    ? `<p style="margin: 24px 0 4px; font-weight: 600;">${htmlText(t('Answers'))}</p>\n${c.answers
        .map(
          (a) =>
            `<p style="margin: 0 0 12px; ${emailWrapStyle}"><span style="color: #555;">${emailUserText(a.question, c.language)}</span><br>${a.answer.html}</p>`,
        )
        .join('\n')}`
    : ''
  const footer = c.footer
    ? `<p lang="${c.footer.language}" style="margin: ${c.manageLinks ? '0 0 8px' : '24px 0 0'}; color: #555; font-size: 13px; ${emailWrapStyle}">${emailText(c.footer.text, c.footer.language)}</p>`
    : ''
  const hostNote = c.hostNote
    ? `<p style="margin: 24px 0 4px; font-weight: 600;">${htmlText(c.hostNote.label)}</p>\n<p style="margin: 0 0 12px; ${emailWrapStyle}">${emailUserText(c.hostNote.text, c.language)}</p>`
    : ''
  const links = c.manageLinks
    ? `<p style="margin: 24px 0 8px;">${htmlText(t('Need to make a change?'))}</p>
${emailButton(t('Reschedule'), c.manageLinks.reschedule, false, c.language)}
${emailButton(t('Cancel'), c.manageLinks.cancel, true, c.language)}
${footer}${footer ? '\n' : ''}<p style="margin: 8px 0 0; color: #555; font-size: 13px; ${emailWrapStyle}">${htmlText(t('If the buttons do not work, copy a link into your browser:'))}<br>${htmlText(textField(t('Reschedule'), c.manageLinks.reschedule, c.language))}<br>${htmlText(textField(t('Cancel'), c.manageLinks.cancel, c.language))}</p>`
    : ''
  const join = c.join
    ? `<div style="margin: 24px 0 0;">
${emailButton(c.join.label, c.join.url, false, c.language)}
<p style="margin: 4px 0 0; font-size: 13px; ${emailWrapStyle}"><a href="${escapeHtml(c.join.url)}" style="${emailLinkStyle}">${emailUserText(c.join.url, c.language, 'ltr')}</a></p>
</div>`
    : ''
  const bookingLink = c.bookingUrl
    ? `<div style="margin: 24px 0 0;">${emailButton(t('Open in Hourmere'), c.bookingUrl, false, c.language)}</div>`
    : ''
  const meetingDates = (c.meetingDates ?? [])
    .map(({ label, dates }) => {
      const items = dates.map(({ when, status, join }) => {
        const detail = join
          ? `<a href="${escapeHtml(join.url)}" style="${emailLinkStyle}">${htmlText(join.label)}</a>`
          : status && htmlText(status)
        return `<li style="margin: 0 0 8px; ${emailWrapStyle}">${htmlText(when)}${detail ? `<br>${detail}` : ''}</li>`
      })
      return `<p style="margin: 24px 0 8px; font-weight: 600;">${htmlText(label)}</p>\n<ul style="margin: 0; padding-left: 24px;">\n${items.join('\n')}\n</ul>`
    })
    .join('\n')
  const afterDetails = [
    meetingDates,
    answers,
    hostNote,
    join,
    bookingLink,
    c.repairNote
      ? `<p style="margin: 24px 0 0; ${emailWrapStyle}">${htmlText(c.repairNote)}</p>`
      : '',
    c.seriesAction ? emailButton(c.seriesAction.label, c.seriesAction.url, false, c.language) : '',
    links,
    ...(!c.manageLinks ? [footer] : []),
    c.replyNotice
      ? `<p style="margin: 24px 0 0; color: #555; font-size: 13px; ${emailWrapStyle}">${htmlText(c.replyNotice)}</p>`
      : '',
    c.receivedWhy === undefined
      ? ''
      : `<p style="margin: 24px 0 0; color: #555; font-size: 13px; ${emailWrapStyle}">${c.receivedWhy.html}</p>`,
  ]
    .filter(Boolean)
    .join('\n')
  const html = emailLayout(
    c.language,
    subject,
    `<p style="margin: 0 0 16px; ${emailWrapStyle}">${c.intro.html}</p>${c.handoffNotice ? `\n<p style="margin: 0 0 16px; ${emailWrapStyle}">${htmlText(c.handoffNotice)}</p>` : ''}
<table role="presentation" width="100%" style="width: 100%; border-collapse: collapse;">
${rows}
</table>${afterDetails ? `\n${afterDetails}` : ''}`,
  )
  return {
    to,
    subject,
    text: `${text}\n`,
    html,
    ...(attachment && { attachments: [attachment] }),
  }
}

/**
 * A neutral follow-up after the scheduled end, without implying attendance. Follow-ups
 * never include a meeting location, join link, manage capability, answers or attachment.
 */
export function followUpEmail(
  meeting: BookingEmailMeeting,
  recipient: BookingEmailRecipient,
  options: { hostNote?: string | undefined; bookingUrl?: string | undefined } = {},
): MailMessage {
  const language = interfaceLanguage(recipient.locale) ?? 'en'
  const t = (key: MailKey, values?: Record<string, string>) => message(language, key, values)
  const event = singleLine(meeting.eventName)
  const host = meetingHostContent(meeting, language)
  const invitee = emailUserValue(singleLine(meeting.inviteeName), language)
  const isHost = recipient.role === 'host'
  const note = multiLine(normalizeFollowUpHostNote(options.hostNote ?? ''))
  const bookingUrl = isHost && options.bookingUrl ? linkableUrl(options.bookingUrl) : undefined
  const receivedWhy = isHost
    ? 'You received this email because {invitee} booked a meeting with you via Hourmere.'
    : recipient.email.toLowerCase() === meeting.inviteeEmail.toLowerCase()
      ? 'You received this email because you booked a meeting with {host} via Hourmere.'
      : 'You received this email because {invitee} added you to a booking with {host} via Hourmere.'
  const content: Content = {
    language,
    subject: t('followUp.subject', { event }),
    intro: mailContent(language, 'followUp.introduction', { other: isHost ? invitee : host }),
    fields: [
      field(t('What'), emailUserValue(event, language)),
      field(t('When'), formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, language)),
      field(t('Host'), host),
      ...(isHost && recipient.coHostNames?.length
        ? [field(t('Co-hosts'), hostListContent(recipient.coHostNames, language))]
        : []),
    ],
    answers: [],
    bookingUrl,
    hostNote: note ? { label: t('followUp.hostNote'), text: note } : undefined,
    replyNotice: replyNotice(recipient, undefined, language),
    receivedWhy: mailContent(language, receivedWhy, { host, invitee }),
  }
  return { ...render(recipient.email, content), sensitive: true }
}

/** A request is informational: it changes neither calendar invitations nor meeting links. */
export function rescheduleRequestEmail(
  meeting: BookingEmailMeeting,
  recipient: BookingEmailRecipient,
  options: {
    expired?: boolean
    expiresAt: Temporal.Instant
    hostNote?: string | undefined
    bookingUrl?: string | undefined
  },
): MailMessage {
  const language = interfaceLanguage(recipient.locale) ?? 'en'
  const t = (key: MailKey, values?: Record<string, string>) => message(language, key, values)
  const event = singleLine(meeting.eventName)
  const host = meetingHostContent(meeting, language)
  const invitee = emailUserValue(singleLine(meeting.inviteeName), language)
  const note = multiLine(normalizeFollowUpHostNote(options.hostNote ?? ''))
  const expired = options.expired === true
  const content: Content = {
    language,
    subject: t(expired ? 'rescheduleRequest.expiredSubject' : 'rescheduleRequest.subject', {
      event,
    }),
    intro: expired
      ? mailContent(language, 'rescheduleRequest.expiredIntroduction', { invitee })
      : mailContent(language, 'rescheduleRequest.introduction', {
          host,
          expiry: formatMailDateTime(
            options.expiresAt.toZonedDateTimeISO(recipient.timeZone),
            { dateStyle: 'full', timeStyle: 'long' },
            language,
          ),
        }),
    fields: [
      field(t('What'), emailUserValue(event, language)),
      field(t('When'), formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, language)),
      field(t('Host'), host),
    ],
    answers: [],
    hostNote: !expired && note ? { label: t('followUp.hostNote'), text: note } : undefined,
    manageLinks: !expired && recipient.role === 'attendee' ? recipient.manageLinks : undefined,
    replyNotice: replyNotice(
      recipient,
      !expired && recipient.role === 'attendee' ? recipient.manageLinks : undefined,
      language,
    ),
    bookingUrl:
      expired && recipient.role === 'host' && options.bookingUrl
        ? linkableUrl(options.bookingUrl)
        : undefined,
    receivedWhy: mailContent(
      language,
      recipient.role === 'host'
        ? 'You received this email because {invitee} booked a meeting with you via Hourmere.'
        : 'You received this email because you booked a meeting with {host} via Hourmere.',
      { host, invitee },
    ),
  }
  return { ...render(recipient.email, content), sensitive: true }
}

// --- Emails -------------------------------------------------------------------------------

const field = (label: string, content: string | EmailContent) =>
  typeof content === 'string' ? { label, text: content } : { label, ...content }

/** Says where replies go when no host address is offered, and how to make changes. */
function replyNotice(
  recipient: BookingEmailRecipient,
  manageLinks: ManageLinks | undefined,
  language: InterfaceLanguage,
): string | undefined {
  if (recipient.role !== 'attendee' || !recipient.repliesNotDelivered) return undefined
  return message(language, manageLinks ? 'replyNotice.manageLinks' : 'replyNotice.plain')
}

/**
 * The email about a booking event for one recipient, with times in the recipient's zone.
 * Manage links go only to the invitee and never into an attachment; cancellations carry none.
 */
export function bookingEmail(
  kind: BookingEmailKind,
  meeting: BookingEmailMeeting,
  recipient: BookingEmailRecipient,
  options: {
    attachment?: MailAttachment | undefined
    bookingUrl?: string | undefined
    handoff?: 'source' | 'replacement' | undefined
    /** Use text/plain when a handoff cancellation has no saved calendar organizer. */
    plainText?: boolean | undefined
  } = {},
): MailMessage {
  const language = interfaceLanguage(recipient.locale) ?? 'en'
  const event = singleLine(meeting.eventName)
  const host = meetingHostContent(meeting, language)
  const invitee = emailUserValue(singleLine(meeting.inviteeName), language)
  const isHost = recipient.role === 'host'
  // Who the meeting is with, from the recipient's side.
  const other = isHost ? invitee : host
  const t = (key: MailKey, values?: Record<string, string>) => message(language, key, values)
  const when = formatShortTime(meeting.start, recipient.timeZone, language)

  const subjects = {
    conference_failed: 'Meeting link needs attention: {event} on {when}',
    confirmed: isHost
      ? 'New booking: {event} with {invitee} on {when}'
      : 'Confirmed: {event} with {host} on {when}',
    rescheduled: 'Rescheduled: {event} with {other}, now {when}',
    cancelled: 'Cancelled: {event} with {other} on {when}',
    reminder: 'Reminder: {event} with {other} on {when}',
  } satisfies Record<BookingEmailKind, MailKey>
  const subjectHost = meetingHosts(meeting, language, true)
  const bookingSubject = t(subjects[kind], {
    event,
    host: subjectHost,
    invitee: invitee.text,
    other: isHost ? invitee.text : subjectHost,
    when,
  })
  const handoff = options.handoff
  const subject = handoff
    ? t('bookingHandoff.subject', { subject: bookingSubject })
    : bookingSubject
  const intros = {
    conference_failed: isHost
      ? 'The time is reserved, but Google Meet could not be prepared. Open this booking in Hourmere to review the problem, retry safe reconciliation or cancel. No final calendar invitation has been sent.'
      : 'Your time is reserved, but the host needs to fix the Google Meet link. No final calendar invitation has been sent. You can use the links below to manage or cancel the booking.',
    confirmed: isHost
      ? '{invitee} booked a meeting with you.'
      : 'Your meeting with {host} is booked.',
    rescheduled: 'Your meeting with {other} has moved to a new time.',
    cancelled: 'Your meeting with {other} has been cancelled.',
    reminder: 'Your meeting with {other} is coming up.',
  } satisfies Record<BookingEmailKind, MailKey>
  const intro = mailContent(language, intros[kind], { host, invitee, other })

  const fields: Content['fields'] = [
    field(t('What'), emailUserValue(event, language)),
    field(t('When'), formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, language)),
  ]
  if (meeting.payment && (kind === 'confirmed' || kind === 'rescheduled' || kind === 'cancelled')) {
    const amount = formatPaymentAmount(meeting.payment, formattingLocale(language))
    fields.push(field(t('bookingPayment.label'), t('bookingPayment.paid', { amount })))
    if (kind === 'cancelled' && meeting.payment.refundStatus) {
      fields.push(
        field(t('bookingPayment.refund'), t(`bookingPayment.${meeting.payment.refundStatus}`)),
      )
    }
  }
  if (isHost && comparisonZone(meeting.inviteeTimeZone) !== comparisonZone(recipient.timeZone)) {
    fields.push(
      field(t("Invitee's time"), formatShortTime(meeting.start, meeting.inviteeTimeZone, language)),
    )
  }
  if (kind === 'rescheduled' && meeting.previous) {
    fields.push({
      ...field(
        t('Was'),
        formatMeetingTime(
          meeting.previous.start,
          meeting.previous.end,
          recipient.timeZone,
          language,
        ),
      ),
      muted: true,
    })
  }
  const location = meeting.location
  const teams = location?.kind === 'microsoft_teams' ? location : undefined
  if (location) {
    fields.push(
      field(
        t('Where'),
        locationContent(location, language, kind === 'cancelled', handoff === 'source'),
      ),
    )
  } else if (kind !== 'conference_failed') {
    fields.push(
      field(t('Where'), t('No location has been specified. Contact the host for meeting details.')),
    )
  }
  if (isHost) {
    fields.push(
      field(t('Invitee'), personContent(meeting.inviteeName, meeting.inviteeEmail, language)),
    )
    if (recipient.coHostNames?.length) {
      fields.push(field(t('Co-hosts'), hostListContent(recipient.coHostNames, language)))
    }
    if (meeting.guests?.length) {
      const guests = meeting.guests.map((guest) => personContent(guest.name, guest.email, language))
      fields.push(
        field(t('Guests'), {
          text: guests.map((guest) => guest.text).join('\n'),
          html: guests.map((guest) => guest.html).join('<br>'),
        }),
      )
    }
  } else {
    fields.push(field(t('Host'), host))
  }
  if (kind === 'cancelled' && meeting.cancelReason) {
    const reason = multiLine(meeting.cancelReason)
    if (reason) fields.push(field(t('Reason'), emailUserValue(reason, language)))
  }

  const answers = isHost
    ? recipient.answers
        .map((a) => ({
          question: singleLine(a.question),
          answer: bookingAnswerContent(a.answer, language),
        }))
        .filter((a) => a.question && a.answer.text)
    : []
  const manageLinks =
    recipient.role === 'attendee' && kind !== 'cancelled' ? recipient.manageLinks : undefined
  const footerRole = isHost ? 'host' : manageLinks ? 'invitee' : 'guest'
  const invitation =
    options.attachment?.contentType === 'text/calendar; method=REQUEST; charset=UTF-8' &&
    /^METHOD:REQUEST\r?$/m.test(options.attachment.content)
  const footer =
    kind !== 'cancelled' && kind !== 'conference_failed' && invitation
      ? { language, text: t(`calendar.email.${footerRole}`) }
      : undefined
  const joinLocation =
    location?.kind === 'link'
      ? location
      : teams?.status === 'ready'
        ? { kind: 'link' as const, label: 'Microsoft Teams', url: teams.url }
        : undefined
  const joinUrl = joinLocation && linkableUrl(joinLocation.url)
  const join =
    joinLocation && joinUrl && kind !== 'cancelled' && kind !== 'conference_failed'
      ? { label: joinLabel(joinLocation, language), url: joinUrl }
      : undefined
  const bookingPage = isHost
    ? options.bookingUrl
    : teams?.status === 'join_url_pending'
      ? manageLinks?.details
      : undefined
  const bookingUrl = bookingPage ? linkableUrl(bookingPage) : undefined
  // Cancellation and suppressed invitations can omit manage links; identity still
  // distinguishes the person who booked from the guests they added.
  const receivedWhy = isHost
    ? 'You received this email because {invitee} booked a meeting with you via Hourmere.'
    : recipient.email.toLowerCase() === meeting.inviteeEmail.toLowerCase()
      ? 'You received this email because you booked a meeting with {host} via Hourmere.'
      : 'You received this email because {invitee} added you to a booking with {host} via Hourmere.'

  return render(
    recipient.email,
    {
      language,
      subject,
      intro,
      handoffNotice: handoff && t(`bookingHandoff.${handoff}`),
      fields,
      answers,
      join,
      bookingUrl,
      manageLinks,
      footer,
      replyNotice: replyNotice(recipient, manageLinks, language),
      ...(handoff !== 'replacement' && {
        receivedWhy: mailContent(language, receivedWhy, { host, invitee }),
      }),
    },
    options.attachment,
    options.plainText,
  )
}

export type SeriesBookingEmailKind = 'confirmed' | 'cancelled' | 'link_update'

export interface SeriesEmailMember {
  start: Temporal.Instant
  end: Temporal.Instant
  state: 'confirmed' | 'updated_separately' | 'started' | 'cancelled'
  conference?: { state: 'pending' | 'failed' } | { state: 'ready'; url: string }
  /** This cancellation affected this date. Other dates retain their current state. */
  affected?: boolean
}

export interface SeriesEmailDetails {
  eventName: string
  hostName: string
  /** Required hosts for a collective booking, in stable booking order. */
  hostNames?: readonly string[]
  inviteeName: string
  /** Booking language used for the booker and every guest. */
  locale?: string | null
  /** Dates in series order, or the recipient's net changes for a link update. */
  members: readonly SeriesEmailMember[]
  /** The instance's canonical PUBLIC_URL from server configuration. */
  publicUrl: string
  cancelReason?: string | null
}

export type SeriesEmailRecipient = { email: string; timeZone: string } & (
  | {
      role: 'booker' | 'guest'
      /** A capability issued for this recipient. A guest's capability must be read-only. */
      token: string
    }
  | {
      role: 'host'
      locale?: string | null
      /** Absolute same-origin URL to authenticated series detail. */
      seriesUrl: string
    }
)

const seriesStateLabels = {
  updated_separately: 'series.updatedSeparately',
  started: 'series.started',
  cancelled: 'series.cancelled.member',
  pending: 'series.pending',
  failed: 'series.failed',
} as const satisfies Record<string, MailKey>

function seriesMemberLabel(member: SeriesEmailMember, language: InterfaceLanguage) {
  const state = member.state === 'confirmed' ? member.conference?.state : member.state
  return state && state !== 'ready' ? message(language, seriesStateLabels[state]) : ''
}

const singleLineUrl = (url: string) => (url === singleLine(url) ? linkableUrl(url) : undefined)

function seriesMemberJoinUrl(member: SeriesEmailMember) {
  return member.state === 'confirmed' && member.conference?.state === 'ready'
    ? singleLineUrl(member.conference.url)
    : undefined
}

/** Localized plain text for VEVENT DESCRIPTION. Apply iCalendar escaping at serialization. */
export function seriesMemberDescription(member: SeriesEmailMember, locale?: string | null): string {
  const language = interfaceLanguage(locale) ?? 'en'
  return seriesMemberLabel(member, language) || seriesMemberJoinUrl(member) || ''
}

function seriesActionUrl(publicUrl: string, recipient: SeriesEmailRecipient): string {
  const origin = URL.parse(publicUrl)?.origin
  if (!origin || !linkableUrl(origin) || (publicUrl !== origin && publicUrl !== `${origin}/`)) {
    throw new Error('Invalid series mail instance origin')
  }
  if (recipient.role === 'host') {
    const url = singleLineUrl(recipient.seriesUrl) && URL.parse(recipient.seriesUrl)
    if (!url || url.origin !== origin || url.username || url.password || url.hash) {
      throw new Error('Invalid host series detail URL')
    }
    return recipient.seriesUrl
  }
  if (!/^[A-Za-z0-9_-]+$/.test(recipient.token)) throw new Error('Invalid series mail capability')
  return `${origin}/series/manage#${recipient.token}`
}

const seriesSubjectKeys = {
  confirmed: 'series.confirmed.subject',
  cancelled: 'series.cancelled.subject',
  link_update: 'series.linkUpdate.subject',
} as const satisfies Record<SeriesBookingEmailKind, MailKey>

/** Render one series email. The caller supplies the recipient's current dates and capability. */
export function seriesBookingEmail(
  kind: SeriesBookingEmailKind,
  series: SeriesEmailDetails,
  recipient: SeriesEmailRecipient,
): MailMessage {
  const isHost = recipient.role === 'host'
  const language = interfaceLanguage(isHost ? recipient.locale : series.locale) ?? 'en'
  const t = (key: MailKey, values?: Record<string, string>) => message(language, key, values)
  const event = singleLine(series.eventName)
  const hostContent = meetingHostContent(series, language)
  const host = hostContent.text ? hostContent : t('Host')
  const invitee = emailUserValue(singleLine(series.inviteeName), language)
  const reason = kind === 'cancelled' && series.cancelReason ? multiLine(series.cancelReason) : ''

  const dates = (label: MailKey, members: readonly SeriesEmailMember[]): MeetingDates => ({
    label: t(label),
    dates: members.map((member) => {
      const url = kind === 'cancelled' ? undefined : seriesMemberJoinUrl(member)
      const status =
        kind === 'cancelled' && member.affected
          ? t('series.cancelled.member')
          : seriesMemberLabel(member, language)
      return {
        when: formatMeetingTime(member.start, member.end, recipient.timeZone, language),
        status,
        ...(url && { join: { label: joinLabel({ kind: 'link', url }, language), url } }),
      }
    }),
  })
  const affected = kind === 'cancelled' ? series.members.filter((member) => member.affected) : []
  const reported =
    kind === 'link_update'
      ? series.members.filter(
          (member) =>
            seriesMemberJoinUrl(member) ||
            (recipient.role !== 'guest' &&
              member.state === 'confirmed' &&
              member.conference?.state === 'failed'),
        )
      : series.members
  const meetingDates =
    kind === 'cancelled'
      ? [
          dates('series.affected', affected),
          dates(
            'series.unchanged',
            series.members.filter((member) => !member.affected),
          ),
        ]
      : [dates('series.occurrences', reported)]
  const count = kind === 'cancelled' ? affected.length : reported.length
  const locale = formattingLocale(language)
  const plural = new Intl.PluralRules(locale).select(count) === 'one' ? 'One' : 'Other'
  const intro =
    kind === 'confirmed'
      ? mailContent(language, `series.confirmed.${recipient.role}`, { host, invitee })
      : mailContent(
          language,
          `series.${kind === 'cancelled' ? 'cancelled' : 'linkUpdate'}.body${plural}`,
          {
            count: new Intl.NumberFormat(locale).format(count),
          },
        )
  const repair =
    isHost &&
    kind !== 'cancelled' &&
    reported.some((member) => member.state === 'confirmed' && member.conference?.state === 'failed')
  const action = isHost
    ? 'Open in Hourmere'
    : recipient.role === 'guest'
      ? 'series.view'
      : 'series.manage'
  return {
    ...render(recipient.email, {
      language,
      subject: t(seriesSubjectKeys[kind], { event }),
      intro,
      fields: [
        field(t('What'), emailUserValue(event, language)),
        isHost ? field(t('Invitee'), invitee) : field(t('Host'), host),
        ...(reason ? [field(t('Reason'), emailUserValue(reason, language))] : []),
      ],
      answers: [],
      meetingDates: meetingDates.filter((section) => section.dates.length > 0),
      ...(repair && { repairNote: t('series.repair') }),
      seriesAction: { label: t(action), url: seriesActionUrl(series.publicUrl, recipient) },
    }),
    sensitive: true,
  }
}
