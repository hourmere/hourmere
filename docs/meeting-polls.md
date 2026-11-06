# Meeting polls: data model and flow proposal

Status: design only, checked against the repository and official help on 2026-11-06.
Nothing in this document is an implemented endpoint, table or product promise. The later
implementation tasks must deliver the same capability through REST, MCP and CLI, including
on self-hosted instances without feature gating. This proposal extends the
[data model](data-model.md), [API conventions](api-conventions.md),
[MCP contract](mcp.md) and [notification system](notifications.md).

## Verified competitor behavior

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
times. This is attendee-to-host negotiation, not evidence of a host-created multi-voter
poll. No official help page establishing that latter behavior was found; the brief's
Cal.com poll premise remains unverified. Do not infer a public voting matrix, vote values,
privacy defaults or a poll API from those pages. These observations are dated source
facts; the decisions below are Hourmere's proposal, not competitor claims.

## Product decisions and authority

A poll proposes one meeting, with one event type, one selected allowed duration and a
fixed candidate set. It is created directly as `open`; no draft rows or automatic winner.
Use three explicit values: `yes`, `if_need_be`, `no`. Conditional availability is useful
when unanimity is impossible, but must not be counted as an unconditional yes. Show
separate counts, never turn missing answers into no, and never select a winner on counts
alone. Every submitted ballot answers every candidate; before submission it is unanswered.

Personal event owners may manage their polls. Current team owners/admins may manage polls
for event types in that team; ordinary members, including configured hosts, do not gain
poll administration. Creator attribution is not enduring authority after departure or
role demotion. Recheck event ownership, organization membership and role on every read,
mutation and replay. Hosts come only from the event type, not arbitrary submitted user IDs.
Session writes require the existing same-origin and `X-Expected-Organization-Id` rules;
API keys remain bound to their organization. Use existing authorization lock ordering for
session/team changes. Unknown readiness stays neutral, never “configure your calendar”.

Proposed key classification: `full` or `bookings` for create, invite, resend, remove voter, delete, close, cancel,
finalize, rotate-link and bulk remove-unverified plus public vote writes; `full`, `read` or `bookings` for private list/detail/results, as with existing
booking reads. Public POST `read` is `booking_read` with `optional_key` authentication
and accepts `full`, `read` or `bookings`; rotate-link and bulk remove-unverified are host
booking writes, requiring `full` or `bookings`.
No scope bypasses owner/admin checks. `read` cannot vote or mint capabilities. MCP OAuth
keeps its existing `mcp:tools` grant and organization authority. Public capability access
requires no key; if a bearer is supplied, validate its scope without anonymous fallback.
An agent may relay a voter's explicit choices using that voter's capability; a host key
alone cannot impersonate voters or recover their edit tokens.

Reuse event duration, location and booking questions. Snapshot the title, duration,
location configuration, questions, scheduling mode, host IDs and guest policy when creating
for stable voter disclosure. Store a canonical hash of these relevant settings. Finalize
compares it with current settings; a mismatch requires a new poll (`poll_event_changed`),
not silent reinterpretation of old consent. Availability, buffers, notice, booking windows,
limits and calendar freshness always use current policy. Notification policy is snapshotted
by the booking service when booking. Disabling/deleting the event or losing eligible hosts
prevents finalization. Do not expose private connection IDs in the public snapshot.

## Voters, visibility and booking participants

Two fixed admission modes: `public_link` and `invited`. Public means no Hourmere login,
not anonymous data: name and email are required, with mailbox verification before the
ballot becomes counted. Unverified public-link enrollees receive only verification mail;
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
Only public-link self-enrollment and its recovery attempts have a one-hour pending expiry,
or the deadline if earlier; resending never extends it. Derive expiry under the poll lock
before checking capacity, without a cleanup worker; expired public credentials cannot verify.
Host invitations reserve capacity atomically at invitation time and keep their place and
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

A voter confirms mailbox possession with an explicit POST using the emailed capability;
merely reading the page does not verify or submit consent. A verified voter can replace
their complete ballot or withdraw while voting is open. Withdrawal removes the ballot
from counts, clears answers and opts out of further poll mail; retain a minimal mailbox
key/tombstone for uniqueness until poll deletion. Reactivation before closing requires
that same capability, renewed consent and an atomic capacity check. Withdrawal suspends
voting authority but retains the credential solely for read-only access and explicit
reactivation; removal or host revocation invalidates it entirely. Name/zone/locale may
be edited before closing; changing email requires a new verified enrollment. Lost links
use rate-limited mailbox recovery with uniform responses, never a host read.

Managers can remove a voter or revoke a pending enrollment while open or closed. Removal
revokes capabilities and queued mail, erases answers/ballot/contact data, frees capacity
and retains only a mailbox digest to block self-reenrollment until poll deletion. No
removal email is sent. Scheduled polls require booking lifecycle operations for attendee
changes. Managers can close voting early, cancel an unscheduled poll, or delete a poll in
any state; deleting a scheduled poll erases poll history without canceling its booking.
Deletion revokes all poll links and pending deliveries and follows the privacy cascade
below. These operations use current authority, expectedRevision and the common poll lock.

