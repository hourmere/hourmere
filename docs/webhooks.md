# Booking webhooks

Webhooks are optional outbound signed notifications for booking creation, rescheduling and
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
The URL is immutable: create a replacement endpoint to change the destination. By default,
URLs require HTTPS on port 443, a fully qualified public DNS hostname, no user information
or fragment, and at most 2048 characters. Private, loopback and special-purpose destinations
are refused unless the operator explicitly allows an eligible private destination below.
Syntax and the current operator policy are checked when creating an endpoint and updating
its subscription/active settings. A PATCH containing only `isActive: false` can always pause
an endpoint, including after its allowlist entry is removed; all other updates recheck the
policy. DNS is checked on every actual delivery. Registration does no DNS
lookup or verification request: accepted configuration does not prove availability, and
rejected creation/update errors do not disclose whether an internal hostname exists.
Treat any credential in your destination's query as sensitive, even though Hourmere never
includes it in delivery errors or logs.

The signing secret is `whsec_` followed by 32 random bytes in base64url. Copy it directly
into the receiver's secret store when creating or rotating; list/detail operations cannot
recover it. Only authenticated AES-256-GCM ciphertext is stored, bound to the endpoint and
organization. Changing the environment encryption key makes existing secrets unreadable;
restore it or rotate every endpoint's signing secret using the new environment key.

### Operator-trusted private destinations

Self-hosters may set `WEBHOOK_PRIVATE_TARGETS`, empty by default, to at most 32
comma-separated entries. **Hourmere Cloud MUST NEVER set this setting.** The codebase has
no hosted execution-mode flag; `HOSTED_SIGNUP_URL` is attribution only. Every process with
a nonempty allowlist emits a startup warning without its values.

