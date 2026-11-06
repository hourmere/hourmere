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
Configuration uses existing event-type authorization and full API key scope.
The invitee chooses an allowed pattern, first local date/time, count, and the usual
one duration, location choice, answers, attendees and locale for the entire series.
A single appointment continues through the ordinary booking flow. Existing series
retain snapshots when the event setting changes or recurrence is disabled.

### Normative bounds

These proposed numeric limits are pinned by the documentation fact test, not runtime
constants. Later implementations must import shared constants and extend that test to
compare them. Raising a limit requires design review and new performance evidence.

| Limit | Value | Reason |
| --- | --- | --- |
| Minimum occurrences | 2 | A single meeting uses the existing flow. |
| Maximum occurrences | 12 | Covers a weekly term or monthly year without unbounded writes/mail. |
| Maximum horizon in local calendar days | 366 | Last local date is at most today + 366 in the recurrence zone; bounds future commitments. |
| Maximum candidate hosts | 8 | Retains the existing collective/round-robin host ceiling. |
| Maximum occurrence-host evaluations | 96 | 12 occurrences times 8 hosts; no alternative-search multiplication. |
| Maximum batch database read statements | 32 | Fixed budget for availability fact loading, independent of occurrence count. |
| Maximum batch fact rows | 10000 | Fail closed rather than truncate a dense busy/booking history. |
| Batch deadline in milliseconds | 5000 | Includes fact loading and evaluation; abort work and release the connection. |

The event's booking window can only shorten the horizon. Count includes the initial
occurrence, never automatically extends to replace a conflict, and cannot be open-ended.
No `UNTIL`, arbitrary RRULE, RDATE, multiple weekdays per week, or caller-provided
expanded UTC array. A request contains `rule: {pattern, count, ordinal?, weekday?}`
and `firstLocalStart` without offset. Reject ordinal/weekday outside monthly rules.
The server expands the rule. An RRULE equivalent is useful for explanation only:
weekly maps to `FREQ=WEEKLY;INTERVAL=1;COUNT=n`, fortnightly to interval 2, and
monthly to `FREQ=MONTHLY;BYDAY=2MO;COUNT=n` (or `-1MO` for last Monday).
The structure avoids accepting the much larger [RFC 5545 recurrence language](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).
It is not an ICS serialization promise.

## Time zones and DST

The event's saved recurrence zone governs expansion, including collective and round-robin
series. Pin that zone on the series. Each occurrence preserves the initial local start
time in that zone across DST, not a fixed elapsed interval. Invitee display zones only
change labels; show the governing zone and every date, local offset and invitee-local
time before confirmation. An invitee in another DST regime can see their hour change.
Duration remains elapsed minutes, as for ordinary bookings.

Use Temporal with explicit disambiguation: a nonexistent local start makes that occurrence
unavailable (`nonexistent_local_time`), without shifting forward or skipping it. A repeated
local start always selects the earlier instant; display its offset in preview and persist
it. There is no later-fold selector in this release. An end crossing a transition is computed
by adding elapsed duration to the start instant. Store both UTC instants on each normal
booking and the original local start on its series occurrence. A timezone database update
never recalculates committed bookings; only a newly previewed/moved occurrence uses current
rules. Recheck preview's resolved instants at commit; return `series_changed` if they differ.

Examples for acceptance: New York weekly 09:00 across spring/fall changes stays 09:00
while UTC changes; a New York 02:30 spring-gap occurrence rejects the batch; repeated
01:30 in autumn uses the earlier offset. Include Australia/Lord_Howe's half-hour change,
a non-DST zone and differing host/invitee zones. Monthly `last` must work across February
and leap years without substituting a numbered date.

## Availability and interactions

Reject the entire series if any occurrence fails. Preview lists every requested occurrence
and its safe availability result; available entries are informational, not reservations or
an offer to submit a subset. Invitees may change the first start, pattern or count and
preview again. No automatic skip, available-subset checkout or per-date alternative search.
A stale checkout returns a conflict and offers a fresh preview without losing form data.
Readiness errors, loading and unauthorized responses remain unknown, never “missing setup.”

