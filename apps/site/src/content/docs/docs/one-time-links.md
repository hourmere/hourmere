---
title: One-time booking links
description: Create a private booking link for one successful booking, then manage its lifecycle.
---

A one-time link opens `/book/{token}` and permits **one successful booking** of its event
type. Opening it or choosing a time does not consume it. The booking and link claim commit
together; a failed booking leaves the link available. If two invitees submit together,
only one can book through that link. The other sees the same neutral unavailable page as
anyone opening a used, expired, revoked or invalid link.

## One-time links and hidden event types

A hidden event type is omitted from the host's public profile, but its ordinary direct
booking address is reusable. Hiding an event type does not limit it to one booking or
verify who follows its address. A one-time link is a separate, private booking capability
for that event type; each link allows one committed booking. Hidden event types can use
one-time links too. The event type must still be saved, enabled and ready for bookings.

One-time links do not disable the ordinary reusable booking address. If you share that
address separately, its normal booking rules still apply. The dedicated one-time page
does not offer it. See [known limitations](#known-limitations) before sharing.

## Create and revoke in the editor

1. Open **Event types** in the intended personal or team space and edit a saved event type.
2. Under **One-time links**, choose **Manage one-time links**. Optionally set **Link expiry**,
   **Prefilled invitee name** and **Prefilled invitee email**, then choose **Create one-time
   link**. Save and enable a new event type before creating its links.
3. Copy the full URL from **Copy your one-time link** and share it privately with the invitee.
   **The URL is shown once.** Closing the dialog, changing event types or leaving the
   space discards it. The administrator list cannot recover it. If you lose the URL,
   revoke the unused link and create another.
4. The list shows each link's state, expiry, prefill, creator and creation time, and the
   original booking reference once used. To withdraw an unused link, choose **Revoke**
   and confirm. Repeating revocation has no further effect; a used link stays used.

The editor offers these expiry presets:

| Choice | Elapsed hours from creation |
|---|---|
| Never | No expiry |
| In 1 hour | 1 |
| In 1 day | 24 |
| In 7 days | 168 |
| In 30 days | 720 |

These are presets, not minimum or maximum expiry bounds for REST or MCP. A day here is
exactly 24 elapsed hours, including across daylight-saving changes.

The optional prefill remains editable. **Prefill is not identity proof:** it neither
verifies an email address nor restricts the link to a particular person. Anyone holding
an active URL can attempt its one booking. The normal hosts, availability, meeting
lengths, questions, notice and booking limits apply.

## Ownership and scopes

Personal event types require their owner. Team owners and admins manage team-owned event
types; ordinary members can manage their own event types in that team. Being a host or
having created a team-owned link does not grant administration rights. A team-owned link
stays with the team after its creator leaves or deletes their account; current team
managers can still list and revoke it.

| Operation | API key scopes |
|---|---|
| Create or revoke | **Bookings** (`bookings`) or **Full account access** (`full`) |
| List or read metadata | **Read** (`read`) or **Full account access** (`full`) |

A `bookings` key cannot read private link history. Existing organization, ownership and
membership checks still apply. Existing authorized MCP OAuth `mcp:tools` grants can create,
list and revoke within those same permissions; session cookies do not authenticate MCP.

## REST

Use an event-type ID from `GET /api/v1/event-types`. Replace the placeholders below with
that ID and a new random UUID retained before making the request. Set `HOURMERE_URL` to
your instance's origin and `HOURMERE_API_KEY` to your scoped key, as in the
[REST quickstart](/docs/rest). These examples use API-key authentication.

| Method and path | Result |
|---|---|
| `POST /api/v1/event-types/{eventTypeId}/one-time-links` | Creates a link and returns its full booking URL once. |
| `GET /api/v1/event-types/{eventTypeId}/one-time-links` | Lists metadata without a URL, token or token hash. |
| `GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}` | Reads one link's safe metadata. |
| `DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}` | Revokes an unused link and reports its state. |

Store this request body in a private `one-time-request.json`, replacing the sample expiry
with an instant in your future:

```json
{
  "expiresAt": "2027-12-01T18:00:00Z",
  "prefill": { "name": "Alex", "email": "alex@example.com" }
}
```

```sh
curl --fail-with-body -X POST \
  "$HOURMERE_URL/api/v1/event-types/<event-type-id>/one-time-links" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <new-random-UUID>' \
  --data-binary @one-time-request.json
```

Choose a future absolute instant with an explicit UTC offset or `Z`. There is no minimum
lead time or maximum lifetime policy beyond requiring a valid future instant. Omit
`expiresAt` or use null for no expiry; an empty object is a valid creation body. Name and
email are independently optional; names allow up to 200 characters and email addresses up
to 254. Invalid values are rejected. There is no private label or note field.

Keep the successful response private and disable response-body logging in your client.
An optional `Idempotency-Key` (1–255 visible ASCII characters without spaces) binds
creation to the caller, credential, organization and normalized request. An exact retry
does not mint a second token. There is no creation-response cache: even an immediate retry
returns `409 one_time_link_already_created` rather than repeating the URL. Reusing the
same key with different values returns `409 idempotency_key_reused`.

After a lost response, inspect the list with a read/full key, revoke the unused link and
create another with a fresh random key. A bookings key can revoke using the ID retained
from a successful create response; ask a manager with history access to find it after a
lost response. Do not automatically generate a new key on a network failure. The replay
protection lasts while the link record remains; physical deletion or retention cleanup
ends it. Changing to another session, key or OAuth grant does not retry the original call.

List or revoke using the metadata ID, without sending the booking token:

```sh
curl --fail-with-body \
  "$HOURMERE_URL/api/v1/event-types/<event-type-id>/one-time-links" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
curl --fail-with-body -X DELETE \
  "$HOURMERE_URL/api/v1/event-types/<event-type-id>/one-time-links/<link-id>" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
```

Listing defaults to 50 rows, with `limit` from 1 to 100. Pass `nextAfter` as `after` for the
next page of the same event type. Newest links appear first, ordered by their time-ordered
UUIDv7 IDs, including links created with an idempotency key. Retry keys are stored
separately from link IDs. Use your instance's `/api/v1/openapi.json` for complete schemas.

Browser-session REST writes also require `X-Expected-Organization-Id` matching the
intended current space; the editor supplies it. An API key stays bound to its organization.

## MCP

Call `create_one_time_link` with this JSON, replacing the event ID, random retry key and
expiry as for REST:

```json
{
  "eventTypeId": "<event-type-id>",
  "idempotencyKey": "<new-random-UUID>",
  "expiresAt": "2027-12-01T18:00:00Z",
  "prefill": { "name": "Alex", "email": "alex@example.com" }
}
```

Call `list_one_time_links` with:

```json
{ "eventTypeId": "<event-type-id>", "limit": 50 }
```

It also accepts `after` from the preceding result's `nextAfter`. To revoke, call
`revoke_one_time_link` with the ID from creation, or the list with a read/full key:

```json
{ "eventTypeId": "<event-type-id>", "id": "<link-id>" }
```

These tools share REST validation and permissions. MCP requires an explicit retained
random `idempotencyKey` on create. The creation output identifies the URL as shown once;
keep it out of shared transcripts and tool-result logs. Revocation returns safe metadata
in `{ "link": ... }`, or `{ "link": null }` for an unknown or unrelated ID. See
[MCP setup](/docs/mcp) for authentication and client configuration.

## CLI

From a source checkout, the following commands send the same JSON to the corresponding
MCP tools. Replace every placeholder and the sample expiry before running. Configure
`HOURMERE_URL` and `HOURMERE_API_KEY` as in the [CLI guide](/docs/cli).

```sh
npm run --silent cli -- one-time-links create --input - <<'JSON'
{
  "eventTypeId": "<event-type-id>",
  "idempotencyKey": "<new-random-UUID>",
  "expiresAt": "2027-12-01T18:00:00Z",
  "prefill": { "name": "Alex", "email": "alex@example.com" }
}
JSON
```

```sh
npm run --silent cli -- one-time-links list --input - <<'JSON'
{ "eventTypeId": "<event-type-id>", "limit": 50 }
JSON
```

```sh
npm run --silent cli -- one-time-links revoke --input - <<'JSON'
{ "eventTypeId": "<event-type-id>", "id": "<link-id>" }
JSON
```

Installed CLI users can replace `npm run --silent cli --` with `hourmere`. A private
file is also accepted with `--input one-time-create.json` (and corresponding list/revoke
files). Creation prints the new URL once to stdout and cannot use `--output`. The CLI
never saves the URL in configuration or history files. Avoid terminal recording, shared
logs and shell commands containing the token.

## States and revocation

| State | Meaning |
|---|---|
| `active` | Unused, unrevoked and before its optional expiry. |
| `used` | A booking committed through the link. The original booking ID is retained. |
| `expired` | The expiry instant has arrived, even if cleanup has not run. |
| `revoked` | An authorized manager withdrew the unused link. |

Expiry is checked against database wall time, including after lock waits. At the exact
expiry instant the link is unavailable. With no expiry it remains available until used
or revoked, provided the event type is active and ready. An inactive or deleted event
type is unavailable. Unknown, malformed, used, expired and revoked links all show the
same neutral **This booking link is unavailable** page, including when another
browser wins a simultaneous booking attempt.

Revocation withdraws an active unused link. Repeating it is harmless; already used,
expired or revoked links retain their state. REST returns safe metadata, or null for an
unknown or unrelated ID, after event management permission is checked. If booking and
revocation race, either the booking commits and the link stays used, or revocation wins
and the booking is refused. Revocation does not cancel an existing booking.

Cancel or reschedule through the booking's normal private management link.
**Cancelling or rescheduling never reactivates the original one-time link.** Its original
booking reference remains as evidence, even if the booking has moved or been cancelled.
An exact retry of the winning booking request can return that original result without a
second claim; opening the used URL for another booking remains unavailable.

## Limits and cleanup

There may be **1000 active, unexpired links per personal owner or team**, across event
types and creators. Ordinary team members additionally have a **200-link allowance**
across their own event types in that team. Owners/admins share the team total without
that sub-limit. Used, expired and revoked links release capacity. Creation is refused
with `one_time_link_limit_reached` at the limit.

An hourly cleanup deletes at most **500 unused links per run** once **90 days** have
passed since expiry or revocation. Revoked links use their revocation time even if their
expiry was earlier. A backlog takes additional runs, and locked rows can wait for a later
run. Active links without expiry are retained. Used links are never deleted by this
cleanup and remain with their original booking, including after cancellation or
rescheduling. Physical event-type or organization deletion removes its links too.

## Privacy

Treat the URL as a secret: anyone who possesses it can attempt the booking. Only a hash
of the booking token is stored. Administrative lists, detail reads and revocations return
neither the URL, token nor hash. Do not paste a real URL into public tickets, transcripts
or analytics, and do not log creation response bodies.

Tokens travel in the URL path. One-time pages and API responses use
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Hourmere never logs the token
or sends it to analytics or error messages. Operators running their own proxy or CDN must
redact the path token in access and error logs, including encoded paths, request headers
and response `Location` headers. Follow the [self-hosting proxy protections](/docs/self-hosting#proxy-behavior-and-an-existing-proxy);
application redaction does not configure external infrastructure.

## Known limitations

- One-time links cannot be embedded and never offer an after-booking redirect.
- There is no bulk creation, automatic delivery, recipient verification, private label or
  note field, or way to recover a discarded URL. Revoke an unused lost link and create another.
- One-time links do not make an event type's ordinary direct booking address single use.
  Arbitrary host-authored descriptions or meeting content can still contain reusable links.
- A host with an empty display name may appear by their public handle.
- Cleanup is bounded to 500 unused rows per hourly run; it does not promise deletion
  exactly 90 days after expiry or revocation. Used links retain their booking evidence.
- A future booking-retention implementation must delete or detach used link evidence
  before deleting its booking; the booking reference currently prevents deletion on its own.
