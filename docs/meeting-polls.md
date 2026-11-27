# Meeting polls

Hosts create and manage a poll in a personal or team space or through REST, MCP and CLI.
Voters use the no-login browser page or public REST operations. The same public
operations are available through authenticated MCP and CLI connections. These surfaces
are available on self-hosted installations without a meeting-poll feature flag.

For setup and voting, see the [host guide](https://hourmere.com/docs/meeting-polls) and
[voter guide](https://hourmere.com/docs/meeting-poll-voting). For request and response
examples, see the [REST, MCP and CLI guide](meeting-polls-api.md). This reference
describes the lifecycle, authorization, storage and delivery behavior. Related
references include the [data model](data-model.md), [API conventions](api-conventions.md),
[MCP contract](mcp.md) and [notification system](notifications.md).

## Verified competitor behavior

Historical research as of 2026-11-06.

Calendly's [Meeting Polls overview](https://calendly.com/help/meeting-polls-overview)
says anyone with the link can vote without an account, supports up to 40 times and 40
participants, disallows adding times after publication and changing submitted votes,
and does not support workflows or rescheduling. The host chooses a time and can add
non-voters before booking. Voting closes on booking, deletion, or when all times pass.
Other voters are visible only with “Show votes on page” enabled. External conflicts are
flagged, but the time remains visible; Calendly booking conflicts cannot be booked over. Buffers can be overridden.
The [setup guide](https://calendly.com/help/how-to-set-up-a-meeting-poll) describes choosing
zone, duration and additional hosts, showing invitees their own zone, sharing a unique
link, and sending calendar invitations after the host books.

Cal.com's [official help index](https://cal.com/help/llms.txt) and
[Help Desk](https://cal.com/help/welcome) were checked. The related documented capability is
[Booking proposals](https://cal.com/help/event-types/propose-multiple-times): an attendee
proposes 1–10 times, then the host confirms one or declines. Requests expire after 48 hours
or the last proposed time, whichever is sooner. Busy candidates cannot be confirmed.
Proposals are unavailable on seated, recurring or paid links. Times remain available by
default; confirmation settings can hold them. Round-robin hosts receive their own proposed
times. The documented feature is attendee-to-host negotiation. The research did not find
official documentation of a Cal.com host-created multi-voter poll.

## Create and manage a poll in the app

In **Meeting polls**, choose **Create meeting poll**, select a saved event type and
meeting length, then pick 2–20 offered times. Times follow the selected display time
zone, including clock changes. Set a voting deadline and choose who can join and
whether verified voters can see vote totals. Proposing times does not reserve them.

Copy the public voting link when it is shown after creation or replacement. The app
cannot recover the original link if the response was lost or the disclosure was
closed. Replace it from the invitation roster if needed. Replacement immediately
invalidates the old public link while preserving links emailed to individual voters.

Use the invitation roster to send batches of up to 40 invitations, resend an
invitation, or remove a voter. Verified voters, active invitations and unexpired
public sign-ups share the 40-place cap. A batch that requires more places than remain
is refused in full. Resend replaces the voter's link and is limited to once every
15 minutes and three times per address for the poll, subject to shared mail limits.
Removing a voter deletes their ballot and contact details and revokes their links.
Bulk removal clears unverified public sign-ups and preserves host invitations.

## Poll behavior and authority

A poll proposes one meeting, with one event type, one selected allowed duration and a
fixed candidate set. It is created directly as `open`; no draft rows or automatic winner.
The three vote values are `yes`, `if_need_be` and `no`. Results count them separately.
An unanswered slot adds nothing to any count. A submitted ballot answers every candidate.
The host chooses the time and attendees.

Personal event owners may manage their polls. Current team owners/admins may manage polls
for event types in that team; ordinary members, including configured hosts, do not gain
poll administration. Creator attribution is not enduring authority after departure or
role demotion. Reads, writes and replays check current event ownership, organization
membership and role. The event type supplies the hosts. Session writes require the
existing same-origin and `X-Expected-Organization-Id` rules. API keys remain bound to their
organization. Session and team changes use the existing authorization lock order. The
app shows a neutral state when readiness is unknown.

API-key scopes are `full` or `bookings` for host and public writes, and `full`, `read` or
`bookings` for private list, detail and results. Public POST `read` is `booking_read` with `optional_key` authentication
and accepts `full`, `read` or `bookings`; rotate-link and bulk remove-unverified are host
booking writes, requiring `full` or `bookings`.
No scope bypasses owner/admin checks. `read` cannot vote or mint capabilities. MCP OAuth
keeps its existing `mcp:tools` grant and organization authority. Public capability access
requires no key; if a bearer is supplied, validate its scope without anonymous fallback.
An agent may relay a voter's explicit choices using that voter's capability; a host key
alone cannot impersonate voters or recover their edit tokens.

Creation uses the event's duration, location and booking questions. It snapshots the
title, duration, location configuration, questions, scheduling mode, host IDs and guest
policy for stable voter disclosure and stores a canonical settings hash. Finalization
compares it with current settings. A mismatch returns `poll_event_changed` and requires a
new poll. Availability, buffers, notice, booking windows,
limits and calendar freshness always use current policy. Notification policy is snapshotted
by the booking service when booking. Disabling/deleting the event or losing eligible hosts
prevents finalization. The public snapshot omits private connection IDs.

## Voters, visibility and booking participants

The two admission modes are `public_link` and `invited`. Voters can join without
an Hourmere login. They supply a name and email address and verify mailbox access before
their ballot counts. Unverified public-link enrollees receive only verification mail;
host invitees may also receive the reminder and outcome notices defined below. A high-entropy per-poll link allows enrollment;
invited mode permits only host-added addresses and sends separate per-voter capabilities.
Opening a link with GET never votes or confirms anything. Possession of an emailed voter
capability proves mailbox access for this poll, not an account identity. Use one normalized
(trimmed, lowercase) mailbox per poll, without provider-specific alias folding.

Public enrollment answers uniformly whether the mailbox exists, is pending, or has voted;
it neither returns an existing token nor overwrites that person's ballot. When enrollment
capacity is full, every enrollment request instead returns 409 `poll_full`, independent
of mailbox state, without sending mail; recovery remains a separate uniform 202 operation.
Verification sends a protected edit link under mail budgets. Count active verified voters,
active host invitations (verified or not), and unexpired public pending reservations once
each toward the 40-place enrollment cap, independently of booking capacity.
Only public-link self-enrollment has a one-hour pending expiry, or the deadline if
earlier; recovery never extends it. Derive expiry under the poll lock before checking
capacity, so capacity never waits for a cleanup worker; expired public credentials cannot verify.
Host invitations reserve capacity atomically at invitation time, are accepted only while
voting is open, and keep their place and
valid voting credential until the deadline, withdrawal, removal or host revocation.
Public-link saturation cannot displace an invitee or force them to reacquire their place.
Host revocation uses remove-voter. Poll closure/cancellation/deletion also stops voting.
Expired public enrollees must enroll again; withdrawn/removed/expired public reservations
no longer count. Invitation batches are all-or-nothing: after mailbox deduplication,
if new reservations exceed remaining places, reject the entire batch with 409 `poll_full`,
without rows or mail intents. A submitted batch over 40 entries instead gets 400
`poll_limit_exceeded`; no prefix is accepted.
Invited-mode polls have no public enrollment capability (`public_token_digest` is null).
Lost-mail recovery accepts the nonsecret poll ID plus mailbox in either mode with uniform
202; it sends only to an existing eligible voter and never admits an uninvited address.
Recovery re-delivers that voter's current credential unchanged; it never creates, rotates
or revokes a credential, so knowing a poll ID and someone's address cannot invalidate their link.

An invitation entry whose mailbox the poll already knows is resolved under the poll lock
before the capacity check. Only outcomes below that reserve a new place count toward the
all-or-nothing rule, and the 202 response reports each entry's outcome without secrets:

| Mailbox state in the poll | Invitation outcome |
|---|---|
| Active host invitee, verified or not | Unchanged: no new place, credential or mail; lost mail uses resend |
| Verified public-link voter | Unchanged: keeps its place, credential and ballot; no mail |
| Unexpired public pending enrollee | Upgraded to an invitation: pending expiry and IP digest cleared, verification credential revoked, invitation mail with a voting credential; still one place |
| Withdrawn voter | Unchanged: withdrawal opted out of poll mail; only the voter's own capability can reactivate. A host who removes and then re-invites the address overrides this deliberately and sends one invitation; a reminder opt-out still applies |
| Expired public pending enrollee | Invited as new: the expired row is replaced and a new place is reserved |
| Removed mailbox | Re-invited: the host's explicit invitation clears the removal tombstone and reserves a new place; mailbox counters persist, and the invitation spends one resend under the resend cooldown and cap |

The enrollment and verification services apply the same rules through REST, MCP, CLI
and the web app.

- Every voter write serializes on the poll row. Host invitations and resends keep the
  lifecycle order (organization-write hook, actor user, organization and membership
  `FOR SHARE`, poll `FOR UPDATE`, event `FOR SHARE`). Public enrollment, verification and
  recovery first take public booking's organization locks (a personal owner's user, then
  the organization, `FOR SHARE`), then the same poll and event locks. Neither takes host
  booking locks. The database clock is read once after those locks.
- Enrollment decides capacity (409 `poll_full`) and then the per-IP cap (429
  `rate_limited`, Retry-After until that IP's earliest reservation expires) before it looks
  at the mailbox, so neither answer depends on the mailbox's state. The IP digest is keyed,
  per poll, with IPv6 addresses grouped by /64.
- Verification of a public enrollee consumes the verification credential, mints a voting
  credential and mails it in the same transaction as a `verification` delivery at that
  credential's generation, under the same mail budgets as every poll mail; the response may
  also return it once. Mailing it restarts the mailbox's recovery count. Delivery workers
  tell the two verification mails apart by the credential's purpose. An invitee's emailed
  voting credential verifies and stays the same, so nothing new is mailed. Repeats return
  the voter's own state and mint or mail nothing. Recovery is for genuinely lost mail.
- Verification and voting credentials share one generation line per voter, so a delivery's
  generation names exactly one credential. Each credential keeps its digest (domain-separated
  by purpose) and an AES-256-GCM copy bound to organization, poll, voter and generation;
  queued mail carries the same copy. Revocation or consumption erases the copy and skips
  that credential's pending mail.
- A soft-deleted event closes admission: enrollment, verification, invitation and resend
  get 409 `poll_closed`, and recovery sends nothing. Invalid voter fields get 400
  `invalid_voter`, except an invalid voter time zone, which gets 400 `invalid_time_zone` as
  in booking; a resend to a withdrawn invitee gets 409 `voter_withdrawn`, and a resend to a
  voter who is not an invitee gets 404 `poll_not_found`.
- Repeated mailboxes in one invitation batch are one entry. An invitation's language
  defaults to English and its zone to the poll's display zone. Host results contain each
  entry's outcome (`invited`, `upgraded` or `unchanged`), voter ID and current roster
  state, never a credential; an exact replay reports every entry as `unchanged` with its
  current state.
- REST and MCP share durable request budgets across server processes. Credential
  delivery applies shared instance and recipient mail budgets and mints the
  purpose-limited reminder opt-out credential included with voting mail.

Removal deletes the voter row with its votes, capabilities and deliveries and
records `removed_at` on the mailbox counter row, whose `email_key` digest alone blocks
self-enrollment until poll deletion. Expired public pending rows stop counting at once;
the next enrollment or invitation of that mailbox replaces them and the bounded cleanup
deletes the rest. No name, address, answer or IP digest therefore outlives removal or
expiry cleanup. A withdrawn voter keeps its row with name, mailbox and zone/locale for
uniqueness and reactivation, but without votes, responses, join consent or IP digest (cleared at
verification, never set for invitees). Re-enrollment or re-invitation creates a new voter ID, while the resend,
recovery, reminder and opt-out records on the mailbox counter row persist until poll deletion.

A voter confirms mailbox possession with an explicit POST using the emailed capability;
merely reading the page does not verify or submit consent. A verified voter can replace
their complete ballot or withdraw while voting is open. Withdrawal removes the ballot
from counts, clears answers and opts out of further poll mail. The retained contact and
mailbox data support uniqueness and reactivation until poll deletion. Reactivation before closing requires
that same capability, renewed consent and an atomic capacity check. Withdrawal suspends
voting authority but retains the credential solely for read-only access and explicit
reactivation; removal or host revocation invalidates it entirely. Name/zone/locale may
be edited before closing; changing email requires a new verified enrollment. Lost links
use rate-limited mailbox recovery with uniform responses, never a host read.

The ballot service applies these rules to voting, withdrawal and reminder opt-out.

- Ballots, withdrawals and opt-outs take the public voter locks (a personal owner's
  user, then the organization, `FOR SHARE`; the poll `FOR UPDATE`; the event `FOR SHARE`)
  and read the database clock once after them. Ballots and withdrawals need an open poll,
  an existing event and that instant strictly before the deadline: the deadline instant
  itself is closed, and a write that waited for the poll lock while the deadline passed gets
  409 `poll_closed` (409 `poll_canceled` on a canceled poll).
- A ballot uses the voting credential. It answers every candidate exactly once with `yes`,
  `if_need_be` or `no`, gives join consent and answers the booking questions of the poll's
  settings snapshot; otherwise it gets 400 `invalid_ballot` (also for a malformed
  `expectedBallotRevision`; 400 `invalid_responses` for the answers, as in booking) and
  writes nothing. It may also edit name, zone and locale, with 400
  `invalid_voter` or `invalid_time_zone`. It replaces the previous ballot whole and records
  submission and consent at the decision instant. An invitee's first ballot also confirms
  the mailbox.
- Every accepted ballot, replacement, withdrawal and reactivation checks
  `expectedBallotRevision`, the revision last returned (0 until the first ballot or
  withdrawal; 409 `poll_changed` when stale), and advances the voter's ballot revision and
  the results revision by one. No voter write moves the host revision; opt-out moves neither.
- Withdrawal uses the voting credential, so an invitee may withdraw before confirming the
  mailbox and stays unconfirmed; a pending public enrollee lets the reservation expire.
  Withdrawal erases the ballot, votes, answers and consent, frees the place and skips the
  voter's queued mail; the credential and its encrypted copy stay for reactivation. A repeat
  at the current revision writes nothing. A ballot from the withdrawn state is the
  reactivation: it takes a place again under the 40-place cap and poll lock, or gets the same
  409 `poll_full` as admission. Verifying a withdrawn voter mints, consumes and mails nothing
  and answers like a repeat.
- Verification and opt-out credentials never vote or withdraw, and voting credentials never
  opt out: each gets the same 404 `poll_not_found` as an unknown, revoked or removed
  voter's credential.
- Opt-out uses the `reminder_opt_out` credential that credential delivery mints. It records
  the mailbox's first `reminder_opted_out_at` on the counter row and skips the voter's queued
  reminders, without verification, ballot access or a revision. As a mail preference it is
  honoured whatever the poll's state and the credential's expiry while the credential is
  unrevoked; a repeat writes nothing. It returns the opted-out state, not a ballot.
- Each ballot and withdrawal returns the voter's own ballot; reading it after the deadline
  uses the public read operation.

Managers can remove a voter or revoke a pending enrollment while open or closed. Removal
revokes capabilities and queued mail, erases answers/ballot/contact data, frees capacity
and retains only a mailbox digest to block self-reenrollment until poll deletion; only a
later host invitation re-admits that address. No removal email is sent. Scheduled polls require booking lifecycle operations for attendee
changes. Managers can close voting early, cancel an unscheduled poll, or delete a poll in
any state; deleting a scheduled poll erases poll history without canceling its booking.
Deletion revokes all poll links and pending deliveries and follows the privacy cascade
below. These operations use current authority, `expectedHostRevision` and the common poll lock.
Removal targets the voter, not a ballot snapshot, so it does not check that voter's ballot
revision; a retry after a lost response gets 404 `poll_not_found` for the deleted voter ID.

The results and removal services share the following rules across transports.

- Results, removal and bulk removal take the key fence first, then the host order of the
  lifecycle services (organization-write hook for the two writes, actor user, organization
  and membership `FOR SHARE`, the poll, the event `FOR SHARE`) and decide with one database
  clock reading after those locks. Removal locks the poll `FOR UPDATE` before it touches a
  voter row. The results read locks the poll `FOR SHARE`, so no voter or host write commits
  between the results revision it returns and the rows it counts. Read keys may read
  results. Because results read voter rows they take the fence as well: a mismatched secret
  refuses them (poll metadata without voters stays readable), and on an installation
  without keyed data their first read records the secret, as any voter service would.
- The results projection, in any poll state, returns the poll metadata with its host
  revision, the results revision, the number of counted ballots and, per candidate,
  separate `yes`, `if_need_be` and `no` counts of counted ballots only: those of verified,
  non-withdrawn voters with a submitted ballot. A voter without a ballot is never counted as
  `no`. Pending reservations are judged live at the read's instant; their expiry moves no
  revision. The roster lists every voter with name, mailbox, status, zone, locale, invitation,
  verification, withdrawal and pending-expiry instants, ballot revision, submission and
  consent instants, votes and answers; removed voters and expired public reservations are
  absent, and no credential or digest appears. The shared results service adds advisory
  availability after the locked snapshot commits, using current schedules, bookings and
  cached busy intervals. Candidate `availability` is `available`, `unavailable` or
  `unknown`. Stale calendar coverage can yield `unknown`. Scheduled and canceled polls
  report `unavailable` because no further selection is possible. Availability changes
  independently of the results revision and finalization rechecks current conditions.
- Removal works while the poll is open or closed, including closure by the deadline and a
  soft-deleted event; a scheduled poll gets 409 `poll_already_scheduled` and a canceled one
  409 `poll_canceled`. The voter lookup precedes the `expectedHostRevision` check, so a
  retry gets 404 `poll_not_found`; an expired public reservation is already absent and also
  gets 404. Removal deletes the voter row, so its votes, credentials and deliveries go with
  it, and upserts `removed_at` on the mailbox counter row, leaving its resend and recovery
  counts, reminder receipt and opt-out unchanged. It advances the host and results
  revisions once and sends no mail. A removed public reservation no longer counts toward
  its IP's three pending reservations, since no IP digest outlives removal.
- Bulk removal checks `expectedHostRevision` and removes exactly the unverified public
  enrollees holding a live reservation, in voter ID order, each behind a tombstone as above.
  Host invitees, verified and withdrawn voters and expired public reservations stay. With
  nothing to remove it writes nothing and moves no revision; in invited mode there is never
  anything to remove. It has no replay key, so a retry after a lost response gets 409
  `poll_changed` and the host rereads the results.
- Re-invitation of a removed mailbox is the invitation service's `invited` outcome: a new
  voter ID, a new place under the cap and one invitation mail. Because it mails the mailbox
  again, it is a resend: it needs the mailbox's resend budget, which removal never resets (at
  most three per poll and mailbox, one per 15 minutes), spends one resend and restarts the
  cooldown. Over budget, the whole batch is refused with 429 `rate_limited`, after the
  capacity check and without rows or mail, with Retry-After only when every refused mailbox
  is cooling down rather than capped. Otherwise the tombstone clears; reminder receipt and
  opt-out stay. The recovery count and cooldown restart because a new credential was mailed.
- Removal is refused on canceled and scheduled polls, so erasing one voter's data there
  needs whole-poll deletion (a known limitation). Expired public reservations are erased by
  the cleanup below.

The cleanup service and poll deletion apply the storage policy described below.

- `cleanupMeetingPolls` in `packages/scheduling/src/meeting-poll-cleanup.ts` runs one bounded
  page per call, each part in its own transaction of up to `MEETING_POLL_RETENTION.batchSize` rows: expired public
  pending voters, terminal polls past retention (at most 10 polls per transaction, each
  bounded by the admission caps) and the replay tombstones of deleted polls once their purge
  instant has passed. The hourly worker job `meeting-poll-cleanup-v1` runs up to 50 pages
  in at most 45 seconds and then queues one successor for a backlog.
- Cleanup never waits for a lock. It takes the public voter order, a personal owner's user
  and then the organization `FOR SHARE`, then the poll `FOR UPDATE`, each with `SKIP
  LOCKED`, reads the database clock once after them, and deletes voter rows only under
  their poll's lock. A poll that a ballot, host write, booking or organization deletion
  holds is skipped and found on a later run. Organization deletion holds the organization
  and then cascades through voter rows before the poll. Cleanup locks the organization
  before the poll. It takes receipt rows with `SKIP LOCKED` alone. Cleanup moves no
  revision and needs no installation secret, so it takes no key fence.
- An expired reservation already stopped counting toward capacity, an IP's pending
  allowance and the results at its expiry instant, so a delayed worker never retains one.
  Cleanup deletes the voter row with its votes, credentials and deliveries; the mailbox
  counter row stays for the poll's lifetime without a removal mark, so the mailbox may
  enroll again.
- Terminal cleanup measures retention from scheduling, cancellation or closure, and from
  the deadline for an open poll whose deadline passed. The service accepts an internal
  retention period in days. The shipped worker supplies none, so terminal polls stay until
  explicit poll, linked-booking or organization deletion.
- `deleteMeetingPoll` needs only `expectedHostRevision` and the host
  order, so ballot churn never makes it fail with `poll_changed`; voter and host writes
  queued behind it get 404 `poll_not_found`. It takes no key fence either, which keeps the
  invalidation procedure of the key-fence section available under a new secret. Deletion,
  terminal cleanup and the linked-booking trigger delete the poll row, and the 0071 cascades
  remove candidates, voters, votes, credentials, deliveries and mailbox counters; receipts
  keep only the organization ID and the unkeyed actor digest, with poll and booking
  references cleared and a purge instant 90 days later. Since migration
  `0088_meeting_poll_receipt_tombstones.sql`, every receipt but `create` also has its request
  fingerprint replaced by 32 zero bytes, because an invitation's fingerprint is an unkeyed
  digest of invitee names and mailboxes; only create replays read a tombstone, and the create
  fingerprint covers event, candidates, deadline and settings, nothing person-derived. The
  row stays until its purge instant, so a reused key is still refused. A linked booking is never deleted
  by poll deletion. Deleting the original linked booking first deletes the poll the
  same way. Booking deletion locks the booking and then the poll.
  Booking cancellation and reschedule likewise lock the booking (and, for a reschedule, its
  hosts) before the scheduled poll, and only for a booking whose chain an unlocked read found
  poll-linked. Finalize locks a poll before the hosts in the opposite order, but only while
  that poll is unscheduled (`booking_id` still null), and the lifecycle lookup matches only
  scheduled polls joined on `booking_id`, so the two never wait on each other. A poll's
  `booking_id` is written only by finalize, in the transaction that inserts the booking, and
  is never re-pointed, which keeps that unlocked read sound.

Privacy default is `private`: voters see only their own choices and the candidate list,
not other names, email addresses, answers or totals. A host can choose `aggregate` at
creation, exposing per-candidate yes/conditional/no counts to verified voters using
their own voting link while they remain active.
With two or three voters, totals minus one's own ballot can reveal another person's
choices. Creation and voter pages disclose this risk. The setting is immutable after
publication. The private host view contains roster information, ballots, answers and
verification and withdrawal states. A public-link reader or withdrawn voter cannot
see counts. The public outcome gives the chosen time and poll status. It omits the
booking ID, other voters' information, management capabilities and conference links.

Finalization explicitly supplies `bookerVoterId` and `attendeeVoterIds`. All must be verified,
non-withdrawn voters with yes or conditional votes for the chosen slot and consent to join.
There must be a booker included in that set; no/no-response voters cannot be silently added.
The host may select a subset and must acknowledge conditional votes in the confirmation
payload. Finalization records each selected voter's booker or guest role for outcome
delivery and later booking updates. Eligible voters who were not included receive a
time-selected notice without a join link or calendar invitation. The voting page
explains selection and the booker's authority over the whole meeting.

Finalization maps the booker to the ordinary booking invitee and other selected voters
to guests. Multiple attendees require `allowGuests`. The attendee limit is
`MAX_GUESTS + 1` (11 including the booker), using `MAX_GUESTS = 10` from
[`bookings.ts`](../packages/scheduling/src/bookings.ts). Exceeding it returns
`too_many_guests`. Each voter answers the event's questions with their ballot.
Finalization passes the designated booker's validated answers into the booking.
Other answers stay in the poll until deletion. The host cannot supply missing required
answers on the booker's behalf. Poll mail uses each voter's saved zone/locale; ordinary
booking guest messages retain the existing booker-language/zone behavior. The voting page discloses that the ordinary calendar invitation can reveal attendees to
one another.

## Installation secret and key fence

The voter services derive three keys from one installation secret, `meetingPollSecret`,
with HKDF: the mailbox digest (`email_key`), the admission IP digests and the AES-256-GCM
key of retained credentials. Capability digests and the public-link digest are unkeyed.
Data written under one secret is therefore unusable under another: the same mailbox would
enroll a second time, a removed mailbox would pass its tombstone, a re-invited invitee would
take a second place, recovery would find no voter and stored ciphertexts would not open.

Migration `0084_meeting_poll_key_state.sql` adds the one-row `meeting_poll_key_state` table.
It records a keyed fingerprint of the secret the data was written under: an HMAC-SHA-256
under its own HKDF subkey, never the secret. `ensureMeetingPollKey` in
`packages/scheduling/src/meeting-poll-key.ts` is the fence:

- Every voter service (enrollment, verification, recovery, invitation and resend, and
  likewise ballots, withdrawal, opt-out, results and removal) calls it first in its
  transaction, before any row lock. It runs only in READ COMMITTED
  transactions, so its reads after the lock see writers that committed meanwhile; other
  isolation levels are refused. Under the recorded secret it takes a shared transaction
  advisory lock and continues.
- A secret is recorded only while no keyed data exists, at first use or replacing another
  one: no voter row and no mailbox counter. Every stored ciphertext belongs to a voter, and
  removal tombstones live on counters; polls without voters hold no keyed data. A missing
  fingerprint beside keyed data (a row deleted by hand) therefore refuses every secret.
- Recording takes the lock exclusively, so concurrent first uses serialize to one row, a
  change waits for every in-flight voter write and then sees its data, and a write that read
  the old fingerprint before a change committed is refused. Another secret is refused
  without taking the lock once keyed data exists, so a misconfigured process never stalls
  correctly configured ones.
- A refusal throws `MeetingPollKeyMismatchError` (code `meeting_poll_key_mismatch`, a
  message without secret material) and the transaction writes nothing. No enrollment,
  invitation, verification, recovery mail or resend happens under another secret, and
  recovery for a well-formed poll ID fails instead of answering 202 with nothing queued.

Public transports and internal credential-delivery and expiry workers use
`BETTER_AUTH_SECRET` as the meeting-poll secret and call the fence in every transaction.
Startup calls `ensureMeetingPollKey` before serving requests. Workers that open, mint
or store credential ciphertext call it first in each transaction, before any row lock or
claim. This lock order prevents a deadlock between a worker holding a poll or delivery row
and a voter service holding the key fence. `meeting-poll-key.test.ts` checks that exported
voter services take the fence.

Operators must keep the meeting-poll secret stable and back it up with the instance's other
secrets. If it changes while keyed data exists, the startup check and every voter operation
fail closed with `MeetingPollKeyMismatchError`. With keyed data present, a missing fingerprint
causes the same refusal. Choose the recovery procedure that matches the key state:

1. **The fingerprint is present and the original secret is available.** Restore that secret
   on every process. Service resumes with the existing poll data.
2. **The fingerprint is missing and the original secret is available.** With all Hourmere
   processes stopped, retrieve the fingerprint from a backup taken while that secret was
   in use, or derive it locally from the original secret using `fingerprintOf` in
   `packages/scheduling/src/meeting-poll-key.ts`. Insert the missing row in
   `meeting_poll_key_state` with `singleton = true` and the 32-byte fingerprint in
   `secret_fingerprint`. Restart with the original secret. This preserves rosters, ballots,
   tombstones, mail counters and queued credential mail.
3. **The original secret is lost or must be retired.** Delete every meeting poll that has
   voters or mailbox counters (deleting an organization deletes its polls). Once no voter
   row or mailbox counter remains, the next start records the new secret. Those polls'
   rosters, ballots, tombstones, mail counters and queued credential mail are gone. Polls
   without voters or counters stay.

The [operator recovery procedure](https://hourmere.com/docs/self-hosting#meeting-poll-credentials-and-recovery)
covers the shutdown, backup and coordinated restart. There is no dedicated invalidation command.

## Tables and invariants

Migration `0071_meeting_polls.sql` implements the storage foundation below.
New application IDs use UUIDv7 with `DEFAULT uuidv7()`;
Foreign keys use the existing UUID organization, user, event and booking IDs.
Poll-scoped tables carry `organization_id`, `created_at` and `updated_at` (server-assigned
`timestamptz`). Instants are UTC and `display_time_zone` and `time_zone` are validated IANA
names. Columns use snake_case, API fields use camelCase, and state columns use text
with CHECK constraints.

| Table | Columns beyond common fields | Constraints and indexes |
|---|---|---|
| `meeting_polls` | `id`, `event_type_id`, nullable `created_by_user_id`, source/API-key attribution, `title`, `duration_minutes`, `display_time_zone`, `settings_snapshot jsonb`, `settings_fingerprint`, `admission_mode`, `visibility`, `deadline_at`, `status`, `closed_at`, `canceled_at`, `scheduled_at`, nullable `chosen_slot_id`, `booking_id`, nullable `public_token_digest`, `host_revision`, `results_revision` | PK id; UNIQUE `(organization_id,id)`; scoped event FK; unique token digest; status CHECK open/closed/scheduled/canceled; positive duration; deadline after creation; chosen slot and booking both present iff scheduled; unique non-null booking ID; `(organization_id,created_at,id)` pagination; partial `(deadline_at,id)` for open polls |
| `meeting_poll_slots` | `id`, `poll_id`, `start_at`, `end_at`, `position` | scoped poll FK; UNIQUE `(organization_id,poll_id,id)` and `(poll_id,start_at,end_at)`; unique `(poll_id,position)`; end > start; trigger/service enforce exact poll duration and immutable slots; `(poll_id,start_at)` |
| `meeting_poll_voters` | `id`, `poll_id`, `name`, `email`, `email_key`, `verified_at`, `pending_expires_at`, `invited_at`, `withdrawn_at`, `ballot_submitted_at`, `admission_ip_digest`, `time_zone`, `locale`, `responses jsonb`, `join_consent_at`, `ballot_revision`, nullable `selected_booking_role` (booker/guest) | scoped poll FK; UNIQUE `(organization_id,poll_id,id)`, `(poll_id,email_key)`; `(poll_id,verified_at)` for roster; only verified active ballots count; public pending expiry ≤ admission + 1 hour and ≤ deadline; host invitations have null pending expiry; removal and expiry cleanup delete the row, withdrawal keeps it; `(poll_id,pending_expires_at)` for expiry |
| `meeting_poll_capabilities` | `id`, `poll_id`, `voter_id`, `purpose` (verification/voting/reminder_opt_out), nullable `capability_ciphertext`, `token_digest`, `generation`, `expires_at`, `consumed_at`, `revoked_at` | scoped voter FK; unique token digest; positive generation; purpose-bound credentials following `waitlist_capabilities`; public verification expiry bounded by pending expiry, invited voting credential expires at deadline; opt-out never grants voting authority |
| `meeting_poll_mailbox_counters` | `id`, `poll_id`, `email_key`, `resend_count`, `last_resend_at`, `recovery_count`, `last_recovery_at`, `reminder_consumed_at`, `reminder_opted_out_at`, `removed_at`, `purge_at` | UNIQUE `(poll_id,email_key)`; no voter FK, survives voter expiry/removal/recreation; resend count 0–3; recovery count 0–3 for the current credential, reset when a new one is mailed; reminder receipt and opt-out never reset; poll deletion/retention purges ledger |
| `meeting_poll_votes` | `id`, `poll_id`, `voter_id`, `slot_id`, `value` | UNIQUE `(poll_id,voter_id,slot_id)`; composite organization/poll/voter and organization/poll/slot FKs prevent cross-poll/tenant votes; value CHECK yes/if_need_be/no; `(poll_id,slot_id,value)` tally index |
| `meeting_poll_operations` | `id`, nullable `poll_id`, `operation`, `actor_scope_digest`, `idempotency_key_digest`, `request_fingerprint`, nullable `booking_id` (set by finalize; a receipt stores no result beyond its `poll_id` and `booking_id` references). Replays return only those stored references: a create replay returns `poll_id` as `poll_already_created`, a finalize replay returns the booking reference, and invite, resend and rotate-link replays return their safe outcome or conflict without a stored result | UNIQUE `(organization_id,operation,actor_scope_digest,idempotency_key_digest)`; scoped poll/booking FKs; no raw request, token, roster or response cache |
| `meeting_poll_deliveries` | `id`, `poll_id`, nullable `voter_id`, nullable `host_user_id`, `kind`, `generation`, `sequence`, `due_at`, `state`, `attempts`, `lease_id`, `lease_until`, nullable purpose-bound `capability_ciphertext`, safe error class | exactly one recipient: scoped voter FK or host user FK; separate partial UNIQUE `(poll_id,voter_id,kind,generation,sequence)` and `(poll_id,host_user_id,kind,generation)`; `sequence` is 0 for the first delivery of a kind and generation; recovery copies and booking-update outcome notices take the next ordinal under the poll lock, so re-deliveries never collide while duplicate first deliveries are still rejected; partial due index for pending rows and expired claims; bounded retries and terminal sent/suppressed/skipped outcomes |
| `meeting_poll_key_state` | `singleton`, `secret_fingerprint`, `updated_at`; installation-wide, so no `organization_id` or `created_at` | One row: `singleton` primary key, CHECK true; 32-byte keyed fingerprint of the meeting-poll secret, never the secret; recorded by the first fence use, never by the migration |

`email_key` is a domain-separated keyed HMAC digest of the normalized mailbox, never
plaintext. It supports uniqueness, removal tombstones and durable mail counters.
`admission_ip_digest` is keyed and retained only for public pending admission accounting.
Rotating verification or voting credentials preserves the separate opt-out credential
and preference. The nullable `capability_ciphertext` column on the capability row holds
purpose-bound verification and voting credentials for reminder delivery and recovery.
The service or worker purges it on revocation or expiry (the deadline for voting
credentials). Host reads omit this material. Voting expiry at the deadline
disables writes, but the retained digest still authenticates read-only own-ballot access
until poll retention/deletion; removal/revocation invalidates reads as well.

A composite chosen-slot foreign key `(organization_id,id,chosen_slot_id)` references the
slot's scoped identity. The scoped booking foreign key `(organization_id,booking_id)`
references `bookings_id_organization_unique`.
A deferred constraint trigger verifies that the scheduled booking belongs to the poll's
event and selected UTC interval when first linked; a CHECK enforces the scheduled pair.
Cancellation/rescheduling later does not invalidate that historical link. Trigger/service
checks enforce candidate and enrollment caps under the poll lock; CHECK cannot count child rows.
The service, not user input, controls lifecycle timestamps/revisions and token digests.

Organization deletion cascades poll data; event soft deletion leaves history but blocks
new writes. Creator deletion nulls attribution, without transferring personal poll access.
Privacy deletion of a poll removes its voters, answers, votes, tokens and deliveries;
operation tombstones retain only pseudonymous replay identity for the configured retention
window: the organization ID and an unkeyed digest of the acting user, API key or OAuth
grant. Anyone holding that bare ID can recompute the digest, and in a personal space the
organization ID itself identifies the user. The [cleanup schedule](#storage-policy-and-cleanup-schedule)
covers expired public pending reservations, credentials and receipts, as well as
abandoned open polls. Poll deletion preserves the
booking. Deleting the original linked booking first deletes the poll and clears its
receipt references.

## Availability and atomic finalization

Creation validates each proposed interval against the availability engine, including
duration, schedule, current busy data, minimum notice, window, limits and buffers.
Alternatives may overlap, and duplicate starts are rejected. The deadline must precede
every start and leave the event's current minimum notice before the earliest candidate.
Open polls leave calendars and booking capacity available.

The create service applies this check. It resolves the event the way ID-addressed
booking does (one-time links use the same resolution, so a personal owner needs a public
handle), and asks the engine whether it offers exactly each candidate's interval at the
creation instant: `intersectSlots` over every host for individual and collective events,
`unionRoundRobinSlots` over the eligible pool for round-robin. That covers schedules and
date overrides in the host's zone, calendar busy time, confirmed bookings and unexpired
payment holds, minimum notice, booking window, buffers and booking limits. Errors, all 409:

- `slot_unavailable`, the existing booking-service code, when any candidate is not offered.
  The error lists every refused start, in order, as `unavailableStarts`; transports report
  it with the field hint `candidateStarts`.
- `event_type_unavailable` when the event takes no bookings at all (for example, a host who
  is no longer a verified member, or round-robin turned off).
- `calendar_sync_unavailable` when a host calendar is stale, as in booking.
- `poll_event_changed` when the hosts changed while creation waited for their locks.

Creation takes public booking's host phase: an unlocked read names the hosts, then their
sorted booking advisory locks, then the event `FOR SHARE` and host users and members
`FOR SHARE`, and it compares the locked host set with the named one. A booking that
committed first is seen and refuses its candidate; a booking that starts later waits for the
creation to commit and then books normally, because candidates are not holds.

Host results include advisory availability. Busy candidates remain visible with ballots
preserved. The app labels unknown availability neutrally. Finalization cannot book a
candidate when required calendar coverage is stale. Finalization strictly revalidates
current availability; no buffer or external-busy override. A conflict leaves the poll and
all votes intact so the host can choose another candidate or cancel and create a new poll.
Local exclusion constraints cannot stop a new external calendar event after the last sync;
existing freshness safeguards and eventual provider reconciliation still apply.

The ordinary booking entry points and poll finalization share a transaction-taking core
in [`bookings.ts`](../packages/scheduling/src/bookings.ts). Finalization uses it in the
same transaction as the poll changes.

1. The poll service validates the caller, scope and expected organization and takes the
   authority locks. It locks the poll before the voter and slot rows or the host phase.
2. It checks the scoped idempotency receipt, lifecycle, selected slot and voters, attendee
   cap, results and ballot revisions, consent and required answers. The booking core
   takes sorted host advisory locks and the event lock, and the service checks the
   settings fingerprint against the locked event. Finalization accepts open or closed
   polls with eligible future slots.
3. The booking core checks current availability, buffers, limits and membership,
   selects hosts and inserts the booking, attendees, settings and notification intents.
   Providers run outside the transaction.
4. Finalization records the chosen slot, booking ID, scheduling time, voter roles,
   operation receipt and poll outcome intents. The booking and poll changes commit
   together. Outbox workers apply existing conference-readiness safeguards after commit.

Host finalize responses, including exact replay through REST, MCP and CLI, whitelist safe
booking metadata and never contain the booker's `manageToken` or manage URL. Only normal
booker confirmation mail conveys management authority. Preserve existing `bookings.source`
values from the finalizing transport: `web` for host UI, `api` for direct REST/API-key
clients, and `mcp` for MCP and the CLI that calls MCP. Preserve API-key/OAuth attribution;
there is no new `poll` enum value. The poll-to-booking FK identifies poll origin.

| Event mode | Current behavior |
|---|---|
| Personal or team individual | One configured host; ordinary booker plus permitted guests |
| Collective | All current pinned hosts must pass validation; one booking consumes each host's availability; any conflict rolls everything back |
| Round-robin | Create validates that at least one eligible pool host offers each candidate; finalize selects through current fairness state, not a voter-specified host; advance fairness only on commit; changed pool fingerprint requires a new poll |
| Group seats | Group seat event types are unsupported. Independent seats have separate answers, capabilities and capacity. |
| One-time links | Polls reference event type IDs under host authority. One-time-link tokens are invalid input, and polling and finalization leave links untouched. |

A scheduled poll preserves the original chosen time and booking link. Use the ordinary
booking controls to reschedule or cancel. An authorized exact finalize retry returns the
current booking from the reschedule chain. The public poll page and read projection
continue to show the original poll outcome; they do not reflect booking moves or
cancellations. Ordinary booking notifications cover selected attendees. Eligible
non-selected voters receive privacy-safe informational updates without booking authority.
Canceling an already scheduled poll returns `poll_already_scheduled`.

## Deadline, concurrency and replay

Transitions: `open → closed` by host or deadline; `open|closed → scheduled` by successful
finalization; `open|closed → canceled` by host. No reopening and no deadline extensions in
this version. Expiry closes voting, not booking selection; if all times have passed the
host can only cancel. A worker persists closed status, but reads derive effective closed
state whenever the database clock reaches the deadline, even if that worker is late.

Every poll write serializes on the poll row: enrollment, verification, recovery, invitations, resend, votes, replacements, profile edits, withdrawals, reactivation, reminder opt-out, expiry handling, removal, bulk removal, link rotation, deletion, close, cancel and finalize.
After acquiring it, the service reads `clock_timestamp()` once. Voting, admission and
verification require an open poll and a decision instant strictly before `deadline_at`. Repeated verification returns current own state without reopening or extending access. Equality is closed. Request arrival time
and transaction-start `now()` are not authoritative. A vote that passes this check may
commit after the wall-clock deadline; it linearized before it. A waiter checked after the
deadline fails. Require `expectedBallotRevision` for ballot/profile edits and withdrawal; stale
forms get `poll_changed`, never overwrite a concurrent decision.

A poll carries two revisions so that voter activity can never block host control.
`host_revision` changes only on accepted host writes (invitation, resend, removal, bulk
removal, link rotation) and host lifecycle transitions (close, cancel, finalize); voter
actions, recovery, reminder opt-out, public pending expiry and the
derived deadline transition never change it. Resend, remove-voter, remove-unverified,
rotate-link, close, cancel and delete require `expectedHostRevision`. Poll settings are
immutable.
`results_revision` changes whenever the results/attendee snapshot changes: admission,
verification, ballot and profile edits, withdrawal, reactivation, invitation, removal and
bulk removal. Only finalize checks it, through
`expectedResultsRevision`, on top of the selected voters' ballot revisions and consent.
Either stale value gets `poll_changed`. Closure stops voter writes that affect results,
so a host facing constant voter edits can always close with the host revision and then
finalize against a results revision that only another manager's removal can still change.

Create and finalize require retained random `Idempotency-Key` (MCP/CLI `idempotencyKey`).
Scope includes organization, operation and actor identity (session user, API key or OAuth
grant), with normalized input fingerprint and the same precision as stored timestamps.
An exact finalize retry returns the original booking's current lifecycle without creating
mail/booking/fairness changes. A changed payload under the same key is
`idempotency_key_reused`. Authorization precedes replay; a receipt is not a capability.
Two finalizers with different keys serialize: only the winner creates a booking, the loser
gets `poll_already_scheduled` with safe poll metadata. Matching retry is checked before
stale expected revisions so a successful lost response remains recoverable.

Create returns a raw public link only once; exact create replay returns
`poll_already_created` with authorized poll ID, never another link or raw capability.
Lost create responses are recovered by reading metadata then explicitly rotating the
public link (old link invalidated), only in public_link mode. Invited mode returns
metadata without a link and rejects rotate-link with 409 `poll_link_unavailable`. Voter-token
recovery instead re-delivers the existing credential by mail and never rotates it. Retain digest-only receipts with the poll; after retention expiry a replay
cannot promise deduplication. Clients must not reuse keys for new intent.

## Notifications, abuse and time zones

Transactional delivery intents cover invitations, verification, deadline reminders,
time-selected outcomes and cancellation. A reminder is due 24 hours before the deadline
if that instant is after creation. The worker sends at most one reminder per poll and
mailbox to eligible invitees (including unverified invitees) and verified public-link
voters who have not submitted ballots. It rechecks the ballot, withdrawal, removal,
voting status and opt-out before sending. Closure stops overdue reminders. Each invitation and reminder contains
a purpose-limited opt-out link: explicit POST records `reminder_opted_out_at` on the
mailbox counter row without requiring login or verification, never grants ballot access, and suppresses further
reminders. Withdrawal additionally opts out of all poll mail. Resend/recovery never
clears opt-out or resets the once-per-poll/mailbox reminder receipt.

Hosts can resend an invitation to a retained, non-withdrawn invitee while voting is
open. A mailbox can receive at most one accepted resend per 15 minutes and three per
poll. Create, invite and resend share the per-organization and per-IP request limits,
and delivery uses instance and per-recipient mail limits. These counters persist across
removal and re-invitation. It rotates the emailed capability,
invalidates the old generation and queues a new durable intent without reacquiring capacity.
A retained idempotency key makes retry mail-free. Requests beyond cooldown/budgets return
429 `rate_limited` with Retry-After when known; no resend extends the poll deadline.
Reminders carry the still-valid voting credential directly in the voter-page fragment,
including for unverified invitees and when enrollment capacity is full; no recovery detour.
Resend/recovery are for genuinely lost mail. Recovery always gives uniform 202 and
re-delivers the retained credential of an eligible voter unchanged: the verification
credential of an unexpired public pending enrollee, or the voting credential of a verified
public-link voter or host invitee. It never rotates or revokes, so a third party who knows
the poll ID and an address can neither invalidate that person's link nor obtain it.
Recovery allows at most one delivery per mailbox per 15 minutes and three per mailbox for
each credential, counted separately from host resends, plus the shared admission bucket and
existing recipient mail budgets. The count and cooldown restart only when a new credential is
mailed to that mailbox (verification, an invitation or re-invitation, host resend or re-enrollment). Per-mailbox limits
never change the uniform 202; excess requests send nothing. Each delivery repeats the current
credential to the same mailbox, so exhausting this budget withholds no credential that
mailbox has not already received three times. Recovery delivers only before the deadline
while the poll is open or closed; withdrawn or removed voters, expired public enrollees,
canceled or scheduled polls and requests after the deadline, when the retained ciphertext
is purged, receive nothing. Invited recovery preserves the reserved place and deadline.
Public pending recovery never extends the original one-hour reservation; after expiry a
new enrollment must acquire capacity. Invited-mode recovery needs no public link.

Cancellation invalidates pending invitations/reminders. Workers recheck state, recipient
consent and generation, deduplicate per recipient, obey existing instance and recipient
mail budgets, and recover expired claims without resetting attempts. SMTP is outside
transactions; the existing acceptance/failed-receipt duplicate window remains. Temporary delivery capabilities are encrypted with purpose binding and are erased
at terminal delivery. Logs, job metadata, analytics and replay records omit raw
capabilities.

Every retained non-withdrawn, non-removed voter receives the chosen-time outcome, including
unverified host invitees; unverified public-link enrollees receive no outcome mail. Selected
attendees receive it through normal booking confirmation rather than a duplicate calendar
invite. Non-selected voters get plain informational mail, no ICS, join URL or manage link.
Preserve ordinary conference gates. Invitations and pre-booking cancellations carry no ICS.

The poll email worker delivers the committed outcome intents using each recipient's saved
language and time zone. A finalized booking's reschedule or cancellation creates an update
intent in the same transaction. The worker checks that the recipient is still eligible and
uses the latest booking in the reschedule chain. A newer change supersedes older queued
notices. Informational mail can go out while a conference is being created, and the ordinary
booking mail continues to wait for conference readiness.

On deadline closure the worker queues one `deadline_closed` notice for the creator if
still authorized. The notice goes to the creator only. It
contains title, deadline in the profile zone, response count and an authenticated browser link
to `/app/meeting-polls/{id}?organizationId={organizationId}`. The notice omits the roster,
answers and voter capabilities. Delivery rechecks authority and skips the notice after
cancellation, scheduling or deletion. Explicit early closure does not send it.
There are no per-vote host emails. A successful booking uses existing normal host
confirmation/lifecycle mail, without an extra poll-selected host message. Delivery storage
supports a host recipient separately from a voter; dedupe host deadline mail once per poll.
Poll mail uses the [shared locale registry](../packages/core/src/locales.ts). The host
can choose an invitation language, which defaults to English. Later poll mail uses the
voter's saved locale, and host mail uses the creator's current profile locale. Outcome emails are translated into
every shipped public locale. The reminder opt-out page asks the
recipient to confirm before sending the credential to the public opt-out endpoint. Opening
the link alone does not change the preference. The page removes the credential fragment
from the address bar and does not require signing in.

Start, end and deadline are stored as UTC `timestamptz`. The service accepts explicit
offsets, normalizes to database microseconds before fingerprinting or comparing, and
returns RFC 3339 timestamps with a Z suffix. The app uses offsets to distinguish
repeated times when clocks move back. End times use elapsed duration. The voting page
shows dates and times in the voter's selected IANA zone. Switching zones changes the
labels while preserving candidate IDs.

The public pages use no-store, no-referrer and no indexing. Browser links hold secrets
in the URL fragment. The page removes the fragment and sends the token in a POST body
when needed. Host list and results omit raw capabilities. Request budgets use trusted
client IP and, for host admission, organization. Per-poll enrollment and mailbox mail
counters bound additional work. The worker uses shared instance and per-recipient mail
budgets. A per-organization mail budget remains planned for open Cloud sign-up.
Forwarded public links and mailbox aliases can still admit unwanted voters. Use invited
mode for sensitive meetings. Verification proves access to the mailbox.

Existing `PUBLIC_RATE_LIMITS` in `apps/server/src/rate-limit.ts` are per trusted IP per
60 seconds: page/slots 120, book 10, manage 30. Enrollment/recovery/verification share a
poll admission bucket sized like `book`: 10 requests per 60 seconds per trusted IP, across
transports and processes. Read uses the page size, 120, and ballot/withdraw/opt-out the
manage size, 30. These alone do not stop filling 40 places: one IP can submit 40
enrollments in roughly 4 rate-limit windows and refill with 40/hour; a catch-all mailbox
can verify 40 voters with 80 admission requests in roughly 8 windows.
Fixed-window boundaries can shorten elapsed time. The binding additional control is at
most 3 concurrent unexpired public pending reservations per trusted IP per poll, checked
atomically under the poll lock; 40 pending places therefore need at least 14 IP addresses.
Reject excess with 429 `rate_limited`, without mail. Host invitations bypass this public
pending-IP limit but count against 40 total places. Shared NATs may need host invitations.
Host create, invite and resend share a separate 10-request-per-minute allowance per
organization and per known trusted IP across REST, MCP and server processes. Exact
retries also consume request allowance. Invitation delivery still uses the worker's
instance and recipient mail budgets and the service's per-mailbox resend limits.
Verification frees the pending-IP allowance: catch-all/distributed verified abuse remains
possible, so this is not a unique-human guarantee. Because a known mailbox takes no place,
one probe is inherent: from an IP with one pending allowance left, or with one place left,
enrolling a target address and then a fresh one shows whether the target was already
known, at the cost of a verification mail to a new target; invited mode avoids it. A global per-poll request budget could let one caller block
legitimate voters. Request budgets use client and organization boundaries.
Hosts can bulk remove unverified public enrollees (never host invitees), individually
remove verified abusers, rotate a leaked public link, or cancel/recreate in invited mode.
If the link has leaked, rotate it before bulk removal. Removal immediately frees the
affected IPs' pending allowances, so anyone still holding a valid link can refill places.
Bulk removal retains mailbox tombstones/counters and uses the same poll lock and
`expectedHostRevision`, so voter activity cannot make any of these remedies fail.

## Limits

The shared policy constants and the service and API validation enforce these limits.

| Limit | Value | Reason |
|---|---|---|
| Candidates per poll | 2–20 | A genuine choice, with a bounded mobile ballot and tally cost |
| Enrollments per poll | 0–40 | Supports a small team/channel with a bounded 800-cell maximum ballot matrix (40 × 20); counts active verified voters, active host invitations and unexpired public pending reservations once each; excludes withdrawn/removed and expired public reservations |
| Attendees per booking | 1–11 | Finalize selects one booker and at most `MAX_GUESTS` guests; `MAX_GUESTS = 10` in `packages/scheduling/src/bookings.ts`, checked by the doc-fact test |
| Pending enrollment expiry | 1 hour | Only unverified public-link self-enrollments expire; host invitations keep their place until deadline/revocation; deadline may shorten this interval |
| Public pending reservations per IP/poll | 3 | Concurrent unexpired public reservations; invited places excluded |
| Deadline after creation | 1 hour–30 days | Gives time to respond without indefinite open state; both bounds inclusive, measured as elapsed time |
| Reminder lead time | 24 hours | One predictable reminder; skip if its due instant is not after creation |
| Invitation resend cooldown | 15 minutes | Bound repeat mail requests for a lost invitation |
| Invitation resend cap | 3 per poll/mailbox | Bound total explicit resends even across removal and re-invitation |
| Recovery delivery cooldown | 15 minutes | Bound repeat recovery mail per mailbox; counted separately from resends, never revealed in the uniform 202 |
| Recovery delivery cap | 3 per mailbox credential | Bound recovery mail that anyone knowing the poll ID and an address can trigger; restarts only when a new credential is mailed, and each delivery repeats that credential |

Deadline must also satisfy the candidate/notice rule above, so short-notice events can
have no valid deadline. Existing duration, field length, question and guest constraints
remain in force; the smaller applicable limit wins. The attendee minimum applies at finalization, not creation; enrollment can be zero.
The enrollment cap does not raise booking capacity. Expiry and host removal bound how long
public-link saturation lasts; per-IP/poll/organization/mailbox admission budgets bound refill
and retained tombstone growth, and link rotation lets the host stop further leaked-link joins. Caps apply equally to self-hosting,
REST, MCP, CLI and UI. Expanding them requires reviewing booking capacity and mail budgets.

## Storage policy and cleanup schedule

`packages/scheduling/src/meeting-poll-policy.ts` defines the admission limits and shared
public request bucket sizes. SQL constraints independently enforce storage bounds.

The cleanup jobs run hourly, in batches of at most 500 rows per transaction, and schedule
bounded continuations for a backlog. Cleanup reads the database clock under the poll
lock. Delayed cleanup never grants a vote, retains an expired public
reservation's capacity, or extends credential validity. The schedule is:

| Stored data | Expiry and cleanup contract |
|---|---|
| Open polls, including abandoned polls | The database clock closes voting at the deadline. The hourly sweep writes that state even without a host visit. |
| Terminal polls | The shipped worker has no automatic age-based retention setting. Closed, canceled and scheduled polls remain until explicit poll, linked-booking or organization deletion. |
| Expired public pending voters | Delete on the first hourly sweep after `pending_expires_at`, cascading votes, capabilities and deliveries. Enrollment/invitation replaces expired rows synchronously when needed; no name, mailbox, responses or IP digest remains after cleanup. |
| Capability ciphertext | Clear immediately on revocation and on the first hourly sweep after expiry. Preserve a voting digest for read-only own-ballot access until poll deletion/retention; expired public pending rows are deleted entirely. |
| Mailbox counters | Counters, reminder receipt, opt-out and removal digest persist for the retained poll lifetime, with no voter FK or early purge/reset. Poll deletion cascades them. |
| Operation receipts | Keep minimal receipts while their poll is retained. On poll deletion erase poll/booking references (`poll_id` and `booking_id`); keep only pseudonymous replay digests for 90 days from deletion (the organization ID and an unkeyed digest of the acting user, API key or OAuth grant), then delete in the first hourly sweep at or after `purge_at`. Organization deletion cascades immediately. |
| Recipient deliveries | Erase ciphertext immediately on sent/suppressed/skipped terminal transition. Retain the minimal terminal recipient receipt for the poll lifetime to prevent duplicate reminders/outcomes; voter/poll deletion cascades. Expired claims keep their attempt count; allow at most 5 attempts with a 5-minute lease, then terminally skip and clear ciphertext. |

The hourly `meeting-poll-cleanup-v1` job persists deadline closure and queues the
creator notice in the same transaction. It also deletes expired public pending voters
and due replay tombstones. The worker does not set the internal terminal-poll retention
parameter.
`meeting-poll-capability-expiry-v1` clears expired capability ciphertext hourly using the
`meeting_poll_capabilities_expiry` index, in bounded pages that skip locked polls and
capabilities. `meeting-poll-email-v1` checks for due reminders and dispatches poll mail
every minute. A poll privacy deletion never deletes its booking.
Deleting the original linked booking deletes its poll history first, preserving the
scheduled-pair invariant and clearing receipt references.
Operators who delete booking history can use the linked-booking cascade or explicitly
delete the poll as part of the same retention procedure. Numeric cleanup and delivery
bounds are named in `MEETING_POLL_RETENTION`.

## Host dashboard

Choose **Meeting polls** in the relevant personal or team space. Personal event owners and
current team owners or admins can open a poll's results and review who voted for each time.
A deadline notice takes you to the results in that poll's space. Sign in and switch spaces
if prompted. The matrix keeps the three vote counts separate. In an aggregate poll, verified
voters can see those totals, and a small group can make individual votes easy to infer.
Candidate times include UTC offsets to distinguish repeated hours after a clock change.

Choose a time, a booker and up to ten other eligible voters when the event allows guests.
A selected voter who chose **If need be** at that time requires explicit acknowledgment.
The app uses the event's default location. REST, MCP and CLI can select a configured
option with `locationOptionId`. Poll finalization cannot collect the booker's phone
number for a location that asks for it.
Availability is advisory. Scheduling checks it again. Review refreshed results after a
revision conflict. If the scheduling response is lost, use the retry on the results page
to send the same request with its original key.

You can close voting early, cancel an unscheduled poll, or delete the poll's history.
After scheduling, **View booking** opens the booking in the admin app. Deleting the poll
preserves that booking.

中文：请在对应的个人或团队空间打开 **会议投票**。个人活动所有者以及团队的现任所有者
和管理员可以查看每位投票人在各个时段的选择。截止通知会打开该投票的结果页，必要时
请先登录并切换空间。如果主持人开启了 **共享投票汇总**，已验证且未撤回的投票人
可以看到各时段的三类票数。参与人数较少时，仍可能从汇总推断他人的选择。候选时段会
显示 UTC 偏移量，方便区分时钟回拨时重复出现的本地时间。

选定时段和预约人后，如果活动允许添加嘉宾，还可选择最多十位符合条件的投票人。
如果任何一位所选参会者在该时段选择了“必要时可以”，请明确确认其有条件同意。
页面显示的可用性仅供参考，安排会议时会重新检查。遇到版本冲突后，请核对刷新后的结果。
如果安排会议的请求未收到响应，可以在结果页重试同一次请求。

你可以提前结束投票、取消尚未排定的投票，或删除投票记录。排定后可打开管理端预约页面，
删除投票不会取消预约。

## REST, MCP and CLI contract

Public capability operations and all host operations below are available without a
feature flag. `/api/v1` responses use camelCase, UUID IDs,
no-store, the existing `{error,message?,field?}` envelope and additive/open response schemas.
Generated OpenAPI documents each operation's inputs, statuses and responses. Clients
should tolerate unfamiliar response fields and states. REST and MCP use the same
scheduling services, and the CLI calls MCP.

| REST operation | MCP tool | CLI under `hourmere polls` | Authority/result |
|---|---|---|---|
| POST `/api/v1/meeting-polls` | `create_meeting_poll` | `create` | Manager; eventTypeId, candidateStarts, deadlineAt, displayTimeZone, admissionMode, optional durationMinutes and visibility, idempotency key; 201 poll + one-time public link only in public_link mode |
| GET `/api/v1/meeting-polls` | `list_meeting_polls` | `list` | Manager; organization-scoped cursor pagination |
| GET `/api/v1/meeting-polls/{id}` | `get_meeting_poll` | `get` | Manager; lifecycle, hostRevision and safe metadata |
| GET `/api/v1/meeting-polls/{id}/results` | `get_meeting_poll_results` | `results` | Manager; ballots, roster, separate counts, advisory availability, hostRevision, resultsRevision and ballot revisions |
| POST `/api/v1/meeting-polls/{id}/invitations` | `invite_meeting_poll_voters` | `invite` | Manager while voting is open; bounded name/email list with optional locale and timeZone, idempotency key; 202 durable intent with each entry's outcome; all-or-nothing 409 poll_full if new reservations exceed remaining places, 400 poll_limit_exceeded for batch >40; no voter secrets |
| POST `/api/v1/meeting-polls/{id}/invitations/{voterId}/resend` | `resend_meeting_poll_invitation` | `resend-invitation` | Manager; expectedHostRevision + idempotency key; 202 intent under resend limits, no secrets |
| DELETE `/api/v1/meeting-polls/{id}/voters/{voterId}` | `remove_meeting_poll_voter` | `remove-voter` | Manager; expectedHostRevision; 200 with poll, resultsRevision and removedVoterIds; deletes the voter row, revokes capabilities and releases capacity |
| POST `/api/v1/meeting-polls/{id}/remove-unverified` | `remove_unverified_meeting_poll_voters` | `remove-unverified` | Manager; expectedHostRevision; bulk revoke only unverified public enrollments, preserve host invitations and abuse counters |
| DELETE `/api/v1/meeting-polls/{id}` | `delete_meeting_poll` | `delete` | Manager; expectedHostRevision; 204 privacy deletion, linked booking preserved |
| POST `/api/v1/meeting-polls/{id}/close` | `close_meeting_poll` | `close` | Manager; expectedHostRevision; 200 current state, including repeats on closed polls |
| POST `/api/v1/meeting-polls/{id}/cancel` | `cancel_meeting_poll` | `cancel` | Manager; expectedHostRevision; 200 current state, including repeats on canceled polls; sends no cancellation mail for an unscheduled poll |
| POST `/api/v1/meeting-polls/{id}/finalize` | `finalize_meeting_poll` | `finalize` | Manager; slotId, bookerVoterId, attendeeVoterIds, acknowledgeConditional, expectedResultsRevision, expectedBallotRevisions, optional locationOptionId, idempotency key; 201 safe booking metadata, 200 exact replay; never manageToken or manage URL |
| POST `/api/v1/meeting-polls/{id}/rotate-link` | `rotate_meeting_poll_link` | `rotate-link` | Manager; public_link mode only, otherwise 409 poll_link_unavailable; expectedHostRevision + idempotency key; one-time new public link, matching replay returns safe conflict |
| POST `/api/v1/public/meeting-polls/read` | `read_meeting_poll` | `view` | Poll/voter capability; public projection, own ballot only, effective deadline and visibility |
| POST `/api/v1/public/meeting-polls/enroll` | `enroll_meeting_poll_voter` | `join` | publicToken, name, email, timeZone and optional locale; uniform 202, or 409 poll_full for every mailbox when full |
| POST `/api/v1/public/meeting-polls/recover` | `recover_meeting_poll_voter` | `recover` | pollId and email; uniform 202 re-delivers the existing credential without rotation when eligible |
| POST `/api/v1/public/meeting-polls/verify` | `verify_meeting_poll_voter` | `verify` | Emailed voter capability; explicit confirmation while voting is open, idempotent verification, no implicit ballot |
| POST `/api/v1/public/meeting-polls/vote` | `submit_meeting_poll_vote` | `vote` | Voter capability; full slot/value array, consent, responses, optional name/zone/locale, expectedBallotRevision; from withdrawn state this is the reactivation, with renewed consent and an atomic capacity check (409 poll_full); 200 own ballot/revision |
| POST `/api/v1/public/meeting-polls/reminder-opt-out` | `opt_out_meeting_poll_reminder` | `reminder-opt-out` | Purpose-limited mail capability; 200 opted-out state, no verification required |
| POST `/api/v1/public/meeting-polls/withdraw` | `withdraw_meeting_poll_vote` | `withdraw` | Voter capability + expectedBallotRevision; 200 withdrawn state |

Capability reads use POST so secrets stay out of HTTP paths and query strings.
Browser entry links use `/poll#<publicCapability>`, `/poll/voter#<voterCapability>` and
`/poll/reminder-opt-out#<optOutCapability>`. MCP input schemas use the same capability
fields. Every poll CLI command reads JSON from stdin (`--input -`). A newly disclosed
public link or voting token may appear in the success response, so keep stdout private. Invitation
and rotation replay receipts use the operation table; changed input conflicts and lost
responses never resend mail or recover raw secrets. An exact invitation replay sends no mail
and reports each entry's current roster state. Create and rotate return `poll` and
`publicLink`, an absolute URL with the public capability in its fragment. Invited create
returns `publicLink: null`. Exact create replay includes `pollId` (null after deletion)
with `poll_already_created`. Enrollment uses a uniform poll-level full response and otherwise uniform 202; recovery
always returns uniform 202 while enforcing its per-mailbox cooldown/cap, and re-delivers only the active credential generation.

| Status/code | Meaning |
|---|---|
| 400 `invalid_request` | Malformed shape at transport boundary |
| 400 `poll_conditional_acknowledgment_required` | At least one selected attendee voted `if_need_be` for the chosen candidate and the host has yet to acknowledge it |
| 400 `invalid_poll`, `poll_limit_exceeded`, `poll_event_unsupported` | Invalid instants/deadline/choices, a resource limit, or an unsupported group event type. REST and MCP reject one-time-link fields outside the request schema. |
| 401 `unauthorized`; 403 `insufficient_scope` | Existing bearer/session rules; never downgrade a supplied bad bearer |
| 403 `team_management_access_denied`; 409 `organization_context_changed` | Existing management/context boundary |
| 404 `poll_not_found` | Unknown/inaccessible poll or voter, or invalid capability, without disclosing existence |
| 409 `poll_full` | Enrollment/invitation batch/reactivation capacity reached; no mailbox membership disclosure |
| 409 `poll_closed`, `poll_canceled`, `poll_changed` | Deadline/state/revision refused the write |
| 409 `poll_link_unavailable` | Rotate-link on an invited-mode poll, which has no public link |
| 409 `poll_already_created`, `poll_already_scheduled`, `poll_link_already_rotated`, `idempotency_key_reused` | Explicit replay/conflicting intent outcomes |
| 409 `poll_event_changed`, `slot_taken`, `calendar_sync_unavailable` | Refresh or choose another time; no partial booking or token consumption |
| 409 `slot_unavailable`, `event_type_unavailable` | Create: a candidate the availability engine does not offer now (with `unavailableStarts`), or an event that takes no bookings; existing booking-service codes |
| 429 `rate_limited` | Existing request/mail abuse boundary; Retry-After when known |
| 503 `meeting_poll_key_mismatch` | The installation secret does not match retained keyed data |

OpenAPI lists the applicable booking validation and conflict errors. A public closed
read remains 200 and read-only for a valid voting credential, with its own prior ballot.
Invalid capabilities receive the same unavailable response.

## Implementation plan and acceptance checks

The table preserves the original plan and review criteria. Storage through host UI
(A1–D4b) and documentation (E1) are complete. E2 remains planned and belongs to the
project lead.

The staged rollout enforced the requirement that every creation surface ship with the
ability to close, cancel, delete, remove voters from and finalize a poll. Host lifecycle
transports preceded creation, and host lifecycle UI preceded the web creation form. The
plan called for host deadline mail to link to the authenticated results REST
endpoint until the results page shipped. Deadline mail now links to the authenticated
results page.

| Stage / day-sized sub-step | Depends on | Endpoint / MCP / CLI ownership | Flag state | Deliverable and acceptance |
|---|---|---|---|---|
| A1 Storage and service: schema | None | None; storage only | No flag; no transport | Poll, candidates, voters, votes, capabilities, mailbox counters, operation receipts and recipient delivery storage/types. Test scoped FKs, lifecycle pairs and caps; populated predecessor preservation, fresh install and no-op migration. Encode numeric admission controls and choose cleanup schedule before service admission lands. |
| A2 Storage and service: host lifecycle | A1 | None; internal service only | No flag; no transport | Create/read, authority, close/cancel/delete and link rotation services on polls without voters. Create validates every candidate against the availability engine (see [Availability and atomic finalization](#availability-and-atomic-finalization)). Test tenant/role/context loss, no holds, immutable settings, idempotent receipts and `expectedHostRevision` on close, cancel, delete and rotate-link. A2 must enforce service-only invariants: immutable event, duration, deadline, admission mode, visibility and settings snapshot/fingerprint; no reopening of closed or canceled polls; public-link polls retain a public token except during deletion. A1 validates candidate duration and start-after-deadline only on slot writes, not parent updates. Voter-dependent results, removal and privacy cascades belong to A4a and A4b. |
| A3a Storage and service: enrollment and verification | A2 | None; internal service only | No flag; no transport | Enroll/invite/verify/recover/resend and purpose-specific credentials. Test 40-person capacity, atomic batch rejection, invitation outcomes for active, verified, pending and expired mailboxes, per-IP pending cap, public pending expiry freeing slots, durable invited places and credentials, recovery re-delivering the unchanged credential without revoking it, separate recovery and resend counters, full 409 uniformity and no expired capability reuse. |
| A3b Storage and service: ballots and deadline | A3a | None; internal service only | No flag; no transport | Submit/replace full ballots, withdraw/reactivate and opt-out. Test ballot and results revisions, voter writes never changing the host revision, reacquiring capacity, consent, purpose separation and unchanged invitations of withdrawn mailboxes; exact database-clock deadline equality and a transaction waiting across the deadline race; ballots read-only after deadline. |
| A4a Storage and service: results and removal | A3b | None; internal service only | No flag; no transport | Results projection, remove voter/bulk remove-unverified, voter-row deletion behind mailbox tombstones, removal/rejoin blocks, host re-invitation of removed mailboxes and retained invitation eligibility. Test that a voter replacing their ballot every second cannot make close, cancel, rotate-link, remove-voter or remove-unverified fail with `poll_changed`, while removal changes the results revision; only the mailbox counter row outlives removal. Removal preserves abuse accounting and opt-outs. Re-invitation uses the retained resend budget and starts a new recovery count and cooldown for the new credential. |
| A4b Storage and service: cleanup and deletion | A4a | None; internal service only | No flag; no transport | Bounded terminal cleanup and expired public pending row cleanup, privacy-deletion cascades and deletion races. Expiry releases capacity immediately. Expired public reservations are already absent from host removal, so erasure of their contact details and IP digests depends on the cleanup worker. Ship cleanup before B1 so it is in place when B2 exposes public enrollment. Test that a voter replacing their ballot every second cannot make delete fail with `poll_changed`, delayed workers never retaining public pending capacity, consistent booking-history deletion, no personal data after expiry cleanup or poll deletion beyond the pseudonymous replay tombstones, and audit shared lock order including deletion/cascade paths. |
| B1 Public voting page: verification mail foundation | A4b | None; workers and internal delivery only | No flag; no transport | Invitation/verification/recovery/resend durable delivery, encrypted capabilities and finite leases/retries, using the existing outbox machinery. Test recovery re-delivering the unchanged credential (nothing after public pending expiry or the deadline), invited credentials remaining valid until deadline, budgets, host-resend generation rotation, terminal suppression and the SMTP duplicate window with fakes. Workers take `ensureMeetingPollKey` first in each transaction, before any row lock or claim, and open a retained ciphertext only after it passes. Delivery claims take the poll lock before any delivery or other poll child row, or claim only with `SKIP LOCKED`, so cleanup and deletion cascades never wait for them. Adds the hourly sweep that clears expired capability ciphertext (`meeting_poll_capabilities_expiry`), bounded and `SKIP LOCKED` like the A4b cleanup. |
| B2 Public voting page: public transports | B1 | All public REST operations, matching MCP tools and CLI commands together | No flag; public transports available | Own public read/enroll/verify/recover/vote/withdraw/opt-out, OpenAPI/generated types and no-login checks; ship scope classification and matching MCP/CLI adapters together. CLI secrets must be read from stdin from this first step, never argv. Supply the meeting-poll secret and call `ensureMeetingPollKey` at server start, before any meeting-poll route serves; document secret rotation and both recovery procedures in the operator documentation. Test service parity, invalid bearer, secret redaction, full-capacity responses, no-valid-token recovery entry and every public operation refused under a mismatched key. |
| B3 Public voting page: ballot UI | B2 | None added; consumes B2 REST | No flag; public page available | No login; verification/recovery, consent, ballots/edit/withdraw, timezone selection and read-only closure. Keyboard/screen-reader access and usable 320px stacked layout without overflow; all shipped locales, private/aggregate disclosures, neutral loading/403/errors, duplicate/stale submit, DST and midnight zone changes preserving slot IDs. Browser checks only through approved escalation/CI. |
| B4 Public voting page: reminder and host deadline mail | B3 | None added; opt-out UI consumes B2 REST | No flag; jobs and opt-out page available | Deadline jobs and mail/opt-out UI. Assert unverified nonresponding invitees receive one reminder carrying their valid voting credential even after one hour and when capacity is full; voted/withdrawn/removed/opted-out people and unverified public enrollees receive none. Jobs that open or mint a credential take `ensureMeetingPollKey` first in each transaction, before any row lock or claim. Adds the hourly sweep that persists deadline closure of open polls (`closed_at` at the deadline, no host revision change), bounded and `SKIP LOCKED` like the A4b cleanup. Test timing, no overdue catch-up, budget suppression, durable once-only receipts, authorized creator deadline notice and departed creator suppression. |
| C1 Host picks a time: booking-core extraction | B4 | None; internal booking core only | No flag; no new transport | Behavior-preserving transaction-taking internal booking core, ordinary entry points unchanged. Existing booking tests remain green; demonstrate rollback and organization → sorted hosts → event → users → members → round-robin lock ordering, with no provider I/O inside locks. |
| C2a Host picks a time: atomic finalize | C1 | None; internal finalize service only | No flag; no new transport | Service selects eligible booker/attendees and commits booking, poll, receipts and delivery intents together. Test MAX_GUESTS + 1, locked event settings, guest permission/answers, conditional consent, strict availability/limits/buffers, safe projection and exact/changed replay. Inject failure after booking insertion and assert complete rollback. |
| C2b Host picks a time: concurrency and scheduling modes | C2a | None; internal service tests only | No flag; no new transport | Harden and test vote/finalize, two-finalizer and ordinary-booking collisions: finalize while open with a stale results revision returns `poll_changed`, and finalize after close succeeds even when a voter edited every second until closure. Test collective rollback and round-robin fairness; group/one-time-link rejection without seat/link mutation. This is a required integration gate before exposing finalize. |
| C3 Host picks a time: outcomes | C2b | None; internal notification delivery only | No flag; no new transport | Notifications to all eligible retained voters and ordinary selected-attendee/host booking mail. Test unverified invited recipient, locale/zone, cancellation/update, conference readiness, deletion/withdrawal and replay dedupe. No nonselected ICS/join/manage capability; host finalize projection never includes manageToken; source is the finalizing transport. |
| D1 Agent and host access: read and lifecycle transports | C3 | Host list/read/results/close/cancel/delete/finalize REST, MCP and CLI together | No flag; host lifecycle transports available, no creation transport yet | Matching thin adapters, OpenAPI/generated types and scope registry, tested on service-created polls. Extends the results service with advisory availability, computed after the locked results read (never under the poll lock) and shared by REST, MCP and CLI. CLI reads secrets from stdin from introduction. Test session context, key scopes, invalid bearer, pagination, tenant boundaries, secret-free metadata, conditional selection, revision/error parity and no returned manage capabilities. |
| D2 Agent and host access: creation and roster transports | D1 | Host create/invite/resend/remove/remove-unverified/rotate-link REST, MCP and CLI together | No flag; host creation transports available with every lifecycle operation | Matching thin adapters; CLI reads secrets from stdin from introduction. Test one-time link return, invitation outcomes, create/invite/rotate replay, mutation authority, `poll_link_unavailable` in invited mode and replay/error parity; regenerate OpenAPI/types. |
| D3 Agent and host access: agent UX and contracts | D2 | No operations added; polish landed MCP/CLI adapters | No flag; existing transports available | Polish CLI help and MCP discovery; end-to-end contract coverage for host and public adapters already shipped. Stdin secret handling is already mandatory in B2/D1/D2. Exercise create, results and finalize across surfaces, insufficient scopes, public capability access and redacted diagnostics. |
| D4a Agent and host access: list, results and lifecycle UI | D3 | None added; consumes D1 REST | No flag; host results and lifecycle UI available | Poll list, results matrix with advisory availability, booker/attendee selection, conditional acknowledgment/finalize, close/cancel/delete confirmations and booking link, for polls created through D2 transports. Switches the B4 deadline-mail results link from the D1 REST endpoint to this page. Test en/zh-CN, stale results/lost finalize responses, unavailable slots, attendee cap, aggregate inference explanations and the switched mail link. |
| D4b Agent and host access: creation and roster UI | D4a | None added; consumes D1/D2 REST | No flag; host creation UI available | Personal/team creation and invitation roster with invite/resend/remove, bulk remove-unverified and rotate-link. Pair link rotation with bulk removal when responding to a leaked link, since removal immediately frees the affected IPs' pending allowances. Reuse event/duration and DST-resolved candidate pickers; deadline, admission mode and visibility disclosures. Test en/zh-CN, stale creation/invitation forms, lost responses and enrollment-cap explanations; preserve weekly-hours hint and neutral unknown readiness. |
| E1 Docs and independent acceptance: docs | D4b | None added; document landed REST/MCP/CLI | No flag; all surfaces available | Publish implemented REST/MCP/CLI/UI guides, privacy/limits/mail/retention and self-hosting behavior; check examples against schemas and no design-only route claims. Document that erasing one voter's poll data in a canceled or scheduled poll requires deleting the whole poll. Deleting a scheduled poll preserves its linked booking. Record remaining limitations and owner steps. |
| E2 Docs and independent acceptance: acceptance | E1 | None added; verify all landed surfaces | No flag; all surfaces available | Independent acceptance across multiple time zones and all surfaces, using fake providers. Verify complete vote-to-booking flow, guest limit, notification audiences, no-login 320px page, scopes, source and token privacy, concurrency/replay and the time cases below. Record mutation evidence and unresolved release blockers. |

Keep every pool bounded and close it; individual files must stay well below CI's default
100 connections. Each sub-step includes targeted regression and source-copy mutation checks;
release gates and independent acceptance run against the complete implementation.

Required time tests across these tasks: spring-forward gaps, both fall-back offsets,
non-hour transitions, zones on opposite sides of midnight, host all-day busy intervals,
UTC deadline equality and a transaction waiting across it, database fractional-second
rounding, elapsed duration across DST, reschedule/cancel after finalization, and replay
after each lifecycle change. Every new protection needs a source-copy negative/mutation
check demonstrating a real assertion fails when removed, then restoration.

## Current limitations

- A poll covers one ordinary booking. Automatic winners, candidate edits, reopening,
  deadline extensions, calendar holds, arbitrary hosts, named public votes, recurring
  polls, payment collection, group seats, one-time-link composition and poll imports are
  unavailable. Changes to snapshotted event settings require a new poll.
- The booker can manage the whole booking. Ordinary guest mail follows the booker's
  language and time zone. Guests cannot cancel independently through the poll.
- For a scheduled or canceled poll, removing one voter's poll data requires deleting the
  whole poll. Terminal history lacks an automatic age-based retention setting in the
  shipped worker.
- Canceling an unscheduled poll ends voting without sending voters a cancellation email.
- The public page and public read API preserve the original poll outcome after a
  booking reschedule or cancellation. The booking and informational emails convey
  subsequent changes.

## Owner steps and planned work

- Self-hosters should configure SMTP and run a worker-enabled process, back up the
  database and keep `BETTER_AUTH_SECRET` consistent across roles. Set a local procedure
  for deleting terminal poll history. Configure trusted proxies for accurate IP limits.
  See the [proxy setup](https://hourmere.com/docs/self-hosting#proxy-behavior-and-an-existing-proxy).
- The project lead owns the planned E2 independent acceptance against the final head
  using fake providers. Verify UI, REST, MCP and CLI through vote-to-booking, plus the
  privacy, authority, mail, guest-limit, time-zone and concurrency cases in the plan.
- A per-organization outbound mail budget is a separate prerequisite for open Cloud
  sign-up.
