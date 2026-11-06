# Meeting polls: data model and flow proposal

Status: design only, checked against the repository and official help on 2026-11-06.
Nothing in this document is an implemented endpoint, table or product promise. The later
implementation tasks must deliver the same capability through REST, MCP and CLI, including
on self-hosted instances without feature gating. This proposal extends the
[data model](data-model.md), [API conventions](api-conventions.md),
[MCP contract](mcp.md) and [notification system](notifications.md).

## Verified competitor behaviour

Calendly's [Meeting Polls overview](https://calendly.com/help/meeting-polls-overview)
says anyone with the link can vote without an account, supports up to 40 times and 40
participants, disallows adding times after publication and changing submitted votes,
and does not support workflows or rescheduling. The host chooses a time and can add
non-voters before booking. Voting closes on booking, deletion, or when all times pass.
Other voters are visible only with “Show votes on page” enabled. External conflicts are
flagged but can be booked over; Calendly booking conflicts cannot. Buffers can be overridden.
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
poll. No official help page establishing that latter behaviour was found; the brief's
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

Proposed key classification: `full` or `bookings` for create, invite, close, cancel,
finalise and public vote writes; `full`, `read` or `bookings` for private list/detail/results, as with existing
booking reads.
No scope bypasses owner/admin checks. `read` cannot vote or mint capabilities. MCP OAuth
keeps its existing `mcp:tools` grant and organization authority. Public capability access
requires no key; if a bearer is supplied, validate its scope without anonymous fallback.
An agent may relay a voter's explicit choices using that voter's capability; a host key
alone cannot impersonate voters or recover their edit tokens.

Reuse event duration, location and booking questions. Snapshot the title, duration,
location configuration, questions, scheduling mode, host IDs and guest policy when creating
for stable voter disclosure. Store a canonical hash of these relevant settings. Finalise
compares it with current settings; a mismatch requires a new poll (`poll_event_changed`),
not silent reinterpretation of old consent. Availability, buffers, notice, booking windows,
limits and calendar freshness always use current policy. Notification policy is snapshotted
by the booking service when booking. Disabling/deleting the event or losing eligible hosts
prevents finalisation. Do not expose private connection IDs in the public snapshot.

## Voters, visibility and booking participants

Two fixed admission modes: `public_link` and `invited`. Public means no Hourmere login,
not anonymous data: name and email are required, with mailbox verification before the
ballot becomes counted or eligible for mail. A high-entropy per-poll link allows enrollment;
invited mode permits only host-added addresses and sends separate per-voter capabilities.
Opening a link with GET never votes or confirms anything. Possession of an emailed voter
capability proves mailbox access for this poll, not an account identity. Use one normalized
(trimmed, lowercase) mailbox per poll, without provider-specific alias folding.

Public enrollment answers uniformly whether the mailbox exists, is pending, or has voted;
it neither returns an existing token nor overwrites that person's ballot. Verification
sends a protected edit link to that address, under mail budgets. Invitations and pending
public enrollments count toward the voter cap to bound storage and fan-out. A voter confirms mailbox possession with an explicit POST using the emailed capability;
merely reading the page does not verify or submit consent. A verified
voter can replace their complete ballot or withdraw with their own token while voting is
open. Withdrawal removes the ballot from counts, clears answers and opts out of further
poll mail; retain a minimal mailbox key/tombstone for uniqueness until poll deletion.
Reactivation before closing requires that same capability and renewed consent. Name/zone/
locale may be edited before closing; changing email requires a new verified enrollment.
Lost links use rate-limited mailbox recovery with uniform responses, never a host read.

Privacy default is `private`: voters see only their own choices and the candidate list,
not other names, email addresses, answers or totals. A host can choose `aggregate` at
creation, exposing only per-candidate yes/conditional/no counts after verification.
This setting is immutable after publication; no named-vote sharing option in this version.
Host/admin views show the roster, ballots and verification/withdrawal state. Unverified
public-link readers receive neither counts nor roster. Host-only question answers never
appear in voter views. Public outcome contains the chosen time/status, not booking IDs,
roster, answers, management capabilities or conference links.

