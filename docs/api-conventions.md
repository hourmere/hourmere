# API conventions

Rules for the product API under `/api/v1`. Agents depend on it for years, so changes are
additive within a version. The OpenAPI document is served at `/api/v1/openapi.json`.

## Versioning

- Product endpoints live under `/api/v1`. A breaking change means `/api/v2`, not an edit.
- Within a version, only additive changes: new endpoints, new optional request fields,
  new response fields. Clients must ignore fields they do not know.
- `/api/health` is operational and unversioned.
- `/api/auth/*` is [Better Auth](https://www.better-auth.com)'s own protocol (sign-in,
  sessions, organizations, API keys). It follows Better Auth's conventions, including its
  error shape (`{ "message", "code" }`), not the ones below.

## JSON

- Field names are camelCase (`apiKeyId`, `startAt`), matching the TypeScript and zod
  schemas and Better Auth. Enum values are lowercase snake_case (`api_key`, `round_robin`).
- IDs are UUID strings.
- Timestamps are RFC 3339 strings in UTC with a `Z` suffix, e.g. `2026-10-15T09:30:00.000Z`.
  Requests may use any offset and up to nine fractional digits (more is 400
  `invalid_request`); instants are stored and compared with microsecond precision (Postgres
  rounds beyond). Calendar dates are `YYYY-MM-DD`; wall-clock times are `HH:MM` with an IANA
  time zone alongside.
- Every `/api/v1` response, errors included, is sent with `Cache-Control: no-store` (it may
  hold private data, and a cached error could hide a later answer), unless its route sets a
  `Cache-Control` of its own.

## Errors

Every error response has the same shape:

```json
{ "error": "unauthorized", "message": "optional human-readable detail" }
```

`error` is a stable, machine-readable snake_case code that clients may branch on; `message`
is optional and may change. The HTTP status carries the category and the code names the
specific case, e.g. 404 `event_type_not_found`, 409 `slot_taken`. These codes are reserved
for the generic cases in the table below (services cannot use them): `invalid_request`,
`unauthorized`, `forbidden`, `not_found` (unknown endpoint), `method_not_allowed`,
`payload_too_large`, `unsupported_media_type`, `rate_limited`, `internal_error`. Codes are never
renamed within `/api/v1`.

| Status | Meaning |
|---|---|
| 400 `invalid_request` | The request is malformed (e.g. invalid JSON) or fails schema validation; `message` names the offending fields. Service-level validation uses specific codes |
| 401 `unauthorized` | No valid credentials: missing, unknown, expired or revoked session or API key. Sent with `WWW-Authenticate: Bearer` |
| 403 `forbidden` | Valid credentials, but the caller may not do this (e.g. not a member of the organization, or a role that lacks the permission) |
| 404 `not_found` | No such resource or endpoint, or one the caller cannot see |
| 409 | Conflict with the current state (e.g. the slot was just booked) |
| 405 `method_not_allowed`, 413 `payload_too_large`, 415 `unsupported_media_type` | Raised by the HTTP layer for the obvious cases; any other 4xx from it is `invalid_request` |
| 429 `rate_limited` | Too many requests; `Retry-After` gives the seconds to wait when known |
| 500 `internal_error` | An unexpected server error; details go to the server log only |

`message` is written for people and is safe to show: it never contains internal error text.

### Where errors come from

Routes call the service layer (`@hourmere/scheduling`), shared with the MCP server so that
people and agents get the same behavior. Services throw `DomainError(kind, code, message?)`
for failures the caller can act on; the server maps the kind to a status and answers
`{ "error": code }` (plus `message` when given):

| `DomainError` kind | Status |
|---|---|
| `invalid` | 400 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |

Anything else a service throws is a bug: 500 `internal_error`, logged on one escaped line.
A lower-level error wrapped as a DomainError's `cause` is logged the same way and never sent
to the client.
New route groups are `RouteModule`s (`apps/server/src/openapi.ts`) created in `server.ts` with
their services and registered by `createApp`; `apps/server/src/app.test.ts` has a template.

## Authentication

A request is authenticated by one of:

