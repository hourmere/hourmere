---
title: Slack booking notifications
description: Send booking updates to Slack using a private incoming-webhook URL.
---

Connect one Slack destination to each personal or team organization in **Settings →
Integrations → Slack booking notifications**. Paste an existing Slack incoming-webhook
URL, select booking creation, cancellation and/or rescheduling, and save. Optionally
choose an event type to restrict notifications. Choose **All event types** to receive
notifications for every event type in that organization. You can pause notifications, replace the URL or delete the
destination at any time. An unavailable saved event type retains its filter; it never
silently expands to all event types. Permanently deleting the filtered event type also
deletes its Slack destination and retained deliveries. **Send test message** queues a synthetic sample; check the
chosen Slack channel to confirm that it arrived.

Hourmere does not install a Slack app or perform Slack OAuth. A workspace administrator
must supply an incoming-webhook URL already authorized for the intended channel. Follow
[Slack's incoming-webhook instructions](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
to obtain one. Slack controls which channel receives messages; Hourmere cannot change it
independently of the URL. No Slack account or workspace is created by Hourmere.

## Permissions and secrets

Only the personal owner or current team owners/admins can manage a destination. Ordinary
team members cannot inspect or change it. Switching spaces changes the destination you
manage. Stale browser writes are rejected and require reloading before retrying.

The URL is a bearer secret. It is encrypted at rest and returned only in masked form,
including immediately after saving. Keep the original in a secure secret store if needed.
The browser clears the URL after submission, including a failed submission; enter it again
to retry. Never paste it into logs, source control, shell history or support messages.

Only HTTPS URLs under `https://hooks.slack.com/services/` are accepted. Slack documents
the `slack-gov.com` domain for GovSlack, but its guides do not name the exact incoming-webhook
host. GovSlack and regional hosts are currently unsupported.
User information, query parameters, fragments and alternate ports are refused. Each
attempt rechecks the URL and public DNS addresses through the outbound guard, pins the
validated address to the socket and does not follow redirects. Private-webhook target
exceptions do not apply to Slack.

## What is sent

Messages use Block Kit and a plain-text fallback. They contain the booking ID, event-type
title, start/end times with UTC offset, status, and an authenticated admin booking link.
Personal destinations also include the invitee name. Team destinations send only the
listed booking fields and omit attendee and host details. Neither sends email addresses,
custom answers, free-text booking titles, cancellation reasons, management tokens,
conference URLs or calendar credentials.

User-controlled text is the event-type title and, for personal destinations, the invitee
name. Hourmere escapes `&`, `<` and `>` as `&amp;`, `&lt;` and `&gt;`, replaces `@` with
the full-width `＠`, and sends the message as `plain_text` with Slack formatting (`mrkdwn`)
and link unfurling turned off. That text therefore cannot mention people or channels
(including `@here` and `<!channel>`), apply formatting or form a labelled link such as
`<https://example.com|label>`. Hourmere does not alter web addresses in that text: Slack
may show a plain address or domain name as a clickable link that displays the address
itself, just as it does for the admin booking link.

Every Slack event type uses the same message layout. The first line names the event type:

<!-- slack-events:start -->
| Event type | Sent when | First line |
|---|---|---|
| `booking.created` | A booking is made | `Hourmere: booking.created` |
| `booking.rescheduled` | A booking moves to a new time | `Hourmere: booking.rescheduled` |
| `booking.cancelled` | A booking is cancelled | `Hourmere: booking.cancelled` |
| `booking.reschedule_requested` | A host asks the invitee to choose a new time | `Hourmere: booking.reschedule_requested` |
| `booking.reschedule_request_expired` | That request expires without a new time | `Hourmere: booking.reschedule_request_expired` |
<!-- slack-events:end -->

The remaining lines are the same for every event type. Request events keep the booking's
current times and `confirmed` status. They do not include the request ID or its message.

Times use the personal organization owner’s public profile time zone, including the UTC
offset at the booking instant. There is no team organization time-zone setting; team
destinations use UTC (`+00:00`) explicitly. A missing personal profile also falls back to
UTC. Event titles and personal invitee names are truncated before escaping to keep both
Slack blocks and the stored payload within their size limits.

Rescheduling emits a reschedule notification, without an additional cancellation for the
old booking. A later cancellation emits its own event. The saved snapshot is immutable;
arrival order need not match booking order. Stored UTC instants preserve the actual
meeting time across daylight-saving changes.

Each attempt uses the destination's current URL, enabled state, subscriptions and
event-type filter, including retries of older snapshots. Replacing the URL can send
already queued notifications to the new channel. Paused, unsubscribed or filtered-out
deliveries are permanently skipped when processed; reenabling or broadening the filter
does not replay skipped events. Changes wait for an in-flight attempt to finish.
The sample notification has no booking and bypasses the event-type filter.

## REST, MCP and CLI

| Action | REST under `/api/v1` | MCP | CLI |
|---|---|---|---|
| List | `GET /slack-destinations` | `list_slack_destinations` | `slack list` |
| Create | `POST /slack-destinations` | `create_slack_destination` | `slack create` |
| Update | `PATCH /slack-destinations/{id}` | `update_slack_destination` | `slack update` |
| Delete | `DELETE /slack-destinations/{id}` | `delete_slack_destination` | `slack delete` |
| Test | `POST /slack-destinations/{id}/test` | `test_slack_destination` | `slack test` |

Creation accepts `{ url, events, isActive?, eventTypeId? }`. `events` is a nonempty,
duplicate-free selection of the five event types listed under [What is sent](#what-is-sent).
The settings page offers booking created, cancelled and rescheduled. Use REST, MCP or the
CLI to subscribe to the two reschedule-request events; saving from the settings page keeps
them. `eventTypeId` is a UUID belonging to this organization or null. Update accepts the same
fields optionally; omitting a field preserves it, and null clears the event-type filter.
Responses contain only destination metadata and a masked URL. `pauseReason` is
`url_rejected` after Slack answered 404/410 and stays until you replace the URL or enable
the destination. It is null while the destination is active and after you pause an active
destination. Treat any other value as paused. Test returns a `deliveryId`
and HTTP 202, which acknowledges queueing rather than Slack acceptance. While a sample is
pending (including retries), another test receives HTTP 409 `slack_test_pending`. REST and
MCP share a limit of five test requests per minute per organization in each server process
(HTTP 429 on REST). Only requests from a current owner/admin for an existing destination
count; refused (403) and unknown-destination (404) requests do not, so team members cannot
use up the admins' limit. The pending-sample guard applies across all server instances.

API keys need `read` or `full` to list and `full` to create, update, delete or test;
organization ownership/admin permission still applies. Browser-session writes require
`X-Expected-Organization-Id`; reads accept it too. MCP and CLI use the same service checks.
Use the CLI's JSON input support to supply configuration privately; avoid putting a secret
URL directly in a shell command. Consult `hourmere --help` (or `npm run --silent cli -- --help` from source) for command options.

## Self-hosting and delivery

The complete feature is available to self-hosters. Configure a stable, independent
`WEBHOOK_ENCRYPTION_KEY` (32 random bytes in base64) on both web and worker processes,
and keep a worker running. Back up the key securely; losing it makes saved URLs
unreadable. Set `WEBHOOKS_ENABLED=true` on both web and worker. Setting it to `false`
stops new Slack capture and outbound delivery as well as generic webhooks; queued work
processed while disabled is skipped.

Slack reuses Hourmere's webhook transactional outbox, durable delivery IDs, bounded retry
schedule and failure tracking. Booking changes and notification enqueue commit or roll
back together. Replaying a successful booking request does not enqueue another event.
The existing retry budget is thirteen total attempts, starting at one minute and doubling
with jitter up to one hour. A Slack 404/410 instead stops after one attempt and pauses
the destination. Settings then says Slack rejected the URL; replace it and enable
notifications before testing again. A destination you pause yourself shows only that
notifications are paused. Sends to one destination run one at a time across workers. A
worker waits at most 10 seconds for another worker's send. After that, it retries later
on the normal schedule, and that run counts as one of the thirteen attempts. See [webhook delivery limits](/docs/webhooks#delivery-and-operational-limits).

Slack incoming webhooks do **not** verify Hourmere's outbound webhook signature, and
Slack request signing is for requests sent by Slack, not incoming-webhook delivery.
The inherited integrity guarantees are the encrypted destination, HTTPS transport,
immutable transactional snapshot and controlled retries; this is not a claim that Slack
validates an Hourmere HMAC signature.

## Known limitations

- Slack messages currently use English. The settings interface supports
  English and Simplified Chinese.
- One destination per organization; the channel is determined by its webhook URL.
- Notifications are minimal operational updates, not full booking summaries. No custom
  message template, interactive actions or channel selection is supported.
- Slack may turn a plain web address or domain name in an event-type title or a personal
  invitee name into a clickable link. Mentions, formatting and labelled links are blocked.
- The settings page lists three of the five event types; manage the reschedule-request
  events through REST, MCP or the CLI.
- Delivery is at least once. A worker interrupted after Slack accepts a message can retry
  it, and Slack incoming webhooks do not deduplicate Hourmere delivery IDs. Duplicate
  messages are possible. There is no exactly-once or ordering guarantee.
- Saving validates configuration, not Slack availability. A queued test is not proof of
  delivery. No past bookings are backfilled; pausing does not retract messages already sent.
- No Slack app installation, OAuth, message edit/delete or manual delivery replay is offered.
- Use **Send test message** and check the intended channel after setup or URL replacement.
  Hourmere cannot confirm who can read that channel.