Finalisation explicitly supplies `bookerVoterId` and `attendeeVoterIds`. All must be verified,
non-withdrawn voters with yes or conditional votes for the chosen slot and consent to join.
There must be a booker included in that set; no/no-response voters cannot be silently added.
The host may select a subset and must acknowledge conditional votes in the confirmation
payload. Persist the chosen booker/guest role on each selected voter in the finalisation transaction
for outcome delivery and later lifecycle updates. All remaining active voters receive a time-selected notice saying they were not
included, without a join link or calendar invitation. Voting UI explains this selection
policy and that the designated booker can manage the whole meeting.

Map the booker to the existing invitee and other selected voters to guests of a single
ordinary booking. Require `allowGuests` for multiple attendees and preserve the existing
guest cap. Collect the event questions from each voter with the ballot; finalisation
passes only the designated booker's validated answers into the booking. Other answers
remain private poll data until retention cleanup. Do not merge answers. The host cannot
invent missing required answers. Poll mail uses each voter's saved zone/locale; ordinary
booking guest messages retain the existing booker-language/zone behaviour. The booking's
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
| `meeting_polls` | `id`, `event_type_id`, nullable `created_by_user_id`, source/API-key attribution, `title`, `duration_minutes`, `display_time_zone`, `settings_snapshot jsonb`, `settings_fingerprint`, `admission_mode`, `visibility`, `deadline_at`, `status`, `closed_at`, `cancelled_at`, `scheduled_at`, nullable `chosen_slot_id`, `booking_id`, `public_token_digest`, `revision` | PK id; UNIQUE `(organization_id,id)`; scoped event FK; unique token digest; status CHECK open/closed/scheduled/cancelled; positive duration; deadline after creation; chosen slot and booking both present iff scheduled; unique non-null booking ID; `(organization_id,created_at,id)` pagination; partial `(deadline_at,id)` for open polls |
| `meeting_poll_slots` | `id`, `poll_id`, `start_at`, `end_at`, `position` | scoped poll FK; UNIQUE `(organization_id,poll_id,id)` and `(poll_id,start_at,end_at)`; unique `(poll_id,position)`; end > start; trigger/service enforce exact poll duration and immutable slots; `(poll_id,start_at)` |
| `meeting_poll_voters` | `id`, `poll_id`, `name`, `email`, `email_key`, `verified_at`, `withdrawn_at`, `token_digest`, `token_generation`, `time_zone`, `locale`, `responses jsonb`, `join_consent_at`, `ballot_revision`, nullable `selected_booking_role` (booker/guest) | scoped poll FK; UNIQUE `(organization_id,poll_id,id)`, `(poll_id,email_key)`, token digest; `(poll_id,verified_at)` for roster; only verified active ballots count |
| `meeting_poll_votes` | `id`, `poll_id`, `voter_id`, `slot_id`, `value` | UNIQUE `(poll_id,voter_id,slot_id)`; composite organization/poll/voter and organization/poll/slot FKs prevent cross-poll/tenant votes; value CHECK yes/if_need_be/no; `(poll_id,slot_id,value)` tally index |
| `meeting_poll_operations` | `id`, nullable `poll_id`, `operation`, `actor_scope_digest`, `idempotency_key_digest`, `request_fingerprint`, nullable `booking_id`, minimal result metadata | UNIQUE `(organization_id,operation,actor_scope_digest,idempotency_key_digest)`; scoped poll/booking FKs; no raw request, token, roster or response cache |
| `meeting_poll_deliveries` | `id`, `poll_id`, `voter_id`, `kind`, `generation`, `due_at`, `state`, `attempts`, `lease_id`, `lease_until`, nullable purpose-bound `capability_ciphertext`, safe error class | scoped voter FK; UNIQUE `(poll_id,voter_id,kind,generation)`; partial due index for pending rows and expired claims; bounded retries and terminal sent/suppressed/skipped outcomes |

Add a composite chosen-slot FK `(organization_id,id,chosen_slot_id)` to slots' scoped
identity, and a scoped booking FK `(organization_id,booking_id)` to a matching unique
booking key. Add supporting unique indexes in the future migration if absent today.
A deferred constraint trigger verifies that the scheduled booking belongs to the poll's
event and selected UTC interval when first linked, and enforces the scheduled pair.
Cancellation/rescheduling later does not invalidate that historical link. Trigger/service
checks enforce candidate and voter caps under the poll lock; CHECK cannot count child rows.
The service, not user input, controls lifecycle timestamps/revisions and token digests.

