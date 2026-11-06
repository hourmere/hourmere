# Slack booking notifications

The canonical [Slack guide](https://hourmere.com/docs/slack) describes setup, REST/MCP/CLI,
secret handling, the minimal payload, self-hosting and delivery limitations.

Slack destinations belong to an organization and reuse the webhook endpoint, snapshot and
outbox machinery. The incoming-webhook URL is encrypted with the webhook encryption key;
only its masked form crosses the service/API response boundary. Never log input URLs,
network error text or Slack response bodies. Use fixed safe failure codes.

Booking creation, rescheduling and cancellation enqueue Slack work in their existing
transaction when `WEBHOOKS_ENABLED=true`. This switch controls Slack and generic webhooks.
Delivery uses the same bounded retries, stable delivery identifiers and failure tracking. It revalidates exact
Slack host/path policy and public DNS on every attempt, with no private-target exception
and no redirects. Only `hooks.slack.com` is accepted;
see [Slack's official incoming-webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

Payloads use an explicit subset of the [team administrator whitelist](team-admin-bookings.md):
booking ID, event-type title, start/end times and status, plus an authenticated admin booking
link. Personal destinations also include the invitee name; team destinations omit all
attendee and host details. Neither includes email addresses, custom answers, free-text
booking titles, cancellation reasons, management capabilities or meeting links.
Block Kit text and its fallback must not enable mention or link interpretation. Never spread
a booking DTO.

Slack documents the GovSlack domain `slack-gov.com`, but does not name its incoming-webhook
host in the linked guide or [GovSlack guide](https://docs.slack.dev/govslack/). GovSlack is
therefore unsupported until the exact host has an official source.

Test requests have a shared per-organization limit of five per minute across REST and MCP
in each server process. A durable destination lock rejects another sample with HTTP 409 `slack_test_pending` while a sample
is pending, including retries. Sample enqueue shares the delivery-row transaction.
A definitive Slack 404/410 pauses the destination after one attempt; repair the URL and
explicitly enable it again. The settings page displays paused destinations.

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
