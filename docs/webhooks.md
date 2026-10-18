# Booking webhooks

Webhooks are optional outbound HTTPS notifications for booking creation, rescheduling and
cancellation. They use the same booking services for public pages, REST and MCP. They do
not depend on Google, Microsoft, mail or a billing account. This first version is API-only;
there is no webhook settings page or third-party integration template.

## Enable and configure

Set `WEBHOOKS_ENABLED=true` and an independent `WEBHOOK_ENCRYPTION_KEY` containing exactly
32 random bytes in base64 (`openssl rand -base64 32`). Set both identically on web and worker
processes, keep the encryption key stable and back it up securely. Do not reuse calendar or
authentication keys. The default is disabled: no events or snapshots are captured, and
enabling does not backfill past bookings. Turning the global switch off also skips queued
deliveries when a worker sees them. Keep a worker running for delivery and retention cleanup.

Organization owners and admins may use these endpoints with a session or API key acting in
that organization. Ordinary members/hosts cannot configure or inspect webhooks, since each
endpoint can receive events about the entire organization. A host can configure their own
personal organization's webhook. Current verified membership and role are checked again in
the service; possession of another organization's endpoint ID grants no access.

| Method and path under `/api/v1` | Purpose |
|---|---|
| `POST /webhooks` | Create `{ url, events, isActive? }`; returns `{ webhook, secret }` |
| `GET /webhooks` | List up to ten endpoints; never returns secrets |
| `PATCH /webhooks/{id}` | Change `events` and/or `isActive` |
| `POST /webhooks/{id}/rotate-secret` | Replace the signing secret; returns `{ secret }` once |
| `DELETE /webhooks/{id}` | Delete the endpoint and all retained deliveries |
| `GET /webhooks/{id}/deliveries?after=…` | At most fifty delivery metadata rows, newest first |

`events` must be a nonempty, duplicate-free subset of `booking.created`,
`booking.rescheduled`, `booking.cancelled`. There are at most ten endpoints per organization.
The URL is immutable: create a replacement endpoint to change the destination. URLs require
HTTPS on port 443, a fully qualified public DNS hostname, no user information or fragment,
and at most 2048 characters. Private, loopback and special-purpose destinations are refused;
there is no development bypass for local/private receivers. Syntax is checked when saving;
DNS is checked on every actual delivery. Registration does not send a verification request.
Treat any credential in your destination's query as sensitive, even though Hourmere never
includes it in delivery errors or logs.

The signing secret is `whsec_` followed by 32 random bytes in base64url. Copy it directly
into the receiver's secret store when creating or rotating; list/detail operations cannot
recover it. Only authenticated AES-256-GCM ciphertext is stored, bound to the endpoint and
organization. Changing the environment encryption key makes existing secrets unreadable;
restore it or rotate every endpoint's signing secret using the new environment key.

## Payload and signatures

The request is `POST`, `Content-Type: application/json`, `User-Agent: Hourmere-Webhooks/1`.
The JSON is an immutable snapshot captured inside the booking's transaction:

```json
{
  "id": "event UUID",
  "type": "booking.rescheduled",
  "occurredAt": "2026-11-01T12:00:00Z",
  "data": {
    "bookingId": "new booking UUID",
    "organizationId": "organization UUID",
    "eventTypeId": "event type UUID or null",
    "start": "2026-11-05T10:00:00.000Z",
    "end": "2026-11-05T10:30:00.000Z",
    "status": "confirmed",
    "source": "web",
    "rescheduledFromId": "previous booking UUID or null"
  }
}
```

Only these bounded identifiers, timestamps and status/source values are included. Invitee
and host names/emails, attendees, answers, locations, management capabilities, API keys and
OAuth credentials are absent. A reschedule emits one event for the new booking, with its
predecessor ID; it does not emit a second cancellation event for the old booking. A later
cancellation has its own snapshot. Old events are still delivered even when a newer state
exists: receivers must reconcile by event time/booking chain rather than arrival order.

| Header | Meaning |
|---|---|
| `Webhook-Id` | Stable delivery UUID; deduplicate using this ID |
| `Webhook-Event-Id` | Stable event UUID shared by subscribed endpoints for this change |
| `Webhook-Timestamp` | Unix seconds at this actual delivery attempt |
| `Webhook-Signature` | `v1=` plus lowercase hex HMAC-SHA256 |

Compute the HMAC using the entire UTF-8 signing secret (including `whsec_`) as the key and
`<Webhook-Timestamp>.<exact raw request body>` as the message. Compare the decoded digest in
constant time before parsing or acting on the body. Check the timestamp against a short
window, for example five minutes, with synchronized clocks. Do not reserialize JSON before
verification. The timestamp/signature is refreshed on each retry, while both IDs and the
body stay unchanged. Store successful delivery IDs durably for at least the thirty-day
delivery lifetime and return a 2xx acknowledgement for an already processed ID.

## Delivery and operational limits

Capture and pg-boss enqueue commit or roll back with the booking; the queue contains only
the delivery ID. Create retries with the same successful idempotency key do not capture a
second event. There is no exactly-once guarantee: if the receiver accepts and Hourmere
crashes before recording success, the next attempt can repeat the same delivery ID. A 2xx
response header acknowledges delivery; the response body is immediately discarded. Every
other HTTP status, DNS/TLS error or unavailable signing secret is retried up to twelve
times after the first attempt, starting at one minute, doubling with jitter to an hour.
After thirteen total attempts, the delivery is failed. There is no manual replay endpoint.

Two delivery jobs run concurrently per worker. Each attempt has one ten-second deadline
covering DNS, TCP/TLS and response headers, and a 16 KiB response-header limit. The transport
validates **all** DNS candidates and refuses the whole answer if any is private or
special-purpose. It pins a validated IP to the socket while preserving the original
hostname for TLS certificate verification, SNI and Host. Connections are not reused;
redirects, proxy environment variables and cookies are not followed. Response bodies,
signature values, destination queries and network error text are never recorded in
delivery status or thrown job errors. Ordinary outbound network policy should still limit
the process to its intended destinations.

Configuration mutations lock the acting user, then organization, then endpoint, and finally
lock/recheck the current owner/admin membership. These locks remain through commit:
demotion/removal already committed while waiting for an organization/endpoint is refused;
once membership is locked, revocation waits for the authorized mutation. Email
unverification similarly serializes through the user lock. The parent-first order also
allows organization/user deletion cascades to complete without an inverse lock order.

An already-started attempt holds the endpoint's share lock until it acknowledges or fails.
Pause, subscription changes, rotation and deletion wait for that attempt to finish before
they return. Subsequent queued attempts use the current subscription/state and current
signing secret. Paused, unsubscribed or globally disabled deliveries are permanently
skipped; enabling again does not revive them. Deletion removes all delivery rows, and old
ID-only jobs safely skip. Receivers should install a new secret before rotation when
coordinating the brief switch; an attempt that began earlier may already have arrived
under the old secret. Keep the old verification key during that transition if needed.

`GET /webhooks/{id}/deliveries` reports IDs, event type, booking ID, status, attempts, HTTP
status, safe error code and timestamps. It exposes no payloads, signatures or secrets and
hides records older than thirty days. A worker cleanup runs every fifteen minutes and
removes up to 1000 expired snapshots/metadata records per pass; a backlog needs more passes.
Delivery also skips snapshots older than thirty days. Existing ID-only pg-boss records
expire separately. Deleting a booking, organization or endpoint cascades its snapshots.

Local tests use synthetic identities, disposable PostgreSQL databases and isolated network
fixtures. They do not grant access to, or deliver events to, a real external receiver.