Organization deletion cascades poll data; event soft deletion leaves history but blocks
new writes. Creator deletion nulls attribution, without transferring personal poll access.
Privacy deletion of a poll removes its voters, answers, votes, tokens and deliveries;
operation tombstones retain only non-personal replay identity for the configured retention
window. Normal terminal retention uses the installation's booking-data retention policy;
implementation must document an explicit cleanup schedule, including abandoned open polls.
Booking retention is independent. Deleting a linked booking must first clear/delete the
poll's personal history consistently, rather than leave a broken scheduled-pair invariant.

## Availability and atomic finalisation

Validate every proposed interval against the existing availability engine at creation,
including duration, schedule, current busy data, minimum notice, window, limits and buffers.
Candidates may overlap each other because they are alternatives. Reject exact duplicates.
The deadline must precede every candidate start and leave the event's current minimum notice
before the earliest candidate. No hold rows, provisional bookings or external calendar
writes while open: a long-running poll must not monopolize the host's calendar or consume
booking limits. Clearly describe candidates as proposals, not reservations.

Recheck availability when viewing host results, but treat it as advisory. Busy candidates
remain visible with ballots preserved; no automatic vote migration. Unknown/stale calendar
state is unavailable to finalise and neutrally labelled. Finalisation strictly revalidates
current availability; no buffer or external-busy override. A conflict leaves the poll and
all votes intact so the host can choose another candidate or cancel and create a new poll.
Local exclusion constraints cannot stop a new external calendar event after the last sync;
existing freshness safeguards and eventual provider reconciliation still apply.

The existing `createPublicBooking` path in
[`bookings.ts`](../packages/scheduling/src/bookings.ts) owns its transaction. Calling it
and then updating the poll would permit an orphan booking. The storage/service task must
extract a transaction-taking internal booking core, keeping existing entry points and
protections, and compose finalisation in that same transaction:

1. Validate caller, scope and expected organization; acquire the existing authority locks.
   Lock poll before its voter/slot rows; all poll writes share this order. Preserve the existing order: organization SHARE, sorted full-host advisory locks,
   event SHARE, users SHARE, members SHARE, then round-robin state. The poll lock fits
   after organization authority and before the host phase.
   Audit deletion/cascade paths for reverse acquisition and test them before release.
2. Check scoped idempotency receipt, lifecycle, relevant event fingerprint, selected slot,
   roster, ballot revisions, consent and required answers. Finalise accepts open or closed
   polls with future eligible slots; it freezes voting atomically, even before the deadline.
3. Reuse the core's current availability, per-host serialization, buffer/limit checks,
   membership checks, host selection and database exclusion constraint. Insert booking,
   attendees and immutable settings; create conference/calendar intents and notification
   outbox rows using the same transaction. Never call providers while holding locks.
4. Set chosen slot, original booking ID, scheduled timestamp and status; persist operation
   receipt and per-voter outcome delivery intents. Commit everything or nothing. Outbox
   workers run after commit, with existing conference readiness gates.

| Event mode | Proposed behaviour |
|---|---|
| Personal or team individual | One configured host; ordinary booker plus permitted guests |
| Collective | All current pinned hosts must pass validation; one booking consumes each host's availability; any conflict rolls everything back |
| Round-robin | Create validates that at least one eligible pool host offers each candidate; finalise selects through current fairness state, not a voter-specified host; advance fairness only on commit; changed pool fingerprint requires a new poll |
| Group seats | Reject with `poll_event_unsupported` in this version. Independent seats have separate answers, capabilities and capacity; neither multiple ordinary bookings nor silently turning voters into seats is correct. Later seat support needs all-or-nothing capacity admission and explicit per-seat lifecycle/notifications |
| One-time links | Not accepted as poll input or finalisation authority; reject token-bearing payloads. Polls reference event IDs under host authority and neither reserve nor consume a one-time link. Future integration must consume exactly once in the booking transaction, never at proposal/vote time |

A scheduled poll is immutable history. Reschedule/cancel the resulting booking through the
existing booking services, not by reopening the poll. Retain the original booking link and
resolve its successor chain on authorized reads; show original chosen time separately from
current booking time/status. Public outcome must not keep advertising a cancelled or moved
meeting as current. Booking lifecycle notifications cover selected attendees; send a
privacy-safe outcome update to other active voters without giving them booking authority.
Poll cancel only operates before scheduling; after scheduling return `poll_already_scheduled`
and direct an authorized host to the booking lifecycle operation.