Privacy default is `private`: voters see only their own choices and the candidate list,
not other names, email addresses, answers or totals. A host can choose `aggregate` at
creation, exposing only per-candidate yes/conditional/no counts after verification.
With two or three voters, totals minus one's own ballot can reveal another person's
choices; aggregates are not anonymity. Mitigate this with private-by-default visibility
and explicit creation-time and voter disclosures before opting into aggregate sharing.
This setting is immutable after publication; no named-vote sharing option in this version.
Host/admin views show the roster, ballots and verification/withdrawal state. Unverified
public-link readers receive neither counts nor roster. Host-only question answers never
appear in voter views. Public outcome contains the chosen time/status, not booking IDs,
roster, answers, management capabilities or conference links.

Finalization explicitly supplies `bookerVoterId` and `attendeeVoterIds`. All must be verified,
non-withdrawn voters with yes or conditional votes for the chosen slot and consent to join.
There must be a booker included in that set; no/no-response voters cannot be silently added.
The host may select a subset and must acknowledge conditional votes in the confirmation
payload. Persist the chosen booker/guest role on each selected voter in the finalization transaction
for outcome delivery and later lifecycle updates. All remaining active voters receive a time-selected notice saying they were not
included, without a join link or calendar invitation. Voting UI explains this selection
policy and that the designated booker can manage the whole meeting.

Map the booker to the existing invitee and other selected voters to guests of a single
ordinary booking. Require `allowGuests` for multiple attendees and preserve the existing
guest cap: selected attendees must number 1 through `MAX_GUESTS + 1` (currently 11),
including the booker. Enforce this at finalize against exported `MAX_GUESTS = 10` in
[`bookings.ts`](../packages/scheduling/src/bookings.ts), with `too_many_guests` for excess
guests, even though up to 40 people may enroll. Collect the event questions from each voter with the ballot; finalization
passes only the designated booker's validated answers into the booking. Other answers
remain private poll data until retention cleanup. Do not merge answers. The host cannot
invent missing required answers. Poll mail uses each voter's saved zone/locale; ordinary
booking guest messages retain the existing booker-language/zone behavior. The booking's
calendar invitation can reveal attendees to one another: disclose that before voting;
poll privacy does not promise a private calendar attendee list.

## Proposed tables and invariants

No migration is included here. New application IDs use UUIDv7 with `DEFAULT uuidv7()`;
FK types match existing UUID organization/user/event/booking keys. Every table carries
`organization_id`, `created_at` and `updated_at` (`timestamptz`, server assigned). Instants
are UTC; `display_time_zone`/`time_zone` are validated IANA names. Use snake_case columns,
camelCase API fields, CHECK-constrained text states, and organization-scoped queries.

| Table | Columns beyond common fields | Constraints and indexes |
|---|---|---|
| `meeting_polls` | `id`, `event_type_id`, nullable `created_by_user_id`, source/API-key attribution, `title`, `duration_minutes`, `display_time_zone`, `settings_snapshot jsonb`, `settings_fingerprint`, `admission_mode`, `visibility`, `deadline_at`, `status`, `closed_at`, `canceled_at`, `scheduled_at`, nullable `chosen_slot_id`, `booking_id`, nullable `public_token_digest`, `revision` | PK id; UNIQUE `(organization_id,id)`; scoped event FK; unique token digest; status CHECK open/closed/scheduled/canceled; positive duration; deadline after creation; chosen slot and booking both present iff scheduled; unique non-null booking ID; `(organization_id,created_at,id)` pagination; partial `(deadline_at,id)` for open polls |
| `meeting_poll_slots` | `id`, `poll_id`, `start_at`, `end_at`, `position` | scoped poll FK; UNIQUE `(organization_id,poll_id,id)` and `(poll_id,start_at,end_at)`; unique `(poll_id,position)`; end > start; trigger/service enforce exact poll duration and immutable slots; `(poll_id,start_at)` |
| `meeting_poll_voters` | `id`, `poll_id`, `name`, `email`, `email_key`, `verified_at`, `pending_expires_at`, `invited_at`, `withdrawn_at`, `removed_at`, `reminder_opted_out_at`, `ballot_submitted_at`, `admission_ip_digest`, `time_zone`, `locale`, `responses jsonb`, `join_consent_at`, `ballot_revision`, nullable `selected_booking_role` (booker/guest) | scoped poll FK; UNIQUE `(organization_id,poll_id,id)`, `(poll_id,email_key)`; `(poll_id,verified_at)` for roster; only verified active ballots count; public pending expiry ≤ admission + 1 hour and ≤ deadline; host invitations have null pending expiry; `(poll_id,pending_expires_at)` for expiry |
| `meeting_poll_capabilities` | `id`, `poll_id`, `voter_id`, `purpose` (verification/voting/reminder_opt_out), nullable `voting_capability_ciphertext`, `token_digest`, `generation`, `expires_at`, `consumed_at`, `revoked_at` | scoped voter FK; unique token digest; positive generation; purpose-bound credentials following `waitlist_capabilities`; public verification expiry bounded by pending expiry, invited voting credential expires at deadline; opt-out never grants voting authority |
| `meeting_poll_mailbox_counters` | `id`, `poll_id`, `email_key`, `resend_count`, `last_resend_at`, `reminder_consumed_at`, `removed_at`, `purge_at` | UNIQUE `(poll_id,email_key)`; no voter FK, survives voter expiry/removal/recreation; resend count 0–3; reminder receipt never resets; poll deletion/retention purges ledger |
| `meeting_poll_votes` | `id`, `poll_id`, `voter_id`, `slot_id`, `value` | UNIQUE `(poll_id,voter_id,slot_id)`; composite organization/poll/voter and organization/poll/slot FKs prevent cross-poll/tenant votes; value CHECK yes/if_need_be/no; `(poll_id,slot_id,value)` tally index |
| `meeting_poll_operations` | `id`, nullable `poll_id`, `operation`, `actor_scope_digest`, `idempotency_key_digest`, `request_fingerprint`, nullable `booking_id`, minimal result metadata | UNIQUE `(organization_id,operation,actor_scope_digest,idempotency_key_digest)`; scoped poll/booking FKs; no raw request, token, roster or response cache |
| `meeting_poll_deliveries` | `id`, `poll_id`, nullable `voter_id`, nullable `host_user_id`, `kind`, `generation`, `due_at`, `state`, `attempts`, `lease_id`, `lease_until`, nullable purpose-bound `capability_ciphertext`, safe error class | exactly one recipient: scoped voter FK or host user FK; separate partial UNIQUE `(poll_id,voter_id,kind,generation)` and `(poll_id,host_user_id,kind,generation)`; partial due index for pending rows and expired claims; bounded retries and terminal sent/suppressed/skipped outcomes |

