// Emails about a booking, to its attendees and its hosts: confirmed, rescheduled, cancelled
// and reminder. Plain text plus simple HTML with inline styles: no images, no external
// assets, no tracking. Everything from the booking is someone's input and is treated so.
import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'
import { type MailKey, mailMessage as message } from './catalogue.ts'
import type { MailAttachment, MailMessage } from './index.ts'
import { emailButton, emailLayout, emailLinkStyle, emailWrapStyle } from './layout.ts'
import { emailText, escapeHtml, linkableUrl, multiLine, singleLine, subjectLine } from './text.ts'

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

export interface BookingEmailMeeting {
  eventName: string
  hostName: string
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
}

/** Links of the invitee's manage page; the secret travels in the URL fragment. */
export interface ManageLinks {
  reschedule: string
  cancel: string
}

/** The invitee or a guest. Only the invitee gets manage links. */
export interface AttendeeRecipient {
  role: 'attendee'
  email: string
  /** IANA time zone the times are shown in. */
  timeZone: string
  locale?: string | null | undefined
  manageLinks?: ManageLinks | undefined
}

export interface HostRecipient {
  role: 'host'
  email: string
  /** IANA time zone the times are shown in. */
  timeZone: string
  locale?: string | null | undefined
  /** The invitee's answers to the booking questions. */
  answers: readonly { question: string; answer: string }[]
}

export type BookingEmailRecipient = AttendeeRecipient | HostRecipient

/** A generated name for a host who is no longer available to the notification worker. */
export function bookingHostName(locale?: string | null): string {
  return message(interfaceLanguage(locale) ?? 'en', 'Host')
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

// ICU puts a narrow no-break space before AM/PM; a plain space reads the same everywhere.
const format = (
  time: Temporal.ZonedDateTime,
  options: Intl.DateTimeFormatOptions,
  language: InterfaceLanguage,
) =>
  new Intl.DateTimeFormat(formattingLocale(language), {
    ...(language === 'zh-CN' && options === TIME ? CHINESE_TIME : options),
    timeZone: time.timeZoneId,
  })
    .format(time.epochMilliseconds)
    .replace(/[\u00a0\u202f]/g, ' ')

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
  }
}

