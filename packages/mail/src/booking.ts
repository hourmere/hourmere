// Emails about a booking, to its attendees and its hosts: confirmed, rescheduled, cancelled
// and reminder. Plain text plus simple HTML with inline styles: no images, no external
// assets, no tracking. Everything from the booking is someone's input and is treated so.
import type { MailAttachment, MailMessage } from './index.ts'
import { escapeHtml, linkableUrl, multiLine, singleLine, subjectLine } from './text.ts'

export type BookingEmailKind = 'confirmed' | 'rescheduled' | 'cancelled' | 'reminder'

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
  manageLinks?: ManageLinks | undefined
}

export interface HostRecipient {
  role: 'host'
  email: string
  /** IANA time zone the times are shown in. */
  timeZone: string
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

// ICU puts a narrow no-break space before AM/PM; a plain space reads the same everywhere.
const format = (time: Temporal.ZonedDateTime, options: Intl.DateTimeFormatOptions) =>
  time.toLocaleString('en-US', options).replace(/[\u00a0\u202f]/g, ' ')

/** `Tuesday, October 20, 2026, 10:00 AM – 10:30 AM (Europe/Berlin)` */
export function formatMeetingTime(
  start: Temporal.Instant,
  end: Temporal.Instant,
  timeZone: string,
): string {
  const zone = displayZone(timeZone)
  const s = start.toZonedDateTimeISO(zone)
  const e = end.toZonedDateTimeISO(zone)
  const until = s.toPlainDate().equals(e.toPlainDate())
    ? format(e, TIME)
    : `${format(e, LONG_DATE)}, ${format(e, TIME)}`
  return `${format(s, LONG_DATE)}, ${format(s, TIME)} – ${until} (${zone})`
}

/** `Tue, Oct 20, 10:00 AM (Europe/Berlin)`, for subject lines. */
function formatShortTime(start: Temporal.Instant, timeZone: string): string {
  const zone = displayZone(timeZone)
  const s = start.toZonedDateTimeISO(zone)
  return `${format(s, SHORT_DATE)}, ${format(s, TIME)} (${zone})`
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

function locationForText(location: MeetingLocation): string {
  if (location.kind === 'link' && location.label) {
    return `${singleLine(location.label)}: ${singleLine(location.url)}`
  }
  if (location.kind === 'phone') return `Phone ${singleLine(location.number)}`
  return meetingLocationText(location)
}

function locationForHtml(location: MeetingLocation): string {
  if (location.kind === 'link') {
    const url = linkableUrl(location.url)
    const label = location.label ? `${escapeHtml(singleLine(location.label))}: ` : ''
    const text = escapeHtml(singleLine(location.url))
    return url
      ? `${label}<a href="${escapeHtml(url)}" style="color: #111;">${text}</a>`
      : `${label}${text}`
  }
  return htmlLines(locationForText(location))
}

// --- Layout -------------------------------------------------------------------------------

const htmlLines = (text: string) => escapeHtml(text).replaceAll('\n', '<br>')

/** `Label: value`, with further lines of the value indented. */
const textField = (label: string, value: string) => `${label}: ${value.replaceAll('\n', '\n  ')}`

interface Content {
  subject: string
  intro: string
  /** Label and value (already cleaned); the HTML value is escaped markup. */
  fields: { label: string; text: string; html: string }[]
  answers: readonly { question: string; answer: string }[]
  manageLinks?: ManageLinks | undefined
}

function render(to: string, c: Content, attachment?: MailAttachment): MailMessage {
  const subject = subjectLine(c.subject)
  const text = [
    c.intro,
    '',
    ...c.fields.map((f) => textField(f.label, f.text)),
    ...(c.answers.length
      ? [
          '',
          'Answers',
          ...c.answers.map((a) => `${a.question}\n  ${a.answer.replaceAll('\n', '\n  ')}`),
        ]
      : []),
    ...(c.manageLinks
      ? [
          '',
          'Need to make a change?',
          `Reschedule: ${c.manageLinks.reschedule}`,
          `Cancel: ${c.manageLinks.cancel}`,
        ]
      : []),
  ].join('\n')

  const cell = 'padding: 2px 16px 2px 0; vertical-align: top;'
  const rows = c.fields
    .map(
      (f) =>
        `<tr><td style="${cell} color: #555;">${escapeHtml(f.label)}</td><td style="${cell}">${f.html}</td></tr>`,
    )
    .join('\n')
  const answers = c.answers.length
    ? `<p style="margin: 24px 0 4px; font-weight: 600;">Answers</p>\n${c.answers
        .map(
          (a) =>
            `<p style="margin: 0 0 12px;"><span style="color: #555;">${htmlLines(a.question)}</span><br>${htmlLines(a.answer)}</p>`,
        )
        .join('\n')}`
    : ''
  const button =
    'display: inline-block; padding: 8px 14px; margin-right: 8px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;'
  const links = c.manageLinks
    ? `<p style="margin: 24px 0 8px;">Need to make a change?</p>
<p style="margin: 0 0 8px;"><a href="${escapeHtml(c.manageLinks.reschedule)}" style="${button}">Reschedule</a><a href="${escapeHtml(c.manageLinks.cancel)}" style="${button}">Cancel</a></p>
<p style="margin: 0; color: #555; font-size: 13px;">If the buttons do not work, copy a link into your browser:<br>Reschedule: ${escapeHtml(c.manageLinks.reschedule)}<br>Cancel: ${escapeHtml(c.manageLinks.cancel)}</p>`
    : ''
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
<p style="margin: 0 0 16px;">${escapeHtml(c.intro)}</p>
<table role="presentation" style="border-collapse: collapse;">
${rows}
</table>
${answers}
${links}
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

const field = (label: string, text: string) => ({ label, text, html: htmlLines(text) })

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
  const when = formatShortTime(meeting.start, recipient.timeZone)

  const subject = {
    confirmed: isHost
      ? `New booking: ${event} with ${invitee} on ${when}`
      : `Confirmed: ${event} with ${host} on ${when}`,
    rescheduled: `Rescheduled: ${event} with ${other}, now ${when}`,
    cancelled: `Cancelled: ${event} with ${other} on ${when}`,
    reminder: `Reminder: ${event} with ${other} on ${when}`,
  }[kind]
  const intro = {
    confirmed: isHost
      ? `${invitee} booked a meeting with you.`
      : `Your meeting with ${host} is booked.`,
    rescheduled: `Your meeting with ${other} has moved to a new time.`,
    cancelled: `Your meeting with ${other} has been cancelled.`,
    reminder: `Your meeting with ${other} is coming up.`,
  }[kind]

  const fields = [
    field('What', event),
    field('When', formatMeetingTime(meeting.start, meeting.end, recipient.timeZone)),
  ]
  if (kind === 'rescheduled' && meeting.previous) {
    fields.push(
      field(
        'Was',
        formatMeetingTime(meeting.previous.start, meeting.previous.end, recipient.timeZone),
      ),
    )
  }
  if (meeting.location) {
    fields.push({
      label: 'Where',
      text: locationForText(meeting.location),
      html: locationForHtml(meeting.location),
    })
  }
  if (isHost) {
    fields.push(field('Invitee', `${invitee} <${singleLine(meeting.inviteeEmail)}>`))
    if (meeting.guests?.length) {
      fields.push(
        field(
          'Guests',
          meeting.guests.map((g) => `${singleLine(g.name)} <${singleLine(g.email)}>`).join('\n'),
        ),
      )
    }
  } else {
    fields.push(field('Host', host))
  }
  if (kind === 'cancelled' && meeting.cancelReason) {
    const reason = multiLine(meeting.cancelReason)
    if (reason) fields.push(field('Reason', reason))
  }

  const answers = isHost
    ? recipient.answers
        .map((a) => ({ question: singleLine(a.question), answer: multiLine(a.answer) }))
        .filter((a) => a.question && a.answer)
    : []
  const manageLinks =
    recipient.role === 'attendee' && kind !== 'cancelled' ? recipient.manageLinks : undefined

  return render(
    recipient.email,
    { subject, intro, fields, answers, manageLinks },
    options.attachment,
  )
}
