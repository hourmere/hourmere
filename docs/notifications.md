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

For phone locations, booking emails and calendar invitations state who calls whom. A phone
number collected from the invitee is included only for hosts and that invitee. Guests receive
“Phone call — the host will call the invitee” without the number, including confirmations,
reschedules, cancellations and reminders. Configured reminders use the same recipient policy;
follow-ups contain no meeting location. The booking's saved location-option snapshot determines
this policy even after the event type is edited or the booking is rescheduled. Host-provided
phone numbers remain shared with attendees so they can call the host. Ordinary provider calendar
copies remain host-only busy-time records and do not currently include meeting locations.
