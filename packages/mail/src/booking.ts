// Emails about a booking, to its attendees and its hosts: confirmed, rescheduled, cancelled
// and reminder. Plain text plus simple HTML with inline styles: no images, no external
// assets, no tracking. Everything from the booking is someone's input and is treated so.
import { type InterfaceLanguage, interfaceLanguage } from '@hourmere/core/language'
import type { MailAttachment, MailMessage } from './index.ts'
import {
  escapeHtml,
  formatChineseTemplate,
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

export interface BookingEmailMeeting {
  eventName: string
  hostName: string
  /** The invitee who booked. */
  inviteeName: string
  inviteeEmail: string
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

// --- Times --------------------------------------------------------------------------------

/** The zone's canonical name, or UTC when it is not a valid IANA time zone. */
function displayZone(timeZone: string): string {
  if (timeZone === '' || /^[+-]/.test(timeZone)) return 'UTC'
  try {
    return new Temporal.ZonedDateTime(0n, timeZone).timeZoneId
  } catch {
    return 'UTC'
  }
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
  new Intl.DateTimeFormat(language === 'en' ? 'en-US' : language, {
    ...(language === 'zh-CN' && options === TIME ? CHINESE_TIME : options),
    timeZone: time.timeZoneId,
  })
    .format(time.epochMilliseconds)
    .replace(/[\u00a0\u202f]/g, ' ')

/** `Tuesday, October 20, 2026, 10:00 AM – 10:30 AM (Europe/Berlin)` */
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
    : language === 'zh-CN'
      ? `${format(e, LONG_DATE, language)}，${format(e, TIME, language)}`
      : `${format(e, LONG_DATE, language)}, ${format(e, TIME, language)}`
  return language === 'zh-CN'
    ? `${format(s, LONG_DATE, language)}，${format(s, TIME, language)} 至 ${until}（${zone}）`
    : `${format(s, LONG_DATE, language)}, ${format(s, TIME, language)} – ${until} (${zone})`
}

/** `Tue, Oct 20, 10:00 AM (Europe/Berlin)`, for subject lines. */
function formatShortTime(
  start: Temporal.Instant,
  timeZone: string,
  language: InterfaceLanguage,
): string {
  const zone = displayZone(timeZone)
  const s = start.toZonedDateTimeISO(zone)
  return language === 'zh-CN'
    ? `${format(s, SHORT_DATE, language)}，${format(s, TIME, language)}（${zone}）`
    : `${format(s, SHORT_DATE, language)}, ${format(s, TIME, language)} (${zone})`
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

function locationForHtml(location: MeetingLocation, language: InterfaceLanguage): string {
  if (location.kind === 'link') {
    const url = linkableUrl(location.url)
    const label = location.label
      ? `${escapeHtml(singleLine(location.label))}${language === 'zh-CN' ? '：' : ': '}`
      : ''
    const text = escapeHtml(singleLine(location.url))
    return url
      ? `${label}<a href="${escapeHtml(url)}" style="color: #111;">${text}</a>`
      : `${label}${text}`
  }
  return htmlLines(locationForText(location, language))
}

// --- Layout -------------------------------------------------------------------------------

const htmlLines = (text: string) => escapeHtml(text).replaceAll('\n', '<br>')

/** `Label: value`, with further lines of the value indented. */
const textField = (label: string, value: string, language: InterfaceLanguage) =>
  `${label}${language === 'zh-CN' ? '：' : ': '}${value.replaceAll('\n', '\n  ')}`

interface Content {
  language: InterfaceLanguage
  subject: string
  intro: string
  /** Label and value (already cleaned); the HTML value is escaped markup. */
  fields: { label: string; text: string; html: string }[]
  answers: readonly { question: string; answer: string }[]
  manageLinks?: ManageLinks | undefined
  footer?: { language: InterfaceLanguage; text: string } | undefined
}

function render(to: string, c: Content, attachment?: MailAttachment): MailMessage {
  const subject = subjectLine(c.subject)
  const t = (key: keyof typeof chinese) => message(c.language, key)
  // Put invitation guidance beside the invitee's actions before the meeting details.
  // Other messages retain their existing layout, and hosts/guests get no manage links.
  const invitationActions = Boolean(c.manageLinks && c.footer)
  const actionText = c.manageLinks
    ? [
        '',
        t('Need to make a change?'),
        textField(t('Reschedule'), c.manageLinks.reschedule, c.language),
        textField(t('Cancel'), c.manageLinks.cancel, c.language),
        ...(invitationActions && c.footer ? [c.footer.text] : []),
      ]
    : []
  const text = [
    c.intro,
    ...(invitationActions ? actionText : []),
    '',
    ...c.fields.map((f) => textField(f.label, f.text, c.language)),
    ...(c.answers.length
      ? [
          '',
          t('Answers'),
          ...c.answers.map((a) => `${a.question}\n  ${a.answer.replaceAll('\n', '\n  ')}`),
        ]
      : []),
    ...(!invitationActions ? actionText : []),
    ...(c.footer && !invitationActions ? ['', c.footer.text] : []),
  ].join('\n')

  const cell = 'padding: 2px 16px 2px 0; vertical-align: top;'
  const rows = c.fields
    .map(
      (f) =>
        `<tr><td style="${cell} color: #555;">${escapeHtml(f.label)}</td><td style="${cell}">${f.html}</td></tr>`,
    )
    .join('\n')
  const answers = c.answers.length
    ? `<p style="margin: 24px 0 4px; font-weight: 600;">${t('Answers')}</p>\n${c.answers
        .map(
          (a) =>
            `<p style="margin: 0 0 12px;"><span style="color: #555;">${htmlLines(a.question)}</span><br>${htmlLines(a.answer)}</p>`,
        )
        .join('\n')}`
    : ''
  const button =
    'display: inline-block; padding: 8px 14px; margin-right: 8px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;'
  const footer = c.footer
    ? `<p lang="${c.footer.language}" style="margin: ${invitationActions ? '0 0 8px' : '24px 0 0'}; color: #555; font-size: 13px;">${escapeHtml(c.footer.text)}</p>`
    : ''
  const links = c.manageLinks
    ? `<p style="margin: 24px 0 8px;">${t('Need to make a change?')}</p>
<p style="margin: 0 0 8px;"><a href="${escapeHtml(c.manageLinks.reschedule)}" style="${button}">${t('Reschedule')}</a><a href="${escapeHtml(c.manageLinks.cancel)}" style="${button}">${t('Cancel')}</a></p>
${invitationActions ? `${footer}\n` : ''}<p style="margin: 0; color: #555; font-size: 13px;">${t('If the buttons do not work, copy a link into your browser:')}<br>${escapeHtml(textField(t('Reschedule'), c.manageLinks.reschedule, c.language))}<br>${escapeHtml(textField(t('Cancel'), c.manageLinks.cancel, c.language))}</p>`
    : ''
  const afterDetails = [answers, ...(invitationActions ? [] : [links, footer])]
    .filter(Boolean)
    .join('\n')
  const html = `<!doctype html>
<html lang="${c.language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
<p style="margin: 0 0 16px;">${escapeHtml(c.intro)}</p>
${invitationActions ? `${links}\n` : ''}<table role="presentation" style="border-collapse: collapse;">
${rows}
</table>${afterDetails ? `\n${afterDetails}` : ''}
</body>
</html>
`
  return {
    to,
    subject,
    text: `${text}\n`,
    html,
    ...(attachment && { attachments: [attachment] }),
  }
}

// --- Emails -------------------------------------------------------------------------------

// English keys are the original email copy, shared by both renderings.
const chinese = {
  What: '活动',
  When: '时间',
  Was: '原时间',
  Where: '地点',
  Invitee: '预约人',
  Guests: '来宾',
  Host: '主持人',
  Reason: '原因',
  Phone: '电话',
  Answers: '回答',
  'Need to make a change?': '需要更改预约吗？',
  Reschedule: '改期',
  Cancel: '取消',
  'If the buttons do not work, copy a link into your browser:':
    '如果按钮无法使用，请将链接复制到浏览器中：',
  'Meeting link needs attention: {event} on {when}': '会议链接需要处理：{event}，{when}',
  'New booking: {event} with {invitee} on {when}': '新预约：与{invitee}的{event}，{when}',
  'Confirmed: {event} with {host} on {when}': '已确认：与{host}的{event}，{when}',
  'Rescheduled: {event} with {other}, now {when}': '已改期：与{other}的{event}，现为 {when}',
  'Cancelled: {event} with {other} on {when}': '已取消：与{other}的{event}，{when}',
  'Reminder: {event} with {other} on {when}': '提醒：与{other}的{event}，{when}',
  'The time is reserved, but Google Meet could not be prepared. Open this booking in Hourmere to review the problem, retry safe reconciliation or cancel. No final calendar invitation has been sent.':
    '时段已保留，但无法准备 Google Meet 链接。请在 Hourmere 中打开此预约，查看问题、重试同步或取消预约。最终日历邀请尚未发送。',
  'Your time is reserved, but the host needs to fix the Google Meet link. No final calendar invitation has been sent. You can use the links below to manage or cancel the booking.':
    '时段已为你保留，但主持人需要修复 Google Meet 链接。最终日历邀请尚未发送。你可以使用以下链接管理或取消预约。',
  '{invitee} booked a meeting with you.': '{invitee}预约了与你的会议。',
  'Your meeting with {host} is booked.': '你与{host}的会议已预约。',
  'Your meeting with {other} has moved to a new time.': '你与{other}的会议已改期。',
  'Your meeting with {other} has been cancelled.': '你与{other}的会议已取消。',
  'Your meeting with {other} is coming up.': '你与{other}的会议即将开始。',
} as const

function message(
  language: InterfaceLanguage,
  key: keyof typeof chinese,
  values: Record<string, string> = {},
): string {
  if (language === 'zh-CN') return formatChineseTemplate(chinese[key], values)
  return key.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder)
}

const field = (label: string, text: string) => ({ label, text, html: htmlLines(text) })
const calendarDecline = {
  en: {
    invitee:
      'Accepting or declining this calendar invitation does not cancel the booking. To cancel, use the Cancel link in this email.',
    host: 'Declining in your calendar is not synced to Hourmere; to cancel the booking, use Hourmere.',
    guest:
      'Accepting or declining this calendar invitation does not cancel the booking. To cancel, contact the person who booked or the host.',
  },
  'zh-CN': {
    invitee: '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用此邮件中的“取消”链接。',
    host: '在日历中拒绝邀请不会同步到 Hourmere；如需取消预约，请在 Hourmere 中操作。',
    guest: '在日历中接受或拒绝邀请不会取消预约。如需取消，请联系预约人或主持人。',
  },
}

/**
 * The email about a booking event for one recipient, with times in the recipient's zone.
 * Manage links go only to the invitee and never into an attachment; cancellations carry none.
 */
export function bookingEmail(
  kind: BookingEmailKind,
  meeting: BookingEmailMeeting,
  recipient: BookingEmailRecipient,
  options: { attachment?: MailAttachment | undefined } = {},
): MailMessage {
  const event = singleLine(meeting.eventName)
  const host = singleLine(meeting.hostName)
  const invitee = singleLine(meeting.inviteeName)
  const isHost = recipient.role === 'host'
  // Who the meeting is with, from the recipient's side.
  const other = isHost ? invitee : host
  const language = interfaceLanguage(recipient.locale) ?? 'en'
  const t = (key: keyof typeof chinese, values?: Record<string, string>) =>
    message(language, key, values)
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
  } satisfies Record<BookingEmailKind, keyof typeof chinese>
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
  } satisfies Record<BookingEmailKind, keyof typeof chinese>
  const intro = t(intros[kind], values)

  const fields = [
    field(t('What'), event),
    field(t('When'), formatMeetingTime(meeting.start, meeting.end, recipient.timeZone, language)),
  ]
  if (kind === 'rescheduled' && meeting.previous) {
    fields.push(
      field(
        t('Was'),
        formatMeetingTime(
          meeting.previous.start,
          meeting.previous.end,
          recipient.timeZone,
          language,
        ),
      ),
    )
  }
  if (meeting.location) {
    fields.push({
      label: t('Where'),
      text: locationForText(meeting.location, language),
      html: locationForHtml(meeting.location, language),
    })
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
      ? { language, text: calendarDecline[language][footerRole] }
      : undefined

  return render(
    recipient.email,
    { language, subject, intro, fields, answers, manageLinks, footer },
    options.attachment,
  )
}
