---
title: API conventions
description: Versioning, authentication, validation, errors and booking semantics for the REST API.
---

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
- `/api/calendar/google/callback` is the separate calendar OAuth protocol callback. The
  owner-side connection API is versioned under `/api/v1/calendar-connections`; see
  [Google Calendar connections](/docs/google-calendar).
- `/api/conference/zoom/callback` is the separate conference OAuth callback.
  `POST /api/conference/zoom/events` is Zoom's signed webhook protocol, enabled only by
  `ZOOM_WEBHOOK_SECRET_TOKEN`, independently of OAuth or automatic meeting configuration.
  It authenticates the exact body bytes with `x-zm-signature` HMAC-SHA256 and requires
  `x-zm-request-timestamp` within five minutes of the server clock. Its limit is 16 KiB
  and 120 requests per minute per client per process (503 with `Retry-After` on exhaustion,
  so Zoom can retry; configure `TRUSTED_PROXIES` behind a reverse proxy). It answers `endpoint.url_validation`
  with `plainToken` and its HMAC `encryptedToken`, and handles `app_deauthorized` by
  removing the matching Zoom user's local connection credentials and identity metadata.
  Unknown users, events older than the current OAuth authorization and repeated events
  return 200 without creating records. `deauthorization_time` is required; when
  `ZOOM_CLIENT_ID` is configured, missing/different payload client IDs are ignored. It requires no
  browser session or API key; invalid signatures/timestamps return 401. See
  [automatic Zoom](/docs/automatic-zoom#app-removal-and-event-endpoint) for operator setup.

Magic-link verification failures default to `/sign-in?error=CODE`, where the app explains
the failure and offers a new link. An explicit `errorCallbackURL` still applies (subject
to Better Auth's trusted-origin check); the successful `callbackURL` is unchanged.

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

An optional `errorAlias` provides an additive, preferred code without renaming `error`.
The OpenAPI `ErrorAlias` schema lists the documented alias code set, generated from the
same registry as the server's response mapping. That set may grow within `/api/v1`.
Clients may prefer a recognized alias and must fall back to `error` when the alias is
absent or unknown, including when talking to older servers. Deprecating an error code
does not schedule its removal from v1: its original `error` value remains for **all of
`/api/v1`**. Renaming or removing it requires a new API version.

| `errorAlias` | Preserved `error` | Meaning |
|---|---|---|
| `zoom_operation_busy` | `zoom_refresh_in_progress` (deprecated) | HTTP 409: another token operation for the same Hourmere owner is in progress, possibly for a different Zoom identity. It does not mean the selected connection is refreshing; retry shortly. |

See [Zoom connections](/docs/zoom-connections) for callback replay and recovery semantics.

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
New route groups are `RouteModule`s ([`apps/server/src/openapi.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/openapi.ts)) created in [`server.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/server.ts) with
their services and registered by `createApp`; [`apps/server/src/app.test.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/app.test.ts) has a template.

## Authentication

The unused Better Auth endpoints `/api/auth/account-info`, `/api/auth/get-access-token`,
`/api/auth/refresh-token`, `/api/auth/link-social` and `/api/auth/list-accounts` are disabled
with `disabledPaths`: they return HTTP 404 with the body `Not Found`, including for signed-in
sessions, whether MCP OAuth is enabled or disabled. Social sign-in still uses
`/api/auth/sign-in/social` and its callbacks. Calendar and conference connections use their
own OAuth flows and encrypted credentials, separate from Better Auth's sign-in accounts.
MCP OAuth uses `/api/auth/oauth2/*`; its existing consent-management restrictions still apply.

Social authorization accepts only `provider`, `callbackURL`, `errorCallbackURL`,
`newUserCallbackURL` and `disableRedirect`. Any other body field (including `scopes`,
`additionalParams`, `loginHint` and direct `idToken`) or any query field returns 400
`UNSUPPORTED_SOCIAL_AUTHORIZATION_PARAMETERS`, without echoing caller values. This before
hook applies to both Google and Microsoft and also protects `/link-social` if it is enabled
in future. Trusted server-side `auth.api.*` calls retain direct ID-token authentication;
they cannot override authorization parameters. No other installed provider authorization
entrance is enabled: the callback's IdP-initiated branch is unavailable for these providers,
and the generic OAuth and OAuth popup plugins are not installed.

HTTP social authorization requires an `Origin` equal to `PUBLIC_URL`'s origin, even without
cookies. Missing/null origins return 403 `MISSING_OR_NULL_ORIGIN`; other origins return 403
`INVALID_ORIGIN`. The web app's same-origin POST fetch supplies this automatically.
Nonbrowser HTTP clients must send the same Origin. This intentionally tightens Better Auth
1.7.10's default, which skips its origin check when a request has no cookie. Provider
callbacks and trusted server-side calls do not acquire this Origin requirement.

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
`hostedSignupUrl` is the public destination for attribution and confirmation links, configured
with `HOSTED_SIGNUP_URL` and defaulting to `https://hourmere.com`.
Optional `privacyPolicyUrl` and `termsUrl` are this instance operator's legal-page URLs,
configured with `PRIVACY_POLICY_URL` and `TERMS_URL`. Each field is omitted when unset or
empty, including on self-hosted instances; clients hide the corresponding link.

`GET /api/v1/me` returns the caller, the organization they act in and whether they used a
session or an API key. The MCP server at `/mcp` ([MCP quickstart](/docs/mcp)) accepts API keys and,
when enabled, MCP OAuth grants. Session cookies never authenticate MCP. OAuth grants are
limited to MCP tools and do not authenticate REST requests.

### Browser organization context

Better Auth's `/api/auth/organization/*` endpoints require browser sessions. Any
Authorization header, including an empty or invalid value, returns `403 SESSION_REQUIRED`
even alongside a valid owner/admin cookie. API keys and MCP OAuth tokens cannot inherit
the browser's organization-management privileges.

Organization-scoped browser drafts bind `X-Expected-Organization-Id` to the organization
where the form or action started. Do not replace that value with the active organization
at submission time. A header works with both the strict REST JSON bodies and Better Auth's
separate protocol, without adding fields to either body.

The existing covered endpoints are:

| Write | Endpoint |
|---|---|
| Create a personal or team event type | `POST /api/v1/event-types` |
| Edit, enable or disable a personal or team event type | `PATCH /api/v1/event-types/{id}` |
| Delete a personal or team event type | `DELETE /api/v1/event-types/{id}` |
| Activate a round-robin team event type | `POST /api/v1/event-types/{id}/round-robin/activate` |
| Cancel a current-team booking as an administrator | `POST /api/v1/team/bookings/{id}/cancel` |
| Invite or resend an invitation | `POST /api/auth/organization/invite-member` |
| Revoke an invitation | `POST /api/auth/organization/cancel-invitation` |
| Change a member's role | `POST /api/auth/organization/update-member-role` |
| Remove a member | `POST /api/auth/organization/remove-member` |
| Leave a team | `POST /api/auth/organization/leave` |
| Leave a team safely after resolving impact | `POST /api/v1/teams/{teamId}/leave` |
| Change team settings, including name or slug | `POST /api/auth/organization/update` |

For the session writes above, the expected organization must match both the operation's
target organization and the current valid session organization. Missing or mismatched
context returns HTTP 409: `organization_context_changed` under `/api/v1`, or
`ORGANIZATION_CONTEXT_CHANGED` under `/api/auth`. The message asks the person to reload.
Inaccessible and missing event-type targets receive the same context refusal on bound
browser writes, so the error cannot reveal another team's objects. The expected ID grants
no access: current membership, verification and role checks still apply. Every session
event-type write requires the header, including personal forms. This prevents an old form
without context from becoming a personal creation after switching or losing team membership,
and prevents a switch into a team from retargeting an unsaved personal draft.
Organization writes and context transitions in the same browser session are ordered across
server processes, so a switch cannot overtake an already checked organization write.

The web booking detail also binds cancellation, rescheduling, conference reconciliation
and calendar-copy retries to its opening organization with this header. These four
booking-ID endpoints validate a supplied expectation against the live session,
membership and booking organization inside the write transaction, ordered with session
organization transitions. They retain ordinary host/organizer permissions; the header
grants no administrative access. For compatibility, callers that omit the header keep
the existing booking-ID authorization. API keys and OAuth grants keep their issued context.

On refusal, keep the draft, show reload guidance and ask before discarding unsaved changes.
Never replay the write or switch organizations automatically. Focus/visibility refresh
uses the same unsaved-changes prompt before replacing an organization's drafts. Declining
keeps the old context and draft; accepting remounts the page. Explicit conflict reload
discards older background session answers before reloading. The server check also protects
requests that arrive before a refresh.

Team creation, explicit switching and invitation acceptance bind their explicit targets
under their existing rules rather than requiring the previous active organization. Automatic
activation after team creation additionally sends the opening organization as its expected
**source** context. Better Auth checks that source under the existing session transition
lock before activating the explicit target; a conflict keeps the created team and draft
available for recovery. Deliberate switches without this optional header retain their
existing target-bound behavior. Personal
profile, calendar and schedule writes, API-key management and OAuth connection management
are excluded. API keys retain their issued organization, and OAuth grants retain their
consented organization; neither depends on this browser header. Public booking and private
manage-token operations retain their existing authority. Team deletion is unavailable
through the browser organization endpoint. Team-administrator booking cancellation uses
the same context protection; the existing host booking-ID routes still require the caller
to be a host.

### Team roles

Team invitations default to `member`; owners and admins may invite only that role,
including when resending. Historical invitations with an elevated or custom stored role
cannot be resent or accepted. Revoke them and issue a new member invitation instead.
Acceptance still requires the exact invited, verified email and does not depend on the
session's active organization. Registration continues to follow the instance's signup policy.

Only a current verified team owner may change a non-owner's role between `admin` and
`member`. Admins cannot change roles, including their own. Assigning `owner`, changing an
existing owner's role and custom role assignments are unavailable. Existing teams with
multiple owners retain their memberships and management access. Stored comma-separated
roles are checked as exact role tokens.

These rules apply to direct Better Auth requests as well as the web app. Policy denials
use HTTP 403 `TEAM_MANAGEMENT_ACCESS_DENIED` in Better Auth's error shape; missing and
inaccessible role targets receive the same denial. Browser context mismatches retain the
409 response above. The server-only Better Auth add-member operation is not an HTTP
onboarding path; joining a team requires accepting a member invitation.

### Member departure preview

`GET /api/v1/team/members/{memberUserId}/departure-impact?teamId={teamId}` lists the
team event types and confirmed, not-yet-ended bookings affected by a member leaving.
It requires a current verified browser session in that team. Members can inspect themselves;
owners and admins can inspect current members of their team. Inaccessible and missing targets
receive the same `403 team_management_access_denied`. Missing or invalid sessions and any
Authorization header, even alongside a valid cookie, receive that same denial without a
`WWW-Authenticate` challenge. Personal data and other teams are excluded.

The response contains `evaluatedAt`, `eventTypes` and `bookings`; each collection has `data`,
`nextCursor` and `totalCount`. Independent `eventTypesLimit` and `bookingsLimit` accept 1–100
(default 50); follow the corresponding cursor as `eventTypesCursor` or `bookingsCursor`.
Counts cover all matches, independently of pagination. Results are recalculated on every
request. Event types give a host-dependency reason; booking fields use the team administrator
whitelist plus `inProgress` and `handling`.

Bookings with `start <= evaluatedAt < end` remain in the list and require waiting until
they end or coordinating offline (`wait_until_end_or_coordinate_offline`). Future bookings
use `coordinate_cancellation`, subject to separate authorization and existing cancellation
time rules. This read neither cancels bookings nor authorizes leaving or removing a member.
See the [full response and pagination contract](https://github.com/hourmere/hourmere/blob/main/docs/member-departure-impact.md).

### Safe team departure

`POST /api/v1/teams/{teamId}/leave` requires a verified browser session, an empty JSON object
and `X-Expected-Organization-Id` bound to the team where the action started. Missing or
invalid sessions and any Authorization header return `403 team_management_access_denied`
without a `WWW-Authenticate` challenge, even alongside a valid cookie. Authorization
headers are rejected before credential resolution. Stale context returns
`409 organization_context_changed`; reload before retrying.

An owner needs another current owner before leaving. The locked refusal is
`409 member_departure_owner_required`, with the message "Another owner is needed before
you can leave." and `handling.owner: another_owner_is_needed_before_you_can_leave`.
The owner check and the event/booking impact recheck share the membership transaction's
organization write lock. Two owners leaving concurrently cannot both succeed.
Unresolved impact returns `409 member_departure_blocked` with bounded `impact` pages and
handling steps. Success revokes membership and returns the personal `organizationId`.
See the [full safe departure contract](https://github.com/hourmere/hourmere/blob/main/docs/member-leave.md).

### Integration settings

The user's own API keys have the same non-credential settings access as browser sessions:
list calendar connections/status, refresh their calendar list, choose conflict calendars,
set/clear the writeback destination and sync a selected calendar now. They may also list
their Zoom connections and select their own meeting-mode connection for automatic Zoom
on personal or single-host team event types they actually host. Connections belong to the
user across organizations; event-type writes still require the acting organization's
permissions and the actual host's identity. Another administrator cannot select a host's
private connection. IDs do not grant access to another user's connections.

Calendar settings, calendar refresh/sync and private Zoom configuration writes recheck the
API key inside the write transaction, after locking its owner. The key must still exist,
be enabled and unexpired, and belong to the same user and acting organization. Revocation
before that check returns the same `401 unauthorized` and `WWW-Authenticate: Bearer` as a
key rejected at request authentication, without changing settings or contacting a provider.

OAuth authorization, code exchange and disconnect require a live browser session.
Explicit Zoom credential refresh also remains session-only. Calendar list refresh and sync
may internally refresh existing access tokens without exposing them or granting new scopes.
Cookie-authenticated writes retain the same-origin requirement; API keys use bearer
authentication. Read-only MCP `list_calendar_connections` and `list_conference_connections`
reuse the REST services with the same ownership checks, including for MCP OAuth grants.
Settings mutations use REST with an API key; MCP OAuth grants remain limited to MCP tools.

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
[`packages/scheduling/src/text.ts`](https://github.com/hourmere/hourmere/blob/main/packages/scheduling/src/text.ts).
As a safety net for every `/api/v1` route, a JSON body with NUL or a lone surrogate anywhere
(values or keys) is refused with 400 `invalid_request` when the route reads it, before the
route can use it.

Request bodies are limited to 64 KB on all of `/api`, sign-in included, unless a route
declares a different limit (`routeBodyLimit` in [`apps/server/src/body-limit.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/body-limit.ts)); beyond the limit, 413
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

### Display names

Account display names are updated with `PATCH /api/v1/profile/name` and a strict
`{ "name": "Ada Lovelace" }` body (4096-byte maximum). The shared service trims and validates
1–200 UTF-16 code units of well-formed single-line text, returning `invalid_display_name`
on invalid values. The result is `{ "name": "Ada Lovelace" }`. This affects only the caller,
works before profile onboarding and across acting organizations, and accepts the same
session/API-key authentication as profile updates. The legacy Better Auth update-user guard
remains enforced so that endpoint cannot bypass the text rules.

Account creation through magic links, Google and Microsoft applies the same text bounds by
sanitizing rather than rejecting provider names: repair malformed Unicode, replace controls
and line separators with spaces, trim, and clip to 200 UTF-16 code units without splitting a
surrogate pair. A name that becomes empty stays empty until the person chooses one.

## Lists

`GET /api/v1/analytics/bookings` returns bounded daily activity counts (at most 90 inclusive
calendar dates), with explicit `startDate`, `endDate` and IANA `timeZone`. Personal owners
and team owners/admins may read the acting organization's totals; ordinary members receive
`403 insufficient_role`. It reports stored operation dates, excludes reschedule withdrawals
from cancellations, and includes no booking or attendee details. See [Booking activity](/docs/analytics)
for the retained-record and deletion semantics.

A list response is `{ "data": [ … ] }`. Lists that can grow without bound use cursor
pagination and add `nextCursor`: pass it as `cursor` (with the same filters) for the next page;
it is null on the last page. Cursors are opaque; `limit` sets the page size (1–100, default
50). Small lists return everything and have no `nextCursor`.

`GET /api/v1/team/bookings` lists the browser session's current team's bookings for current
verified team owners/admins, including meetings hosted by other members. It accepts the
same time/status filters, `order`, `limit` and opaque `cursor` as the host booking list.
Pagination uses start time and ID, retaining microsecond cursor precision; collective
bookings appear once. Inserts before a cursor do not shift later pages; later inserts can
appear after it. Missing or invalid sessions, personal organizations, ordinary or removed
members and API-key/OAuth callers receive the same `403 team_management_access_denied`,
without revealing team existence. Any Authorization header is denied even alongside a
valid owner/admin session cookie. The route uses the shared team-management access check
and caller Origin/Referer handling. Responses contain only ID, status, start/end,
`cancelledAt`, associated `eventType: {id,title}` (null title after deletion), saved
`hosts: [{userId,name}]` and `attendees: [{name,email,timeZone,isBooker}]`, inside
`{data,nextCursor}`. No answers, free-text titles/reasons, management capabilities, calendar
copies, conference URLs or reschedule-chain IDs are included. Cancelled reschedule
predecessors and their successors are separate rows.

`POST /api/v1/team/bookings/{id}/cancel` lets the same current verified owner/admin browser
session cancel a booking of its current team before the booking starts. Send
`X-Expected-Organization-Id` from the team where the action started and an optional strict
`{ "reason": "…" }` body (at most 1000 characters). A same-origin `Origin`, or a same-origin
`Referer` when Origin is absent, is required; missing sources, `Origin: null` and other
origins receive 403 `forbidden`. Missing or stale expected organization receives 409
`organization_context_changed`; reload before deciding whether to submit again.

Success returns 200 `{ "cancelled": true }`. A cancellation already committed in this team
returns 409 `booking_already_cancelled`, including a retry after a lost response. Reload the
team list to see the saved state; that response queues no additional notifications. Concurrent
cancellations commit one cancellation and one notification set. Missing, other-team,
personal and already-started bookings receive the same 403 `team_management_access_denied`.
Current membership and role are rechecked under the write locks. API keys, including a key
alongside a session cookie, receive the same denial for every target; MCP OAuth tokens do
not authenticate REST and receive 401. An Authorization header never falls back to cookies.

Cancellation retains the saved hosts and conference organizer, attributes the operation to
the acting administrator, and queues the normal host/attendee cancellation notifications
and conference cleanup in the same transaction. Team administration grants no host
reschedule or organizer-only conference retry authority. Existing host, private-link, REST
API-key and MCP cancellation permissions and retry responses remain unchanged.

Booking lists accept `endAfter` (end strictly after this instant) and `endTo` (end at or
before it), alongside the existing start-time `from`/`to` filters. The web app splits Upcoming
and Past at the end time, so a meeting in progress stays Upcoming. Ordering and cursors
remain based on start time and ID; keep all filters when paginating.

Authenticated host booking lists and details add optional `rescheduledToId`: the immediate
successor in the same organization that the caller also hosts, or null when none is
available. It is included even when the successor is outside the current page or filters,
and omitted from public/manage responses. Rescheduling still leaves the predecessor's API
`status` as `cancelled`; the host UI uses this link to label that withdrawal `Rescheduled`.

Host lists and details also add optional `eventTypeTitle`, the event type's current title
(null when deleted). The stored `title` remains the original booking title. The web app
localizes its generated composition only when it exactly equals `eventTypeTitle` +
`" with "` + the booker's saved name; custom titles, older titles after event-type renames,
and titles without current event metadata remain unchanged. Public/manage responses omit
`eventTypeTitle`.

## Booking readiness reads

`GET /api/v1/readiness/self` returns the current member’s own readiness detail. In their
personal organization it also returns their personal event-type readiness; in a team it
returns only that member’s detail. It requires a current verified web session and current
membership. API keys and OAuth callers cannot use readiness reads.
On the self read, an `Authorization` header takes precedence over the session cookie: a valid API key plus
a cookie receives `403 readiness_access_denied`; an invalid bearer or MCP OAuth access
token receives `401 unauthorized`, even alongside a valid cookie. There is no `userId`,
organization or audience override; unknown query fields receive `400 invalid_request`.

`GET /api/v1/teams/{teamId}/readiness` returns minimal member and event-type summaries for
the acting team, through the shared team-management access check. Only current verified
team owners/admins can read it. Missing sessions, ordinary members, other teams and
nonexistent teams receive the same `403 team_management_access_denied`. Any Authorization
header is denied even with a valid owner/admin cookie. The summary includes coarse reasons such as
`calendar_attention_required` and repair kinds; it excludes private calendar/account data,
schedules, exact sync times, provider errors and busy-time details.
Names are returned only for verified members with a nonempty, valid display name;
otherwise `displayName` is the neutral label `Team member`. It never falls back to email.
The path's `teamId` must match the session's current active team, even if the caller
manages another team. Each request rechecks organization context and current roles, so
switching organizations, demotion or removal cannot reuse an earlier authorized summary.
After membership removal the ordinary caller resolver may fall back to the person's
personal organization; the self response then describes that current context only.

Both reads use cached server-side configuration and sync facts, without live provider calls.
Enablement, round-robin activation, configuration, sync and check results remain separate.
No external calendar is required for basic checks. A successful summary describes its check
time and does not promise available slots or reserve a booking; booking still rechecks its
current prerequisites. Unknown or failed checks remain `not_checked` or `check_failed`.

The self response is `{member,eventTypes:{data,nextCursor}}`. Each item contains
`subject:{kind,id,organizationId}`, `audience:"self_detail"`, `enablement`, `activation`,
`evaluatedAt`, `scope:"configuration_and_cached_sync"`, `signals`, `summary`,
`availability:"not_checked"`, `completeness` and `details`. Private schedule and calendar
metadata appears once in `member.details`; event-type `details` retains the required
`{schedules:[],calendars:[]}` container for compatibility. Use the member's detail for repairs.
The redundant `event_enablement` signal is no longer emitted; its published enum value
remains compatible with older responses. Read the independent `enablement` axis instead:
inactive events are `disabled`, while active hidden events remain `enabled` because their
direct booking link still works. Disabled is independent of configuration blockers.

The team response is `{organizationId,members:{data,nextCursor},eventTypes:{data,nextCursor}}`.
Member items contain `memberId`, `displayName`, `summary`, `completeness`, `evaluatedAt`,
`reasonCodes` and `fixKinds`. Event items replace member identity/name with `eventTypeId`,
`enablement` and `activation`. Repair kinds are `edit_event`, `ask_member` and `retry_summary`;
member-owned calendar and schedule repairs require the member to act.

Each self signal is `{id,state,reasonCode,checkedAt,ownerKind,fixKind}`. Its state is:

| State | Meaning |
|---|---|
| `satisfied` | The condition passed at `checkedAt`; available slots are not promised. |
| `not_applicable` | Successfully confirmed that this check does not apply. |
| `configuration_blocker` | A known configuration gap needs repair. |
| `dependency_unavailable` | Selected conflict-calendar data is unsafe or unavailable. |
| `not_checked` | The check is unknown or unsupported; `checkedAt` is null. |
| `check_failed` | A read or evaluation was attempted but failed; `checkedAt` is the attempt time. |

Unknown and failed required checks set `completeness:"partial"`; they never imply passed
checks or no slots. `slot_observation` always remains `not_checked` and is excluded from
configuration completeness. For selected Google calendars, explicit sync errors or inactive
connections take precedence as `calendar_attention_required`; otherwise a missing successful
timestamp or snapshot uses `sync_not_ready`. Other unsafe cached-sync facts use
`calendar_attention_required`. One selected-sync signal reports one cause and repair.
Team summaries collapse these into the single coarse `calendar_attention_required` reason.
Neither a missing timestamp nor a reset snapshot proves that synchronization was never tried.

Both routes use the common open `Error` schema: `400 invalid_request` for malformed/unknown
query fields (`invalid_limit` or `invalid_cursor` for service-level pagination validation)
and `500 internal_error` for unexpected failures that prevent a safe response. The self read
uses `401 unauthorized` for missing or invalid credentials, `403 readiness_access_denied`
for an authenticated caller without access, and `429 rate_limited` for credential throttling.
The team read refuses any Authorization header before credential resolution and uses only
`403 team_management_access_denied` for every access denial, including missing or invalid
sessions, without a `WWW-Authenticate` challenge. Dependency evaluation failures that can be safely
represented inside an authorized item use `check_failed` in a successful response instead.

Pages default to 50 items and accept `limit=1..100`. Pass the member page’s `nextCursor` as
`memberCursor` and the event-type page’s `nextCursor` as `eventTypeCursor`; cursors are UUIDs.
The self read has only an event-type page. Each returned item has its own completeness and
check result; a page is not evidence that unreturned members or events passed.

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
  once, when the booking is made (and with the new booking after an invitee reschedule).
  `…/slots` ignores the booking itself, as rescheduling does, so it offers times that overlap
  the current one; a booking that cannot move answers 409 as a reschedule would
  (`booking_cancelled`, `booking_in_past`, `event_type_unavailable`). Like every manage
  endpoint it acts on the booking the token opens (below): with an email's token, the latest
  of the reschedule chain.

Two kinds of manage token are accepted, alike in shape (43 base64url characters) and
everywhere a token is taken, REST and MCP:

- **The booking's own token**, the `manageToken` the create (or reschedule) response
  returned. An invitee reschedule leaves it with the old, cancelled booking: cancelling or
  rescheduling with it gets 409 `booking_cancelled`. A host reschedule instead transfers
  its hash to the successor, clearing it on the predecessor in the same transaction, so
  the invitee's existing link opens the new booking without exposing a secret to the host.
- **An email's token**, from the manage links in the invitee's booking emails; each email
  carries its own ([Notifications and background jobs](/docs/notifications#which-booking-a-token-opens)). It
  follows the meeting: after a reschedule it opens the booking that replaced it (the latest
  of the chain), and cancels or reschedules that one.

Invitee rescheduling is limited to five moves across the entire booking chain by default.
`BOOKING_MAX_INVITEE_RESCHEDULES` accepts an integer at least zero; zero disables invitee
rescheduling. Reaching the limit returns `409 booking_reschedule_limit`, with guidance to
contact the host. New response tokens and older email links share the same budget.
Authenticated host moves do not consume this budget and remain available after it is
spent; cancellation remains available too.

After a cancellation, any token still shows the booking (status `cancelled`); cancelling
again or rescheduling gets 409 `booking_cancelled`. A token stops working only when its
booking is deleted. Responses never contain an email's token. With an email's token, a
cancel or reschedule that keeps finding the meeting rescheduled again while it waits gets
409 `booking_changed`; trying again is safe.

The web manage page immediately reads once more when it receives a cancelled booking
without a conference: a reschedule may have committed between token resolution and booking
hydration. That read uses the same token and the successor rules above. Its result is final
for that transition, including a cancelled successor or the same cancelled booking; failure
keeps the first snapshot. It never automatically repeats a write or starts a polling loop.

They are rate limited per client (`TRUSTED_PROXIES` decides which address that is; IPv6
clients count per /64 network, since one subscriber usually has a whole /64): 120 requests a
minute for host and event pages and for slots (the manage link's slots included), 10 for
creating bookings, 30 for the other manage endpoints;
beyond that 429 `rate_limited` with `Retry-After`, decided before the request body is read
(only a `Content-Length` over the body limit is refused first). The counters live in each server process's memory, so with several instances a client gets that budget once per instance; a shared store
comes with multi-instance deployments.

### Host rescheduling

Authenticated hosts use `GET /api/v1/bookings/{id}/slots?start=…&end=…` to find a new time,
then `POST /api/v1/bookings/{id}/reschedule` with a strict `{ "start": "…" }` body.
Both require the caller to host that booking in the caller's acting organization, with the
same authorization and service layer as MCP `reschedule_booking({bookingId,start})`.
Slot lookup ignores the booking's own busy time and checks all original hosts; it uses
the same range bounds as invitee slot lookup. Authenticated host requests have separate
per-user limits: 120 slot lookups and 30 reschedules per minute, shared by all of the user's
sessions and API keys across organizations and addresses. Invitee traffic from the same
address does not consume these budgets. API-key limits also apply. Host limits run after
authentication and before the request body is read; exceeding one returns 429 `rate_limited`
with `Retry-After`. Like the invitee limits, their counters are per server process.

Host moves always return `{ booking, manageToken: null }`. No invitee token is minted or
revealed: the existing booking-token hash moves to the successor, and per-email tokens
continue to follow the reschedule chain. Repeated host moves preserve those links; a later
invitee move still rotates the booking token as described above. Notifications and origin
attribution use the same transactional reschedule behavior as invitee moves. The web admin
booking detail uses these public endpoints.

A slots request may span at most 62 days, and its bookable part (from now plus the event
type's minimum notice to the end of its booking window) at most 20 000 possible start times at
the event type's slot step: about 13 days with 1-minute steps, any 62 days with 30-minute
steps. Beyond either, 400 `range_too_long`; a range with no bookable part returns no slots.

### Reserved handles

Because booking pages share the root with the web app, the API and static files, some names
can never be a handle: every top-level path the app or the server answers (`app`, `api`,
`assets`, `booking`, `sign-in`, `event-types`, `favicon.ico`, …) and pages people expect from
the product itself (`support`, `security`, `pricing`, `status`, …). The list is
`RESERVED_NAMES` in [`packages/core/src/reserved.ts`](https://github.com/hourmere/hourmere/blob/main/packages/core/src/reserved.ts), compared case-insensitively. Setting one
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

A replay never sends the booking emails a second time: they are queued only in the
transaction that creates the booking.

Invitee rescheduling is not idempotent: it cancels the booking and creates a new one with a
new manage token, so retrying it with the booking's own token after a lost response gets 409
`booking_cancelled`. The invitee does not lose access: the reschedule email carries a new
link, and links in earlier emails follow the meeting to the new booking. (So a retry with
an email's token would move the meeting again; clients must not resubmit it on their own.)
Host rescheduling is also not idempotent, but returns no token; retrying the predecessor
booking ID gets `booking_cancelled`. Inspect host booking history and `rescheduledFromId`
after a lost response before deciding to move the successor.

### Team booking links

Individual, collective and explicitly activated round-robin team event types have a public page at `/team/{teamSlug}/{slug}`. The matching
API is `GET /api/v1/public/teams/{handle}/{slug}`, with `/slots` and `POST /bookings` suffixes
as on personal pages; `handle` here is the organization slug in its exact stored case.
Organization slug uniqueness is case-sensitive, so these routes preserve case and never
choose a different team by lowercasing it. Event type slugs remain lowercase. Team slugs
are 1–64 ASCII letters/digits/inner hyphens and may not be reserved names.

The event response includes `team: { name, slug }` in addition to its host and the usual
public fields. Personal organizations and personal event types cannot be reached through
this namespace. Only active, non-deleted types with valid, verified team members as hosts
are served: `individual` types have one assigned host, while `collective` types require all
two to eight assigned hosts to be available for the complete interval. Collective hosts use
their current default schedules; see [collective scheduling](/docs/collective-scheduling) for
configuration, concurrency and rescheduling rules. Round-robin types offer the union of
currently eligible hosts and assign one available host in a durable equal rotation. Legacy
and newly saved round-robin pools need explicit activation; ordinary metadata saves never
activate them. Round-robin event metadata omits `host.timeZone`; invitees view slots in
their own zone. Booking results include only safe assigned-host name/time zone. A pool edit
committed while a booking waits returns retryable `409 booking_changed` when the event
still exists; fetch current availability before retrying. See
[round-robin scheduling](/docs/round-robin-scheduling) for activation, fairness and failure rules.
Team bookings use the same availability rules, locks, idempotency scope, notifications and
manage links as personal bookings.

### Unlisted event types

Event type writes accept `isHidden` (default `false`). A hidden event type is omitted from
the host's public event list, while its direct page, slots and booking endpoints continue to
work when it is active. Anyone who knows or guesses the link can book it; hiding is not
authentication or access control. The editor offers an optional random slug suffix to make
a link less guessable; applying it changes the URL and never adds access control. Inactive
or deleted event types remain unbookable.
Authenticated REST and MCP catalog reads retain hidden configurations and their `isHidden`
flag so owners and authorized team members can manage them.

### Additional guest recipients

Event types default `allowGuests` to false. Only the personal owner or a team owner/admin
can enable it. Public personal/team detail and authenticated event-type detail/catalog
report the flag. Sending nonempty `guests` while it is off returns `400 guests_not_allowed`
from both REST and MCP, without creating a booking or email jobs. The maximum remains ten
after opt-in. A settings change is serialized with booking approval; idempotent replays
of committed bookings and existing attendees on reschedule/cancel remain intact.

### Organization webhooks

`/api/v1/webhooks` configuration and delivery metadata require a current verified owner/admin
of the acting organization. Ordinary hosts cannot inspect organization-wide outbound
events. Creation/rotation reveal a signing secret once; lists never recover it. Destinations
are immutable HTTPS public DNS URLs by default. Self-hosted operators may explicitly
allow private HTTP(S) host/IP/CIDR and port destinations with `WEBHOOK_PRIVATE_TARGETS`;
Hourmere Cloud must never set it. Saving and updating endpoint settings rechecks URL policy
without DNS lookups or verification requests, and gives the same safe refusal regardless
of internal hostname existence. A PATCH containing only `isActive: false` can pause an
endpoint even after its allowlist entry is removed; all other updates recheck the policy.
Every actual send re-resolves all addresses against the current policy and pins a validated
address to the socket. Accepted configuration does not establish receiver availability.
The instance must explicitly enable new captures; no historical bookings are backfilled.
See [Booking webhooks](/docs/webhooks) for the payload, signed headers, retention and delivery contract.

### Automatic Google Meet

The optional event-type input `location: {kind:"google_meet",autoCreate:true}` explicitly enables per-booking provisioning when the instance and selected owned calendar support it. Label-only existing input is unchanged. Collective opt-ins require an authenticated `conferenceOrganizer: {userId}` from their required hosts; individual and round-robin types use their actual host/winner and reject a fixed selection. Unsupported configurations return `automatic_meet_disabled`, `automatic_meet_unavailable` or `invalid_conference_organizer`. Protected booking details add optional bounded `conference` state; catalogs expose no join URL. The current verified pinned organizer can POST an empty strict JSON object to `/api/v1/bookings/{id}/conference/retry` for safe reconciliation. It never overrides an ambiguous create or switches the pinned destination. See [Automatic Google Meet](/docs/automatic-google-meet) for ready-gated invitations, cancellation and retry limits.

`conference.status="failed"` with `conference.errorCode="conference_pending_timeout"`
means Google still reported pending when the bounded provisioning poll budget expired;
`provider_unavailable` identifies a provider/transport failure instead. This is booking
state in a successful protected read, not a new HTTP error status. Explicit host retry
restarts a bounded reconciliation budget with the same event/request UUID and only polls
an acknowledged PATCH; it cannot force Google to restart a stuck pending request. A fresh
UUID is reserved for a known provider `conference_failed` or the documented operator repair.

Authenticated host reads alone include optional caller-only `calendarCopy` and `conferenceCanRetry`.
`POST /api/v1/bookings/{id}/calendar-copy/retry` takes an empty strict object, rechecks original
host/current verified membership, and reconciles the immutable target. Unconfigured targets
cannot be bound later. Public/manage responses never expose these fields or invitation snapshots.
