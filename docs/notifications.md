[Notifications and background jobs](https://hourmere.com/docs/notifications).

If the original inviter leaves or is removed from the team, their pending invitations are
no longer valid. Neither resend nor the expired-row replacement action can reuse them:
both refuse with `INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION`.
Acceptance uses the same error code.
A current owner/admin must cancel any old pending invitation and send a fresh invitation
in their own name through the invite form.
The administrator list shows **No longer valid**, with derived `invalidReason: "inviter_left"`;
cancellation remains allowed. Demotion while the inviter remains a member leaves validity
unchanged. These checks do not rewrite the invitation's stored lifecycle.
