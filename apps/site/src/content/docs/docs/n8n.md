---
title: n8n
description: Automate Hourmere bookings with the self-hosted n8n community node.
---

`n8n-nodes-hourmere` adds **Hourmere** actions and an **Hourmere Trigger** to n8n.
It uses your instance's existing REST API. All supported operations are available to
self-hosters; no Hourmere paid plan is required.

**Not yet published to npm.** Install the local package below for now. Publication and
n8n verification are separate steps; the package is not currently available on n8n Cloud.
Hourmere Cloud is an invitation-only preview with sign-ups closed. Use the base URL of
an Hourmere instance you already have access to, not the marketing website.

## Install locally

From an Hourmere source checkout, using the repository's required Node.js version:

```sh
npm ci
npm run build --workspace n8n-nodes-hourmere
npm pack --workspace n8n-nodes-hourmere --pack-destination /tmp
```

Copy the resulting `n8n-nodes-hourmere-<version>.tgz` to your n8n host. As the operating-system
user that runs n8n, install it in n8n's community-node directory, replacing the path below
with the actual archive path:

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /absolute/path/n8n-nodes-hourmere-<version>.tgz
```

Restart n8n and search for **Hourmere** in the node picker. For containers, install inside
the n8n container's persistent user directory; install the same package on every worker
when using queue mode. The package is not part of Hourmere's Docker image.
See n8n's [manual installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation.md).

After a future npm publication, a self-hosted n8n owner/admin can use **Settings → Community
nodes → Install** with the package name `n8n-nodes-hourmere`, following n8n's
[GUI installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation.md).
Do not expect that registry installation to work before publication.

## Credentials and scopes

Create an API key in Hourmere at **API keys** (`/app/api-keys`) in the intended personal
or team space. In n8n, create an **Hourmere API** credential with:

- **Base URL:** your instance origin, for example `https://hourmere.example.com`, without
  `/api/v1`. Use HTTPS outside a trusted local network.
- **API Key:** the key shown once by Hourmere. This is an n8n password field, sent as a
  Bearer credential. Keep it out of workflow expressions, examples and logs.

The credential test performs a cheap authenticated profile read. Passing it confirms
connectivity and authentication, not permission for every operation.

| Operation | Accepted scopes | Recommended scope |
|---|---|---|
| Credential test; list event types; find available slots; get/list bookings | `read`, `bookings`, `full` | `read` for reporting |
| Create, cancel or reschedule a booking | `bookings`, `full` | `bookings` |
| Activate/deactivate Hourmere Trigger | `full` | Separate `full` credential for the trigger |

Existing organization and host permissions still apply. A trigger needs an organization
owner/admin, including the owner of a personal space, because it subscribes to events for
the whole organization. A booking key does not grant management of every booking in a team.
Use separate credentials for reporting, booking actions and triggers to limit access.
See [API key scopes](/docs/api-keys).

## Booking actions

The **Hourmere** node can list event types, find available slots, create a booking, get a
booking, cancel it, reschedule it and list bookings with filters. Use IDs returned by
Hourmere instead of display titles. Lists are bounded; use the exposed pagination fields
when following later pages.

For availability, enter the personal handle or team slug, event type slug and a bounded `start`/`end` range. Supply instants
with an explicit UTC offset and an IANA time zone such as `America/Los_Angeles`. Keep the
returned slot instant when booking: a local wall-clock time can be repeated or absent at
a daylight-saving transition. Availability does not reserve a slot; a concurrent booking
can take it before your create request.

For create, retain one idempotency key per intended operation. Reuse that
key and the same input after a timeout or retry; use a new key for a different operation.
Do not generate a new key on each retry. Rescheduling returns a successor booking ID;
use that ID for later host actions. Reschedule has no node-level idempotency key; after an
ambiguous response, read the booking state before deciding to retry. Cancellation and rescheduling use Hourmere's existing
authorization and lifecycle rules.

API errors include the HTTP status and Hourmere error code, such as `insufficient_scope`
or `slot_unavailable`. On HTTP 429, the node waits once for a valid `Retry-After` of up to
60 seconds and retries. A longer wait or another 429 becomes an error with retry guidance;
use a Wait node or an error workflow before trying again. Automatic retry does not bypass
Hourmere's limits.

## Signed booking triggers