`email_key` is a domain-separated keyed HMAC digest of the normalized mailbox, never
plaintext; use it for uniqueness, removal tombstones and durable mail counters.
`admission_ip_digest` is a keyed digest of the trusted client IP for public pending limits;
retain only while needed for admission accounting. Capability purposes/generations are
independent: rotating verification/voting must not revoke an opt-out credential or reset
its stored opt-out. Keep encrypted voting capability material with purpose binding until
deadline/revocation for direct reminder delivery; terminal delivery ciphertext alone is
not sufficient after initial invitation mail has been erased. This encrypted material is
stored in a nullable `voting_capability_ciphertext` column on the capability row and purged
on deadline/revocation; never expose it in host reads. Voting expiry at the deadline
disables writes, but the retained digest still authenticates read-only own-ballot access
until poll retention/deletion; removal/revocation invalidates reads as well.

Add a composite chosen-slot FK `(organization_id,id,chosen_slot_id)` to slots' scoped
identity, and a scoped booking FK `(organization_id,booking_id)` to a matching unique
booking key. Add supporting unique indexes in the future migration if absent today.
A deferred constraint trigger verifies that the scheduled booking belongs to the poll's
event and selected UTC interval when first linked, and enforces the scheduled pair.
Cancellation/rescheduling later does not invalidate that historical link. Trigger/service
checks enforce candidate and enrollment caps under the poll lock; CHECK cannot count child rows.
The service, not user input, controls lifecycle timestamps/revisions and token digests.

Organization deletion cascades poll data; event soft deletion leaves history but blocks
new writes. Creator deletion nulls attribution, without transferring personal poll access.
Privacy deletion of a poll removes its voters, answers, votes, tokens and deliveries;
operation tombstones retain only non-personal replay identity for the configured retention
window. Normal terminal retention uses the installation's booking-data retention policy;
implementation must document an explicit cleanup schedule, including abandoned open polls.
Booking retention is independent. Deleting a linked booking must first clear/delete the
poll's personal history consistently, rather than leave a broken scheduled-pair invariant.

## Availability and atomic finalization

Validate every proposed interval against the existing availability engine at creation,
including duration, schedule, current busy data, minimum notice, window, limits and buffers.
Candidates may overlap each other because they are alternatives. Reject exact duplicates.
The deadline must precede every candidate start and leave the event's current minimum notice
before the earliest candidate. No hold rows, provisional bookings or external calendar
writes while open: a long-running poll must not monopolize the host's calendar or consume
booking limits. Clearly describe candidates as proposals, not reservations.

Recheck availability when viewing host results, but treat it as advisory. Busy candidates
remain visible with ballots preserved; no automatic vote migration. Unknown/stale calendar
state is unavailable to finalize and neutrally labeled. Finalization strictly revalidates
current availability; no buffer or external-busy override. A conflict leaves the poll and
all votes intact so the host can choose another candidate or cancel and create a new poll.
Local exclusion constraints cannot stop a new external calendar event after the last sync;
existing freshness safeguards and eventual provider reconciliation still apply.

The existing `createPublicBooking` path in
[`bookings.ts`](../packages/scheduling/src/bookings.ts) owns its transaction. Calling it
and then updating the poll would permit an orphan booking. Implementation step C1 must
extract a transaction-taking internal booking core, keeping existing entry points and
protections, and compose finalization in that same transaction:

1. Validate caller, scope and expected organization; acquire the existing authority locks.
   Lock poll before its voter/slot rows; all poll writes share this order. Preserve the existing order: organization SHARE, sorted full-host advisory locks,
   event SHARE, users SHARE, members SHARE, then round-robin state. The poll lock fits
   after organization authority and before the host phase.
   Audit deletion/cascade paths for reverse acquisition and test them before release.
2. Check scoped idempotency receipt and lifecycle. Take the core's sorted host advisory
   locks, then event `FOR SHARE`, and read the locked `current` event row before comparing
   its settings fingerprint. Never compare against an unlocked pre-read. Check selected
   slot, roster, attendee cap, ballot revisions, consent and required answers. Finalize accepts open or closed
   polls with future eligible slots; it freezes voting atomically, even before the deadline.
