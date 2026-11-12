# Booking workflows design

Status: proposed design, not a shipped feature. Step 1 of the plan has added the pure
definition contract in `packages/workflows` behind the hard-off constant, step 2 the
definition and revision tables (migration 0076) and step 3 the execution tables (migration
0079), which nothing reads or writes yet; no interface or interface string exists yet. Decisions below are Hourmere decisions unless explicitly
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
[reschedule requests](../apps/site/src/content/docs/docs/request-reschedule.md),
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

The following limits are source constants in `packages/workflows/src/limits.ts`, and the
document test binds each number here to its constant. The definition contract enforces the
structural ones; later steps enforce the rest where their behavior lives. They bound
fan-out, storage and understandability. Structural and recipient
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

Capture runs inside the same `BookingNotifier` call that notifications and webhooks receive,
and only for its `created`, `rescheduled` and `cancelled` events. `BookingEvent` on main
also has `reschedule_requested` and `reschedule_request_expired`. Those two capture no
workflow and create no occurrence. They neither retire, recalculate nor postpone timers or
delayed work: the booking stays confirmed while a request is pending, and its reminders
stay in effect ([reschedule requests](../apps/site/src/content/docs/docs/request-reschedule.md)).
An invitee's pick is an ordinary reschedule (a `rescheduled` event for the successor,
handled below), and a cancellation from the request is an ordinary `cancelled` event. V1
offers no workflow trigger for reschedule requests.
`pending_payment` holds capture no workflows or timers. Successful paid confirmation
captures `booking.created` exactly once at confirmation, with timer anchors at the booked
instants; payment release or `expired` holds emit no `booking.cancelled` workflow.

Attendee no-show marking is on main (migration 0070,
[no-shows](../apps/site/src/content/docs/docs/no-shows.md)). A host marks or unmarks one
attendee after the scheduled start in the dashboard or through REST, MCP or CLI, and
webhooks can subscribe to `booking.attendee_no_show_changed`. The change does not pass
through `BookingNotifier`: `setAttendeeNoShow` calls a separate `AttendeeNoShowNotifier`,
which only webhook capture implements. V1 workflows treat it as follows:

- `booking.attendee_no_show_changed` is not a workflow trigger. The marker is private host
  metadata: invitee pages, public booking responses and emails never show it, and marking
  sends no email. A workflow email sent because of a mark would disclose that judgment to
  the invitee. A mark also belongs to one attendee and can be undone, while a workflow
  occurrence belongs to a booking lifecycle. Integrations that need the change subscribe to
  the signed webhook directly. A later trigger needs its own contract: per-attendee
  occurrence identity, an unmark and re-mark policy, a privacy review of invitee-facing
  mail, and team access, because team owners and admins who do not host the booking can
  mark only through a browser session.
- Workflows register nothing on `AttendeeNoShowNotifier`, and a mark or unmark changes no
  workflow run. As with follow-ups, an `after_end` workflow still runs for a marked
  attendee. No condition or template variable reads the marker. Do not infer absence from
  conference-provider attendance either.

So the booking webhook kinds on main that are not workflow triggers are
`booking.reschedule_requested`, `booking.reschedule_request_expired` and
`booking.attendee_no_show_changed`.

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
Disable and delete always override snapshots and prevent dispatch, but at different times.
Disabling one definition is lazy, like the operator switch below: it changes no execution
row and stops new capture for that definition. A pending run that the dispatcher claims
while its definition is disabled ends permanently as `workflow_disabled`. Re-enabling never
revives terminal or skipped work; runs not yet claimed stay eligible, so a brief toggle loses
only the runs claimed during it. The editor states this when disabling. Deletion is
eager: the deleting transaction retires every pending run of that definition. Imported
bookings and their reschedule chains are excluded, matching existing import silence.

| Condition | Rationale and comparison |
| --- | --- |
| Event type equals | Equivalent to an event-specific scope; retained as an explicit AND predicate for editor consistency. |
| Booking source equals | Personal only; exact existing stored source enum, never caller-supplied inference. |
| Attendee answer equals | Personal only; booker's saved answer for a stable question ID of a select or checkbox question, exact typed scalar equality. |
| Location kind equals | Personal only; fixed location discriminator, never URL/text matching. |
| Guest count equals/at least/at most | Number of non-booker attendees saved on this booking, inclusive integer comparison. |

Conditions are AND only, with no nesting, OR, regex, scripts or network lookups. Multiple
workflows can express alternatives but still consume the same cap and intent deduplication.
Missing/deleted questions and unknown values fail closed; arrays/free-text searching are
unsupported. Answer predicates are only allowed for a single personal event type so the
question schema is unambiguous. They compare select and checkbox questions only, and a
checkbox `equals false` matches only a stored false. The public booking form always submits
an unticked box as false, but API and MCP callers may omit an optional checkbox, and an
omitted answer matches neither true nor false. Team definitions reject source, answer and
location predicates, including in preview: boolean matching and skip history can leak
hidden data.
Evaluate against the captured occurrence snapshot, then recheck live eligibility,
ownership and lifecycle before dispatch. A booking whose event type was deleted after the
definition was saved is never matched, at capture or at dispatch. This differs from
reminders, which do not check whether the event type was deleted.
A failed condition records only `condition_false`, not the value or predicate index.
Cancelled snapshots intentionally remain eligible for cancellation actions; they never
revive before/after actions.

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
switch or relax the Cloud requirement. Step 11a owns validation and the renderer's
built-in fallback that dispatch uses; step 11b owns safe built-in catalogs, and step 12b
integrates and tests the live switch recheck at dispatch.

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

The catalog in `packages/workflows/src/variables.ts` names these placeholders; the document
test binds this table to it. Every other name is unknown, including any attendee no-show
marker.