| Existing behavior | Series decision |
| --- | --- |
| Daily/weekly/monthly limits | Each occurrence consumes one booking. Compute cumulative proposed counts against active bookings of this event in each host's effective schedule zone (Monday-based weeks and calendar months), not the recurrence/display zone. Check all periods before any insert. |
| Buffers and busy times | Apply ordinary exclusions and buffers to every occurrence and to pairs within the proposed set; other event types/imports still block time. |
| Minimum notice and window | Re-evaluate each occurrence against one fresh clock sampled after locks. All must pass; later dates cannot escape the current window. |
| One-time links | Unsupported for series initially; refuse before consumption with `recurrence_not_supported`. Their existing single-booking semantics are unchanged. |
| Group seats | Unsupported, including creating a new slot or joining an occupied slot. Do not silently treat a series as one seat/slot. |
| Round-robin | One host for the entire series, chosen from hosts eligible and available for every occurrence. Never choose a different host per date. If intersections are empty, fail even if each date has some host. Apply existing fair selection once among whole-series candidates and advance fairness once on successful commit, never preview/replay. |
| Collective | The same complete pinned required-host set attends every occurrence; all must pass. Missing/currently invalid membership fails closed. |
| Waitlist | No series waitlist or redemption token initially; reject a waitlist token on series creation. Existing single-slot waitlists remain unchanged. Cancelled occurrences may trigger normal single-slot waitlist wakeups through existing committed effects. |
| Paid bookings | Unsupported. Reject paid event configurations, rather than charging once or partly refunding an atomic series. |
| Imported bookings | Continue to block availability. Never attach imported read-only rows to a new series or allow series operations to bypass `imported_booking_read_only`. No inference of imported recurrence. |
| Guests, duration, location, conferences | Respect current opt-ins and validation; snapshot the same choices per occurrence. Automatic conferences remain independently provisioned and ready-gated per occurrence, not one shared provider meeting. |

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

Proposed future migration (allocate its number when implemented, not here):

- Add nullable `event_types.recurrence` JSONB with validated pattern subset, IANA zone
  and bounded maximum, plus a revision incremented on any admission-relevant setting
  change. Null preserves disabled behavior for every predecessor event. Enforce shape
  and numeric checks in the database; canonical zone validation belongs to the service.
- `booking_series`: UUIDv7 `id`, `organization_id` FK with organization cascade,
  nullable `event_type_id` (deletion sets null), immutable original event UUID snapshot,
  rule version/validated rule columns, `time_zone`, initial local start, requested count,
  duration/notification/host-policy snapshots, `created_at`/`updated_at` timestamptz,
  revision for optimistic concurrency and nullable SHA-256 series manage-token digest.
  Store neither raw management tokens nor raw idempotency response bodies.
- `booking_series_occurrences`: UUIDv7 `id`, organization and series IDs, stable
  `ordinal` (1 through requested count), original local start and resolved UTC start/end,
  and the immutable root booking ID. Unique `(series_id, ordinal)` and root booking ID.
  CHECK positive ordered finite instants, valid bounded ordinal and rule fields. The
  transaction verifies contiguous count and that the first date matches the rule; a
  deferred constraint trigger verifies count/root ownership at commit.
- Add nullable `series_occurrence_id` to `bookings`. Every successor in an existing
  reschedule chain retains that occurrence ID. A partial unique index on occurrence ID
  where status is confirmed permits at most one live version; cancelled predecessors
  remain ordinary history. An occurrence can be cancelled without deleting its row.
- Composite unique `(organization_id, id)` parent keys and composite FKs bind series,
  occurrences and booking roots to the same organization. Deferred root references
  resolve insertion cycles within one transaction. Do not rely on UUID uniqueness alone
  for tenancy. Validate event ownership too; preserve ordinary event-deletion behavior.
- `booking_series_receipts`: UUIDv7 ID, organization, operation kind, authority-scope
  digest, idempotency key/fingerprint, series ID and bounded affected occurrence/result
  IDs. Unique `(organization_id, authority_scope, operation_kind, idempotency_key)`.
  Persist create and bulk-cancel receipts transactionally. Scope remains tied to the
  caller/API key or OAuth consent (anonymous shared organization scope), never to email alone.
- Index series `(organization_id, id)` for cursor listing, occurrences `(series_id, ordinal)`,
  bookings `series_occurrence_id`, and receipt series FK. Existing booking time/status,
  exclusion and host indexes remain in force. Series rows and receipts cascade on
  organization deletion; event deletion cannot destroy booked occurrence history.
  Retention deletes a complete eligible series only after its ordinary booking/chain
  retention permits it, with explicit child cleanup, never a dangling retained receipt.