First enable [booking webhooks](/docs/webhooks) on Hourmere: set `WEBHOOKS_ENABLED=true`,
configure its independent encryption key on web and worker processes, and run a worker.
Configure n8n's external webhook URL so Hourmere can reach it. Public destinations need
HTTPS; private self-hosted destinations need the operator's explicit
[private receiver configuration](/docs/self-hosting#private-webhook-receivers).

Add **Hourmere Trigger**, select its credential and one or more events, then activate the
workflow. The node registers its callback and stores the returned webhook ID and signing
secret in workflow static data. Deactivation deletes that endpoint. Each active trigger
uses one of Hourmere's ten webhook endpoints per organization. Supported events are:

- `booking.created`
- `booking.cancelled`
- `booking.rescheduled`

Every delivery must have a valid HMAC-SHA256 signature over the exact raw body and a
signed timestamp within five minutes of n8n's clock. Unsigned, tampered and stale requests
are rejected before emitting a workflow item. Keep both hosts' clocks synchronized.
Hourmere refreshes the timestamp and signature when retrying an old event, so event age
alone does not cause rejection.

The node suppresses redeliveries using the **signed payload's event ID**, retaining receipts
for thirty days. A process-level coordinator merges separate request snapshots to suppress
concurrent redelivery within one n8n process. Limits are 10,000 receipts per registration,
100,000 receipts and 1,000 registrations per process; reaching a limit returns 503 instead
of forgetting unexpired receipts. These safeguards are best-effort: n8n workflow static
data is not a transactional receipt store across workers, process crashes or restarts.
For durable effects, make the downstream operation idempotent using the event `id` in a
persistent store with a unique constraint. Do not assume exactly-once workflow execution.

The signing secret is in workflow static data, which is separate from n8n's encrypted API
credentials. Restrict access to workflow data, database copies, exports and backups.
Do not rotate this endpoint's secret manually: deactivate/reactivate the trigger to
register a replacement. Deactivation removes the old endpoint and its retained deliveries;
events during the gap are not backfilled.

Payloads contain booking identifiers, times and status, without invitee contact details or
management links. Get the booking with an authorized action if your workflow needs more
data. Events can arrive out of order. A reschedule carries the new booking ID and
`rescheduledFromId`; it does not produce a second cancellation event for its predecessor.

## Examples

**Keep another system in sync:** activate a trigger for all three events. Use the event
`id` as your downstream deduplication key. Match records using `data.bookingId`; for a
reschedule, link the successor to `data.rescheduledFromId`. Reconcile the latest booking
state before applying an older event.

**Book from a request:** use a `bookings` credential to list event types, find a slot and
create a booking with the request's retained idempotency key and invitee data. Store the
returned booking ID. If the slot was taken, fetch availability again and ask for another
time instead of blindly retrying the same occupied slot.

**Daily report:** use a separate `read` credential with a Schedule Trigger and Hourmere's
list-bookings operation. Set date/status filters and follow pagination. Limit who can
view execution history because booking responses can contain attendee details.

## Development and limitations

The package follows n8n's community-node metadata conventions and uses its official
[`n8n-node` tooling](https://docs.n8n.io/connect/create-nodes/build-your-node/using-the-n8n-node-tool.md)
for build/lint. Tests mock HTTP and check the repository's generated OpenAPI contract;
they do not contact a live provider. Installing and running n8n itself is separate from
running the Hourmere server.

The package is not yet published to npm or verified for n8n Cloud. It covers booking
workflows, not all Hourmere configuration endpoints. There is no historical-event backfill,
manual replay or exactly-once delivery guarantee. Protect and retain downstream receipts
when effects must survive retries, concurrent workers or restarts.

### Interface language

Node parameter labels include English and Simplified Chinese (`zh`, with a `zh-CN` alias).
n8n's [locale setting](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/timezone-and-localization.md)
uses `N8N_DEFAULT_LOCALE=zh` for Chinese; untranslated strings fall back to English.
The upstream [node loader](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/node-types.ts)
supports adjacent translation files, including community nodes. Its
[credential/header translation controller](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/controllers/translation.controller.ts)
loads only built-in package resources for those surfaces, so this community package's
credential fields, node headers and runtime errors remain English. This does not change
Hourmere's own interface or notification languages.