| Placeholder | Value | Allowed for |
| --- | --- | --- |
| `{{recipient.name}}` | Recipient's own name | Every workflow and recipient class |
| `{{recipient.time_zone}}` | Recipient's saved zone label | Every workflow and recipient class |
| `{{event_type.title}}` | Event-type title | Every workflow and recipient class |
| `{{event_type.public_path}}` | Public booking path while still valid | Every workflow and recipient class |
| `{{booking.start}}` | Scheduled start in the recipient's saved zone | Every workflow and recipient class |
| `{{booking.end}}` | Scheduled end in the recipient's saved zone | Every workflow and recipient class |
| `{{answer.<questionId>}}` | Booker's saved scalar answer | Personal workflows of one event type whose recipients exclude other attendees |

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

The webhook baseline on main comes from migration 0070 (attendee no-shows), which last
redefined both event CHECKs; the delivery key is still the one 0064 added:

- `WEBHOOK_EVENTS` has 6 kinds: `booking.created`, `booking.rescheduled`,
  `booking.cancelled`, `booking.reschedule_requested`, `booking.reschedule_request_expired`
  and `booking.attendee_no_show_changed`.
- Service `eventsOf()` already validates `.max(WEBHOOK_EVENTS.length)`.
- 0070's `webhooks_events_check` is `cardinality(events) BETWEEN 1 AND 6` over those kinds,
  and its `webhook_deliveries_event_type_check` allows the same set. 0070 only widened both
  constraints; 0017 created them and 0064 replaced them before.
- Deliveries are unique by
  `UNIQUE NULLS NOT DISTINCT (webhook_id, booking_id, event_type, request_id)`, which 0064
  added and 0070 left unchanged. `request_id` is a plain `uuid` without a foreign key, and
  it has two uses. Request-origin rows carry the reschedule request's ID. Attendance rows
  carry a fresh per-change receipt ID, so every mark or unmark gets its own delivery; that
  value never appears as `data.requestId`. Booking-origin rows leave it NULL.

That key cannot represent several workflow executions for one booking and endpoint. Step
14a's new outbox migration follows 0064's `request_id` pattern. It adds a nullable
`workflow_run_id uuid` with no foreign key, like `request_id`, and replaces the key with
`UNIQUE NULLS NOT DISTINCT (webhook_id, booking_id, event_type, request_id, workflow_run_id)`.
Workflow rows get their own column instead of reusing `request_id` as attendance rows do,
so each column keeps a meaning the schema can check. A CHECK requires `workflow_run_id`
exactly on `workflow.executed` rows, and another forbids a row carrying both `request_id`
and `workflow_run_id`. No existing row is rewritten or
backfilled: booking-origin rows (both columns NULL), request-origin rows and attendance
rows (`request_id` set) keep their uniqueness, payloads, signatures and receipts. The same
migration replaces 0070's `webhook_deliveries.event_type` CHECK, extending it from the
6 current kinds to 7, before any workflow delivery can be inserted. Postgres infers an
`ON CONFLICT` arbiter only from the exact column set, so step 14a also moves the existing
capture's conflict target in `packages/webhooks/src/delivery.ts` from the four columns to
the five. Booking and request duplicate capture must still coalesce, and each attendance
change must still get its own delivery. Verify a populated predecessor that includes
request-origin and attendance rows, fresh installation and a no-op rerun.

The endpoint must explicitly subscribe to this new event kind and remain active; removal,
rotation, pause, global webhook disablement and private-target policy retain their existing
semantics. Existing endpoint configuration is a prerequisite; steps 13a–13c ship its
missing MCP/CLI mappings. Steps 13d and 13e own the additive `workflow.executed`
subscription expansion:

- Step 13d appends `workflow.executed` to `WEBHOOK_EVENTS`, which goes from 6 to 7 kinds.
  `eventsOf()` keeps `.max(WEBHOOK_EVENTS.length)` and gains no literal. The published
  create/update request schemas keep no `maxItems`, as today; the bound stays in
  `eventsOf()`. Its new migration replaces 0070's `webhooks.events` CHECK
  (`webhooks_events_check`) with `cardinality(events) BETWEEN 1 AND 7` over the extended
  set. Tests cover a populated predecessor with endpoints subscribed to the request and
  attendance kinds, fresh install, no-op rerun and DB types. Published migrations 0017,
  0064 and 0070 remain unchanged. The route schemas build their enums from
  `WEBHOOK_EVENTS`, so 13d also regenerates OpenAPI and the client, and verifies an
  additive OpenAPI diff.
- Step 13e updates the interfaces and guides: list `Webhook.events`, delivery `eventType`,
  MCP/CLI inputs, outputs and help, the webhook/MCP/CLI guides and the published payload
  field list. Document response enums as open and tell consumers to ignore unknown events,
  per [API conventions](api-conventions.md). The request kinds and the attendance kind were
  appended to the same published enums, and the webhook guide already tells consumers to
  ignore unknown event types; 13e extends that note to the workflow kind.

Existing subscriptions that include `booking.attendee_no_show_changed` keep working
unchanged. No stored `events` array is rewritten or expanded: as with the attendance kind,
an endpoint receives `workflow.executed` only after it subscribes explicitly. The bound of 7
lets an endpoint already subscribed to all 6 current kinds add the workflow kind. The
`workflows_disabled` check below concerns only adding `workflow.executed`, so keeping,
adding or removing the attendance kind behaves as today. An attendance change never emits
`workflow.executed`, and a workflow never emits the attendance kind.

Zapier, n8n and Make do not offer `workflow.executed` in v1. The kind reaches only the
endpoint that a workflow action selects by ID, but the Zapier and n8n triggers create their
endpoint on activation and delete it on deactivation, so a definition could not keep
pointing at it. Until step 20, a default instance also refuses the kind as
`workflows_disabled`, so an integration offering it would fail to activate. Two integration
tests bind to `WEBHOOK_EVENTS`, so step 13d, which appends the kind, updates them in the
same change:

