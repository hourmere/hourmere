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
| Maximum guests | 10 | Retains the existing guest ceiling, in addition to the booker. |
| Recipient mail per rolling hour | 5 | Existing default booking-mail budget. |
| Recipient mail per rolling day | 20 | Existing default booking-mail budget. |
| Instance mail per rolling hour | 100 | Shared default ledger for booking, sign-in and team mail. |
| Public booking requests per minute per IP | 10 | Existing public book limiter; one series submission uses one request. |
| Series submissions per hour per IP and event | 2 | Additional series-specific admission cap, shared across personal/team create routes. |

The event's booking window can only shorten the horizon. Count includes the initial
occurrence, never automatically extends to replace a conflict, and cannot be open-ended.
No `UNTIL`, arbitrary RRULE, RDATE, multiple weekdays per week, or caller-provided
expanded UTC array. A request contains `rule: {pattern, count, ordinal?, weekday?}`
and `firstLocalStart` with a required numeric UTC offset (for example `2027-11-07T01:30:00-05:00`). Validate that offset against the event zone on that date; reject a mismatch instead of normalizing it. Reject ordinal/weekday outside monthly rules.
The server expands the rule. An RRULE equivalent is useful for explanation only:
weekly maps to `FREQ=WEEKLY;INTERVAL=1;COUNT=n`, fortnightly to interval 2, and
monthly to `FREQ=MONTHLY;BYDAY=2MO;COUNT=n` (or `-1MO` for last Monday).
The structure avoids accepting the much larger [RFC 5545 recurrence language](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).
It is not an ICS serialization promise.

## Time zones and DST

The event's saved recurrence zone governs expansion, including collective and round-robin
series. Hosts may not yet be selected in round-robin, and collective hosts may have different zones; one event-owned zone makes expansion deterministic before host selection. Pin that zone on the series. Each occurrence preserves the initial local start
time in that zone across DST, not a fixed elapsed interval. Invitee display zones only
change labels; show the governing zone and every date, local offset and invitee-local
time before confirmation. An invitee in another DST regime can see their hour change.
Duration remains elapsed minutes, as for ordinary bookings.

Use Temporal with explicit disambiguation: a nonexistent local start makes that occurrence
unavailable (`nonexistent_local_time`), without shifting forward or skipping it. A repeated
local start after the first occurrence selects the earlier instant; display its offset in preview and persist
it. The first occurrence honors the supplied offset, including a later-fold slot selected
from ordinary availability; never silently replace that instant with the earlier fold. An end crossing a transition is computed
by adding elapsed duration to the start instant. Store both UTC instants on each normal
booking and the original local start on its series occurrence. A timezone database update
never recalculates committed bookings; only a newly previewed/moved occurrence uses current
rules. Recheck preview's resolved instants at commit; return `series_changed` if they differ.

Examples for acceptance: New York weekly 09:00 across spring/fall changes stays 09:00
while UTC changes; a New York 02:30 spring-gap occurrence rejects the batch; repeated
01:30 in autumn uses the earlier offset for generated dates; first-slot tests cover both valid offsets and reject an invalid offset. Include Australia/Lord_Howe's half-hour change,
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
| Round-robin | One host for the entire series, chosen from hosts eligible and available for every occurrence. Never choose a different host per date. If intersections are empty, fail even if each date has some host. Apply existing fair selection once among whole-series candidates and advance fairness once on successful commit, never preview/replay. Existing least-recently-assigned rotation measures assignments, not booked minutes: a 12-date series can load one host twelve times more than a single booking. Mitigate with cumulative host limits and an owner-lowered maxOccurrences; explicitly document that equal meeting-count distribution is not guaranteed. Do not pretend repeated timestamp advances solve this skew. |
| Collective | The same complete pinned required-host set attends every occurrence; all must pass. Missing/currently invalid membership fails closed. |
| Waitlist | No series waitlist or redemption token initially; reject a waitlist token on series creation. Existing single-slot waitlists remain unchanged. Cancelled occurrences may trigger normal single-slot waitlist wakeups through existing committed effects. |
| Paid bookings | Unsupported. Reject paid event configurations, rather than charging once or partly refunding an atomic series. |
| Imported bookings | Continue to block availability. Never attach imported read-only rows to a new series or allow series operations to bypass `imported_booking_read_only`. No inference of imported recurrence. The Cal.com importer retains its `event_recurring` warning ("Recurring event generation is not imported"); its yearly/1–20 intervals/32-count rules must not be partially mapped into this subset. |
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
  revision for optimistic concurrency and nullable SHA-256 primary-booker API series manage-token digest.
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
- `booking_series_notifications`: series/action revision/kind/recipient unique receipt,
  recipient role and capability scope, nullable unique SHA-256 manage-token digest,
  outcome/suppression reason and bounded affected ordinals. This is a new series equivalent
  of booking notification receipts, not an encrypted credential outbox. Delete with series
  retention; successful hashes remain valid for the retained series history. Durable jobs
  carry only IDs, never raw capabilities. Member lifecycle jobs must suppress their ordinary
  confirmation/cancellation fan-out when owned by an aggregate series action.
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
Guests retain no booking mutation authority; existing guest mail does not issue manage links. Invitee moves retain current move-count,
cutoff, duration and availability rules; pinned round-robin/collective hosts do not rotate
on a move. Host moves preserve the current host-specific policy. Cancellation stays possible
when an event is disabled/deleted, while moving still needs a bookable event.

