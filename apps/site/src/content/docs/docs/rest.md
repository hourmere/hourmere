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