- `tools/n8n-nodes-hourmere/contract.test.ts` requires the trigger's `EVENTS` to equal
  `WEBHOOK_EVENTS` and the generated OpenAPI subscription enum.
- `scripts/make-template-validation.test.ts` requires a notifier capture and a README and
  site table row for every `WEBHOOK_EVENTS` kind.

Both then compare against `WEBHOOK_EVENTS` without `workflow.executed`, through one explicit
exclusion of that kind, so a later booking kind still fails them until its integration is
updated. Each test applies its exclusion at every binding site: the n8n test also removes
the workflow kind from the generated OpenAPI subscription enum before comparing it with
`EVENTS`, and the Make test uses the reduced list for its captures and both tables. The n8n
trigger's `EVENTS` and translations, and the Make recipes and tables, stay unchanged; the
n8n signature check already rejects a delivery whose type is not in `EVENTS`. Zapier needs
no change: its triggers are a fixed subset, and its contract test validates requests against
the generated OpenAPI, where the extra enum value is additive. Step 13e says in the Zapier,
n8n and Make guides that they do not offer the workflow kind.

Internal webhook tests that subscribe an endpoint to every kind would add
`workflow.executed` and get `404 workflows_disabled` while workflows are off:
`packages/webhooks/src/delivery.test.ts` and `packages/webhooks/src/no-show.test.ts`. Step
13d makes them subscribe to the booking kinds only, or use the enabled context.

While workflows are off, a create or update whose resulting event set adds
`workflow.executed` to an endpoint not already subscribed returns `404 workflows_disabled`.
Keeping or removing an existing subscription is allowed, and other kinds still work. For
create, the check runs with event validation, before the destination policy and the existing
`409 webhooks_disabled` check, so `workflows_disabled` wins when both apply. For update, it
compares the requested set with the row locked by `lockedWebhook()` and runs before the
destination recheck. Update has no `webhooks_disabled` check today and gains none.

The workflow payload has the existing bounded booking ID/time/status projection plus
`workflowId`, `workflowRevision`, `trigger` and stable `workflowRunId`, never `requestId`;
existing booking, request and attendance payloads stay unchanged.
`WebhookDelivery.bookingId` remains a required UUID, never null or omitted, including team
workflow deliveries. Internal
subscription tests may use the enabled context after 13d but insert no workflow deliveries
before 14a. Before step 13d, steps 5–6 validate endpoint existence and ownership but
reject webhook action definitions as `invalid_workflow`; 13d enables their subscription
validation in internal tests. Production workflow operations remain hard-off until step 19b.

Use the current bounded identifier/time/status payload projection; no custom JSON templates,
answers, names, addresses or location fields. Team workflow payloads also omit source and
reschedule predecessor. The same endpoint may already receive both on `booking.*` events;
the omission keeps workflow payloads within the team variable whitelist below and is a
deliberate minimum, not a claim that the endpoint lacks that access. Keep
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
Step 8a's pure functions compute due instants and both outcomes before any capture exists;
capture in steps 8b and 8c applies them when it creates rows, and dispatch rechecks expiry.

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
stable Message-ID, and retry within the due window with bounded backoff. Each retry first
re-admits its reservation and restamps its ledger row (see Mail budget). A definitive
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
| `NOTIFICATION_RETRY_LIMIT` | 12 | job option (documentation label) | Core booking-notification job retries after an SMTP failure. |
| `NOTIFICATION_RETRY_DELAY_SECONDS` | 60 | job option (documentation label) | First retry delay; each later delay doubles. |
| `NOTIFICATION_RETRY_MAX_DELAY_SECONDS` | 3600 | job option (documentation label) | Largest single retry delay. |

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

Workflow charges are recorded in `notification_email_sends`, the table that core admission
already counts, not in a separate ledger. Each admitted workflow attempt inserts two rows in
one short admission transaction under the shared `lockNotificationEmailBudget` lock:

- one `notification_email_sends` row with a workflow-purpose recipient hash and
  `workflow_reservation_id` set;
- one workflow mail reservation row holding the owner, run and recipient intent.

Step 3's migration adds the nullable `workflow_reservation_id` column without a foreign key,
so deleting a workflow, booking or team never removes a charge. Existing rows stay NULL,
core inserts are unchanged, and the existing two-day purge still applies. The unchanged core
queries therefore count workflow rows in the global hour. Booking and sign-in recipient
counts filter by their own purpose hash, so workflow rows never consume those per-address
allowances. The workflow instance count is the rows with `workflow_reservation_id` set in
the same sliding hour. The owner count joins the reservations, and the workflow recipient
counts use the workflow-purpose hash.

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
The combined ceiling 120 matches today's ceiling of 120, not 140. These figures hold because
workflow rows live in the shared table. Workflow admission needs the global count, core and
workflow rows together, below 100. Core invitee mail stops when that same count reaches 100,
and host and sign-in mail when it reaches 120. So each workflow row takes one of the first
100 slots, at most 20 such rows exist in any sliding hour, and no row of any kind is admitted
at or beyond 120. The documented sizing rule
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

A known-not-sent SMTP retry (see Scheduling) re-admits under the same lock rather than
relying on its first stamp. It recounts every window without its own ledger row. If the
attempt is still admitted, it moves that row's `sent_at` and the reservation's timestamp
to the retry instant; otherwise it ends as `budget_suppressed`. A retry never adds a second
ledger row. Core mail inserts its ledger row inside its SMTP transaction. A workflow
attempt is stamped in the admission transaction committed just before SMTP, and is
restamped on each retry. So an attempt's charge never ages out of the sliding hour before
it reaches SMTP, and the sizing rule holds up to that admission-to-SMTP latency.

