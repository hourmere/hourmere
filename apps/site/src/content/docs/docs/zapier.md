---
title: Zapier
description: Connect Hourmere booking triggers, actions and searches using a private Zapier integration.
---

**Status: private app until published.** Hourmere is not yet published in the Zapier
directory. The source in `tools/zapier-hourmere` lets a self-hoster deploy a private
integration with their own Zapier account. It uses the existing REST API and has no
Hourmere Cloud requirement or feature gate. Publishing and Zapier review are separate
owner steps; checking out or building Hourmere does not register or upload an integration.

## Connect an instance

Create an API key at **App → API keys** (`/app/api-keys`) in the organization you want
to automate. In Zapier, enter that key and your instance's HTTPS origin, for example
`https://hourmere.example.com`, without `/api/v1` or a path prefix. The base URL is
required: Hourmere does not currently document a public Cloud API origin. The marketing
website is separate from your instance. Zapier must be able to reach the instance.
Your connection remains bound to the key's organization and existing permissions.
The connection test makes one authenticated `GET /api/v1/me` request; it makes no booking.

Use separate connections for different jobs so each key has the least privilege it needs:

| Capability | Least key scope | Additional requirements |
|---|---|---|
| Test connection, find booking, find slots, event-type dropdown | `read` | Existing booking and event visibility |
| Create, cancel or reschedule a booking | `bookings` | Existing booking permissions; cancellation and rescheduling use host authority |
| Booking Created, Booking Cancelled, Booking Rescheduled triggers | `full` | Personal organization owner or team owner/admin; webhooks enabled |

`bookings` and `full` also support the connection test and scheduling reads. Use `read`
for read-only workflows, `bookings` for booking actions, and reserve `full` for the hook
connection because webhook registration and deletion change organization configuration.
Scopes cannot be edited: replace and reconnect a key, then revoke the old one. See
[API keys](/docs/api-keys). Do not place keys or webhook signing secrets in Zap fields,
shared examples or source control.

For instant triggers, the operator must enable `WEBHOOKS_ENABLED`, configure
`WEBHOOK_ENCRYPTION_KEY` and keep a worker running as described in [webhooks](/docs/webhooks).
Each enabled trigger registers one endpoint; the existing limit is ten endpoints per
organization. Turning the Zap off attempts to unsubscribe its endpoint; an already-deleted
endpoint is treated as success. Disable Zaps before revoking their key. An unreachable
instance, revoked key or lost subscription response can leave an orphan endpoint. It
still occupies one of the ten slots and Hourmere retries deliveries even when Zapier
returns 410. With an owner/admin `full` key, inspect `GET /api/v1/webhooks`, identify the
unused endpoint, and remove it with `DELETE /api/v1/webhooks/{id}`. Events before
registration are not backfilled.

## Build a Zap

- **Booking Created → create a CRM activity:** map the booking ID and UTC start/end.
  Add **Find Booking** only when the connection is allowed to read the booking and the
  destination actually needs its private details. The trigger itself contains no invitee
  email, name, custom answers or management link.
- **Booking Rescheduled → update an existing record:** use `rescheduledFromId` to find
  the previous booking and save the successor `bookingId`. A move creates a new booking
  ID and emits one reschedule event; it does not emit a separate cancellation event.
- **Booking Cancelled → close a task:** match by booking ID. Events can arrive out of
  order, so reconcile their timestamps and the booking chain before overwriting newer state.
- **Incoming request → find slots → create a booking:** choose the event type, search a
  bounded range and map an exact returned UTC start. Use the same duration in both steps.
  Supply the invitee's IANA time zone, such as `Europe/Berlin`; do not convert local wall
  times to UTC by assuming a fixed daylight-saving offset. A found slot is not reserved.

For **Create Booking**, generate a random UUID for each new booking attempt upstream,
map it into Zapier, and retain that same key on retries. Do not use predictable IDs or
email addresses. Different booking attempts need different random keys; changed input with a reused
key is refused. Cancellation and rescheduling act immediately and may send booking
notifications. Rescheduling is not generally idempotent: after an uncertain response,
inspect the original booking and its successor before replaying the step.

