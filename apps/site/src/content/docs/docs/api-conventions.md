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

  Team invitation writes at `POST /api/auth/organization/invite-member` require a current
  verified owner/admin, a same-origin session and `X-Expected-Organization-Id`. Only
  `member` may be invited (also the default when `role` is omitted). Ordinary retries by
  the original inviter preserve an unambiguous pending invitation's generation/outcome;
  another inviter receives `409 INVITATION_ALREADY_PENDING` and must reload.
  The additive `existing` boolean is false only for a newly created invitation and true
  when a pending invitation is retained, including explicit resend and replay. A repeated
  queued result therefore identifies the existing invitation instead of implying creation.
  Explicit resend additionally requires `resend: true`, `invitationId`,
  `expectedGeneration` (1–32) and a fresh UUID `requestId`. An identical request replays
  its current result; stale generations or ambiguous matches return 409
  `INVITATION_CONFLICT`. Resending an unexpired invitation retains its ID, email, role and inviter,
  and extends expiry from now by its original validity length. For an expired invitation,
  this same explicit action atomically cancels the old invitation and creates a new ID,
  with generation 1 and the acting administrator as inviter. The old link remains unusable;
  signup eligibility uses the new inviter. Creation applies the usual request budgets,
  active-duplicate check and team pending limit. The invite form uses the same creation
  policy and cancels expired rows for that address in its transaction. Neither path leaves
  a second stored-pending invitation. Accepted, canceled or rejected invitations cannot
  be resent. Each new generation records its authorizing administrator for sender authority
  checks and the mail's “invited by” name. An unexpired resend preserves its original
  inviter for signup policy. A replacement response returns the new ID and `existing: false`;
  clients must follow that ID when reading the final state. Exact resend replay applies
  to an unexpired invitation's retained ID; a replaced, canceled ID is not revived.

  Resends wait 60 seconds after the later of the last explicit resend or worker update (`429 INVITATION_RESEND_COOLDOWN`,
  `retryAfterSeconds: 60`, `Retry-After: 60`); live sending leases return 409
  `INVITATION_DELIVERY_BUSY`, and generation 32 returns 409 `INVITATION_GENERATION_LIMIT`.
  Request budgets return fixed `429 INVITATION_RATE_LIMITED`; unauthorized management
  returns uniform `403 TEAM_MANAGEMENT_ACCESS_DENIED`. An authorized team admin inviting
  a current member receives `409 INVITATION_RECIPIENT_ALREADY_MEMBER`; accepting a legacy
  invitation while already a member receives the same refusal. Teams may retain at most
  100 pending, unexpired invitations (`409 INVITATION_PENDING_LIMIT`). Other admission
  responses do not distinguish an existing non-member account from a new address. The additive `delivery` summary contains
  `generation`, `state` and `attempts`; `queued` records intent, not successful delivery.
  A successful queued response waits for durable job enqueueing after admission commits,
  and never waits for SMTP. Queue failure or an unconfirmed exclusive conflict returns
  `503 INVITATION_DELIVERY_UNAVAILABLE`; the invitation and due queued intent remain saved.
  If an expired replacement has committed, this error includes its new `invitationId` so
  clients can read its current summary. A post-commit `409 INVITATION_INELIGIBLE` likewise
  includes that ID if acceptance or cancellation overtook dispatch. Read the returned ID
  before offering another action. If a lost response leaves the replacement ID unknown,
  reading the old canceled row cannot confirm whether a replacement was saved; review
  Pending invitations before retrying. Retrying the invite form with the same email repairs
  the replacement's queued intent without creating another pending invitation.
  Retrying the same request repairs its current generation; resend retries must retain
  the same `requestId` and `expectedGeneration`. A periodic repairer also recovers missing
  live jobs and expired claims without resetting their bounded attempt budget. The
  worker rechecks invitation status, expiry and generation before every send, using the
  current address. `smtp_accepted` means accepted by the mail server; it does not promise
  inbox delivery. A failed result commit after SMTP acceptance can cause a duplicate.
  If cancellation, acceptance, expiry or deletion overtakes dispatch, the request returns
  `409 INVITATION_INELIGIBLE` with the existing no-longer-pending wording. A newer generation
  overtaking dispatch still returns 503; reload before retrying an obsolete resend.
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
session or an API key. Its additive `personalOrganizationId` is the caller's own personal
organization UUID, derived from the stored ownership marker independently of the active
organization, or null when no marker exists. Clients must not infer it from organization names.
The MCP server at `/mcp` ([MCP quickstart](/docs/mcp)) accepts API keys and,
when enabled, MCP OAuth grants. Session cookies never authenticate MCP. OAuth grants are
limited to MCP tools and do not authenticate REST requests.

