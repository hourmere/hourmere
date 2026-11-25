# n8n-nodes-hourmere

Hourmere booking actions and signed webhook triggers for self-hosted n8n.
The package is unverified. n8n Cloud installation requires approval from n8n.

## Installation

### Before npm publication

Build and pack the standalone package from an Hourmere source checkout using the
repository's pinned Node.js version.

```sh
cd tools/n8n-nodes-hourmere
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run build
npm test
npm pack --ignore-scripts --pack-destination /tmp
```

This directory has its own committed `package-lock.json` and is excluded from the root
npm workspaces. Root installs never download the n8n toolchain. The separate
`n8n-compatibility` CI job runs the commands above; the root test suite checks the
OpenAPI contract without requiring this package’s `node_modules`.

Copy the archive to your n8n host. As n8n's operating-system user, install the actual
archive path in `~/.n8n/nodes`, then restart n8n.

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /absolute/path/n8n-nodes-hourmere-0.1.0.tgz
```

### After npm publication

Once an installable version of `n8n-nodes-hourmere` is published on npm, sign in to
self-hosted n8n as an owner or admin. With unverified community nodes enabled, open **Settings → Community Nodes →
Install**, enter `n8n-nodes-hourmere`, acknowledge the unverified-code prompt and select
**Install**. [n8n's GUI installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation.md).

For queue mode or an instance without the install UI, run `npm install n8n-nodes-hourmere`
in `~/.n8n/nodes` as the n8n operating-system user and restart n8n. For either installation
path, use a persistent directory in containers and install the same version on every queue
worker. The Hourmere Docker image excludes this package.
[n8n's manual installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation.md).

## Credentials

Create an **Hourmere API** credential with your Hourmere instance base URL (no `/api/v1`)
and API key. HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`.
The credential test uses the same URL validation as actions and triggers. The password
field is sent as Bearer authentication; the credential test
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
a booking, and list bookings with filters. List operations emit one item per result;
choose **Return All** to follow booking cursors automatically, or set **Limit**. Booking
pagination stops with an error after 1,000 pages or a
repeated cursor; narrow the filters if this limit is reached. Supply offset-bearing
instants and an IANA time zone; retain returned instants across DST transitions. A
reschedule returns a successor booking ID. HTTP errors include the API error code;
429 responses respect `Retry-After`, with one automatic retry for waits up to 60 seconds.

Generate a random idempotency key (for example UUIDv4) once per booking attempt and
retain it for retries; never derive it from attendee details or the request. Create
booking returns `manageToken`, a private management capability stored in n8n execution
history. Restrict execution-data access/retention or drop that field before retaining
or forwarding results. Dropping it in a later node does not erase the create node’s
saved output; restrict or disable execution-data storage as appropriate.

**Hourmere Trigger:** booking created, cancelled, rescheduled, reschedule requested,
reschedule request expired, and **Attendee No-Show Changed**
(`booking.attendee_no_show_changed`). Attendance changes include `data.attendeeId`,
`data.noShowMarkedAt` and `data.noShowMarkedBy`; both marker fields are null when
a host unmarks a no-show. Activation registers a
REST webhook; deactivation attempts to delete it. If Hourmere is unreachable, deactivation
returns false and retains registration details for recovery. Find the leftover endpoint's
ID with `GET /api/v1/webhooks`, MCP `list_webhooks` or CLI `webhooks list`. Then call
REST `DELETE /api/v1/webhooks/{id}` using a `full` API key for an organization owner/admin.
REST, MCP and the CLI also support manual endpoint creation.
See [Booking webhooks](https://hourmere.com/docs/webhooks).
The endpoint consumes one of the organization’s ten webhook slots until removed.
Hourmere webhooks must be enabled and its worker must reach n8n's configured callback URL.
Private destinations need Hourmere's explicit operator allowlist; ordinary public
receivers use HTTPS.

Every delivery verifies HMAC-SHA256 over raw bytes and a signed timestamp within five
minutes. Missing/invalid signatures and stale requests are rejected. The signed event ID
suppresses repeats for ten minutes (twice the timestamp tolerance). Process-level
coordination merges separate request
snapshots and suppresses concurrent redelivery in one process. Limits are 10,000 receipts
per registration, 100,000 receipts and 1,000 registrations per process. Expired receipts
are evicted; HTTP 503 occurs only when receipts still inside that window fill a limit.
Successful remote deletion clears the registration’s local receipts. Failed deactivation
retains the endpoint, secret and receipts together, preventing replay after quick reactivation. n8n static data is
best-effort, not transactional across workers/restarts.
Use the event ID with a downstream persistent unique constraint for durable idempotency.

The registration ID and signing secret are stored in workflow static data, separate from
n8n's encrypted credential store. Protect workflow databases, exports and backups.
Deactivate/reactivate to replace a secret; events during the gap are not backfilled.
There is no exactly-once guarantee or historical replay. Events may arrive out of order.

## Compatibility and language

The package has no runtime dependencies and uses n8n's `n8n-workflow` peer. It pins
`2.45.1` for development. The build uses `n8n-node`. Lint runs the official strict
ESLint preset with warnings treated as errors and an exception for the MIT license rule.
Unit tests mock HTTP and OpenAPI contract tests detect incompatible Hourmere API changes.
[n8n node tooling](https://docs.n8n.io/connect/create-nodes/build-your-node/using-the-n8n-node-tool.md).

Node parameter translations include English and Simplified Chinese (`zh`/`zh-CN`).
Use n8n's `N8N_DEFAULT_LOCALE=zh`. Community credential/header translation loading and
runtime errors remain English. [Interface language details](https://hourmere.com/docs/n8n#interface-language).

## Example workflows

- **Daily booking report.** Connect a Schedule Trigger to **Hourmere → List Bookings**.
  Use a `read` credential, set date and status filters and enable **Return All** to
  retrieve all matching bookings.
- **Sync attendance changes.** Configure **Hourmere Trigger** for **Attendee No-Show
  Changed**. Pass the event `id` to a downstream store with a uniqueness constraint
  and match the attendance record using `data.bookingId` and `data.attendeeId`. A null
  `data.noShowMarkedAt` clears the mark.

## Documentation

[Hourmere n8n guide](https://hourmere.com/docs/n8n) includes setup, scopes, examples and
limitations. [Webhook reference](https://hourmere.com/docs/webhooks) describes server
configuration, payloads and retries. [API keys](https://hourmere.com/docs/api-keys)
explains authorization and least privilege.

Contributors install with `npm ci --ignore-scripts`, as CI does. This skips the lint
plugin's preinstall download of an unpinned dependency. The source manifest stays private
and packing creates a local tarball. Maintainers use the approved GitHub Actions release
workflow. [Owner release runbook](https://github.com/hourmere/hourmere/blob/main/docs/n8n-release.md).

## License

[AGPL-3.0-only](LICENSE).