Mint a primary-booker API series capability at creation and persist only its digest;
return the raw value once, never on replay. For each booker/guest series email, mint a fresh 32-byte
base64url capability at send time and store only its digest in the new series notification
receipt, following today's `booking_notifications` transaction/send pattern. SMTP failure
rolls the receipt back; retry mints a new token. Terminal budget suppression clears that
attempt's digest and does not retry; earlier delivered/API capabilities stay valid. No raw
series token enters a job or encrypted outbox. A crash after SMTP before commit has the
existing duplicate/invalid-link window; do not claim exactly-once delivery.

Each booker/guest mail contains one `/series/manage#<token>` link. The page sends the fragment token
in POST bodies or the redacted `x-series-manage-token` header for existing GET manage/slots operations (never logs/query strings) and lists every occurrence and its current
successor. Booker capabilities can read the series and cancel all/following; guest mail
capabilities expose only that recipient's permitted read-only details, never sibling attendee data or mutation authority. Host mail links to authenticated
series detail instead. Existing per-occurrence capabilities remain occurrence-only.
The series page invokes existing manage-booking read/slots/reschedule/cancel operations extended
with a mutually exclusive `seriesToken` plus stable `ordinal` authority mode (ordinal may be a GET query field, never the token); the service
resolves the current chain and applies that recipient's existing permissions/cutoffs. It
never returns or mints raw occurrence tokens. Thus one delivered series link reaches every
occurrence without needing twelve separately delivered links. Series token lookup checks
both API and successful notification digests, role, retained ownership and revocation.
Already displayed API links and authenticated host access survive suppressed mail; a lost
anonymous response plus suppressed email cannot be recovered by replay. Show delivery
failure through authorized reads and document host assistance, not guaranteed delivery.

Bulk cancel accepts `scope: "all" | "following"`, `fromOrdinal` only for following,
`expectedRevision`, a request key and optional reason. Sample one clock after locks; compute
and return affected/unchanged IDs explicitly. An empty eligible set succeeds without mail.
Single changes increment series revision in the same transaction. A non-replay stale
revision returns `series_changed` for a reload; never silently include a concurrently moved
occurrence. Series capability remains useful for reading history after cancellation.

## Notifications and calendars

Notifications are per series action. Creation sends one confirmation per recipient
listing every occurrence, with one calendar attachment containing every occurrence.
Whole-series or this-and-following cancellation sends one email per recipient listing the
affected and unchanged dates, with one attachment containing the affected events. A
single-occurrence reschedule or cancel sends one email for that occurrence. Do not also
queue the ordinary per-occurrence lifecycle messages for a series action. Reminders and
follow-ups remain per occurrence with ordinary budgets and snapshotted due times.