3. Reuse the core's current availability, per-host serialization, buffer/limit checks,
   membership checks, host selection and database exclusion constraint. Insert booking,
   attendees and immutable settings; create conference/calendar intents and notification
   outbox rows using the same transaction. Never call providers while holding locks.
4. Set chosen slot, original booking ID, scheduled timestamp and status; persist operation
   receipt and per-voter outcome delivery intents. Commit everything or nothing. Outbox
   workers run after commit, with existing conference readiness gates.

Host finalize responses, including exact replay through REST, MCP and CLI, whitelist safe
booking metadata and never contain the booker's `manageToken` or manage URL. Only normal
booker confirmation mail conveys management authority. Preserve existing `bookings.source`
values from the finalizing transport: `web` for host UI, `api` for direct REST/API-key
clients, and `mcp` for MCP and the CLI that calls MCP. Preserve API-key/OAuth attribution;
there is no new `poll` enum value. The poll-to-booking FK identifies poll origin.

| Event mode | Proposed behavior |
|---|---|
| Personal or team individual | One configured host; ordinary booker plus permitted guests |
| Collective | All current pinned hosts must pass validation; one booking consumes each host's availability; any conflict rolls everything back |
| Round-robin | Create validates that at least one eligible pool host offers each candidate; finalize selects through current fairness state, not a voter-specified host; advance fairness only on commit; changed pool fingerprint requires a new poll |
| Group seats | Reject with `poll_event_unsupported` in this version. Independent seats have separate answers, capabilities and capacity; neither multiple ordinary bookings nor silently turning voters into seats is correct. Later seat support needs all-or-nothing capacity admission and explicit per-seat lifecycle/notifications |
| One-time links | Not accepted as poll input or finalization authority; reject token-bearing payloads. Polls reference event IDs under host authority and neither reserve nor consume a one-time link. Future integration must consume exactly once in the booking transaction, never at proposal/vote time |

A scheduled poll is immutable history. Reschedule/cancel the resulting booking through the
existing booking services, not by reopening the poll. Retain the original booking link and
resolve its successor chain on authorized reads; show original chosen time separately from
current booking time/status. Public outcome must not keep advertising a canceled or moved
meeting as current. Booking lifecycle notifications cover selected attendees; send a
privacy-safe outcome update to other active voters without giving them booking authority.
Poll cancel only operates before scheduling; after scheduling return `poll_already_scheduled`
and direct an authorized host to the booking lifecycle operation.

## Deadline, concurrency and replay

Transitions: `open → closed` by host or deadline; `open|closed → scheduled` by successful
finalization; `open|closed → canceled` by host. No reopening and no deadline extensions in
this version. Expiry closes voting, not booking selection; if all times have passed the
host can only cancel. A worker persists closed status, but reads derive effective closed
state whenever the database clock reaches the deadline, even if that worker is late.

Enrollment, verification, invitations, votes, replacements, withdrawals, expiry, reactivation, resend, removal, deletion, close, cancel and finalize serialize on the poll row.
After acquiring it, capture `clock_timestamp()` once; accept voting iff status is open
and that instant is strictly before `deadline_at`; admission and verification use the same
check. Repeated verification returns current own state without reopening or extending access. Equality is closed. Request arrival time
and transaction-start `now()` are not authoritative. A vote that passes this check may
commit after the wall-clock deadline; it linearized before it. A waiter checked after the
deadline fails. Require `expectedBallotRevision` for edits and `expectedRevision` for host
writes; stale forms get `poll_changed`, never overwrite a concurrent decision. Every
admission, verification, ballot/profile edit and withdrawal increments poll revision as
well as any affected ballot revision; finalization expectedRevision therefore protects
the complete results/attendee snapshot, not only host edits.

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
metadata without a link and rejects rotate-link with `poll_event_unsupported`. Voter-token recovery likewise rotates by verified
mail delivery. Retain digest-only receipts with the poll; after retention expiry a replay
cannot promise deduplication. Clients must not reuse keys for new intent.

## Notifications, abuse and time zones

Use durable transactional delivery intents for invitations/verification, a deadline
reminder, time-selected outcomes and cancellation. Schedule the reminder at deadline minus
24 hours, only when that instant is after creation. Send at most one deadline reminder per
poll/mailbox, while voting is open, to every non-withdrawn, non-removed host invitee with
no submitted ballot, including invitees who never verified, plus verified public-link
voters with no submitted ballot. Never remind people who already voted or unverified
public-link enrollees. Recheck `ballot_submitted_at`, withdrawal, removal and opt-out just
before sending; no overdue catch-up after closure. Each invitation and reminder contains
a purpose-limited opt-out link: explicit POST records `reminder_opted_out_at` without
requiring login or verification, never grants ballot access, and suppresses further
reminders. Withdrawal additionally opts out of all poll mail. Resend/recovery never
clears opt-out or resets the once-per-poll/mailbox reminder receipt.

Host resend invitation is an explicit operation for a retained, nonremoved,
nonwithdrawn invitee while open: at most one accepted resend per mailbox per 15 minutes
and three per poll/mailbox, plus existing actor/organization/IP/recipient mail budgets.
Persist these counters across expiry/removal/recreation. It rotates the emailed capability,
invalidates the old generation and queues a new durable intent without reacquiring capacity.
A retained idempotency key makes retry mail-free. Requests beyond cooldown/budgets return
429 `rate_limited` with Retry-After when known; no resend extends the poll deadline.
Reminders carry the still-valid voting credential directly in the voter-page fragment,
including for unverified invitees and when enrollment capacity is full; no recovery detour.
Resend/recovery are for genuinely lost mail. Recovery always gives uniform 202 and rotates
only eligible credentials; invited recovery preserves the reserved place and deadline.
Public pending recovery never extends the original one-hour reservation; after expiry a
new enrollment must acquire capacity. Invited-mode recovery needs no public link.