API failures retain the Hourmere error code in the Zapier error. A 401 marks the
connection expired so Zapier can ask you to reconnect. For `insufficient_scope`,
check the connection's scope; for permission failures, check organization/host membership.
An authorization or availability error does not establish that configuration is missing.
Rate-limit errors use `Retry-After` to ask Zapier to delay a retry.

## Delivery verification and limits

The app verifies each delivery's HMAC-SHA256 against the exact raw request body using
the signing secret returned by webhook registration. Zapier supplies that saved secret
through `bundle.subscribeData` during the hook's `perform`; its raw headers use the
`Http-Webhook-*` names. Invalid signatures, wrong secrets and malformed payloads return
an empty result with a masked reason code. Stale timestamps have a distinct
`stale_webhook_timestamp` reason from `invalid_webhook_signature`. Keep the instance
clock synchronized and the hook URL private.

Zapier acknowledges intake before running `perform`. The app therefore allows a one-hour
timestamp tolerance for queue delays, instead of five minutes. Longer delays still drop
an event that Hourmere will not retry after that acknowledgement.

The signed event ID becomes the trigger's `id`. After verification, the app uses Zapier's
durable cache to atomically claim `hm:<subscription ID>:<event ID>` with set-if-absent.
A duplicate returns an empty result; the same event can reach different subscriptions.
Claims last 24 hours, covering Hourmere's twelve retry delays capped at one hour each, plus queueing. Replay safety comes from this claim, not the timestamp window.
If the cache is unavailable, the app logs only a masked reason and accepts the authentic
event to avoid losing an already-acknowledged delivery. Cache outages or expiry can thus
permit duplicates. Downstream operations should still atomically deduplicate by signed
event ID; a separate search-then-create step does not guarantee that. Retries do not
promise exactly-once downstream actions.

The polling fallback fetches sample bookings that the connected user hosts. It is a
setup aid, not a complete historical change feed or an outage-recovery poller. Organization
hooks can include bookings the connected administrator does not host, which the sample
list and Find Booking cannot read. Webhook samples are projected to the same minimal
fields as live events, with `organizationId: null` because host booking reads omit that
field. Live deliveries include the organization ID. Disable and re-enable the Zap to
register a fresh subscription
after signing-secret rotation; a manually rotated secret cannot be recovered by the app.
See [webhook delivery limits](/docs/webhooks#delivery-and-operational-limits) for bounded
retries, retention, deletion and out-of-order delivery.

## Deploy privately with your own account

The integration is separate from the Hourmere server and is excluded from its Docker
image. The repository uses Node.js 26; Zapier's runtime uses Node.js 22. Keep your normal
Hourmere installation on Node.js 26 and use Node.js 22 for this package's Zapier commands.
The package pins `zapier-platform-core` and `zapier-platform-cli` to **19.2.1**, released
on October 14, 2026. The package README contains the offline checks.

Install this package separately with `npm ci --ignore-scripts` in `tools/zapier-hourmere`;
its committed package lock pins the deployed dependency tree. Root workspace installs
do not install Zapier dependencies. Review the source and run the package's tests
and validation. Only the operator who intends to upload the integration should then
authenticate to their own Zapier developer account, register their private integration,
and push its version from `tools/zapier-hourmere` with
`HOURMERE_ZAPIER_PUSH_APPROVED=1` explicitly set for the guarded build. The pinned CLI uses `zapier-platform`;
the old `zapier` command was removed in version 19. Registration writes a local
`.zapierapprc` association: keep your
account-specific file out of Git, and never commit deployment credentials.

Newly pushed versions are private by default. Test with synthetic bookings in your own
instance, then share access only with intended testers through Zapier's private-integration
sharing controls. Public directory listing requires a separate publication/review process.

See Zapier's official [CLI overview](https://docs.zapier.com/integrations/build-cli/overview),
[core reference](https://docs.zapier.com/integrations/build-cli/core) and
[testing guide](https://docs.zapier.com/integrations/build-cli/testing-and-debugging).