Entries use exact `hostname:port` (one port), `IPv4[/CIDR]:port[-port]`, or
`[IPv6[/CIDR]]:port[-port]`, for example
`n8n:5678,192.168.1.0/24:8080,[fd12:3456::/64]:8443-8444`. Hostnames are ASCII DNS labels,
case-insensitive, with no trailing dot or wildcard. Ports are explicit decimal values
1–65535 without leading zeros; ranges are inclusive and ascending. CIDRs must use their
network base. Only RFC1918 IPv4, IPv4 loopback, IPv6 unique-local and IPv6 loopback addresses
are eligible. Public addresses, unspecified/broad ranges such as `0.0.0.0/0` or `[::/0]`,
link-local addresses (including the entire `169.254.0.0/16`, which contains the
`169.254.169.254` metadata endpoint), Alibaba's `100.100.100.200`, AWS's entire reserved
service range `fd00:ec2::/32` (including metadata at `fd00:ec2::254`), GCP metadata at
`fd20:ce::254` and OCI metadata at `fd00:c1::a9fe:a9fe` are forbidden even if listed.
Any CIDR overlapping a refused range or containing one of those endpoints is refused at
startup; the same addresses are refused in DNS answers at delivery. IPv4-mapped IPv6
(`::ffff:0:0/96`) and NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48` are ineligible too.
Invalid settings prevent startup, including when event capture is disabled.

Matching destinations may use HTTP or HTTPS, explicit nonstandard ports, dotless hostnames
and IP literals. The effective URL port must match: omitted HTTP/HTTPS ports are 80/443,
which still need explicit entries. At delivery every DNS answer must satisfy the same
entry: a hostname entry matches only that exact hostname and port and requires all answers
to be eligible private/loopback addresses; an IP/CIDR entry requires all answers inside
that IP/network at an allowed port. A hostname may be saved under a CIDR's matching port
without resolving it, but delivery remains blocked until all its addresses fit the CIDR.
Answers mixing eligible and ineligible addresses are refused. Every retry resolves again;
private exceptions require the current answers to fit one entry, never a union of entries.
An exact hostname entry binds that host and port to private addresses, so a later change
to public DNS is refused even for an otherwise public-style HTTPS URL. Unrelated ordinary
public HTTPS URLs retain the public-only delivery path alongside the private allowlist.
HTTP uses the same HMAC headers, without transport encryption.
Credentials, fragments, redirects, proxy environment variables, timeouts and response-body
handling retain the restrictions below.

Set the allowlist identically on all web and worker processes and recreate both after
changes. The current policy is checked again before each actual send, including queued
events captured under an older policy. Trust entries narrowly: organization administrators
can choose any URL path on an allowed host and port. An IP/CIDR entry also permits every
virtual host whose DNS answers fit that range: the organization administrator chooses the
URL hostname and therefore the HTTP Host header. An internal reverse proxy that routes by
Host can expose multiple services through one allowed address. Delivery records expose
`httpStatus` (stored as `http_status`), revealing whether an allowed internal destination
responded and its HTTP status; this visibility is inherent to allowing that destination.
See the
[same-network n8n Compose example](../apps/site/src/content/docs/docs/self-hosting.md#private-webhook-receivers).

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
The budget includes interrupted attempts (shutdown, a killed worker or an expired job),
including attempts whose send outcome is unknown. After thirteen total attempts, the
delivery is failed. A surviving retry uses pg-boss's attempt number to include runs lost
before the delivery transaction committed. Graceful shutdown records `interrupted` and
consumes an attempt before retrying unless a valid 2xx acknowledgement arrived: that
delivery remains successful even when shutdown raced the response. Shutdown also takes
precedence over a signing-secret decryption failure: it records `interrupted`, sends
nothing and consumes the attempt. A later attempt without shutdown records
`secret_unavailable` if the key is still unavailable; restoring the key allows recovery
within the remaining retry budget. Every fifteen minutes, cleanup also marks up to 1000
pending deliveries without a created, retrying or active
pg-boss job as failed with
`job_missing`; retained job metadata supplies any missing attempt count. If the job was
already deleted, only known attempts can be reported. Active jobs remain pending until
pg-boss expires/retries or terminates them. Cleanup reads retained `webhook-delivery` jobs
once, keeps only singleton keys belonging to pending deliveries, and groups their live
state and maximum attempt count together. It reuses that materialized history when
selecting and locking up to 1000 orphaned deliveries. There is no job-age or queue-policy
cutoff: an old live job still protects its delivery, and all retained attempts for that
delivery count. The scan still grows with retained jobs; filtering pending keys bounds the
history aggregation, not the number of retained rows PostgreSQL may need to read. No
application indexes are added to pg-boss's schema. Each dispatch has a ten-second
database-work budget within its thirty-second job lease; each reconciliation/retention
statement is limited to five seconds, with at most one second waiting for locks. A canceled
or lock-unavailable batch rolls back and stays eligible for the next scheduled run.
PostgreSQL `57014` means query cancellation, including statement timeout and manual
cancellation; `55P03` means lock unavailable, including lock timeout. Each deferred batch
with either code emits one structured warning with `event: "webhook_cleanup_deferred"`,
`phase: "reconciliation"` or `"retention"`, and `code`. Only those fixed phase values and
recognized SQLSTATE codes are logged; the warning contains no query, error text, delivery
payload or credentials. Other database errors fail the cleanup job. Repeated warnings
indicate cleanup is making insufficient progress and needs investigation.
Row locks skip deliveries already being acknowledged or reconciled by another worker.
There is no manual replay endpoint.

Two delivery jobs run concurrently per worker. Each attempt has one ten-second deadline
covering DNS, TCP/TLS and response headers, and a 16 KiB response-header limit. The transport
validates **all** DNS candidates against the public-only default or one matching private
allowlist entry and refuses the whole answer if any candidate is outside that policy.
It pins a validated IP to the socket while preserving the original
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
ID-only jobs safely skip.

Secret rotation is a **hard switch**, with one signature per attempt and no grace period
or dual signing. The new secret exists only in the rotation response, so it cannot be
installed beforehand. Prepare the receiver to accept both old and new secrets during a
transition, call rotate, then immediately install the returned new secret alongside the
old one. All attempts starting after rotation use only the new secret, including retries
of older snapshots. Attempts rejected while the receiver is being updated consume the
same retry budget and retry with backoff (about seven hours total for the full budget).
Previously started requests may already have reached the receiver signed with the old
secret; retain old verification temporarily for those in-flight requests, then remove it.
There is no zero-interruption guarantee. Grace-period dual signing is a follow-up.

`GET /webhooks/{id}/deliveries` reports IDs, event type, booking ID, status, attempts, HTTP
status, safe error code and timestamps. It exposes no payloads, signatures or secrets and
hides records older than thirty days. A worker cleanup runs every fifteen minutes and
removes up to 1000 expired snapshots/metadata records per pass; a backlog needs more passes.
Delivery also skips snapshots older than thirty days. Existing ID-only pg-boss records
expire separately. Deleting a booking, organization or endpoint cascades its snapshots.

### Reconciliation performance at scale

Reconciliation still scales with retained job history and **all pending delivery keys**,
even though it updates at most 1000 orphans. The pending-delivery index does not guarantee
a particular join or scan. At a large pending backlog, PostgreSQL can hash the retained job
table in multiple batches and spill to temporary files. A zero-temp plan at a small backlog
does not establish a zero-temp bound for production.

The following local measurements used PostgreSQL **18.6**, aarch64 Alpine, `work_mem=4MB`,
and **1,000,000 total pg-boss jobs** in each disposable database. Every group of eight
pending deliveries covers missing, terminal, never-started, multiple-history, created,
delayed-retry and active jobs; old live jobs and old attempts remain authoritative. All
matching jobs belong to the webhook queue. In the mixed layout, 60% of unrelated jobs
belong to that queue and the rest to four other queues; the webhook layout puts every job
in it. There are 625 eligible orphans at 1000 pending, and each larger fixture processes
exactly 1000. Every measured query verifies the exact delivery IDs, statuses and attempt
counts, then rolls back to the same input.

Times below are median **EXPLAIN query round-trip wall milliseconds**, after one warmup
and five measured samples per variant in alternating order. They include
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` overhead, but exclude transaction setup, result
verification, rollback and the separate retention phase. Temp read/write values are the
root plan's block totals, not sums of inclusive child counters; ranges show the minimum
and maximum across samples. These observations depend on hardware, cache, statistics and PostgreSQL
settings, and are not timing assertions or a dispatch-latency guarantee.