### Browser organization context

Better Auth's `/api/auth/organization/*` endpoints require browser sessions. Any
Authorization header, including an empty or invalid value, returns `403 SESSION_REQUIRED`
even alongside a valid owner/admin cookie. API keys and MCP OAuth tokens cannot inherit
the browser's organization-management privileges.

`GET /api/auth/organization/list-members` retains Better Auth's offset paging and
`{ members, total }` shape. It counts joined memberships only. Members receive each
membership's IDs, role, creation time and public user summary (`id`, `name`); other
members' email addresses and avatars are omitted. Verified owners and admins also receive
the native member email/avatar fields. Sensitive fields require a current database
membership with only known `owner`, `admin` and `member` role tokens, including an owner
or admin token. Unknown roles and unverified identities receive the public summary.
`get-full-organization` uses the same member projection and omits `invitations` for
non-managers; direct `list-invitations` returns `403 TEAM_MANAGEMENT_ACCESS_DENIED` to
them. The settings page loads the separate, cursor-paged safe invitation summaries from
`GET /api/v1/team/invitations` only for owners and admins.

Organization-scoped browser drafts bind `X-Expected-Organization-Id` to the organization
where the form or action started. Do not replace that value with the active organization
at submission time. A header works with both the strict REST JSON bodies and Better Auth's
separate protocol, without adding fields to either body.

For team REST routes that accept this header, a different current organization returns
`409 organization_context_changed` when the verified session user still owns or administers
the expected non-personal team. For the self-service routes
`POST /api/v1/teams/{teamId}/leave` and the caller's own
`GET /api/v1/team/members/{memberUserId}/departure-impact`, any current member of the
expected team receives that 409, including an ordinary member. Previewing another member
still requires expected-team owner/admin authority. This includes a switch to personal
space or a team where the user is only a member. Expected-team authority is checked before
current-team eligibility; the header never authorizes reading or writing that team's data.
Invalid, personal, missing or inaccessible expected teams receive the uniform
`403 team_management_access_denied`, without revealing existence. For management routes,
a caller who is only an ordinary member of the expected team receives that same 403.
Omitting an optional read header keeps its existing current-team behavior, while required
write headers remain required.
Native team writes use the same mismatch rule with their uppercase
`ORGANIZATION_CONTEXT_CHANGED` and `TEAM_MANAGEMENT_ACCESS_DENIED` codes. Native
`POST /api/auth/organization/leave` also accepts any current expected-team member for
409 recovery; the other native writes retain the owner/admin rule. A missing required
header retains the existing 409 reload refusal. Explicit switching retains its
source-context contract rather than requiring management authority in the previously
active organization.

These browser context checks include the following status changes. They grant no new
permission and do not affect API-key or MCP OAuth authority.

