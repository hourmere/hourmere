---
title: Command-line client
description: Use API-key booking tools from a terminal.
---

The standalone CLI supports Node.js 22 or later; repository development still uses Node.js 26.
It calls the existing stateless MCP tools at `/mcp` for API-key users, using Node's built-in
HTTP client with no additional dependencies. The `export` command obtains a bounded MCP
download pointer and streams the CSV from REST to a file or stdout; CSV rows are never
returned in the MCP tool result. This is for personal bookings; team exports require the
verified owner/admin browser session. Failed downloads report the API error code and remove
an output file created by this invocation. See [CSV booking export](/docs/booking-export).
This preserves the key's organization, permissions, idempotency scope and `mcp` audit source,
including host rescheduling, without introducing another booking API.

Run it from a source checkout:

```sh
export HOURMERE_URL=https://hourmere.example.com
# Supply HOURMERE_API_KEY from your secret manager or an existing private environment.
npm run --silent cli -- whoami
npm run --silent cli -- catalog
npm run --silent cli -- --help
```

Install the standalone **`@hourmere/cli`** package from npm once published; until then,
use the source commands above. Install with `npm install --global @hourmere/cli` and use
`hourmere whoami`, `hourmere --help` and `hourmere --version`. See the
[npm README](https://github.com/hourmere/hourmere/blob/main/tools/cli/README.md) and [release procedure](https://github.com/hourmere/hourmere/blob/main/docs/releasing.md) for the tarball
checks and owner approval requirements.

The CLI cannot create or revoke API keys. Sign in to the web app, open `/app/api-keys`,
choose the intended organization and a scope, then create and privately copy the key.
**Bookings** (`bookings`, the web default) is recommended for AI booking agents;
**Read** (`read`) suits analytics/reporting and cannot book, move, cancel or retry bookings.
**Full account access** (`full`) also permits event-type and notification configuration changes;
choose it only for trusted software. Legacy keys retain `full`. Scope cannot be edited:
use **Create replacement**, update the client and revoke the old key. `whoami` returns
`apiKeyScope`; [API keys](/docs/api-keys#operation-reference) lists each command's allowed
scopes in a table generated from the authorization code. MCP discovery is filtered by scope;
a disallowed command reports `insufficient_scope` on stderr and exits **1**.

The CLI reads only
`HOURMERE_URL` and `HOURMERE_API_KEY`; it does not load `.env`, browser sessions or stored
credentials. Do not put a key into shell history. `--url ORIGIN` overrides `HOURMERE_URL`.
Use an HTTPS origin with no credentials, path, query or fragment. HTTP is accepted only for
`localhost`, `127.0.0.1` or `[::1]` development instances. Redirects are refused before a key
can be forwarded. Requests time out after 30 seconds and are never automatically retried.

For `hourmere one-time-links create|list|revoke`, see
[one-time booking links](/docs/one-time-links). Creation prints its private URL once to
stdout and refuses `--output`; list/revoke use metadata IDs without the booking token.
Create/revoke require `bookings` or `full` API key scope, while listing allows `read` or `full`.

## Commands and JSON arguments

Arguments are the corresponding [MCP tool's](/docs/mcp#tools) JSON object. Supply them with
`--input FILE` or `--input -` for standard input. No input means `{}`. Secrets and attendee
data need not appear in process arguments or shell history. Input files must be regular
files (symlinks are refused); input is limited to slightly less than 2 MiB to leave room
for the MCP envelope. The server enforces the tool's full schema and domain rules.

| Command | Tool | Arguments |
|---|---|---|
| `branding get` | `get_branding` | `{}`; requires `read` or `full` |
| `branding set` | `set_branding` | optional `brandPrimaryColor` (`#RRGGBB`), `brandLogo` (uploaded hash); `null` clears; requires `full` |
| `branding upload` | REST `POST /api/v1/branding/logo` | `--file FILE --content-type image/png` (also `image/jpeg`, `image/webp`); requires `full` |
| `whoami` | `whoami` | `{}` |
| `profile` | `get_profile` | `{}` |
| `catalog` | `list_event_types` | optional `limit`, `after` |
| `event` | `get_event_type` | `id` from `catalog` |
| `create-event` | `create_event_type` | `slug`, `title`, `durationMinutes`; optional `allowedDurationsMinutes` and other event-type fields |
| `update-event` | `update_event_type` | `id` beside the changed event-type fields, including optional `durationMinutes`, `allowedDurationsMinutes` |
| `set-event-notifications` | `set_event_type_notifications` | `id`, complete `notifications` (`reminders` and `followUps`); `full` scope required |
| `schedules` | `list_schedules` | optional `limit`, `after` |
| `schedule` | `get_schedule` | `id` from `schedules` |
| `slots` | `find_available_slots` | `handle` or `teamSlug`, `slug`, `timeZone`, `startDate`, `endDate`; optional `durationMinutes`, `maxSlots`, `after` |
| `open-time-snippet` | `generate_open_time_snippet` | exactly one of `eventTypeId`, `slug`; `from`, `to`; optional `count`, `locale`, `displayTimeZone`, `durationMinutes` |
| `book` | `create_booking` | `handle` or `teamSlug`, `slug`, `start`, `invitee`, **`idempotencyKey`**; optional `durationMinutes`, `responses`, `guests` |
| `list` | `list_bookings` | optional `from`, `to`, `status`, `order`, `limit`, `cursor` |
| `reschedule` | `reschedule_booking` | `start` and exactly one of `bookingId`, `manageToken`; optional `durationMinutes` |
| `cancel` | `cancel_booking` | exactly one of `bookingId`, `manageToken`; optional `reason` |
| `one-time-links create` | `create_one_time_link` | `eventTypeId`, retained random `idempotencyKey`; optional `expiresAt`, `prefill`; requires `bookings` or `full` |
| `one-time-links list` | `list_one_time_links` | `eventTypeId`; optional `limit`, `after`; requires `read` or `full` |
| `one-time-links revoke` | `revoke_one_time_link` | `eventTypeId`, `id`; requires `bookings` or `full` |

`catalog` includes the key's visible team and personal configurations. Booking and slot
commands accept exactly one of `handle` (personal link) or `teamSlug` (team link). Team
slugs keep their stored case; collective types require every configured host. Activated
round-robin types offer the union and assign one available host; `book` returns its safe
`assignedHost` name/time zone. Replaying the same JSON/key retains the selection. See
[round-robin scheduling](/docs/round-robin-scheduling) for explicit activation and fairness. `reschedule` and `cancel` by ID require hosting that booking in the key's
organization. A management token instead acts as the invitee. These operations can send
the same notification emails and calendar updates as the booking page.

Choose a meeting length from the event type's `allowedDurationsMinutes`, returned by
`event` or `slots`. Pass it as JSON `durationMinutes` or use `--duration-minutes 60` on
`slots`, `book` and `reschedule`. The option accepts whole minutes from 1 to 1440; the
server also checks the event type's allowed list. If both JSON and the option supply a
length, they must agree. Keep the same selection when paging through slots and booking.
Omitting it uses the default for slots and new bookings. Rescheduling without a selection
keeps the booking's actual length, even if the host has since removed that option;
an explicit new length must be in the current list.

For example, `hourmere slots --input slots.json --duration-minutes 60` finds hour-long
slots, and `hourmere book --input booking-request.json --duration-minutes 60 --output booking-result.json`
books the chosen slot with that length.

For example, put this JSON into a local request file, then run
`npm run --silent cli -- slots --input slots.json`:

```json
{
  "handle": "ada",
  "slug": "intro",
  "timeZone": "Europe/Berlin",
  "startDate": "2026-11-02",
  "endDate": "2026-11-02",
  "maxSlots": 20
}
```

For a team link such as `/team/Cobaltmere/interview`, replace `"handle": "ada"`
with `"teamSlug": "Cobaltmere"` and use `"slug": "interview"` in both the slots
and booking JSON. Do not provide both namespace fields. The CLI forwards the same JSON
without a separate team command.

Read notifications with `event --input event.json`, where the file contains
`{"id":"<event-type-id>"}`. Replace them with
`npm run --silent cli -- set-event-notifications --input notifications.json`:

```json
{
  "id": "<event-type-id>",
  "notifications": {
    "reminders": [],
    "followUps": [
      {
        "id": "one-hour-later",
        "offsetMinutes": 60,
        "recipients": { "invitee": true, "guests": false, "host": false },
        "hostNote": "Thank you for your time."
      }
    ]
  }
}
```

The command returns the full event type and changes only future new bookings, without
immediate email. Both arrays are required; two empty arrays disable scheduled messages.
See [Reminders and follow-ups](/docs/reminders-and-follow-ups) for timing, recipients,
host notes and known limitations.
Use a `full` key with personal-owner or team-owner/admin permissions. The server applies
the same [validation rules](/docs/api-conventions#event-type-notification-settings)
as REST and MCP; failure retains the error code and exits 1. Follow-up notes also require
the operator's [host-note setting](/docs/notifications#host-notes-and-hosted-email-abuse-controls).

Keep all filters unchanged when continuing a page. Catalogs and slots return `nextAfter`;
pass it as `after` until null. Booking lists return `nextCursor`; pass it as `cursor` until
null. The CLI makes one bounded request per invocation, rather than silently fetching an
unlimited list. Availability can change between pages and before booking.

Host booking fields from `list` include optional `rescheduledToId`: the immediate successor
in the same organization that the caller also hosts, or null when none is available. It is
returned even when the successor falls outside the current page or filters. Public/manage
responses omit it. The predecessor's `status` remains `cancelled`; `rescheduledToId`
distinguishes a reschedule, while `rescheduledFromId` points back to the predecessor.

## Draft open-time email snippets

Save a request such as the following to `snippet-request.json`, using future instants:

```json
{
  "slug": "intro",
  "from": "2026-11-09T00:00:00-08:00",
  "to": "2026-11-16T00:00:00-08:00",
  "count": 3,
  "displayTimeZone": "America/Los_Angeles",
  "locale": "en"
}
```

```sh
hourmere open-time-snippet --json --input snippet-request.json
# From a source checkout:
npm run --silent cli -- open-time-snippet --json --input snippet-request.json
```

Use exactly one of `eventTypeId` or `slug`; `from`/`to` are offset-bearing instants spanning
at most 31 elapsed days. `count` defaults to 3 and accepts 1–10. Optional `durationMinutes`
is supplied in JSON; omitted language and display zone use the caller's profile defaults.
`--json` makes the normal JSON output explicit. The response includes `slots` with direct
links, `text` and `html` for your draft. Generation sends no mail and reserves no time.
`read`, `bookings` and `full` keys work with personal-owner or team-owner/admin permission,
when the operator enables `SLOT_SNIPPETS_ENABLED`. See [the agent guide](/docs/open-time-snippets) for
response fields, DST boundaries, no-times errors and the booking page's taken-time fallback.

## Configure meeting lengths

`create-event` and `update-event` require a `full` API key and keep the same organization,
role and ownership checks as REST. Their JSON fields are `durationMinutes` for the default
and `allowedDurationsMinutes` for the complete list, kept in ascending order. Supplied lengths are sorted before storage.
Offer 1–12 distinct lengths,
each 1–1440 whole minutes, and include the default. The `--duration-minutes` option is for
slot, booking and reschedule selection; use JSON for event-type configuration.

For example, save `{ "slug": "intro", "title": "Introduction", "durationMinutes": 30,
"allowedDurationsMinutes": [15, 30, 60] }` to a request file, then run
`hourmere create-event --input event-request.json`. Updates use a flat object such as
`{ "id": "<event-type-uuid>", "durationMinutes": 60, "allowedDurationsMinutes": [30, 60] }`
and `hourmere update-event --input event-update.json`. Omitting the list on creation
makes a single-length type. See [multiple meeting lengths](/docs/multiple-durations) for
update compatibility, rescheduling and shared-rule limits.

## Configure an after-booking redirect

Use `event` to read `successRedirect` and `create-event` / `update-event` with a `full` key
to write it through JSON or the matching redirect flags.
`--success-redirect-url`, `--success-redirect-parameters`,
`--success-redirect-include-invitee-personal-data` and `--success-redirect-allow-embed-parent`
construct the replacement object; `--clear-success-redirect` clears it. See
[after-booking redirects](/docs/after-booking#cli) for flag syntax, privacy warnings,
field errors and the current limitations.

## Booking and private results

Choose a slot's UTC `start` unchanged. A booking input could contain:

```json
{
  "handle": "ada",
  "slug": "intro",
  "start": "2026-11-02T08:00:00Z",
  "invitee": {
    "name": "Test Invitee",
    "email": "invitee@example.test",
    "timeZone": "Europe/Berlin"
  },
  "idempotencyKey": "replace-with-a-new-random-UUID-for-this-booking"
}
```

Optional `invitee.locale` is the same BCP 47 notification preference as REST and MCP.
The [shared locale registry](/docs/interface-languages) matches supported languages;
unsupported languages and missing messages fall back to English. Dates use the recipient
language and time zone; retries, reschedules and cancellation retain the saved locale.

Generate and retain a random idempotency key before each booking, along with that booking's
input. The CLI requires it and never generates a disposable key that would be lost after a
network failure. After checking the request and recipient, create the booking and retain
its one-time management token in a new private file:

```sh
npm run --silent cli -- book --input booking-request.json --output booking-result.json
```

`--output` reserves a **new** file before contacting the server, with permissions `0600`,
and writes the full JSON result including its `manageToken`. It refuses an existing file,
directory or symlink, preventing accidental overwrites and token loss through a bad output
path. The file is flushed before the CLI reports `{"outputWritten":true}`. Keep request and
result files out of Git, backups shared with others and logs. Stdout otherwise carries the
JSON result with management tokens and API keys redacted, including copies in nested text;
the CLI never prints booking management capabilities. Other returned information, such as attendee
email addresses, remains private booking data: redirect it only to destinations you trust.

`one-time-links create` is the exception to secret redaction: it prints its new private
booking URL once to stdout so you can copy it. It refuses `--output` before contacting the
server and never writes the URL to config, history or other files. Keep terminal capture
and shell redirection private. The retained `idempotencyKey` prevents a retry from creating
another link, but no response cache can recover a lost URL. See
[one-time booking links](/docs/one-time-links) for UI, REST, MCP and CLI examples.

Use `reschedule --input move-request.json --output moved-result.json` to retain the new
booking's result. Host moves return `manageToken: null` and preserve the invitee's existing
links; invitee moves return a new token. Input is `{"bookingId":"...","start":"..."}` for a host move, or
the same object with `manageToken` instead of `bookingId` for an invitee move. Cancellation
uses `{"bookingId":"...","reason":"..."}` or a private `manageToken` input. There is no
interactive confirmation: running a mutation command is the instruction to perform it.

## Failures and recovery

Success exits **0**. Usage, local input/output, protocol and domain errors exit **1**.
Network failures or generic HTTP transport errors exit **3**. Errors are JSON on stderr
with a stable `error` code, an HTTP `status` when available, and `retryAfterSeconds` when
provided. Untrusted server messages, URLs and exception causes are not printed.

A failure after the call begins includes `outcomeMayBeUnknown: true`. A reserved result
file can remain empty or incomplete after a failed call or write: do not treat it as a
successful booking, and retain the original request. Inspect the server before retrying.

- For a lost **book** response, repeat the exact request with the same key and
  `idempotencyKey`. A committed booking replays with `manageToken: null`; it cannot return
  the original secret again. Hosts can use `list` and booking IDs; invitees need their
  notification email's management link if the original response was lost. Use a new output
  filename for each attempt. A different request with the same key gets
  `idempotency_key_reused`.
- **Rescheduling is not idempotent.** Never retry automatically. Inspect `list` and
  `rescheduledToId` and `rescheduledFromId` first. The previous booking ID points to a cancelled booking. A
  booking-specific token stays there after an invitee move, but follows host moves;
  an email token always follows the chain and retrying it can move the meeting again.
- Cancellation cannot be undone. Repeating it returns `booking_cancelled`.

All local integration tests use synthetic identities, real HTTP and helper-owned temporary
PostgreSQL databases. They do not send mail, access a real calendar or configure hosted
ChatGPT/claude.ai connectors.

For an activated round-robin link `/team/Cobaltmere/intro`, use the same JSON shape:

```json
{
  "teamSlug": "Cobaltmere",
  "slug": "intro",
  "timeZone": "UTC",
  "startDate": "2026-11-02",
  "endDate": "2026-11-02"
}
```

Pass the returned start to `book` with a fresh random `idempotencyKey`; retry that same
input if the response is lost. Clients do not choose a pool host.

## Automatic Meet and original calendar copies

`list` returns only this key user's optional `calendarCopy` status. `retry-meeting` forwards
`retry_conference`; `retry-calendar-copy` forwards `retry_calendar_copy`. Both use
`{"bookingId":"<current-booking-uuid>"}` in `--input`, require current verified original-host
permissions, and never accept a replacement calendar, organizer or management token. Unknown
accepted imports are reconciled without a second blind POST. Unconfigured original copies
cannot be added by retry. Collective organizer selection is authenticated event-type configuration;
round-robin allocation uses the actual eligible winner and public `book` cannot select one.


Automatic single-host Zoom uses the existing `retry-meeting` command and MCP
`retry_conference` authority. Supply `{"bookingId":"<id>"}` through `--input`; an API key
may retry an already authorized booking for its current verified pinned organizer. Browser
consent is required to authorize Zoom permissions. Account selection uses REST with the
actual host's own `full` API key; the CLI has no account-selection tool. A claimed create
with no validated ID remains ambiguous: retry does not issue another POST or adopt a guessed
meeting. Inspect/remove any orphan in Zoom before replacing the booking. Personal and
individual single-host team events are supported; collective/round-robin automatic Zoom
requires a later per-host policy. See [Automatic Zoom for one host](/docs/automatic-zoom).

## Meeting location choices

Configure an ordered `locations` list through the event-type create/update operations,
and choose `locationOptionId` for slot availability and booking. An invitee-phone option additionally requires
`inviteePhone`, normalized to E.164 after removing common phone separators.
CLI `slots` and `book` accept `locationOptionId` in their JSON input files.
Rescheduling keeps the original choice. See [meeting location choices](https://hourmere.com/docs/location-choices)
for configuration examples, public discovery, compatibility and conference rules.

## Ask an invitee to choose another time

Hosts can send `POST /api/v1/bookings/{id}/request-reschedule` with
`{"idempotencyKey":"<random UUID>","note":"Could you choose another time?"}`.
The MCP equivalent is `request_reschedule` with `bookingId` and the same fields;
CLI users run `hourmere request-reschedule --input request.json`.
A `bookings` or `full` API key and existing host permission are required.
The optional plain-text note is limited to 2000 UTF-16 code units and appears only
in the email body. Retain the UUID and identical input for safe retries; use a new
UUID to replace the outstanding request.

The returned booking stays `confirmed`, with optional `pendingReschedule` containing
`id`, `expiresAt` and `note`. The original time stays booked and blocks availability
until the invitee uses their normal manage link to pick another time or cancel.
The request expires after 48 hours or when the original meeting starts, whichever
comes first. Expiry keeps that time and notifies the host. Imported and group-seat bookings
cannot receive a request. Picking uses the normal availability rules and reschedule
limit, calendar updates, conference handling and reminders.

When answering a request through REST or MCP, include `rescheduleRequestId` from
`pendingReschedule.id` with the managed pick or cancel input. This rejects stale
replaced requests and makes identical retries safe; a replayed pick returns the
same successor with `manageToken: null`. Without that field, existing ordinary
reschedule retry semantics remain unchanged.

## Configure booking limits

Use `hourmere create-event --input event-request.json` or
`hourmere update-event --input event-update.json` with a `full` API key. Put
`maxBookingsPerDay`, `maxBookingsPerWeek` and `maxBookingsPerMonth` in the JSON file;
updates include `id` alongside changed fields. `--input -` reads the same JSON from
stdin. Read the saved settings with `hourmere event --input event-query.json`, where
the query contains `id`.

Each ceiling is a whole number from 1 to 1000, or `null` for no ceiling. Omitted
update fields preserve the saved setting. Configured allowances must satisfy
day ≤ week ≤ month, comparing each pair that is set, including day/month without a
weekly limit. See [booking limits](/docs/booking-limits) for examples, host schedule
time zones, Monday-based weeks, calendar months and counting rules. Lowering a
ceiling does not cancel existing bookings.

## Record attendee no-shows

[Marking no-shows](/docs/no-shows) records private per-attendee attendance after the
scheduled start. Use REST `PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show`,
MCP `set_attendee_no_show`, or CLI `set-no-show` with `bookingId`, `attendeeId` and
`noShow`. API keys require `bookings` or `full` plus booked-host authority. API keys
of every scope and MCP OAuth can read or mark attendees only on bookings the caller
hosts in the current organization. Non-host team owners/admins need a browser session;
agent credentials receive `booking_not_found`, just as for a missing booking.
Invitee pages and messages are unchanged, including scheduled follow-ups.

## Booking waitlists

See [booking waitlists](/docs/booking-waitlist) for host settings, entry management,
invitee consent and verification, REST/MCP/CLI inputs, scopes, privacy and retention.
Nothing is reserved: every eligible invitee can be notified and the first successful
ordinary booking wins.