| Pending deliveries | Layout | Current wall ms | Current temp read/write blocks |
| ---: | --- | ---: | ---: |
| 1,000 | mixed | 130.683 | 0 / 0 |
| 50,000 | mixed | 287.583 | 0 / 0 |
| 200,000 | mixed | 733.770 | 11,433 / 14,547 |
| 1,000 | webhook | 175.217 | 0 / 0 |
| 50,000 | webhook | 349.443 | 0–468 / 0–468 |
| 200,000 | webhook | 833.583 | 14,354 / 18,062 |

Only two alternative query shapes were evaluated: the pre-#41 query (`NOT EXISTS` for
live jobs, then aggregate attempts for the selected orphan batch), and the current query
with `job_history AS NOT MATERIALIZED` so the planner may inline it. Each cell below lists
wall milliseconds followed by temp read/write blocks.

| Pending deliveries | Layout | Pre-#41 `NOT EXISTS`: ms; temp R/W | Inline history: ms; temp R/W |
| ---: | --- | ---: | ---: |
| 1,000 | mixed | 342.012; 4,620 / 4,620 | 132.583; 0 / 0 |
| 50,000 | mixed | 383.949; 4,761 / 4,761 | 280.291; 0 / 0 |
| 200,000 | mixed | 480.728; 6,050 / 6,061 | 689.387; 11,433 / 13,394 |
| 1,000 | webhook | 456.038; 8,246 / 8,246 | 174.353; 0 / 0 |
| 50,000 | webhook | 495.281; 8,237 / 8,237 | 342.373; 0–468 / 0–468 |
| 200,000 | webhook | 584.691; 9,609 / 9,620 | 782.470; 14,354 / 16,909 |

The production query is unchanged. The pre-#41 shape is slower at the smaller backlogs;
inlining also increases the 1000-pending mixed median. Neither alternative meets the
requirement to reduce temp usage without becoming slower at any of the three pending
scales. The small inline timing difference is not evidence of a reliable improvement.
At 200,000 pending in the mixed fixture, the current retained-job hash uses 16 batches;
inlining retains that hash and only reduces some materialization writes. Larger backlogs
can therefore still need temporary disk space and can reach the five-second statement
deadline. Repeated `webhook_cleanup_deferred` warnings indicate insufficient progress;
inspect pending count, retained queue size and the actual plan when sizing the installation.
At 50,000 pending in the webhook layout, both current and inline plans varied between no
temp use and 468 read/write blocks, illustrating why tests must not require one exact plan.

Reproduce on disposable PostgreSQL 18 databases with the database-creation account:

```sh
DATABASE_URL=postgres://hourmere:hourmere@localhost:5432/hourmere \
  node scripts/webhook-reconciliation-benchmark.ts --mode=compare --jobs=1000000 \
  --pending=1000,50000,200000 --layouts=mixed,webhook --samples=5 \
  --output=/tmp/webhook-reconciliation-scale.json
```

The URL is used only by the test helper to create/drop isolated databases; fixture and
measurement queries use those databases. The script requires PostgreSQL 18, records the
server version/settings, row distribution, individual wall/execution timings and complete
plans, stops its pools and logs each database drop. It adds no indexes to pg-boss. The local
server allowed 300 connections, but the benchmark uses one reusable app pool (maximum 10)
and one pg-boss connection; CI retains PostgreSQL's default `max_connections=100`.

Local tests use synthetic identities, disposable PostgreSQL databases and isolated network
fixtures. They do not grant access to, or deliver events to, a real external receiver.
