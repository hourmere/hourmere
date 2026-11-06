import { webhookUrl } from './transport.ts'

/** Only Slack's documented commercial incoming-webhook endpoint. */
export function slackUrl(value: unknown): string | undefined {
  const normalized = webhookUrl(value)
  if (!normalized || typeof value !== 'string') return undefined
  if (
    !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
      value,
    )
  )
    return undefined
  return normalized
}

export function escapeSlackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '＠')
}

/** Each user field is bounded before escaping so snapshots stay below the 8 KiB outbox
 * limit even with four-byte Unicode and entity expansion. Team snapshots omit invitees. */
export function slackPayload(event: {
  type: string
  bookingId?: string
  start?: string
  end?: string
  status?: string
  eventTypeTitle?: string | null
  timeZone?: string
  inviteeName?: string
  bookingUrl?: string
}) {
  const field = (value: string | null | undefined) =>
    [...(value ?? '')]
      .slice(0, 120)
      .join('')
      .replaceAll(/[\r\n]/g, ' ')
  const localTime = (value: string | undefined) => {
    if (!value) return ''
    try {
      return Temporal.Instant.from(value)
        .toZonedDateTimeISO(event.timeZone ?? 'UTC')
        .toString({ smallestUnit: 'minute' })
    } catch {
      return field(value)
    }
  }
  const lines = [
    event.bookingId ? `Hourmere: ${field(event.type)}` : 'Hourmere: test notification',
    ...(event.bookingId
      ? [
          `Event: ${field(event.eventTypeTitle) || 'Deleted event type'}`,
          `Booking: ${field(event.bookingId)}`,
          `Start: ${localTime(event.start)}`,
          `End: ${localTime(event.end)}`,
          `Status: ${field(event.status)}`,
          ...(event.inviteeName ? [`Invitee: ${field(event.inviteeName)}`] : []),
          ...(event.bookingUrl && escapeSlackText(event.bookingUrl).length <= 600
            ? [event.bookingUrl]
            : []),
        ]
      : ['Your Slack destination is connected.']),
  ].map(escapeSlackText)
  const text = lines.join('\n')
  return JSON.stringify({
    text,
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
  })
}
