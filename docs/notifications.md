[Notifications and background jobs](https://hourmere.com/docs/notifications).

Cal.com/cal.diy imports use durable `source=import` local-only bookings. Their empty
notification snapshots do not authorize confirmation delivery. Every enqueue, retry,
recovery, repair and worker entry checks the persistent policy, including connected
reschedule chains and stale artifacts from before a restart. No mail, ICS, calendar,
conference, webhook or scheduled-message delivery is produced for them. Bounded dispatchers
exclude import-connected records before applying their page limit so ordinary work can
continue behind stale imported intents. See [Cal.com imports](calcom-import.md).

If the original inviter leaves or is removed from the team, their pending invitations are
no longer valid. Neither resend nor the expired-row replacement action can reuse them:
both refuse with `INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION`.
Acceptance uses the same error code.
Native recipient invitation discovery omits these rows. They grant no signup exception:
an otherwise ineligible address receives no sign-in email and cannot create an account.
A current owner/admin must cancel any old pending invitation and send a fresh invitation
in their own name through the invite form.
The administrator list shows **No longer valid**, with derived `invalidReason: "inviter_left"`;
cancellation remains allowed. Demotion while the inviter remains a member leaves validity
unchanged. These checks do not rewrite the invitation's stored lifecycle.
