# Slack booking notifications

The [Slack guide](https://hourmere.com/docs/slack) covers app creation, channel setup,
destination management, message privacy and the REST, MCP and CLI interfaces.

## Self-hosted setup

In the Slack app dashboard, create an app in the target workspace, enable **Incoming
Webhooks**, then choose **Add New Webhook to Workspace** and authorize the channel.
For a private channel, join it before authorizing. Slack grants the
`incoming-webhook` scope for this installation. Hourmere has no Slack OAuth flow,
requests no Slack scopes and registers no redirect URL. It uses the channel-specific
incoming-webhook URL as its only Slack credential.
[Slack's app setup guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)

| Environment variable | Usage |
|---|---|
| `WEBHOOKS_ENABLED` | Set to `true` on web and worker to capture and deliver Slack and generic webhook events. Defaults to `false`. Work processed while disabled is skipped. |
| `WEBHOOK_ENCRYPTION_KEY` | The same independent 32-byte base64 key on web and worker. The server requires it when webhooks are enabled, and creating or replacing a Slack URL requires it. Keep it stable and backed up. |
| `PUBLIC_URL` | Hourmere's public origin, used to build the authenticated booking link. |

Keep a worker running with HTTPS egress to `hooks.slack.com`. The personal owner or a
current team owner/admin opens **Settings → Integrations → Slack booking notifications**
in the target Hourmere space, saves the URL and subscriptions, then sends a synthetic
test and verifies arrival in Slack. To change channels, authorize a new Slack webhook
and replace the saved URL. The sender uses the current URL for queued work and retries.

Deleting the Hourmere destination cascades retained delivery records and leaves pending
jobs with nothing to send. Revoke the webhook in Slack or uninstall the app there to
invalidate the URL. Hourmere does not call Slack's token revocation API.
[Slack's app removal guide](https://slack.com/help/articles/360003125231-Remove-apps-and-custom-integrations-from-your-workspace)

## Events and message data

Slack destinations share the webhook endpoint, snapshot and outbox machinery. When
`WEBHOOKS_ENABLED=true`, booking changes enqueue subscribed Slack work in the booking
transaction. The settings page offers the first three events and preserves the other
subscriptions on save.

<!-- slack-events:start -->
- `booking.created`
- `booking.rescheduled`
- `booking.cancelled`
- `booking.reschedule_requested`
- `booking.reschedule_request_expired`
<!-- slack-events:end -->

The first line identifies the event. Reschedule requests and their expirations retain
the confirmed booking's times and status. A move does not post a second cancellation
for the old time. Attendee no-show changes and workflow events are signed-webhook
subscriptions only.

The snapshot contains a booking ID, event-type title, start/end with offsets, status,
and an authenticated admin booking link when the configured public origin fits the
payload limit. Personal destinations also include the booker's name. They use the
personal owner's public profile time zone with a UTC fallback. Team destinations use
UTC and omit all attendee and host details. Neither includes email addresses, custom
answers, free-text booking titles, cancellation reasons, request IDs or notes, private
management links, or meeting links.

Build the payload from an explicit field list. Copying a booking DTO risks adding
private fields. Block Kit uses `plain_text`; formatting and link previews are off.
Truncate user text before escaping `&`, `<`, `>` and replacing `@` with `＠`.
Slack may auto-link a plain web address. Keep channel access in mind when choosing
a destination for personal bookings.

## Authorization, retries and failures

- Current verified owners/admins manage Slack destinations, including through API keys,
  MCP OAuth and CLI. Browser writes also bind to the expected organization. The
  service rechecks authority after waiting for the destination row.
- The URL is encrypted with the webhook key and API responses expose only its masked
  form. Audit details include the subscribed events. Keep input URLs, network error
  text and Slack response bodies out of logs. Use fixed failure codes.
- The sender accepts exact commercial `hooks.slack.com/services/` HTTPS URLs, rechecks
  public DNS on every attempt and pins the validated address. GovSlack, redirects and
  private-target exceptions are unsupported. Slack does not verify the Hourmere HMAC.
- Slack documents a general channel posting rate of one message per second with short
  bursts. HTTP 429 uses the same Hourmere retry budget as other retryable HTTP and
  transport failures. The transport does not read Slack's `Retry-After` header.
  [Slack's rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- A Slack 404/410 fails that delivery immediately and pauses the destination with
  `pause_reason = 'url_rejected'`. This applies when Slack rejects a revoked URL with
  one of those statuses, including if shutdown races an already received response.
  Replacing the URL or explicitly enabling the destination clears the reason. An
  ordinary pause of an active destination leaves it null.
- Workers serialize sends per destination. The advisory lock wait is bounded to ten
  seconds and uses the normal retry budget on timeout. The worker restores the original
  lock timeout before taking row locks. The budget is thirteen total attempts with
  exponential backoff starting at one minute, capped at one hour. Ambiguous transport
  results can cause duplicate Slack messages. Successful booking-request replays do
  not enqueue a second event.
- Each attempt rechecks enabled state, subscriptions and the current event-type filter.
  Skipped deliveries do not replay when settings change. Samples bypass the event-type
  filter. Hard deletion of a filtered event type removes the destination and its
  deliveries. There is no backfill or manual replay.

## Synthetic test delivery

REST and MCP share five attempts per minute per organization in each server process.
A request counts after the final authority check finds the destination. An exhausted
budget can reject an authorized call before lookup once preflight authorization passes.
One pending sample per destination is allowed across server instances, including
retries. Another test returns HTTP 409 `slack_test_pending`. HTTP 202 confirms queueing.

Samples enqueue in the delivery-row transaction. They use a null booking and workflow
run ID and store their own event ID in `webhook_deliveries.request_id` so that the unique
delivery key with `NULLS NOT DISTINCT` still permits a later sample. A sample's
`request_id` is its identity marker.

Automated tests use local transport fakes and disposable databases. Real workspace
acceptance is an owner-run check.