With default limits and an initially empty ledger, 12 occurrences with 10 guests send
1 email to each of 11 invitee recipients: 1 < 5/hour and 1 < 20/day, not 12 each.
Including the maximum 8 collective hosts, creation costs 11 + 8 = 19 instance emails,
below 100/hour. Creation followed by a whole-series cancellation in the same hour costs
2 per invitee and 38 instance emails; two maximum series each created and cancelled cost
4 per invitee and 76 instance emails. No host reserve is needed for this proof (the
existing worker allows verified hosts up to 120, but that is not extra invitee capacity).
Keep 12 occurrences and 10 guests. Previous traffic, reminders, unrelated sign-in/team
mail or lower operator-configured limits can still exhaust the shared ledger; these
figures prove bounded isolated actions fit, not guaranteed global delivery. Preserve
ordinary suppression semantics and expose terminal per-recipient delivery outcomes in
authorized series reads; never mark suppressed mail delivered or erase existing links.

The aggregate confirmation waits for all required occurrence conferences to be ready,
using a bounded durable retry policy; it cannot send a partial calendar and silently omit
an unready date. On exhaustion expose failed/pending occurrence readiness in the series
page and host repair workflow. No extra automatic per-occurrence confirmation on repair.
Refresh lifecycle/revision before send so an overtaken aggregate cannot revive cancelled
or moved events. This deliberately trades independent sibling delivery for one complete mail.

Use one RFC 5545 VCALENDAR attachment with multiple independent VEVENTs, each retaining
its occurrence reschedule-chain UID, organizer snapshot and SEQUENCE, UTC DTSTART/DTEND,
and STATUS for cancellations. Omit METHOD for this aggregate calendar snapshot: it is an
importable calendar file, **not a multi-UID iTIP REQUEST or CANCEL** (iTIP scheduling messages
require a single UID). This fits the one-attachment decision while preserving existing
independent booking/provider identities. RRULE+EXDATE would introduce a second master UID
and RECURRENCE-ID exception model for independently moved bookings and pinned provider
copies; that extra reconciliation is excluded. Ordinary single-occurrence messages keep
the existing one-UID iTIP behavior. Bulk cancellation's snapshot may require manual import
and client confirmation to update/remove existing entries; do not promise automatic native
series scheduling or uniform cancellation imports. List every cancelled date in the mail.

