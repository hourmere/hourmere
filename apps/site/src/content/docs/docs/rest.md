---
title: REST quickstart
description: Use an Hourmere API key to find a slot, book it and manage the booking.
---

## Prepare a host and key

Run your own [instance](/docs/self-hosting), sign in, and open **Event types** in your personal
space. The setup guide orders your profile (including display name), default availability,
first event type and booking link. Calendar connection is optional. After completing your
profile, you can confirm Monday–Friday 09:00–17:00 in its time zone directly in the guide;
adjust existing schedules in **Availability**. The guide hides when these basics are ready,
and the event list keeps the links to open and copy. For the examples below the booking
page is `/ada/intro`. Replace it with your own handle/slug.

For API setup, `POST /api/v1/schedules/default` with `{}` confirms those starter hours after
the stored profile and display name are set. It returns 201 for creation or 200 with the
unchanged existing default on retries, including concurrent submissions. It never overwrites
an existing schedule; schedules without a default require an explicit default choice
(`409 setup_default_schedule_required`). A missing profile or display name returns
`409 setup_profile_required`. An existing default still needs valid weekly hours before the
guide counts availability as complete.

API-key setup/configuration writes require `full` scope. The booking examples below work
with the recommended `bookings` scope after setup is complete.

Pass the current account interface language as `{ "language": "en" }` or
`{ "language": "zh-CN" }` to name a newly created schedule in that language. Omitting it
uses English. The profile still supplies the time zone; later language changes never
rename an existing schedule.

Open **API keys** at `/app/api-keys`, choose the intended organization and scope, create a key
and copy it once into your secret store. **Bookings** (`bookings`, the default) is recommended
for AI booking agents; **Read** (`read`) suits analytics/reporting and cannot mutate bookings.
**Full account access** (`full`) also permits account configuration changes; grant it only to
trusted software. Scope is immutable: create a replacement and revoke the old key to change
it. Legacy keys and API creations omitting `metadata.scope` retain `full`. See
[API keys](/docs/api-keys) for creation details and the generated operation table.
It acts as its creator in that organization. Keep API keys and
booking manage tokens out of URLs, shared transcripts and source control. Set these shell
variables privately (placeholders below are not working credentials):

```sh
export HOURMERE_URL='http://localhost:3000'
export HOURMERE_API_KEY='<your API key>'
```

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/me" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
```

Use `/api/v1/openapi.json` on your instance as the full request/response reference. Strict
request schemas reject unknown fields. Errors use `{ "error": "stable_code", "message": "…" }`.

## Instance capabilities

`GET /api/v1/instance` includes additive `ssoOidcEnabled` and `ssoSamlEnabled`
booleans. Both are currently `false`: organization SSO is unavailable, including on
self-hosted instances, and no environment setting enables it yet. Older servers may
omit these fields; clients should treat absence as unknown, keep SSO entry points hidden and
tolerate unknown response fields. No SSO operations are exposed in this release.

## Configure meeting lengths

Create an event type with `POST /api/v1/event-types` or edit it with
`PATCH /api/v1/event-types/{id}`. Set `durationMinutes` to the default and
`allowedDurationsMinutes` to the complete list of allowed lengths, kept in ascending order, for example
`{ "durationMinutes": 30, "allowedDurationsMinutes": [15, 30, 60] }`.
The list must contain 1–12 distinct whole-minute values from 1 to 1440 inclusive and include
the default. Supplied lengths are sorted before storage. Creation also requires `slug` and `title`; omitting the list creates
`[durationMinutes]`. These configuration writes require a `full` API key.

On a multi-length type, send both fields to change the default to a length outside the
saved list. Omitting the list on update preserves it, except that a duration-only edit
of a single-length type also replaces its sole allowed length. Invalid values return
`400 invalid_event_type`; malformed request shapes return `400 invalid_request`.
The [multiple meeting lengths guide](/docs/multiple-durations) covers the editor,
invitee choices, rescheduling and shared-rule limits.

## Configure an after-booking redirect

Event-type create/PATCH accepts `successRedirect`, and protected reads return the saved
configuration. Writes require `full` key scope. Omit the field to preserve it; send `null`
to clear it. See [after-booking redirects](/docs/after-booking#rest) for the complete object,
field errors, privacy warning and policy-change behavior.

## Configure reminders and follow-ups

See [Reminders and follow-ups](/docs/reminders-and-follow-ups) for editor steps, timing,
recipients and known limitations.

Use a `full` API key and an event-type ID from `GET /api/v1/event-types`. Protected event
reads include `notifications`. To replace only that setting:

```sh
curl --fail-with-body -X PUT "$HOURMERE_URL/api/v1/event-types/<event-type-id>/notifications" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"notifications":{"reminders":[{"id":"one-day","offsetMinutes":1440,"recipients":{"invitee":true,"guests":true,"host":true}}],"followUps":[{"id":"thanks","offsetMinutes":60,"recipients":{"invitee":true,"guests":false,"host":false},"hostNote":"Thank you for your time."}]}}'
```

The response is the full event type. Creation and PATCH also accept optional
`notifications`; omission keeps creation defaults or the saved value respectively. A
replacement must include both arrays. Personal types require their owner and team types
an owner or admin; `bookings` and `read` keys cannot write these settings. Saves affect
only new bookings and send no immediate mail. Read the
[complete validation contract](/docs/api-conventions#event-type-notification-settings)
and [host-note operating policy](/docs/notifications#host-notes-and-hosted-email-abuse-controls)
before enabling follow-ups or host-written text.

## Create one-time links

Use `POST /api/v1/event-types/{eventTypeId}/one-time-links` with optional `expiresAt`
and `prefill`, then save the creation response's URL privately. It is shown once.
List safe metadata with GET on the same path; revoke with DELETE on its `/{id}` path.
Create and revoke require `bookings` or `full`, while list/get allow `read` and `full`.
An exact `Idempotency-Key` retry never creates a second link and returns
`409 one_time_link_already_created` because the URL cannot be recovered.
See [one-time booking links](/docs/one-time-links) for examples, permissions and limits.

## Generate an email snippet

`POST /api/v1/open-time-snippets` accepts exactly one of `eventTypeId` or `slug`,
required `from`/`to` instants (at most 31 elapsed days), and optional `count` (1–10, default 3),
`locale`, `displayTimeZone` and `durationMinutes`. It returns chosen `slots` with direct
links plus `text` and `html`. Personal owners and team owners/admins can use `read`,
`bookings` or `full` keys when `SLOT_SNIPPETS_ENABLED` is enabled. It reserves nothing.
See [the agent guide](/docs/open-time-snippets) for a complete curl example, response
fields, date boundaries and taken-time fallback.

## Find a time

Choose a future UTC range within the event type's booking window, at most 62 days.
The public slots endpoint returns UTC instants:

```sh
curl --fail-with-body --get "$HOURMERE_URL/api/v1/public/ada/intro/slots" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  --data-urlencode 'start=2026-11-02T00:00:00Z' \
  --data-urlencode 'end=2026-11-04T00:00:00Z'
