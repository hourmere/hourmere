[API conventions](https://hourmere.com/docs/api-conventions).

### Booking source compatibility

`Booking.source` adds `"import"` to the response values `"web"`, `"embed"`, `"api"`
and `"mcp"`. It identifies locally imported bookings, which remain managed in the
original system and carry `managementPolicy: "local_only_read_only"`. This is a
response enum expansion within `/api/v1`: clients with exhaustive source switches or
closed response validators must add `"import"` before reading imported bookings.
Regenerate clients from the current OpenAPI document; do not infer write permissions
from source attribution. Imported booking mutations return `imported_booking_read_only`.

### Webhook event compatibility

`Webhook.events` and `WebhookDelivery.eventType` are open response enums within `/api/v1`.
Additions include the reschedule-request events, `booking.attendee_no_show_changed` and
`workflow.executed`. Regenerate clients from the current OpenAPI document, update closed
validators and ignore unknown event types. New kinds require explicit subscription.
While workflows are off, attempts to add `workflow.executed` return
`404 workflows_disabled`. Keeping or removing an existing subscription is allowed.

### Booking activity no-show counts

`GET /api/v1/analytics/bookings` adds `noShows` to daily and total counts. MCP
`get_booking_activity` and CLI `booking-activity` return the same report and enforce
the same personal-owner or current team-owner/admin access, with `read` or `full`
API-key scope. Each currently marked attendee counts once on the scheduled start's
local date in the requested IANA time zone. Unmarking removes the count; cancelled
bookings and rescheduled predecessors are excluded. Guests and independent group
seats count individually. This is current state, so corrections change past days.
Clients must ignore unknown fields and treat an absent `noShows` on older servers
as unknown, not zero. See [booking activity](https://hourmere.com/docs/analytics)
for daylight-saving boundaries and retained-data limitations.

### Attendance access and team booking fields

Actual booking hosts may read attendees and mark or unmark no-shows. Team owners/admins
who do not host the booking may do so only through a browser session. API keys of any
scope and MCP OAuth have host-only access in the current organization, including REST
`GET /api/v1/bookings/{id}/attendees`, the marking endpoint, MCP attendance tools and CLI
attendance commands. Non-host bookings return the same `booking_not_found` response as
missing bookings, without revealing whether they exist.

The team booking list/detail whitelist adds `canManageNoShow` and attendee `id`,
`noShowMarkedAt` and `noShowMarkedBy` to the existing team booking fields. The marker
fields are nullable; each attendee ID identifies its own row even if multiple attendees
share an email address.
Clients must tolerate absent additive fields from older servers. These fields remain
private and are absent from public and invitee-management responses.

### Validation error fields

An optional `field` string identifies a stable validation field name. Known values are
`successRedirect`, `successRedirect.url`, `successRedirect.parameters`,
`successRedirect.includeInviteePersonalData`, `successRedirect.allowEmbedParent` and
`responses.<questionId>` for a rejected routed booking answer.
New values may appear within `/api/v1`; clients must ignore unknown values and fall back
to the error code and optional message. The published schema is an open string, not a
closed enum. The field may be absent, including when talking to older servers.

### API key scopes

Keys have one immutable scope: `full`, `read` or `bookings`. The web creation form defaults
to `bookings` for AI agents; `read` suits analytics/reporting, and **Full account access**
(`full`) also permits account configuration changes. Existing roles, ownership and host
visibility still apply. Neither `read` nor `bookings` removes existing visible attendee
details or meeting links, and `bookings` can manage previously created bookings you host.

`POST /api/v1/open-time-snippets` is explicitly classified as a booking read: `read`,
`bookings` and `full` keys may call it with personal-owner or team-owner/admin permission.
It reads availability and formats ordinary reusable public links without minting a
capability, reserving a time or changing configuration. The shared service also serves
MCP `generate_open_time_snippet` and CLI `open-time-snippet --json`. See the
[request/response contract](https://hourmere.com/docs/open-time-snippets#request-and-response-reference)
for the 31-elapsed-day bound, language and time-zone defaults, and empty-result behavior.

`GET /api/v1/event-types/{id}/availability-troubleshooting` is a read-only diagnostic that
only `full` keys may call (operation group "Availability diagnostics"), with personal-owner or
team-owner/admin permission. Repeated explanations can reveal when a host is busy, so `read`
and `bookings` keys get `403 insufficient_scope`. The shared service also serves MCP
`troubleshoot_availability` and CLI `troubleshoot-availability`. Its reason `code` is an open
string: new codes may be added within `/api/v1`, and clients must show unknown codes neutrally.
See [Troubleshoot availability](https://hourmere.com/docs/availability-troubleshooting).

Native creation accepts `metadata.scope` with exactly `full`, `read` or `bookings`;
omitting it keeps `full` compatibility, including absent/null metadata. Legacy keys were migrated to `full`.
Top-level `scope`/`scopes`, arrays, combinations and unknown values get
`400 INVALID_METADATA`. Updates containing `metadata.scope`, even the same value, get
`400 API_KEY_SCOPE_IMMUTABLE`. Create a replacement, update clients, then revoke the old key.
Owner-authorized organization updates preserve the original scope. `/api/v1/me` and MCP
`whoami` include `apiKeyScope` for API key callers.

A valid key used for a disallowed operation gets REST `403 insufficient_scope`; invalid,
expired or revoked keys get 401. Public booking/manage-token endpoints remain available
without a key; a supplied bearer must additionally be valid and allow the operation,
without fallback to cookies or anonymous access. Public metadata needs no key. MCP filters
`tools/list` and returns `isError: true` with `insufficient_scope` for direct calls to known
disallowed tools. Reconnect or refresh discovery after replacing a cached client's key.
MCP OAuth retains its existing `mcp:tools` permission.

Native `/api/auth/api-key/create`, `get`, `list`, `update` and `delete` retain their owner
session/trusted-server boundary. Any Authorization header gets `403 SESSION_REQUIRED`,
even with a valid cookie; no key scope authorizes key administration. See
[API keys](https://hourmere.com/docs/api-keys) for operation tables generated from the shared code registry and
the creation contract. New operations need explicit classification; GET/read-only hints
do not grant scoped access.

Stop every old web/all/worker and other old key-authenticating process before migrating,
then restart all roles with the new code before using scoped keys. Never run old and new
servers side by side once scoped keys exist: old code treats them as full access. Use the
supported backup/restore procedure for rollback.

The original inviter must still belong to the invitation's team. If they have left or
been removed, explicit resend (including exact replay) and expired-row replacement return
HTTP 409 `INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION` without renewing or replacing
the invitation. A current owner/admin must use the invite form to create a fresh invitation
in their own name, canceling any old unexpired pending invitation first.
Demotion while retaining membership does not invalidate an invitation. The generation's
authorizing administrator does not replace this original-inviter validity requirement.

The original inviter must remain a member of the same team. If they left or were removed,
native `get-invitation` and `accept-invitation` return HTTP 400
`INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION`; trusted `auth.api.acceptInvitation`
enforces the same rule.
Acceptance checks this inside its user → organization → session → invitation transaction,
sharing the organization lock with departure/removal. It either commits before departure or
refuses without creating a member or rewriting the invitation. The recipient must ask the
team for a new invitation. An inviter's role demotion alone does not invalidate it.

Native `list-user-invitations` omits invitations whose original inviter no longer belongs
to that team, for both HTTP and trusted `auth.api.listUserInvitations` calls. The stored
invitation status is unchanged; retained rows keep the native response fields and recipient
verification rules. A void invitation also grants no signup exception or sign-in email to
an otherwise ineligible address.

Rows with `invalidReason: "inviter_left"` show **No longer valid** and explain that a current
owner/admin must cancel the old invitation and send a fresh invitation using the invite form.
Resend and the expired-row replacement action are unavailable for these rows;
cancellation remains available.

These session webhook compatibility rows mirror the canonical documentation for repository readers.

| Request and supplied expectation | Previous response | Current response |
|---|---|---|
| Session webhook writes: missing or malformed expected ID | 2xx success (header ignored) | 409 `organization_context_changed`, matching session event-type writes |
| Session webhook writes: ordinary member of the expected current team | 403 `insufficient_role` | 403 `team_management_access_denied` |
| Session webhook writes and reads with the optional header: the expected team differs from the current space | Header ignored; request used the current organization | 409 `organization_context_changed` when the caller still owns/administers the expected team, otherwise uniform 403 `team_management_access_denied` |
| Session webhook writes: the caller's own expected personal organization differs from the current space | 2xx success (header ignored; request used the current organization) | 409 `organization_context_changed` |
| Session webhook reads: malformed expected ID or a different expected personal organization | 200 (header ignored) | 403 `team_management_access_denied` |

### Team single sign-on

Read provider summaries at `GET /api/v1/team/sso/providers` and the team policy at
`GET /api/v1/team/sso/policy` as a current, verified team owner or administrator.
REST accepts a browser session or a `read` or `full` API key for the team. On an
enforced team use a session with live SSO proof or a key with a usable delegation.
A machine request missing that delegation gets `403 sso_required`. An enrolled
owner can also read these two resources from the browser with a live recovery grant.
When recovering from another space, send the grant's team ID in `X-Expected-Organization-Id`.

SSO writes under `/api/v1/team/sso` require a browser session, its exact same-origin
`Origin` and `X-Expected-Organization-Id` for the intended team. Omit the
`Authorization` header. Follow the operation's proof and revision requirements.
When a write returns `403 sso_reauthentication_required`, complete its returned
`proofMethods` in the same browser and retry the same input with the returned
`attemptId` as `proofAttemptId`. Use a fresh recovery verification for each
recovery-authorized write.

Both protocol settings default to on. The two reads remain available to authorized
callers in every settings combination. Trust-adding requests through an off protocol
return `404 sso_disabled` and stored team enforcement continues.
See the [REST quickstart](https://hourmere.com/docs/rest#read-team-single-sign-on-configuration)
and [operation contracts](sso.md#proposed-rest-mcp-and-cli-contracts).

中文：读取提供方与策略需要当前团队所有者或管理员权限。强制 SSO 的团队还要求浏览器证明，
或密钥的有效委托。SSO 写入仅接受同源浏览器会话，须提供目标团队的
`X-Expected-Organization-Id` 并省略 `Authorization`。如需新鲜证明，在同一浏览器完成后
用原输入及 `proofAttemptId` 重试。两种协议默认开启，关闭协议时已有强制策略继续生效。

### Group booking fields and privacy

Event-type configuration adds `bookingMode` (`individual` or `group`) and nullable
`groupCapacity` (2–100 for group mode). Authenticated booking projections add optional
`groupSlotId` for group seats. Clients must tolerate absent additive fields on older
servers. Each booking still represents one independent seat. The occurrence attendee
endpoint returns private names, email addresses, answers, status and no-show metadata
only after host/current-membership authorization; non-host team owners/admins require
a browser session. Public and invitee-management reads never return the roster.
See [group events](https://hourmere.com/docs/group-events) for operations and constraints.

Occurrence attendee lists default to confirmed seats (`status=active`); request
`status=cancelled` or `status=all` for retained cancellation history. Lists are bounded
by `limit` (1–100, default 25) and `offset` (0–10000, default 0), returning
`pagination: {limit, offset, hasMore}`. REST query parameters and MCP/CLI JSON inputs
share these rules. Each page is a snapshot, ordered by creation time and booking ID;
concurrent changes can move records between requests. Switching an event type back to
individual mode requires both `bookingMode: "individual"` and `groupCapacity: null`
in the same update because omitted fields retain their saved values.

Attendee pagination stops at offset 10000; `hasMore` indicates another permitted page,
not whether older retained history exists beyond that bound.

中文：名单翻页最多到偏移量 10000；`hasMore` 表示还有可请求的下一页，
不保证该范围之外没有保留的历史记录。