Cancellation invalidates pending invitations/reminders. Workers recheck state, recipient
consent and generation, deduplicate per recipient, obey existing instance and recipient
mail budgets, and recover expired claims without resetting attempts. SMTP is outside
transactions; the existing acceptance/failed-receipt duplicate window remains. Store
temporary delivery capabilities encrypted with purpose binding, delete after terminal
delivery, and never put raw capabilities in logs, job metadata, analytics or replay records.

Every retained non-withdrawn, non-removed voter receives the chosen-time outcome, including
unverified host invitees; unverified public-link enrollees receive no outcome mail. Selected
attendees receive it through normal booking confirmation rather than a duplicate calendar
invite. Non-selected voters get plain informational mail, no ICS, join URL or manage link.
Preserve ordinary conference gates. Invitations and pre-booking cancellations carry no ICS.

Host mail: on deadline closure, enqueue one `deadline_closed` notice for the creator if
still authorized; never fan out to all team admins or transfer it after departure. It
contains title, deadline in the profile zone, response count and an authenticated results
link (the D1 REST results resource until the D4b page lands), no roster, answers or voter capabilities. Recheck current authority before send;
skip after cancellation, scheduling or deletion. Explicit early closure does not send it.
There are no per-vote host emails. A successful booking uses existing normal host
confirmation/lifecycle mail, without an extra poll-selected host message. Delivery storage
supports a host recipient separately from a voter; dedupe host deadline mail once per poll.
Use the shared locale registry in `packages/core/src/locales.ts`: invitation language
chosen by host then instance fallback, subsequent poll mail in voter's saved locale, host
mail in current profile locale. Add complete natural public translations in every shipped
locale and en/zh-CN admin text in the later tasks; no new product strings in this task.

Store start/end/deadline as UTC `timestamptz`. Accept explicit offsets, normalize to database
microseconds before fingerprints/comparisons, and return RFC 3339 Z timestamps. Reject
invalid zones and unresolved ambiguous/nonexistent local input; a local-time picker must
explicitly resolve fall-back offsets. Elapsed duration determines end, not local wall-clock
addition. Display each candidate and deadline in the voter's selected IANA zone, including
local date and offset when ambiguous. Switching zone changes labels only, never ballot IDs.

Public routes use no-store, no-referrer, no indexing and no third-party scripts. Put secrets
in URL fragments for browser entry, then send them in protected request bodies/headers;
redact them from request diagnostics. Use domain-separated digests, constant-time token
verification, explicit rotation and revocation. No raw capabilities in list/results APIs.
Rate-limit by trusted client IP, poll, organization and normalized mailbox digest, with
bounded payloads, enrollment and mail work. Reuse existing email budgets; do not deliver
arbitrary host HTML or reminders to unverified public-link enrollees. Configure shared rate-limit enforcement
for multiple processes; per-process limits alone are insufficient. Additional mail budgets
and retention schedules must be selected and documented in the service task using existing
abuse-control policy; they are not new constants pinned here. Forwarded public links and
mailbox aliases can still admit unwanted voters; invited mode is recommended for sensitive
meetings. Email verification is not proof of a unique human.

Existing `PUBLIC_RATE_LIMITS` in `apps/server/src/rate-limit.ts` are per trusted IP per
60 seconds: page/slots 120, book 10, manage 30. Enrollment/recovery/verification share a
10-request-per-minute admission bucket across transports and processes. Read uses 120,
and ballot/withdraw/opt-out uses 30 per minute. These alone do not stop filling 40 places:
one IP can submit 40 enrollments in roughly four minute windows and refill with 40/hour;
a catch-all mailbox can verify 40 voters with 80 admission requests in roughly eight windows.
Fixed-window boundaries can shorten elapsed time. The binding additional control is at
most 3 concurrent unexpired public pending reservations per trusted IP per poll, checked
atomically under the poll lock; 40 pending places therefore need at least 14 IP addresses.
Reject excess with 429 `rate_limited`, without mail. Host invitations bypass this public
pending-IP limit but count against 40 total places. Shared NATs may need host invitations.
Verification frees the pending-IP allowance: catch-all/distributed verified abuse remains
possible, so this is not a unique-human guarantee. A global per-poll request budget must
not be the primary control: an attacker could spend it to block legitimate voters.
Hosts can bulk remove unverified public enrollees (never host invitees), individually
remove verified abusers, rotate a leaked public link, or cancel/recreate in invited mode.
Bulk removal retains mailbox tombstones/counters and uses the same lock/revision rules.

## Initial limits

These are proposed numeric contract facts for the later implementation; the doc-fact test
pins this table. Boundary validation belongs in the service and API tests later.

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
| Invitation resend cap | 3 per poll/mailbox | Bound total explicit resends even across expired reservations |

