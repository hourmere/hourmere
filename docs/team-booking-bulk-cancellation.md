# Team booking bulk cancellation contract

This contract describes a future release. The current team booking list, detail and
single-booking cancellation remain the shipped interfaces. See
[team administrator booking fields](team-admin-bookings.md) for their data boundary and
[REST booking operations](../apps/site/src/content/docs/docs/api-conventions.md#lists)
for the existing cancellation rules.

## Decisions and scope

| Decision | Contract |
| --- | --- |
| Required credential | Current verified team owner/admin browser session |
| Supported operation | Cancel selected upcoming, confirmed, native team bookings that have no online payment obligation or payment record. |
| Target | One booking ID in the session's current non-personal team. A collective appointment is one booking, a group booking is one independent seat, and a recurring booking is one occurrence. |
| Confirmation identity | Server-generated confirmation ID, single use for admission |
| Atomic unit | One selected booking and its side effects. Other items continue after an item fails. |

Cancel is the existing team management action that administrators can apply to several
appointments for the same operational reason. The bulk interface has no free-text reason
field. The existing individual interfaces retain their own access rules for rescheduling,
deleting, changing hosts, attendance, refunds and provider or notification retries.
Imported records, payment holds and bookings governed by an online payment policy or
linked to a payment record are ineligible. Determine payment eligibility from stored
booking facts under lock, including the booking's immutable payment terms if present.
Today's event-type price is insufficient.
Cancellation of a selected seat or occurrence uses existing group or series rules, including
any required slot or series bookkeeping. It never adds a sibling, successor, other series
member or other group seat to the selection.

Reuse the shared team-management boundary at list opt-in, preview, confirmation and status.
These requests require `X-Expected-Organization-Id`. Preserve the existing same-origin
Origin/Referer requirement for cookie writes, the existing SSO session proof checks and
SCIM suspension checks. A team that requires a fresh SSO sign-in keeps its existing
recovery response. An Authorization header denies the request even alongside a valid
session cookie. Personal-space, ordinary-member, removed-member
and invalid-session callers receive the shared `403 team_management_access_denied`.
An administrator still authorized for the expected team receives
`409 organization_context_changed` when the current space changes. An inaccessible expected
team receives the uniform 403. Resolve authorization before reading a proof or receipt for
the caller. Receipt lookup always scopes by team and authorizing account. Another actor's or
team's receipt and a missing receipt return the same `404 bulk_cancellation_not_found`.

## Selection and confirmation

1. Use an explicit bulk mode on the team booking list. Selection belongs to one returned API
   page, even when the ordinary list appends results with **Show more**. Offer checkboxes
   for rows shown as confirmed and upcoming, using existing list fields. Preview determines
   actual eligibility. Select individually or select these rows on the active page, up to 25.
   If there are more than 25 such rows, omit the page-wide action and require explicit row
   selection. Earlier slices visible in the list are outside the active selection.
   Changing the page, applied filters, query, sort order, team or session, or replacing the
   page on refresh, clears selection and closes an unsubmitted confirmation. Disable
   submitting during loading and discard late responses from the abandoned view.
   There is no select-all-matches action.
2. An opted-in list response carries a short-lived, purpose-bound authenticated page token
   for the exact returned booking IDs in page order. Bind it to the acting account, session,
   organization and expiration. Include a keyed digest of the normalized list query and
   cursor as page identity. Keep raw filters, search text and cursor out of the token
   payload, and keep the token out of logs. The cursor only locates a boundary in a live
   list. The server rejects the entire preview when any selected ID is absent from the
   same page proof.
   Reject expired, altered or mismatched page proof before individual item lookups with
   `409 bulk_selection_changed`. Validate a list of 1–25 distinct UUIDs after canonicalization;
   duplicates, invalid IDs and over-limit lists return 400. The server normalizes the
   selection to the proof's page order and scopes every subsequent booking lookup to the
   bound team. It never queries later pages to expand the selection.
3. Preview returns one entry per selected ID with `eligible` or the applicable skip
   code from the results table, plus a confirmation ID and expiration. Preview has no
   booking, notification or journal side effects. Show the team, time zone, selected count,
   each selected appointment's identifier or recognizable label from the existing page
   whitelist, the count eligible for cancellation and the reasons shown for skipped
   entries. The primary action names the operation and eligible count
   (for example, **Cancel 3 bookings**). Disable the action when none are eligible and
   refuse direct submission with `409 bulk_no_eligible_bookings`. State that cancellation
   is irreversible, existing cancellation notifications will be queued as applicable, and
   some items may no longer be eligible when processed. Support this flow and result
   labels in en and zh-CN.
4. Closing the dialog before submitting abandons the confirmation. Confirmation sends only
   the issued ID, after an explicit user action. A confirmed receipt freezes the scope and
   item order. A row shown as ineligible stays skipped for that receipt, even if it becomes
   eligible later. A row shown as eligible can still be skipped at execution. A cancelled
   predecessor is never followed to its replacement.

## Submission, replay and recovery

The same confirmation ID always refers to the same batch. The opaque server-generated UUID
is the idempotency key and becomes the batch ID when first accepted. There is no
client-generated key or mutable second request body. Advancing an unexpired confirmation
requires the issuing session, the still-current team, current owner/admin authority and at
least one eligible preview entry. The admission transaction locks that receipt, acquires
capacity, rechecks expiry with the database clock, marks it admitted, writes the admission
audit event and enqueues the durable job together. Parallel submits serialize at
admission. A failed or rolled-back admission has no job or booking effects and can be
submitted again with the same ID while valid.
An unsubmitted expired confirmation cannot start work.

After admission, repeating confirmation returns that batch's ID and current state. Replay
bypasses new-admission quotas and creates no job, item, audit event or notification. It first
requires fresh authorization for the same account and team. The same actor can recover a
previously accepted batch after signing in again in that team. A new session cannot submit
a previous session's unused confirmation and receives `404 bulk_cancellation_not_found`.
Unavailable or purged IDs are never reused as new confirmations, even by the same actor.
Resubmitting with extra fields or edited target IDs is invalid. A changed selection
requires a new preview and explicit confirmation.

After a timeout, the browser keeps the submitted ID and known confirmation expiry in the
team's current tab and checks that same ID. A 404 before expiry is inconclusive while the
submit is unresolved. It can safely resend the same ID while the original view and session
are still valid. After navigating away or changing context, resume status only on return to
the authorized team. Status checks an unadmitted receipt under a lock that serializes with
admission and uses database time to report expiration. An expired response, or a 404 once
the known expiry has passed on the server, ends recovery. Starting a different batch
requires a fresh list read, deliberate new selection and explicit confirmation.
On completion, refresh visible booking states in the bound team and retain the per-item
results and counts. A new attempt for an unsuccessful item begins with a fresh selection
and preview of bookings still eligible.

## Execution, results and undo

A worker handles one item at a time per batch. Recheck the original submitting session's
expiry, active team, verified actor, exact current owner/admin role, SCIM eligibility and
required SSO proof for each pending item under the existing team-write locks. Reapply the
team-write pre-commit SSO proof fence inside the worker transaction, where the HTTP
middleware's request context is absent. Resolve current policy and evidence through the
stored actor and session identifiers. Keep bearer material out of the queue. Use the
existing organization and booking cancellation lock order, including series and group locks
as applicable. Check the current start time, state, import status and payment eligibility
after locking the booking, using the current time after any lock wait. Keep the item
claim lock after the team authorization locks and before booking-related locks.
Stop pending writes on loss of authority or team context and finalize the unprocessed rows
with `authorization_lost`; completed rows stand. A transient database/lock failure is not a
loss-of-authority result.

The status response reports `queued`, `running` or `completed`, counts by outcome, and one
ordered entry per selected booking ID. Counts include pending rows and sum to the selected
count. `completed` means every item has a terminal outcome, which may include failures.
Each entry has one of these codes.

| Code | Meaning |
| --- | --- |
| `pending` | Awaiting an attempt or an internal retry. |
| `cancelled` | This batch committed that booking's cancellation and its normal durable side effects. |
| `already_cancelled` | Previously cancelled, including a rescheduled predecessor. No cancellation side effects from this batch. |
| `booking_started` | The same-team booking was confirmed but had already started at eligibility check. |
| `booking_not_supported` | The same-team entry was imported, held for payment or otherwise ineligible by its stored payment or lifecycle policy. |
| `booking_unavailable` | No booking with this ID exists in the bound team. Missing and outside-team rows share the same code, with no foreign metadata. |
| `authorization_lost` | The original authority or active team stopped permitting write work. |
| `processing_failed` | A transient failure exhausted item retries, or the execution window ended before an outcome could be committed. The booking transaction did not commit through this batch. |

Evaluate in order: owned row exists, current state is already cancelled, state or policy
is unsupported, scheduled start has passed, then eligible. A worker must distinguish an
already-cancelled group seat from a cancellation, even when a shared helper otherwise
returns a no-op. A terminal result never changes. An expected item rejection can be recorded
without rolling back earlier items. If an unexpected write error occurs, roll back that
item before recording a terminal failure in a separate transaction. A disconnect at
commit leaves the outcome unknown. Re-read the result under the item claim fence before
retrying or recording failure, and keep any committed result. A successfully committed
cancellation and its successful item result are inseparable.

After admission there is no stop or undo operation. Closing a progress dialog stops only
viewing. Committed cancellation releases the booking's occupancy or group seat under
existing scheduling rules and may enqueue attendee notices, webhooks, calendar and
conference cleanup or other existing cancellation effects. A `cancelled` result describes
the database change, with delivery tracked by existing
notification rules. Correct an unintended cancellation through a new booking if the
time and event are still available, with its own confirmation, notifications and identity.
Never restore old meeting links, reuse the cancelled row or compensate a failed item by
undoing a successful one.

## Data, queue and audit

Store a batch header (ID, team, actor, issuing session ID, timestamps, state) and ordered
item rows (batch ID, ordinal, booking ID, preview eligibility/outcome, execution outcome
and due/attempt metadata). Enforce one row per booking and ordinal per batch, one admission
and at most one active batch per team. Avoid a cascading link from an item to a booking so
a disappearing target still has an outcome. Team deletion removes its receipts and any
stale job must exit. Session deletion prevents further writes without erasing a receipt.
Keep typed status codes and UUIDs. Store no session bearer, page token, raw filter, name,
email, answer, cancellation reason, manage token, meeting URL, provider failure text or
provider credentials in receipts or job payloads. Queue only the batch ID.

| Limit | Initial design value |
| --- | --- |
| Maximum selected rows from one returned page | 25 |
| Page proof and unsubmitted confirmation lifetime | 10 minutes from page issuance, shared by the proof and its confirmations |
| Preview attempts per rolling minute | 6 per account/team and 30 per team |
| New admissions per rolling minute | 2 per account/team and 4 per team |
| Status reads and client polling | 30 per account/team per rolling minute, poll no faster than every 3 seconds while visible |
| Active batches | 1 per team and 100 per instance, queued and running combined |
| Concurrent work | 1 item per team and at most 4 item transactions per instance across workers |
| Item write bounds | 2-second lock wait and 10-second transaction deadline |
| Transient retries and execution window | At most 3 attempts per item including the first, with 5-second and 15-second delays. Stop starting items 5 minutes after admission. |
| Completed result and replay retention | 7 days from completion |

Rate and capacity checks are shared across processes, using database time and atomic
admission. Authorized excess returns `429 rate_limited` with `Retry-After`; capacity
refusal returns `429 bulk_queue_full` with `Retry-After`. Neither consumes the confirmation.
Honor the server delay before another request. Under full capacity, existing status and
replays still work within their read budget. Enforce runtime concurrency across worker replicas.
Use the existing Postgres job infrastructure and a bounded recovery sweep for due items and
batches past their deadline. Treat jobs as at-least-once wakeups. Commit an attempt claim with a
lease before work. The item transaction rechecks the claim and batch deadline under lock
before mutation, and holds the claim fence through the booking mutation, journal, normal
notification enqueue and terminal item result. A redelivery sees completed items and
only resumes pending ones. Recovery honors
active fences, remaining attempt budgets and operation deadlines. No external provider I/O
runs inside item transactions. Use the existing delivery outboxes, budgets and retry policies.

Record `booking.bulk_cancellation_admitted` once with admission and
`booking.bulk_cancellation_completed` once with terminal completion, using the batch ID as
target. Attribute admission to the initiating user/session and completion to the bulk
worker. The batch's events use the batch ID as their server-generated
`request_id`, including each successful item's ordinary `booking.cancelled` entry.
That ordinary entry and existing operation attribution identify the real initiating
administrator. Allow only selected count on admission and bounded outcome counts on
completion. Use existing journal retention and transactional audit rules, with application
and database allow-lists for the new action details. Skips, failed attempts, replays and
redeliveries emit no extra cancellation event. Rejected previews and admissions produce
no business audit event. Receipt retention governs the detailed outcomes for those
entries. Expire receipts with bounded cleanup that skips locked rows and never removes a
running batch.

## REST, MCP and CLI surfaces

All interfaces below are proposed. Requests and responses are private and non-cacheable.

| Browser-session REST | Contract | MCP and CLI |
| --- | --- | --- |
| `GET /api/v1/team/bookings?bulkSelection=true` | Existing page and optional `bulkPageToken` and `bulkPageExpiresAt` for opted-in requests. Ordinary list envelope stays unchanged. | No team-wide list tool or command. |
| `POST /api/v1/team/bookings/bulk-cancellations/preview` | `previewTeamBookingBulkCancellation`. Takes `{pageToken, bookingIds}`, returns 200 with `confirmationId`, `expiresAt` and ordered preview entries. | Session-only parity exemption. |
| `POST /api/v1/team/bookings/bulk-cancellations/{id}/confirm` | `confirmTeamBookingBulkCancellation`. Bodyless. Returns 202 with `{id, state}` while queued/running and 200 with the same shape when completed. Expired unused confirmation with a retained receipt returns 409 `bulk_confirmation_expired`. | Session-only parity exemption. |
| `GET /api/v1/team/bookings/bulk-cancellations/{id}` | 200 with admitted batch state, counts and ordered item results. A live unsubmitted receipt returns `{id, state: "awaiting_confirmation", expiresAt}` and an expired retained receipt returns 409 `bulk_confirmation_expired`. Missing, purged and foreign IDs share 404. | No team-wide status tool or command. |

Register proposed writes in OpenAPI with exactly `[{ "session": [] }]` and concrete
`browser-session-only` entries for both operation IDs in
[scripts/interface-parity.json](../scripts/interface-parity.json). The existing MCP
`cancel_booking` and CLI `cancel` continue to apply their host or invitee-link authority
for one booking. Agent credentials cannot impersonate a team administrator or access
batch receipts through an alternate interface.

## Test plan and one-day implementation steps

Each row is an implementation slice with its own review and checks. Keep admission and
UI off through the earlier slices.

| Day | Scope and prerequisites | Acceptance checks |
| --- | --- | --- |
| 1. Scope and proof | Session-only opted-in list, selected-page proof, and preview receipt schema with constraint coverage. | Real PostgreSQL fixtures for two teams and multiple pages. Verify search/sort and cursor changes, forged or expired proof, unseen IDs and UUID duplicates. Cover admin, owner, host-only member, personal, removed, expired and unverified sessions, API keys, MCP OAuth and credential-plus-cookie requests. |
| 2. Durable admission | Confirm/status, shared rate, queue and journal admission, using day 1 proof and receipts. | Test parallel submission and lost response, same-key replay after a new sign-in, stale unsubmitted receipt, quotas across processes and rollback of enqueue or audit writes. Test receipt privacy and authorization before existence checks. Run generated type and parity gates. |
| 3. Item processing | Existing cancellation service integration and recovery, using day 2 receipts. | Mix eligible, cancelled, started, unavailable, imported and paid rows. Check a deadline crossed while locked, session or role revocation, team switch, SCIM suspension and SSO proof expiry or revocation during work. Exercise concurrent host cancellation, per-item rollback and worker crash/redelivery. Verify group/series isolation, one journal/cancellation intent per success, no extra writes, result retention and bounded concurrency with real PostgreSQL and fake providers. |
| 4. Browser and release gate | Selection, confirmation and results UI in en and zh-CN, using all prior slices. | Keyboard and multi-role browser acceptance. Check that page/filter/team changes clear selection, stale async results cannot submit, a lost response recovers the existing batch, and the completion screen explains skipped and committed rows. Verify the existing single-booking and host agent paths still behave as before. Enable only after authorization, privacy, recovery and operator acceptance pass. |