Automate parser round trips, UID uniqueness/stability, all 12 entries, SEQUENCE/STATUS,
privacy, one attachment, SMTP counts, dedupe and fake-provider update/cancel checks.
Before release the only owner client check is to import a synthetic maximum-series file,
then a generated single-move update and bulk-cancel snapshot into one supported version
each of Google Calendar, Outlook and Apple Calendar, recording count, duplicates and
whether cancellations require deletion. Use isolated test calendars, no real attendees or
provider sends. Record versions/results and concise user instructions; incompatible update
or cancellation behavior is a release blocker requiring a new calendar decision, not an
unbounded owner matrix. See [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) and
[iTIP restrictions](https://www.rfc-editor.org/rfc/rfc5546#section-3.2).

Implementation acceptance with default limits: a 12-occurrence/10-guest/8-host series
produces exactly 19 confirmations and then 19 bulk-cancel mails, zero suppressed receipts,
12 calendar entries per creation attachment, and working links to all permitted ordinals.
Repeat for following cancellation and one-occurrence move/cancel on fresh fixtures. Fill
the ledger to the default boundary in negative controls and assert explicit suppression,
no retry, no false delivered state, preserved previously issued links and no capability
recovery. Mutate aggregate enqueueing back to occurrence fan-out and require real count
and zero-suppression assertions to fail. These are future implementation tests; this PR
only pins the design contract, not runtime delivery behavior.

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

Preview and `POST /booking-series/manage` are explicitly booking reads in the API-key scope registry and generated scope table even though POST: public callers and `read`, `bookings`,
`full` keys can use it. Create/cancel require `bookings` or `full` when a key is supplied;
reads accept all three with current booking visibility. API key scope never substitutes
for a host role or capability. A supplied invalid/disallowed bearer fails without anonymous
fallback. Preserve MCP OAuth `mcp:tools`, session expected-organization protections,
same-origin checks, hidden-link semantics and public route resolution. Public capabilities
remain available without authentication; never require a paid account or cloud deployment.

The implementation must add these explicit classifications to the shared scope registry
and regenerate its API-key scope table; POST-read classification does not exempt parity.

| REST operation group | Scope classification | Allowed supplied key scopes |
| --- | --- | --- |
| Event-type create/update recurrence | Account configuration write | `full` |
| Both series-preview POSTs | Booking read | `read`, `bookings`, `full` |
| Series list/host GET and POST `/booking-series/manage` | Booking read | `read`, `bookings`, `full` |
| Both series-create POSTs and both series-cancel POSTs | Booking write | `bookings`, `full` |
| Existing member manage/slots reads | Booking read | `read`, `bookings`, `full` |
| Existing member reschedule/cancel POSTs | Booking write | `bookings`, `full` |

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

A series submission counts as one public booking request against the existing
10 requests/60 seconds per IP book limiter, not twelve. Add a series-specific cap of
2 submissions/rolling hour per IP and event, with a shared durable counter across server
processes; reject excess with 429 before expansion. Replays still consume request limits
but produce no new mail. Preview retains the 120 requests/60 seconds per IP slots limiter;
manage retains 30/60 seconds. The extra create cap bounds repeated series admission but
cannot reserve the shared mail ledger against other IPs/events. Apply ordinary recipient
and instance budgets per actual aggregate email, never per contained VEVENT. Keep body
limits, cheap validation, cancellation dedupe and finite retries. Never log capabilities,
raw answers or attendee arrays. Bound every response by count. Retryable admission failures
require a fresh preview unless recovering a committed request with its original key.

## Implementation plan

Each row is one roughly one-working-day implementation change. Dependencies name only
previous rows; endpoint families and UI surfaces ship separately. All REST paths below
are relative to `/api/v1`; operation IDs are proposed unless already present.
**Interface gate** means the row ships its named REST operations, MCP tools, CLI commands,
OpenAPI schemas, authorization/API-key-scope registry and generated web API types together,
and passes route coverage, interface parity and API-key-scope parity in that same change.
This includes public POSTs and read-style POSTs; no new write waits for a later parity step.
All web UI uses the generated `/api/v1` client and only endpoints completed in earlier rows.
Each protection needs a source-copy mutation proving a real assertion fails without it.

Introduce proposed `RECURRING_BOOKINGS_ENABLED=false` in 1a. **Off** below means no real
series admission or notification emission; only isolated test fixtures enable unfinished
paths. Schema migrations still run normally. **Off; test-on** permits end-to-end fixtures,
not production enablement. Keep it off through 6d, so aggregate email never sends a link to
a missing page. Step 7 permits operator opt-in only after every dependency and acceptance
check passes; the shipped default remains false. Once enabled, turning the flag off stops
new configuration/preview/create and hides admission controls, but keeps existing series
reads, manage pages, moves/cancels and delivery workers working. This is an admission flag,
not a mechanism that strands existing recipients. Do not enable a partially deployed build.

| Step (about one day each) | Earlier dependencies | Owned deliverable and REST / MCP / CLI operations | Concrete acceptance checks | Flag state |
| --- | --- | --- | --- | --- |
| 1a. Rule expansion | None | Pure rule normalization/expansion and flag plumbing; no REST routes, MCP tools or CLI commands. | Weekly/fortnightly/monthly ordinals, leap year, gap, both first-slot fold offsets and Lord Howe; governing-zone determinism before host choice; fixed count/horizon and unsupported combinations. | Off |
| 1b. Batch availability | 1a | Explicit-start fact loader/check shared with single-booking rules; no REST routes, MCP tools or CLI commands. | Cumulative host-zone daily/week/month limits, buffers, common round-robin host and unknown freshness; 96 evaluations, at most 32 reads/10000 rows, abort at 5000 ms; dense benchmark with measured evidence required before revising a budget. | Off |
| 2a. Schema and upgrade | 1a | Future migration for recurrence/revision, series/member/request-receipt and notification bookkeeping described above, booking membership, composite FKs and deferred guards; regenerated DB types. No REST routes, MCP tools or CLI commands. | Populated predecessor upgrade preserves realistic data; fresh install and no-op rerun; cross-org/member and duplicate-active-ordinal violations fail; existing single bookings remain valid. | Off |
| 2b. Atomic creation service | 1b, 2a | Transaction-aware insertion, request fingerprint and replay receipts; no REST routes, MCP tools or CLI commands. | Concurrent series/single admission, same/different-key replay, failure at first/middle/final insertion leaves zero rows/jobs; one host for all round-robin dates and documented fairness update; no external I/O under locks. | Off |
| 3a. Capabilities and member integration | 2b | Series capability resolver and existing single-member read/move/cancel service integration; no REST routes, MCP tools or CLI commands. | Returned-token and send-time email-token hashes resolve safely; stable ordinal follows reschedule chain; cross-series/org/guest refusal; org → series → member → hosts order; single-member move/cancel races preserve existing protections. | Off |
| 3b. Tail/all cancellation service | 3a | Transactional tail/all cancellation and action dedupe; no REST routes, MCP tools or CLI commands. | One/following/all scopes, cutoff, expected revision, no-op/replay and deletion; cancel versus move/create races; exactly the affected local outboxes and no deadlocks. | Off |
| 4a. Aggregate notification delivery | 3b | One confirmation/cancellation per series action and recipient, durable dedupe and send-time capability hashing; define series-manage fragment URL contract consumed by 6c. No REST routes, MCP tools or CLI commands. | Default-budget 12-occurrence/10-guest create and tail/all cancel fixtures deliver complete lists without suppressed rows; include maximum hosts in instance accounting; shared-budget exhaustion, SMTP retry and replay controls; no raw tokens in jobs/logs and no guest mutation capability. | Off |
| 4b. Calendar attachments and provider jobs | 4a | One aggregate calendar attachment, stable per-occurrence UID/SEQUENCE and existing per-booking provider jobs; no REST routes, MCP tools or CLI commands. | Parse every VEVENT and compare UTC times/UIDs; one move affects one UID, tail cancel only its members; fake Google writes/Microsoft no-write behavior; aggregate waits for all conferences and exposes bounded-retry exhaustion; automate calendar-file checks, leaving only the client behavior checks specified above for the owner. | Off |
| 5a. Event configuration interfaces | 2a, 4b | Existing `createEventType` POST `/event-types` and `updateEventType` PATCH `/event-types/{id}` gain `recurrence`; existing MCP `create_event_type` / `update_event_type` arguments and CLI `create-event` / `update-event` flags. | Interface gate; owner/admin and expected-organization checks; disabled recurrence compatibility and revision invalidation; public event metadata exposes only permitted recurrence choices. | Off |
| 5b. Preview interfaces | 1b, 5a | `createPublicBookingSeriesPreview` POST `/public/{handle}/{slug}/series-preview`; `createPublicTeamBookingSeriesPreview` POST `/public/teams/{handle}/{slug}/series-preview`; MCP `preview_booking_series` personal/team modes; CLI `series preview`. | Interface gate with explicit read classification for both POSTs; all dates and safe errors, stale-calendar failure, hidden links, public limits and invalid bearer refusal. | Off |
| 5c. Creation interfaces | 2b, 4b, 5b | `createPublicBookingSeries` POST `/public/{handle}/{slug}/booking-series`; `createPublicTeamBookingSeries` POST `/public/teams/{handle}/{slug}/booking-series`; MCP `create_booking_series` personal/team modes; CLI `series book`. | Interface gate; preview equality, safe 400/409/429/503 mapping and replay; one public booking charge plus series cap; no partial booking/mail after failed admission; capability redaction. | Off |
| 5d. Series read interfaces | 3a, 5c | `listBookingSeries` GET `/booking-series`; `getHostBookingSeries` GET `/booking-series/{id}`; `getManagedBookingSeries` POST `/booking-series/manage`; MCP `list_booking_series`, `get_booking_series` host/manageToken modes; CLI `series list`, `series get`. | Interface gate, explicitly classifying manage POST as read; bounded pagination/detail, host visibility, token-only access, supplied-key scope enforcement and uniform missing-capability errors. | Off |
| 5e. Series cancellation interfaces | 3b, 5d | `cancelHostBookingSeries` POST `/booking-series/{id}/cancel`; `cancelManagedBookingSeries` POST `/booking-series/manage/cancel`; MCP `cancel_booking_series` host/manageToken modes; CLI `series cancel`. | Interface gate; all/following semantics and atomic revalidation, no-op/replay, stale revision, cutoff and guest refusal; one aggregate action notification per recipient. | Off |
| 5f. Single-occurrence interfaces | 3a, 5e | Extend existing GET `/bookings/manage`, GET `/bookings/manage/slots`, `rescheduleManagedBooking` POST `/bookings/manage/reschedule` and `cancelManagedBooking` POST `/bookings/manage/cancel` for a series capability plus member ordinal (GET uses a dedicated redacted token header and ordinal query, POST uses body fields); preserve `rescheduleHostBooking` POST `/bookings/{id}/reschedule` and `cancelHostBooking` POST `/bookings/{id}/cancel`. Existing MCP `reschedule_booking` / `cancel_booking` and CLI `reschedule` / `cancel` gain the same member selector. | Interface gate; selector cannot escape the authorized series, follows the current member chain and requires expected member revision; single move/cancel sends one occurrence email; existing single-booking input/response behavior and ordinary manage-slot range cap remain intact. | Off |
| 6a. Admin configuration UI | 5a | Event recurrence enablement/editor using completed configuration endpoints; no REST routes, MCP tools or CLI commands. | jsdom enable/disable/validation and neutral loading/403/error states; en/zh-CN; preserve team weekly-hours hint; accessible controls and CI browser flow. | Off; test-on |
| 6b. Public booking page | 5b, 5c, 6a | Rule/count selection, full preview and atomic submit using completed preview/create endpoints; no REST routes, MCP tools or CLI commands. | All public locales; full/partial/stale/unknown availability, first-fold selection, retained request-key replay and returned series manage link; generated-client CI browser creation flow. | Off; test-on |
| 6c. Series manage page | 5d, 5e, 5f, 6b | Fragment-token page listing every member and its move/cancel controls plus tail/all cancel; no REST routes, MCP tools or CLI commands. | Every member from the aggregate email is reachable; fragment stripped safely, no capability leakage; guest read-only access and rejection of every mutation; reschedule-chain follow, stale revision, cancel and failure UI; all public locales and CI browser flow. | Off; test-on |
| 6d. Host series UI | 5d, 5e, 5f, 6c | Host series list/detail and member/tail/all actions through completed endpoints; no REST routes, MCP tools or CLI commands. | Host/cross-org visibility, en/zh-CN, current member after moves, cancellation summaries and neutral unknown readiness; generated-client CI browser flow. | Off; test-on |
| 7. Documentation and DST acceptance | 1a–6d | User/agent/self-host guides, deployment/upgrade and flag notes, importer warning and documented client limitations; no REST routes, MCP tools or CLI commands. | Cross-DST creation → one move → tail cancel → replay across host/invitee zones; compare DB instants, exports, webhooks and ICS; maximum-recipient default-budget acceptance; recorded client results/release blockers and self-host parity. | Default off; opt-in only after acceptance |

Calendar checks use parser/SMTP fixtures and fake provider adapters. The only owner client
check is the exact synthetic import → single move → bulk-cancel sequence specified in
“Notifications and calendars,” once per named client/version; record its result or a release
blocker. No separate broad manual matrix or live provider-send test is added by this plan.

## Out of scope and known limitations

No implementation in this PR. No open-ended/yearly/daily/custom RRULE series, exceptions
at creation, arbitrary per-date alternatives, partial commits, tail/all rescheduling,
series waitlist, one-time-link redemption, group seats, payment/refund orchestration,
imported-series management, per-occurrence round-robin rotation, provider recurring masters,
or automatic time-zone-rule repair. Calendar clients see independent events; booking twelve
dates produces one aggregate confirmation per recipient, with calendar import limitations described above. Atomic local admission cannot guarantee
provider delivery or protect against an external calendar change not yet synchronized.
The narrower combinations and rejection policy are deliberate first-release decisions;
future expansion must separately specify accounting, capabilities, races and compatibility.
