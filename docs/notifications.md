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

## Internal meeting-poll credential mail

Meeting polls have internal delivery workers, but no public or host transport yet.
`meeting-poll-email-v1` scans durable invitation, verification and recovery intents every
minute in `worker` and `all` roles. Messages use the voter's saved language and time zone,
with complete English, Simplified Chinese, German, French, Spanish and Brazilian Portuguese
copy. They never look up account membership or include other voters, ballots, booking
management links, conference links or calendar files. Links carry credentials only in
fragments and target the later voter and reminder opt-out pages; opening a link itself
neither verifies nor votes. Host creation remains unavailable until those pages land.

Each transaction checks the meeting-poll key fence before locks or ciphertext access.
Internal workers use `BETTER_AUTH_SECRET` for the poll key. Claims lock the poll before
its delivery row; SMTP runs outside transactions. A committed claim has a five-minute
lease, consumes an attempt and reserves the shared notification instance/hour and
recipient/hour/day budget atomically. Defaults remain 100 instance messages/hour and
5 recipient messages/hour, 20/day; configured limits apply. These reservations share
booking-mail recipient accounting. Failed, interrupted and uncertain sends conservatively
consume budget, so concurrent workers cannot exceed a last available slot. Public request
and host actor/organization admission wiring belongs to the later transport steps;
existing poll/mailbox recovery and resend cooldowns and caps remain unchanged.

Temporary failures retry after 1, 2, 4 and 8 minutes, with at most five attempts including
crashed claims. Permanent failures and missing SMTP configuration stop delivery. Terminal
sent, suppressed or skipped rows erase their ciphertext. Recovery repeats the current
credential unchanged; it sends nothing after public pending expiry or the poll deadline.
Only recovery can send after early closure. Cancellation, scheduling, withdrawal, removal,
event deletion and superseded credentials suppress unsent work. Voting mail also includes
an independent reminder opt-out capability, stable across recovery and resend.

A state change after the final eligibility check can race an in-flight SMTP send; the
credential's service checks still enforce current authority. SMTP acceptance followed by
a failed receipt commit can cause a duplicate when the lease expires. This is the existing
mail acceptance/receipt window, bounded by attempts and budgets, not an exactly-once claim.
No raw provider/database error or capability is logged; without SMTP, sensitive poll mail
is skipped rather than sent to the development log mailer.

`meeting-poll-capability-expiry-v1` clears expired capability ciphertext hourly in batches
of at most 500, skipping locked polls and capabilities. It retains digest-only credentials
for permitted read-only history. Poll/voter deletion and the existing cleanup cascades
continue to remove their dependent private data. No migration or feature flag is added.
