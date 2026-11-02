[API conventions](https://hourmere.com/docs/api-conventions).

### API key scopes

Keys have one immutable scope: `full`, `read` or `bookings`. The web creation form defaults
to `bookings` for AI agents; `read` suits analytics/reporting, and **Full account access**
(`full`) also permits account configuration changes. Existing roles, ownership and host
visibility still apply. Neither `read` nor `bookings` removes existing visible attendee
details or meeting links, and `bookings` can manage previously created bookings you host.

Native creation accepts `metadata.scope` with one of those exact values; omitting it keeps
`full` compatibility, including absent/null metadata. Legacy keys were migrated to `full`.
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