| Request and supplied expectation | Previous response | Current response |
|---|---|---|
| Native `invite-member`, `cancel-invitation`, `update-member-role`, `remove-member`, `leave` or `update`: malformed expected ID | 409 `ORGANIZATION_CONTEXT_CHANGED` | 403 `TEAM_MANAGEMENT_ACCESS_DENIED` |
| The same native management writes (all above except `leave`): expected team differs from the current space and the caller no longer owns/administers it, including ordinary membership, missing teams and personal organizations | 409 `ORGANIZATION_CONTEXT_CHANGED` | 403 `TEAM_MANAGEMENT_ACCESS_DENIED` |
| Native `leave`: expected team differs from the current space and the caller is no longer a member, or the expectation names a missing/personal organization | 409 `ORGANIZATION_CONTEXT_CHANGED` | 403 `TEAM_MANAGEMENT_ACCESS_DENIED` |
| REST `POST /api/v1/team/members/{memberUserId}/removal`: malformed expected ID, or a different expected team the caller no longer owns/administers | 409 `organization_context_changed` | 403 `team_management_access_denied` |
| REST `POST /api/v1/team/bookings/{id}/cancel`: malformed expected ID, or a different expected team the caller no longer owns/administers | 409 `organization_context_changed` | 403 `team_management_access_denied` |
| REST `POST /api/v1/teams/{teamId}/leave`: malformed expected ID, or a different expected team the caller no longer belongs to, including missing/personal organizations | 409 `organization_context_changed` | 403 `team_management_access_denied` |
| Team reads with the optional header: a different expected team still authorized for that read (any member for their own departure preview; owner/admin for management reads) | 403 `team_management_access_denied` | 409 `organization_context_changed` |
| Team reads that did not previously read the header (`GET /api/v1/team/bookings`, `GET /api/v1/teams/{teamId}/readiness`, departure impact, removal records, removal handling): malformed expected ID | 200 (header ignored) | 403 `team_management_access_denied` |
| The same reads: the expected team differs from the current team | 200 (header ignored) | 409 `organization_context_changed` when still authorized for the expected team, otherwise 403 `team_management_access_denied` |

A still-current ordinary member's stale REST or native leave request retains 409.
Missing required write headers retain 409, and optional-header omission retains existing
reads. The management 403 cases above intentionally avoid distinguishing unknown teams
from teams the caller cannot manage.

The optional read header applies to `GET /api/v1/team/bookings`,
`GET /api/v1/team/invitations`, `GET /api/v1/teams/{teamId}/readiness`,
`GET /api/v1/team/members/{memberUserId}/departure-impact`,
`GET /api/v1/team/member-removals/{operationId}` and
`GET /api/v1/team/members/{memberUserId}/removal-handling`. Each retains its existing
role and target restrictions when the expected organization matches or the header is absent.

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
| Remove a member and return the handling record | `POST /api/v1/team/members/{memberUserId}/removal` |
| Leave a team | `POST /api/auth/organization/leave` |
| Leave a team safely after resolving impact | `POST /api/v1/teams/{teamId}/leave` |
| Change team settings, including name or slug | `POST /api/auth/organization/update` |

For the session writes above, the expected organization must match both the operation's
target organization and the current valid session organization. Missing context and
an authorized context mismatch return HTTP 409: `organization_context_changed` under
`/api/v1`, or `ORGANIZATION_CONTEXT_CHANGED` under `/api/auth`. Inaccessible expectations
use the 403 rules above. The 409 message asks the person to reload.
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
keeps the old context and draft without repeating the prompt while changes remain unsaved.
After saving, discarding or leaving the draft, the next focus/visibility read follows the
current organization silently. Accepting remounts the page. Explicit conflict reload
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

Only a current verified team owner may assign the fixed `admin` or `member` role.
Owner targets cannot be demoted, including by themselves; only their own safe departure
is allowed. Admins cannot change roles, including their own. Assigning `owner` and custom roles is
unavailable; full ownership transfer is not offered at launch. Stored comma-separated
roles are checked as exact role tokens.

Role changes, removal and departure retain the same organization row `FOR UPDATE` lock
and defensive current-owner check inside the membership write transaction. Owner-target
role changes and administrative removals receive the uniform access denial before any
write. A safe departure that would leave no owner returns
`409 member_departure_owner_required`, with
`handling.nextStep: add_another_owner_first` and message "The team must retain at least
one owner." The existing `handling.owner: another_owner_is_needed_before_you_can_leave`
remains for compatibility.
Native Better Auth responses use `{code,message,handling}`; REST uses
`{error,message,handling}`. Concurrent conflicting changes can commit only one loss of
ownership. A caller whose authority has already been revoked receives the ordinary access
denial instead.

Team deletion at `/api/auth/organization/delete` returns
`403 TEAM_OPERATION_NOT_SUPPORTED`, including trusted server-side calls, before any
cascade can delete booking history. Owner assignments through `update-member-role`
return `403 TEAM_MANAGEMENT_ACCESS_DENIED`; this instance exposes no separate ownership
transfer endpoint. Personal-organization protections remain unchanged.