## Deadline, concurrency and replay

Transitions: `open → closed` by host or deadline; `open|closed → scheduled` by successful
finalisation; `open|closed → cancelled` by host. No reopening and no deadline extensions in
this version. Expiry closes voting, not booking selection; if all times have passed the
host can only cancel. A worker persists closed status, but reads derive effective closed
state whenever the database clock reaches the deadline, even if that worker is late.

Enrollment, verification, invitations, votes, replacements, withdrawals, close, cancel and finalise serialize on the poll row.
After acquiring it, capture `clock_timestamp()` once; accept voting iff status is open
and that instant is strictly before `deadline_at`; admission and verification use the same
check. Repeated verification returns current own state without reopening or extending access. Equality is closed. Request arrival time
and transaction-start `now()` are not authoritative. A vote that passes this check may
commit after the wall-clock deadline; it linearized before it. A waiter checked after the
deadline fails. Require `expectedBallotRevision` for edits and `expectedRevision` for host
writes; stale forms get `poll_changed`, never overwrite a concurrent decision. Every
admission, verification, ballot/profile edit and withdrawal increments poll revision as
well as any affected ballot revision; finalisation expectedRevision therefore protects
the complete results/attendee snapshot, not only host edits.

Create and finalise require retained random `Idempotency-Key` (MCP/CLI `idempotencyKey`).
Scope includes organization, operation and actor identity (session user, API key or OAuth
grant), with normalized input fingerprint and the same precision as stored timestamps.
An exact finalise retry returns the original booking's current lifecycle without creating
mail/booking/fairness changes. A changed payload under the same key is
`idempotency_key_reused`. Authorization precedes replay; a receipt is not a capability.
Two finalisers with different keys serialize: only the winner creates a booking, the loser
gets `poll_already_scheduled` with safe poll metadata. Matching retry is checked before
stale expected revisions so a successful lost response remains recoverable.

Create returns a raw public link only once; exact create replay returns
`poll_already_created` with authorized poll ID, never another link or raw capability.
Lost create responses are recovered by reading metadata then explicitly rotating the
public link (old link invalidated). Voter-token recovery likewise rotates by verified
mail delivery. Retain digest-only receipts with the poll; after retention expiry a replay
cannot promise deduplication. Clients must not reuse keys for new intent.

## Notifications, abuse and time zones

Use durable transactional delivery intents for invitations/verification, a deadline
reminder, time-selected outcomes and cancellation. Schedule the reminder at deadline minus
the lead time below, only when that instant is after creation; send to verified active
voters while still open, including responders who may edit. No overdue catch-up reminder
after closure. Cancellation invalidates pending invitations/reminders. Workers recheck
state, recipient consent and generation, deduplicate per recipient, obey existing instance
and recipient mail budgets, and recover expired claims without resetting attempts. SMTP
is outside transactions; the existing acceptance/failed-receipt duplicate window remains.
Store temporary delivery capabilities encrypted with purpose binding, delete after terminal
delivery, and never put raw capabilities in logs, job metadata, analytics or replay records.

All active verified voters receive the chosen-time outcome; selected attendees receive
it through the normal booking confirmation path rather than a duplicate calendar invite.
Non-selected voters get a plain informational message, no ICS, join URL or manage link.
Preserve the ordinary conference gate so pending logistics never produce a premature join
link. Invitations and cancellations before scheduling carry no ICS because no booking exists.
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
arbitrary host HTML or bulk unverified reminders. Configure shared rate-limit enforcement
for multiple processes; per-process limits alone are insufficient. Numeric request budgets
and retention schedules must be selected and documented in the service task using existing
abuse-control policy; they are not new constants pinned here. Forwarded public links and
mailbox aliases can still admit unwanted voters; invited mode is recommended for sensitive
meetings. Email verification is not proof of a unique human.

## Initial limits

These are proposed numeric contract facts for the later implementation; the doc-fact test
pins this table. Boundary validation belongs in the service and API tests later.

| Limit | Value | Reason |
|---|---|---|
| Candidates per poll | 2–20 | A genuine choice, with a bounded mobile ballot and tally cost |
| Voters per poll | 1–11 | Finalisation requires at least one selected voter; an open poll can have zero enrollments. Maximum enrollment matches one booker plus the existing ten-guest booking cap; includes pending and withdrawn identities until cleanup |
| Deadline after creation | 1 hour–30 days | Gives time to respond without indefinite open state; both bounds inclusive, measured as elapsed time |
| Reminder lead time | 24 hours | One predictable reminder; skip if its due instant is not after creation |

