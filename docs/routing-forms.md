# Routing forms — proposed design

Status: design only; no routing form is available yet. This proposal adds no tables,
routes, UI or plan checks. The eventual feature is free on self-hosted and Cloud alike.
[Data model](data-model.md), [API conventions](api-conventions.md),
[MCP](mcp.md) and [team administrator booking fields](team-admin-bookings.md) remain
canonical for existing behavior. All contracts below describe future implementation.

## Official reference check

Checked 2026-11-06. These are documented behaviors, not claims from hands-on testing
or a comprehensive competitor/plan comparison:

- Calendly's [create a Routing Form](https://calendly.com/help/how-to-create-a-routing-form)
  describes AND/OR conditions, event-type, custom-message and external-URL destinations,
  a fallback route (initially a custom message), preview before publishing, and link/embed
  sharing. Its [management guide](https://calendly.com/help/how-to-manage-routing-forms)
  describes permissions, viewing responses and exporting results.
- Cal.com's [Routing Overview](https://cal.com/help/routing/routing-overview)
  describes member attributes, attribute weights/virtual queues, fallback member subsets,
  Salesforce ownership routing and administrator-visible routing traces. Its route actions
  are event redirect, external redirect and custom page message; external redirects accept
  HTTP, HTTPS and mailto, with unsupported saved schemes falling back to a message.
- Cal.com's [answer mapping guide](https://cal.com/help/routing/connect-routing-form-to-booking-questions)
  describes matching field identifiers and compatible types to carry answers into booking
  questions; visible questions can be edited by the booker. Its
  [headless guide](https://cal.com/help/routing/headless-routing) passes external form data
  through URL parameters. Hourmere deliberately proposes body-only answer submission.

The choices below are Hourmere decisions, not inferred competitor guarantees. These
help pages do not establish a universal paid-plan restriction; this design makes no such claim.

## Form model and limits

A form belongs to exactly one organization, including a personal organization. It has
an immutable ID, public slug within that organization, title, optional description,
draft revision, published-version pointer and enabled/archived state. Public paths are
`/route/{handle}/{slug}` for personal owners and `/route/team/{teamSlug}/{slug}` for teams;
reserve this namespace using the existing reserved-name checks. Slug changes invalidate
old paths without redirect aliases. Drafts are private; publishing is explicit.

Questions are ordered arrays with stable opaque IDs allocated on creation. Reordering or
renaming retains identity; changing type or deleting/recreating allocates a new identity.
Choice options also have stable IDs and public labels: rename does not change a match.
IDs cannot be reused within a form's history. `required` defaults to false. Unknown answer
IDs and unknown fields are rejected, and optional blank values are omitted. Required
means a nonblank text value or a selected option, not merely a present JSON key.

Initial types: `short_text`, `select` (single choice), `email`. These cover names,
company, contact and explicit qualification categories while reusing familiar booking
validation. Defer long text and phone to the booking form to minimize pre-booking PII.
Defer multiple choice and number to avoid ambiguous set/range semantics; use explicit
company-size bands as select options. No file uploads, HTML, rich text, hidden fields or
conditional question visibility. Email syntax uses existing invitee validation; it is not
email verification and grants no identity or mailbox ownership.

The following is the normative numeric-limit register for later code. Character limits
use UTF-16 code units after trimming; validate well-formed Unicode and reject controls,
including bidi embedding/isolate controls. Email uses the existing booking validator in
addition to this envelope. These bounds keep validation and evaluation work finite.

| Limit | Value | Meaning |
|---|---:|---|
| questions_per_form | 20 | Maximum questions in a version |
| options_per_question | 50 | Maximum options for a select question |
| rules_per_form | 50 | Maximum ordered rules, excluding fallback |
| conditions_per_rule | 10 | Maximum predicates in an AND rule |
| label_length | 200 | Maximum question/option label and form title length |
| text_answer_length | 500 | Maximum short-text or email answer length |
| message_length | 2000 | Maximum description or custom message length |
| submission_bytes | 16384 | Maximum UTF-8 JSON submission body bytes |
| route_lifetime_minutes | 30 | Absolute route receipt lifetime from submission |
| purge_grace_hours | 24 | Maximum normal cleanup delay after receipt expiry |

Nonempty titles, labels, options and message targets are required. Empty question/rule
arrays are permitted for a fallback-only form. IDs are UUIDs, not labels or array offsets.
The body-byte cap applies independently of per-field maxima. Versions and organization
form quotas must be bounded by the storage task before launch; their numeric values are
not fixed here. Reuse existing public read/booking request budgets initially, with a
separate routing-write bucket and durable per-form/instance admission ceilings; the public
execution task must document and test those ceilings before enabling public writes.

## Rules and versions

Evaluate enabled published rules top to bottom; first match wins. Each rule is an AND
of nonempty predicates. `equals` is allowed on short text, email and select; `one_of`
is allowed on select with a nonempty distinct subset of that question's option IDs.
Text equality is exact after trimming and Unicode NFC normalization, case-sensitive;
email equality uses the existing invitee email normalization. Missing optional answers
never match, including against an empty literal (empty literals are invalid). There is
no coercion between strings and option IDs. No contains, regex, numeric ranges, NOT,
nested expressions or arbitrary scripts initially. OR is expressed by adjacent rules
with the same target; `one_of` provides OR within a select. This keeps evaluation and
explanation deterministic without an expression-builder language.

A mandatory fallback target is separate from the ordered rules and has stable identity
`fallback` in provenance. It may be an eligible event or a nonempty plain-text message.
New drafts start with a message fallback that the author must review before publishing.
An invalid draft cannot publish: reject dangling questions/options, mismatched operators,
invalid mappings/targets and duplicate IDs/positions. Preview uses exactly the shared
validator/evaluator, returns author-only matched-rule explanations, persists no answers
and creates no route receipt, booking or analytics event.

Publishing atomically inserts an immutable version (questions, order, rules, targets,
mappings and labels) and switches the pointer. Versions have monotonically increasing
numbers per form and immutable UUID identities. Every draft save and publish supplies
`expectedRevision`; stale concurrent changes return `routing_revision_conflict`. Publishing
must revalidate current permissions and all targets in the transaction. No editing of
published rows or silent republishing. Archive/disable immediately blocks new submissions
and unconsumed continuations, including ones issued from older versions.

A public GET includes `versionId`. Submission must name the currently published version;
a publish race returns `routing_form_changed`, with no receipt, and asks the invitee to
reload and review answers against the new questions. Keep compatible values only in browser
memory by stable ID; removed/type-changed values are discarded. A successful submission
pins its version and matched rule until its receipt expires. Later publication does not
reroute that receipt. Current target eligibility, form enablement and booking validation
are still checked on continuation and booking. Existing bookings retain their original
form/version/rule attribution; rescheduling copies it and never evaluates routing again.

## Targets and failure behavior

| Target | Initial decision |
|---|---|
| Personal event | Allowed only inside the form's personal organization, owned by its owner |
| Team event | Allowed only inside the form's team organization, using its existing host mode |
| Specific team member within an event | Deferred; reject this target shape. It would bypass round-robin fairness or reduce a collective's required hosts. Use a separately configured individual team event instead |
| External URL | Not allowed initially, including fallback. Reject URL target kinds and client-supplied return URLs; message text is rendered without HTML or automatic links. This adds no open-redirect surface |
| Custom message | Allowed plain text, displayed without answer interpolation or executable markup |

Only enabled, nondeleted, publicly listed event types are eligible. Hidden types are
rejected even though their direct links may otherwise be bookable: public routing must
not become a hidden-event discovery API. Publishing a form does not change event visibility.
The continuation reveals only the selected event's ordinary public projection, never the
other targets, candidate hosts, member IDs, assignment queue or rule logic. An individual
event's already-public host name and actual confirmed hosts keep their existing visibility.

Do not block event deletion, deactivation or team-member departure for routing references.
Mark affected targets broken through current eligibility checks; a dependency invalidation
in the same mutation transaction updates an author-visible health marker. Historical
version contents remain immutable. The admin list/editor shows affected form and rule,
neutral unavailable status and a repair action; authorized reads rederive health so a
missed background job cannot conceal a broken target. No new email notification pipeline.
Unknown/loading/403/provider errors are not reported as missing configuration.

When a matching rule's target is structurally broken, use the version's fallback directly;
do not continue to later rules. If the fallback is broken, show a built-in neutral
unavailable message and mint no booking capability. Record both matched rule and resolved
fallback identity in the receipt so later booking provenance is truthful. Temporary lack
of slots is not a broken target and does not route to another event. Provider/readiness
errors fail neutrally rather than being treated as proof of deletion or no slots.

If a receipt's target becomes broken after submission, invalidate its continuation with
`routing_unavailable`; invitee restarts on the current form. Never switch an already
chosen appointment silently. Target checks serialize with event deletion/member departure
using existing organization and event locks. The storage/execution tasks must preserve
[data-model lock ordering](data-model.md#team-membership-and-host-lock-order), then lock
form and receipt in consistent order; they must not acquire an event lock after a form
lock on a competing path. Hard-deleted targets retain historical UUID attribution without
an event FK; never retain deleted users' names/email just for routing diagnostics.

## Answer transfer, receipts and privacy

Submission is POST JSON, never URL/query parameters. It returns either a message or an
opaque random `routeToken` plus expiry, with no answers echoed. Store only its digest;
store the validated answers encrypted with a purpose-specific key, binding organization,
form/version and receipt IDs as authenticated associated data. Token URLs, if needed for
same-origin browser continuation, use a fragment cleared immediately after reading;
never server access logs, query strings, referrers, localStorage or analytics. All routing
responses/pages use no-store and no-referrer. Tokens and bodies are redacted from logs.

A receipt binds exact normalized answers, version, matched rule, resolved target/mappings,
expiry and eventual consuming booking. It grants only continuation to that event; it
neither authenticates an invitee nor reserves a slot. Route GET/slots/booking consume the
capability through body/header transport, not an arbitrary event/member selector. Ordinary
direct booking remains supported; routing is qualification convenience, not an access
control barrier or verified lead qualification.

Per-target explicit mappings use source question ID and destination booking-question ID,
or `inviteeName`/`inviteeEmail`. No matching by labels or coincidental IDs. Short text maps
to short text/long text or name; email maps to invitee email or compatible text; select
maps to select only with an explicit complete option-ID-to-current-option-value crosswalk.
No implicit number/boolean/phone conversions. Each destination has at most one source.
Publication validates mappings and runtime revalidates against current event questions.
If destination fields/options change incompatibly, omit that prefill and ask the invitee
to complete current questions; never silently coerce or drop required booking validation.
Name/email and mapped answers remain visible/editable before confirmation. Editing booking
prefill does not change the saved routing answers or reevaluate qualification. To change
routing inputs the invitee restarts the form. The final booking stores both original
routing answers and final ordinary booking responses distinctly, including label/option
snapshots for interpreting history.

Booking creation atomically consumes the receipt and writes its immutable provenance and
answer snapshot with ordinary booking, host assignment and outbox writes. Concurrent use
can create at most one booking. Include receipt identity and submitted final booking fields
in the existing authority-scoped idempotency fingerprint. An exact authorized retry returns
the original booking's current lifecycle even after receipt expiry; a changed request/key
cannot reuse a consumed receipt. Keep minimal consumed digest/booking evidence with the
booking for replay, without recoverable token or duplicate answer ciphertext. Rollback
leaves the receipt unconsumed. Reschedule/cancel do not revive it or send new routing mail.

Unbooked receipts are inaccessible to form administrators and have no response list/export.
Erase encrypted answers at expiry, with the bounded cleanup grace above; expired receipts
are unusable even when cleanup is delayed. Infrastructure outages can delay physical
purge; operators monitor oldest expired row and backups follow their ordinary deletion
cycle. Message results retain no answers or receipt at all. Booked snapshots follow booking
retention/deletion, not an invented automatic booking expiry; form archive preserves them.
Deleting the organization deletes its receipts and snapshots with its bookings.

| Surface | Proposed data boundary |
|---|---|
| Authorized booking host detail / agent host detail | Add optional `routing` with form/version, matched and resolved rule IDs, and question/answer label snapshots; same current host/org checks as ordinary custom answers |
| Invitee private management detail | Own answer snapshot only; no predicates, route names, other targets or author diagnostics |
| Team-admin booking list/detail and exports | No routing answers or provenance. Preserve the exact [whitelist](team-admin-bookings.md); managing a form grants no host-booking read authority |
| Host export | Include routing answers only in an explicitly requested authorized host export, with stable field IDs/version labels and CSV formula escaping; no broad admin export or abandoned-lead export |
| Webhooks | Keep existing immutable minimal whitelist: no routing answers, route IDs, contact data or capability. No submission webhook |
| Email, ICS, provider calendar copies, embed messages, analytics | No new routing answer/provenance fields. Mapped ordinary answers keep existing surface-specific rules |

## Scheduling interactions

- Round-robin: target the whole activated pool. Routing creates no assignment or fairness
  advance; booking uses current availability and commits assignment once. No route-specific
  weights/queues or candidate member exposure. Exact booking replay does not advance it.
- Collective: all required hosts remain required. Routing cannot narrow the set. Changed
  membership is handled by existing deactivation/required-host safety and neutral failure.
- One-time links: neither routing targets nor combinable input. Reject `routeToken` together
  with a one-time-link token. Routing receipts use separate purposes/digests and cannot mint
  or revive one-time links. Both existing direct flows remain available.
- Waitlist: allow the selected event's ordinary waitlist flow only where already supported.
  Enrollment has its own explicit consent and verified email; do not copy routing answers
  or prolong the receipt. A later waitlist link books normally, without expired routing
  provenance. No routing-based prioritization and no round-robin/collective waitlist expansion.
- Embeds: defer routing-form embeds initially. Existing event embeds remain unchanged;
  dedicated routing pages deny framing. Later support needs the existing exact-origin,
  source/instance-checked protocol and no answer/token data in parent messages.
- Paid bookings: no payment capability is added here. Until a paid-event contract can bind
  receipt consumption to final booking/payment commit and checkout expiry, reject paid
  targets at publication/runtime; never bypass a required payment. Future payment failures
  must not consume a receipt or advance fairness. No provider calls from routing.
- Group seats: defer routing to group event types while their public enablement is separate;
  reject them initially. Durations, zones, notice, capacity and DST otherwise remain the
  selected event's normal booking rules; no second availability engine.

## Ownership, permissions and public security

Personal owners manage their own forms; current exact team owners/admins manage team
forms, even if someone else created them. Ordinary team members cannot author/read private
team routing configuration. Creator is historical attribution, not continuing authority.
No cross-organization target, mapping, version, receipt lookup or transfer of form ownership.
Every service entry rechecks current membership; never trust an organization ID in a body.

Use existing session Origin/Referer and expected-organization fencing for configuration
writes. Keys are scoped to their configured organization: `full` for create/update/publish,
disable/archive and preview; `read` or `full` for private list/get; `bookings` or `full`
for actual routing/continuation and booking. Public metadata/submission require no key;
a supplied bearer must be valid and scope-authorized without anonymous/cookie fallback.
MCP OAuth retains `mcp:tools` with the same live ownership checks. Configuration access
never expands the session-only team-admin booking endpoints to agent credentials.

Apply trusted-proxy client IP resolution, existing public-read budgets, distinct routing
submission/continuation buckets, shared durable form/instance admission ceilings and the
body-size cap before expensive validation/storage. Hash rate-limit IP keys with a dedicated
HMAC purpose; retain no raw IP or answer values in rate accounting. Rate-limit refused and
invalid requests too. Repeated route submissions may mint separate receipts within those
budgets; booking replays cannot consume a receipt twice. Do not send email on submission.
Public preview is forbidden. Unknown/archived forms share a neutral unavailable response;
unknown, expired and invalid continuation tokens are indistinguishable. Reject excess
input depth and unknown keys. Render author content as text, and do not fetch remote URLs.

There is no CAPTCHA. Distributed bots can submit plausible answers and infer outcomes;
rate limits do not prove humanity, business email ownership or qualification. Public forms
necessarily reveal their questions and selected public destination/message; repeated probes
can infer parts of the policy. Keep predicates, all alternative targets and match traces
server-side, use neutral errors, and never claim timing indistinguishability. No public
member search or hidden-event target selection is introduced.

## Analytics decision

Defer route counters and funnel analytics. Retained booking provenance supports authorized
host troubleshooting without collecting abandoned leads. No view/submission telemetry,
per-answer breakdown or new analytics IDs. If aggregate counts are added later, they need
an explicit retention/privacy contract, transaction-safe deduplication and small-count
exposure review; they must not be reconstructed from unbooked answer retention.

## Table sketch (proposal, not a migration)

Application tables live in `public`, snake_case; UUIDv7 keys and `timestamptz` instants.
Every organization reference is an FK to `auth.organization`; organization deletion
cascades. Use composite unique keys/FKs to prevent cross-organization associations.

| Table | Columns and constraints | Indexes |
|---|---|---|
| `routing_forms` | `id`, `organization_id`, `slug`, `created_by_user_id` (historical UUID, no user FK), `draft` JSONB, `draft_revision`, nullable `published_version_id`, `enabled`, `archived_at`, timestamps; unique organization/slug and organization/id; positive revision | organization + creation time + id for keyset lists; scoped slug unique |
| `routing_form_versions` | `id`, `organization_id`, `form_id`, positive `version_number`, immutable `questions`/`rules`/`fallback` JSONB, `published_at`, historical publisher UUID; composite form FK and unique form/version number; unique organization/form/id for pointer FK | form + version number |
| `routing_target_dependencies` | `organization_id`, `version_id`, rule identity (UUID text or `fallback`), historical `event_type_id`, derived health code/time; composite version FK; no cascading event/user FK; JSON target is authoritative | organization + event_type_id; unique version/rule |
| `routing_receipts` | `id`, `organization_id`, `form_id`, `version_id`, unique `token_hash`, nullable `answers_ciphertext`, matched/resolved rule identities, resolved target snapshot, `created_at`, `expires_at`, nullable `consumed_booking_id`; composite version/booking FKs; expiry after creation; consumed implies booking and no answer ciphertext | digest unique; partial expiry + id for unconsumed cleanup; consuming booking |
| `booking_routing` | `booking_id` PK/composite organization FK with cascade, historical form/version UUIDs and version number, matched/resolved rule IDs, immutable question/answer snapshots; no cascading FK to form/version | organization + booking; form/version for authorized maintenance only |

Published-version pointers must reference that same form and organization (deferred FK
allows atomic publication). Service validation owns JSON semantics and limits; SQL CHECKs
own JSON container types, lifecycle/nullability, positive revisions and expiry invariants.
Normalized dependency rows are transactionally generated from every event target, including
fallback, never supplied independently by callers. Hard form deletion is an archive API;
physical version cleanup may remove only versions with no live receipt and no current
pointer. Booking snapshots make history independent of that cleanup. Consumed receipt
evidence survives form archive and version cleanup: detach its version FK only after
consumption and retain historical IDs, or retain the referenced version until booking deletion;
choose the latter initially. Unconsumed receipts cascade on physical organization deletion.
Cleanup locks receipt rows in bounded batches, skips locked rows and does not take host locks.
No migration number is reserved by this document.

## REST, MCP and CLI contract sketch (proposal)

All new writes register in OpenAPI and the shared interface-parity/scope registry. Share
service validation/authorization, use camelCase JSON, RFC 3339 UTC instants, strict request
schemas and open additive response schemas. Responses/errors use no-store. Lists return
`{ data, nextCursor }` and opaque keyset cursors scoped to organization/filter. Existing
booking payloads get optional fields; do not rename enums, error codes or existing fields.

| REST under `/api/v1` | MCP | CLI | Access |
|---|---|---|---|
| `GET /routing-forms`, `GET /routing-forms/{id}` | `list_routing_forms`, `get_routing_form` | `routing-forms list`, `routing-forms get` | Form manager; read/full |
| `POST /routing-forms` | `create_routing_form` | `routing-forms create` | Form manager; full |
| `PATCH /routing-forms/{id}` (draft or enabled flag), `DELETE /routing-forms/{id}` (archive) | `update_routing_form`, `archive_routing_form` | `routing-forms update`, `routing-forms archive` | Form manager; full |
| `POST /routing-forms/{id}/publish` | `publish_routing_form` | `routing-forms publish` | Form manager; full |
| `POST /routing-forms/{id}/preview` | `preview_routing_form` | `routing-forms preview` | Form manager; full |
| `GET /public/routing-forms/{organizationSlug}/{slug}` | `get_public_routing_form` | `routing-forms public` | Anonymous/public metadata; personal lookup uses handle with explicit `ownerKind` |
| `POST /public/routing-forms/{organizationSlug}/{slug}/route` | `route_lead` | `routing-forms route` | Anonymous or bookings/full; explicit ownerKind |
| `POST /routing-continuations/resolve`, `POST /routing-continuations/slots` | `resolve_routing_continuation`, `find_routed_slots` | `routing-forms resolve`, `routing-forms slots` | Route capability; bookings/full when bearer supplied |
| Existing booking creation with optional `routeToken` | `create_booking` | `book` | Existing booking authority plus route capability |

Draft create uses a client-generated UUID `requestId` scoped to actor/organization for
idempotency. Publish/update/archive take `expectedRevision`; repeat publish with its same
requestId and canonical input returns its original version. Changed input with the same
key returns `idempotency_key_reused`. Route submission takes `{ versionId, answers }`;
it intentionally has no durable replay cache containing raw tokens. On lost response the
invitee submits again and gets a new expiring receipt, within admission budgets. Each
receipt remains single-use; only booking idempotency prevents duplicate booking retries.
CLI JSON input comes from stdin/file, not answer-bearing command-line arguments; CLI/MCP
must treat returned route capabilities as sensitive and never emit them to diagnostic logs.

Agent example: read public form metadata, ask the lead for the declared questions, call
`route_lead` with `versionId` and `answers` keyed by question UUIDs, then use returned
`routeToken` for `find_routed_slots` and `create_booking` with a retained booking idempotency
key. The agent receives a message or the selected public booking projection, not predicates
or members to choose from. It gets invitee agreement before booking; route submission alone
creates no booking or notification. The agent can also hand the private continuation to
the invitee through the secure application flow without placing answers into a URL.

| Status/code | Meaning and recovery |
|---|---|
| 400 `invalid_routing_form`, `invalid_routing_answers`, `invalid_routing_target` | Invalid authored config, supplied answers or unsupported target/mapping; optional open-string `field`, no submitted values |
| 401 `unauthorized`, 403 `insufficient_scope` | Existing credential rules |
| 403 `team_management_access_denied` | Uniform unauthorized team configuration access |
| 404 `routing_form_not_found` | Unknown/out-of-scope private form or unavailable public form, without existence clues |
| 409 `organization_context_changed` | Existing session context recovery |
| 409 `routing_revision_conflict`, `routing_form_changed` | Reload editor or public form respectively |
| 409 `routing_unavailable` | Neutral invalid/expired/consumed capability or target no longer usable; restart unless exact booking replay succeeds |
| 409 `idempotency_key_reused` | Same retained key with different canonical input |
| 413 `payload_too_large`, 429 `rate_limited` | Transport bounds; Retry-After on throttling |

Ordinary slot conflicts, booking validation, reschedule/cancel and credential errors keep
existing codes. Unknown readiness uses a neutral service-unavailable failure; never pretend
it was an empty schedule or absent configuration. Public errors omit rule/target diagnostics.

## Implementation plan

These are approximately day-sized slices; split a slice again if its acceptance matrix
cannot be completed within a day. Internal storage/services may land first, but public write
routes must ship their MCP/CLI/OpenAPI parity together. No partially enabled public feature.

| Later task / slice | Concrete acceptance checks |
|---|---|
| Form/rule storage and versioning | New migration after checking main/open PR numbers; populated predecessor preservation, fresh install and no-op rerun; generated DB types; reject cross-org FKs/invalid JSON; concurrent expected-revision publishes have one winner; immutable versions and stable IDs survive edits |
| Storage target lifecycle and cleanup | Event disable/delete, host departure and publish races; fallback dependencies included; no deletion blockers or booking-history cascades; admin derived health repairs missed invalidations; expired unbooked ciphertext purged, consumed evidence retained; bounded pools and cleanup locks |
| Public form and pure routing | Validate every type/operator/boundary and first-match/AND/one-of/fallback cases; stale version refresh, no rule/hidden target/member leakage; no answers in URL/logs; bot budgets/body caps; preview has no side effects; all shipped public locales and jsdom/accessibility tests |
| Booking continuation and answer transfer | Mapped prefill/edit/changed-question behavior; consume/rollback/concurrent replay tests; current target eligibility; no round-robin advance before commit; collective required-host and DST checks; cancellation/reschedule preserve provenance; waitlist and unsupported combinations tested; admin/webhook/export negative privacy assertions |
| Rule editor UI (en + zh-CN) | Create/reorder questions/options/rules with stable IDs; publish/disable/archive and stale-editor recovery; required fallback, mapping and broken-target repair; neutral loading/403/error states; keyboard reorder and jsdom tests; natural Chinese with full-width punctuation |
| REST/MCP/CLI exposure | Ship public execution adapters with the corresponding public slices; shared service contract tests across transports, scope/org matrices, public projection/error redaction, CLI JSON stdin, OpenAPI types and parity registry; final configuration adapters cover every table operation |
| Docs and acceptance | Publish public documentation-site how-to, agent examples and known limitations alongside enablement; self-hosted/Cloud parity; full synthetic public→route→book acceptance plus privacy/replay/deletion negative controls; CI e2e, no real providers; author-side review and project-lead acceptance |

Each implementation slice adds assertion-failing source-copy mutations for its protections.
This design's doc-fact test checks only the numeric register and mutation controls; it does
not claim to test routing behavior that does not exist yet. No schema change, migration,
product strings or UI is part of this design PR.

## Out of scope and known limitations

Deferred: external redirects, specific-member targeting, CRM/attribute routing, expression
nesting/contains/ranges, extra question types, conditional/hidden fields, routing embeds,
paid/group targets, imported forms, automatic translation of author content, experiments,
aggregate analytics and abandoned-lead exports. Public system strings will use all shipped
public locales; author-written labels/messages remain in the author's language initially.
No CAPTCHA, verified lead identity, routing-only access gate or slot reservation. Users can
share ordinary booking URLs and infer policies from repeated public outcomes. Expired
answers may remain in operator backups; physical purge depends on working maintenance.
No decisions in this document alter the accepted team-admin data whitelist.