Old bookings have null series membership; no backfill or guessing from matching titles.
The migration must preserve populated predecessor rows, fresh install and no-op re-run,
then regenerate db types. No migration or generated schema changes belong to this PR.

Existing list queries, exports, activity, billing-independent counts, reminders and follow-ups
continue to see one ordinary booking per occurrence. Lists must not replace rows with a
summary. Add optional safe series ID/ordinal/count metadata to booking read models and
exports; retain current pagination and cancelled-predecessor semantics. Emit existing
booking-created/rescheduled/cancelled webhooks per affected occurrence, with additive safe
series metadata and the current immutable minimal whitelist. No attendees, manage tokens
or provider IDs in webhook metadata. No new series webhook is required initially.
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

Proposed order for a new series: existing waitlist fence is unnecessary because tokens
are refused; organization parent -> all configured host advisory locks in existing sorted
order -> locked event/membership resolution -> round-robin state if applicable -> insert
new series/occurrence/booking rows in ordinal order. Recheck receipt after serialization,
policy/version, host pool, current time, all availability and aggregate limits. Acquire
all host locks once, not once per occurrence. Only newly created series rows are locked
on this path; never lock preexisting occurrence booking rows after holding host locks.
Existing exclusion constraints remain the final collision defense. Any failed insert,
limit, enqueue or constraint rolls back every row, fairness update and outbox intent.
Provider/SMTP I/O occurs only after commit through existing durable jobs; atomicity covers
local booking intent, not distributed delivery or provider calendar availability changes.

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
series/current booking lifecycle with 200 (first creation 201), no second reservation,
fairness advance, mail or raw manage token. Reauthorize before every replay; do not rerun
new admission rules against an already committed series. Cancel replay returns the original
affected IDs with current state even when its expected revision is now stale. Retained
receipts define the replay lifetime; after retention deletion, no perpetual dedupe promise.
Lost-response recovery uses authenticated reads or the original queued confirmation links,
not token recovery from a GET or replay.

## Reschedule, cancel and capabilities

| Scope | Reschedule | Cancel |
| --- | --- | --- |
| One occurrence | Existing move creates a cancelled predecessor and successor under the same stable occurrence ID. Other occurrences keep instants, hosts, rules and links. | Existing cancellation affects only its current chain; no replacement date is added. |
| This and following | Unsupported (`series_reschedule_not_supported`); do not emulate with a partial loop. Move individually or cancel the tail and book a new series explicitly. | Supported atomically for the selected immutable ordinal and higher ordinals that have not started. Ordinal, not a moved start time, defines “following.” |
| Whole series | Unsupported bulk move; rule edits never rewrite committed bookings. | Atomically cancel every still-confirmed, not-started occurrence. Past/started/cancelled rows stay historical and are reported as unchanged. |

Both hosts and the primary booker may cancel future occurrences subject to current ordinary
booking authorization. Hosts must be authorized for every target, never gain cross-team
power from knowing a series UUID; a team admin without existing booking authority gains none.
A guest's existing links remain occurrence-only. Invitee moves retain current move-count,
cutoff, duration and availability rules; pinned round-robin/collective hosts do not rotate
on a move. Host moves preserve the current host-specific policy. Cancellation stays possible
when an event is disabled/deleted, while moving still needs a bookable event.

Mint one separate series capability for the primary booker, store its digest and deliver
its raw value only at creation or in the encrypted notification outbox under existing expiry
rules. Use a fragment-based series manage page and request-body capability, not URL query
parameters or logs. Each occurrence keeps its own token and reschedule-chain following
semantics; an occurrence token cannot authorize siblings or mint a series token. Series
reads require the series capability or a currently authorized host. A series token follows
its stable occurrence records to successors but does not expand into unrelated bookings.

Bulk cancel accepts `scope: "all" | "following"`, `fromOrdinal` only for following,
`expectedRevision`, a request key and optional reason. Sample one clock after locks; compute
and return affected/unchanged IDs explicitly. An empty eligible set succeeds without mail.
Single changes increment series revision in the same transaction. A non-replay stale
revision returns `series_changed` for a reload; never silently include a concurrently moved
occurrence. Series capability remains useful for reading history after cancellation.

## Notifications and calendars

