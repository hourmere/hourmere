[Notifications and background jobs](https://hourmere.com/docs/notifications).

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

## SMS reminders

Operator-configured Twilio supports per-event-type booking reminders for explicitly
consenting invitees. The signed inbound webhook applies instance-wide STOP suppression
under the same transaction fence as send reservations. SMS jobs and failures are separate
from email delivery. See [SMS reminders and opt-out](https://hourmere.com/docs/sms-provider)
for setup, consent, replay protection, limits and delivery limitations.