These rules apply to direct Better Auth requests as well as the web app. Policy denials
use HTTP 403 `TEAM_MANAGEMENT_ACCESS_DENIED` in Better Auth's error shape; missing and
inaccessible role targets receive the same denial. Browser context mismatches use the
409 or uniform 403 rules above. The server-only Better Auth add-member operation is not an HTTP
onboarding path; joining a team requires accepting a member invitation.

### Team invitation delivery summaries

Owners and admins manage invitations in Settings → Team members. Each pending row offers
**Resend invitation** and a confirmed **Cancel invitation** action. Select **Expired** for
**Send a new invitation**, which atomically cancels the expired invitation and creates a new
ID under the acting administrator. The page follows the returned ID, rereads server state
after actions and displays joined, cancelled or queued outcomes independently of the filter.

`GET /api/v1/team/invitations/{invitationId}` returns one current `TeamInvitationSummary`
without list pagination or lifecycle filtering. `POST /api/v1/team/invitations/{invitationId}/cancel`
requires JSON `{}` and returns that summary after locking the invitation. Both require
`X-Expected-Organization-Id`, a verified current team owner/admin session and no Authorization
header; cancellation also requires same-origin CSRF checks. Missing and other-team IDs return
uniform `403 team_management_access_denied`. Context drift returns `409 organization_context_changed`.
Cancellation serializes with resend and acceptance. It only voids a still-pending invitation;
if joining won, the result remains `accepted` and the member remains joined. Native acceptance
commits the accepted status and matching membership in one transaction, including session
activation. Native team creation likewise commits the organization and creator-owner
membership together. Repeating cancel is safe. Native Better Auth `cancel-invitation` uses the same locked policy. A submission
already in flight may still be accepted by SMTP, while the cancelled link cannot join.

The additive `generation` is the expected generation for resend. `resendDeniedReason` is
null when eligible, otherwise a fixed admission code (role/lifecycle, already a member,
generation cap, live delivery, cooldown, duplicate active invitation, pending limit or request
budget). `resendRetryAfterSeconds` gives the remaining 1–60 seconds for cooldown, otherwise
null. Eligibility is an observation and reserves no capacity; the write always rechecks it.

`GET /api/v1/team/invitations` is Hourmere's own versioned read protocol, independent
of Better Auth's invitation response schemas. It lists only the browser session's current
team and requires a current verified owner/admin. Missing or invalid sessions, personal
organizations, ordinary or removed members and any Authorization header receive the same
`403 team_management_access_denied`, without `WWW-Authenticate`. Authorization headers
are rejected before resolving API-key/OAuth credentials, even alongside a valid cookie.
The route uses the shared team-management access middleware and rechecks current authority
before reading invitations. It is session-only REST; MCP and CLI credentials grant no
team invitation management authority.

Browsers may send optional `X-Expected-Organization-Id` to bind every page and retry to
the team where the invitation section opened. A switch to any other organization, including
personal space or a team where the reader is only a member, returns
`409 organization_context_changed` if the reader still owns or administers the expected
team, with guidance to reload, before any summaries are read. Invalid, personal or
inaccessible expected teams retain the same `403 team_management_access_denied`.
These checks cover the first page without a cursor. The header grants no
authority and must match the session's current team. Omitting it preserves existing
current-team reads.

The envelope is `{data,nextCursor}`. `limit` accepts 1–100 (default 50); pass the opaque
`nextCursor` as `cursor` in the same team with the same filters until it is null. Optional
`status` accepts `pending`, `accepted`, `canceled`, `rejected`, `expired` or `unknown` and
filters the derived lifecycle before pagination. In particular, `status=pending` excludes
expired pending rows using the database clock, and terminal or unknown rows cannot
produce empty intermediate pages. Omitting `status` retains all lifecycle states.
Ordering is invitation ID
ascending, with an exclusive keyset boundary: deleting a previous row or inserting before
the boundary does not shift later pages. Later inserts can appear. A cursor from another
team returns `400 invalid_cursor`; malformed query parameters return `400 invalid_request`.

Each item contains exactly these fields in the current implementation. Published OpenAPI
response objects remain extensible for additive v1 changes.