- **API key** (agents, scripts): `Authorization: Bearer hm_…`. Keys belong to a user and act
  in one organization, chosen when the key is created (the user's personal organization by
  default). If the Authorization header is present it alone decides: a bad key is a 401
  even when a session cookie is also sent.
- **Session cookie** (the web app, same origin): set by signing in through `/api/auth/*`.
  Requests act in the session's active organization. Cookie-authenticated requests other
  than GET, HEAD and OPTIONS must come from the app's own `Origin` (CSRF protection), or they
  get a 403: Better Auth checks this for `/api/auth/*`, the shared `requireCaller` middleware
  for `/api/v1`. API key requests are exempt.

`GET /api/v1/instance` needs no credentials: it tells clients what the instance offers before
anyone signs in, such as which sign-in methods are enabled (`signIn.google`, …).

`GET /api/v1/me` returns the caller, the organization they act in and whether they used a
session or an API key. The MCP server at `/mcp` ([mcp.md](mcp.md)) takes API keys only, never
session cookies, and answers with the same error codes.

## Validation

Input is checked in two layers:

- **Shape** (the route's zod schema): JSON syntax, types and required fields. Request objects
  are strict: an unknown field (often a misspelling) is refused, not ignored. A route may also
  pre-check simple formats and lengths. Failures are 400 `invalid_request`, with `message`
  naming the fields.
- **Values and meaning** (the service, shared with the MCP server): the service validates
  every value it relies on, formats, lengths and ranges as well as anything that needs the
  database or domain rules, e.g. that a time zone exists, that answers fit the event type's
  questions, or that a slot is still free. Failures use specific codes (400 `invalid_slug`,
  `invalid_questions`, `invalid_responses`, 409 `slot_taken`, …). Services never rely on a
  route having checked something.

MCP tools reuse the routes' zod schemas, so the same input fails the same way over REST and
MCP. The OpenAPI document still describes limits (`maxLength`, `pattern`, `minimum`, …) as
metadata where only the service enforces them.

Free text (names, emails, answers, reasons, question labels and options, schedule names, event
type titles and descriptions, location addresses and links) must be well-formed Unicode
without control characters: no NUL, C0 or C1 controls, DEL, U+2028 or U+2029; only multi-line
fields (long answers, reasons, event type descriptions) may contain tabs and line breaks.
Services refuse anything else with the field's code (`invalid_invitee`, `invalid_guests`,
`invalid_responses`, `invalid_reason`, `invalid_questions`, `invalid_schedule`,
`invalid_event_type`, `invalid_location`), using the helpers in
`packages/scheduling/src/text.ts`.
As a safety net for every `/api/v1` route, a JSON body with NUL or a lone surrogate anywhere
(values or keys) is refused with 400 `invalid_request` when the route reads it, before the
route can use it.

Request bodies are limited to 64 KB on all of `/api`, sign-in included, unless a route
declares more (`routeBodyLimit` in `apps/server/src/body-limit.ts`); beyond the limit, 413
`payload_too_large`. A `Content-Length` over the limit is refused at once; any other body
(e.g. sent chunked) is counted while the route reads it, which also stops a body longer than
its `Content-Length`. Nothing reads the body before the route needs it: rate limits and
authentication refuse a client (429, 401) without reading what it sends. Because the size
and text checks decide while the body is read, a route reads (and validates) its body before
doing anything with side effects, and never swallows a failed read. Limits count the bytes as
sent: request bodies are never decompressed (`Content-Encoding` is not supported). A route's
limit must be at least its largest legal request with every string at its maximum length and
every character escaped as `\uXXXX` (6 bytes, as e.g. Python's `json.dumps` sends by
default). Creating a booking allows 2 MB: its largest legal request (20 multi-select answers
choosing all 50 options of 200 characters, plus the invitee and 10 guests) is about 1.23 MB
that way. Cancel and reschedule bodies stay far below 64 KB (a reason is at most 1000
characters). Creating or changing an event type allows 2 MB (20 questions with 50 options of
200 characters come to about 1.29 MB), as do creating or changing a schedule (a day can hold
1440 one-minute intervals: about 1.23 MB for a week); setting one date's override allows
256 KB (about 176 KB for 1440 intervals).

