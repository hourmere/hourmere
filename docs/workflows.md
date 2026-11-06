# Booking workflows design

Status: proposed design, not a shipped feature. This change adds no product code,
migration or interface strings. Decisions below are Hourmere decisions unless explicitly
attributed to another product. Existing reminders and follow-ups remain available.

## Evidence and existing foundations

Official help checked on 2026-11-06:

- [Calendly: create an Automation](https://calendly.com/help/how-to-create-an-automation)
  describes choosing a template or custom automation, selecting a trigger and timing,
  and automated email/text reminders and follow-ups. Its current help calls these
  Automations, although the create page title still says Workflows.
- [Calendly: view Automations](https://calendly.com/help/how-to-view-your-automations)
  describes event-type associations and a meeting timeline showing when automations ran.
- [Cal.com: Workflows overview](https://cal.com/help/workflows/workflowsoverview)
  describes personal/team ownership, applying to selected links or all links including
  future links, booking/cancellation/reschedule/no-show and before/after triggers,
  email steps, delays, filters and paths. Its delay example carries a wait over a
  reschedule. Its help also describes variables, custom messages and self-hosted usage.

These pages establish product examples, not delivery guarantees. We do not infer their
idempotency, privacy, retry or mail-budget behavior. Hourmere deliberately chooses the
bounded model below instead of reproducing every competitor feature.

The implementation foundation is [notification settings](../packages/scheduling/src/notification-settings.ts),
[scheduled mail](../packages/notifications/src/scheduled.ts),
[mail budgets](../packages/notifications/src/mail-limits.ts),
[notification delivery](../packages/notifications/src/index.ts),
[webhook service](../packages/webhooks/src/service.ts),
[delivery](../packages/webhooks/src/delivery.ts) and
[transport](../packages/webhooks/src/transport.ts). Read their existing tests before implementation.
Also preserve [reminder behavior](../apps/site/src/content/docs/docs/reminders-and-follow-ups.md),
[webhook behavior](../apps/site/src/content/docs/docs/webhooks.md),
[team booking privacy](team-admin-bookings.md), [API conventions](api-conventions.md)
and [MCP authorization](mcp.md).

## Relationship with reminders and follow-ups

Workflows sit beside the existing notification system. They share infrastructure and
lifecycle fences, but do not replace confirmation/cancellation/reschedule mail, calendar
invitations, or the reminder settings API. Existing event settings and immutable booking
notification snapshots retain their meaning, including the legacy-default branch, default
reminder, host notes, recipient rules, original settings on reschedule, and import silence.
No automatic conversion or backfill sends workflow mail for historical bookings.

Migration in the first release is therefore a no-op for existing settings and bookings.
An owner who wants a custom workflow instead of a reminder first removes the original
rule through the existing notification-setting operation, then enables the workflow for
future bookings. Bookings made between those changes can have neither custom message;
existing bookings keep their original reminder. The editor explains this boundary. There
is no atomic conversion endpoint or silent rewriting of existing booking snapshots in v1.
A later explicit conversion tool would require its own parity-complete contract.

Prevent duplicate reminder intents rather than attempting content similarity detection:
when capturing each booking, record an intent key of category (before-start/after-end),
elapsed offset and normalized recipient address. Existing reminder/follow-up intents win.
Workflow email at that same category/offset/address is skipped as `existing_notification`;
this applies even when its wording differs or the legacy message is later suppressed.
For overlapping workflows, the earliest-created workflow (ID tie-breaker) wins that intent.
Distinct offsets and lifecycle messages are intentionally distinct communications. Warn
about them in preview; no claim is made that similar prose at different times is deduplicated.
Existing group-host aggregation stays untouched; a workflow cannot reopen its receipt.

## Definitions, ownership and limits

A definition has immutable identity and owner, a revision, name, enabled flag, scope,
trigger, optional lifecycle delay, AND conditions, and one email or webhook action.
Creation defaults to disabled. A scope selects one event type or all current and future
event types of the same personal owner or team. Personal scopes never cover team event
types merely because the person hosts them. An all-event workflow and event-specific
workflows count together toward the enabled-per-event limit; enforce it under an owner
lock on workflow changes and event-type creation. Disabled drafts do not execute.

The following are **proposed limits**, pinned by the document test, not existing runtime
constants. They bound fan-out, storage and understandability. Structural and recipient
limits are fixed; the instance/owner mail values are defaults for the separately configurable
sub-caps below, rather than unchangeable product capacity limits.

| Identifier | Value | Meaning |
| --- | ---: | --- |
| `WORKFLOW_MAX_ENABLED_PER_EVENT` | 5 | Matching enabled definitions, including all-event definitions. |
| `WORKFLOW_MAX_DEFINITIONS_PER_OWNER` | 100 | All retained definitions, including disabled drafts; deletion releases definition capacity. |
| `WORKFLOW_NAME_MAX_BYTES` | 200 | UTF-8 name size after normalization. |
| `WORKFLOW_SUBJECT_MAX_BYTES` | 200 | UTF-8 custom subject limit. |
| `WORKFLOW_BODY_MAX_BYTES` | 8000 | UTF-8 custom body limit per locale. |
| `WORKFLOW_RENDERED_MAX_BYTES` | 16000 | Maximum expanded plain text per recipient before HTML escaping. |
| `WORKFLOW_MAX_ACTIONS` | 1 | Action per definition; multiple workflows express independent actions. |
| `WORKFLOW_MAX_CONDITIONS` | 5 | Predicates joined only by AND. |
| `WORKFLOW_MIN_TIMER_OFFSET_MINUTES` | 5 | Smallest before/after offset. |
| `WORKFLOW_MAX_OFFSET_MINUTES` | 43200 | Largest timer offset or lifecycle delay. |
| `WORKFLOW_MAX_LATE_MINUTES` | 60 | Strict upper bound on catch-up lateness. |
| `WORKFLOW_MAIL_MAX_PER_HOUR` | 20 | Default WORKFLOW_MAIL_MAX_PER_HOUR before the shared-budget reserve. |
| `WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR` | 5 | Scale positive core caps down before applying the workflow ceiling. |
| `WORKFLOW_OWNER_MAIL_MAX_PER_HOUR` | 5 | Default WORKFLOW_OWNER_MAIL_MAX_PER_HOUR for each personal owner or team. |
| `WORKFLOW_RECIPIENT_EMAILS_PER_HOUR` | 1 | Dedicated normalized-address allowance, including hosts. |
| `WORKFLOW_RECIPIENT_EMAILS_PER_DAY` | 3 | Dedicated normalized-address allowance, including hosts. |
| `WORKFLOW_HISTORY_DAYS` | 30 | Visible run history and scheduled metadata retention after terminal state. |

## Triggers, conditions and snapshots

| Trigger | Capture and timing |
| --- | --- |
| `booking.created` | Once for an original confirmed native booking, including paid confirmation; never a hold. |
| `booking.cancelled` | Once for explicit cancellation; not for a reschedule predecessor. |
| `booking.rescheduled` | Once for a committed successor, with a private internal link to the predecessor. |
| `before_start` | Start instant minus positive whole-minute offset. |
| `after_end` | Scheduled end instant plus positive whole-minute offset; no attendance assertion. |

Capture uses the same `BookingNotifier` lifecycle events as notifications and webhooks.
`pending_payment` holds capture no workflows or timers. Successful paid confirmation
captures `booking.created` exactly once at confirmation, with timer anchors at the booked
instants; payment release or `expired` holds emit no `booking.cancelled` workflow.

No-show marking is absent from the inspected main booking service and routes. Reserve no
public `no_show` enum now: introduce `booking.no_show_marked` only alongside a real
permission-checked attendance transition, event capture and parity-complete interfaces.
Repeated marking must not create another occurrence; an undo/re-mark policy needs design
with that feature. Do not infer absence from conference-provider attendance.

Lifecycle triggers permit a nonnegative whole-minute `delayMinutes` through the maximum
offset; zero means immediately eligible after commit. Before/after triggers use their
offset directly and reject a second delay. There is no chain of waits or action-dependent
execution. Failed/suppressed email does not block another definition's webhook.

Capture workflow revision and relevant booking snapshot in the booking transaction,
including a durable lifecycle occurrence ID. Definitions created or edited later affect
future captures only. Rescheduling retains the original captured timer definitions and
recalculates anchors on the successor, like reminders; it also captures current enabled
reschedule-trigger definitions. It does not capture new created-trigger definitions. Pending delayed-created work is
retired on reschedule rather than carried forward; see the explicit divergence below.
Disable/delete always overrides snapshots and prevents future dispatch. Re-enabling never
revives terminal/skipped work. Imported bookings and their reschedule chains are excluded,
matching existing import silence.

| Condition | Rationale and comparison |
| --- | --- |
| Event type equals | Equivalent to an event-specific scope; retained as an explicit AND predicate for editor consistency. |
| Booking source equals | Personal only; exact existing stored source enum, never caller-supplied inference. |
| Attendee answer equals | Personal only; booker's saved answer for a stable question ID, exact typed scalar equality. |
| Location kind equals | Personal only; fixed location discriminator, never URL/text matching. |
| Guest count equals/at least/at most | Number of non-booker attendees saved on this booking, inclusive integer comparison. |

Conditions are AND only, with no nesting, OR, regex, scripts or network lookups. Multiple
workflows can express alternatives but still consume the same cap and intent deduplication.
Missing/deleted questions and unknown values fail closed; arrays/free-text searching are
unsupported. Answer predicates are only allowed for a single personal event type so the
question schema is unambiguous. Team definitions reject source, answer and location
predicates, including in preview: boolean matching and skip history can leak hidden data.
Evaluate against the captured occurrence snapshot, then recheck live eligibility,
ownership and lifecycle before dispatch. A failed condition records only `condition_false`,
not the value or predicate index. Cancelled snapshots intentionally remain eligible for
cancellation actions; they never revive before/after actions.

## Email and webhook actions

Email recipients are classes: booker, other attendees, assigned hosts, or their union.
Resolve saved assignments, not the current round-robin pool; send individually and dedupe
normalized addresses across classes. Never accept arbitrary recipient addresses, CC/BCC,
custom From/Reply-To, attachments or executable template logic. Group events are excluded in the first workflow release. Their slot-owned host
notification policy and private per-seat data require a separate workflow contract;
all-event scopes skip them explicitly, without changing existing group mail. An event-specific
scope targeting a group event type is refused at save and preview.

Host-written subject and body text use the same `FOLLOW_UP_HOST_NOTES_ENABLED` policy as
follow-up notes, for every workflow recipient class. When false, save/update/preview reject
custom subject/body with `invalid_workflow`; templates permit only built-in localized text
and safe variables. Dispatch rechecks the switch and falls back to built-in text for an
existing custom revision when it is off. Hourmere Cloud MUST keep it false until host
eligibility, recipient consent and complaint controls are reviewed and implemented.
Self-hosted defaults retain the existing true host-notes default; open-signup operators
should set it false. The final workflow default flip does not change this independent
switch or relax the Cloud requirement. Step 11a owns validation and dispatch policy;
step 11b owns safe built-in catalogs, and step 12b tests the live switch recheck.

Templates are plain text with a typed allowlist of variables. Built-in localized wrappers
and templates cover every public locale in `packages/core/src/locales.ts`; administrator
screens cover English and zh-CN. Use recipient profile locale for hosts and the saved
booker locale for attendees, following current notification behavior, with the registry's
fallback. Custom content is explicitly supplied per locale; a missing translation uses
the localized built-in template, never silently inserts English custom text. Preview
shows the selected locale and fallback. No automatic translation service is introduced.

Common variables: recipient's own name, event-type title, scheduled start/end rendered
in recipient's saved zone, zone label, and public booking path when still valid. Personal
host-recipient templates may additionally use the saved booker's scalar answers; personal
booker templates may use that booker's own answers. Other attendees cannot receive them.
No template exposes other attendees' email addresses, management tokens, private calendar
contents, credentials, conference organizer identity or start/retry capabilities. V1
omits meeting URLs, cancellation reasons and free-text booking titles from all workflow
variables. Structured date variables are formatted by code, not arbitrary format strings.

Reject unknown or unauthorized variables at save and preview. Parse placeholders into a
small AST, substitute only plain scalar values, then escape the whole result for the
HTML email wrapper; never interpolate into raw HTML/attributes/styles/URLs. HTML-looking
input displays as text. Reject subject/header CR/LF and invalid Unicode/control characters;
normalize body line endings. Preview and actual rendering use the same renderer, and
stored action payloads never include generated HTML supplied by a user. Apply the byte
limits above after normalization; limit locale-map keys to the shipped public locale
registry, with one value per locale and no arbitrary locale keys. Placeholder parsing is
linear in the bounded input, with no recursion or evaluation. Refuse a rendered subject
above its subject limit or a rendered body above the expansion limit as `render_limit`,
without truncating user content or attempting delivery. Enforce the definition-count cap
on drafts too, under the same owner admission lock.

Webhook POST references an existing endpoint in the same organization, not a URL embedded
in a workflow or a template. Extend the existing signed transactional webhook outbox with
a distinct `workflow.executed` event kind and stable event/delivery IDs; do not manufacture
another `booking.created` subscription event. Only the selected endpoint gets this event.
The existing unique key `(webhook_id, booking_id, event_type)` cannot represent several
workflow executions for one booking. A new migration must keep that uniqueness for
ordinary booking-origin deliveries and add a distinct unique workflow-run/endpoint
identity for workflow-origin rows. Backfill existing rows as booking-origin without
changing their payloads, signatures or receipts; verify populated predecessor, fresh
installation and no-op rerun behavior.
The endpoint must explicitly subscribe to this new event kind and remain active; removal,
rotation, pause, global webhook disablement and private-target policy retain their existing
semantics. Existing endpoint configuration is a prerequisite; steps 13a–13c ship its
missing MCP/CLI mappings. Step 13d owns the additive
`workflow.executed` subscription expansion: `WEBHOOK_EVENTS`, service `eventsOf()` validation `.max(3)`
becoming `.max(WEBHOOK_EVENTS.length)` (4), matching published create/update input bounds, list `Webhook.events`, delivery `eventType`, OpenAPI/generated client,
and existing MCP/CLI inputs and responses. While workflows are off, create/update attempts
to add this kind return `404 workflows_disabled`; existing event kinds still work.
Document response enums as open and tell consumers to ignore unknown events, per
[API conventions](api-conventions.md); update the published webhook payload field list.
The workflow payload has the existing bounded booking ID/time/status projection plus
`workflowId`, `workflowRevision`, `trigger` and stable `workflowRunId`; existing booking
payloads stay unchanged. `WebhookDelivery.bookingId` remains a required UUID, never null
or omitted, including team workflow deliveries. Step 13d verifies an additive OpenAPI diff.
Its new migration expands the existing `webhooks.events` CHECK from three to four allowed
events and cardinality 1–4, with populated-predecessor preservation, fresh-install, no-op
rerun and DB-type checks. Published migration 0017 remains unchanged. Internal subscription
tests may use the enabled context after this migration but insert no workflow deliveries.
Step 13 expands the `webhook_deliveries.event_type` CHECK in its separate outbox migration
before any workflow delivery can be inserted.
Before step 13d, steps 5–6 validate endpoint existence and ownership but reject webhook
action definitions as `invalid_workflow`; 13d enables their subscription validation in
internal tests. Production workflow operations remain hard-off until step 19.

Use the current bounded identifier/time/status payload projection; no custom JSON templates,
answers, names, addresses or location fields. For team workflow payloads omit source and
reschedule predecessor as well, because they are outside the team-admin whitelist. Keep
internal occurrence relationships private. Reuse existing HMAC signing, encrypted secret
storage, retries and URL guard. Validate at configuration and every attempt: public HTTPS
by default, only the existing explicit operator private-target exceptions, all DNS answers
validated and pinned to the socket, no redirects or proxy-variable bypass. A workflow
cannot grant a broader network policy. Endpoint and workflow authorization are checked
inside the same capture/dispatch fences.

## Scheduling, races and delivery guarantees

All due times are UTC instants computed with `Temporal.Instant` elapsed-minute arithmetic.
A day offset is elapsed time, not the same local wall-clock hour tomorrow. DST changes and
recipient display-zone changes cannot change due instants. Test spring gaps, autumn folds,
and different host/booker zones. Booking minimum notice still governs booking acceptance;
it does not make past-due workflow timers eligible. Before-start actions, including webhook
reminders, must satisfy the existing strict reminder gap from booking/reschedule. At or
before that gap, record `minimum_gap`; at or before capture time record `offset_not_future`.

Reschedule transaction retires predecessor timer and delayed-created/rescheduled work,
then creates successor timer rows using the captured definitions and new anchors. This
intentionally differs from Cal.com's documented delay carry-over: a delayed-created message
about an earlier occurrence is not silently repurposed for the successor. Owners can use
`booking.rescheduled` or successor timers for that intent; there is no delayed-created
carry-over in v1. Old jobs
wake only old identities and safely skip. Cancellation retires all unsent before/after and
delayed-created/rescheduled work, then captures its cancellation occurrence. A delayed
cancellation message keeps that cancellation snapshot. Repeated cancellation/idempotent
booking writes cannot create another occurrence. No delivery is triggered by merely
editing a definition or previewing it.

After downtime, dispatch only while `now < due + WORKFLOW_MAX_LATE_MINUTES`; before-start
also requires `now < start`. At equality or beyond, skip permanently as `expired`.
After-end can run late within that bound only after the saved end. A delayed lifecycle
message is also limited by the same bound and current applicability. Budget exhaustion
skips permanently as `budget_suppressed`, without retry storms or catch-up later. Existing
reminders retain their current expiry/retry behavior; the new bound is for workflows only.
For webhook deliveries it bounds the first network attempt only; a delivery first attempted
in time retains the existing roughly seven-hour retry schedule, even beyond due + 60 minutes.
Each retry still checks cancellation, disablement, authority and endpoint policy.

Use durable definition revisions, booking associations, occurrences, per-action executions
and per-recipient intents with database uniqueness; pg-boss jobs carry only opaque row IDs.
Reconciliation recreates missing wakes without recreating intents. Lock in the existing
identity/organization/lifecycle order, use claim tokens and fencing, and recheck authority,
workflow enabled state, booking anchors/status, recipient eligibility and deadline after
waiting. Cancellation/disable serializes with the marker transaction and checks any already
committed dispatch marker (irreversible unless positively known not sent) to determine which operation won. For email,
that marker transaction is the dispatch boundary: a mutation that commits first prevents
the marker and SMTP; an email whose marker commits first may still start or finish SMTP
after cancellation/disable returns. This narrow race cannot recall an already-authorized
dispatch. No workflow-held booking, workflow or budget row lock spans SMTP. Check expiry and live
authority immediately before the marker, after all waits. Test both transaction orders,
including a pause between marker commit and the SMTP call. Webhook delivery retains its
existing endpoint/delivery locking and adds workflow checks without promising SMTP semantics.

For email, a database transaction cannot atomically commit SMTP acceptance. Choose
**at-most-once potentially accepted SMTP attempt**: commit the recipient's reservation and
`dispatching` marker before SMTP. A crash after the marker, or post-DATA timeout with
uncertain acceptance, becomes terminal `delivery_unknown`; replay cannot send again.
A crash between marker and SMTP can lose the message. A positively classified connection,
greeting or authentication failure before envelope acceptance is known not sent: atomically
reverse the marker only with the matching claim token, keep the same intent/reservation and
stable Message-ID, and retry within the due window with bounded backoff. A definitive
permanent SMTP rejection is terminal. Ambiguity never qualifies for reversal. Stale workers
cannot reverse a newer marker; there is never more than one active SMTP attempt per intent.
These safe retries do not consume a second mail allowance or create a second recipient row.
A Message-ID assists diagnostics but is not an SMTP deduplication guarantee. Show unknown
outcomes honestly; preserve existing reminder retry behavior.

Webhooks retain the existing at-least-once transport: retry after an ambiguous outcome can
repeat a POST with the same delivery ID. Receivers must durably deduplicate that ID before
side effects. An absolute no-double-POST claim would contradict the reused transport;
workflow idempotency guarantees one outbox delivery identity, not one network attempt.
History distinguishes accepted HTTP acknowledgement from downstream business completion.

The implementation must establish logical scheduling order, not inbox arrival order:
lifecycle/core booking notification intents must be captured before workflow wakes in
the booking transaction; existing reminders win shared intents.
Core notification workers have reserved execution/SMTP capacity; workflow jobs cannot hold
the core global budget lock during SMTP. Do not make booking mail wait for workflow
completion. Mail can still arrive out of order at a provider; no delivery-order promise.

## Mail budget and capacity

The source-derived defaults below must stay bound to runtime behavior and `.env.example`
by the document test. Host mail is exempt from booking-recipient limits; sign-in uses a
separate purpose hash, but shares the global ledger and host reserve. Current recipient
windows are sliding windows; the global host/sign-in ceiling is `floor(MAIL_MAX_PER_HOUR * 1.2)`.

| Identifier | Value | Kind | Source meaning |
| --- | ---: | --- | --- |
| `MAIL_RECIPIENT_MAX_PER_HOUR` | 5 | env | Default booking recipient hourly allowance. |
| `MAIL_RECIPIENT_MAX_PER_DAY` | 20 | env | Default booking recipient daily allowance. |
| `SIGN_IN_MAIL_MAX_PER_HOUR` | 5 | env | Separate sign-in recipient hourly allowance. |
| `SIGN_IN_MAIL_MAX_PER_DAY` | 20 | env | Separate sign-in recipient daily allowance. |
| `MAIL_MAX_PER_HOUR` | 100 | env | Default core shared instance allowance. |
| `MAIL_HOST_RESERVE_PERCENT` | 120 | literal (documentation label) | Existing host/sign-in ceiling as a percent of the core cap. |
| `MAX_GUESTS` | 10 | constant | Extra attendees permitted on a booking. |
| `MAX_HOSTS` | 8 | literal (documentation label) | Maximum collective assigned hosts. |
| `REMINDER_MAX_RULES` | 5 | literal (documentation label) | Existing per-event reminders. |
| `FOLLOW_UP_MAX_RULES` | 3 | literal (documentation label) | Existing per-event follow-ups. |
| `NOTIFICATION_MIN_OFFSET_MINUTES` | 5 | literal (documentation label) | Existing notification minimum offset. |
| `NOTIFICATION_MAX_OFFSET_MINUTES` | 43200 | literal (documentation label) | Existing notification maximum offset. |
| `DEFAULT_REMINDER_OFFSET_MINUTES` | 1440 | constant member (documentation label) | Legacy default reminder offset. |
| `REMINDER_MIN_GAP_HOURS` | 1 | constant member (documentation label) | Strictly exceeded by before-start due times. |
| `MAIL_LEDGER_WINDOW_HOURS` | 1 | literal (documentation label) | Sliding global ledger reservation window. |

A busy collective type taking ten bookings/hour with the maximum guests and hosts has
`1 + 10 + 8 = 19` potential recipients per booking. Five email workflows with distinct
timing intents could request `10 * 5 * 19 = 950` workflow emails in an hour when their due
times coincide. Even five reminders plus three follow-ups can already request
`10 * (5 + 3) * 19 = 1520` existing optional emails in such a coincident hour, before
confirmation or sign-in mail. These are worst-case demand counts, not promised sends.
Workflow mail counts inside the existing `MAIL_MAX_PER_HOUR` budget, never on top of it.
All attempts share the global sliding 1-hour ledger and atomic admission lock with core
mail. Workflow-purpose rows participate in global counts but use separate recipient hashes
and owner sub-counters so they cannot consume booking/sign-in per-address allowances.

Step 10 introduces nonnegative integer settings `WORKFLOW_MAIL_MAX_PER_HOUR` (default 20)
and `WORKFLOW_OWNER_MAIL_MAX_PER_HOUR` (default 5). Zero disables workflow email for that
sub-cap, not unlimited; webhook actions are unaffected. At positive core cap M, workflow
admission requires both global usage below M and workflow usage below
`min(WORKFLOW_MAIL_MAX_PER_HOUR, floor(MAIL_MAX_PER_HOUR / 5))`, plus owner and recipient
limits. This reserves at least 80% of the base allowance for core booking mail; workflows
cannot use the extra 20% host/sign-in reserve. Core may use unused workflow capacity.
At `MAIL_MAX_PER_HOUR=0` the global budget is unlimited, but both configured workflow
sub-caps and fixed recipient caps still apply; there is no implicit unlimited workflow mode.
Positive M below 5 admits no workflow email. Use the same sliding 1-hour ledger window for
core and workflow admission; owner hourly and recipient hourly/daily windows are sliding too.

At defaults, the effective formula is `min(20, floor(MAIL_MAX_PER_HOUR / 5))`.
Workflow attempts are at most 20/hour inside the base ceiling 100, leaving
`100 - 20 = 80` base slots for core mail and another 20 host/sign-in reserve slots.
The combined ceiling 120 matches today's ceiling of 120, not 140. The documented sizing rule
`1.2 × MAIL_MAX_PER_HOUR` remains valid. The busy owner gets at most 5 workflow attempts/hour
of the 950 demanded: owner 5/h, recipient 1/h and 3/day, including repeated hosts. Four owners
can consume the default 20/hour instance sub-cap; no per-owner slot is guaranteed. These
conservative defaults contain optional-message abuse during rollout; operators of larger
instances can raise the instance and owner settings independently, but a positive core
budget still enforces the 20% workflow ceiling. Recipient caps do not scale with either
setting; their deliberately low host-mail consequence must be visible in configuration
and owner previews. A higher workflow share requires a separate reviewed reserve policy.

Use oldest-due-first admission, a bounded workflow queue/pool and SMTP connection slots
reserved for core workers. Workflow acquisitions of the common budget lock cover only short admission transactions,
never SMTP or waiting for a workflow network connection; existing core lock behavior stays unchanged. Workflow reservations remain in
the shared counts for their window even on ambiguous attempts; deletion cannot reset them.
The reserve guarantees headroom against workflow flooding, not delivery through an SMTP
outage or exhaustion caused by core traffic itself. No additional provider capacity is
required merely to enable workflows under the existing documented sizing rule.

## Permissions, persistence and audit

Personal owners manage only their definitions; team owners/admins manage team definitions.
Require verified identity and current membership, with the same parent locks, late role
recheck and browser organization-context fence used by webhook mutations. A mere assigned
host cannot configure a team workflow. Demoted creators do not own team automations:
the team does; deleting a personal owner removes personal definitions. Team deletion
removes definitions and pending work. Each execution rechecks the owning scope and
recipient host membership. Authorization errors never become “missing configuration.”

API keys need `full` for mutations and preview, `full` or `read` for definitions/history;
`bookings` is insufficient. MCP OAuth retains its current authorized `mcp:tools` model
plus the same live ownership checks. A team-bound `full` key held by a current owner/admin
suffices for configuration; no new permission is introduced and this does not grant access
to the session-only team bookings API. History returned through any interface is metadata-only: workflow ID,
revision, trigger, due/finished timestamps, aggregate outcomes and fixed error codes.
No booking IDs, recipients, payloads, answer values, event source, chain IDs or hidden
condition details appear in workflow history, personal or team; v1 has no per-booking timeline. Templates/previews use synthetic fixtures;
there is no preview-by-booking-ID bypass. Existing webhook delivery lists retain their
published required `bookingId`, which their authorized callers already see for booking
events; this separate existing permission is not broadened by workflow history. Their
MCP/CLI adapters preserve that schema. Do not redact or null this published required field.

Team variables are limited to the relevant subset of the explicit whitelist in
[team-admin-bookings.md](team-admin-bookings.md): event-type title/public path, scheduled
instants, recipient's own attendee name/time zone or host name/public zone. Do not spread
host booking DTOs into templates or webhook payloads. In particular, team admin rights
never authorize answers, free-text title/cancellation reason, source/attribution,
reschedule-chain data, location or conference links. Recipient email addresses are used
internally for delivery and never rendered as template variables or returned in history.

Proposed tables (future migration, not added here): workflow definitions and immutable
revisions; booking workflow snapshots; lifecycle occurrences; action runs and recipient
intents; workflow mail reservations. Use organization-scoped FKs and unique occurrence/
revision/action/recipient identities, with bounded indexes for pending due work and
retention. Deleting a workflow tombstones its identity and disables pending work while
retaining safe history for the stated window. Purging history must not erase replay
protection while a booking, snapshot or job can still reference it: retain minimal
non-content terminal identity tombstones until all such references are retired. No replay
endpoint exists. Booking deletion removes private snapshots and safely retires ID-only
jobs. Never store rendered mail bodies, plaintext endpoint secrets or answer snapshots
in audit/history merely for diagnostics.

Audit log PR [#246](https://github.com/hourmere/hourmere/pull/246) is in review as of the
research date; this design does not assume its schema has landed. Implementation depends
on its accepted shared writer for step 16b completion; do not create a competing audit
store. Earlier steps 5–7 ship an injected no-op audit port with contract/rollback tests if
the writer is unavailable, safe only while hard-off. Step 16b binds the accepted writer
and verifies every event before any production opt-in; no no-op port may survive that gate.
Record `workflow.created`, `workflow.updated`, `workflow.enabled`, `workflow.disabled`,
`workflow.deleted`, `workflow.previewed`, `workflow.run_scheduled`,
`workflow.run_cancelled`, `workflow.run_skipped`, `workflow.email_attempted`,
`workflow.email_sent`, `workflow.email_rejected`, `workflow.email_delivery_unknown`,
`workflow.webhook_queued` and `workflow.webhook_completed`/`workflow.webhook_failed`.
Use actor/scope, workflow/revision identity, fixed reason/outcome and timestamps; background
actors are explicit. Definition changes and scheduling audit records commit with their
transactions; replay cannot duplicate terminal records. No bodies, answers, addresses,
raw URLs or secrets. Retention/access follow the accepted audit policy separately from
workflow history, without widening team data access.

## REST, MCP and CLI contract sketch

All paths below start with `/api/v1`; request schemas are strict and responses open for
additive v1 evolution. Responses use existing envelope/error conventions and cursor lists.
Use `DomainError` with stable codes such as `workflow_not_found`, `workflow_revision_conflict`,
`workflow_limit_reached`, `invalid_workflow` and `workflows_disabled`, mapped through the
shared adapter. Cross-owner lookup returns the normal opaque not-found response.

| REST operation | operationId | MCP tool | CLI command |
| --- | --- | --- | --- |
| GET `/workflows` | `listWorkflows` | `list_workflows` | `workflows list` |
| POST `/workflows` | `createWorkflow` | `create_workflow` | `workflows create` |
| GET `/workflows/{id}` | `getWorkflow` | `get_workflow` | `workflows get` |
| PATCH `/workflows/{id}` | `updateWorkflow` | `update_workflow` | `workflows update` |
| DELETE `/workflows/{id}` | `deleteWorkflow` | `delete_workflow` | `workflows delete` |
| POST `/workflows/preview` | `previewWorkflow` | `preview_workflow` | `workflows preview` |
| GET `/workflows/{id}/runs` | `listWorkflowRuns` | `list_workflow_runs` | `workflows runs` |

Create/list/preview carry explicit `{kind: personal|team, id}` owner scope checked against
the current principal; other operations derive it from the authorized definition. Create
requires a retained client idempotency key; same normalized input replays the result,
changed input conflicts. Update requires the expected revision and a partial definition;
`enabled: false` disables and `enabled: true` enables. Delete uses expected revision and
is idempotent within retained identity. Preview accepts a candidate definition plus
synthetic example values, returns rendered text and escaped HTML, matched/skipped reasons
and static budget estimates derived only from the candidate and published limits; never
instance-wide or other-owner usage. It performs no email or webhook call. No write sends immediately.

Keep OpenAPI operation IDs, generated web client types, API-key policy registry, MCP tool
schemas, CLI help/JSON behavior and interface-parity mappings in the same change as each
operation. [The parity script](../scripts/interface-parity.ts) covers **every** new v1
POST/PUT/PATCH/DELETE, including public and preview endpoints. Its browser exemption
requires exactly one security requirement with only `session: []`; these workflow
operations support agents and do not qualify. No new parity gap entry is acceptable.
The web app calls only the generated `/api/v1` client, never a service import, native
side-channel or undocumented endpoint. UI work starts after its operations exist.

Existing webhook endpoint create/update/delete/rotate writes gain MCP/CLI parity before
workflow webhook actions can be configured through every supported interface. Preserve
the existing endpoint limits and existing route rate-limit middleware; no bypass or
higher request allowance is introduced for workflows.

## Rollout and limitations

[Release tags can select main commits](../.github/workflows/release.yml), so an environment
flag is not a sufficient barrier for incomplete work. Step 1 introduces the source constant
`WORKFLOWS_IMPLEMENTED = false` checked at service entry, handler, UI and execution
boundaries. Hard-off means behavior, not registration: every workflow operation returns
`404 workflows_disabled`, including reads, disable and delete, until step 19. No environment
value overrides it. Routes/OpenAPI, tool implementations, CLI commands, parity mappings and
scope-registry rows ship in each operation's owning step. MCP `tools/list` omits workflow
tools while off; direct known-tool calls return the same `404 workflows_disabled` domain
error (MCP error result and CLI error output), rather than an unknown-tool protocol error.

Build the parity inventory with the feature enabled through internal dependency injection,
following `loadInterfaceInventory()` in `scripts/interface-parity.ts`, which already passes
`slotSnippetsEnabled: true`. This inventory-only construction must not bypass production
hard-off. From each owning step, generated API-key scope tables on the live site
`apps/site/src/content/docs/docs/api-keys.md` and `mcp.md`, generated from
`packages/auth/src/api-key-operations.ts`, list workflow operations. Regenerate all scope
tables in that same step, and add adjacent prose documenting them as disabled until enabled.
OpenAPI and CLI help likewise list them with that warning. The docs index must say that
listed interfaces may precede feature availability. Steps 13a–13c update webhook/MCP/CLI
guides as their existing webhook tools become usable; do not defer those guides to step 18b.

Only after the complete stack exists may step 19 set the constant true and introduce
`WORKFLOWS_ENABLED` default false. Write `.env.example` as `WORKFLOWS_ENABLED=` with a
comment that empty means the server default, and document that in `configuration.md`.
Operator-off refuses creation, preview, enabling and all edits (including renames) with
`404 workflows_disabled`, and stops new capture/dispatch. Definition/history reads,
disable-only updates and deletion remain available for recovery. MCP discovery while off
omits workflow tools; authorized direct recovery calls remain usable after step 19 only.
Pending runs become terminally skipped only when they wake due while off; future runs are
not eagerly swept. Re-enabling never revives skipped work, but future not-yet-due rows remain
eligible. Existing reminders continue. Final acceptance changes the default to true;
explicit false stays supported and an environment copied from step 19 picks up the flip.
Cloud and self-hosting have identical workflow capabilities without paid gating, with the
independent host-text policy and configurable operator mail sub-caps described above.

Out of scope: SMS, WhatsApp, AI calls, arbitrary HTTP methods/bodies, attachments, billing,
marketing campaigns, arbitrary recipient lists, OR/path builders, loops, multiple action
chains, attendance inference, historical bulk execution, manual resend, retroactive rule
edits and automatic legacy conversion. Delayed-created messages are retired on reschedule, unlike the cited Cal.com example.
Custom subject/body text is unavailable while host notes are disabled. SMTP can lose an
ambiguous message under the chosen at-most-once potentially accepted attempt policy; webhook receivers must deduplicate. Shared SMTP-provider quotas remain
an operator concern. Limits can suppress optional messages on busy event types. History
is metadata only, and team workflows intentionally support fewer conditions and variables.

## Implementation plan

Each row is approximately one working day, including its focused tests. Dependencies
refer only to earlier rows; work that does not fit that budget must be split before
construction. These are implementation steps, not shipped capabilities. The workflow operation
inventory above and existing webhook prerequisites below are exhaustive for this version; “none” means no new transport operation.
Every listed write ships its REST/OpenAPI operation, MCP registration, CLI command,
scope registry and interface-parity mapping in that same step. All reads also ship the
three interfaces together. The web app uses only the regenerated `/api/v1` client.

“Hard-off” means every workflow operation returns `404 workflows_disabled` and a source
constant denies capture/execution in every process; no environment setting can bypass it. Tests inject dependencies into internal
services without exposing a production override. Existing reminder/webhook services stay
available. Read-only history and disable/delete remain usable under the later operator-off
state; creation, enabling, preview, all edits except disable-only, and new execution are refused.
Each transport-owning row below includes same-step generated scope tables and disabled
prose, OpenAPI/client, CLI help and enabled-inventory parity, as defined in Rollout.

| Step (about one day) | Dependencies | Work and owned REST / MCP / CLI operations | Rollout state | Concrete acceptance |
|---|---|---|---|---|
| 1. Pure definition contract | None | None. Introduce WORKFLOWS_IMPLEMENTED=false and behavioral guards, then strict schemas, AND evaluation, ownership selectors, template variable catalog and pinned limits. | Hard-off | Unknown fields/operators rejected; absent answers false; cross-owner IDs rejected; imported/group/no-show cases fail closed. |
| 2. Definition storage | 1 | None. New migration for definitions and immutable revisions; select next available migration number at implementation time. | Hard-off | Populated predecessor upgrade preserves reminders and booking snapshots; fresh install equivalent; rerun no-op; generated DB types match. |
| 3. Execution storage | 2 | None. New migration for enrollments, due runs, per-recipient claims and minimal history and workflow mail reservations; indexed cleanup. | Hard-off | Unique constraints kill concurrent duplicate capture; deletion/retention cannot revive a dispatch; predecessor/fresh/no-op upgrade tests. |
| 4. Definition reads | 2 | `GET /api/v1/workflows` (`listWorkflows`) / `list_workflows` / `workflows list`; `GET /api/v1/workflows/{id}` (`getWorkflow`) / `get_workflow` / `workflows get`. | Hard-off | Full/read scope and current owner/admin checks; foreign IDs and team-context changes reveal no data; additive OpenAPI responses and generated client. |
| 5. Create definitions | 4 | `POST /api/v1/workflows` (`createWorkflow`) / `create_workflow` / `workflows create`. Include audit creation port (no-op under hard-off until 16b); reject webhook actions until 13d. | Hard-off | Creation replay returns same definition; changed replay conflicts; concurrent all-event/per-event admissions enforce combined cap; full-only writes; parity check passes. |
| 6. Edit, enable and disable | 3, 5 | `PATCH /api/v1/workflows/{id}` (`updateWorkflow`) / `update_workflow` / `workflows update`. Include audit update/enable/disable port; reject webhook actions until 13d. | Hard-off | Expected-revision conflicts; fixture pending claims are fenced on disable; re-enable does not backfill; new revisions do not overwrite booking enrollments. (End-to-end sends are tested in 12b.) |
| 7. Delete and retirement | 3, 6 | `DELETE /api/v1/workflows/{id}` (`deleteWorkflow`) / `delete_workflow` / `workflows delete`. Include audit delete port and retention behavior. | Hard-off | Repeated authorized delete safe; fixture claims retire and cannot be reacquired; history remains minimal; no cross-tenant existence leaks. |
| 8a. Creation capture and intents | 3, 7 | None. Native confirmed creation hooks, immutable enrollments and reminder/workflow intent ordering. | Hard-off | Rollback creates no run; duplicate capture coalesces; hold-confirm captures once; hold-expire/release creates nothing; imported/group bookings remain silent. |
| 8b. Cancellation and reschedule capture | 8a | None. Cancellation and successor hooks with occurrence identities. | Hard-off | Reschedule emits neither a second created nor an actual-cancel trigger; cancellation replay coalesces; successor retains timer revisions; delayed-created work retires explicitly. |
| 9a. Timer calculations | 8b | None. Pure UTC due-time and expiration rules. | Hard-off | Before/after start/end anchors, minimum-gap equality, spring/fall DST and non-hour shifts; late-bound equality; retired delayed-created messages never transfer to successors. |
| 9b. Dispatcher and repair | 9a | None. Bounded due claims, fences and missing-wake repair. | Hard-off | Cancel/reschedule/disable/delete while claim waits; racing worker cannot reclaim retired work; repair preserves unique identity; no late first attempt. |
| 10. Shared mail admission and sub-caps | 3 | None. Shared global ledger/lock, workflow purpose hashes and instance/owner settings; use reservations migrated in 3. Document new settings in .env.example and configuration.md. | Hard-off | Last-slot races across core/workflow workers admit once; workflow flood leaves reserved core headroom; small/zero caps and sliding windows; deletion cannot reset budget; close pools below CI ceiling. |
| 11a. Safe email renderer and text policy | 6 | None. Bounded escaped interpolation and FOLLOW_UP_HOST_NOTES_ENABLED policy in save/update and shared candidate validator (preview endpoint integrates in 15). | Hard-off | Hostile HTML/header/control inputs inert; unauthorized variables rejected; switch off rejects custom subject/body in save/update and candidate-validator fixtures, including host recipients; built-ins remain valid. |
| 11b. Localized built-in catalogs | 11a | None. Templates for every shipped public locale and fixture snapshots. | Hard-off | Locale fallback is built-in; plain-text/HTML snapshots; no sibling contacts, capabilities or unauthorized team fields; self-hosted/Cloud defaults documented. |
| 12a. Email attempt and retry state machine | 9b, 10, 11b | None. Marker commit, fenced known-not-sent reversal and terminal ambiguity. | Hard-off | Connection/greeting/auth failure retries same reservation/intent; stale token cannot reverse marker; post-DATA ambiguity and crash never create a second potentially accepted attempt; bounded backoff expires. |
| 12b. Email lifecycle race integration | 12a | None. Integrate live eligibility, policy and lifecycle rechecks with fake SMTP. | Hard-off | Overlapping reminder intent wins without duplicate send; cancel-before-marker sends nothing; marker-first permits only its authorized attempt; disable/delete races; live host-text switch falls back to built-ins; no shared budget lock across workflow SMTP. |
| 13a. Webhook discovery and creation parity | 4 | Existing `GET /api/v1/webhooks` (`listWebhooks`) / `list_webhooks` / `webhooks list`; existing `POST /api/v1/webhooks` (`createWebhook`) / `create_webhook` / `webhooks create`. Update webhook/MCP/CLI guides now. | Hard-off for workflow event kind | Full/read discovery, full-only create; current owner/admin checks; one-time secret returned only on creation; CLI JSON/help and parity mapping; existing event kinds unchanged. |
| 13b. Webhook edit and retirement parity | 13a | Existing `PATCH /api/v1/webhooks/{id}` (`updateWebhook`) / `update_webhook` / `webhooks update`; existing `DELETE /api/v1/webhooks/{id}` (`deleteWebhook`) / `delete_webhook` / `webhooks delete`. Update webhook/MCP/CLI guides now. | Hard-off for workflow event kind | Pause after URL policy removal; immutable URL and permission tests; deletion race; parity gaps removed without changing unrelated gaps. |
| 13c. Webhook rotation and history parity | 13b | Existing `POST /api/v1/webhooks/{id}/rotate-secret` (`rotateWebhookSecret`) / `rotate_webhook_secret` / `webhooks rotate-secret`; existing `GET /api/v1/webhooks/{id}/deliveries` (`listWebhookDeliveries`) / `list_webhook_deliveries` / `webhooks deliveries`. Update webhook/MCP/CLI guides now. | Hard-off for workflow event kind | Rotation exposes secret once with no CLI logging; current authorization and secret rotation races; safe paginated metadata; full/read read scope and full-only rotation. |
| 13d. Existing webhook subscription API expansion | 6, 13c | Extend createWebhook/updateWebhook/listWebhooks/listWebhookDeliveries across REST/OpenAPI, MCP and CLI with workflow.executed; update WEBHOOK_EVENTS, service .max(3) and published input bounds; add a new webhooks.events CHECK/cardinality migration with populated/fresh/no-op preservation and DB types; regenerate client and webhook/MCP/CLI guides. Enable webhook-action validation in workflow create/update internal tests. | Hard-off for workflow event kind | New kind returns 404 workflows_disabled while off; other kinds work; additive OpenAPI diff; required bookingId remains UUID; open-enum compatibility note and payload fields published; missing/inactive/cross-owner subscription rejected. |
| 13. Webhook outbox extension | 9b, 13d | None. Extend signed delivery identity/payload schema and webhook_deliveries.event_type CHECK for workflow-origin records without changing existing booking subscriptions. | Hard-off | New origin-aware uniqueness migration preserves populated predecessor data, matches fresh install and reruns as no-op; two workflow runs targeting one endpoint retain distinct identities; duplicate capture coalesces; transactional rollback; signatures verified with fake receiver; payload contains no new booking personal fields. |
| 14. Webhook delivery fences | 13 | None. Reuse guarded transport and bounded delivery repair; add workflow cancellation/disable and expiration checks. | Hard-off | DNS rebinding, redirects, forbidden/private targets and policy removal refused; endpoint pause/rotation race; first attempt expires at due+60min but timely-started delivery retries beyond that bound with same ID and receiver dedupe; no real outbound calls. |
| 15. Synthetic preview | 11b, 14 | `POST /api/v1/workflows/preview` (`previewWorkflow`) / `preview_workflow` / `workflows preview`. | Hard-off | Only synthetic examples; no booking lookup, mail, DNS or webhook call; same validation/rendering as execution; estimates reveal only static candidate limits, no instance usage; full scope and parity mapping. |
| 16a. Workflow history interfaces | 12b, 14 | `GET /api/v1/workflows/{id}/runs` (`listWorkflowRuns`) / `list_workflow_runs` / `workflows runs`. | Hard-off | Stable cursor pages; safe codes; personal/team workflow history omit booking IDs and private details; existing webhook lists preserve required bookingId; retention never removes live dedupe. |
| 16b. Accepted audit writer integration | 15, 16a | None. Replace earlier no-op audit port with accepted shared writer; wait here if unavailable. | Hard-off | All declared lifecycle/definition events covered; transactional rollback and exact replay; redacted actor/scope metadata; production opt-in cannot use no-op writer. |
| 17. Configuration UI | 7, 15 | None; calls list/get/create/update/delete/preview from steps 4–7 and 15 through generated client. | Hard-off | jsdom create/edit/disable/delete and stale revision/context tests; English/zh-CN strings; loading/403/error are neutral; keyboard/mobile acceptance; no raw fetch or alternate server path. |
| 18a. History UI | 16b, 17 | None; calls history from 16a through generated client. | Hard-off | jsdom pagination and suppression/unknown outcomes; neutral empty/loading/error states; no inbox-delivery claim; English/zh-CN strings and scoped data. |
| 18b. Complete operating documentation | 18a | None. Consolidate workflow UI/REST/MCP/CLI guides, mail settings/reserve, host-text policy, reschedule divergence and limitations; preserve earlier operation-level docs. | Hard-off | Examples use published operations; SMTP sizing remains 1.2 × MAIL_MAX_PER_HOUR; Cloud host text stays off; owner/recipient limits explicit; all public template locales complete. |
| 19. Complete-stack opt-in | 18b | None. Replace hard-off constant only after creation, edit, disable/delete, both execution paths and history exist; introduce operator setting default false, .env.example WORKFLOWS_ENABLED= (empty means server default), and configuration.md entry. | Operator-off by default | Default release cannot capture/send; explicit opt-in exercises full end-to-end fakes; only due wakes skip while off; future rows survive a short stop; recovery reads/disable/delete work; all roles agree on setting; no self-hosting paywall. |
| 20. Final acceptance and default enablement | 19 | None. Acceptance PR changes operator default to true, retains explicit false emergency stop, and updates operating docs. | Default true only after acceptance | Copied step-19 .env picks up true while explicit false stays off; host-text switch unchanged; author-side review plus project-lead acceptance; concurrency/replay/reschedule/cancel/DST and crash negative controls; separate Biome/typecheck/full tests/build/Docker/API types gates; required CI green, browser tests run with approved environment; rollback runbook reviewed. |

The future audit writer dependency is a prerequisite for step 16b completion, not a
claim that its currently reviewed implementation is already on main. If it is still
unavailable, retain hard-off and do not proceed to opt-in. No workflow operation qualifies
for a browser-session-only parity exemption. No send-test, replay-run, conversion,
export or no-show mutation endpoint is introduced by this plan. Existing webhook
secret rotation receives agent parity; it does not introduce a second endpoint.
