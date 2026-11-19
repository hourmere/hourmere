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

## Meeting poll deadlines

When voting is still open, eligible nonresponders receive at most one reminder per poll
and mailbox. It is due 24 hours before the deadline if the poll already existed at that
time. The reminder includes their voting link and a separate link to stop reminders.
The opt-out page requires confirmation and works without signing in. It does not change
the recipient's ballot.

The hourly cleanup records closure at the voting deadline and queues a notice for the
creator if they still manage the event. The notice contains the deadline, response count
and an authenticated results link. Closing a poll early does not send this notice.
Both mail types use the shared instance and recipient mail budgets. The workers and
opt-out page are available without a feature flag. Poll creation has yet to be exposed.

See [Meeting polls](meeting-polls.md#notifications-abuse-and-time-zones) for the full
eligibility and privacy rules.