Deadline must also satisfy the candidate/notice rule above, so short-notice events can
have no valid deadline. Existing duration, field length, question and guest constraints
remain in force; the smaller applicable limit wins. The attendee minimum applies at finalization, not creation; enrollment can be zero.
The enrollment cap does not raise booking capacity. Expiry and host removal bound recovery
from public-link saturation; per-IP/poll/organization/mailbox admission budgets bound refill
and retained tombstone growth, and link rotation lets the host stop further leaked-link joins. Caps apply equally to self-hosting,
REST, MCP, CLI and UI. Expanding them requires reviewing booking capacity and mail budgets.

## Proposed REST, MCP and CLI contract

All names below are proposals for later tasks. `/api/v1` responses use camelCase, UUID IDs,
no-store, the existing `{error,message?,field?}` envelope and additive/open response schemas.
Document stable errors in OpenAPI and regenerate clients; clients ignore unfamiliar fields
and future response states. Services throw `DomainError`; no tool-specific business logic.

| REST resource/action under `/api/v1` | MCP tool | CLI under `hourmere polls` | Authority/result |
|---|---|---|---|
| POST `/meeting-polls` | `create_meeting_poll` | `create` | Manager; eventTypeId, candidate starts, durationMinutes, deadlineAt, displayTimeZone, admissionMode, visibility, idempotency key; 201 poll + one-time public link only in public_link mode |
| GET `/meeting-polls`, GET `/meeting-polls/{id}` | `list_meeting_polls`, `get_meeting_poll` | `list`, `get` | Manager; organization-scoped cursor pagination, lifecycle and safe metadata |
| GET `/meeting-polls/{id}/results` | `get_meeting_poll_results` | `results` | Manager; ballots, roster, separate counts, advisory availability and revisions |
| POST `/meeting-polls/{id}/invitations` | `invite_meeting_poll_voters` | `invite` | Manager; bounded name/email/locale list, idempotency key; 202 durable intent; all-or-nothing 409 poll_full if remaining capacity is insufficient, 400 poll_limit_exceeded for batch >40; no voter secrets |
| POST `/meeting-polls/{id}/invitations/{voterId}/resend` | `resend_meeting_poll_invitation` | `resend-invitation` | Manager; expectedRevision + idempotency key; 202 intent under resend limits, no secrets |
| DELETE `/meeting-polls/{id}/voters/{voterId}` | `remove_meeting_poll_voter` | `remove-voter` | Manager; expectedRevision; 200 removed state, revoke capabilities and release capacity |
| POST `/meeting-polls/{id}/remove-unverified` | `remove_unverified_meeting_poll_voters` | `remove-unverified` | Manager; expectedRevision; bulk revoke only unverified public enrollments, preserve host invitations and abuse counters |
| DELETE `/meeting-polls/{id}` | `delete_meeting_poll` | `delete` | Manager; expectedRevision; 204 privacy deletion, linked booking preserved |
| POST `/meeting-polls/{id}/close`, `/cancel` | `close_meeting_poll`, `cancel_meeting_poll` | `close`, `cancel` | Manager; expectedRevision; 200 current state, matching repeated intent has no extra mail |
| POST `/meeting-polls/{id}/finalize` | `finalize_meeting_poll` | `finalize` | Manager; slotId, bookerVoterId, attendeeVoterIds, conditional acknowledgment, expectedRevision, idempotency key; 201 safe booking metadata, 200 exact replay; never manageToken or manage URL |
| POST `/meeting-polls/{id}/rotate-link` | `rotate_meeting_poll_link` | `rotate-link` | Manager; public_link mode only, otherwise poll_event_unsupported; expectedRevision + idempotency key; one-time new public link, matching replay returns safe conflict |
| POST `/public/meeting-polls/read` | `read_meeting_poll` | `view` | Poll/voter capability; public projection, own ballot only, effective deadline and visibility |
| POST `/public/meeting-polls/enroll`, `/recover` | `enroll_meeting_poll_voter`, `recover_meeting_poll_voter` | `join`, `recover` | Enrollment: public poll capability + name/email/zone/locale; recovery: poll ID + mailbox, 202 uniform verification response; enroll returns 409 poll_full for every mailbox when full |
| POST `/public/meeting-polls/verify` | `verify_meeting_poll_voter` | `verify` | Emailed voter capability; explicit confirmation while voting is open, idempotent verification, no implicit ballot |
| POST `/public/meeting-polls/vote` | `submit_meeting_poll_vote` | `vote` | Voter capability; full slot/value array, consent, responses, expectedBallotRevision; 200 own ballot/revision |
| POST `/public/meeting-polls/reminder-opt-out` | `opt_out_meeting_poll_reminder` | `reminder-opt-out` | Purpose-limited mail capability; 200 opted-out state, no verification required |
| POST `/public/meeting-polls/withdraw` | `withdraw_meeting_poll_vote` | `withdraw` | Voter capability + revision; 200 withdrawn state |

Capability read is POST to avoid secrets in paths/query logs. Browser route proposal:
`/poll#<publicCapability>` and `/poll/voter#<voterCapability>`. MCP input schemas carry the
same capability fields; CLI reads secrets from stdin from the first adapter, never command-line
arguments or diagnostics. Classify every operation in the shared scope registry and keep
MCP discovery, direct-call insufficient-scope behavior and CLI help in sync. Invitation
and rotation replay receipts use the operation table; changed input conflicts and lost
responses never resend mail or recover raw secrets. Enrollment uses a uniform poll-level full response and otherwise uniform 202; recovery
always retains uniform 202 while enforcing cooldown/budget and active token generation.

