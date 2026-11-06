# Slack booking notifications

The canonical [Slack guide](https://hourmere.com/docs/slack) describes setup, REST/MCP/CLI,
secret handling, the minimal payload, self-hosting and delivery limitations.

Slack destinations belong to an organization and reuse the webhook endpoint, snapshot and
outbox machinery. The incoming-webhook URL is encrypted with the webhook encryption key;
only its masked form crosses the service/API response boundary. Never log input URLs,
network error text or Slack response bodies. Use fixed safe failure codes.

Booking creation, rescheduling and cancellation enqueue Slack work in their existing
transaction, independently of generic signed-webhook enablement. Delivery uses the same
bounded retries, stable delivery identifiers and failure tracking. It revalidates exact
Slack host/path policy and public DNS on every attempt, with no private-target exception
and no redirects. The documented hosts are hooks.slack.com and hooks.slack-gov.com;
see [Slack's official incoming-webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

Payloads deliberately remain below the [team administrator whitelist](team-admin-bookings.md):
identifiers, timestamps and status only, with no names, contact information, custom answers,
free-text booking titles, cancellation reasons, management capabilities or meeting links.
Block Kit text and its fallback must not enable mention or link interpretation. Adding
personal details later requires a separate visibility decision; never spread a booking DTO.

Slack incoming webhooks do not validate Hourmere signatures. Slack's own signing-secret
mechanism verifies requests originating from Slack and does not apply here. The feature
inherits transactional integrity, encrypted secrets, HTTPS and retries, not receiver-side
HMAC verification. At-least-once attempts can produce duplicate Slack messages after an
ambiguous success; successful booking-request replay itself must not enqueue twice.

Real Slack workspace acceptance belongs to a later deployment task. Tests must use local
transport fakes and disposable PostgreSQL databases, never actual Slack URLs or workspaces.