```

Adjust these example dates so they remain in the future. Take the desired returned slot's
`start` unchanged. For local date/time-zone queries, the MCP `find_available_slots` tool
performs that conversion. A selected Google calendar with missing, failed or stale sync yields
`calendar_sync_unavailable`; fix or deliberately disable that calendar instead of assuming
unknown busy data is free.

An event type with several lengths includes `allowedDurationsMinutes` in its public event
details. Add `durationMinutes=<allowed length>` to the slots query and the same numeric
`durationMinutes` to the booking JSON to select that length. Omission uses the event type's
default `durationMinutes`; a length outside the allowed list returns `400 invalid_duration`.
The personal and `/api/v1/public/teams/{handle}/{slug}` endpoints share this contract.

## Create and manage one booking

For reporting, [export bookings as CSV](/docs/booking-export) using
`GET /api/v1/bookings/export.csv`. A `read` or `full` key and a bounded date range are
required for personal exports. Team exports require a verified browser session and current
owner/admin membership, and use the limited team-admin field set. Team API keys and OAuth
credentials cannot export team data.

Bookings send email to the host/invitee when workers are enabled. Additional guests require
the host to enable `allowGuests` on the event type (off by default, at most ten). Otherwise
nonempty `guests` return `400 guests_not_allowed`. Existing guests keep receiving updates
and cancellations after the host disables new guests. Use
an address you control for a test. Use a new idempotency key per intended booking and keep
the same body/key for retries:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/public/ada/intro/bookings" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <new random UUID>' \
  -d '{"start":"<chosen slot start>","invitee":{"name":"Test Invitee","email":"<your test address>","timeZone":"America/Los_Angeles"}}'
```

Set optional `invitee.locale` to a BCP 47 tag such as `zh-CN` for notification language.
Supported tags use the [shared locale registry](/docs/interface-languages); unsupported
languages and missing translations fall back to English. MCP and CLI accept the same field.
The saved language survives retries, reschedules and cancellation, independently of `timeZone`.

Save the returned `manageToken` privately. Only its hash is stored; it is returned once. A
same-key retry returns HTTP 200 (rather than 201) with the original booking and
`manageToken: null`. Reusing the key with different arguments fails with `idempotency_key_reused`; use a new key for a genuinely new booking.

The public booking and invitee management endpoints do not require an API key; when one is
supplied, it must be valid and allow the operation, in addition to the independent manage
token where required. Invalid keys get 401 and disallowed scopes get `403 insufficient_scope`,
without falling back to anonymous access or a session cookie. A credential-free public
request retains its existing capabilities. The examples include a key for consistency with
the authenticated calls above. A public create request's
idempotency key uses the shared anonymous namespace for that organization, so make it random.
For invitee management send the manage token in a header. Choose a new
available slot for rescheduling; it returns a replacement booking and a new manage token:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/bookings/manage/reschedule" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H "X-Manage-Token: $HOURMERE_MANAGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"start":"<new slot start>"}'
```

Use the new token for subsequent operations. Cancelling with the current token:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/bookings/manage/cancel" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H "X-Manage-Token: $HOURMERE_MANAGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Test cleanup"}'
```