Workflow email has no long retry. An SMTP outage longer than the 60-minute late bound
(`WORKFLOW_MAX_LATE_MINUTES`) ends every workflow email whose window closes during the
outage as `expired`. Core booking-notification mail retries 12 times, from one minute,
doubling, capped at one hour: about seven hours in total. This is a listed limitation.

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

Migration 0076 (step 2) adds workflow definitions and their immutable revisions; see
[workflow definition storage](data-model.md#workflow-definition-storage). Migration 0079
(step 3) adds the execution tables: enrollments (the booking workflow snapshots, one per
booking, lifecycle occurrence and workflow), due runs, per-recipient claims that hold the
recipient intents, minimal run history and workflow mail reservations, plus the nullable
`notification_email_sends.workflow_reservation_id` without a foreign key; see
[workflow execution storage](data-model.md#workflow-execution-storage). The remaining proposed
column on an existing table is `webhook_deliveries.workflow_run_id` (step 14a), nullable and
without a foreign key.
Use organization-scoped FKs and unique occurrence/
revision/action/recipient identities, with bounded indexes for pending due work and
retention. Deleting a workflow tombstones its identity and disables pending work while
retaining safe history for the stated window. Purging history must not erase replay
protection while a booking, snapshot or job can still reference it: retain minimal
non-content terminal identity tombstones until all such references are retired. The execution
rows are those tombstones: they name the workflow and revision without a foreign key to the
definition and hold no content, so purging a tombstoned definition with its revisions keeps
them until their booking or organization goes, and a purge waits until the workflow has no
unfinished run. History retention deletes only the history records. No replay
endpoint exists. Booking deletion removes private snapshots and safely retires ID-only
jobs. Never store rendered mail bodies, plaintext endpoint secrets or answer snapshots
in audit/history merely for diagnostics.

Audit log PR [#246](https://github.com/hourmere/hourmere/pull/246) is open as of the
research date and may merge before or after any workflow step; this design does not assume
its schema. Every workflow step emits through an injected audit port that this design
defines, so no step before 16b depends on #246, and no competing audit store is created.
Event ownership:

- Steps 5–7 emit the definition events (`workflow.created`, `workflow.updated`,
  `workflow.enabled`, `workflow.disabled`, `workflow.deleted`) as they add those operations.
- Step 15b alone wires every execution and preview event into the port: capture (8b, 8c),
  dispatch (9), email (12a, 12b), webhook (14a, 14b) and preview (15a). It retrofits those
  paths inside the transactions named below and tests them with a recording fake port.
- Step 16b binds the port to the accepted shared writer from #246, or whichever audit
  writer main has by then, for definition and preview events. Step 16c binds the execution
  events and closes the no-op path, so no production wiring can select it.

If no accepted writer is on main when step 16b starts, stop there: keep hard-off and do not
proceed to opt-in. The no-op port is safe only while hard-off and must not survive step 16c.
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

The web app learns availability from instance discovery. Step 4 adds an optional boolean
`workflowsEnabled` to the existing public `GET /api/v1/instance` response, next to
`followUpHostNotesEnabled` and `slotSnippetsEnabled`, and documents it as false until
workflows are enabled. It reports the constant and the operator switch together: false
while hard-off, then the value of `WORKFLOWS_ENABLED` from step 19b. Step 19a computes it
from the injected operator state. Clients treat an absent field as false. The web app
(steps 17a and 17b) shows workflow navigation and the editor only when it is true. Its
editor hides custom subject/body fields when `followUpHostNotesEnabled` is false. Under operator-off, recovery
reads, disable and delete stay available through REST, MCP and CLI; the web app offers no
separate recovery view in v1.

## Rollout and limitations

[Release tags can select main commits](../.github/workflows/release.yml), so an environment
flag is not a sufficient barrier for incomplete work. Step 1 introduces the source constant
`WORKFLOWS_IMPLEMENTED = false` checked at service entry, handler, UI and execution
boundaries. Hard-off means behavior, not registration: every workflow operation returns
`404 workflows_disabled`, including reads, disable and delete, until step 19b. No environment
value overrides it. Routes/OpenAPI, tool implementations, CLI commands, parity mappings and
scope-registry rows ship in each operation's owning step. MCP `tools/list` omits workflow
tools while off; direct known-tool calls return the same `404 workflows_disabled` domain
error (MCP error result and CLI error output), rather than an unknown-tool protocol error.

That MCP behavior differs from the slot-snippet precedent. When disabled, slot snippets
leave their tools out of `productTools()`, so a direct call gets the SDK's "Tool … not found"
protocol error. Workflow tools are always included in `productTools()`. Step 4 extends the
catalog/visible split in `registerTools()` (`apps/server/src/mcp/tools.ts`) with a
feature predicate. Today that split keeps a tool the API key does not allow out of the
visible registry, but in `catalog`, so a direct call still reaches `runTool`. With the
predicate, workflow tools also stay out of the visible registry while workflows are
unavailable, and a direct call reaches the tool, whose service returns
`workflows_disabled`. Scope refusals keep their existing precedence.

Build the parity inventory with the feature enabled in effect: registration never depends
on the constant or the operator switch. So `loadInterfaceInventory()` in
`scripts/interface-parity.ts` sees every workflow route, tool and command without the
`slotSnippetsEnabled: true` style of option that slot snippets need. The other catalogue
consumers that call `productTools()` with `slotSnippetsEnabled: true` see them too and need
no new option: `apps/server/src/capability-contracts.test.ts`,
`apps/server/src/mcp/scopes.test.ts` and `apps/server/src/mcp/schema-contracts.test.ts`.
No inventory-only construction exists that could bypass production hard-off. From each
owning step, generated API-key scope tables on the live site
`apps/site/src/content/docs/docs/api-keys.md` and `mcp.md`, generated from
`packages/auth/src/api-key-operations.ts`, list workflow operations. Regenerate all scope
tables in that same step, and add adjacent prose documenting them as disabled until enabled.
OpenAPI and CLI help likewise list them with that warning. The docs index must say that
listed interfaces and forwarded Compose settings may precede feature availability. Steps
13a–13c update webhook/MCP/CLI guides as their existing webhook tools become usable; do not
defer those guides to step 18b. Step 13a, the first to add webhook MCP/CLI operations, also
rewrites the sentence "Webhook management is REST-only" wherever it appears:
`apps/site/src/content/docs/docs/webhooks.md`, `apps/site/src/content/docs/docs/n8n.md` and
`tools/n8n-nodes-hourmere/README.md`.

Operator settings reach Compose installs through the explicit `environment:` list in
`docker-compose.yml`; there is no `env_file`, and the worker inherits the list through
`extends` in `docker-compose.worker.yml`. `scripts/compose-env.test.ts` requires Compose to
forward every `loadConfig` input. Every workflow setting is forwarded with an empty default,
never `:-false` or a number, so that empty means the server default:

- Step 10 adds `WORKFLOW_MAIL_MAX_PER_HOUR` and `WORKFLOW_OWNER_MAIL_MAX_PER_HOUR` to
  `loadConfig` and forwards them as `${WORKFLOW_MAIL_MAX_PER_HOUR:-}` and
  `${WORKFLOW_OWNER_MAIL_MAX_PER_HOUR:-}`. They have no effect while hard-off, so step 10
  adds no `.env.example` line or `configuration.md` row for them.
- Step 19b adds `WORKFLOWS_ENABLED` (default false) and forwards it as
  `${WORKFLOWS_ENABLED:-}`. The repository convention `:-false` would pin every Compose
  install off after the step-20 flip. Step 19b also writes all three settings in
  `.env.example` as empty assignments (`WORKFLOWS_ENABLED=`, `WORKFLOW_MAIL_MAX_PER_HOUR=`
  and `WORKFLOW_OWNER_MAIL_MAX_PER_HOUR=`), with a comment that empty means the server
  default. It adds their `configuration.md` rows, which state that the mail settings apply
  only while workflows are enabled.

Only after the complete stack exists may step 19b set the constant true and introduce
`WORKFLOWS_ENABLED` default false. Step 19a first implements the operator-off state behind
the still-false constant, through an internal injected setting. Operator-off refuses
creation, preview, enabling and all edits (including renames) with
`404 workflows_disabled`, and stops new capture/dispatch. Definition/history reads,
disable-only updates and deletion remain available for recovery. MCP discovery while off
omits workflow tools; authorized direct recovery calls remain usable after step 19b only.
Pending runs become terminally skipped as `instance_disabled` only when they are claimed
while off; future runs are not eagerly swept. Re-enabling never revives skipped work, but future
not-yet-due rows remain eligible. Disabling one definition is lazy in the same way, with
`workflow_disabled`. Existing reminders continue. Step 19b rewrites the docs index
known-limitation line to say workflows are available but off by default. Final acceptance
(step 20) changes the default to true and updates that line again. Explicit false stays
supported; an environment copied from step 19b, or a Compose install with the empty
forward, picks up the flip. Cloud and self-hosting have an identical workflow feature set
without paid gating. Hourmere Cloud runs the independent host-text switch off, as described
above, and each operator configures the mail sub-caps.

Out of scope: SMS, WhatsApp, AI calls, arbitrary HTTP methods/bodies, attachments, billing,
marketing campaigns, arbitrary recipient lists, OR/path builders, loops, multiple action
chains, attendance inference, historical bulk execution, manual resend, retroactive rule
edits, automatic legacy conversion, triggers on reschedule requests or attendee no-show
changes, and workflow triggers in Zapier, n8n or Make. Delayed-created
messages are retired on reschedule, unlike the cited Cal.com example.
Custom subject/body text is unavailable while host notes are disabled. SMTP can lose an
ambiguous message under the chosen at-most-once potentially accepted attempt policy; webhook
receivers must deduplicate. An SMTP outage longer than 60 minutes expires the workflow
email due in it, while core mail retries for about seven hours. Shared SMTP-provider quotas
remain an operator concern. Limits can suppress optional messages on busy event types.
History is metadata only, and team workflows intentionally support fewer conditions and
variables. Under operator-off, recovery uses REST, MCP or CLI rather than the web app.

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
| 1. Pure definition contract | None | None. Introduce WORKFLOWS_IMPLEMENTED=false and behavioral guards, then strict schemas, AND evaluation, ownership selectors, template variable catalog, pinned limits and the injected audit port interface. | Hard-off | Unknown fields/operators rejected; absent answers false; cross-owner IDs rejected; imported/group cases fail closed; a no-show trigger, condition or variable is rejected as unknown. |
| 2. Definition storage | 1 | None. New migration for definitions and immutable revisions; select next available migration number at implementation time. | Hard-off | Populated predecessor upgrade preserves reminders and booking snapshots; fresh install equivalent; rerun no-op; generated DB types match. |
| 3. Execution storage | 2 | None. New migration for enrollments, due runs, per-recipient claims, minimal history and workflow mail reservations, plus nullable `notification_email_sends.workflow_reservation_id` without a foreign key; indexed cleanup. | Hard-off | Unique constraints kill concurrent duplicate capture; deletion/retention cannot revive a dispatch; existing ledger rows keep NULL and core count queries are unchanged; predecessor/fresh/no-op upgrade tests. |
| 4. Definition reads and availability signals | 2 | `GET /api/v1/workflows` (`listWorkflows`) / `list_workflows` / `workflows list`; `GET /api/v1/workflows/{id}` (`getWorkflow`) / `get_workflow` / `workflows get`. Add optional `workflowsEnabled` to existing `GET /api/v1/instance`; add the workflow feature predicate to the `registerTools()` catalog/visible split. | Hard-off | Full/read scope and current owner/admin checks; foreign IDs and team-context changes reveal no data; `tools/list` omits workflow tools while a direct call returns 404 workflows_disabled; `/instance` reports false; additive OpenAPI responses and generated client. |
| 5. Create definitions | 4 | `POST /api/v1/workflows` (`createWorkflow`) / `create_workflow` / `workflows create`. Emit the creation audit event through the port (no-op under hard-off until 16b); reject webhook actions until 13d. | Hard-off | Creation replay returns same definition; changed replay conflicts; concurrent all-event/per-event admissions enforce combined cap; full-only writes; parity check passes. |
| 6. Edit, enable and disable | 3, 5 | `PATCH /api/v1/workflows/{id}` (`updateWorkflow`) / `update_workflow` / `workflows update`. Emit update/enable/disable audit events through the port; reject webhook actions until 13d. | Hard-off | Expected-revision conflicts; with fixture execution rows, disable and re-enable change only the definition row and never write, retire or backfill an execution row; new revisions do not overwrite booking enrollments. (Wake-time skips are tested in 9; end-to-end sends in 12b.) |
| 7. Delete and retirement | 3, 6 | `DELETE /api/v1/workflows/{id}` (`deleteWorkflow`) / `delete_workflow` / `workflows delete`. Emit the deletion audit event through the port; retention behavior. | Hard-off | Repeated authorized delete safe; storage-state invariant: the deleting transaction marks every pending fixture run of the definition retired, and no retired row can return to pending; history remains minimal; no cross-tenant existence leaks. (Claim races are tested in 9.) |
| 8a. Timer calculations | 1 | None. Pure UTC due-time, minimum-gap, capture-time and expiration rules used by capture and dispatch. | Hard-off | Before/after start/end anchors; minimum_gap and offset_not_future equality; spring/fall DST and non-hour shifts; late-bound equality. |
| 8b. Creation capture and intents | 3, 7, 8a | None. Native confirmed creation hooks on the `created` notifier event, immutable enrollments, due rows from 8a, and reminder/workflow intent ordering. | Hard-off | Rollback creates no run; duplicate capture coalesces; hold-confirm captures once; hold-expire/release creates nothing; imported/group bookings remain silent; minimum_gap and offset_not_future recorded at capture. |
| 8c. Cancellation, reschedule and request-event capture | 8b | None. Cancellation and successor hooks with occurrence identities; `reschedule_requested` and `reschedule_request_expired` notifier events capture nothing; workflows register nothing on `AttendeeNoShowNotifier`. | Hard-off | Reschedule emits neither a second created nor an actual-cancel trigger; cancellation replay coalesces; successor retains timer revisions; delayed-created work retires and never transfers to the successor; request and request-expiry events create no occurrence and leave pending runs and wakes unchanged, and so does marking or unmarking an attendee as a no-show; a pick captures as an ordinary reschedule and a request cancellation as an ordinary cancellation. |
| 9. Dispatcher and repair | 8c | None. Bounded due claims, fences, lazy definition-disable check at wake and missing-wake repair. | Hard-off | Cancel/reschedule/disable/delete while claim waits; a claim while its definition is disabled ends as workflow_disabled, and re-enabling before the claim dispatches within the late bound; racing worker cannot reclaim retired work; a pending reschedule request or a no-show mark neither delays nor skips a due run; repair preserves unique identity; no late first attempt. |
| 10. Shared mail admission and sub-caps | 3 | None. Shared global ledger/lock and workflow-purpose hash; admission inserts the workflow-linked `notification_email_sends` row and the reservation row in one transaction; retry re-admission restamps that row; instance/owner settings in loadConfig with Compose `${…:-}` forwards and no .env.example or configuration.md entry yet. | Hard-off | Unchanged core queries count workflow rows; last-slot races across core/workflow workers admit once; workflow flood leaves 80 core and 20 reserve slots; re-admission excludes its own row, adds none and suppresses when full; small/zero caps and sliding windows; deletion cannot reset budget; Compose forwards both with empty defaults; close pools below CI ceiling. |
| 11a. Safe email renderer and text policy | 6 | None. Bounded escaped interpolation and FOLLOW_UP_HOST_NOTES_ENABLED policy in save/update, the shared candidate validator and the renderer's built-in fallback used by dispatch (preview endpoint integrates in 15a). | Hard-off | Hostile HTML/header/control inputs inert; unauthorized variables rejected; switch off rejects custom subject/body in save/update and candidate-validator fixtures, including host recipients; the renderer falls back to built-in text for a stored custom revision when the switch is off; built-ins remain valid. |
| 11b. Localized built-in catalogs | 11a | None. Templates for every shipped public locale and fixture snapshots. | Hard-off | Locale fallback is built-in; plain-text/HTML snapshots; no sibling contacts, capabilities or unauthorized team fields; self-hosted/Cloud defaults documented. |
| 12a. Email attempt and retry state machine | 9, 10, 11b | None. Marker commit, fenced known-not-sent reversal with re-admission, and terminal ambiguity. | Hard-off | Connection/greeting/auth failure retries the same reservation/intent after re-admission, with one ledger row; stale token cannot reverse marker; post-DATA ambiguity and crash never create a second potentially accepted attempt; bounded backoff expires at due + 60 minutes during a longer outage. |
| 12b. Email lifecycle race integration | 12a | None. Integrate live eligibility, policy and lifecycle rechecks with fake SMTP. | Hard-off | Overlapping reminder intent wins without duplicate send; cancel-before-marker sends nothing; marker-first permits only its authorized attempt; disable/delete races; live host-text switch falls back to built-ins; no shared budget lock across workflow SMTP. |
| 13a. Webhook discovery and creation parity | 4 | Existing `GET /api/v1/webhooks` (`listWebhooks`) / `list_webhooks` / `webhooks list`; existing `POST /api/v1/webhooks` (`createWebhook`) / `create_webhook` / `webhooks create`. Update webhook/MCP/CLI guides now, including the "Webhook management is REST-only" sentence in `apps/site/src/content/docs/docs/webhooks.md`, `apps/site/src/content/docs/docs/n8n.md` and `tools/n8n-nodes-hourmere/README.md`. | Hard-off for workflow event kind | Full/read discovery, full-only create; current owner/admin checks; one-time secret returned only on creation; CLI JSON/help and parity mapping; existing event kinds unchanged. |
| 13b. Webhook edit and retirement parity | 13a | Existing `PATCH /api/v1/webhooks/{id}` (`updateWebhook`) / `update_webhook` / `webhooks update`; existing `DELETE /api/v1/webhooks/{id}` (`deleteWebhook`) / `delete_webhook` / `webhooks delete`. Update webhook/MCP/CLI guides now. | Hard-off for workflow event kind | Pause after URL policy removal; immutable URL and permission tests; deletion race; parity gaps removed without changing unrelated gaps. |
| 13c. Webhook rotation and history parity | 13b | Existing `POST /api/v1/webhooks/{id}/rotate-secret` (`rotateWebhookSecret`) / `rotate_webhook_secret` / `webhooks rotate-secret`; existing `GET /api/v1/webhooks/{id}/deliveries` (`listWebhookDeliveries`) / `list_webhook_deliveries` / `webhooks deliveries`. Update webhook/MCP/CLI guides now. | Hard-off for workflow event kind | Rotation exposes secret once with no CLI logging; current authorization and secret rotation races; safe paginated metadata; full/read read scope and full-only rotation. |
| 13d. Webhook subscription kind and migration | 6, 13c | Existing createWebhook/updateWebhook accept workflow.executed: append it to WEBHOOK_EVENTS (6 to 7 kinds; eventsOf keeps .max(WEBHOOK_EVENTS.length); no maxItems added); workflows_disabled check with event validation; new migration replaces the 0070 webhooks.events CHECK with cardinality BETWEEN 1 AND 7 over the extended set; regenerate OpenAPI and client. Update the integration tests that bind to WEBHOOK_EVENTS, `tools/n8n-nodes-hourmere/contract.test.ts` and `scripts/make-template-validation.test.ts`, to exclude workflow.executed explicitly at every binding site, including the n8n OpenAPI enum comparison; the n8n EVENTS, Make tables and Zapier app stay unchanged. Internal webhook tests that subscribe to every kind, `packages/webhooks/src/delivery.test.ts` and `packages/webhooks/src/no-show.test.ts`, subscribe to the booking kinds only or use the enabled context. Enable webhook-action validation in workflow create/update internal tests. | Hard-off for workflow event kind | Adding the new kind returns 404 workflows_disabled while off, ahead of 409 webhooks_disabled; keeping or removing an existing subscription works; other kinds work; populated predecessor with request- and attendance-kind subscriptions preserved, fresh install, no-op rerun and DB types; an endpoint subscribed to all current kinds can add the workflow kind; the n8n and Make tests still fail for a booking kind that their integration lacks; additive OpenAPI diff; missing/inactive/cross-owner subscription rejected; the docs/workflows.md baseline and its doc test are updated to the new constant and CHECK. |
| 13e. Webhook subscription interfaces and guides | 13d | Existing listWebhooks/listWebhookDeliveries responses and the create_webhook/update_webhook and webhooks create/update interfaces carry the new kind; update MCP/CLI help, webhook/MCP/CLI guides and the payload field list; extend the existing open-enum compatibility note to the workflow kind; state in the Zapier, n8n and Make guides that they do not offer it. | Hard-off for workflow event kind | MCP and CLI return the same 404 workflows_disabled for the new kind; list Webhook.events and delivery eventType documented as open enums; required bookingId remains UUID; guides name every kind and the disabled state. |
| 14a. Webhook outbox extension | 9, 13e | None. Signed workflow delivery payload; new migration adds nullable webhook_deliveries.workflow_run_id, re-keys the 0064 NULLS NOT DISTINCT uniqueness with it, and replaces the 0070 event_type CHECK, extending it from 6 to 7 kinds without changing booking, request or attendance deliveries; move the existing ON CONFLICT target in delivery.ts to the new key. | Hard-off | Populated predecessor with booking-origin, request-origin and attendance rows preserved unchanged, fresh install and no-op rerun; the existing capture's conflict target moves to the five-column key, booking/request duplicate capture still coalesces and each attendance change still gets its own delivery; the docs/workflows.md baseline and its doc test are updated; two workflow runs targeting one endpoint retain distinct identities; duplicate capture coalesces; transactional rollback; signatures verified with fake receiver; payload contains no new booking personal fields and no requestId. |
| 14b. Webhook delivery fences | 14a | None. Reuse guarded transport and bounded delivery repair; add workflow cancellation/disable and expiration checks. | Hard-off | DNS rebinding, redirects, forbidden/private targets and policy removal refused; endpoint pause/rotation race; first attempt expires at due+60min but timely-started delivery retries beyond that bound with same ID and receiver dedupe; no real outbound calls. |
| 15a. Synthetic preview | 11b, 14b | `POST /api/v1/workflows/preview` (`previewWorkflow`) / `preview_workflow` / `workflows preview`. | Hard-off | Only synthetic examples; no booking lookup, mail, DNS or webhook call; same validation/rendering as execution; estimates reveal only static candidate limits, no instance usage; full scope and parity mapping. |
| 15b. Execution audit wiring | 12b, 14b, 15a | None. Wire run_scheduled/run_cancelled (8b, 8c), run_skipped (9), the email events (12a, 12b), the webhook events (14a, 14b) and previewed (15a) into the audit port inside their transactions; production stays no-op until 16c. | Hard-off | A recording fake port sees each event once per transition; rollback records none; replay adds no terminal duplicate; background actors explicit; no bodies, answers, addresses, raw URLs or secrets. |
| 16a. Workflow history interfaces | 12b, 14b | `GET /api/v1/workflows/{id}/runs` (`listWorkflowRuns`) / `list_workflow_runs` / `workflows runs`. | Hard-off | Stable cursor pages; safe codes including workflow_disabled; personal/team workflow history omit booking IDs and private details; existing webhook lists preserve required bookingId; retention never removes live dedupe. |
| 16b. Audit writer binding for definition events | 15b, 16a | None. Bind the port to the accepted shared writer from #246, or main's audit writer, for definition and preview events; wait here if none is on main. | Hard-off | Created/updated/enabled/disabled/deleted/previewed reach the accepted writer inside their transactions; rollback and exact replay; redacted actor/scope metadata; retention and access follow the accepted policy without widening team access. |
| 16c. Audit writer binding for execution events | 16b | None. Bind the execution events wired in 15b to the same writer and close the no-op path. | Hard-off | Every execution event recorded transactionally with exact replay; background actors explicit; production wiring cannot select the no-op port, and a test fails if any process builds workflows with it. |
| 17a. Workflow list and lifecycle UI | 7 | None; calls list/get/update (enable and disable)/delete from steps 4, 6 and 7 through the generated client; reads `workflowsEnabled` from `/instance`. | Hard-off | jsdom list, enable, disable and delete with stale revision/context tests; navigation hidden when workflowsEnabled is false or absent; disabling explains that runs claimed while disabled are skipped; English/zh-CN strings; loading/403/error are neutral; keyboard/mobile acceptance; no raw fetch or alternate server path. |
| 17b. Workflow editor and preview UI | 15a, 17a | None; calls create/update/preview from steps 5, 6 and 15a through the generated client; reads `followUpHostNotesEnabled` from `/instance`. | Hard-off | jsdom create and edit of scope, trigger, offset or delay, conditions, recipients, per-locale text and webhook endpoint; custom subject/body hidden when followUpHostNotesEnabled is false; preview shows rendered text, skip reasons and locale fallback; stale revision conflict; English/zh-CN strings; keyboard/mobile acceptance; no raw fetch or alternate server path. |
| 18a. History UI | 16c, 17b | None; calls history from 16a through generated client. | Hard-off | jsdom pagination and suppression/unknown outcomes; neutral empty/loading/error states; no inbox-delivery claim; English/zh-CN strings and scoped data. |
| 18b. Complete operating documentation | 18a | None. Consolidate workflow UI/REST/MCP/CLI guides, mail reserve, host-text policy, reschedule divergence, reschedule-request isolation, lazy disable and limitations; preserve earlier operation-level docs; operator settings wait for 19b. | Hard-off | Examples use published operations; SMTP sizing remains 1.2 × MAIL_MAX_PER_HOUR; Cloud host text stays off; owner/recipient limits and the 60-minute SMTP outage limitation explicit; all public template locales complete. |
| 19a. Operator-off semantics | 18b | None. Implement operator-off behind the still-false constant through an injected setting: recovery reads, disable-only updates and deletion allowed; creation, preview, enabling and other edits refused; MCP discovery hidden; due wakes skip as instance_disabled; `/instance` workflowsEnabled follows the injected state. | Hard-off | Each operation under injected on/off states over REST, MCP and CLI; only due wakes skip while off and future rows survive a short stop; re-enabling never revives skipped work; workflow_disabled and instance_disabled stay distinct in history; the production constant still denies everything. |
| 19b. Operator setting and opt-in | 19a | None. Set the constant true only after creation, edit, disable/delete, both execution paths, history and audit binding exist; add WORKFLOWS_ENABLED (default false) to loadConfig and Compose as `${WORKFLOWS_ENABLED:-}`; write empty .env.example entries for it and both mail sub-caps; add their configuration.md rows; rewrite the docs index known-limitation line. | Operator-off by default | Default release cannot capture/send and `/instance` reports false; explicit opt-in exercises full end-to-end fakes; Compose forwards all three settings with empty defaults; all roles agree on setting; no self-hosting paywall. |
| 20. Final acceptance and default enablement | 19b | None. Acceptance PR changes operator default to true, retains explicit false emergency stop, and updates operating docs and the docs index line. | Default true only after acceptance | Compose test: the forward is exactly `${WORKFLOWS_ENABLED:-}` and an empty value yields true; copied step-19b .env picks up true while explicit false stays off; host-text switch unchanged; author-side review plus project-lead acceptance; concurrency/replay/reschedule/cancel/DST and crash negative controls; separate Biome/typecheck/full tests/build/Docker/API types gates; required CI green, browser tests run with approved environment; rollback runbook reviewed. |

The future audit writer dependency is a prerequisite for completing steps 16b and 16c, not
a claim that its currently reviewed implementation is already on main. If it is still
unavailable, retain hard-off and do not proceed to opt-in. No workflow operation qualifies
for a browser-session-only parity exemption. No send-test, replay-run, conversion,
export or no-show mutation endpoint is introduced by this plan. Existing webhook
secret rotation receives agent parity; it does not introduce a second endpoint.
