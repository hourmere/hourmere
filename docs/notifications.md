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

## Staged booking handoff mail

A committed departure handoff queues a cancellation for the original booking and a
confirmation for the replacement. Both notices explain the host change in the recipient's
mail language. A booker or guest may receive either notice first.

The cancellation uses the original calendar UID and saved organizer, with the sequence one
higher than the last version of that event. If the organizer was never saved, recipients get
a plain-text cancellation and may need to remove the original event from their calendars
manually. The replacement uses a fresh UID and starts at sequence zero. Its invitation and
manage link belong to the replacement booking.

The staged administrator receipt reports when the mail server accepts each notice for all
attendees. Refresh the handoff status after the background worker runs. Mail-server acceptance
does not confirm inbox receipt. Replaying a committed handoff does not queue another notice.
Production admission remains off.