Deadline must also satisfy the candidate/notice rule above, so short-notice events can
have no valid deadline. Existing duration, field length, question and guest constraints
remain in force; the smaller applicable limit wins. The voter minimum applies at finalisation, not creation; enrollment count ranges from zero
to the maximum including pending/withdrawn identities. Caps apply equally to self-hosting,
REST, MCP, CLI and UI. Expanding them requires reviewing booking capacity and mail budgets.

## Proposed REST, MCP and CLI contract

All names below are proposals for later tasks. `/api/v1` responses use camelCase, UUID IDs,
no-store, the existing `{error,message?,field?}` envelope and additive/open response schemas.
Document stable errors in OpenAPI and regenerate clients; clients ignore unfamiliar fields
and future response states. Services throw `DomainError`; no tool-specific business logic.

| REST resource/action under `/api/v1` | MCP tool | CLI under `hourmere polls` | Authority/result |
|---|---|---|---|
| POST `/meeting-polls` | `create_meeting_poll` | `create` | Manager; eventTypeId, candidate starts, durationMinutes, deadlineAt, displayTimeZone, admissionMode, visibility, idempotency key; 201 poll + one-time link |
| GET `/meeting-polls`, GET `/meeting-polls/{id}` | `list_meeting_polls`, `get_meeting_poll` | `list`, `get` | Manager; organization-scoped cursor pagination, lifecycle and safe metadata |
| GET `/meeting-polls/{id}/results` | `get_meeting_poll_results` | `results` | Manager; ballots, roster, separate counts, advisory availability and revisions |
| POST `/meeting-polls/{id}/invitations` | `invite_meeting_poll_voters` | `invite` | Manager; bounded name/email/locale list, idempotency key; 202 durable intent, no voter secrets |
| POST `/meeting-polls/{id}/close`, `/cancel` | `close_meeting_poll`, `cancel_meeting_poll` | `close`, `cancel` | Manager; expectedRevision; 200 current state, matching repeated intent has no extra mail |
| POST `/meeting-polls/{id}/finalise` | `finalise_meeting_poll` | `finalise` | Manager; slotId, bookerVoterId, attendeeVoterIds, conditional acknowledgement, expectedRevision, idempotency key; 201 booking metadata, 200 exact replay |
| POST `/meeting-polls/{id}/rotate-link` | `rotate_meeting_poll_link` | `rotate-link` | Manager; expectedRevision + idempotency key; one-time new public link, matching replay returns safe conflict |
| POST `/public/meeting-polls/read` | `read_meeting_poll` | `view` | Poll/voter capability; public projection, own ballot only, effective deadline and visibility |
| POST `/public/meeting-polls/enroll`, `/recover` | `enroll_meeting_poll_voter`, `recover_meeting_poll_voter` | `join`, `recover` | Public poll capability; name/email/zone/locale, 202 uniform verification response |
| POST `/public/meeting-polls/verify` | `verify_meeting_poll_voter` | `verify` | Emailed voter capability; explicit confirmation while voting is open, idempotent verification, no implicit ballot |
| POST `/public/meeting-polls/vote` | `submit_meeting_poll_vote` | `vote` | Voter capability; full slot/value array, consent, responses, expectedBallotRevision; 200 own ballot/revision |
| POST `/public/meeting-polls/withdraw` | `withdraw_meeting_poll_vote` | `withdraw` | Voter capability + revision; 200 withdrawn state |

Capability read is POST to avoid secrets in paths/query logs. Browser route proposal:
`/poll#<publicCapability>` and `/poll/voter#<voterCapability>`. MCP input schemas carry the
same capability fields; CLI accepts secrets through stdin/protected files, not command-line
arguments or diagnostics. Classify every operation in the shared scope registry and keep
MCP discovery, direct-call insufficient-scope behaviour and CLI help in sync. Invitation
and rotation replay receipts use the operation table; changed input conflicts and lost
responses never resend mail or recover raw secrets. Enrollment/recovery retain uniform
responses while enforcing cooldown/budget and active token generation.

