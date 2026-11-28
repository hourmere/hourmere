---
title: Slack booking notifications
description: Send booking updates to a Slack channel with an incoming webhook.
---

Send booking updates to one Slack channel per Hourmere personal or team organization.
The personal owner or a current team owner or admin can manage the destination.

## Create a Slack app and choose a channel

1. In [Slack's app dashboard](https://api.slack.com/apps), choose **Create New App →
   From scratch**. Name the app and select the Slack workspace where you want to post.
2. Open **Incoming Webhooks**, turn on **Activate Incoming Webhooks**, and choose
   **Add New Webhook to Workspace**. If your workspace requires app approval, ask its
   app manager to approve the installation.
3. Pick the channel and select **Authorize**. For a private channel, join it before
   authorizing. Copy the new URL from **Webhook URLs for Your Workspace**.
   [Slack's incoming-webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)

Slack grants the `incoming-webhook` scope for channel-bound posting. The installation
runs in Slack. Hourmere requests no Slack OAuth scopes and has no Slack redirect URL to
register. The webhook URL is the only Slack credential you enter in Hourmere.
[Slack's scope reference](https://docs.slack.dev/reference/scopes/incoming-webhook/)

## Connect in Hourmere

1. Switch to the personal or team space that owns the bookings. Open **Settings →
   Integrations → Slack booking notifications**.
2. Paste the **Slack incoming-webhook URL**, select the events to post, and choose an
   **Event type filter** or **All event types**. Leave **Enable Slack notifications**
   checked and select **Save Slack destination**.
3. Select **Send test message** and look for **Hourmere: test notification** in the
   selected channel. Hourmere confirms that it queued the test. Confirm delivery in Slack.

The URL is a bearer secret. Anyone who has it can post to its channel. Hourmere encrypts
it at rest, displays and returns only a masked URL, and clears the URL input when it
submits a save. Keep the original in a secret store and out of logs, shell history and
support messages.

To switch channels, authorize a new webhook in Slack for the desired channel, then
save it in **Replacement Slack webhook URL** and test it. Queued deliveries use the
current URL, so an older booking update can arrive in the new channel. If Hourmere
reports that the active space changed, reload before editing.

## What is sent

Each message starts with `Hourmere:` followed by the event type.

<!-- slack-events:start -->
| Event type | Sent when |
|---|---|
| `booking.created` | A booking is made |
| `booking.rescheduled` | A booking moves to a new time |
| `booking.cancelled` | A booking is cancelled |
| `booking.reschedule_requested` | A host asks the invitee to choose a new time |
| `booking.reschedule_request_expired` | That request expires without a new time |
<!-- slack-events:end -->

The settings page offers creation, cancellation and rescheduling. Subscribe to the
two reschedule-request events through REST, MCP or the CLI. Saving in Settings
preserves those subscriptions. Requests and expirations show the booking's current
time and `confirmed` status. Moving a booking sends a reschedule update, and a
separate later cancellation sends its own update. Attendee no-show changes are
available through signed webhooks. [Signed webhooks](/docs/webhooks)

Messages include the booking ID, event-type title, start and end with UTC offset,
status, and a link to the booking in the authenticated Hourmere app when the configured
origin fits the payload limit. Personal destinations also include the booker's name and
use the personal owner's profile time zone, falling back to UTC if the profile is missing.
Team destinations use UTC and omit all attendee and host details. Hourmere omits email
addresses, custom answers, free-text booking titles, cancellation reasons, reschedule
request IDs and notes, attendee management links, and meeting links. Anyone with access
to the channel can see the message text.
Opening the booking link requires the relevant Hourmere access.

Hourmere truncates event-type titles and booker names and sends Block Kit plain text
with Slack formatting and link previews disabled. User-supplied text cannot create
mentions or labelled links. Slack may make a plain web address in that text clickable.

## Pause, disconnect or revoke

- To pause delivery, clear **Enable Slack notifications** and save. Re-enable it to
  receive future updates. Pausing does not retract messages in Slack.
- To disconnect from Hourmere, select **Delete Slack destination** and confirm.
  This removes the saved URL and retained delivery records. Pending jobs for that
  destination skip.
- To revoke the URL itself, remove that webhook in the Slack app's settings. You can
  also remove the app from the workspace to revoke its installation. If you want
  to reconnect, authorize a new webhook and save its URL in Hourmere.
  [Slack's app removal guide](https://slack.com/help/articles/360003125231-Remove-apps-and-custom-integrations-from-your-workspace)

Hourmere records changes, tests and automatic pauses in the [audit log](/docs/audit-log).
The audit details contain the subscribed events. They omit the webhook URL.

## Rate limits and delivery failures

Hourmere allows five authorized test attempts per organization per minute per server
process, shared by REST and MCP. Only one sample can be pending per destination,
including during retries. A sample bypasses the event-type filter.

Slack generally allows one message per second per channel, with short bursts. Hourmere
serializes sends per destination and uses its normal retry schedule for Slack HTTP
429 responses. It does not use Slack's `Retry-After` header to reschedule the attempt.
[Slack's rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

Hourmere treats a 2xx response as delivered. A 404 or 410 ends the delivery attempt
without further retries and pauses the destination. This can happen if the webhook
has been revoked or the channel is unavailable. Refresh Settings to see the pause.
Check the channel and installation in Slack, then save a working URL and re-enable
notifications. Other non-2xx responses and transport failures use the bounded retry
schedule, with up to 13 total attempts and backoff starting at one minute, capped
at one hour. Exhausting those retries fails that delivery and leaves the destination
enabled. A worker that cannot acquire the destination's send lock within ten seconds
retries later on the same budget. Settings has no Slack delivery history. Check the
channel to verify receipt.

## Self-hosting

Set these variables on both the web and worker processes. With a single process
serving HTTP and running jobs, set them there.

| Variable | Value |
|---|---|
| `WEBHOOKS_ENABLED` | Set to `true` to capture and deliver Slack notifications and signed webhooks. Defaults to `false`. |
| `WEBHOOK_ENCRYPTION_KEY` | An independent key of 32 random bytes encoded as base64. Use the same key on web and worker, and back it up securely. Losing it makes existing saved URLs unreadable. |
| `PUBLIC_URL` | Your public Hourmere origin, used to build the booking link in the message. |

Keep a worker running and allow it to reach `hooks.slack.com` over HTTPS. Store the
webhook URL in the organization settings. The same Slack app setup works with a
self-hosted Hourmere instance. Disabling `WEBHOOKS_ENABLED` stops new capture, and
queued deliveries processed while disabled are skipped.
See the [configuration reference](/docs/configuration) and
[webhook delivery limits](/docs/webhooks#delivery-and-operational-limits).

## REST, MCP and CLI

| Action | REST under `/api/v1` | MCP | CLI |
|---|---|---|---|
| List | `GET /slack-destinations` | `list_slack_destinations` | `slack list` |
| Create | `POST /slack-destinations` | `create_slack_destination` | `slack create` |
| Update | `PATCH /slack-destinations/{id}` | `update_slack_destination` | `slack update` |
| Delete | `DELETE /slack-destinations/{id}` | `delete_slack_destination` | `slack delete` |
| Test | `POST /slack-destinations/{id}/test` | `test_slack_destination` | `slack test` |

Creation accepts `{ url, events, isActive?, eventTypeId? }`. Select at least one event
without duplicates. The event-type UUID must belong to the same organization.
Update accepts any of the same fields. Omit a field to keep it, or pass
`eventTypeId: null` to clear the filter. `pauseReason` is `url_rejected` after a
404 or 410 pause. Replacing the URL or explicitly enabling the destination clears
that reason. A manual pause of an active destination leaves it null.

REST test returns HTTP 202 and a `deliveryId` on enqueue, HTTP 409
`slack_test_pending` while a sample is pending, and HTTP 429 with `Retry-After`
when the test budget is exhausted. Refused or unknown-destination requests do not
use the budget. Once exhausted, the budget check can reject an authorized request
before looking up its destination.

API keys need `read` or `full` to list and `full` to change or test. The organization
role check still applies. Session writes require `X-Expected-Organization-Id`, which
reads also accept. Use the CLI's JSON input support to provide the URL privately.
See [CLI](/docs/cli) for command options.

## Known limits

- Only commercial Slack incoming-webhook URLs under `https://hooks.slack.com/services/`
  are accepted. GovSlack and other hosts are unsupported. URLs with user information,
  query parameters, fragments or an explicit port are refused. Each attempt checks
  public DNS and the HTTPS destination. Private-target exceptions and redirects are unavailable.
- Hourmere uses the current enabled state, subscriptions and event-type filter for each
  attempt. Skipped deliveries are final. An unavailable saved event type keeps its
  filter. Permanently deleting the event type removes that filtered destination and its
  retained deliveries.
- No backfill, manual replay, custom message templates, interactive actions, or Slack
  message editing and deletion. Messages are in English. The Hourmere settings support
  English and Simplified Chinese.
- Booking notifications are captured with the booking change. A retry after an ambiguous
  transport result can post a duplicate, and messages can arrive out of order. Imported
  bookings are skipped, and pending deliveries expire after 30 days.
- Slack incoming webhooks use the secret URL and HTTPS to accept posts. They do not
  verify Hourmere's signed-webhook HMAC.