An API response token stays with the cancelled booking after an invitee move and follows
host moves. The token in a booking email always follows the reschedule chain. Treat both as credentials. The public management page carries email tokens
in a fragment (`/booking#token=…`); API calls use headers, never query parameters. Set `HOURMERE_MANAGE_TOKEN` privately to the
current returned token before running either management example.

`GET /api/v1/bookings/manage/slots?start=…&end=…` uses the booking's original length,
including after the host changes the event default or removes that length. An optional
`durationMinutes` query parameter selects a current allowed length instead; send the same
number in the reschedule JSON. Omitting it from reschedule preserves the original length.
The response's `start` and `end` always describe the actual booked interval.

List the key owner's hosted bookings with `GET /api/v1/bookings`. A key does not grant access
to arbitrary hosts' private bookings. Results default to ascending start time and ID; request
`order=desc` for newest first. Pass `nextCursor` as `cursor` and keep the time filters and
order unchanged for every page. Rate limits return `429` and `Retry-After`; slot races
return `slot_taken` or `slot_unavailable`. Recheck availability before retrying with a new key.

Team owners/admins can use `GET /api/v1/team/bookings` with a verified browser session in
the current team. It includes bookings hosted by other members and returns only the team
administration fields: ID, status, times, cancellation time, event ID/title, saved host
IDs/names and attendee contact/time-zone/booker fields. API keys, personal organizations
and ordinary members receive `403 team_management_access_denied`. The endpoint uses the
same time/status filters and opaque cursor pagination as the host list; keep filters and
order unchanged between pages. Collective bookings appear once. No answers, private
management links, calendar copies or conference links are returned.

To move a booking you host, read `GET /api/v1/bookings/{id}/slots?start=…&end=…`, then
send `POST /api/v1/bookings/{id}/reschedule` with JSON `{ "start": "<chosen slot start>" }`.
Both require a session or API key in the booking's organization. Slots ignore the current
booking, so the new time may overlap it. A host move returns the successor booking with
`manageToken: null` and preserves existing invitee links. The web booking detail page uses
these same public APIs. Do not retry a move automatically; inspect your booking list if
the answer is lost.

Host slot queries and reschedule JSON accept the same optional `durationMinutes`, with
the same original-length default and current-allowed-list validation as invitee moves.

Team owners/admins can also read `GET /api/v1/team/invitations` using a verified browser
session in the current team. It returns paginated invitation lifecycle and safe current
delivery state, attempts, fixed error classification and current resend eligibility.
Expiry uses the database clock. API keys and OAuth are denied, including alongside a
session cookie. See the [field, pagination and error contract](/docs/api-conventions#team-invitation-delivery-summaries).

## Search the booking list

`status=cancelled` lists only cancelled bookings, a page at a time like every other view.
It includes bookings replaced by a reschedule; their `rescheduledToId` points to the new
booking. `status=confirmed` lists the others.

`q` searches the list you already have access to. A booking matches when the invitee's name
or email, or the title of its event type, contains the text, ignoring case:

```sh
curl --fail-with-body -G "$HOURMERE_URL/api/v1/bookings" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  --data-urlencode "status=cancelled" --data-urlencode "q=ada@example.com"
```

- The text is trimmed and may have at most 100 characters; longer text or control
  characters return `400 invalid_request`. Blank text means no search.
- `%`, `_` and `\` match themselves; there are no wildcards.
- Search only narrows: it never adds bookings you do not host, bookings from another
  organization or, on the team list, bookings from another team. The team list
  (`GET /api/v1/team/bookings`) accepts the same `status` and `q`.
- Keep `q`, `status`, the time filters and `order` unchanged while following `nextCursor`.
  Ordering stays by start time and ID, so pages do not repeat or skip bookings when new
  bookings are added or cancelled meanwhile.

Known limitations: search matches the invitee who booked, not guests; the current title
of an event type that still exists, not stored booking titles, answers or notes; and whole
substrings, without typo tolerance or accent folding. Letter case is ignored according to
the database's locale. CSV export does not take `q`, so the web app offers the export only
when no search is applied.

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
reschedule retry semantics remain unchanged. An answer to a request that expired, was
replaced or was already resolved by a move fails with `reschedule_request_changed`, as
does a pick after cancellation. With the request email's token, REST
`GET /api/v1/bookings/manage` reports what happened in `rescheduleRequest`; MCP and CLI
have no invitee read of a manage token.

## Configure booking limits

Event-type creation and updates accept `maxBookingsPerDay`, `maxBookingsPerWeek` and
`maxBookingsPerMonth`: whole numbers from 1 to 1000, or `null` for no ceiling.
Omitted update fields preserve the saved setting. Configured allowances must satisfy
day ≤ week ≤ month, comparing each pair that is set, including day/month without a
weekly limit. Event-type reads return all three settings. API keys need `full` scope
for configuration writes. See [booking limits](/docs/booking-limits) for REST, MCP and
CLI examples, host schedule time zones, Monday-based weeks, calendar months and
counting rules. Lowering a ceiling does not cancel existing bookings.

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