| Status/code | Meaning |
|---|---|
| 400 `invalid_request` | Malformed shape at transport boundary |
| 400 `invalid_poll`, `poll_limit_exceeded`, `poll_event_unsupported` | Invalid instants/deadline/choices, bounded resource limit, or unsupported group/one-time-link mode; safe field hints |
| 401 `unauthorized`; 403 `insufficient_scope` | Existing bearer/session rules; never downgrade a supplied bad bearer |
| 403 `team_management_access_denied`; 409 `organization_context_changed` | Existing management/context boundary |
| 404 `poll_unavailable` | Unknown/inaccessible poll or invalid capability, without disclosing existence |
| 409 `poll_closed`, `poll_cancelled`, `poll_changed` | Deadline/state/revision refused the write |
| 409 `poll_already_created`, `poll_already_scheduled`, `poll_link_already_rotated`, `idempotency_key_reused` | Explicit replay/conflicting intent outcomes |
| 409 `poll_event_changed`, `slot_taken`, `calendar_sync_unavailable` | Refresh or choose another time; no partial booking or token consumption |
| 429 `rate_limited` | Existing request/mail abuse boundary; Retry-After when known |

Retain existing booking-service validation/conflict codes where applicable rather than
renaming them; list those in the later OpenAPI operation. A public closed read remains
200 read-only with own prior ballot; invalid capabilities remain uniformly unavailable.

## Implementation plan and acceptance checks

| Later task | Deliverable and acceptance |
|---|---|
| Storage and service layer | New migrations/types, constraints, scoped access and transactional booking-core extraction. Upgrade populated predecessor schema, preserve data, fresh install/no-op migration. Test tenant isolation, owner/admin loss, current bearer scopes, all numeric boundaries, invite/public verification and privacy deletion. Race vote/deadline, vote/finalise, two finalisers, ordinary booking/finalise, limits/buffers, collective rollback and round-robin fairness; inject failure after booking insert to prove poll/booking/outbox atomicity. Test changed and exact create/finalise replay, token rotation and lost responses; assert rejected group/one-time-link paths leave seats/links untouched. Keep pools bounded under CI's default connection limit and close every pool. |
| Public voting page | No login; own ballot and explicit consent, verification/recovery, edit/withdraw, read-only deadline and outcomes. Accessible keyboard/screen-reader choices and usable stacked candidates at 320px without page overflow. Test all shipped locales, neutral loading/403/errors, private/aggregate projections, DST and midnight crossings, changed zone retaining IDs, duplicate submit and stale revision. jsdom locally, browser checks through approved escalation/CI. |
| Host UI | Personal/team creation, invitation, results, conditional-attendee confirmation, close/cancel and booking link. en/zh-CN, full-width Chinese punctuation. Test role changes, stale organization forms, lost responses, unavailable candidates and immutable published settings. Preserve the team weekly-hours hint and neutral unknown readiness. |
| REST/MCP/CLI | Same service operations and error/replay semantics, OpenAPI/generated types, scope registry/discovery and CLI help/stdin capabilities. Contract tests for every operation, public vote without login through REST and capability vote with MCP/CLI, invalid supplied bearer, cross-tenant IDs, pagination and secret redaction. Publish hourmere.com guides and known limitations with the implemented surfaces, without claiming design-only routes exist. |
| Notifications | Durable recipient jobs, encrypted temporary capabilities, invitation/verification, deadline reminder, selected/non-selected outcome and cancellation/update mail. Fake mail/providers only; test locale/zone, withdrawal, closure, replay dedupe, retry exhaustion, expired leases, deletion, budget suppression, conference gates and the SMTP duplicate window. Selected booking reschedule/cancel uses existing UID/sequence and manage-token protections; other voters never get that capability. |

Required time tests across these tasks: spring-forward gaps, both fall-back offsets,
non-hour transitions, zones on opposite sides of midnight, host all-day busy intervals,
UTC deadline equality and a transaction waiting across it, database fractional-second
rounding, elapsed duration across DST, reschedule/cancel after finalisation, and replay
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

Project-lead acceptance should confirm the ordinary booker/guest mapping and its voter cap,
aggregate-only sharing option, no-hold policy and explicit unsupported modes before storage
work starts. Cal.com's host-created multi-voter poll premise needs an official source if
it is to appear in future competitive claims. Later storage work must finalize numeric
abuse budgets/retention and prove lock-order compatibility; these are release gates, not
permission to ship unbounded enrollment or mail.