| Status/code | Meaning |
|---|---|
| 400 `invalid_request` | Malformed shape at transport boundary |
| 400 `invalid_poll`, `poll_limit_exceeded`, `poll_event_unsupported` | Invalid instants/deadline/choices, bounded resource limit, or unsupported group/one-time-link mode; safe field hints |
| 401 `unauthorized`; 403 `insufficient_scope` | Existing bearer/session rules; never downgrade a supplied bad bearer |
| 403 `team_management_access_denied`; 409 `organization_context_changed` | Existing management/context boundary |
| 404 `poll_not_found` | Unknown/inaccessible poll or invalid capability, without disclosing existence |
| 409 `poll_full` | Enrollment/invitation batch/reactivation capacity reached; no mailbox membership disclosure |
| 409 `poll_closed`, `poll_canceled`, `poll_changed` | Deadline/state/revision refused the write |
| 409 `poll_already_created`, `poll_already_scheduled`, `poll_link_already_rotated`, `idempotency_key_reused` | Explicit replay/conflicting intent outcomes |
| 409 `poll_event_changed`, `slot_taken`, `calendar_sync_unavailable` | Refresh or choose another time; no partial booking or token consumption |
| 429 `rate_limited` | Existing request/mail abuse boundary; Retry-After when known |

Retain existing booking-service validation/conflict codes where applicable rather than
renaming them; list those in the later OpenAPI operation. A public closed read remains
200 read-only with own prior ballot; invalid capabilities remain uniformly unavailable.

## Implementation plan and acceptance checks

The five stages below run in A → B → C → D → E order. Each named sub-step is
approximately one working day, independently reviewable with its own tests. Dependencies
are explicit; no page depends on an endpoint or mail kind assigned to a later stage.
B2 owns public transport parity; D owns complete host/agent access and UX.
Stage C can exercise host selection through the service until stage D exposes host APIs/UI.
No feature flag is introduced: “No flag” below means each landed surface is available.
Before D1 there is no host creation endpoint, MCP tool or CLI command, so real users cannot
create polls. B1 mail links target the B3 voter page and B4 opt-out UI; B4 host deadline mail
targets the authenticated D1 results REST endpoint until D4b supplies the results page.
The mail URL switches to that page in D4b; D1 already lands before users can create polls,
so every available creation surface has a working results destination without a flag.

