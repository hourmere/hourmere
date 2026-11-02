---
title: One-time booking links
description: Create a private booking link for one successful booking, then manage its lifecycle.
---

A one-time link opens `/book/{token}` and permits one successful booking of its event
type. Opening it or choosing a time does not consume it. The booking and link claim commit
together; a failed booking leaves the link available. Cancelling or rescheduling the
booking never makes the original link reusable.

## Create and revoke in the editor

1. Open **Event types** in the intended personal or team space and edit a saved event type.
2. Under **One-time links**, choose **Manage one-time links**. Optionally set an expiry
   and an invitee name or email, then choose **Create one-time link**. Save and enable
   a new event type before creating its links.
3. Copy the full URL from the creation dialog and share it privately with the invitee.
   **The URL is shown once.** Closing the dialog, changing event types or leaving the
   space discards it. The administrator list cannot recover it.
4. The list shows each link's state, expiry, prefill, creator and creation time, and the
   original booking reference once used. To withdraw an unused link, choose **Revoke**
   and confirm. Repeating revocation has no further effect; a used link stays used.

The optional prefill remains editable. It neither verifies an email address nor restricts
the link to a particular person. Anyone holding an active URL can attempt its one booking.
The normal hosts, availability, meeting lengths, questions, notice and booking limits apply.

Personal event types require their owner. Team owners and admins manage team-owned event
types; ordinary members can manage their own event types in that team. Being a host or
having created a team-owned link does not grant administration rights. A team link stays
with the team after its creator leaves or deletes their account.

## REST

Use an event-type ID from `GET /api/v1/event-types` and a **Bookings** (`bookings`) or
**Full account access** (`full`) API key for creation and revocation. Listing and reading
require `read` or `full`; a `bookings` key cannot read private link history. Existing
organization and ownership checks still apply.

| Method and path | Result |
|---|---|
| `POST /api/v1/event-types/{eventTypeId}/one-time-links` | Creates a link and returns its full booking URL once. |
| `GET /api/v1/event-types/{eventTypeId}/one-time-links` | Lists metadata without a URL, token or token hash. |
| `GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}` | Reads one link's safe metadata. |
| `DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}` | Revokes an unused link and reports its state. |

For example, store this optional request body in `one-time-request.json`:

```json
{
  "expiresAt": "2027-12-01T18:00:00Z",
  "prefill": { "name": "Alex", "email": "alex@example.com" }
}
```

Choose an expiry in the future, with an explicit UTC offset or `Z`. Omit `expiresAt`
or use null for no expiry. Name and email are independently optional; names allow up to
200 characters and email addresses up to 254. Invalid values are rejected. There is no
private label or note field.

```sh
curl --fail-with-body -X POST \
  "$HOURMERE_URL/api/v1/event-types/<event-type-id>/one-time-links" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <new random UUID>' \
  --data-binary @one-time-request.json
```

Keep the successful response private and disable response-body logging in your client.
An optional `Idempotency-Key` (1–255 visible ASCII characters without spaces) binds
creation to the caller, organization and normalized request. An exact retry does not
mint a second token. The server has no creation-response
cache and stores only token hashes, so even an immediate retry returns
`409 one_time_link_already_created` rather than repeating the URL. Reusing the same key
with different values returns `409 idempotency_key_reused`. After a lost response, inspect
the list with a read/full key, revoke the unused link and create another with a fresh
random key. A bookings key can revoke using the id from a successful create response;
ask a manager with history access to find the id after a lost response. Do not
automatically generate a new key on a network failure. The replay protection lasts while
the link record remains; physical deletion or retention cleanup ends it.

List or revoke without sending the booking token:

```sh
curl --fail-with-body \
  "$HOURMERE_URL/api/v1/event-types/<event-type-id>/one-time-links" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
curl --fail-with-body -X DELETE \
  "$HOURMERE_URL/api/v1/event-types/<event-type-id>/one-time-links/<link-id>" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
```

Use your instance's `/api/v1/openapi.json` for the complete request and response schemas.
Listing defaults to 50 rows, with `limit` from 1 to 100. Pass `nextAfter` as `after`
for the next page of the same event type. Newest links appear first, ordered by their
time-ordered UUIDv7 IDs, including links created with an idempotency key. Retry keys are
stored separately from link IDs.

## MCP and CLI

MCP tools are `create_one_time_link`, `list_one_time_links` and `revoke_one_time_link`.
Creation takes `eventTypeId` and a retained random `idempotencyKey`, plus optional
`expiresAt` and `prefill`; listing takes `eventTypeId` and optional `limit`/`after`,
and revocation takes `eventTypeId` and the `id` returned when the link was created, or
from the list with a read/full key. These use the
same validation, permissions and replay rules as REST. Revocation wraps its nullable
metadata result as `{ "link": ... }`. The creation output explicitly
identifies the URL as shown once. Keep it out of shared transcripts and tool-result logs.
Creation and revocation require a `bookings` or `full` API key; listing requires `read`
or `full`. Existing MCP OAuth `mcp:tools` grants can create, list and revoke links within
the account’s organization and event-type permissions.

For the CLI, add `eventTypeId` and a retained random `idempotencyKey` to the example
JSON above. Supply JSON through a private file or standard input:

```sh
hourmere one-time-links create --input one-time-create.json
hourmere one-time-links list --input one-time-list.json
hourmere one-time-links revoke --input one-time-revoke.json
```

The list input is `{ "eventTypeId": "<event-type-id>" }`; revoke adds
`"id": "<link-id>"`. Creation prints the new URL once to stdout. It cannot use `--output`;
the CLI never saves this URL in configuration or history files. Avoid terminal recording,
shared logs and shell commands containing the token. See [CLI](/docs/cli) for environment
setup and source-checkout usage.

## States, limits and privacy

| State | Meaning |
|---|---|
| `active` | Unused, unrevoked and before its optional expiry. |
| `used` | A booking committed through the link. The original booking ID is retained. |
| `expired` | The expiry instant has arrived, even if cleanup has not run. |
| `revoked` | An authorized manager withdrew the unused link. |

There may be **1000 active, unexpired links per personal owner or team**, across event
types and creators. Ordinary team members additionally have a **200-link allowance**
across their own event types in that team. Used, expired and revoked links release
capacity. Creation is refused with `one_time_link_limit_reached` at the limit.

Expiry is an absolute instant checked against database wall time, including after lock
waits. At the exact expiry instant the link is unavailable; daylight-saving clock changes
do not extend it. With no expiry it remains available until used or revoked. Inactive or
deleted event types are unavailable; hidden event types can still use direct one-time links.
Every unavailable link shows the same neutral public page.

Tokens travel in the URL path. One-time pages and API responses use
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`; Hourmere excludes capabilities
from request logs, errors and analytics. Operators must apply equivalent redaction to
reverse-proxy and infrastructure logs. Links cannot be embedded, and the dedicated page
does not offer the reusable booking address. Arbitrary host-authored content can still
contain reusable links, and a host with an empty display name may appear by their handle.

Used links remain as evidence with the original booking, including after a cancellation
or reschedule. Booking deletion must first delete or detach that evidence because its
foreign key uses `NO ACTION`. An hourly cleanup deletes at most 500 unused links whose
expiry or revocation is at least 90 days old; a backlog takes additional runs. Active
links without expiry are retained. There is no bulk creation, automatic delivery,
recipient verification, label/note field or way to recover a discarded URL.