function locationForText(location: MeetingLocation, language: InterfaceLanguage): string {
  if (location.kind === 'link' && location.label) {
    return textField(singleLine(location.label), singleLine(location.url), language)
  }
  if (location.kind === 'phone')
    return `${message(language, 'Phone')} ${singleLine(location.number)}`
  return meetingLocationText(location)
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

interface Content {
  language: InterfaceLanguage
  subject: string
  intro: string
  /** Label and value, already cleaned. */
  fields: { label: string; text: string; muted?: boolean }[]
  answers: readonly { question: string; answer: string }[]
  join?: { label: string; url: string } | undefined
  bookingUrl?: string | undefined
  manageLinks?: ManageLinks | undefined
  footer?: { language: InterfaceLanguage; text: string } | undefined
  receivedWhy: string
}

function render(to: string, c: Content, attachment?: MailAttachment): MailMessage {
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
    c.intro,
    '',
    ...c.fields.map((f) => textField(f.label, f.text, c.language)),
    ...(c.answers.length
      ? [
          '',
          t('Answers'),
          ...c.answers.map((a) => `${a.question}\n  ${a.answer.replaceAll('\n', '\n  ')}`),
        ]
      : []),
    ...(c.join ? ['', c.join.label, c.join.url] : []),
    ...(c.bookingUrl ? ['', textField(t('Open in Hourmere'), c.bookingUrl, c.language)] : []),
    ...actionText,
    ...(c.footer && !c.manageLinks ? ['', c.footer.text] : []),
    '',
    c.receivedWhy,
  ].join('\n')

  const cell = 'padding: 2px 16px 2px 0; vertical-align: top;'
  const rows = c.fields
    .map((f) => {
      // Long labels must share narrow email widths with their values. Keep compact labels
      // on one line, while longer copy can wrap at words or within a long word.
      const labelStyle =
        [...f.label].length > 20
          ? `white-space: normal; width: 35%; ${emailWrapStyle}`
          : 'white-space: nowrap; width: 1%;'
      return `<tr><td style="${cell} color: #555; ${labelStyle}">${htmlText(f.label)}</td><td style="${cell} ${emailWrapStyle}${f.muted ? ' color: #777; text-decoration: line-through;' : ''}">${htmlLines(f.text, c.language)}</td></tr>`
    })
    .join('\n')
  const answers = c.answers.length
    ? `<p style="margin: 24px 0 4px; font-weight: 600;">${htmlText(t('Answers'))}</p>\n${c.answers
        .map(
          (a) =>
            `<p style="margin: 0 0 12px; ${emailWrapStyle}"><span style="color: #555;">${htmlLines(a.question, c.language)}</span><br>${htmlLines(a.answer, c.language)}</p>`,
        )
        .join('\n')}`
    : ''
  const footer = c.footer
    ? `<p lang="${c.footer.language}" style="margin: ${c.manageLinks ? '0 0 8px' : '24px 0 0'}; color: #555; font-size: 13px; ${emailWrapStyle}">${emailText(c.footer.text, c.footer.language)}</p>`
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
<p style="margin: 4px 0 0; font-size: 13px; ${emailWrapStyle}"><a href="${escapeHtml(c.join.url)}" style="${emailLinkStyle}">${htmlText(c.join.url)}</a></p>
</div>`
    : ''
  const bookingLink = c.bookingUrl
    ? `<div style="margin: 24px 0 0;">${emailButton(t('Open in Hourmere'), c.bookingUrl, false, c.language)}</div>`
    : ''
  const afterDetails = [
    answers,
    join,
    bookingLink,
    links,
    ...(!c.manageLinks ? [footer] : []),
    `<p style="margin: 24px 0 0; color: #555; font-size: 13px; ${emailWrapStyle}">${htmlText(c.receivedWhy)}</p>`,
  ]
    .filter(Boolean)
    .join('\n')
  const html = emailLayout(
    c.language,
    subject,
    `<p style="margin: 0 0 16px; ${emailWrapStyle}">${htmlText(c.intro)}</p>
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

// --- Emails -------------------------------------------------------------------------------

const field = (label: string, text: string) => ({ label, text })

/**
 * The email about a booking event for one recipient, with times in the recipient's zone.
 * Manage links go only to the invitee and never into an attachment; cancellations carry none.
 */
export function bookingEmail(
  kind: BookingEmailKind,
  meeting: BookingEmailMeeting,
  recipient: BookingEmailRecipient,
  options: { attachment?: MailAttachment | undefined; bookingUrl?: string | undefined } = {},
): MailMessage {
  const event = singleLine(meeting.eventName)
  const host = singleLine(meeting.hostName)
  const invitee = singleLine(meeting.inviteeName)
  const isHost = recipient.role === 'host'
  // Who the meeting is with, from the recipient's side.
  const other = isHost ? invitee : host
  const language = interfaceLanguage(recipient.locale) ?? 'en'
  const t = (key: MailKey, values?: Record<string, string>) => message(language, key, values)
  const when = formatShortTime(meeting.start, recipient.timeZone, language)
  const values = { event, host, invitee, other, when }

  const subjects = {
    conference_failed: 'Meeting link needs attention: {event} on {when}',
    confirmed: isHost
      ? 'New booking: {event} with {invitee} on {when}'
      : 'Confirmed: {event} with {host} on {when}',
    rescheduled: 'Rescheduled: {event} with {other}, now {when}',
    cancelled: 'Cancelled: {event} with {other} on {when}',
    reminder: 'Reminder: {event} with {other} on {when}',
  } satisfies Record<BookingEmailKind, MailKey>
  const subject = t(subjects[kind], values)
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
  const intro = t(intros[kind], values)

  const fields: Content['fields'] = [
    field(t('What'), event),
    field(t('When'), formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, language)),
  ]
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
  if (meeting.location) {
    const location = meeting.location
    // Join URLs belong to the action below the details, and never to a cancelled email.
    const locationText =
      location.kind === 'link'
        ? singleLine(location.label ?? '') || t('Online meeting')
        : locationForText(location, language)
    fields.push(field(t('Where'), locationText))
  }
  if (isHost) {
    fields.push(field(t('Invitee'), `${invitee} <${singleLine(meeting.inviteeEmail)}>`))
    if (meeting.guests?.length) {
      fields.push(
        field(
          t('Guests'),
          meeting.guests.map((g) => `${singleLine(g.name)} <${singleLine(g.email)}>`).join('\n'),
        ),
      )
    }
  } else {
    fields.push(field(t('Host'), host))
  }
  if (kind === 'cancelled' && meeting.cancelReason) {
    const reason = multiLine(meeting.cancelReason)
    if (reason) fields.push(field(t('Reason'), reason))
  }

  const answers = isHost
    ? recipient.answers
        .map((a) => ({ question: singleLine(a.question), answer: multiLine(a.answer) }))
        .filter((a) => a.question && a.answer)
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
  const joinUrl = meeting.location?.kind === 'link' ? linkableUrl(meeting.location.url) : null
  const join =
    joinUrl &&
    meeting.location?.kind === 'link' &&
    kind !== 'cancelled' &&
    kind !== 'conference_failed'
      ? { label: joinLabel(meeting.location, language), url: joinUrl }
      : undefined
  const bookingUrl =
    isHost && options.bookingUrl ? (linkableUrl(options.bookingUrl) ?? undefined) : undefined
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
      fields,
      answers,
      join,
      bookingUrl,
      manageLinks,
      footer,
      receivedWhy: t(receivedWhy, { host, invitee }),
    },
    options.attachment,
  )
}
