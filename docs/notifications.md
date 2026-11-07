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

Group occurrence host mail is drained in batches during each minute's worker run;
the batch size does not limit an instance to four messages per minute. The worker
starts new attempts for up to 230 seconds, leaving time for a bounded SMTP attempt
before its five-minute job expiry. Remaining rows stay durable for the next run.
Shared instance hourly mail limits (including the host reserve), per-message receipts,
coalesced calendar updates, and finite retry limits still apply. Reminders expire at
the occurrence start, so an SMTP outage or a backlog exceeding the worker's time
budget can still prevent delivery before that deadline.
