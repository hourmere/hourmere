# Slack booking notifications

The canonical [Slack guide](https://hourmere.com/docs/slack) describes setup, REST/MCP/CLI,
secret handling, the minimal payload, self-hosting and delivery limitations.

Slack destinations belong to an organization and reuse the webhook endpoint, snapshot and
outbox machinery. The incoming-webhook URL is encrypted with the webhook encryption key;
only its masked form crosses the service/API response boundary. Never log input URLs,
network error text or Slack response bodies. Use fixed safe failure codes.

Booking changes enqueue Slack work in their existing transaction when
`WEBHOOKS_ENABLED=true`. Slack accepts the same event types as signed webhooks
(`WEBHOOK_EVENTS`); the settings page offers the first three and keeps the others on save:

<!-- slack-events:start -->
- `booking.created`
- `booking.rescheduled`
- `booking.cancelled`
- `booking.reschedule_requested`
- `booking.reschedule_request_expired`
<!-- slack-events:end -->

All of them use one message layout whose first line names the event type. This switch controls Slack and generic webhooks.
Delivery uses the same bounded retries, stable delivery identifiers and failure tracking. It revalidates exact
Slack host/path policy and public DNS on every attempt, with no private-target exception
and no redirects. Only `hooks.slack.com` is accepted;
see [Slack's official incoming-webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

Payloads use an explicit subset of the [team administrator whitelist](team-admin-bookings.md):
booking ID, event-type title, start/end times and status, plus an authenticated admin booking
link. Personal destinations also include the invitee name; team destinations omit all
attendee and host details. Neither includes email addresses, custom answers, free-text
booking titles, cancellation reasons, management capabilities or meeting links.
Block Kit text and its fallback are `plain_text` with `mrkdwn` and unfurling off. User
text (event-type titles, personal invitee names) is entity-escaped for `&`, `<`, `>` and
has `@` replaced by `＠`, so it cannot mention, format or form labelled links. Plain web
addresses are left as they are and Slack may auto-link them; the guide says so. Never
spread a booking DTO.

Slack documents the GovSlack domain `slack-gov.com`, but does not name its incoming-webhook
host in the linked guide or [GovSlack guide](https://docs.slack.dev/govslack/). GovSlack is
therefore unsupported until the exact host has an official source.

Test requests have a shared per-organization limit of five per minute across REST and MCP
in each server process. The service counts an attempt (`admit` callback) only after the
final owner/admin check found the destination, so refused or unknown-ID calls never use
the admins' budget. A durable destination lock rejects another sample with HTTP 409 `slack_test_pending` while a sample
is pending, including retries. Sample enqueue shares the delivery-row transaction.
A definitive Slack 404/410 pauses the destination after one attempt and sets
`pause_reason = 'url_rejected'`; replacing the URL or enabling the destination clears it,
and a manual pause leaves it null. The settings page asks for a new URL only for that
reason. Workers serialize sends per destination with a transaction advisory lock and wait
at most `SLACK_SENDER_WAIT_MS` (10 s) for it; a timeout rolls back and the job retries.
The bound is restored before any row lock, so a 404/410 pause after Slack answered never
times out.

The owner/admin checks are the only role checks for API-key, MCP OAuth and CLI callers:
`requireAdmin` runs before any lock (members never take or wait for destination locks) and
again after the destination lock (a demotion during the wait wins). Browser sessions use
the team context check and receive `team_management_access_denied`.

A synthetic test delivery stores its own event ID in `webhook_deliveries.request_id`.
Delivery identity is unique on `(webhook_id, booking_id, event_type, request_id)` with
`NULLS NOT DISTINCT` (migration 0064). Samples have no booking, so the event ID lets a
new sample follow a finished one. On rows with a null `booking_id`, `request_id` is that
marker, never a reschedule-request ID.

Times use the personal organization owner’s public profile time zone, including the UTC
offset at the booking instant. There is no team organization time-zone setting; team
destinations use UTC (`+00:00`) explicitly. A missing personal profile also falls back to
UTC. Event titles and personal invitee names are truncated before escaping to keep both
Slack blocks and the stored payload within their size limits.

Slack incoming webhooks do not validate Hourmere signatures. Slack's own signing-secret
mechanism verifies requests originating from Slack and does not apply here. The feature
inherits transactional integrity, encrypted secrets, HTTPS and retries, not receiver-side
HMAC verification. At-least-once attempts can produce duplicate Slack messages after an
ambiguous success; successful booking-request replay itself must not enqueue twice.

Real Slack workspace acceptance belongs to a later deployment task. Tests must use local
transport fakes and disposable PostgreSQL databases, never actual Slack URLs or workspaces.
