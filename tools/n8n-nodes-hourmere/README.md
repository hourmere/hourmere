# n8n-nodes-hourmere

Hourmere booking actions and signed webhook triggers for self-hosted n8n.
**Not yet published to npm or verified for n8n Cloud.**

## Installation

Build and pack the standalone package (requires the repository’s pinned Node.js version):

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

Publishing is a separate owner-approved step; building and packing do not publish.
`package.json` sets `"private": true`, so npm refuses every real publication, whatever
`--registry`, `--ignore-scripts` or `--force` options are used, and nothing is published.
npm checks `private` only at its last step, though, so it can contact servers first:

1. In a CI job that offers an OIDC ID token, such as GitHub Actions with
   `id-token: write`, npm obtains that token from the CI provider and exchanges it at the
   target registry. `--force` and `--offline` do not skip this.
2. Without credentials for the target registry, npm then stops with `ENEEDAUTH`.
3. Without `--force` or `--offline`, npm then reads the package's published versions from
   the target registry, sending your npm token for that registry.
4. Only then does npm refuse with `EPRIVATE`.

Dry-runs never reach that check.

`publishConfig.registry` also points to `https://registry.invalid/`, an unresolvable
placeholder. It applies with scripts disabled and takes precedence over registries set in
`.npmrc` files or the environment. An explicit `--registry` option on the command line
overrides it, so never pass `--registry` to get past the placeholder. The `prepublishOnly`
guard refuses publication unless `HOURMERE_N8N_PUBLISH=1` is set, but only when lifecycle
scripts run. This directory's `.npmrc` turns them off, so `npm publish` here skips that
guard unless scripts are turned back on, for example with `--ignore-scripts=false`.

The reviewed change that approves publication removes `private` and the placeholder
registry together. `dist` is not committed and no publish script builds it, so build it
first: in this directory, run `npm ci --ignore-scripts` and `npm run build`, then run the
release as `HOURMERE_N8N_PUBLISH=1 npm publish --ignore-scripts=false`, so the approval
guard runs.

A dry-run's exit code says nothing about where a publication would go. Without
`--offline`, `npm publish --dry-run` queries the target registry for existing versions,
ignores the failure and still exits 0, even for the unreachable placeholder. What counts
is the `npm notice Publishing to <registry> … (dry-run)` line in its output.
Outside CI, `npm publish --dry-run --ignore-scripts --offline` prints it without network
access (in CI with an ID token, the OIDC exchange still runs), and
the packaging tests assert that it names `https://registry.invalid/`. They also aim a
non-dry-run publish with `--force` and `--offline`, outside CI, at a local sink and require
`EPRIVATE` with no connection to it.

Contributors must use `npm install --ignore-scripts` (or `npm ci --ignore-scripts`):
the official CLI requires `eslint-plugin-n8n-nodes-base`, whose preinstall otherwise
fetches and executes an unpinned `only-allow`. Native toolchain install scripts are
also unnecessary for this package’s build and tests. This directory's `.npmrc` also sets
`ignore-scripts=true`; scripts you name, such as `npm run build` and `npm test`, still run.

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
returns false and retains registration details for recovery. Remove the leftover endpoint
through REST: find its ID with `GET /api/v1/webhooks`, then call
`DELETE /api/v1/webhooks/{id}` using a `full` API key for an organization owner/admin.
Webhook management is REST-only; there is no settings page or MCP/CLI operation.
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

The package accepts `n8n-workflow: "*"` as its community-node peer and pins its
development dependency to `2.45.1` (released 2026-10-22). Its build and lint use the official
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
