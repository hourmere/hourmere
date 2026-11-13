# Recurring bookings design

Status: proposal, not shipped. This document specifies a bounded first release; it
adds no routes, schema, configuration, or calendar behavior today. The implementation
must ship equally on self-hosted instances. Existing single bookings remain unchanged.

## Evidence and motivation

Official help pages were checked on 2026-11-06. Recurring availability, separately
booking another meeting, and booking an atomic recurring series are different capabilities.
The initial claim that three competitors support the last capability is not established
by the evidence below; it is not a product requirement or a competitive count.

| Product | What the official sources establish |
| --- | --- |
| Cal.com | [Create a recurring link](https://cal.com/help/event-types/create-recurring) documents a host-selected interval of 1–20 weeks/months/years and a maximum of 32 occurrences. Bookers may choose fewer. Seats, payments and the per-booker booking limit cannot be combined with recurrence. |
| Calendly | [Confirmation-page links](https://calendly.com/help/how-to-add-links-to-the-event-confirmation-page) documents returning to the event type to book another meeting. This is repeat booking; the page does not establish atomic recurring checkout. |
| SavvyCal | [Booking-page help](https://docs.savvycal.com/what-schedulers-see-on-your-booking-page) describes selecting a time and confirming. [Single-use link help](https://docs.savvycal.com/single-use-links) distinguishes reusable links; the [official API schema](https://docs.savvycal.com/developers/v1/api/schemas/createlinkrequest) defines `type: recurring` as Multi-Use links. These sources do not establish recurring appointment-series booking. |

This is a description of those pages, not a claim that an undocumented feature cannot
exist. No competitor conflict, atomicity or DST guarantee is inferred from marketing.

## Rule and configuration

Use an explicit structure, not arbitrary RRULE input. The supported patterns are
`weekly`, `fortnightly`, and `monthly_weekday`. Weekly advances by one local calendar
week; fortnightly advances by two. Monthly means the same ordinal weekday, with ordinal
`1`, `2`, `3`, `4`, or `last`, and ISO weekday Monday through Sunday. It does not mean
the same numbered date. The invitee explicitly selects `last` when desired; a fourth
Monday does not silently become the last Monday. The initial date must match the rule.
This supports working-hour schedules and avoids skipping short months or inventing a
February replacement for January 31. Fifth-weekday-only patterns are unsupported.

A personal owner or team owner/admin enables `recurrence` on an event type, selecting
an explicit IANA `timeZone`, a nonempty `allowedPatterns` subset and `maxOccurrences`.
The setting defaults to null (disabled); enabling defaults the maximum to 12, which the
owner may lower. Prefill the zone from the owner's schedule but require saving it as
an event setting: neither host reassignment nor a profile-zone edit changes it.
Configuration uses existing event-type authorization and the `other_write` API key class
(`full` scope). The invitee chooses an allowed pattern, first local date/time, count, and
the usual one duration, location choice, answers, attendees and locale for the entire
series. A single appointment continues through the ordinary booking flow. Existing series
retain snapshots when the event setting changes or recurrence is disabled. Public event
metadata exposes only the permitted choices, and agents read them from MCP
`find_available_slots` (see [REST, MCP and CLI proposal](#rest-mcp-and-cli-proposal)).

The event's booking window can only shorten the horizon in
[Proposed limits](#proposed-limits). Count includes the initial occurrence, never
automatically extends to replace a conflict, and cannot be open-ended.
No `UNTIL`, arbitrary RRULE, RDATE, multiple weekdays per week, or caller-provided
expanded UTC array. A request contains `rule: {pattern, count, ordinal?, weekday?}`
and `firstLocalStart` with a required numeric UTC offset (for example
`2027-11-07T01:30:00-05:00`). Validate that offset against the event zone on that date;
reject a mismatch instead of normalizing it. Reject ordinal/weekday outside monthly rules.
The server expands the rule. An RRULE equivalent is useful for explanation only:
weekly maps to `FREQ=WEEKLY;INTERVAL=1;COUNT=n`, fortnightly to interval 2, and
monthly to `FREQ=MONTHLY;BYDAY=2MO;COUNT=n` (or `-1MO` for last Monday).
The structure avoids accepting the much larger [RFC 5545 recurrence language](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).
It is not an ICS serialization promise.

### Proposed limits

These are design values, not runtime constants yet. `scripts/recurring-bookings-docs.test.ts`
pins them; the step that first enforces a value adds a shared constant and changes the test
to compare it. Raising a limit requires design review and new performance evidence.

| Proposed limit | Value | Reason |
| --- | --- | --- |
| Minimum occurrences | 2 | A single meeting uses the existing flow. |
| Maximum occurrences | 12 | Covers a weekly term or monthly year without unbounded writes/mail. |
| Maximum horizon in local calendar days | 366 | Last local date is at most today + 366 in the recurrence zone; bounds future commitments. |
| Maximum occurrence-host evaluations | 96 | Maximum occurrences times the existing host ceiling; no alternative-search multiplication. |
| Maximum batch database read statements | 32 | Fixed budget for availability fact loading, independent of occurrence count. |
| Maximum batch fact rows | 10000 | Fail closed rather than truncate a dense busy/booking history. |
| Batch deadline in milliseconds | 5000 | Includes fact loading and evaluation; abort work and release the connection. |
| Series admissions per rolling hour per actor and event | 2 | Counts committed new series only; see [Performance and abuse controls](#performance-and-abuse-controls). |
| Series confirmation conference wait in minutes | 30 | Longest wait for automatic meeting links before the confirmation is sent anyway. |
| Series confirmation lead before the first start in minutes | 15 | Rule 3 sends the confirmation by this point before the first not-started occurrence, or by the imminent-start point when that is later. |
| Imminent-start confirmation wait in minutes | 5 | The longest wait for the first meeting's link when the first start is close; it never extends past that start. |
| Minimum minutes between regular series copies to one recipient | 60 | Gate 2 of the [link-update rule](#link-update-rule): a link-update copy waits this long after that recipient's last delivered confirmation or link-update copy of the series. |
| Maximum link-update copies per series and recipient per rolling day | 3 | Gate 3 of the [link-update rule](#link-update-rule); later changes wait. |

### Existing limits

The design and its mail proof depend on these current code constants and defaults. The
documentation test reads each one from the named source, so a change on main fails the test
until this design is re-checked.

| Existing limit | Value | Source |
| --- | --- | --- |
| Maximum candidate hosts | 8 | `hasValidHostShape`, packages/scheduling/src/hosts.ts |
| Maximum guests besides the booker | 10 | `MAX_GUESTS`, packages/scheduling/src/bookings.ts |
| Invitee mail per recipient per rolling hour | 5 | `MAIL_RECIPIENT_MAX_PER_HOUR` default, apps/server/src/config.ts and .env.example |
| Invitee mail per recipient per rolling day | 20 | `MAIL_RECIPIENT_MAX_PER_DAY` default, same sources |
| Instance mail per rolling hour | 100 | `MAIL_MAX_PER_HOUR` default, shared by booking, sign-in and invitation mail |
| Public booking requests per IP per 60 seconds | 10 | `PUBLIC_RATE_LIMITS.book`, apps/server/src/rate-limit.ts |
| Public slot requests per IP per 60 seconds | 120 | `PUBLIC_RATE_LIMITS.slots` |
| Public manage requests per IP per 60 seconds | 30 | `PUBLIC_RATE_LIMITS.manage` |
| Maximum slot search range in days | 62 | `MAX_SLOT_RANGE_DAYS`, packages/scheduling/src/availability.ts |
| Conference outbox attempts per notification | 13 | `CONFERENCE_NOTIFICATION_ATTEMPTS`, packages/notifications/src/index.ts |
| Conference outbox first retry delay in minutes | 1 | `conferenceRetryDelay`, same file; each later delay doubles |
| Conference outbox longest retry delay in minutes | 60 | `conferenceRetryDelay`, same file |

## Time zones and DST

The event's saved recurrence zone governs expansion, including collective and round-robin
series. Hosts may not yet be selected in round-robin, and collective hosts may have
different zones; one event-owned zone makes expansion deterministic before host selection.
Pin that zone on the series. Each occurrence preserves the initial local start
time in that zone across DST, not a fixed elapsed interval. Invitee display zones only
change labels; show the governing zone and every date, local offset and invitee-local
time before confirmation. An invitee in another DST regime can see their hour change.
Duration remains elapsed minutes, as for ordinary bookings.

Use Temporal with explicit disambiguation: a nonexistent local start makes that occurrence
unavailable (`nonexistent_local_time`), without shifting forward or skipping it. A repeated
local start after the first occurrence selects the earlier instant; display its offset in
preview and persist it. The first occurrence honors the supplied offset, including a
later-fold slot selected from ordinary availability; never silently replace that instant
with the earlier fold. An end crossing a transition is computed by adding elapsed duration
to the start instant. Store both UTC instants on each normal booking and the original local
start on its series occurrence. A timezone database update never recalculates committed
bookings; only a newly previewed/moved occurrence uses current rules. Recheck preview's
resolved instants at commit; return `series_changed` if they differ.

Examples for acceptance: New York weekly 09:00 across spring/fall changes stays 09:00
while UTC changes; a New York 02:30 spring-gap occurrence rejects the batch; repeated
01:30 in autumn uses the earlier offset for generated dates; first-slot tests cover both
valid offsets and reject an invalid offset. Include Australia/Lord_Howe's half-hour change,
a non-DST zone and differing host/invitee zones. Monthly `last` must work across February
and leap years without substituting a numbered date.

## Availability and interactions

Reject the entire series if any occurrence fails. Preview lists every requested occurrence
and its safe availability result. Preview holds nothing: it writes no row and creates no
hold (Hourmere's only holds are the internal paid-booking `pending_payment` holds of the
[paid-booking foundation](payments.md), which series never create), and available entries
are informational, not an offer to submit a subset. Invitees may change the first start,
pattern or count and preview again. No automatic skip, available-subset checkout or per-date
alternative search. A stale checkout returns a conflict and offers a fresh preview without
losing form data. Readiness errors, loading and unauthorized responses remain unknown, never
“missing setup.”

| Existing behavior | Series decision |
| --- | --- |
| Daily/weekly/monthly limits | Each occurrence consumes one booking. Compute cumulative proposed counts against this event's occupying bookings (confirmed, and single-booking `pending_payment` holds before their deadline, as the slot engine counts them) in each host's effective schedule zone (Monday-based weeks and calendar months), not the recurrence/display zone. Check all periods before any insert. |
| Buffers and busy times | Apply ordinary exclusions and buffers to every occurrence and to pairs within the proposed set; other event types, imports and unexpired payment holds still block time, sharing the slot engine's hold-deadline rules; creation drains past-deadline holds before inserting (see the lock order below). |
| Minimum notice and window | Re-evaluate each occurrence against one fresh clock sampled after locks. All must pass; later dates cannot escape the current window. |
| One-time links | Unsupported for series initially: no series route or MCP mode exists under `/book/{token}`, and one-time-link metadata omits `recurrence`, so no link is consumed. Their existing single-booking semantics are unchanged. |
| Group seats | Unsupported, including creating a new slot or joining an occupied slot. Do not silently treat a series as one seat/slot. |
| Round-robin | One host for the entire series, chosen from hosts eligible and available for every occurrence. Never choose a different host per date. If intersections are empty, fail even if each date has some host. Apply existing fair selection once among whole-series candidates and advance fairness once on successful commit, never preview/replay. Existing least-recently-assigned rotation measures assignments, not booked minutes: a 12-date series can load one host twelve times more than a single booking. Mitigate with cumulative host limits and an owner-lowered maxOccurrences; explicitly document that equal meeting-count distribution is not guaranteed. Do not pretend repeated timestamp advances solve this skew. |
| Collective | The same complete pinned required-host set attends every occurrence; all must pass. Missing/currently invalid membership fails closed. |
| Waitlist | No series waitlist or redemption token initially; reject a waitlist token on series creation with `recurrence_not_supported`. Existing single-slot waitlists remain unchanged. Cancelled occurrences reach waitlists through the existing booking-change scan signals, as any cancelled booking does. |
| Paid bookings | Unsupported. The paid-booking foundation ([design](payments.md)) has no public checkout or price setting yet and creates `pending_payment` holds only through an internal service. Series never create holds. Once paid event settings exist, series admission refuses paid events with `recurrence_not_supported` until a design defines series charging and refunds; whichever of paid event settings and series admission ships second adds that refusal and its test. Never charge once or partly refund an atomic series. |
| Imported bookings | Continue to block availability. Never attach imported read-only rows to a new series or allow series operations to bypass `imported_booking_read_only`. No inference of imported recurrence. |
| Cal.com importer | A source event with Cal.com `recurringEvent` keeps its existing `event_recurring` **activation blocker** (packages/import-calcom/src/events.ts), not a warning: its draft stays inactive until the owner's activation review, and the importer never writes Hourmere `recurrence`. Cal.com's yearly, 1–20 interval and 32-count rules are not partially mapped. Source bookings from a Cal.com series stay independent read-only imported bookings under the existing `recurringOccurrencesComplete` owner decision. After activation an owner may enable Hourmere recurrence explicitly. No step downgrades or removes this blocker; step 7 documents it. |
| Guests, duration, location | Respect current opt-ins and validation; snapshot the same choices per occurrence. |
| Automatic conferences | Each occurrence keeps its own provider meeting, provisioned and ready-gated by the existing conference jobs; no shared provider meeting. Series mail follows [Automatic conferences](#automatic-conferences). |

Calendar freshness policy stays identical to ordinary booking: unknown busy data is not
available. With round-robin, stale candidates can be omitted under existing rules; report
`calendar_sync_unavailable` if freshness prevents deciding that any whole-series host exists.
Safe per-occurrence results never reveal host calendars, meeting titles, other bookers,
private reasons, or candidate-host availability matrices. Capacity/limit failures may use
the same public `unavailable` reason.

## Series model and migration sketch

Use an organization-owned series plus ordinary booking rows. A single giant booking row
would break interval exclusion, host visibility, statistics, reminders and existing exports.
The rule is provenance; materialized occurrences are authoritative after creation.

Proposed future migrations (allocate numbers when implemented, not here). Step 2a.1 adds
the first four items, step 2a.2 the last three.

- Add nullable `event_types.recurrence` JSONB with validated pattern subset, IANA zone
  and bounded maximum, plus a revision incremented on any admission-relevant setting
  change. Null preserves disabled behavior for every predecessor event. Enforce shape
  and numeric checks in the database; canonical zone validation belongs to the service.
- `booking_series`: UUIDv7 `id`, `organization_id` FK with organization cascade,
  nullable `event_type_id` (deletion sets null), immutable original event UUID snapshot,
  rule version/validated rule columns, `time_zone`, initial local start, requested count,
  duration/notification/host-policy snapshots, `created_at`/`updated_at` timestamptz,
  `revision` for optimistic concurrency and a nullable SHA-256 primary-booker API series
  manage-token digest. Store neither raw management tokens nor
  raw idempotency response bodies.
- `booking_series_occurrences`: UUIDv7 `id`, organization and series IDs, stable
  `ordinal` (1 through requested count), original local start and resolved UTC start/end,
  and the immutable root booking ID. Unique `(series_id, ordinal)` and root booking ID.
  CHECK positive ordered finite instants, valid bounded ordinal and rule fields. The
  transaction verifies contiguous count and that the first date matches the rule; a
  deferred constraint trigger verifies count/root ownership at commit.
- Add nullable `series_occurrence_id` to `bookings`. Every successor in an existing
  reschedule chain retains that occurrence ID. A partial unique index on occurrence ID
  where status is confirmed permits at most one live version; cancelled predecessors
  remain ordinary history. Series members are only ever `confirmed` or `cancelled`: paid
  events are refused, so no member is `pending_payment` or `expired`. An occurrence can be
  cancelled without deleting its row.
- `booking_series_receipts`: UUIDv7 ID, organization, operation kind, authority-scope
  digest, idempotency key/fingerprint, series ID and bounded affected occurrence/result
  IDs. Unique `(organization_id, authority_scope, operation_kind, idempotency_key)`.
  Persist create and bulk-cancel receipts transactionally. Scope remains tied to the
  caller/API key or OAuth consent (anonymous shared organization scope), never to email alone.
- `booking_series_notifications`: per-recipient receipts unique by series, kind
  (`confirmation`, `cancellation` or `link_update`), sequence and recipient. The sequence is
  the series revision of the action for a confirmation or cancellation, and that
  recipient's link-update counter in the series for a link update, so two cancellation
  actions or several link updates at one revision never collide. Each receipt holds
  recipient role and capability scope, nullable unique SHA-256 manage-token digest, outcome
  (delivered with its delivery time, the `sent_at` its send transaction wrote to the mail
  ledger, or suppressed with its reason) and the bounded ordinals it reported with their
  meeting-link state; a delivered receipt is that recipient's last report. Outbox rows hold
  due time, attempts, lease and skipped/exhausted state, mirroring
  `booking_conference_notifications`: one row per series, kind and sequence for a
  confirmation or cancellation, and one row per series, recipient and sequence for a link
  update, so each recipient's link updates wait and retry on their own (see the
  [link-update rule](#link-update-rule)). This is a new series equivalent of booking
  notification receipts, not an encrypted credential outbox. Durable jobs carry only IDs,
  never raw capabilities. Member lifecycle jobs must suppress their ordinary
  confirmation/cancellation fan-out when owned by an aggregate series action.
- `booking_series_admissions`: UUIDv7 ID, organization, event type, actor digest (API key
  or OAuth consent ID, or an HMAC of the client's rate-limit address key derived from the
  server secret like the mail ledger's recipient hash; never a raw IP) and `admitted_at`.
  Index `(event_type_id, actor_digest, admitted_at)`. One row is written in each committed
  new-series transaction and counts toward the series admission cap.

Index series `(organization_id, id)` for cursor listing, occurrences `(series_id, ordinal)`,
bookings `series_occurrence_id`, and receipt series FK. Existing booking time/status,
exclusion and host indexes remain in force. Composite unique `(organization_id, id)` parent
keys and composite FKs bind series, occurrences, booking roots, receipts, notifications and
admissions to the same organization. Deferred root references resolve insertion cycles
within one transaction. Do not rely on UUID uniqueness alone for tenancy. Validate event
ownership too; preserve ordinary event-deletion behavior.

Retention follows today's bookings, which have no retention job: booking rows and their
idempotency keys (`bookings_idempotency` in packages/db/migrations/0002_scheduling.sql)
live until the organization is deleted. Series, occurrence, receipt and notification rows
likewise live as long as their organization and cascade with it; event deletion sets
`event_type_id` null and keeps history. The only new purge is admission rows older than two
days, added to the existing hourly `notification-email-cleanup` job that already purges the
mail ledger after two days (packages/notifications/src/mail-limits.ts). No other retention
job is introduced.

Old bookings have null series membership; no backfill or guessing from matching titles.
Each migration must preserve populated predecessor rows, fresh install and no-op re-run,
then regenerate db types. No migration or generated schema changes belong to this PR.

Existing list queries, exports, activity, billing-independent counts, reminders and follow-ups
continue to see one ordinary booking per occurrence. Lists must not replace rows with a
summary. Step 5g adds additive series metadata to the existing booking reads, the CSV
export and webhook payloads; current pagination and cancelled-predecessor semantics stay.
Emit existing booking-created/rescheduled/cancelled webhooks per affected occurrence with
the current immutable minimal whitelist plus the 5g series identifiers. No attendees, manage
tokens or provider IDs in webhook metadata. No new series webhook is required initially.
Series detail resolves each root's current successor and retains historical access under
ordinary visibility rules; it cannot expose sibling attendees to a guest capability.

## Atomic creation, locks and replay

Implement one service transaction, not a loop over public `createBooking` calls (which
would commit separately). Refactor the existing transaction-aware validation/insertion,
notification, conference, calendar-target and webhook helpers for reuse; single booking
must retain its existing behavior. Load a bounded preview outside the write transaction,
then resolve and check fresh facts under the same locks used by single bookings.

Existing `packages/scheduling/src/bookings.ts` creation acquires organization parent,
sorted host advisory locks, then locked event resolution; round-robin state follows.
Existing moves acquire organization, booking row, then sorted host advisory locks.
Do not reverse these orders or replace host locks with series-only locks.

Proposed order for a new series: the existing waitlist fence is unnecessary because tokens
are refused. In its place, take a series-only admission advisory lock keyed by event and
actor digest; only series creation takes it, always first, so it cannot form a cycle with
single bookings. Then organization parent -> all configured host advisory locks in existing
sorted order -> locked event/membership resolution -> round-robin state if applicable ->
drain past-deadline payment holds for every candidate host with the existing
`expirePaymentHolds`, as single creation does in its locked slot check -> insert new
series/occurrence/booking/admission rows in ordinal order. The drain is needed because the
host exclusion constraint counts a `pending_payment` row until it is marked expired, even
after its deadline; preview never drains, since it writes nothing. Recheck receipt after
serialization, admission count, policy/version, host pool, current time, all availability
and aggregate limits. Acquire all host locks once, not once per occurrence. Apart from the
hold drain, which locks only past-deadline `pending_payment` rows with `FOR UPDATE ... SKIP
LOCKED` and so never waits for them, only newly created series rows are locked on this path;
never lock preexisting occurrence booking rows after holding host locks (series members are
never `pending_payment`, so the drain never locks one). Existing exclusion constraints remain
the final collision defense.
Any failed insert, limit, enqueue or constraint rolls back every row, fairness update,
admission row and outbox intent. Provider/SMTP I/O occurs only after commit through existing
durable jobs; atomicity covers local booking intent, not distributed delivery or provider
calendar availability changes.

For operations on an existing series, organization -> series row -> current occurrence
booking rows in stable ordinal order -> existing operation-specific locks. All series-member
single moves/cancellations must acquire the series row before the booking row as well,
including old manage-token chain resolution. Ordinary non-series paths keep their current
order. Bulk cancellation acquires no host advisory locks, matching existing cancellation;
it never calls separate transactions. Avoid any booking-row -> series-row path, including
receipt writes and worker updates. New series creation cannot wait for an existing series
row. Test series/single moves, cancels, event edits and cross-organization shared-host
contention; lock-graph review is a prerequisite, not a claim of existing batch support.
Bulk rescheduling is excluded below, avoiding multi-source move locking in this release.

Require a random `Idempotency-Key` using the existing 1–255 printable ASCII format on new
series create and bulk-cancel operations. Fingerprint normalized input including event,
rule, zone/version, resolved preview occurrences, duration, attendees/answers and location;
exclude display-only labels. Keys grant no authority. Serialize identical concurrent keys
with the receipt uniqueness constraint and re-read the winning receipt after a conflict.
Changed input returns `idempotency_key_reused`; exact create replay returns the original
series/current booking lifecycle with 200 (first creation 201), no second series or booking
rows, admission row, fairness advance, mail or raw manage token. The receipt lookup runs
before the admission cap, so a replay is answered even when the cap is reached. Reauthorize
before every replay; do not rerun new admission rules against an already committed series.
Cancel replay returns the original affected IDs with current state even when its expected
revision is now stale. Receipts live as long as their series, the same lifetime an ordinary
booking's idempotency key has today. Lost-response recovery uses authenticated reads or the
original queued confirmation links, not token recovery from a GET or replay.

## Reschedule, cancel and capabilities

| Scope | Reschedule | Cancel |
| --- | --- | --- |
| One occurrence | Existing move creates a cancelled predecessor and successor under the same stable occurrence ID. Other occurrences keep instants, hosts, rules and links. | Existing cancellation affects only its current chain; no replacement date is added. |
| This and following | Unsupported (`series_reschedule_not_supported`); do not emulate with a partial loop. Move individually or cancel the tail and book a new series explicitly. | Supported atomically for the selected immutable ordinal and higher ordinals that have not started. Ordinal, not a moved start time, defines “following.” |
| Whole series | Unsupported bulk move; rule edits never rewrite committed bookings. | Atomically cancel every still-confirmed, not-started occurrence. Past/started/cancelled rows stay historical and are reported as unchanged. |

Both hosts and the primary booker may cancel future occurrences subject to current ordinary
booking authorization. Hosts must be authorized for every target, never gain cross-team
power from knowing a series UUID; a team admin without existing booking authority gains
none. A team owner/admin keeps the existing per-booking `cancelTeamBooking` POST
`/team/bookings/{id}/cancel` for one member, which follows the series lock order and
revision rule like every member cancel, but gets no tail/all series cancellation. A host may
also ask the booker to pick another time for one member with the existing reschedule request
(`POST /bookings/{id}/request-reschedule`, MCP `request_reschedule`, CLI
`request-reschedule`); there is no series-wide request. Creating or replacing a member's
request takes the series row before the booking row, as member moves and cancels do. The
existing request-expiry job (`expireRescheduleRequest`) keeps locking only the member's
booking row: it holds no other lock and never touches the series row, so it adds no
booking-row -> series-row edge. Its request mail is ordinary per-occurrence mail with the
existing occurrence link. The booker answers through the occurrence link or in series mode;
both series-mode member routes, reschedule and cancel, accept the existing optional
`rescheduleRequestId` with today's fence. The pick is a single-occurrence move under the
series rules and increments the series revision; a cancel of that member resolves the
request as cancelled. As in today's `rescheduleManagedBooking` and `cancelManagedBooking`
(packages/scheduling/src/bookings.ts), the request is checked right after the locks and
before any booking-state check: a pick naming a request already picked at the same start and
duration returns that picked booking with `manageToken: null`, a cancel naming a request
already cancelled returns the member as it is now, and any other request that is not
pending and unexpired fails with `reschedule_request_changed`. In series mode this check
runs before the `expectedRevision` check, so a lost-response replay carrying the revision it
read before its own change gets the saved result, as a bulk-cancel replay does, not
`series_changed`. A bulk cancellation resolves each affected member's pending request as
cancelled, exactly as single cancellation does. Guests retain no booking mutation authority;
existing guest mail does not issue manage links. Invitee moves retain current move-count,
cutoff, duration and availability rules; pinned round-robin/collective hosts do not rotate
on a move. Host moves
preserve the current host-specific policy. Cancellation stays possible when an event is
disabled/deleted, while moving still needs a bookable event.

Mint a primary-booker API series capability at creation and persist only its digest;
return the raw value once, never on replay. For each booker/guest series mail (confirmation,
link update, series cancellation), mint a fresh 32-byte base64url capability at send time and
store only its digest in the new series notification receipt, following today's
`booking_notifications` transaction/send pattern. SMTP failure rolls the receipt back; retry
mints a new token. Terminal budget suppression clears that attempt's digest and does not
retry; earlier delivered/API capabilities stay valid. No raw series token enters a job or
encrypted outbox. A crash after SMTP before commit has the existing duplicate/invalid-link
window; do not claim exactly-once delivery.

Series capabilities travel the way manage tokens do today. REST callers send one in the
`X-Series-Manage-Token` request header on every route that accepts it: the new GET
`/booking-series/manage` and POST `/booking-series/manage/cancel`, and the four existing
`/bookings/manage` routes in series mode. This matches the existing `X-Manage-Token`
header, which GET `/bookings/manage`, GET `/bookings/manage/slots` and both manage POSTs
already read (apps/server/src/routes/bookings.ts). Over REST a capability never appears in
a path, query string or JSON body, and both headers share one redaction rule. MCP tools take
it as the `seriesManageToken` argument, as `reschedule_booking` and `cancel_booking` take
`manageToken` today; the CLI passes it in JSON input, never as a flag.

Each booker/guest series mail contains one `/series/manage#<token>` link. The page keeps the
fragment token in memory, strips it from the address bar, sends it only in that header and
lists every occurrence with its current successor and meeting-link state. Booker
capabilities can read the series and cancel all/following; guest mail capabilities expose
only that recipient's permitted read-only details, never sibling attendee data or mutation
authority. Host mail links to authenticated series detail instead. The series page invokes
the existing manage-booking read/slots/reschedule/cancel operations in series mode: the
`X-Series-Manage-Token` header plus the stable `ordinal` (a GET query field or a POST body
field, never the token), mutually exclusive with `X-Manage-Token`. The service resolves the
current chain and applies that recipient's existing permissions/cutoffs. Series-mode member
moves and cancels also require the series `expectedRevision` from the latest series read;
a mismatch returns 409 `series_changed`, except for the reschedule-request replay described
above. Thus one delivered series link reaches every
occurrence without needing twelve separately delivered links. Series token lookup checks
both API and successful notification digests, role, retained ownership and revocation.

Ordinary per-occurrence mail for a series member keeps today's per-booking pipeline:
reminders, follow-ups and the one email of a single-occurrence move or cancel. The booker's
copy carries an occurrence link (`/booking#token=…`) minted at send time and stored in
`booking_notifications`, exactly as for a single booking, except cancellations, which carry
no link today; guests' copies carry none. That link reaches only its occurrence. These mails
keep their current templates and never mint series capabilities. A series-mode reschedule
response returns `manageToken: null`, because the series token keeps addressing that
ordinal. An occurrence-token reschedule of a series member returns a new occurrence token,
as today. Already displayed API links and authenticated host access survive suppressed mail;
a lost anonymous response plus suppressed email cannot be recovered by replay. Show delivery
failure through authorized reads and document host assistance, not guaranteed delivery.

Bulk cancel accepts `scope: "all" | "following"`, `fromOrdinal` only for following,
`expectedRevision`, a request key and optional reason. Sample one clock after locks; compute
and return affected/unchanged IDs explicitly. An empty eligible set succeeds without mail.
Every member move or cancel, through any route, and every bulk cancellation increments the
series revision in the same transaction. Occurrence-token and host operations keep their
existing inputs. A non-replay stale revision returns `series_changed` for a reload; never
silently include a concurrently moved occurrence. Series capability remains useful for
reading history after cancellation.

## Notifications and calendars

Notifications are per series action. Creation sends one confirmation per recipient listing
every occurrence, with one calendar attachment containing every confirmed, not-started root
member (a host's attachment leaves out each member whose provider copy that host's calendar
receives; see [Calendar attachments](#calendar-attachments)). Whole-series or
this-and-following cancellation sends one email per recipient listing the affected and
unchanged dates, with one attachment containing CANCELLED entries only for affected
occurrences previously delivered to that recipient. A single-occurrence reschedule or cancel
sends one email for that occurrence. Do not also queue the ordinary per-occurrence lifecycle
messages for a series action. Reminders and follow-ups remain per occurrence with ordinary
budgets and snapshotted due times. Refresh lifecycle/revision before send so an overtaken
series mail cannot revive cancelled or moved events.

Every series mail picks its language as existing booking mail does: the booking language
for the booker and guests, each host's own language for host copies. Templates exist in
every booking-mail catalogue in packages/mail/src/catalogues (today en, zh-CN, de, fr, es
and pt-BR). Step 4a.1 owns these templates and translations, including the meeting-link
markers used below.

### Automatic conferences

For series roots, conference readiness changes do not insert today's per-booking
`confirmed` or `conference_failed` outbox rows (written by `writeBookingConference` in
packages/calendars/src/conferences.ts). They update the series state that drives the two
series mails below. Series conference state and series mail track only members whose
current booking is still the root. A member moved before a series mail is listed with its
current time and “Updated separately”, gets no VEVENT in series attachments, never delays
the confirmation and never appears in link updates: its successor is an ordinary
single-occurrence change and keeps the existing per-booking invitation and conference mail,
including at most one `conference_failed` notice for that move. Per-occurrence reminders stay
ready-gated as today, so a member without a ready link gets no reminder.

The series confirmation becomes due at the first of these points, and is then sent with
whatever is still pending:

1. every confirmed, not-started root member has a terminal conference state, `ready` or
   `failed`; a member without an automatic conference counts as ready, so a series on an
   event without automatic conferences is due at commit;
2. the series confirmation conference wait (30 minutes) after commit;
3. the later of two points: the series confirmation lead (15 minutes) before the first
   not-started member's start, and the first of that member's terminal conference state,
   its start, or the imminent-start wait (5 minutes) after commit. When the first start is
   less than 15 minutes away (the default minimum notice is 0), the second point always
   governs, so the confirmation waits briefly for that first link and never past that start.
   While that link is still pending, the second point also governs for a first start less
   than 20 minutes away, because the imminent-start wait then ends after the lead point;
   from 20 minutes on, the lead point governs unless point 2 comes first. A later first
   start never makes the confirmation earlier.

Started and cancelled members never delay it. Today's per-booking outbox skips a pending
confirmation once its booking starts (`dispatchConferenceNotifications` in
packages/notifications/src/index.ts); the series confirmation is skipped only when no member
is still confirmed and not started. It lists every member and always carries the calendar
attachment, with one VEVENT for every confirmed, not-started root member. Ready members
carry their meeting link. Pending members are marked “Meeting link pending” and failed
members “No automatic meeting link”, in the mail and in their VEVENT description, with no
link. Started and cancelled members are labelled as such and get no VEVENT. Host copies name
the failed dates and point to the existing per-occurrence repair (`retryBookingConference`
POST `/bookings/{id}/conference/retry`, MCP `retry_conference`, CLI `retry-meeting`). Guest
copies show the same markers without repair instructions, and guests never get a separate
failure notice, matching today's exclusion of guests from `conference_failed`.

Every series copy is rendered when it is sent, again on each retry after an SMTP failure, so
it shows each member's state at that moment. After the confirmation, later readiness
changes reach recipients in series mail only through link updates, sent under the
[link-update rule](#link-update-rule) below. No change skips that rule: a link that becomes
ready shortly before its member starts waits like any other (see
[known limitations](#out-of-scope-and-known-limitations)). Each link-update copy carries only
net changes since that recipient's last delivered report. Newly ready members get a VEVENT
with the same UID and SEQUENCE and a newer DTSTAMP, now with the link, which updates the
entry already delivered. For the booker and hosts, newly failed members are reported too. A
guest gets one only when it contains a newly ready link. A member that has started is never
reported in a link update. A link update is skipped when no member remains confirmed and not
started. Between mails, host series detail and the series manage page list every member's
current state, with each ready member's current join link, also after that member starts
(step 5d returns it, steps 6c and 6d show it); hosts also see the link on their booking page
and in their provider calendar copy of that member, if they have one. A per-occurrence
reminder stays ready-gated as today, so a reminder of a member that is still due when its
link becomes ready carries that link too.

#### Link-update rule

Link updates are scheduled per recipient. Each recipient has at most one waiting
link-update copy per series, in its own outbox row; later changes join it. The copy is sent
only when all three gates hold. They are checked when it is sent, and again on every retry
after an SMTP rollback, inside its send transaction after the existing mail-budget lock that
every booking-mail send takes, so they see every earlier copy's committed outcome:

1. Ordering: every earlier copy of the same series to that recipient (confirmation, link
   update or cancellation) is final, meaning no further attempt of it will be made:
   delivered, suppressed, rejected for good by the mail server, skipped, or exhausted after
   its last attempt.
2. Spacing: at least 60 minutes have passed since that recipient's last delivered
   confirmation or link-update copy of the series, counted from the delivery time on its
   receipt.
3. Daily cap: fewer than 3 link-update copies of the series reached that recipient in the
   last rolling day, counted the same way.

A copy whose gates are closed waits, and waiting is not an attempt: a closed gate ends the
claim without counting against the copy's attempts and moves its due time to when the
spacing and the daily cap allow, and the transaction that makes the earlier copy final also
makes the waiting copy due. Only a delivery attempt that SMTP refuses or that is interrupted
counts. Each gate looks only at that recipient's own copies, so a recipient whose mail server
defers its copies never holds back anyone else's link updates. Confirmations and
cancellations have no gates and are sent when due. The series outbox retries a refused copy
on the conference outbox schedule: 13 attempts, the delay starting at 1 minute and doubling
to at most 60, so the last attempt is due 423 minutes (7 hours 3 minutes) after the first,
later only by the dispatcher's polling and an interrupted attempt's lease. The series pages
always show each member's current state, and a recipient's link update becomes due at most
60 minutes after a change, with two exceptions that affect only that recipient: once 3
link-update copies reached it in a rolling day, the next waits up to a day (gate 3); and
while its own earlier series copies are being retried, its link update waits until the last
of them is final, and then 60 more minutes if that was a delivered confirmation or link
update (gates 1 and 2), about 483 minutes (8 hours 3 minutes) after that copy's first
attempt.
Never send a per-occurrence `confirmed` or `conference_failed` mail for a series root.

### Mail budget proof

Defaults from [Existing limits](#existing-limits), an initially empty ledger, 12
occurrences, the booker plus 10 guests (11 invitee recipients) and 8 collective hosts. One
series mail costs 1 per invitee recipient and 19 instance mails. Unless a row says otherwise,
two series share these recipients. Host mail skips the recipient windows; its larger instance
allowance is not used here. The ledger counts `sent_at` strictly after now minus one hour, so
mails 60 minutes apart never share a window, and a mail is suppressed only when the count
before it has reached the limit: as many mails as the limit fit in one window.

| Case | Per invitee recipient, rolling hour | Per invitee recipient, rolling day | Instance mails, rolling hour | Instance mails, total |
| --- | --- | --- | --- | --- |
| Create | 1 | 1 | 19 | 19 |
| Create, then whole-series cancel in the same hour | 2 | 2 | 38 | 38 |
| All 12 automatic conferences fail, the host repairs all, then whole-series cancel | 2 | 3 | 38 | 57 |
| Series-mail maximum for one series in a rolling day: confirmation, 3 link updates, whole-series cancel | 2 | 5 | 38 | 95 |
| One series at the maximum, every copy refused once by SMTP and retried | 2 | 5 | 38 | 95 |
| Two series at the admission cap, each at the series-mail maximum | 4 | 10 | 76 | 190 |
| Two series at the cap, every copy refused once by SMTP and retried | 4 | 10 | 76 | 190 |
| Two series at the cap, a recipient's confirmation copies deferred for hours by SMTP | 4 | 10 | 76 | 190 |
| Two series at the cap with different invitees | 2 | 5 | 76 | 190 |
| Two series with different invitees, every copy refused once by SMTP and retried | 2 | 5 | 76 | 190 |
| Rejected alternative: one failure notice per occurrence (attempted) | 12 | 12 | 108 | 108 |

Every accepted row stays within the recipient hourly and daily limits and the instance
hourly limit, so nothing is suppressed, in particular no cancellation. The bound is on series
mail. A recipient gets at most 1 regular copy (confirmation or link update) of one series in
any rolling hour: gates 1 and 2 of the [link-update rule](#link-update-rule) space a
recipient's regular copies of a series at least 60 minutes apart by their own delivery times.
No link update goes before an earlier copy is final, and none within 60 minutes of the last
one delivered, so an SMTP refusal or deferral only moves a copy later, and the next one is
spaced from when it arrived.
Each cancellation action adds 1. One series therefore costs at most 2 per invitee recipient
in an hour, and two series at most 4, one below the hourly limit. Every recipient, hosts
included, follows the same gates, so a series sends at most 19 regular copies and 19
cancellation copies in an hour, and two series at most 76 instance mails, whoever their
invitees are. In a rolling day a recipient gets at most 1 + 3 + 1 = 5 mails of one series
(gate 3). When all 12 fail within the wait, the confirmation reports all 12 failures, one
link-update mail carries all 12 repaired links no earlier than an hour later, and the
cancellation follows. The rejected per-occurrence alternative would send 12 failure notices
to the booker within minutes, of which 7 are suppressed, and attempt 108 instance mails in
total.

The documentation test derives the hourly figures from one exhaustive model of these rules
for one invitee recipient. It enumerates every order, inside one rolling hour, of each
series' confirmation, two link changes and whole-series cancellation, for one and two series,
in five forms: a series confirmed in that hour; the same with every copy refused once by SMTP
and retried at a later step; an older series whose last regular copy arrived just before
the hour; the same with every copy refused once; and a series whose confirmation reached its
other recipients before the hour but this recipient only in it, after SMTP deferred it. None
of the 5869 orders suppresses mail, and the worst hour holds 2 mails for one series and 4 for
two. With the spacing measured from the series' other copies instead, a deferred
confirmation copy and the link update behind it share the recipient's hour (3 mails for one
series), and two such series suppress a cancellation in all 70 orders.

The test also replays a timed case. With defaults, series X commits at 08:00; its first
member starts at 10:40 and its conferences are pending, so its confirmation is due at 08:30
(rule 2) and reaches 18 recipients then. The booker's server refuses its copy with 4xx until
the seventh attempt, at 09:33. Member 1 fails at 08:45 and is repaired at 09:45. Series Y of
the same actor and event commits at 09:50 and confirms at 09:51; the host cancels X at 10:00
and Y at 10:05. The booker's 09:33 confirmation already shows the failure, its link update
cannot be due before 10:33 and is skipped after the cancellation, and the booker gets 4 series
mails in that hour, none suppressed. No other recipient waits for the booker: hosts get the
failure in X's link update at 09:30, and guests the repaired link at 09:45.

Each further this-and-following cancellation, single-occurrence change, host reschedule
request, reminder or follow-up costs one more mail per recipient, exactly as the same change
does for separate single bookings, and is outside this bound. With two series in one hour,
one such mail still fits; a further one can be suppressed, and the suppressed mail can then be
a whole-series cancellation. Configurable reminder rules (up to
five offsets per event) whose offsets differ by the series interval fire for several members
at the same moment, as they would for the same bookings made separately; the step 7 owner
guide tells owners to avoid such offsets on recurring events. Previous traffic, unrelated
sign-in/team mail or lower operator-configured limits can still exhaust the shared ledger;
these figures prove bounded isolated series actions fit, not guaranteed global delivery. Keep
12 occurrences and 10 guests. Preserve ordinary suppression semantics and expose terminal
per-recipient delivery outcomes in authorized series reads; never mark suppressed mail
delivered or erase existing links. A suppressed link-update copy is not retried; the next
link update to that recipient, if another change triggers one, repeats what that copy missed.

The two-series figures cover an hour whose series mail comes from at most two series. The
admission cap counts commits of one actor and event, but a confirmation can trail its commit
by up to the 30-minute conference wait and a refused copy by hours of SMTP retries, and older
series keep sending link updates and cancellations, so a third series can share that hour;
its mail then counts as previous traffic. For example, with defaults: series A commits at
09:00 and, waiting for its conferences, confirms at 09:30; B and C of the same actor and
event commit at 10:00:30 and 10:01, after A's admission has left the cap window, and confirm
at once; all three are cancelled between 10:02 and 10:04. The booker's rolling hour then
holds the three confirmations and A's and B's cancellations, so C's cancellation, the sixth
series mail, is suppressed (`recipient_hourly_limit`). The model finds a suppressed
cancellation in all 1680 orders of three series that each confirm, change a link and cancel
within one hour. Three such series also attempt 114 instance mails in that hour, over the
instance limit, so with different invitees the invitee copies after the 100th are suppressed
(`instance_hourly_limit`). Counting each admission for 90 minutes would not close this: B and
C would then commit just after 10:30, and A's link update, due 60 minutes after its 09:30
confirmation, would take that confirmation's place in the hour. No admission window closes
it, because a deferred copy or an older series' link update can land in any hour, so the cap
stays a rolling hour and this case is listed under known limitations.

The daily figures likewise cover a recipient's rolling day with series mail from the series in
the table only. The admission cap allows 2 new series of one actor and event every hour, but a
recipient's rolling day takes 20 invitee mails: 4 series at the series-mail maximum (5 each),
or 10 that each confirm and cancel. Mail from more series in that day counts as previous
traffic, and the 21st invitee mail, which can be a cancellation, is suppressed
(`recipient_daily_limit`). For example, an actor that books and cancels a pair of series for
the same booker every 65 minutes stays within the admission cap and never puts more than two
series in one rolling hour, yet the sixth pair's mail, its cancellations included, is
suppressed. This case is listed under known limitations too.

### Calendar attachments

Use one RFC 5545 VCALENDAR attachment with multiple independent VEVENTs, each retaining its
occurrence reschedule-chain UID, organizer snapshot and SEQUENCE, UTC DTSTART/DTEND, and
STATUS for cancellations. Omit METHOD for this aggregate calendar snapshot: it is an
importable calendar file, **not a multi-UID iTIP REQUEST or CANCEL** (iTIP scheduling
messages require a single UID). This fits the one-attachment decision while preserving
existing independent booking/provider identities. RRULE+EXDATE would introduce a second
master UID and RECURRENCE-ID exception model for independently moved bookings and pinned
provider copies; that extra reconciliation is excluded. Ordinary single-occurrence messages
keep the existing one-UID iTIP behavior. SEQUENCE follows today's rule (`data.root.depth +
(kind === 'cancelled' ? 1 : 0)` in packages/notifications/src/index.ts): confirmation and
link-update entries carry the chain depth, and CANCELLED entries carry depth + 1. A link
update re-sends an entry with the same UID and SEQUENCE and a newer DTSTAMP. Adding a
meeting link changes no time or status, so RFC 5546 §2.1.4 does not require an increment,
and by §2.1.5 the latest DTSTAMP wins when UID and SEQUENCE match. A later single-occurrence
move (depth + 1) or a cancellation (depth + 1) therefore still supersedes it. Hosts follow
today's provider-copy rule, which is decided per booking (`calendarCopyHosts` in
packages/notifications/src/index.ts: that booking's pinned destinations and calendar
conference mirrors, and its Google Meet organizer), so a series applies it per member. In
series confirmations, link updates and cancellations alike, a host's attachment leaves out
every member whose provider copy that host's calendar receives, and a host with a provider
copy of every member the mail lists gets no attachment. A member whose Meet failed has no
organizer copy, so its VEVENT stays in the organizer's attachment. No host sees a duplicate
entry. A recipient's cancellation attachment contains CANCELLED entries only for occurrences
delivered to that recipient before, in a delivered series attachment or a delivered
per-occurrence invitation; the per-recipient receipts record those. Every other affected
date is listed in the mail body only, so no client gets a stray cancelled entry for a date
it never had. Do not promise automatic native series scheduling. List every cancelled date
in the mail. See [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) and [iTIP
restrictions](https://www.rfc-editor.org/rfc/rfc5546#section-3.2).

Automate parser round trips, UID uniqueness/stability, all 12 entries, SEQUENCE/STATUS,
privacy, one attachment, SMTP counts, dedupe and fake-provider update/cancel checks. The only
manual check is the calendar client check, run by the owner once at the end of step 4b
(4b.5), before any creation interface exists. Use one current version each of Google
Calendar (web), Outlook (web) and Apple Calendar (macOS), an isolated test calendar and
synthetic files from 4b.1, with no real attendees or provider sends. Pass criteria:

1. Import: the 12-occurrence confirmation attachment, with some entries still marked
   “Meeting link pending”, creates exactly 12 entries at the stated UTC instants with no
   duplicates; a later link-update attachment updates exactly its entries in place, adding
   the link, with no duplicates.
2. Single move: the existing one-UID REQUEST for one moved occurrence updates exactly that
   entry (same UID, higher SEQUENCE); the other 11 are unchanged and nothing is duplicated.
3. Bulk cancel: after opening the cancellation attachment and taking at most the one action
   the mail documents (for example Import), every affected entry is removed or shown as
   cancelled and every unchanged entry remains. The cancellation mail also lists, in its
   body only, one affected date never delivered to that recipient; the attachment has no
   entry for it and the client shows none.

The check passes only when all three criteria hold in all three clients. Any stale active
entry, duplicate or wrong time is a failure. A failure blocks step 5a and every later step
until a revised calendar decision (for example per-occurrence CANCEL attachments) passes the
same check; no creation interface exists yet, so only 4a.1–4b.4c need rework. Record client
versions, results and the concise user instructions in that step's change.

Implementation acceptance with default limits: a 12-occurrence/10-guest/8-host series
produces exactly 19 confirmations and then 19 bulk-cancel mails, zero suppressed receipts,
12 calendar entries per creation attachment, and working links to all permitted ordinals.
With automatic conferences on fake providers: all ready gives 19 confirmations with 12
entries each; 8 ready and 4 failed give 19 confirmations with 12 entries, 8 with links and 4
marked “No automatic meeting link”; all failed give 19 confirmations with 12 entries without
links and zero per-occurrence failure notices, and repairing all 12, none of which starts
within the next hour, gives exactly 19 link-update mails with 12 updated entries no earlier
than 60 minutes after the confirmation; a provider still pending at the 30-minute wait gives
“Meeting link pending”; a started or cancelled member never delays the confirmation. With
the first member's provider still pending, the confirmation goes out 5 minutes after commit
for first starts 10, 14 and 16 minutes after commit (rule 3, the imminent-start wait), 10
minutes after commit for a first start 25 minutes after commit (rule 3, 15 minutes before
it) and 30 minutes after commit for a first start 60 minutes after commit (rule 2, the
conference wait), so a later first start never confirms earlier. A first start 10 minutes
after commit with providers ready within seconds gives 19 confirmations that carry that
first member's link, with the same counts and zero suppression; with its provider still
pending at the 5-minute wait, the confirmation marks it “Meeting link pending”, its link
appears in the series reads and pages as soon as it is ready, and no series mail reports it: the first link update cannot be due before 60 minutes after the confirmation, and that member
has started by then. If that pending link fails and is repaired before the start, the
recipients get no mail about either change. Repeat for following cancellation and
one-occurrence move/cancel on fresh fixtures. Fill the ledger to the default boundary in
negative controls and assert explicit suppression, no retry, no false delivered state,
preserved previously issued links and no capability recovery. Mutate series enqueueing back
to per-occurrence confirmation or failure fan-out and require the real count and
zero-suppression assertions to fail. These are future implementation tests; this PR only
pins the design contract, not runtime delivery behavior.

Provider writes are also one event per occurrence per existing pinned destination, with
ordinary idempotent identities, retries and cancellations. Google writeback uses the same
UID contract as today. Microsoft series writeback must follow this per-occurrence model
when that provider's writeback is supported; this design does not assert it exists today.
Never create both a provider recurring master and independent occurrence events. No shared
Zoom/Meet recurring meeting is introduced. Partial provider failure cannot roll back a
committed local series; show occurrence-specific repair/readiness state and use existing
repair authorization without rebooking the successful occurrences.

## REST, MCP and CLI proposal

All names below are proposed, not registered endpoints. Use `/api/v1`, shared scheduling
services and OpenAPI `app.openapi()` operations. Responses remain additive/open; clients
ignore unknown fields and reason strings. Register authorization and interface parity
mappings together, generate web API types, and preserve existing error shapes from
[API conventions](api-conventions.md). CLI uses the MCP registry, not separate behavior.

| Operation | REST proposal | MCP proposal | CLI proposal |
| --- | --- | --- | --- |
| Configure | Existing event-type create/update with optional `recurrence` | Existing `create_event_type` / `update_event_type` | Existing `create-event` / `update-event` |
| Discover allowed rules | Existing GET `/public/{handle}/{slug}` and `/public/teams/{handle}/{slug}` metadata gain `recurrence` | Existing `find_available_slots` returns it in `eventType` | Existing `slots` |
| Preview personal/team | POST `/public/{handle}/{slug}/series-preview` or `/public/teams/{handle}/{slug}/series-preview` | `preview_booking_series` with personal/team mode | `series preview` |
| Create personal/team | POST matching public prefix `/booking-series` | `create_booking_series` | `series book` |
| List authorized series | GET `/booking-series?limit=…&after=…` | `list_booking_series` | `series list` |
| Read host / booker | GET `/booking-series/{id}` for host; GET `/booking-series/manage` with `X-Series-Manage-Token` for booker or guest | `get_booking_series` host/seriesManageToken mode | `series get` |
| Cancel tail/all | POST `/booking-series/{id}/cancel` for host; POST `/booking-series/manage/cancel` with `X-Series-Manage-Token` for booker | `cancel_booking_series` host/seriesManageToken mode | `series cancel` |
| Move/cancel one | Existing host booking endpoints, including the reschedule request; series mode on the four existing `/bookings/manage` routes | Existing `reschedule_booking` / `cancel_booking` with a new seriesManageToken mode; existing `request_reschedule` | Existing `reschedule` / `cancel` / `request-reschedule` |
| Series metadata on existing reads | Existing GET `/bookings`, GET `/bookings/{id}`, GET `/bookings/manage` and responses sharing the `Booking` schema, webhook payloads, and the CSV export GET `/bookings/export.csv` | Existing `list_bookings` and `export_bookings` | Existing `list` and `export` |

Both preview POSTs are explicitly booking reads in the API-key scope registry and
generated scope table even though they are POSTs. API key scope never substitutes for a
host role or capability. A supplied invalid/disallowed bearer fails without anonymous
fallback. Preserve MCP OAuth `mcp:tools`, session expected-organization protections,
same-origin checks, hidden-link semantics and public route resolution. Public capabilities
remain available without authentication; never require a paid account or cloud deployment.

The implementation must add these explicit classifications (registry classes in
packages/auth/src/api-key-operations.ts) to the shared scope registry, including a row for
each new MCP tool mode, and regenerate its API-key scope table; POST-read classification
does not exempt parity.

| REST operation group | Registry class | Allowed supplied key scopes |
| --- | --- | --- |
| Event-type create/update with `recurrence` | `other_write` | `full` |
| Public event metadata GETs (unchanged rows) | `booking_read`, optional key | `full`, `read`, `bookings` |
| Both series-preview POSTs | `booking_read`, optional key | `full`, `read`, `bookings` |
| Series list and host GET | `booking_read` | `full`, `read`, `bookings` |
| GET `/booking-series/manage` | `booking_read`, optional key | `full`, `read`, `bookings` |
| Both series-create POSTs and both series-cancel POSTs | `booking_write` (create and manage cancel with optional key) | `full`, `bookings` |
| Existing member manage/slots GETs in series mode (unchanged rows) | `booking_read`, optional key | `full`, `read`, `bookings` |
| Existing member reschedule/cancel POSTs in series mode (unchanged rows) | `booking_write`, optional key | `full`, `bookings` |

Example preview input (the event supplies and validates the governing zone):

```json
{
  "firstLocalStart": "2027-02-02T09:00:00-05:00",
  "rule": {"pattern": "weekly", "count": 6},
  "durationMinutes": 30
}
```

Preview returns 200 with `canBook`, `timeZone`, `eventRevision`, `checkedAt` and the entire
ordered `occurrences` array: `{ordinal, localStart, start, end, offset, available, reason?}`.
A gap has null start/end/offset. `reason` is an open string (`unavailable`,
`nonexistent_local_time`, `outside_booking_window`); no internal busy details. A
`seriesReason: "no_common_host"` may prevent booking even if every date has some host.
Unknown readiness returns the existing service error, not `available: false` fabricated
from a failure. The bounded normalized preview object is submitted as `expectedPreview`
on create with the same rule and normal booking details. It is an equality precondition,
not a trusted hold or signature; server expansion and locked availability win.
Compare event revision, governing zone, normalized rule/duration and each ordinal's local
start, UTC endpoints and offset. Exclude `checkedAt`, `canBook`, `available`, reasons and
display labels from equality and the idempotency fingerprint; those are transient facts.
Re-evaluate availability independently instead of requiring the new check time to match.

Create with a partial/stale conflict returns 409 `series_unavailable` and optional safe
`occurrences`/`seriesReason` in the common error envelope; no booking/series IDs exist.
A changed event revision/expansion or a stale series `expectedRevision` outside a replay
returns 409 `series_changed`. Oversize/bad rule, count, zone or horizon returns 400
`invalid_recurrence` with optional open `field`. Unsupported combinations, and every admission while
[admission is off](#admission-switch), return 400 `recurrence_not_supported`. Bulk moves
return 400 `series_reschedule_not_supported`. An unknown series ID or series capability
returns a uniform 404 `series_not_found`; an unknown ordinal in series mode returns the
existing 404 `booking_not_found` of the manage routes. Reuse existing 401/403, 404
`event_type_not_found`, 409 `idempotency_key_reused`, 429 `rate_limited` and calendar
freshness errors. A fact-budget
or deadline exhaustion returns 503 `series_check_unavailable`, without partial success
or guessed availability. Add explicit shared error mapping for this proposed 503.
MCP domain failures use `isError: true`; CLI exits nonzero and exposes the same safe code
in JSON. Do not change single-booking errors or retry semantics in this design.

An agent asked to book weekly coaching for a client calls `find_available_slots` (CLI
`slots`) for the event. Its `eventType.recurrence` lists the allowed patterns, maximum count
and governing zone, and is absent when the event or instance does not allow series. The
agent previews six dates, presents all dates and the chosen zone to the client, then submits
that exact preview and a fresh retained random request key with authorized client details.
It reuses that key after transport loss; it never automatically books an available subset,
retries a single move, changes the agreed dates or emails capabilities to another person.
After a conflict it obtains a new preview and agreement before submitting a changed request.
One API key can admit at most 2 new series per event per hour, however many clients it
books for.

## Performance and abuse controls

The batch check evaluates only the submitted dates, never every slot in a year. Normalize
and reject over-limit requests before DB/provider work. Load schedules, overrides, current
membership, event policy, cached busy intervals and period counts in bounded set queries;
fetch only relevant occurrence windows and limit-period aggregates. A dense-result overflow
must return unavailable service state, never truncate busy rows and advertise free time.
The existing slot enumerator caps ranges at the slot search range in
[Existing limits](#existing-limits); do not bypass it by enumerating a year. Build an
explicit-start checker sharing its rules. No provider network I/O or per-occurrence query
loop in the check. The proposed statement, row and deadline budgets include fact loading
and aggregate result rows; reads inside the locked recheck must meet the same bound.
Instrument deterministic query/evaluation counts; benchmark the largest host/occurrence
case with dense overlapping calendars. Wall time is an abort bound, not a throughput SLA.
One transaction/connection per write, no occurrence pools, no connection retained while
awaiting external I/O. Test pools must close in teardown and each file stay well under
CI's 100-connection default.

A series submission counts as one request against the existing public booking limit (the MCP
tool applies the same `book` limit, as `create_booking` does), not one per occurrence.
Preview keeps the slot limiter and the series manage routes keep the manage limiter. The
series admission cap adds 2 committed new series per rolling hour per actor and event,
shared across the personal and team create routes. The actor is the API key or OAuth consent
when one is supplied, otherwise the client's existing rate-limit address key (an IPv4
address or IPv6 /64, honoring `TRUSTED_PROXIES`). Only admissions that commit count: an
exact replay is answered from its receipt before the cap is checked, and a validation
failure, 409 `series_unavailable` or `series_changed`, or a rolled-back transaction writes
no admission row, so stale previews cannot lock an invitee out. Create checks the cap
cheaply before expansion and again inside the transaction under the admission lock,
rejecting excess with 429 `rate_limited` and Retry-After. The counter is the
`booking_series_admissions` table, shared by every server process, unlike the in-memory
per-process public limiter. Consequences: anonymous invitees behind one NAT address share
the cap per event; one agent key gets 2 new series per event per hour regardless of how many
clients it serves; other events and actors are unaffected.

The cap bounds repeated series admission but cannot reserve the shared mail ledger against
other IPs/events. Apply ordinary recipient and instance budgets per actual series email,
never per contained VEVENT. Keep body limits, cheap validation, cancellation dedupe and
finite retries. Never log capabilities, raw answers or attendee arrays. Bound every response
by count. Retryable admission failures require a fresh preview unless recovering a committed
request with its original key.

## Implementation plan

Each row is one roughly one-working-day implementation change; a step named with a decimal
(for example 4b.3) is one of several one-day sub-steps of that step. Dependencies name only
previous rows; endpoint families and UI surfaces ship separately. All REST paths below are
relative to `/api/v1`; operation IDs are proposed unless already present.
**Interface gate** means the row ships its named REST operations, MCP tools, CLI commands,
OpenAPI schemas, authorization/API-key-scope registry and generated web API types together,
and passes route coverage, interface parity and API-key-scope parity in that same change.
This includes public POSTs and read-style POSTs; no new write waits for a later parity step.
All web UI uses the generated `/api/v1` client and only endpoints completed in earlier rows.
Each protection needs a source-copy mutation proving a real assertion fails without it.
An implementer may split a row further when it does not fit a day (for example 5g into
reads and export versus webhooks, or 6d into member and tail/all controls), keeping the
order, the interface gate and the rule that the setting arrives only with the guides.

### Admission switch

Releases are tagged from any commit on main, so no operator setting may enable an unfinished
feature. Through step 6d, series admission is **hard-off** in code: a constant in the
scheduling package, not an environment variable. `loadConfig` does not read
`RECURRING_BOOKINGS_ENABLED`, and setting it changes nothing (a 1a config test). Unit tests
enable unfinished paths through an injected service dependency, and the e2e fixture server
(tools/e2e/fixture-server.ts) through a code-only `startServer` option in
apps/server/src/server.ts, never through the environment. The production entry point
(apps/server/src/index.ts) calls `startServer()` without that option. Step 6d adds the
series manage page, the last missing interface once creation (5c, 6b), tail/all cancellation
(5e) and single-occurrence move/cancel (5f.1–5f.3) exist. Step 7 then publishes the user,
agent and owner guides, and only that step replaces the constant with the operator setting
`RECURRING_BOOKINGS_ENABLED`, default `false`, in config. That step also passes it through
docker-compose.yml with an empty default and adds an empty line to `.env.example`, so an
empty value means the code default and step 8's flip reaches installs set up earlier. So no
operator can enable series before the guides and their owner limitations exist. GET
`/instance` reports `recurringBookingsEnabled` from 5a, first from the constant and from
step 7 from the setting. Step 8, the final acceptance step, changes the default to `true`.
While hard-off, the new MCP tools and CLI commands exist; their descriptions say series
booking is not enabled on the instance until the setting is on, and they return
`recurrence_not_supported`, an empty list or 404. The same holds for the generated
documentation. From the row that adds each operation (5b onward), the API-key scope tables
that `scripts/api-key-scope-docs.ts` writes into docs/api-keys.md, docs/mcp.md and their
site copies list it, as do the MCP tool list and the OpenAPI reference. A note beside those
tables and in each operation summary says that series booking returns the disabled error
until an operator enables it, and the step 7 guides explain availability.

The switch gates admission only. While admission is off, hard-off or with the setting false:

- event-type create/update with a non-null `recurrence` that differs from the saved value
  returns 400 `recurrence_not_supported` (field `recurrence`); resending the saved value
  unchanged, `recurrence: null` and every other edit succeed, saved settings are retained,
  and authenticated event-type reads still return them;
- public event metadata, MCP `find_available_slots` and CLI `slots` omit `recurrence`, GET
  `/instance` reports `recurringBookingsEnabled: false`, and the admin editor and
  booking-page series controls stay hidden;
- both preview and both create operations (REST, MCP and CLI) return 400
  `recurrence_not_supported` before expansion, cap counting or availability work, except
  that an exact replay of an already committed create still returns its original result.

Nothing else reads the switch. Turning the setting off after series exist keeps them
confirmed and fully served: series reads, the series manage page and host series UI,
already delivered series and occurrence links, series-mode and ordinary member moves and
cancels, tail/all cancellation, pending confirmations and link-update mail, cancellation
mail, reminders, follow-ups, provider jobs, webhooks and exports all continue unchanged,
and new series mail for existing series still carries working links. Turning it on again
restores admission with the retained event settings.

| Step (about one day each) | Earlier dependencies | Owned deliverable and REST / MCP / CLI operations | Concrete acceptance checks | Admission |
| --- | --- | --- | --- | --- |
| 1a. Rule expansion | None | Pure rule normalization/expansion, the hard-off admission constant and its code-only test overrides (service dependency and `startServer` option); no environment variable, REST routes, MCP tools or CLI commands. | Weekly/fortnightly/monthly ordinals, leap year, gap, both first-slot fold offsets and Lord Howe; governing-zone determinism before host choice; fixed count/horizon and unsupported combinations; config test that `RECURRING_BOOKINGS_ENABLED=true` in the environment changes nothing and that apps/server/src/index.ts passes no override. | Hard-off |
| 1b. Batch availability | 1a | Explicit-start fact loader/check shared with single-booking rules; no REST routes, MCP tools or CLI commands. | Cumulative host-zone daily/week/month limits, buffers, unexpired payment holds blocking and expired ones not, common round-robin host and unknown freshness; 96 evaluations, at most 32 reads/10000 rows, abort at 5000 ms; dense benchmark with measured evidence required before revising a budget. | Hard-off |
| 2a.1. Series schema | 1a | First new migration: `event_types.recurrence` and its revision, `booking_series`, `booking_series_occurrences`, `bookings.series_occurrence_id`, composite FKs and the deferred root trigger; regenerated DB types. No REST routes, MCP tools or CLI commands. | Populated predecessor upgrade preserves realistic data; fresh install and no-op rerun; cross-org/member and duplicate-active-ordinal violations fail; an incomplete series fails at commit; existing single bookings remain valid. | Hard-off |
| 2a.2. Receipt, notification and admission tables | 2a.1 | Second new migration: `booking_series_receipts`, `booking_series_notifications` (receipts and outbox) and `booking_series_admissions`; admission purge added to the existing `notification-email-cleanup` job; regenerated DB types. No REST routes, MCP tools or CLI commands. | Upgrade, fresh install and no-op rerun; receipt and notification uniqueness; cross-org references fail; the purge deletes only admission rows older than two days; only digests and HMACs are stored, never raw tokens or IPs. | Hard-off |
| 2b. Atomic creation service | 1b, 2a.2 | Transaction-aware insertion, request fingerprint, replay receipts, admission lock and counter, draining past-deadline payment holds with the existing `expirePaymentHolds` for every candidate host under the host locks, after event resolution and before the locked availability recheck (as single creation does in packages/scheduling/src/bookings.ts), and one existing booking.created webhook per occurrence; automatic-conference events refused with `recurrence_not_supported` until 4b.3; no REST routes, MCP tools or CLI commands. | Concurrent series/single admission; same/different-key replay; replay answered at the cap; conflicts, validation failures and rollbacks write no admission row; failure at first/middle/final insertion leaves zero rows/jobs/webhooks; one host for all round-robin dates and documented fairness update; no external I/O under locks; a past-deadline, unswept payment hold on one date lets both a single booking and the series succeed, while preview reports that date available and writes nothing. | Hard-off |
| 3a. Capabilities and member integration | 2b | Series capability resolver and existing single-member read/move/cancel service integration; no REST routes, MCP tools or CLI commands. | Returned-token and send-time email-token hashes resolve safely; stable ordinal follows reschedule chain; cross-series/org/guest refusal; org → series → member → hosts order on host, invitee, team-admin (`cancelTeamBooking`) and reschedule-request (`requestReschedule` create and replace, and the booker's pick or cancel) paths, while the request-expiry job (`expireRescheduleRequest`) locks only the member row; every member change increments the series revision and sends the ordinary single-occurrence mail; single-member move/cancel races preserve existing protections. | Hard-off |
| 3b. Tail/all cancellation service | 3a | Transactional tail/all cancellation and action dedupe, resolving each affected member's pending reschedule request as cancelled like single cancellation, with one existing booking.cancelled webhook per affected occurrence; no REST routes, MCP tools or CLI commands. | One/following/all scopes, cutoff, expected revision, no-op/replay and deletion; cancel versus move/create races; exactly the affected local outboxes and webhooks; a pending reschedule request on an affected member ends as cancelled and one on an unchanged member stays pending; no deadlocks. | Hard-off |
| 4a.1. Series mail content | 3b | Series confirmation, series cancellation and link-update templates (text and HTML, including “Meeting link pending”, “No automatic meeting link”, “Updated separately”, started and cancelled labels, also as VEVENT descriptions) in every booking-mail catalogue (today en, zh-CN, de, fr, es, pt-BR), choosing languages as existing booking mail does; no delivery, REST routes, MCP tools or CLI commands. | Catalogue key parity in every language with no English left in other catalogues; 12-member rendering snapshots; booker, guest and host variants, with no repair instructions or mutation link for guests; escaping; no capability in logs. | Hard-off |
| 4a.2. Aggregate notification delivery | 4a.1 | One confirmation/cancellation per series action and recipient, durable dedupe, send-time capability hashing and suppression of member lifecycle fan-out for series actions; define the series-manage fragment URL contract consumed by 6d. No REST routes, MCP tools or CLI commands. | Default-budget 12-occurrence/10-guest/8-host create and tail/all cancel fixtures deliver exactly 19 complete mails each with zero suppressed rows; single-member moves/cancels send exactly the existing one per-booking mail; shared-budget exhaustion, SMTP retry and replay controls; no raw tokens in jobs/logs and no guest mutation capability; mutation back to occurrence fan-out fails the counts. | Hard-off |
| 4b.1. Aggregate calendar attachment | 4a.2 | One METHOD-less VCALENDAR of independent VEVENTs for every confirmed, not-started root member (links only for ready ones), link-update entries with the same UID and SEQUENCE and a newer DTSTAMP, per-recipient cancellation snapshots limited to previously delivered entries, and the generator for the 4b.5 synthetic files; no REST routes, MCP tools or CLI commands. | Parse every VEVENT and compare UTC times, UIDs, DTSTAMP and STATUS, with SEQUENCE equal to the chain depth on confirmation and link-update entries and depth + 1 on CANCELLED entries; 12 entries in one attachment, including pending ones; one move affects one UID; tail cancel lists only its members, and a recipient's cancellation carries no entry it was never sent; guest copies contain no other attendee data; in every series mail a host's attachment leaves out exactly the members whose provider copy (a pinned destination, or that member's Meet organizer) the host has, a host with copies of all listed members gets none, and a member whose Meet failed stays in its organizer's attachment; a member moved before the confirmation gets no VEVENT there. | Hard-off |
| 4b.2. Provider calendar jobs | 4b.1 | Existing per-booking provider writes, retries and cancellations for every member; no REST routes, MCP tools or CLI commands. | Fake Google writes one event per occurrence with the existing UID contract; tail cancel cancels exactly the affected provider events; Microsoft no-write behavior unchanged; partial provider failure keeps the local series and shows per-occurrence repair state; no provider recurring master. | Hard-off |
| 4b.3. Conference-ready series confirmation | 4b.2 | Lift the 2b automatic-conference refusal; series roots feed series state instead of per-booking `confirmed`/`conference_failed` outbox rows; confirmation due at all-terminal, the 30-minute wait, or the later of 15 minutes before the first not-started start and the first of that member's terminal state, its start or the 5-minute imminent-start wait; per-member markers. No REST routes, MCP tools or CLI commands. | Fake providers: all ready, 8 ready with 4 failed, all failed, pending at the wait, a first start 10 minutes after commit with its link ready within seconds, and, with the first link still pending, first starts 10, 14, 16, 25 and 60 minutes after commit confirmed 5, 5, 5, 10 and 30 minutes after commit (a later first start never confirms earlier), each with the exact counts, markers and times in [Calendar attachments](#calendar-attachments); started/cancelled members never delay it; whole cancel before send skips the confirmation and still sends the cancellation; zero per-occurrence failure notices and zero suppressed receipts; mutation to per-occurrence `conference_failed` fan-out fails the counts. | Hard-off |
| 4b.4a. Link-update outbox and ordering | 4b.3 | Per-recipient link-update outbox rows mirroring `booking_conference_notifications` (due time, attempts, lease, skipped/exhausted state): one waiting copy per series and recipient that later changes join, skipped when no member remains confirmed and not started, and gate 1 (ordering) of the [link-update rule](#link-update-rule), with the waiting copy made due in the transaction that makes the earlier copy final and closed gates not counted as attempts; content follows in 4b.4b and gates 2 and 3 in 4b.4c. No REST routes, MCP tools or CLI commands. | While the booker's confirmation copy is refused by SMTP and retried, the booker's link update waits until that copy is final and the other 18 recipients get theirs; the waiting copy becomes due in the transaction that makes the confirmation copy final, with its attempts untouched; a confirmation copy rejected for good or exhausted after 13 attempts also releases it; repeated changes coalesce into one waiting copy per recipient; a copy waiting at whole cancellation is skipped. Mutations that drop gate 1, skip the wake or count a closed gate as an attempt each fail. | Hard-off |
| 4b.4b. Link-update content | 4b.4a | Each copy rendered when it is sent, again on each retry, with the net changes since that recipient's last delivered report: newly ready members for everyone, as VEVENTs with the same UID and SEQUENCE and a newer DTSTAMP, newly failed members for the booker and hosts only, and never a started member; a retried confirmation copy is rendered again too. No REST routes, MCP tools or CLI commands. | All 12 fail and the host repairs all 12 through the existing conference retry: each recipient's link update carries 12 updated entries with the same UIDs and SEQUENCE and a newer DTSTAMP; a guest gets nothing for a failure-only change; a started member is never reported; a confirmation copy retried after the links became ready shows them, and the next link update does not repeat them. Mutations that render a copy when it is queued instead of when it is sent, report started members or send failure-only updates to guests each fail. | Hard-off |
| 4b.4c. Link-update spacing and daily cap | 4b.4b | Gates 2 (spacing) and 3 (daily cap) of the [link-update rule](#link-update-rule), read from each recipient's own receipts and checked when each copy is sent and on every retry, inside its send transaction after the mail-budget lock; no REST routes, MCP tools or CLI commands. | All 12 fail and the host repairs all: exactly 19 link-update mails no earlier than 60 minutes after the confirmation, then 19 cancellation mails; 57 in total and at most 38 in any rolling hour, zero suppressed. Two series at the cap, each with a confirmation, two repaired links and a whole-series cancel, in several orders: at most 4 per invitee recipient and 76 instance mails in any rolling hour, zero suppressed, also when every copy is refused once by SMTP and retried. The timed case in [Mail budget proof](#mail-budget-proof): the booker gets 4 series mails in the hour, its link update is not due before 10:33, and hosts and guests get theirs at 09:30 and 09:45. A copy refused on all 13 attempts keeps that recipient's next link update waiting until it is exhausted, about 423 minutes after its first attempt, and one delivered on its last attempt keeps it waiting until about 483 minutes after it; no other recipient waits. A fourth link-update copy to one recipient in a rolling day waits, without using any of its attempts. Mutations measuring the spacing from the series' other copies, from a copy's first attempt instead of its delivery time or from link updates only, or removing the daily cap, each fail the counts. | Hard-off |
| 4b.5. Calendar client check | 4b.4c | Owner-run import check with the 4b.1 synthetic files; no code, REST routes, MCP tools or CLI commands. | Criteria 1–3 in [Calendar attachments](#calendar-attachments) pass in Google Calendar, Outlook and Apple Calendar; versions and results recorded; any failure blocks 5a and every later step. | Hard-off |
| 5a. Event configuration interfaces | 2a.1, 4b.5 | Existing `createEventType` POST `/event-types` and `updateEventType` PATCH `/event-types/{id}` gain `recurrence` (also returned by the existing event-type GETs); existing MCP `create_event_type` / `update_event_type` arguments and CLI `create-event` / `update-event` JSON input; existing public metadata GET `/public/{handle}/{slug}` and GET `/public/teams/{handle}/{slug}` gain `recurrence`, so MCP `find_available_slots` returns it in `eventType` and CLI `slots` prints it; GET `/instance` gains `recurringBookingsEnabled`, reporting the hard-off constant until step 7. | Interface gate; owner/admin and expected-organization checks; hard-off returns 400 `recurrence_not_supported` for a changed non-null `recurrence` while null, unchanged and other edits succeed; disabled recurrence compatibility and revision invalidation; metadata exposes only permitted choices and is absent while off. | Hard-off |
| 5b. Preview interfaces | 1b, 5a | `createPublicBookingSeriesPreview` POST `/public/{handle}/{slug}/series-preview`; `createPublicTeamBookingSeriesPreview` POST `/public/teams/{handle}/{slug}/series-preview`; MCP `preview_booking_series` personal/team modes; CLI `series preview`. | Interface gate with explicit read classification for both POSTs; all dates and safe errors, stale-calendar failure, hidden links, slot limiter and invalid bearer refusal; 400 `recurrence_not_supported` while off. | Hard-off |
| 5c. Creation interfaces | 2b, 4b.5, 5b | `createPublicBookingSeries` POST `/public/{handle}/{slug}/booking-series`; `createPublicTeamBookingSeries` POST `/public/teams/{handle}/{slug}/booking-series`; MCP `create_booking_series` personal/team modes; CLI `series book`. | Interface gate; preview equality, safe 400/409/429/503 mapping and replay; one public booking charge plus the admission cap per actor and event, with replays and conflicts not counted; no partial booking/mail after failed admission; capability redaction; 400 `recurrence_not_supported` while off. | Hard-off |
| 5d. Series read interfaces | 3a, 5c | `listBookingSeries` GET `/booking-series`; `getHostBookingSeries` GET `/booking-series/{id}`; `getManagedBookingSeries` GET `/booking-series/manage` with `X-Series-Manage-Token`; MCP `list_booking_series`, `get_booking_series` host/seriesManageToken modes; CLI `series list`, `series get`. Both detail reads return each member's link state and, once its conference is ready, its current join URL in the member's protected `location`, as existing booking and manage reads do for a confirmed, ready booking. | Interface gate; bounded pagination/detail, host visibility, token-only access with header redaction, supplied-key scope enforcement and uniform 404 `series_not_found`; per-member link state; the host read and the managed read (booker and guest capabilities) return each confirmed ready member's current join URL, also after that member starts, and none for pending, failed or cancelled members; a member moved separately shows its current successor's link, never a predecessor's; reads unaffected by the switch. | Hard-off |
| 5e. Series cancellation interfaces | 3b, 5d | `cancelHostBookingSeries` POST `/booking-series/{id}/cancel`; `cancelManagedBookingSeries` POST `/booking-series/manage/cancel` with `X-Series-Manage-Token`; MCP `cancel_booking_series` host/seriesManageToken modes; CLI `series cancel`. | Interface gate; all/following semantics and atomic revalidation, no-op/replay, stale revision, cutoff and guest refusal; one series action notification per recipient; works while admission is off. | Hard-off |
| 5f.1. Series-mode manage reads | 3a, 5e | Extend existing GET `/bookings/manage` and GET `/bookings/manage/slots` with `X-Series-Manage-Token` plus an `ordinal` query field, mutually exclusive with `X-Manage-Token`; OpenAPI and generated types for the new header and field. Reads, so no new MCP tool or CLI command. | Interface gate; selector cannot escape the authorized series and follows the current member chain; guest capability is read-only and sibling-redacted; both headers return 400 `invalid_request` and neither keeps the existing 404; unknown ordinal returns 404 `booking_not_found`; existing token behavior and the ordinary manage-slot range cap remain intact. | Hard-off |
| 5f.2. Series-mode reschedule | 5f.1 | Extend `rescheduleManagedBooking` POST `/bookings/manage/reschedule` with `X-Series-Manage-Token` plus body `ordinal`, required `expectedRevision` and the existing optional `rescheduleRequestId`, returning `manageToken: null`; existing MCP `reschedule_booking` gains the seriesManageToken mode and CLI `reschedule` the same input; `rescheduleHostBooking` POST `/bookings/{id}/reschedule` unchanged. | Interface gate including the new MCP mode scope row; stale `expectedRevision` returns 409 `series_changed`; one occurrence email; series revision increments; invitee move-count and cutoff rules; guest refusal; a pick for a member's pending reschedule request resolves it as picked, and a replaced or expired request fails with the existing `reschedule_request_changed`; a lost-response replay of that pick with its request id and the now-stale `expectedRevision` returns the picked booking with `manageToken: null`, not `series_changed`, because the request check runs first; existing single-booking input/response behavior unchanged. | Hard-off |
| 5f.3. Series-mode single cancel | 5f.2 | Extend `cancelManagedBooking` POST `/bookings/manage/cancel` with the same selector, required `expectedRevision` and the existing optional `rescheduleRequestId`; existing MCP `cancel_booking` gains the seriesManageToken mode and CLI `cancel` the same input; `cancelHostBooking` POST `/bookings/{id}/cancel` unchanged. | Interface gate including the new MCP mode scope row; stale revision, cutoff, started member and guest refusal; a cancel naming a member's pending reschedule request resolves it as cancelled, a replay with that id and the now-stale revision returns the cancelled member rather than `series_changed`, and a picked, replaced or expired request fails with `reschedule_request_changed`; one occurrence email and one booking.cancelled webhook; other members untouched; existing single-booking input/response behavior unchanged. | Hard-off |
| 5g. Series metadata on existing reads, export and webhooks | 3b, 5f.3 | Additive nullable `series: {id, ordinal, count}` on the shared `Booking` schema, so it appears on GET `/bookings`, GET `/bookings/{id}` and GET `/bookings/manage`, and also on every existing response embedding that schema (host and manage cancel responses, and `BookingWithToken.booking` on create and reschedule responses): null for ordinary bookings, the member's series otherwise. Existing MCP `list_bookings` and CLI `list` return it. `series_id` and `series_ordinal` are appended after the existing columns of the personal CSV export (`exportBookingsCsv` GET `/bookings/export.csv`, MCP `export_bookings`, CLI `export`). Additive nullable `seriesId` and `seriesOrdinal` in the shared booking webhook `data` (booking.created, booking.rescheduled, booking.cancelled, booking.reschedule_requested and booking.reschedule_request_expired). OpenAPI, generated types and the published REST, export and webhook field lists. No new operations; the team export and team-admin booking list keep their current whitelist. | Interface gate. REST: each named GET, the cancel and reschedule responses and the public create response (`BookingWithToken.booking`, as `PublicBookingResult` uses it) return null for ordinary and imported bookings and the member's id/ordinal/count for every member, including rescheduled successors with the same ordinal. MCP `list_bookings` and CLI `list --json` return the same object. CSV: a member row carries its series ID and ordinal, an ordinary row leaves both empty, and existing column order is unchanged. Webhooks: snapshots captured in the booking transaction carry both fields, bulk cancel emits one webhook per affected member, and a contract test pins the published webhook field list. Additive-only OpenAPI diff. | Hard-off |
| 6a. Admin configuration UI | 5a | Event recurrence editor using completed configuration endpoints, shown only when GET `/instance` reports admission on; no REST routes, MCP tools or CLI commands. | jsdom enable/disable/validation and neutral loading/403/error states; hidden while off; en/zh-CN; preserve team weekly-hours hint; accessible controls and a CI browser flow through the injected test dependency. | Hard-off |
| 6b. Public booking page | 5b, 5c, 6a | Rule/count selection, full preview and atomic submit using completed preview/create endpoints; no REST routes, MCP tools or CLI commands. | All public locales; full/partial/stale/unknown availability, first-fold selection, retained request-key replay and returned series manage link; no series controls when metadata omits `recurrence`; generated-client CI browser creation flow. | Hard-off |
| 6c. Host series UI | 5d, 5e, 5f.3, 5g | Host series list/detail, member actions through existing host booking operations, tail/all cancel, series labels in booking lists from 5g metadata, and per-member conference state with retry and each ready member's current join link from 5d; no REST routes, MCP tools or CLI commands. | Host/cross-org visibility, en/zh-CN, current member after moves, cancellation summaries; host series detail shows each ready member's current join link, also after that member starts, and pending/failed conference states with retry and neutral unknown readiness otherwise; generated-client CI browser flow. | Hard-off |
| 6d. Series manage page | 5d, 5e, 5f.3, 6b, 6c | Fragment-token page listing every member with its current join link from 5d or its link-state marker, any pending reschedule request, move/cancel controls and tail/all cancel, sending a displayed request's id as `rescheduleRequestId` with that member's pick or cancel, as the occurrence manage page does (apps/web/src/public/api.ts); no REST routes, MCP tools or CLI commands. | Every member from the confirmation is reachable; fragment stripped safely, no capability leakage; guest read-only access and rejection of every mutation; chain follow, stale revision, cancel and failure UI; a pick or cancel of a member with a pending request sends its id, and `reschedule_request_changed` reloads the series; each ready member's current join link, or its pending or failed marker, per member, including a started member's link, which no series mail reports; all public locales and CI browser flow through the injected test dependency. | Hard-off |
| 7. Guides and admission setting | 1a–6d | User, agent, owner and self-host guides (create, manage, cancel, limits, mail timing and lag, conference markers, the 4b.5 client results, reminder-offset guidance for recurring events, and the admission cap's NAT and agent consequences), upgrade notes and the Cal.com importer activation blocker; replaces the hard-off constant with `RECURRING_BOOKINGS_ENABLED` (default `false`) in config, adds `RECURRING_BOOKINGS_ENABLED: ${RECURRING_BOOKINGS_ENABLED:-}` to the explicit environment list in docker-compose.yml and an empty `RECURRING_BOOKINGS_ENABLED=` line to `.env.example` (copied by scripts/setup.sh), and documents it in the configuration docs. It also adds a series-member exception to the existing per-booking conference pages: `/docs/automatic-google-meet` (apps/site/src/content/docs/docs/automatic-google-meet.md, “Booking and notifications”), `/docs/automatic-zoom` (automatic-zoom.md, “Status, notifications and retry”) and `/docs/notifications` (notifications.md, its automatic Google Meet paragraph and “Conference outbox delivery budget”). For series members: (1) the series confirmation is not held until every link is ready, as today's confirmed emails and REQUEST ICS are, but sent by [rules 1–3](#automatic-conferences), at most 30 minutes after commit, marking members “Meeting link pending” or “No automatic meeting link”; (2) a link or failure after that reaches series mail only in link updates under the [link-update rule](#link-update-rule), never after the member starts, and is otherwise shown on host series detail, the series manage page, hosts' own booking pages and provider copies, and in a still-due ready-gated reminder of that member; (3) a series root gets no “Meeting link needs attention” (`conference_failed`) notice: host copies of the confirmation name failed dates with the repair instructions, link updates report failures to the booker and hosts, and guests get none, as today; (4) unchanged per member: reminders stay ready-gated, cancellations are never held, and a member moved separately becomes an ordinary booking with today's held invitation and at most one failure notice. No REST routes, MCP tools or CLI commands, and no other code. | Site build and link checks; every stated limit, error code and step behavior matches this design and the bound constants; known limitations listed; the three conference pages each state exceptions (1)–(4) beside the per-booking promise they change; config tests for default false (unset and empty), true enabling admission, and turning it off keeping every behavior listed in [Admission switch](#admission-switch) working; compose and setup tests that the container receives the variable, an empty value falls back to the code default, and a setup-generated `.env` contains the empty line. | Setting, default false |
| 8. Final acceptance and default on | 7 | Cross-DST end-to-end acceptance suite; changes the `RECURRING_BOOKINGS_ENABLED` code default to `true` and the configuration docs to match; compose and `.env.example` keep the empty value, so installs whose `.env` was copied during step 7 also get the new default; no REST routes, MCP tools or CLI commands. | Cross-DST creation → one move → tail cancel → replay across host/invitee zones; compare DB instants, REST/MCP/CLI reads, export, webhooks and ICS; maximum-recipient default-budget acceptance including the all-fail conference case; self-host parity; default-on config test for unset and empty values, including a setup-generated `.env` from step 7. | Default true |

Calendar checks use parser/SMTP fixtures and fake provider adapters. Step 4b.5 is the only
owner step in this plan, with the pass criteria in [Calendar attachments](#calendar-attachments).
No separate broad manual matrix or live provider-send test is added by this plan.

## Out of scope and known limitations

No implementation in this PR. No open-ended/yearly/daily/custom RRULE series, exceptions at
creation, arbitrary per-date alternatives, partial commits, tail/all rescheduling, series
waitlist, one-time-link redemption, group seats, payment/refund orchestration,
imported-series management, per-occurrence round-robin rotation, provider recurring masters,
or automatic time-zone-rule repair. Calendar clients see independent events; booking twelve
dates produces one series confirmation per recipient, with calendar import limitations
described above. With automatic conferences, a recipient's link update becomes due at most
60 minutes after a change, except after 3 link updates to that recipient in a rolling day
(up to a day) and while that recipient's own earlier series copy is still retried by SMTP
(up to about 483 minutes after that copy's first attempt); a member without a ready link
gets no reminder. When a member's meeting link becomes ready, changes or fails shortly
before that member starts, recipients may see it only on the series manage page, host series
detail, the host's booking page, a provider calendar copy or a still-due reminder of that
member until the next link update. That update is due no earlier than 60 minutes after the
recipient's previous confirmation or link update, so the change can wait up to 60 minutes
(longer in the two cases above), and a member that has started by then is never reported in
series mail: a first member starting within the hour after the confirmation whose link was
still pending in it never gets that link in series mail. The mail figures cover at most two
series in a recipient's hour: a series whose confirmation waited for its conferences can
share that hour with two newer series of the same actor and event (for example A commits at
09:00 and confirms at 09:30, B and C commit at 10:00:30 and 10:01, and all three are
cancelled by 10:04), and the sixth series mail of that hour, C's cancellation, is
suppressed; three series in one hour also exceed the instance limit, so with different
invitees their last invitee copies are suppressed. The daily figures likewise cover only
those series: a recipient's rolling day takes 20 invitee mails, so when one actor books and
cancels a pair of series for the same booker every 65 minutes, within the admission cap, the
sixth pair's mail, cancellations included, is suppressed. Configurable reminder offsets that
differ by the series interval coincide across members. The admission cap is shared by
invitees behind one NAT address and by all clients of one agent key. The team export and
team-admin booking list gain no series fields initially. Atomic local admission cannot
guarantee provider delivery or protect against an external calendar change not yet
synchronized. The narrower combinations and rejection policy are deliberate first-release
decisions; future expansion must separately specify accounting, capabilities, races and
compatibility.