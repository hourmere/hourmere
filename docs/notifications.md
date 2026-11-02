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

Collective booking emails name all current verified required hosts, with locale-aware list
formatting. Subjects with more than three names abbreviate the remainder by count; bodies
and calendar summaries/descriptions retain every name. Host emails show co-host names only.
Invitee/guest Reply-To contains every current verified required host as separate mailboxes
(duplicates collapsed and invalid addresses omitted); host replies go to the booker.
Single-host and round-robin replies still go to their one assigned host. This does not alter
the configured From, the pinned calendar organizer or calendar RSVP routing. Host booking
links include an organization context hint; the app verifies membership before switching.
