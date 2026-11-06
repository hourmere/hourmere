# n8n-nodes-hourmere

Hourmere booking actions and signed webhook triggers for self-hosted n8n.
**Not yet published to npm or verified for n8n Cloud.**

## Installation

Build and pack from the Hourmere repository root (requires its pinned Node.js version):

```sh
npm ci
npm run build --workspace n8n-nodes-hourmere
npm pack --workspace n8n-nodes-hourmere --pack-destination /tmp
```

Copy the archive to your n8n host. As n8n's operating-system user, install the actual
archive path in `~/.n8n/nodes`, then restart n8n:

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /absolute/path/n8n-nodes-hourmere-0.1.0.tgz
```

Use a persistent directory in containers and install on all queue workers. The Hourmere
Docker image excludes this package. Once published, self-hosted n8n owners/admins may
install `n8n-nodes-hourmere` through Settings → Community nodes.
See the [official manual installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation.md).

## Credentials

Create an **Hourmere API** credential with your Hourmere instance base URL (no `/api/v1`)
and API key. The password field is sent as Bearer authentication; the credential test
reads `/api/v1/profile`. Hourmere Cloud is an invitation-only preview, not an open signup
service; use an instance you already have access to.

| Operation | Minimum recommended scope |
|---|---|
| List event types; find slots; get/list bookings; credential test | `read` (`bookings` and `full` also accepted) |
| Create, cancel or reschedule bookings | `bookings` (`full` also accepted) |
| Trigger registration/deletion | `full`, plus organization owner/admin permission |

Use separate credentials to limit access. Existing organization/host permissions apply.

## Operations

**Hourmere:** list event types, find available slots for a personal/team event page and
time range, create a booking with a retained idempotency key, get, cancel and reschedule
a booking, and list bookings with filters and cursor pagination. Supply offset-bearing
instants and an IANA time zone; retain returned instants across DST transitions. A
reschedule returns a successor booking ID. HTTP errors include the API error code;
429 responses respect `Retry-After`, with one automatic retry for waits up to 60 seconds.

**Hourmere Trigger:** booking created, cancelled and rescheduled. Activation registers a
REST webhook; deactivation deletes it. Hourmere webhooks must be enabled and its worker
must reach n8n's configured callback URL. Private destinations need Hourmere's explicit
operator allowlist; ordinary public receivers use HTTPS.

Every delivery verifies HMAC-SHA256 over raw bytes and a signed timestamp within five
minutes. Missing/invalid signatures and stale requests are rejected. The signed event ID
suppresses repeats for thirty days. Process-level coordination merges separate request
snapshots and suppresses concurrent redelivery in one process. Limits are 10,000 receipts
per registration, 100,000 receipts and 1,000 registrations per process; capacity fails closed
with HTTP 503. n8n static data is best-effort, not transactional across workers/restarts.
Use the event ID with a downstream persistent unique constraint for durable idempotency.

The registration ID and signing secret are stored in workflow static data, separate from
n8n's encrypted credential store. Protect workflow databases, exports and backups.
Deactivate/reactivate to replace a secret; events during the gap are not backfilled.
There is no exactly-once guarantee or historical replay. Events may arrive out of order.

## Compatibility and language

The package pins its `n8n-workflow` peer/development dependency to `2.45.1` (released
2026-10-22). Its build and lint use the official
[`n8n-node` CLI](https://docs.n8n.io/connect/create-nodes/build-your-node/using-the-n8n-node-tool.md).
Unit tests mock HTTP; OpenAPI contract tests detect incompatible Hourmere API changes.

Node parameter translations include English and Simplified Chinese (`zh`/`zh-CN`).
Use n8n's `N8N_DEFAULT_LOCALE=zh`. Community credential/header translation loading and
runtime errors remain English; see the [language details](https://hourmere.com/docs/n8n#interface-language).
This package is licensed under AGPL-3.0-only.

## Documentation

[Hourmere n8n guide](https://hourmere.com/docs/n8n) includes setup, scopes, examples and
limitations. [Webhook reference](https://hourmere.com/docs/webhooks) describes server
configuration, payloads and retries. [API keys](https://hourmere.com/docs/api-keys)
explains authorization and least privilege.