| Stage / day-sized sub-step | Depends on | Endpoint / MCP / CLI ownership | Flag state | Deliverable and acceptance |
|---|---|---|---|---|
| A1 Storage and service: schema | None | None; storage only | No flag; no transport | Poll, candidates, voters, votes, capabilities, mailbox counters, operation receipts and recipient delivery storage/types. Test scoped FKs, lifecycle pairs and caps; populated predecessor preservation, fresh install and no-op migration. Encode numeric admission controls and choose cleanup schedule before service admission lands. |
| A2 Storage and service: host lifecycle | A1 | None; internal service only | No flag; no transport | Create/read, authority, close/cancel/delete and link rotation services on polls without voters. Test tenant/role/context loss, no holds, immutable settings and idempotent receipts. Voter-dependent results, removal and privacy cascades belong to A4. |
| A3a Storage and service: enrollment and verification | A2 | None; internal service only | No flag; no transport | Enroll/invite/verify/recover/resend and purpose-specific credentials. Test 40-person capacity, atomic batch rejection, per-IP pending cap, public pending expiry freeing slots, durable invited places and credentials, full 409 uniformity and no expired capability reuse. |
| A3b Storage and service: ballots and deadline | A3a | None; internal service only | No flag; no transport | Submit/replace full ballots, withdraw/reactivate and opt-out. Test revisions, reacquiring capacity, consent and purpose separation; exact database-clock deadline equality and a transaction waiting across the deadline race; ballots read-only after deadline. |
| A4 Storage and service: results, removal and cleanup | A3b | None; internal service only | No flag; no transport | Results projection, remove voter/bulk remove-unverified, bounded terminal cleanup and public pending expiry, retained invitation eligibility, removal/rejoin blocks and deletion races. Test privacy cascades and retained abuse accounting, delayed workers never retaining public pending capacity, no lost opt-outs or reset budgets, and consistent booking-history deletion. Audit shared lock order. |
| B1 Public voting page: verification mail foundation | A4 | None; workers and internal delivery only | No flag; no transport | Invitation/verification/recovery/resend durable delivery, encrypted capabilities and finite leases/retries, using the existing outbox machinery. Test public expired-link recovery, invited credentials remaining valid until deadline, budgets, generation rotation, terminal suppression and the SMTP duplicate window with fakes. |
| B2 Public voting page: public transports | B1 | All public REST operations, matching MCP tools and CLI commands together | No flag; public transports available | Own public read/enroll/verify/recover/vote/withdraw/opt-out, OpenAPI/generated types and no-login checks; ship scope classification and matching MCP/CLI adapters together. CLI secrets must be read from stdin from this first step, never argv. Test service parity, invalid bearer, secret redaction, full-capacity responses and no-valid-token recovery entry. |
| B3 Public voting page: ballot UI | B2 | None added; consumes B2 REST | No flag; public page available | No login; verification/recovery, consent, ballots/edit/withdraw, timezone selection and read-only closure. Keyboard/screen-reader access and usable 320px stacked layout without overflow; all shipped locales, private/aggregate disclosures, neutral loading/403/errors, duplicate/stale submit, DST and midnight zone changes preserving slot IDs. Browser checks only through approved escalation/CI. |
| B4 Public voting page: reminder and host deadline mail | B3 | None added; opt-out UI consumes B2 REST | No flag; jobs and opt-out page available | Deadline jobs and mail/opt-out UI. Assert unverified nonresponding invitees receive one reminder carrying their valid voting credential even after one hour and when capacity is full; voted/withdrawn/removed/opted-out people and unverified public enrollees receive none. Test timing, no overdue catch-up, budget suppression, durable once-only receipts, authorized creator deadline notice and departed creator suppression. |
| C1 Host picks a time: booking-core extraction | B4 | None; internal booking core only | No flag; no new transport | Behavior-preserving transaction-taking internal booking core, ordinary entry points unchanged. Existing booking tests remain green; demonstrate rollback and organization → sorted hosts → event → users → members → round-robin lock ordering, with no provider I/O inside locks. |
| C2a Host picks a time: atomic finalize | C1 | None; internal finalize service only | No flag; no new transport | Service selects eligible booker/attendees and commits booking, poll, receipts and delivery intents together. Test MAX_GUESTS + 1, locked event settings, guest permission/answers, conditional consent, strict availability/limits/buffers, safe projection and exact/changed replay. Inject failure after booking insertion and assert complete rollback. |
| C2b Host picks a time: concurrency and scheduling modes | C2a | None; internal service tests only | No flag; no new transport | Harden and test vote/finalize, two-finalizer and ordinary-booking collisions; collective rollback and round-robin fairness; group/one-time-link rejection without seat/link mutation. This is a required integration gate before exposing finalize. |
| C3 Host picks a time: outcomes | C2b | None; internal notification delivery only | No flag; no new transport | Notifications to all eligible retained voters and ordinary selected-attendee/host booking mail. Test unverified invited recipient, locale/zone, cancellation/update, conference readiness, deletion/withdrawal and replay dedupe. No nonselected ICS/join/manage capability; host finalize projection never includes manageToken; source is the finalizing transport. |
| D1 Agent and host access: creation/results transports | C3 | Host create/list/read/results/invite REST, MCP and CLI together | No flag; host creation transports available | Matching thin adapters, OpenAPI/generated types and scope registry. CLI reads secrets from stdin from introduction. Test session context, key scopes, invalid bearer, pagination, tenant boundaries and secret-free metadata. |
| D2 Agent and host access: lifecycle transports | D1 | Host resend/remove/remove-unverified/close/cancel/delete/finalize/rotate REST, MCP and CLI together | No flag; host lifecycle transports available | Matching thin adapters; CLI reads secrets from stdin from introduction. Test conditional selection, mutation authority, replay/error parity and no returned manage capabilities; regenerate OpenAPI/types. |
| D3 Agent and host access: agent UX and contracts | D2 | No operations added; polish landed MCP/CLI adapters | No flag; existing transports available | Polish CLI help and MCP discovery; end-to-end contract coverage for host and public adapters already shipped. Stdin secret handling is already mandatory in B2/D1/D2. Exercise create, results and finalize across surfaces, insufficient scopes, public capability access and redacted diagnostics. |
| D4a Agent and host access: list, create and invitation list | D3 | None added; consumes D1/D2 REST | No flag; host creation UI available | Poll list, personal/team creation and invitation roster with invite/resend/remove and bulk remove-unverified. Reuse event/duration and DST-resolved candidate pickers; deadline, admission mode and visibility disclosures. Test en/zh-CN, stale creation/invitation forms, lost responses and enrollment-cap explanations; preserve weekly-hours hint and neutral unknown readiness. |
| D4b Agent and host access: results and lifecycle UI | D4a | None added; consumes D1/D2 REST | No flag; full host UI available | Results matrix with advisory availability, booker/attendee selection, conditional acknowledgment/finalize, close/cancel/delete confirmations and booking link. Test en/zh-CN, stale results/lost finalize responses, unavailable slots, attendee cap and aggregate inference explanations. |
| E1 Docs and independent acceptance: docs | D4b | None added; document landed REST/MCP/CLI | No flag; all surfaces available | Publish implemented REST/MCP/CLI/UI guides, privacy/limits/mail/retention and self-hosting behavior; check examples against schemas and no design-only route claims. Record remaining limitations and owner steps. |
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

## Out of scope and decisions to confirm

This change contains no schema, storage/service implementation, public page, host UI,
API/MCP/CLI registration or new UI strings. No automatic winner, candidate edits/reopening,
calendar holds, arbitrary non-event hosts, named public vote matrix, recurring polls,
payments, group seats, one-time-link composition or imported polls. Polls are preferences,
not RSVPs or verified external calendar availability. Booker's manage authority applies
to the whole ordinary booking; guest-localized booking mail and independent attendee
cancellation are not supplied by this design. A changed event snapshot requires restarting
a poll; the host should choose the final settings before sharing.

Project-lead acceptance should confirm the ordinary booker/guest mapping and separate enrollment/attendee caps,
aggregate-only sharing option, no-hold policy and explicit unsupported modes before storage
work starts. Cal.com's host-created multi-voter poll premise needs an official source if
it is to appear in future competitive claims. Later storage work must finalize numeric
abuse budgets/retention and prove lock-order compatibility; these are release gates, not
permission to ship unbounded enrollment or mail.
