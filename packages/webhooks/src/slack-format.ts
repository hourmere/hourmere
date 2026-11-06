import { webhookUrl } from './transport.ts'

/** Only Slack's documented commercial and GovSlack incoming-webhook endpoints. */
export function slackUrl(value: unknown): string | undefined {
  const normalized = webhookUrl(value)
  if (!normalized || typeof value !== 'string') return undefined
  if (
    !/^https:\/\/hooks\.(?:slack\.com|slack-gov\.com)\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
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

/** Explicit minimum projection also applies to team-wide destinations: no titles, answers,
 * attendees, links, cancellation reasons or reschedule-chain IDs enter the snapshot. */
export function slackPayload(event: {
  type: string
  bookingId?: string
  start?: string
  end?: string
  status?: string
}) {
  const lines = [
    event.bookingId ? `Hourmere: ${event.type}` : 'Hourmere: test notification',
    ...(event.bookingId
      ? [
          `Booking: ${event.bookingId}`,
          `Start (UTC): ${event.start}`,
          `End (UTC): ${event.end}`,
          `Status: ${event.status}`,
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