| Field | Meaning |
|---|---|
| `id` | Invitation UUID. |
| `email` | Invited recipient address, visible only to verified owners/admins of this team. |
| `status` | `pending`, `accepted`, `canceled`, `rejected`, derived `expired` or `unknown`. Only stored pending invitations with `expiresAt <=` the database clock become expired; terminal statuses take precedence. Unrecognized stored statuses map to `unknown`, stay in pagination and never count as pending or allow resend. |
| `createdAt` | Stored invitation creation time in UTC. |
| `expiresAt` | Stored invitation expiry in UTC. Reading does not renew expiry or change status. |
| `delivery.state` | Current generation's `queued` (waiting to send, including retry), `sending` (submitting to the mail server), `smtp_accepted` (accepted by the mail server), `failed` or `skipped`; `unknown` if no delivery row remains. Mail server acceptance does not imply inbox delivery, reading or joining. |
| `delivery.attempts` | Stored current-generation attempts (0–4), or null without a delivery row. |
| `delivery.lastAttemptAt` | Database time when the latest attempt was recorded in the current generation. Null before any attempt, for unknown legacy attempt times or without a delivery row. Later outcome updates do not replace it. |
| `delivery.lastErrorCode` | Fixed classification below, or null. No raw provider error text. |
| `resendAllowed` | Current member-invitation eligibility and actor/team/recipient request budgets. Unexpired resend checks the 60-second cooldown, generation cap and live sending lease; expired replacement checks recipient membership, active duplicates and the team pending limit. This read spends no budget and reserves no permission; resend checks again. |
| `generation` | Current generation (1–32), or 1 for legacy invitations without retained delivery metadata. |
| `resendDeniedReason` | Null when allowed, otherwise the fixed admission code describing why resend or replacement is unavailable. |
| `resendRetryAfterSeconds` | Remaining cooldown seconds (1–60), otherwise null. |

Delivery error codes are `transport_error`, `smtp_auth`, `smtp_temporary`, `smtp_permanent`,
`smtp_not_configured`, `mail_rate_limited`, `interrupted`, `attempts_exhausted`,
`invitation_ineligible` and `legacy_delivery_unknown`. These are stored diagnostic
classifications, distinct from the endpoint's HTTP errors. Accepted, canceled,
rejected or unknown invitations cannot be resent; elevated/custom historical roles are ineligible.
Expired pending invitations require a new ID; the explicit action cancels the expired row
and creates its replacement atomically if admission permits.
An exhausted current generation can be explicitly resent if the new-generation rules allow it.

Recipient addresses are returned only to the current team's verified owners/admins.
Members, other teams and API-key/OAuth callers cannot read them through this endpoint.
No inviter identity, role, message body, invitation link/token, credential,
job ID, lease identity, resend request ID or raw third-party error is returned. The endpoint
does not send mail or change the invitation or delivery records.

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

### Immediate member removal

`POST /api/v1/team/members/{memberUserId}/removal` accepts the strict body `{teamId}`
and requires `X-Expected-Organization-Id`. A current verified owner can remove an admin
or a member; an admin can remove a member only. Owner targets, administrative self targets,
missing and inaccessible members receive the same `403 team_management_access_denied`
before any write. Owner targets allow only the owner’s own safe departure. The locked
write transaction retains a defensive owner count; its stable
`409 member_departure_owner_required` uses message "The team must retain at least one
owner." and `handling.nextStep: add_another_owner_first`.
Missing or invalid sessions and any Authorization header, even with a valid session
cookie, receive that same denial without a `WWW-Authenticate` challenge. Authorization
headers are refused before credentials are resolved. Cookie writes require a same-origin
Origin or Referer. The header and body `teamId` must match the current session team.
Missing context or a stale expectation for a team the caller still owns/administers
returns `409 organization_context_changed` without writing; malformed or inaccessible
expectations return the uniform 403. Reload the page before submitting again.

The membership revocation, affected event-type deactivation and removal operation record
commit together. Individual and collective team types using the member are deactivated;
round-robin types are deactivated when no other current verified team host remains.
Personal event types and other teams are untouched. Existing bookings and saved hosts
remain intact. Repair affected configurations and explicitly reactivate them before taking
new bookings. For another member, Better Auth's native `remove-member` endpoint uses the
same transaction and target policy, with its own response and error format. A native
self target uses safe team departure instead, including the owner and impact checks
described below. REST immediate removal refuses self targets; use the safe departure
route so dependency checks and the personal-organization fallback run together.

