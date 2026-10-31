[API conventions](https://hourmere.com/docs/api-conventions).

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