Choose per-occurrence confirmations and ICS, with the position/count and a series manage
link for the primary booker; the web confirmation lists all occurrences. Explicitly warn
before booking that each date sends an invitation. This preserves per-occurrence conference
readiness, recipient privacy and existing durable delivery receipts. Do not send a second
aggregate confirmation with duplicate calendar attachments. Reminders/follow-ups stay per
occurrence using snapshotted policy and its own due times. Bulk cancellation queues one
ordinary cancellation per affected occurrence/recipient, with finite retries and existing
mail budgets; batching does not bypass suppression or promise exactly-once SMTP delivery.

Each invitation has one independent VEVENT, using that occurrence's reschedule-chain root
UID, organizer snapshot and existing SEQUENCE rules. Use UTC DTSTART/DTEND, no RRULE,
EXDATE or RECURRENCE-ID; a move updates that occurrence UID and a cancel cancels only it.
This deliberately sacrifices calendar-native “edit series” grouping. Google, Outlook and
Apple interoperability must be exercised on actual supported clients before release;
independent VEVENTs avoid depending on identical recurrence-exception interpretations but
are a design choice, not proof of universal compatibility. Follow [existing calendar
invitation rules](https://hourmere.com/docs/notifications#calendar-invitations) and
[RFC 5545 VEVENT](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1).

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
| Preview personal/team | POST `/public/{handle}/{slug}/series-preview` or `/public/teams/{handle}/{slug}/series-preview` | `preview_booking_series` with personal/team mode | `series preview` |
| Create personal/team | POST matching public prefix `/booking-series` | `create_booking_series` | `series book` |
| List authorized series | GET `/booking-series?limit=…&after=…` | `list_booking_series` | `series list` |
| Read host / booker | GET `/booking-series/{id}` for host; POST `/booking-series/manage` with token for booker | `get_booking_series` host/manageToken mode | `series get` |
| Cancel tail/all | POST `/booking-series/{id}/cancel` for host; POST `/booking-series/manage/cancel` with token for booker | `cancel_booking_series` host/manageToken mode | `series cancel` |
| Move/cancel one | Existing booking endpoints; optional additive series metadata | Existing `reschedule_booking` / `cancel_booking` | Existing `reschedule` / `cancel` |

Preview is explicitly a read even though POST: public callers and `read`, `bookings`,
`full` keys can use it. Create/cancel require `bookings` or `full` when a key is supplied;
reads accept all three with current booking visibility. API key scope never substitutes
for a host role or capability. A supplied invalid/disallowed bearer fails without anonymous
fallback. Preserve MCP OAuth `mcp:tools`, session expected-organization protections,
same-origin checks, hidden-link semantics and public route resolution. Public capabilities
remain available without authentication; never require a paid account or cloud deployment.

Example preview input (the event supplies and validates the governing zone):

```json
{
  "firstLocalStart": "2027-02-02T09:00:00",
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
not a trusted reservation or signature; server expansion and locked availability win.
Compare event revision, governing zone, normalized rule/duration and each ordinal's local
start, UTC endpoints and offset. Exclude `checkedAt`, `canBook`, `available`, reasons and
display labels from equality and the idempotency fingerprint; those are transient facts.
Re-evaluate availability independently instead of requiring the new check time to match.

Create with a partial/stale conflict returns 409 `series_unavailable` and optional safe
`occurrences`/`seriesReason` in the common error envelope; no booking/series IDs exist.
A changed event revision/expansion returns 409 `series_changed`. Oversize/bad rule, count,
zone or horizon returns 400 `invalid_recurrence` with optional open `field`. Unsupported
combinations return 400 `recurrence_not_supported`. Bulk moves return 400
`series_reschedule_not_supported`. Reuse existing 401/403/404, 409
`idempotency_key_reused`, 429 `rate_limited` and calendar freshness errors. A fact-budget
or deadline exhaustion returns 503 `series_check_unavailable`, without partial success
or guessed availability. Add explicit shared error mapping for this proposed 503.
MCP domain failures use `isError: true`; CLI exits nonzero and exposes the same safe code
in JSON. Do not change single-booking errors or retry semantics in this design.

An agent asked to book weekly coaching for a client discovers the event's allowed rules,
previews six dates, presents all dates and the chosen zone to the client, then submits
that exact preview and a fresh retained random request key with authorized client details.
It reuses that key after transport loss; it never automatically books an available subset,
retries a single move, changes the agreed dates or emails capabilities to another person.
After a conflict it obtains a new preview and agreement before submitting a changed request.

## Performance and abuse controls

The batch check evaluates only the submitted dates, never every slot in a year. Normalize
and reject over-limit requests before DB/provider work. Load schedules, overrides, current
membership, event policy, cached busy intervals and period counts in bounded set queries;
fetch only relevant occurrence windows and limit-period aggregates. A dense-result overflow
must return unavailable service state, never truncate busy rows and advertise free time.
The existing slot enumerator caps ranges at 62 days; do not bypass it by enumerating
a year. Build an explicit-start checker sharing its rules. No provider network I/O or
per-occurrence query loop in the check. The normative statement,
row and deadline budgets include fact loading and aggregate result rows; reads inside the
locked recheck must meet the same bound. Instrument deterministic query/evaluation counts;
benchmark the largest host/occurrence case with dense overlapping calendars. Wall time is
an abort bound, not a throughput SLA. One transaction/connection per write, no occurrence
pools, no connection retained while awaiting external I/O. Test pools must close in teardown
and each file stay well under CI's 100-connection default.

Reuse public IP/account/event rate limits and request-body limits. Charge admission/mail
budgets by occurrence and recipient rather than one cheap “series” request; replay creates
no new charge for deliveries. Authentication and cheap validation precede expensive work.
Never log capabilities, raw answers or attendee arrays; previews expose only safe outcomes.
Apply cancellation outbox dedupe and ordinary mail budgets even to bulk actions. Retain
existing guest limits and encrypted outbox expiry, and bound all responses by count.
No hidden unbounded automatic retries; retryable failures require a new current preview
unless recovering an already committed request with its original key.

## Implementation plan

Each row is a roughly one-day reviewable slice, with shared helpers split further if the
acceptance cannot fit. Do not combine all slices into one implementation PR.

| Slice | Deliverable | Concrete acceptance checks |
| --- | --- | --- |
| Engine: expansion and batch availability | Pure rule expansion and bounded shared-service fact loader/check; no checkout UI. | Weekly/fortnightly/monthly ordinals; leap year, gap/fold, Lord Howe; cumulative host-zone daily/week/month limits and buffers; common round-robin host; unknown freshness; at limits 96 evaluations, at most 32 reads/10000 rows and abort at 5000 ms; source-copy mutations break each protection. |
| Atomic creation | Future migration plus transaction-aware batch insertion and receipts. | Populated predecessor/fresh/no-op migration and regenerated types; concurrent series/single bookings and identical/different replay; failure at first/middle/final insertion leaves zero rows/jobs; fairness once; no external I/O under locks; preserved single-booking tests. |
| Series cancellation | Tail/all cancellation, series capabilities and single-member lock integration. | One vs following vs all; stable ordinal after moves; host/booker/guest and cross-org authorization; cutoff, stale revision, no-op/replay; cancel vs single move/create races and deletion; exactly the affected local outboxes, no deadlocks, no token recovery. |
| Notifications and ICS | Per-occurrence delivery using existing receipts/UIDs and provider targets. | One failed conference does not block ready siblings; move/cancel one UID; SMTP retry/budget negative controls; Google/Microsoft fake adapters only; Google/Outlook/Apple manual import/update/cancel matrix with explicit results and owner steps. |
| UI and REST/MCP/CLI | Equivalent proposed operations, event enablement and full-list preview/management. | OpenAPI/authorization/parity guards and generated types; replay/error/capability redaction; jsdom conflict/stale/unknown states; en and zh-CN admin, all shipped public locales; preserve weekly-hours readiness hint; CI browser checks for full/partial availability. |
| Docs and acceptance | published user/agent/self-host guides and known limits, release/upgrade notes. | Cross-DST end-to-end creation, one move, tail cancel and replay; different host/invitee zones; compare DB instants, exports, webhooks and ICS; limit and unsupported-feature examples; same feature on self-hosting; actual client matrix evidence or clearly recorded release blocker. |

## Out of scope and known limitations

No implementation in this PR. No open-ended/yearly/daily/custom RRULE series, exceptions
at creation, arbitrary per-date alternatives, partial commits, tail/all rescheduling,
series waitlist, one-time-link redemption, group seats, payment/refund orchestration,
imported-series management, per-occurrence round-robin rotation, provider recurring masters,
or automatic time-zone-rule repair. Calendar clients see independent events; booking twelve
dates can produce twelve invitations per recipient. Atomic local admission cannot guarantee
provider delivery or protect against an external calendar change not yet synchronized.
The narrower combinations and rejection policy are deliberate first-release decisions;
future expansion must separately specify accounting, capabilities, races and compatibility.