The REST response is `{operationId, memberUserId, deactivatedEventTypeIds}`.
`GET /api/v1/team/member-removals/{operationId}?teamId={teamId}` lets current verified
owners/admins read the handling list after the member has been removed. It returns
`id`, `memberUserId`, `removedAt`, `evaluatedAt`, `reason: "member_removed"` and
`bookings: {data, nextCursor, totalCount}`. Bookings use the departure preview's field
whitelist and handling reasons, with confirmed bookings ending after `evaluatedAt`.
`limit` accepts 1–100 (default 50); follow `nextCursor` as `cursor` with the same team
and removal ID. Pages use exact stored start time and ID; counts cover all current matches.
Each request recalculates unfinished bookings. The record does not grant cancellation
permission or relax cancellation time rules. Inaccessible and missing records share the
same 403 denial. This read is session-only and does not expose the general operation log.
After a native removal, use
`GET /api/v1/team/members/{memberUserId}/removal-handling?teamId={teamId}` to discover
the latest removal's handling list without an operation ID. It has the same response,
access rules and pagination bounds; its returned `id` pins that record for subsequent
requests through the removal-record route.

### Safe team departure

`POST /api/v1/teams/{teamId}/leave` requires a verified browser session, an empty JSON object
and `X-Expected-Organization-Id` bound to the team where the action started. Missing or
invalid sessions and any Authorization header return `403 team_management_access_denied`
without a `WWW-Authenticate` challenge, even alongside a valid cookie. Authorization
headers are rejected before credential resolution. A stale expectation returns
`409 organization_context_changed` when the caller is still a member of that non-personal
team, in any role; a non-member receives the uniform 403. Reload before retrying.
The same membership rule applies to native `/api/auth/organization/leave` and the caller's
own departure-impact preview. Management routes retain the owner/admin rule.

An owner needs another current owner before leaving. The locked refusal is
`409 member_departure_owner_required`, with the message "The team must retain at least one
owner." and `handling.owner: another_owner_is_needed_before_you_can_leave`.
The owner check and the event/booking impact recheck share the membership transaction's
organization write lock. The handling object also includes
`nextStep: add_another_owner_first`. Native `/organization/leave`, including an exact
sole `owner` role, and self-directed native removal return the same stable 409 code.
Two owners leaving concurrently cannot both succeed, including races with removal or
demotion.
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
`cancelledAt`, associated `eventType: {id,title,publicBookingPath}` (null title after deletion), saved
`hosts: [{userId,name,timeZone,isCurrentMember}]` and `attendees: [{name,email,timeZone,isBooker}]`, inside
`{data,nextCursor}`. The read-only `timeZone`, `isCurrentMember` and `publicBookingPath` fields
are additive and nullable. Host zones come only from public profiles; a missing profile
returns null. Membership refers to the booking's team, including false for saved hosts who
left. The public path is present only while the event type exists, is enabled and its
current configuration is publicly bookable; otherwise it is null. These additions apply
only to this list, without expanding member-departure or removal previews. No answers,
free-text titles/reasons, management capabilities, calendar
copies, conference URLs or reschedule-chain IDs are included. Cancelled reschedule
predecessors and their successors are separate rows.

`POST /api/v1/team/bookings/{id}/cancel` lets the same current verified owner/admin browser
session cancel a booking of its current team before the booking starts. Send
`X-Expected-Organization-Id` from the team where the action started and an optional strict
`{ "reason": "…" }` body (at most 1000 characters). A same-origin `Origin`, or a same-origin
`Referer` when Origin is absent, is required; missing sources, `Origin: null` and other
origins receive 403 `forbidden`. A missing expected organization, or a stale expectation
for a team the caller still owns/administers, receives 409 `organization_context_changed`;
malformed or inaccessible expectations receive 403 `team_management_access_denied`.
Reload before deciding whether to submit again.

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
configuration completeness. Each selected Google calendar is judged separately: explicit
sync errors or inactive connections take precedence as `calendar_attention_required`;
otherwise a missing successful timestamp or snapshot uses `sync_not_ready`. Other unsafe
cached-sync facts use `calendar_attention_required`. Across selected calendars, unexpected
evaluation failures remain `check_failed`; otherwise `calendar_attention_required` takes
precedence over `sync_not_ready`. One selected-sync signal reports one cause and repair.
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