## Lists

A list response is `{ "data": [ … ] }`. Lists that can grow without bound use cursor
pagination and add `nextCursor`: pass it as `cursor` (with the same filters) for the next page;
it is null on the last page. Cursors are opaque; `limit` sets the page size (1–100, default
50). Small lists return everything and have no `nextCursor`.

## Public endpoints

Booking pages and invitee links work without credentials. The web app serves them at the
root, `/{handle}` and `/{handle}/{slug}`, and the invitee's page at `/booking`:

- `/api/v1/public/{handle}`: the host's page, their name and bookable personal event types in
  the order they arranged them (404 `host_not_found`).
- `/api/v1/public/{handle}/{slug}` (event page, `/slots`, `/bookings`) for personal event types.
- `/api/v1/bookings/manage` (`GET` shows the booking with its event type and hosts' names,
  `GET …/slots` the times it can move to, `POST …/cancel`, `POST …/reschedule`)
  with the invitee's secret in the `X-Manage-Token` header. Invitee links carry it in the URL
  fragment, `https://<app>/booking#token=<token>`, which browsers never send to servers or in
  `Referer`; the web app reads it and sends the header. A missing, malformed or unknown token
  gets the same 404 `booking_not_found`. Only the token's SHA-256 is stored, so it is returned
  once, when the booking is made (and with the new booking after a reschedule).
  `…/slots` ignores the booking itself, as rescheduling does, so it offers times that overlap
  the current one; a booking that cannot move answers 409 as a reschedule would
  (`booking_cancelled`, `booking_in_past`, `event_type_unavailable`).

They are rate limited per client (`TRUSTED_PROXIES` decides which address that is; IPv6
clients count per /64 network, since one subscriber usually has a whole /64): 120 requests a
minute for host and event pages and for slots (the manage link's slots included), 10 for
creating bookings, 30 for the other manage endpoints;
beyond that 429 `rate_limited` with `Retry-After`, decided before the request body is read
(only a `Content-Length` over the body limit is refused first). The counters live in each server process's memory, so with several instances a client gets that budget once per instance; a shared store
comes with multi-instance deployments.

A slots request may span at most 62 days, and its bookable part (from now plus the event
type's minimum notice to the end of its booking window) at most 20 000 possible start times at
the event type's slot step: about 13 days with 1-minute steps, any 62 days with 30-minute
steps. Beyond either, 400 `range_too_long`; a range with no bookable part returns no slots.

### Reserved handles

Because booking pages share the root with the web app, the API and static files, some names
can never be a handle: every top-level path the app or the server answers (`app`, `api`,
`assets`, `booking`, `sign-in`, `event-types`, `favicon.ico`, …) and pages people expect from
the product itself (`support`, `security`, `pricing`, `status`, …). The list is
`RESERVED_NAMES` in `packages/core/src/reserved.ts`, compared case-insensitively. Setting one
as a handle (`PUT /api/v1/profile`) is refused with 400 `handle_reserved`, and personal
organization slugs never take one (`Admin` becomes `admin-user`). A handle stored before its
name was reserved is not served: its host page, event pages, slots and bookings answer 404 as
if it did not exist (agents' MCP tools too), so nobody keeps a page at a path the app now
uses. Its owner keeps the profile, and must pick a new handle the next time they save it.
Existing bookings stay reachable through their manage links, which do not involve the handle.

## Retries

`POST /api/v1/public/{handle}/{slug}/bookings` accepts an `Idempotency-Key` header (1–255
printable ASCII characters). A retry with the same key and the same request returns the
original booking with 200 instead of booking again; its `manageToken` is null, because the
secret is not stored and cannot be returned twice. The same key with a different request is
refused with 409 `idempotency_key_reused`. Keys are scoped to the organization and the
caller's API key, and all anonymous callers share one scope, so they must be random (e.g. a
UUIDv4), never derived from the request.

Rescheduling is not idempotent: it cancels the booking and creates a new one with a new
manage token, so retrying it after a lost response gets 409 `booking_cancelled`. Booking
emails (coming later) will carry the new link, so the invitee does not lose it.
