# Booking workflows design

Status: proposed design, not a shipped feature. This change adds no product code,
migration or interface strings. Decisions below are Hourmere decisions unless explicitly
attributed to another product. Existing reminders and follow-ups remain available.

## Evidence and existing foundations

Official help checked on 2026-11-06:

- [Calendly: create an Automation](https://calendly.com/help/how-to-create-an-automation)
  describes choosing a template or custom automation, selecting a trigger and timing,
  and automated email/text reminders and follow-ups. Its current help calls these
  Automations, although older links use Workflows.
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
constants. They bound fan-out, storage and understandability; operators cannot raise them
until a separately reviewed capacity design changes the contract.

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
| `WORKFLOW_INSTANCE_EMAILS_PER_HOUR` | 20 | Dedicated workflow instance allowance before scaling down. |
| `WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR` | 5 | Scale positive core caps down before applying the workflow ceiling. |
| `WORKFLOW_OWNER_EMAILS_PER_HOUR` | 5 | Dedicated personal-owner or team allowance. |
| `WORKFLOW_RECIPIENT_EMAILS_PER_HOUR` | 1 | Dedicated normalized-address allowance, including hosts. |
| `WORKFLOW_RECIPIENT_EMAILS_PER_DAY` | 3 | Dedicated normalized-address allowance, including hosts. |
| `WORKFLOW_HISTORY_DAYS` | 30 | Visible run history and scheduled metadata retention after terminal state. |

## Triggers, conditions and snapshots

| Trigger | Capture and timing |
| --- | --- |
| `booking.created` | Once for an original committed native booking. |
| `booking.cancelled` | Once for explicit cancellation; not for a reschedule predecessor. |
| `booking.rescheduled` | Once for a committed successor, with a private internal link to the predecessor. |
| `before_start` | Start instant minus positive whole-minute offset. |
| `after_end` | Scheduled end instant plus positive whole-minute offset; no attendance assertion. |

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
reschedule-trigger definitions. It does not capture new created-trigger definitions.
Disable/delete always overrides snapshots and prevents future dispatch. Re-enabling never
revives terminal/skipped work. Imported bookings and their reschedule chains are excluded,
matching existing import silence.

| Condition | Rationale and comparison |
| --- | --- |
| Event type equals | Restrict an all-event workflow to one stable event-type ID. |
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
all-event scopes skip them explicitly, without changing existing group mail.

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
semantics. Existing endpoint configuration is a prerequisite; adding workflow types to its
writes must ship its missing MCP/CLI mappings in the same implementation change.

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
then creates successor timer rows using the captured definitions and new anchors. Old jobs
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

Use durable definition revisions, booking associations, occurrences, per-action executions
and per-recipient intents with database uniqueness; pg-boss jobs carry only opaque row IDs.
Reconciliation recreates missing wakes without recreating intents. Lock in the existing
identity/organization/lifecycle order, use claim tokens and fencing, and recheck authority,
workflow enabled state, booking anchors/status, recipient eligibility and deadline after
waiting. Cancellation/disable serializes with the marker transaction and checks any already
committed irreversible dispatch marker to determine which operation won. For email,
that marker transaction is the dispatch boundary: a mutation that commits first prevents
the marker and SMTP; an email whose marker commits first may still start or finish SMTP
after cancellation/disable returns. This narrow race cannot recall an already-authorized
dispatch. No booking, workflow or budget row lock spans SMTP. Check expiry and live
authority immediately before the marker, after all waits. Test both transaction orders,
including a pause between marker commit and the SMTP call. Webhook delivery retains its
existing endpoint/delivery locking and adds workflow checks without promising SMTP semantics.

For email, a database transaction cannot atomically commit SMTP acceptance. Existing mail
receipts reduce ordinary retries but cannot prove exactly-once external delivery across a
crash. To meet the workflow no-duplicate-on-job-retry requirement, choose **at-most-once
SMTP attempt**: commit each recipient's budget reservation and irreversible `dispatching`
marker before calling SMTP. A crash or ambiguous timeout after that marker becomes terminal
`delivery_unknown`; neither worker replay nor manual retry may send that intent again.
A crash between marker and SMTP can lose the message. Pre-marker transient failures can
retry within the due window; definitive SMTP rejection is terminal in this first version.
A stable Message-ID assists diagnostics but is not a deduplication guarantee. Show unknown
outcomes honestly in history. This policy is new for workflows and must not silently
change existing reminder delivery behavior.

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

| Identifier | Value | Source meaning |
| --- | ---: | --- |
| `MAIL_RECIPIENT_MAX_PER_HOUR` | 5 | Default booking recipient hourly allowance. |
| `MAIL_RECIPIENT_MAX_PER_DAY` | 20 | Default booking recipient daily allowance. |
| `SIGN_IN_MAIL_MAX_PER_HOUR` | 5 | Separate sign-in recipient hourly allowance. |
| `SIGN_IN_MAIL_MAX_PER_DAY` | 20 | Separate sign-in recipient daily allowance. |
| `MAIL_MAX_PER_HOUR` | 100 | Default core shared instance allowance. |
| `MAIL_HOST_RESERVE_PERCENT` | 120 | Existing host/sign-in ceiling as a percent of the core cap. |
| `MAX_GUESTS` | 10 | Extra attendees permitted on a booking. |
| `MAX_HOSTS` | 8 | Maximum collective assigned hosts. |
| `REMINDER_MAX_RULES` | 5 | Existing per-event reminders. |
| `FOLLOW_UP_MAX_RULES` | 3 | Existing per-event follow-ups. |
| `NOTIFICATION_MIN_OFFSET_MINUTES` | 5 | Existing notification minimum offset. |
| `NOTIFICATION_MAX_OFFSET_MINUTES` | 43200 | Existing notification maximum offset. |
| `DEFAULT_REMINDER_OFFSET_MINUTES` | 1440 | Legacy default reminder offset. |
| `REMINDER_MIN_GAP_HOURS` | 1 | Strictly exceeded by before-start due times. |

A busy collective type taking ten bookings/hour with the maximum guests and hosts has
`1 + 10 + 8 = 19` potential recipients per booking. Five email workflows with distinct
timing intents could request `10 * 5 * 19 = 950` workflow emails in an hour when their due
times coincide. Even five reminders plus three follow-ups can already request
`10 * (5 + 3) * 19 = 1520` existing optional emails in such a coincident hour, before
confirmation or sign-in mail. These are worst-case demand counts, not promised sends.
Simply putting workflows into the current ledger could exhaust the invitee ceiling of
100 and host/sign-in ceiling of 120. A lower workflow cap sharing that ledger still steals
some existing capacity and therefore does not establish non-starvation.

Create a disjoint workflow ledger and purpose hash. Workflow reservations count against
all three workflow limits (instance, owner/team, normalized recipient including hosts),
never against core instance or booking/sign-in recipient counters. Core counters must
explicitly exclude workflow purpose; do not infer that from recipient hashes alone. The
workflow instance allowance is `min(20, floor(MAIL_MAX_PER_HOUR / 5))` when the configured
core cap is positive; when it is zero (unlimited core), workflows remain capped at 20.
A positive core cap below five consequently admits no workflow email. No borrowing in
either direction. At defaults this adds at most 20 workflow attempts/hour while preserving
the original 100 invitee/120 host-and-sign-in allowance: the possible combined ceiling is
140, not 100. Document this compatibility change in operator configuration before enablement.

For that single busy owner, the owner allowance admits at most five workflow attempts/hour,
and repeated host addresses admit at most one each/hour and three/day. Other owners share
the remaining instance allowance fairly through oldest-due-first admission; there is no
promise every owner gets a slot. An ambiguous attempt consumes its reservation. Use a
separate short database budget lock and bounded pool/queue for workflow jobs, releasing
it before SMTP; isolate SMTP connections and reserve core worker capacity so workflow
backlogs cannot occupy every mail sender. Operators must provision the additional SMTP
capacity; upstream SMTP-wide outages and provider quotas cannot be eliminated by local
accounting. “Never starve” means workflows consume none of the existing Hourmere core
budgets or reserved dispatch capacity, not guaranteed delivery during provider failure.

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
plus the same live ownership checks. Team workflow configuration via agents is a new
explicit narrow configuration permission; it does not grant access to the session-only
team bookings API. History returned through any interface is metadata-only: workflow ID,
revision, trigger, due/finished timestamps, aggregate outcomes and fixed error codes.
No booking IDs, recipients, payloads, answer values, event source, chain IDs or hidden
condition details appear in team history. Templates/previews use synthetic fixtures;
there is no preview-by-booking-ID bypass. The existing webhook delivery-list operation
must also omit `bookingId` for team workflow-origin rows, including its MCP/CLI adapters.
Keep ordinary booking-origin delivery fields compatible. Test both history entry points
so a caller cannot recover forbidden workflow booking identities through endpoint history.

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
on its accepted shared writer, or waits for it; do not create a competing audit store.
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
and budget estimates, and performs no email or webhook call. No write sends immediately.

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
flag is not a sufficient barrier for incomplete work. Start with a source-code constant
`WORKFLOWS_IMPLEMENTED = false` checked at all route/tool registration, service entry,
UI and execution boundaries. No environment value overrides it. Intermediate migrations
may safely exist dormant, but cannot capture or dispatch work.

Only after creation, editing, enabling/disabling, deletion, execution and history are
complete across authorized interfaces and the UI may a completion change set the constant
true and introduce `WORKFLOWS_ENABLED` with default false. Operator-off refuses creation, editing, enabling, preview and new capture/dispatch,
and terminally skips pending runs. Definition/history reads, disabling and deleting remain
available for recovery; enabling does not revive skipped work. Existing reminders continue. Publish website configuration guidance, mail budgets,
privacy, SMTP ambiguity and workflow limitations with the feature, for all deployments.
Final acceptance alone changes the operator default to true, with an explicit false still
supported. Self-hosters receive exactly the same feature and limits, without paid gating.

Out of scope: SMS, WhatsApp, AI calls, arbitrary HTTP methods/bodies, attachments, billing,
marketing campaigns, arbitrary recipient lists, OR/path builders, loops, multiple action
chains, attendance inference, historical bulk execution, manual resend, retroactive rule
edits and automatic legacy conversion. SMTP can lose an ambiguous message under the chosen
at-most-once policy; webhook receivers must deduplicate. Shared SMTP-provider quotas remain
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

“Hard-off” means a source constant denies configuration and capture/execution in every
process; no environment setting can bypass it. Tests inject dependencies into internal
services without exposing a production override. Existing reminder/webhook services stay
available. Read-only history and disable/delete remain usable under the later operator-off
state; creation, enabling, editing for execution and new execution are refused.

| Step (about one day) | Dependencies | Work and owned REST / MCP / CLI operations | Rollout state | Concrete acceptance |
|---|---|---|---|---|
| 1. Pure definition contract | None | None. Strict schemas, AND evaluation, ownership selectors, template variable catalog and pinned limits. | Hard-off | Unknown fields/operators rejected; absent answers false; cross-owner IDs rejected; imported/group/no-show cases fail closed. |
| 2. Definition storage | 1 | None. New migration for definitions and immutable revisions; select next available migration number at implementation time. | Hard-off | Populated predecessor upgrade preserves reminders and booking snapshots; fresh install equivalent; rerun no-op; generated DB types match. |
| 3. Execution storage | 2 | None. New migration for enrollments, due runs, per-recipient claims and minimal history; indexed cleanup. | Hard-off | Unique constraints kill concurrent duplicate capture; deletion/retention cannot revive a dispatch; predecessor/fresh/no-op upgrade tests. |
| 4. Definition reads | 2 | `GET /api/v1/workflows` (`listWorkflows`) / `list_workflows` / `workflows list`; `GET /api/v1/workflows/{id}` (`getWorkflow`) / `get_workflow` / `workflows get`. | Hard-off | Full/read scope and current owner/admin checks; foreign IDs and team-context changes reveal no data; additive OpenAPI responses and generated client. |
| 5. Create definitions | 4 | `POST /api/v1/workflows` (`createWorkflow`) / `create_workflow` / `workflows create`. Include audit creation adapter. | Hard-off | Creation replay returns same definition; changed replay conflicts; concurrent all-event/per-event admissions enforce combined cap; full-only writes; parity check passes. |
| 6. Edit, enable and disable | 5 | `PATCH /api/v1/workflows/{id}` (`updateWorkflow`) / `update_workflow` / `workflows update`. Include audit update/enable/disable. | Hard-off | Expected-revision conflicts; disable fences pending claims; re-enable does not backfill; new revisions do not overwrite booking enrollments; overlapping reminder intent wins without a duplicate send. |
| 7. Delete and retirement | 6 | `DELETE /api/v1/workflows/{id}` (`deleteWorkflow`) / `delete_workflow` / `workflows delete`. Include audit delete and retention behavior. | Hard-off | Repeated authorized delete safe; racing worker cannot reclaim retired not-yet-dispatched work; history remains minimal; no cross-tenant existence leaks. |
| 8. Lifecycle capture | 3, 7 | None. Booking create/cancel/reschedule transactional hooks and enrollment rules. | Hard-off | Rollback creates no run; replay and concurrent captures create one run; reschedule emits neither a second created nor an actual-cancel trigger; imported/group bookings remain silent. |
| 9. Timers and repair | 8 | None. UTC due times, predecessor fencing, bounded dispatcher and downtime decisions. | Hard-off | Before/after start/end anchors, minimum-gap equality, DST spring/fall and non-hour shifts; cancel/reschedule while claim waits; catch-up boundary and missing-job recovery. |
| 10. Isolated mail accounting | 3 | None. Workflow-only ledger, conservative reservations, resource isolation and caps. | Hard-off | Parallel last-slot claims admit once; workflow flood leaves existing sign-in/booking capacity unchanged; configured small/zero core cap tested; deletion cannot reset windows; every pool closes below CI connection ceiling. |
| 11. Localized email renderer | 1 | None. Built-in templates and bounded escaped text interpolation for each permitted recipient. | Hard-off | All shipped public locales; hostile HTML/header/control inputs inert; no sibling contacts, answers, management capabilities or unauthorized team fields; plain-text and HTML snapshots. |
| 12. Email dispatch | 9, 10, 11 | None. Commit-before-SMTP dispatch fence, permanent unknown outcome on ambiguous attempts. | Hard-off | Crash before/after SMTP and receipt-commit failure never invoke SMTP twice for a recipient; definite suppression recorded; cancel-before-marker sends nothing, marker-before-cancel permits only the committed attempt; lifecycle recheck; no shared budget lock held during workflow network I/O. |
| 13a. Webhook discovery and creation parity | 4 | Existing `GET /api/v1/webhooks` (`listWebhooks`) / `list_webhooks` / `webhooks list`; existing `POST /api/v1/webhooks` (`createWebhook`) / `create_webhook` / `webhooks create`. | Hard-off for workflow event kind | Full/read discovery, full-only create; current owner/admin checks; one-time secret returned only on creation; CLI JSON/help and parity mapping; existing event kinds unchanged. |
| 13b. Webhook edit and retirement parity | 13a | Existing `PATCH /api/v1/webhooks/{id}` (`updateWebhook`) / `update_webhook` / `webhooks update`; existing `DELETE /api/v1/webhooks/{id}` (`deleteWebhook`) / `delete_webhook` / `webhooks delete`. | Hard-off for workflow event kind | Pause after URL policy removal; immutable URL and permission tests; deletion race; parity gaps removed without changing unrelated gaps. |
| 13c. Webhook rotation and history parity | 13b | Existing `POST /api/v1/webhooks/{id}/rotate-secret` (`rotateWebhookSecret`) / `rotate_webhook_secret` / `webhooks rotate-secret`; existing `GET /api/v1/webhooks/{id}/deliveries` (`listWebhookDeliveries`) / `list_webhook_deliveries` / `webhooks deliveries`. | Hard-off for workflow event kind | Rotation exposes secret once with no CLI logging; current authorization and secret rotation races; safe paginated metadata; full/read read scope and full-only rotation. |
| 13. Webhook outbox extension | 9, 13c | None. Extend signed delivery identity/payload schema for workflow-origin records without changing existing booking subscriptions. | Hard-off | New origin-aware uniqueness migration preserves populated predecessor data, matches fresh install and reruns as no-op; two workflow runs targeting one endpoint retain distinct identities; duplicate capture coalesces; transactional rollback; signatures verified with fake receiver; payload contains no new booking personal fields. |
| 14. Webhook delivery fences | 13 | None. Reuse guarded transport and bounded delivery repair; add workflow cancellation/disable and expiration checks. | Hard-off | DNS rebinding, redirects, forbidden/private targets and policy removal refused; endpoint pause/rotation race; same delivery ID on retry and receiver dedupe; no real outbound calls. |
| 15. Synthetic preview | 11, 14 | `POST /api/v1/workflows/preview` (`previewWorkflow`) / `preview_workflow` / `workflows preview`. | Hard-off | Only synthetic examples; no booking lookup, mail, DNS or webhook call; same validation/rendering as execution; full scope and parity mapping. |
| 16. History reads and audit integration | 12, 14 | `GET /api/v1/workflows/{id}/runs` (`listWorkflowRuns`) / `list_workflow_runs` / `workflows runs`. Integrate accepted audit writer contract when available. | Hard-off | Stable cursor pages; redacted safe codes; team agents receive no booking-detail projection in workflow history or existing endpoint delivery lists; transactional audit rollback and exact replay; expiry never removes dedupe before eligibility ends. |
| 17. Configuration UI | 7, 15 | None; calls list/get/create/update/delete/preview from steps 4–7 and 15 through generated client. | Hard-off | jsdom create/edit/disable/delete and stale revision/context tests; English/zh-CN strings; loading/403/error are neutral; keyboard/mobile acceptance; no raw fetch or alternate server path. |
| 18. History UI and documentation | 16, 17 | None; calls history from step 16. Update website guides, REST/MCP/CLI examples, self-hosting budget changes and limitations together. | Hard-off | jsdom pagination, suppression/unknown outcomes, empty/loading/error states; no claim of inbox delivery; scoped data shown consistently; translated admin text and public-template catalogs complete. |
| 19. Complete-stack opt-in | 18 | None. Replace hard-off constant only after creation, edit, disable/delete, both execution paths and history exist; introduce operator setting default false. | Operator-off by default | Default release cannot capture/send; explicit opt-in exercises full end-to-end fakes; disabling stops pending dispatch while retaining history and retirement controls; all roles agree on setting; no self-hosting paywall. |
| 20. Final acceptance and default enablement | 19 | None. Acceptance PR changes operator default to true, retains explicit false emergency stop, and updates operating docs. | Default true only after acceptance | Author-side review plus project-lead acceptance; concurrency/replay/reschedule/cancel/DST and crash negative controls; separate Biome/typecheck/full tests/build/Docker/API types gates; required CI green, browser tests run with approved environment; rollback runbook reviewed. |

The future audit writer dependency is a prerequisite for step 16 completion, not a
claim that its currently reviewed implementation is already on main. If it is still
unavailable, retain hard-off and do not proceed to opt-in. No workflow operation qualifies
for a browser-session-only parity exemption. No send-test, replay-run, conversion,
export or no-show mutation endpoint is introduced by this plan. Existing webhook
secret rotation receives agent parity; it does not introduce a second endpoint.
