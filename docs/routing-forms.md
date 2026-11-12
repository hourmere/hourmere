# Routing forms — proposed design

Status: storage foundation only; no routing form is available yet. Migration 0072 adds
the five storage tables; no routes, UI, execution path or plan checks exist. The shared
validator, evaluator and target checks (step a2) exist as internal functions that no
service or transport calls yet. The eventual
feature is free on self-hosted and Cloud alike,
and is on by default once the final acceptance step passes (see [Rollout gating](#rollout-gating)).
[Data model](data-model.md), [API conventions](api-conventions.md),
[MCP](mcp.md) and [team administrator booking fields](team-admin-bookings.md) remain
canonical for existing behavior. Contracts beyond storage below describe future implementation.

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

Calendly’s official creation page lists Professional, Teams, Teams Plus and Enterprise;
access can vary with account creation date and add-ons. The cited Cal.com help pages do
not state plan availability. The choices below are Hourmere decisions, not inferred
competitor guarantees. Hidden-target support below is our own design decision, not a
claim that the official Calendly pages document secret-event routing.

## Form model and limits

A form belongs to exactly one organization, including a personal organization. It has
an immutable ID, public slug within that organization, title, optional description,
draft revision, published-version pointer and enabled/archived state. Public paths are
`/route/{handle}/{slug}` for personal owners and `/route/team/{teamSlug}/{slug}` for teams.
Only a personal handle can collide with `/route/...`: team pages live under `/team/`.
Adding `route` to `RESERVED_NAMES` in `packages/core/src/reserved.ts` would immediately stop
serving a legacy `route` handle's pages (`servedHandle` in
`packages/scheduling/src/availability.ts` does not serve stored handles that became
reserved), so the namespace step instead rejects `route`, in any case, wherever a personal
handle is newly claimed or changed, and leaves `RESERVED_NAMES`, page serving and team slugs
unchanged. If a stored personal handle `route` already exists, its pages keep working and
routing stays effectively off on that instance (see [Rollout gating](#rollout-gating))
until an explicit operator-led rename with the owner and a server restart; never silently
take over or de-serve an existing URL.
Public API paths use `/api/v1/public/-/routing/{handle}/{slug}` and
`/api/v1/public/-/routing/teams/{teamSlug}/{slug}`. The `-` segment cannot be a valid
handle, so it cannot shadow existing personal endpoints; the explicit `teams` branch
mirrors the existing personal/team split, without an `ownerKind` discriminator.
Slug changes invalidate
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

The following is the normative numeric-limit register for later code. Character limits use
UTF-16 code units of the value as submitted, before trimming, so every legal string is
bounded; trimming then decides blankness, storage and comparison. Validate well-formed
Unicode and reject controls, including bidi embedding/isolate controls. Email uses the
existing booking validator in addition to this envelope. These bounds keep validation and
evaluation work finite.

| Limit | Value | Meaning |
|---|---:|---|
| forms_per_organization | 100 | Maximum non-archived forms, including disabled forms |
| total_forms_per_organization | 1000 | Maximum retained forms, including archived forms |
| versions_per_form | 1000 | Maximum retained published versions of one form |
| questions_per_form | 20 | Maximum questions in a version |
| options_per_question | 50 | Maximum options for a select question |
| rules_per_form | 50 | Maximum ordered rules, excluding fallback |
| conditions_per_rule | 10 | Maximum predicates in an AND rule |
| label_length | 200 | Maximum question/option label and form title length |
| text_answer_length | 500 | Maximum short-text or email answer length |
| message_length | 2000 | Maximum description or custom message length |
| submission_bytes | 65536 | Maximum UTF-8 JSON submission body bytes |
| route_lifetime_minutes | 30 | Absolute route receipt lifetime from submission |
| purge_grace_hours | 24 | Maximum normal cleanup delay after receipt expiry |

Nonempty titles, labels, options and message targets are required. Empty question/rule
arrays are permitted for a fallback-only form. IDs are UUIDs, not labels or array offsets.
The body-byte cap applies independently of per-field maxima. It equals the server's
default `/api` body limit (`DEFAULT_BODY_LIMIT` in `apps/server/src/body-limit.ts`), so the
submission route declares no larger limit. That file's rule requires a route limit to fit
its largest legal request with every string at its maximum length and every character
escaped as `\uXXXX`. The largest legal submission is 20 short-text answers of 500 CJK code
units keyed by question UUIDs: 30,904 bytes as ordinary UTF-8 JSON and 64,764 bytes with
every character of every string, keys and `versionId` included, escaped as `\uXXXX`. Both
fit the cap, so clients may send either encoding. The storage quotas above count retained
non-archived forms regardless of enabled state, with a separate total-forms cap that
includes archived forms. Archiving frees a non-archived form slot; it does not free a total
form slot. Unreferenced old-version cleanup frees a version slot, but never permits reusing
a version number; each form retains its greatest published version number. SQL serializes
form admission with a per-organization transaction advisory lock, without upgrading the
organization share lock; version admission writes the form row. Form creation and
unarchiving require READ COMMITTED isolation; other isolation modes fail closed with
40001, and must restart at READ COMMITTED. Concurrent writers cannot exceed these quotas.
These limits apply equally to self-hosted and Cloud installations. Public
submissions and continuations use the named rate-limit buckets and admission ceilings in
[Ownership, permissions and public security](#ownership-permissions-and-public-security);
step c1 pins their values before any public routing write exists.

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

The shared validator (step a2, `packages/scheduling/src/routing-form-config.ts` and
`routing-form-targets.ts`) fixes the JSON that later steps store and accept. A version is
`{ questions, rules, fallback }`. A question is `{ id, type, label, required }` plus, for
select only, `options` of `{ id, label }` with distinct labels. A rule is
`{ id, conditions, target }`; a condition is `{ questionId, operator: 'equals', value }`
or `{ questionId, operator: 'one_of', values }`, where select values are option IDs. A
target is `{ kind: 'message', message }` or `{ kind: 'event', eventTypeId, mappings }`, with
no member, host, URL or redirect field. A mapping is `{ questionId, destination, options }`:
`destination` is `{ kind: 'inviteeName' }`, `{ kind: 'inviteeEmail' }` or
`{ kind: 'question', questionId }`, and `options`, for a select source only, maps every
source option ID to a destination option. IDs are lowercase UUIDs, distinct across a
version's questions, options and rules. Unknown fields are rejected at every level. Errors
name a `field` path such as `rules.2.target`; target errors add a `reason`: `not_found`
(a missing event and another organization's event alike), `deleted`, `disabled`,
`group_booking`, `unsupported_mode`, `payment_required`, `unsupported_target`,
`invalid_message`, `invalid_mapping`, `unknown_destination`, `incompatible_mapping` or
`incompatible_options`. Event types have no price setting yet, so a stored event projects
no payment requirement; any other projected value fails closed as `payment_required`.

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
| Specific team member within an event | Reject an arbitrary member selector inside a pool/collective. Per-member routing is supported by targeting that member’s personal event in the same personal organization, or their single-host individual team event in the same team organization. Pool narrowing is deferred because it needs per-subset fairness state; collective required hosts cannot be removed |
| External URL | Not allowed initially, including fallback. Reject URL target kinds and client-supplied return URLs; message text is rendered without HTML or automatic links. This adds no open-redirect surface |
| Custom message | Allowed plain text, displayed without answer interpolation or executable markup |

Enabled, nondeleted event types may be listed or hidden, subject to the scheduling
restrictions below. Publishing a form does not change event visibility. A hidden target
is exposed through routing only to a capability holder whose answers selected that rule
(or the selected fallback), never in form metadata or unmatched outcomes. The continuation
shows the selected title, duration, bookable slots and required booking fields, but never
the event slug, public link, other targets, candidate hosts, member IDs, assignment queue
or rule logic. An individual event’s existing host display and actual confirmed hosts
keep their existing visibility. The invitee stays on `/route/continue` throughout booking;
the server resolves the event from the token rather than redirecting to its public URL.
Routing booking results and exact replays use a dedicated projection without reusable
handle/slug/path fields or saved after-booking redirects, following one-time-link
projection practice. Route-capability booking suppresses the `successRedirect` snapshot,
response field and confirmation Continue link, including exact replays, for listed and
hidden targets alike (a [known limitation](#out-of-scope-and-known-limitations)); ordinary
direct bookings keep their existing redirect behavior. Manage links retain their normal
private authority. Arbitrary
host-authored text is not scrubbed for URLs; this rule prevents automatic link disclosure.
Hidden remains discovery control, not access control: someone already holding the
ordinary direct URL can still book without a routing token exactly as today. Routing
does not reveal that URL or turn an unmatched outcome into a hidden-event lookup.

Do not block event deletion, deactivation or team-member departure for routing references.
Mark affected targets broken through current eligibility checks; a dependency invalidation
in the same mutation transaction updates an author-visible health marker. Historical
version contents remain immutable. The admin list/editor shows affected form and rule,
neutral unavailable status and a repair action; authorized reads rederive health so a
missed background job cannot conceal a broken target. No new email notification pipeline.
Unknown/loading/403/provider errors are not reported as missing configuration.

When a matching rule's target is structurally broken, use the version's fallback directly;
do not continue to later rules. If the fallback is broken, submission returns
`409 routing_unavailable`, the page shows a built-in neutral unavailable message, and no
receipt or booking capability is minted. Record both matched rule and resolved
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
opaque random `routeToken`, its `continuationUrl` and expiry, with no answers echoed. Store
only the token's digest; store the validated answers encrypted with a purpose-specific key,
binding organization, form/version and receipt IDs as authenticated associated data. The
answer-encryption key and the rate-limit HMAC key are derived from `BETTER_AUTH_SECRET` with
routing-specific labels, as the waitlist derives its keys, so routing adds no secret
setting. Rotating that secret makes pending receipts unreadable: they fail neutrally with
`routing_unavailable` and the invitee restarts. Booked snapshots are ordinary booking data
and are unaffected. The server builds `continuationUrl` in the submission response (REST,
`route_lead` and `routing-forms route` alike), exactly
`{PUBLIC_URL}/route/continue#token={encodedRouteToken}` from the configured public origin,
as it does for one-time link URLs; clients and agents never assemble it. It contains only
the URL-encoded opaque token. The web form page navigates to it. The continuation page reads
it into memory and immediately clears the fragment with `history.replaceState`; never server
access logs, query strings, referrers, localStorage or analytics. All routing
responses/pages use no-store and no-referrer. Tokens and bodies are redacted from logs.

A receipt binds exact normalized answers, version, matched rule, resolved target/mappings,
expiry and eventual consuming booking. It grants only continuation to that event; it
neither authenticates an invitee nor reserves a slot. Resolve/slots/booking requests present the
capability through POST bodies, not an arbitrary event/member selector. Its scope is
this organization, form, immutable version, selected rule/fallback, target and answer
snapshot only. It lasts an absolute 30 minutes from submission, without sliding renewal.
Resolve and slot reads can repeat before expiry; only successful booking consumes it.
Failed validation/transactions leave it usable; exact authorized booking retries retain
the idempotency behavior below. No general event-list/read, manage or host authority is granted. Ordinary
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
can create at most one booking. Include the presented token's digest (the receipt identity
kept as consumed evidence) and submitted final booking fields in the existing
authority-scoped idempotency fingerprint. An exact authorized retry returns
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
| Booking CSV export | Extend the existing server-side booking export (`GET /bookings/export.csv`, `export_bookings`, CLI `export`) with an explicitly requested routing column group for personal exports only, using its stable headers, JSON answer cells and CSV formula protection. Team exports keep the team-admin whitelist and refuse the option. No separate export, broad admin export or abandoned-lead export |
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
- Waitlist: defer enrollment from routing continuations initially. Existing direct
  event waitlist flows remain unchanged, with their explicit consent and verified email.
  A routed no-slot outcome offers retry/restart, not a direct event URL or waitlist link
  that reveals a hidden slug. Future token-bound enrollment/resend needs REST/MCP/CLI
  parity and consent UI; it must not copy routing answers or prolong the receipt. No
  routing-based prioritization or round-robin/collective waitlist expansion.
- Embeds: defer routing-form embeds initially. Existing event embeds remain unchanged;
  dedicated routing pages deny framing. Later support needs the existing exact-origin,
  source/instance-checked protocol and no answer/token data in parent messages.
- Paid bookings: no public payment setting exists. Main carries an internal paid-booking
  foundation ([payments](payments.md): `pending_payment`/`expired` holds and the reserved,
  default-off `PAID_BOOKINGS_ENABLED`), but no event price setting and no public payment
  route. Routing adds none and never creates a payment hold. A receipt is consumed when the
  booking commits, and nothing binds that consumption to payment confirmation or hold
  expiry, so a paid target could bypass a required payment or consume a receipt for an
  unpaid booking. Target eligibility is therefore an allowlist that fails closed: any
  payment requirement that a later price setting on that foundation adds is rejected at
  publication (validator a2, publish transaction a3) and treated as a broken target at
  runtime until a paid-routing contract exists, and c7 checks that a routed booking never
  enters `pending_payment`. Future payment failures must not consume a receipt or advance
  fairness. No provider calls from routing.
- Group seats: group booking (`booking_mode = 'group'`) is an internal capability without
  public enablement. A seat shares slot capacity, per-slot booker uniqueness and seat
  idempotency, which the single-booking receipt contract does not cover, and routing must
  not become an unplanned public entry point to group booking. The same allowlist accepts
  only `booking_mode = 'individual'`: group targets are rejected at publication and treated
  as broken at runtime if an event changes mode later. Durations, zones, notice, capacity
  and DST otherwise remain the selected event's normal booking rules; no second
  availability engine.

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

Apply trusted-proxy client IP resolution, the rate-limit buckets and admission ceilings
below and the body-size cap before expensive validation/storage. These names are used
everywhere in this document and in the implementation:

| Name | Kind | Applies to |
|---|---|---|
| `page` | Existing public request bucket (`PUBLIC_RATE_LIMITS`) | `GET` public form metadata |
| `routingSubmission` | New public request bucket | `POST …/route` submissions |
| `routingContinuation` | New public request bucket | Continuation resolve and slots |
| `book` | Existing public request bucket | Continuation booking |
| Form admission ceiling | New durable ceiling shared by all server processes | Unexpired, unconsumed receipts of one form at once |
| Instance admission ceiling | New durable ceiling shared by all server processes | Unexpired, unconsumed receipts of the instance at once |

A submission over either ceiling is refused with `429 rate_limited` and mints nothing. Both
ceilings are counts of live receipts, not time windows. The submission transaction counts
them with the partial indexes on unconsumed receipts (organization, form and expiry for the
form ceiling; expiry for the instance ceiling), the form ceiling under the form row lock and
the instance ceiling under one transaction-scoped advisory lock, so concurrent processes
cannot overshoot. Expired receipts stop counting at expiry, before cleanup. Key the two new
request buckets with a dedicated HMAC purpose over the client key and retain no raw IP or
answer values in routing rate accounting; the admission ceilings count per form and per
instance only, and the existing `page` and `book` buckets keep their current keys.
Rate-limit refused and invalid requests too. Repeated route submissions may mint separate
receipts within those limits; booking replays cannot consume a receipt twice. Do not send
email on submission.
Public preview is forbidden. Unknown/archived forms share a neutral unavailable response;
unknown, expired and invalid continuation tokens are indistinguishable. Reject excess
input depth and unknown keys. Render author content as text, and do not fetch remote URLs.

There is no CAPTCHA. Distributed bots can submit plausible answers and infer outcomes;
rate limits do not prove humanity, business email ownership or qualification. Public forms
necessarily reveal their questions and selected destination projection/message; repeated probes
can infer parts of the policy. Keep predicates, all alternative targets and match traces
server-side, use neutral errors, and never claim timing indistinguishability. No public
member search or arbitrary hidden-event selector is introduced.

## Analytics decision

Defer route counters and funnel analytics. Retained booking provenance supports authorized
host troubleshooting without collecting abandoned leads. No view/submission telemetry,
per-answer breakdown or new analytics IDs. If aggregate counts are added later, they need
an explicit retention/privacy contract, transaction-safe deduplication and small-count
exposure review; they must not be reconstructed from unbooked answer retention.

## Table sketch (storage installed by migration 0072)

Application tables live in `public`, snake_case; UUIDv7 keys and `timestamptz` instants.
Every organization reference is an FK to `auth.organization`; organization deletion
cascades. Use composite unique keys/FKs to prevent cross-organization associations.

| Table | Columns and constraints | Indexes |
|---|---|---|
| `routing_forms` | `id`, `organization_id`, `slug`, `created_by_user_id` (historical UUID, no user FK), `draft` JSONB, `draft_revision`, nonnegative `last_version_number` high-water mark, nullable `published_version_id`, `enabled`, `archived_at`, timestamps; unique organization/slug and organization/id; positive revision | organization + creation time + id for keyset lists; scoped slug unique |
| `routing_form_versions` | `id`, `organization_id`, `form_id`, positive `version_number`, immutable `questions`/`rules`/`fallback` JSONB, `published_at`, historical publisher UUID; composite form FK and unique form/version number; unique organization/form/id for pointer FK | form + version number |
| `routing_target_dependencies` | `organization_id`, `version_id`, rule identity (UUID text or `fallback`), historical `event_type_id`, derived health code/time; composite version FK; no cascading event/user FK; JSON target is authoritative | organization + event_type_id; unique version/rule |
| `routing_receipts` | `id`, `organization_id`, `form_id`, `version_id`, unique `token_hash`, nullable `answers_ciphertext`, matched/resolved rule identities, resolved target snapshot, `created_at`, `expires_at`, nullable `consumed_booking_id`; composite version/booking FKs; expiry after creation; consumed implies booking and no answer ciphertext | digest unique; partial expiry + id for unconsumed cleanup; partial organization + form + expiry for unconsumed admission counts; consuming booking |
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
Migration 0072 installs this storage foundation. Version rows reject every update;
foreign keys reject deletion of the current published version or any receipted version.
Only unreferenced historical versions can be cleaned up. Booking routing snapshots
reject updates and follow booking/organization deletion.

## REST, MCP and CLI contract sketch (proposal)

All new writes register in OpenAPI and the shared interface-parity/scope registry
(`packages/auth/src/api-key-operations.ts`); the generated API-key scope tables then list them
from the owning step (see [Rollout gating](#rollout-gating)). Share
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
| `GET /public/-/routing/{handle}/{slug}`, `GET /public/-/routing/teams/{teamSlug}/{slug}` | `get_public_routing_form` | `routing-forms public` | Anonymous/public metadata; explicit personal/team paths |
| `POST /public/-/routing/{handle}/{slug}/route`, `POST /public/-/routing/teams/{teamSlug}/{slug}/route` | `route_lead` | `routing-forms route` | Anonymous or bookings/full; explicit personal/team paths |
| `POST /routing-continuations/resolve`, `POST /routing-continuations/slots` | `resolve_routing_continuation`, `find_routed_slots` | `routing-forms resolve`, `routing-forms slots` | Route capability; bookings/full when bearer supplied |
| `POST /routing-continuations/bookings` using the existing booking service with `routeToken` (no event URL selector) | `create_booking` | `book` | Existing booking authority plus route capability |
| Extend `GET /bookings/{id}` | New `get_booking` | New `booking` (flat, like `event` and `schedule`) | Current host/org authority; read/bookings/full |
| Extend `GET /bookings/manage` | No new tool (private manage-token UI) | No new command | Existing invitee manage-token authority; own answer snapshot only |
| Extend `GET /bookings/export.csv` with `includeRoutingAnswers` (`true` or `false`; step e3, once the booking export is on main) | Extend `export_bookings` | Extend `export` | Existing personal export authority (read/full); team exports refuse the option |

While routing is effectively off, every routing operation in this table returns
`404 routing_forms_disabled` over REST, on a direct MCP call and in the CLI, and the
routing-only MCP tools are omitted from `tools/list`. For `create_booking` and `book` this
applies only to requests carrying `routeToken`, and an exact committed routed-booking replay
still succeeds. The export's `includeRoutingAnswers=true` returns the same error; the two
booking-read extensions keep returning stored routing provenance. See [Rollout
gating](#rollout-gating).

Draft create and publish each take a client-generated UUID `requestId` scoped to
actor/organization for idempotency. Publish/update/archive take `expectedRevision`; a
repeated publish with the same requestId and canonical input returns its original version.
Changed input with the same key returns `idempotency_key_reused`. Route submission takes
`{ versionId, answers }`; it intentionally has no durable replay cache containing raw
tokens. On lost response the invitee submits again and gets a new expiring receipt, within
the admission ceilings. Each receipt remains single-use; only booking idempotency prevents
duplicate booking retries. CLI JSON input comes from stdin/file, not answer-bearing
command-line arguments; CLI/MCP must treat returned route capabilities as sensitive and
never emit them to diagnostic logs. The CLI already redacts management capabilities on
stdout. `routing-forms route` therefore prints `routeToken` and `continuationUrl` as
`[redacted]` on stdout and writes them only with the existing `--output FILE` flag, into a
new 0600 JSON file, exactly like returned manage tokens. `routing-forms resolve`,
`routing-forms slots` and `book` accept `routeToken` only in JSON input and redact it from
stdout, `--output` files and errors. CLI help documents this from c2b; the CLI guide does
from e4c. MCP `route_lead` returns both fields in its result.

Agent example: read public form metadata, ask the lead for the declared questions, call
`route_lead` with `versionId` and `answers` keyed by question UUIDs, then use returned
`routeToken` for `find_routed_slots` and `create_booking` with a retained booking idempotency
key. The agent receives a message or the selected booking projection, not predicates
or members to choose from. It gets invitee agreement before booking; route submission alone
creates no booking or notification. For an invitee to finish instead, the agent returns
the `continuationUrl` from `route_lead` unchanged (the server-built same-origin fragment
link defined above) in its private conversation with that invitee, states the absolute
expiry, and stops short of booking. The link contains no answers, event ID, slug or public link.
Anyone who receives/forwards it has the same bearer capability until expiry or consumption;
it is not identity-bound. Opening the link does not consume it, booking does. Do not put
it in public posts, diagnostic logs or third-party link shorteners; delivery does not renew
its lifetime. If expired, ask the invitee to restart the form, never silently resubmit answers.

| Status/code | Meaning and recovery |
|---|---|
| 400 `invalid_routing_form`, `invalid_routing_answers`, `invalid_routing_target` | Invalid authored config, supplied answers or unsupported target/mapping; optional open-string `field` and, for targets, open-string `reason` (for example `group_booking`, `payment_required`), no submitted values |
| 400 `invalid_request` | `includeRoutingAnswers=true` on a team export while routing is on (`false` is the same as omitting it) |
| 401 `unauthorized`, 403 `insufficient_scope` | Existing credential rules |
| 403 `team_management_access_denied` | Uniform unauthorized team configuration access |
| 404 `routing_form_not_found` | Unknown/out-of-scope private form or unavailable public form, without existence clues |
| 404 `routing_forms_disabled` | Routing is effectively off on this instance. After existing transport checks, the response is identical for every form and token, except that an exact committed routed-booking replay still returns its booking; retry only after the operator enables routing |
| 409 `organization_context_changed` | Existing session context recovery |
| 409 `routing_revision_conflict`, `routing_form_changed` | Reload editor or public form respectively |
| 409 `routing_unavailable` | Neutral invalid/expired/consumed capability or target no longer usable; restart unless exact booking replay succeeds |
| 409 `idempotency_key_reused` | Same retained key with different canonical input |
| 413 `payload_too_large`, 429 `rate_limited` | Transport bounds; Retry-After on throttling |

Ordinary slot conflicts, booking validation, reschedule/cancel and credential errors keep
existing codes. Unknown calendar readiness keeps the scheduling service's existing neutral
`409 calendar_sync_unavailable`; never pretend it was an empty schedule or absent
configuration. Public errors omit rule/target diagnostics.

## Implementation plan

The later project plan is rescheduled into the named steps below, each budgeted at about one
working day including its focused tests. The order is storage/services (a), complete
configuration interfaces (b), public execution (c), editor (d), then answer surfaces,
documentation, operator setting and release acceptance (e). Each step depends only on the
row directly above it; e3 also needs the server-side booking export on main. No step borrows
an API, validator or permission check from a later step. In particular, the editor uses the
OpenAPI-generated `/api/v1` client in `apps/web/src/api/resources.ts`; configuration REST
writes, their MCP tools, invoking CLI commands, scope/parity registrations and generated
`apps/web/src/api/schema.d.ts` land together in the owning b-step. The same rule applies to
each public POST, including read-like resolve/slots operations.

### Rollout gating

Releases are cut by a manual tag on any main commit (`.github/workflows/release.yml`), so
every step below must be safe to ship on its own.

**Hard-off until e4c.** From a1b through e4b there is no operator-settable switch. Routing
is off in code: server composition passes `routingFormsEnabled: false` from a code constant,
not from an environment variable or any other setting, so no release tagged in that range
can turn routing on. Server integration tests enable routing only by injecting
`routingFormsEnabled: true` into the app or service dependencies under test, as existing
`slotSnippetsEnabled` tests do; jsdom tests fake the `/instance` response with
`routingFormsEnabled: true`. Before the editor exists, those fixtures author and publish
forms through the already completed configuration APIs. e4b builds and tests the setting
parser and the effective-state computation, but production composition keeps passing the
constant until e4c.

The constant is `routingFormsEnabled` in `apps/server/src/server.ts`, passed to
`productRoutes`; tests inject `true` there. The shared guard is
`apps/server/src/routing-forms.ts`: `requireRoutingFormsEnabled` for services, the REST
middleware `routingFormsGuard` and the MCP registration helper `routingFormTools`. Only the
boolean `true` enables. A REST operation lists the middleware last in its route middleware,
after nothing but the caller, `rateLimit` and `routeBodyLimit` (registration refuses anything
else, such as a per-user limit counted after authentication). The scope binding in
`apps/server/src/rest-scopes.ts` then runs it right after credential validation (including
the existing Origin/Referer check on cookie-authenticated writes) and before the API-key
scope check, also for a bearer supplied to a public route; anonymous requests meet it before
input validation. The helper marks tools so that `apps/server/src/mcp/tools.ts` leaves them
out of `tools/list` and answers a direct call before the scope check and argument checks.

**Setting from e4c.** e4c is the first step after configuration interfaces (b1–b3), public
execution (c1–c7), the complete editor with archive (d1–d3), host answer detail and screens
(e1–e2), the export's routing columns (e3), the documentation drafts (e4a) and the setting
plumbing (e4b) are all on main, so an operator who enables routing always gets the complete
feature, and its documentation goes live in the same step. e4c wires the operator setting
`ROUTING_FORMS_ENABLED` into server composition: `true` or `false`; unset or empty (Docker
Compose passes unset variables as empty strings) means the default, `false`; any other value
fails configuration validation at startup. e4c adds `${ROUTING_FORMS_ENABLED:-}` to
`docker-compose.yml` and an empty `ROUTING_FORMS_ENABLED=` to `.env.example`, with a comment
that empty means the server default, so installs that copy either file follow the default.
e5 changes the default to `true` once its acceptance passes, so self-hosted and Cloud
instances get the full feature by default, including those whose `.env` was copied from the
e4c `.env.example`; an explicit `false` remains the opt-out.

**Effective state.** Before e4c, routing is always off outside tests. From e4c, routing is
effectively on only when the setting is `true` and no stored personal handle `route` exists
(team slugs cannot collide). The server runs a1c's case-insensitive collision detector at
startup, logs a warning with the remedy when it finds one, and keeps routing off until an
operator-led rename with the owner and a server restart. The detector is
`findLegacyHandleCollisions(db)` in `packages/scheduling/src/profile.ts` (exported by
`@hourmere/scheduling`): it returns each stored handle matching `CLAIM_RESERVED_HANDLES` in
`packages/core/src/reserved.ts` with its owner's user ID, and changes nothing. e4b's
effective-state computation calls it, and e4c runs that computation in server composition at
startup. Because a1c rejects new `route` handles, no new collision can appear later. So
whenever routing is on, no legacy page exists under `/route`, and while it is off the legacy
pages keep being served.
`GET /api/v1/instance` reports the effective value as `routingFormsEnabled`; the web reads
only that field, never a separate build flag. Publishing never overrides it.

**What the off state still shows.** While routing is effectively off, no routing behaviour,
data or UI is reachable. The only exposures are names and schemas, listed after the
behaviour rules below.

- Every routing operation returns `404 routing_forms_disabled`, a feature-specific code
  following the existing `slot_snippets_disabled`: over REST, on a direct MCP tool call and
  therefore in the CLI. This covers configuration
  list/get/create/update/archive/publish/preview, public metadata and submission, and
  continuation resolve/slots/bookings (including `create_booking` and `book` with
  `routeToken`). Existing transport checks (body cap, credential validation, rate limits)
  run first, unchanged. The guard then runs before any scope/role check,
  organization/form/receipt/token lookup or body validation, so the response is identical
  for every form and token. One exception: on continuation booking, the ordinary booking
  request validation and authority checks run before the guard so that an exact authorized
  replay of an already committed routed booking, matched through the idempotency record and
  the presented token's digest, still returns that booking. No receipt is read or consumed;
  every other request gets `routing_forms_disabled`.
- A booking export request with `includeRoutingAnswers=true` returns
  `routing_forms_disabled` (before any team-export check); `false` or omission leaves
  personal and team exports unchanged.
- MCP `tools/list` omits all eleven routing tools in the contract table
  (`list_routing_forms`, `get_routing_form`, `create_routing_form`, `update_routing_form`,
  `archive_routing_form`, `publish_routing_form`, `preview_routing_form`,
  `get_public_routing_form`, `route_lead`, `resolve_routing_continuation`,
  `find_routed_slots`), as slot-snippet tools are absent from `productTools` when their flag
  is off (`apps/server/src/server.ts`). A direct `tools/call` of one of those names returns
  `routing_forms_disabled` rather than the SDK's unknown-tool error, through the
  catalogue-versus-visible dispatch seam that already answers scope-hidden tools
  (`apps/server/src/mcp/tools.ts`). The CLI prints that error code in its usual stderr error
  JSON and exits with code 1, like any tool error.
- The web shows no routing navigation entry and mounts neither the manager screens (they
  render the ordinary not-found page) nor the public `/route/...` pages. Those paths fall
  through to existing public page resolution, so a legacy `route` owner's pages are
  unaffected. `/route/continue` first clears any `#token=` fragment with
  `history.replaceState`, so a web invitee who opens a continuation link while routing is
  off cannot resume from that tab later; only someone still holding the original link can.
- Booking reads keep any routing provenance already stored with a booking (host detail,
  invitee management snapshot). On an instance that never enabled routing, nothing new
  appears.

Accepted name-level exposures while off, each from the step that adds it:

- `GET /api/v1/instance` reports `routingFormsEnabled: false` (a1b).
- The per-instance OpenAPI document lists each routing REST operation, documented as
  returning `routing_forms_disabled` while routing is off (b1, b2, b3, c2a, c2b, c4, c5b).
- The static CLI command table and help list `routing-forms …` commands (b1 onward).
- The generated API-key scope tables list every routing REST operation, MCP tool and CLI
  command from its owning step. CI requires every operation to be classified in
  `packages/auth/src/api-key-operations.ts`, and `scripts/api-key-scope-docs.ts` regenerates
  the tables on the live `/docs/api-keys` and `/docs/mcp` pages and in `docs/api-keys.md`
  and `docs/mcp.md`. This follows the off-by-default `generate_open_time_snippet`, which
  those tables already list. b1 adds one sentence next to the generated tables on those four
  pages, outside the generated markers: routing operations return `routing_forms_disabled`
  until an operator enables routing. That sentence is the only routing prose on live pages
  before e4c.
- Shared tool and route schemas carry their routing inputs: `routeToken` in `create_booking`
  and `book` (c5b), and `includeRoutingAnswers` in `export_bookings` and
  `GET /bookings/export.csv` (e3). Their descriptions say routing must be enabled.

**Turning the setting off later.** Setting `ROUTING_FORMS_ENABLED=false` and restarting after
routing was in use has exactly these effects:

- Existing forms are kept unchanged: drafts, published versions, enabled/archived states
  and slugs. Nothing is deleted, archived or unpublished. The editor and configuration
  operations are unavailable (`routing_forms_disabled`) until routing is re-enabled; forms are
  then exactly as they were.
- Published links stop working: public pages fall through as above and the public API
  returns `routing_forms_disabled` without metadata. Links never redirect to the target events.
  They work again when routing is re-enabled, with the usual form and target checks.
- Pending continuation tokens (unconsumed receipts) are refused with `routing_forms_disabled`
  and are not extended. Their absolute 30-minute lifetime keeps running, and cleanup keeps
  purging encrypted answers on schedule. A token still unexpired when routing is
  re-enabled works again for whoever still holds the original link (the continuation page
  cleared it from any tab that opened it while off); an expired one never does.
- Routed bookings already made stay ordinary bookings: confirmations, manage links,
  reschedule, cancel, host detail and invitee snapshots are unaffected, and exact replays of
  committed routed bookings still succeed. Only the export's routing columns are
  unavailable while off.
- Target-health invalidation and receipt/version cleanup keep running.

### Steps

All REST paths in the ownership table are relative to `/api/v1`. `P` abbreviates both
`/public/-/routing/{handle}/{slug}` and `/public/-/routing/teams/{teamSlug}/{slug}`; `-`
cannot be a valid user handle. A row saying “none” introduces no transport operation. Reuse
of an earlier operation is stated explicitly, so it does not imply a later adapter. “Off:”
in each acceptance cell is that step's check that, with routing off, none of the behaviour,
data or UI it adds is reachable; only the name-level exposures listed under Rollout gating
remain. “Hard-off” means the code constant above; “fixtures on” means tests inject
`routingFormsEnabled: true`.

| Step (~one day each) | What it builds | Owned REST / MCP / CLI operations | Depends on | Rollout state | Acceptance checks |
|---|---|---|---|---|---|
| a1a — Routing storage | Five-table migration, composite organization FKs, immutable history support, bounded form/version quotas with values chosen and pinned here | None; storage only | None | No routing code path exists | Check main/open-PR migration numbers; realistic predecessor preservation, fresh install and no-op rerun; DB types; cross-org FK negatives; quota boundaries. Off: the generated OpenAPI document, every route registered on the app as `startServer` assembles it (`createApp(productionAppOptions(…))`, built with every optional route group on — SCIM, MCP and its OAuth, slot snippets, webhooks, the Zoom event webhook, the waitlist pages and the web app — and the Google Calendar, Microsoft Calendar and Zoom clients configured), every `/…` string literal and every path built by a template literal or `+` concatenation in the production sources (non-test sources under each apps, packages and tools workspace's `src`; test support, fixtures and generated files excluded, each checked to be unreachable from the server, web and CLI entry points), the MCP tool list, the CLI command table and the web routes (the route table, `PATHS`, and every `<Route path>` and route object in non-test web sources, including `main.tsx` and descendant `<Routes>`) contain no routing-named path, operation, schema, tool, command or route, and no production source outside the storage layer (migration, generated table types, `routing-storage-*` files) imports the storage or names its tables (`scripts/routing-forms-off.test.ts`, `apps/web/src/routing-forms-off.test.tsx`); later steps delete or narrow those assertions as they add each surface. No catalogue is snapshotted or compared with a git base |
| a1b — Hard-off guard | Code constant `routingFormsEnabled = false` in server composition (no environment variable); shared guard returning `404 routing_forms_disabled` in the order stated under Rollout gating; MCP registration helper that omits routing tools from `tools/list` while off and answers their direct calls with that code; effective state in existing public config | Extend `GET /instance` (`routingFormsEnabled`), OpenAPI and generated web types; no new MCP tool/CLI command | a1a | Hard-off constant introduced | Guard ordering and identical response; injected `true` reaches guarded paths in tests only; setting `ROUTING_FORMS_ENABLED` in the environment changes nothing; a mutation flipping the constant fails a real assertion. Off: `/instance` reports `false` |
| a1c — Route namespace | Claim-time rejection of `route`, in any case, wherever a personal handle is claimed or changed (sign-up, profile edit, import); `RESERVED_NAMES`, `servedHandle` and team slugs unchanged; legacy collision detector for a stored personal handle `route`, wired into the effective state in e4c | None; extend existing personal-handle claim validation only | a1b | Hard-off | New or changed handle `route`/`Route`/`ROUTE` rejected on every claim path; a stored `route` handle's pages are still served; its owner can still save other profile fields with the unchanged handle, because `putProfile` revalidates the handle on every save and the claim check compares with the stored handle inside the same upsert, race-free; team slug `route` unaffected; detector finds the stored handle; no silent rename. Off: a legacy owner's pages resolve as today |
| a2 — Shared validation and evaluation | Question/rule validation, ordered first-match evaluator, target eligibility allowlist (enabled, nondeleted, listed or hidden, same organization, `booking_mode = 'individual'`, no payment requirement), complete answer-mapping validator | None; pure/shared services | a1c | Hard-off | Every type/operator/boundary, optional answers, AND/one-of/fallback; dangling IDs, incompatible destination fields/options and cross-org targets rejected; per-member personal/single-host targets accepted within the same organization; group-mode targets and a synthetic payment-requiring projection rejected with `invalid_routing_target`, for the reasons under Scheduling interactions; unknown modes fail closed. Off: no transport, nothing reachable |
| a3 — Configuration services and publication | Draft CRUD/archive, optimistic revisions, idempotency, atomic immutable publish, dependency generation and side-effect-free preview service | None; service entry points only | a2 | Hard-off | Concurrent publish has one winner; stale save/archive rejected; stable IDs/history; current membership and mapping/target validation inside publish transaction, including group/paid rejection for targets changed after draft save; preview writes no receipt/answers. Off: no transport, nothing reachable |
| a4 — Target lifecycle and retention | Invalidation on event delete/disable, booking-mode change and member departure; derived target health (`ok`, `unavailable`, `unknown`); bounded receipt/version cleanup jobs | None; extend existing mutation services without adding public operations | a3 | Hard-off | Publish/deletion/departure races respect organization → event → form → receipt order; fallback included; `unknown` never shown as missing configuration; no deletion blockers/history cascades; encrypted answers purged after expiry, consumed evidence retained; bounded pools/batches. Off: with no forms, existing event delete/disable/departure responses unchanged and jobs no-op |
| b1 — Configuration read/create/update/archive interfaces | Shared REST/MCP/CLI adapters, key scopes classified in `packages/auth/src/api-key-operations.ts` with regenerated scope tables and the one-sentence disabled note beside them, strict schemas, OpenAPI and generated web types. Both reads return a4's derived target health, rederived on read: per rule and fallback for the published version in `get`, a per-form summary in `list` | `GET /routing-forms`, `GET /routing-forms/{id}`, `POST /routing-forms`, `PATCH /routing-forms/{id}`, `DELETE /routing-forms/{id}`; `list_routing_forms`, `get_routing_form`, `create_routing_form`, `update_routing_form`, `archive_routing_form`; `routing-forms list/get/create/update/archive` | a4 | Hard-off; fixtures on | All transports share organization/role/scope matrix; read/full for reads, full for writes; Origin/Referer and expected-organization checks; create replay/revision conflicts; health present after a missed invalidation job, so d3 needs no API change; parity registry and scope-doc consistency; the parity inventory and the other catalogue tests that build `productTools` with `slotSnippetsEnabled: true` (capability contracts, MCP scopes, schema contracts) also pass `routingFormsEnabled: true`; generated-client checks. Off: every REST operation and direct MCP call returns `routing_forms_disabled` before any lookup and the CLI prints it; `tools/list` omits the five tools; no row written |
| b2 — Publish interfaces | Explicit publication adapter and authoritative publish errors | `POST /routing-forms/{id}/publish`; `publish_routing_form`; `routing-forms publish` | b1 | Hard-off; fixtures on | Full scope and current permissions; same-input publish retry vs changed-key input; invalid mappings/targets, including group and paid targets, rejected with `invalid_routing_target` across transports; parity/OpenAPI/types. Off: `routing_forms_disabled` over REST, direct MCP call and CLI; `tools/list` omits `publish_routing_form`; no version written |
| b3 — Preview interfaces | Author-only draft preview and diagnostics | `POST /routing-forms/{id}/preview`; `preview_routing_form`; `routing-forms preview` | b2 | Hard-off; fixtures on | Full scope; evaluator parity; no anonymous preview, persistence, tokens or notification; CLI stdin/file JSON; parity/OpenAPI/types. Off: `routing_forms_disabled` over REST, direct MCP call and CLI; `tools/list` omits `preview_routing_form`; no evaluation runs |
| c1 — Receipt and admission services | Purpose-bound encryption/digests with keys derived from `BETTER_AUTH_SECRET`, absolute expiry, `routingSubmission` and `routingContinuation` bucket definitions, form and instance admission ceilings | None; routing submission service only | b3 | Hard-off; fixtures on | Pin bucket and ceiling values and the limiter definitions; live-receipt ceilings counted under their locks without overshoot; depth/unknown keys/overlong raw strings fail before storage; message result retains nothing; key derivation, purpose separation and expiry. Off: service refuses before storing a receipt or counting admission |
| c2a — Public form metadata adapters | Personal/team public projection with `versionId`, questions and labels; no predicates, alternative targets or hidden slugs | `GET P` (personal and team); `get_public_routing_form`; `routing-forms public` | c1 | Hard-off; fixtures on | Anonymous and supplied-bearer scope rules; `page` bucket on both routes, counting refused requests; collision-free personal/team paths; unknown and archived forms share the neutral not-found response; no predicates, alternative targets or hidden slugs; parity/OpenAPI/types. Off: both paths and direct MCP calls return `routing_forms_disabled` without metadata, for existing and unknown forms alike; `tools/list` omits `get_public_routing_form` |
| c2b — Route submission adapters | Version-pinned submission and receipt response with server-built `continuationUrl`; CLI redaction and `--output` handling | `POST P/route` (personal and team); `route_lead`; `routing-forms route` | c2a | Hard-off; fixtures on | Anonymous and supplied-bearer scope rules; `routingSubmission` bucket on both routes, counting refused and invalid requests; unescaped and fully `\uXXXX`-escaped maximum submissions accepted, one byte over the cap `413 payload_too_large`; stale version refresh; token/body log redaction; CLI stdout redacts `routeToken`/`continuationUrl` and `--output` writes them to a new 0600 file; CLI help documents it; parity/OpenAPI/types. Off: both paths and direct MCP calls return `routing_forms_disabled` without minting a receipt; `tools/list` omits `route_lead` |
| c3 — Public form page | Accessible question UI on `/route/{handle}/{slug}` and `/route/team/{teamSlug}/{slug}`, validation and stale-form recovery in every shipped public locale | None; consumes c2a/c2b through generated client | c2b | Hard-off; fixtures on | All question types, keyboard/labels/errors, jsdom/accessibility; preserve compatible answers in memory only; no URL answers; message outcomes and neutral unavailable page; navigates to the returned `continuationUrl`; `apps/web/src/public/routes.test.tsx` accepts `/route` as claim-reserved (not in `RESERVED_NAMES`) and asserts the pages mount only while `routingFormsEnabled` is true. Off: paths fall through to existing public page resolution; no metadata request |
| c4 — Continuation resolution and slots | Token-bound current target projection, mapped prefill and ordinary availability | `POST /routing-continuations/resolve`, `POST /routing-continuations/slots`; `resolve_routing_continuation`, `find_routed_slots`; `routing-forms resolve/slots` | c3 | Hard-off; fixtures on | Thirty-minute absolute lifetime; repeated reads do not consume/extend receipt; `routingContinuation` bucket on both routes, counting refused and invalid requests; guessed/expired/archived/broken target fails neutrally; title/duration and required booking fields without hidden slug/path; mapping revalidation; no assignment advance; CLI redacts the input token; parity/OpenAPI/types. Off: `routing_forms_disabled` for valid, expired and unknown tokens alike, over REST, direct MCP call and CLI; `tools/list` omits `resolve_routing_continuation` and `find_routed_slots`; receipts untouched |
| c5a — Routed booking service | Atomic consume, provenance and answer snapshot with ordinary booking/host/outbox writes; receipt identity in the idempotency fingerprint; `successRedirect` snapshot suppression at creation | None; extend the existing booking service only | c4 | Hard-off; fixtures on | Concurrent use yields one booking; rollback leaves receipt usable; same lock order and snapshot labels; no redirect snapshot stored; minimal consumed evidence without token or duplicate ciphertext. Off: service refuses before consuming anything; only an exact committed replay returns |
| c5b — Routed booking interfaces | Route-capability booking adapter declaring `routeBodyLimit(BOOKING_BODY_LIMIT)` (2 MiB) like the existing booking routes, dedicated booking/replay projection without reusable path or redirect fields, one-time-link exclusion | `POST /routing-continuations/bookings`; extend `create_booking` and `book` with mutually exclusive `routeToken` selector; existing direct booking operations unchanged | c5a | Hard-off; fixtures on | The largest legal booking body with every character escaped is accepted and one byte over 2 MiB gets `413 payload_too_large`; authorized exact replay after expiry; changed input/key rejected; no `successRedirect` response field or Continue link on creation or replay; `routeToken` with a one-time token rejected; `book` bucket; CLI redacts the input token; parity/OpenAPI/types. Off: `routing_forms_disabled` except an exact committed replay; `create_booking` stays listed and direct booking is unchanged |
| c6 — Continuation booking UI and handoff | `/route/continue#token=…`, immediate fragment clearing, editable prefill and booking confirmation using selected-event projection | None; consumes c4/c5b through generated client | c5b | Hard-off; fixtures on | Agent-to-invitee link contains token only; no-referrer/no-store and no persistent browser storage; matched hidden event books without exposing direct path; no after-booking redirect Continue link; expired/consumed neutral recovery; public locales and accessible jsdom tests. Off: page clears the fragment, then falls through; no API call |
| c7 — Scheduling integration matrix | Finish shared booking lifecycle integration across host modes, reschedule/cancel, waitlist and unsupported combinations | Extend existing personal/team booking and host/invitee reschedule/cancel service behavior only; no new endpoint/tool/command | c6 | Hard-off; fixtures on | Round-robin assigns once on commit/replay; collective hosts preserved; DST/duration/notice checks; cancel/reschedule preserve routing snapshot without reviving receipt; routing waitlist controls absent; ordinary direct waitlist unchanged and never inherits answers; paid/group/one-time combinations rejected and a routed booking never enters `pending_payment`; no email/ICS/provider/webhook answer expansion. Off: existing booking lifecycle suites pass unchanged |
| d1 — Question editor and archive | Manager list/draft screens, stable-ID question/option ordering and archive with confirmation in en + zh-CN, so every form the web can create can be removed in the web | None; consumes b1 (including `DELETE /routing-forms/{id}`) through generated client | c7 | Hard-off; fixtures on | Create/edit/reorder questions/options; keyboard reorder, jsdom; archived forms leave the active list and block new submissions; natural Chinese/full-width punctuation; preserve weekly-hours hint and neutral loading/403/error states. Off: no navigation entry; manager routes show the ordinary not-found page; no routing request issued |
| d2 — Rule and mapping editor | Ordered rules, targets, fallback and answer-mapping controls in en + zh-CN | None; consumes b1/b3 and the existing `GET /event-types` and `GET /event-types/{id}` reads (targets, destination questions and options) through generated client | d1 | Hard-off; fixtures on | First-match order, per-member event selection, hidden targets, mapping validation and preview; accessible controls and jsdom tests. Off: no rule or mapping control reachable; no routing request issued |
| d3 — Publication and repair editor | Publish, disable and re-enable flows, fallback review, version conflicts and broken-target repair from b1's health in en + zh-CN | None; consumes b1/b2/b3 through generated client | d2 | Hard-off; fixtures on | End-to-end author draft → preview → publish using shipped APIs; stale-editor recovery, disable acknowledgement, health display and repair; no public enablement from editor. Off: no publication or repair control reachable; no routing request issued |
| e1 — Host answer detail interfaces | Optional authorized host `routing` projection; explicit MCP host-detail read | Extend `GET /bookings/{id}`; add `get_booking` and CLI `booking` (read/bookings/full); no new REST write | d3 | Hard-off; fixtures on | Positive snapshot/version/rule assertions; live host/org authorization; no routing addition to team-admin list/detail, webhooks or ordinary broad lists; OpenAPI/types and MCP/CLI contract tests. Off: no `routing` field on bookings without provenance; stored provenance still shown |
| e2 — Host and invitee answer screens | Host booking detail in en + zh-CN; invitee private management snapshot in public locales | Extend `GET /bookings/manage` projection; host web consumes e1; no new MCP/CLI operation for private manage UI | e1 | Hard-off; fixtures on | Host sees original routing and final booking answers distinctly; invitee sees only own answer snapshot, no rule IDs/names/diagnostics/other targets; existing manage-token authority; reschedule history and escaping; locale/jsdom checks. Off: screens add nothing for bookings without provenance |
| e3 — Routing columns in booking CSV export | Adds an opt-in routing column group (`routing_form_id`, `routing_form_version`, `routing_matched_rule_id`, `routing_resolved_rule_id`, `routing_answers` JSON keyed by question ID with label snapshots) to personal exports of the existing server-side booking CSV export (`GET /bookings/export.csv`, `export_bookings`, CLI `export`). No substitute export is built | Extend `GET /bookings/export.csv` (`includeRoutingAnswers` `true` or `false`), `export_bookings` and `export`; no new operation | e2, plus the server-side booking CSV export (`exportBookingsCsv`, `export_bookings`, CLI `export`) on main (accepted external dependency; e3 starts only after it lands) | Hard-off; fixtures on | Personal read/full only, same as the export; team exports refuse `includeRoutingAnswers=true` with `invalid_request`, treat `false` as omission and keep the team-admin whitelist; the export's formula protection, JSON escaping, row bounds and streaming apply to the new cells; web en + zh-CN choice; parity/OpenAPI/types. Off: web hides the choice, `includeRoutingAnswers=true` returns `routing_forms_disabled` over REST, MCP (`export_bookings` stays listed) and CLI; `false` and ordinary exports unchanged |
| e4a — Operator and agent documentation | New routing guide pages (how-to, all interface examples, capability handoff, limits/privacy, the setting and its off-state effects) written as Starlight drafts (`draft: true`, excluded from production builds); existing live guides are not edited here | None | e3 | Hard-off | Examples match registered tools/CLI; explain hidden targets, token lifetime/single booking use, answer retention, export opt-in, `routing_forms_disabled` and the MCP listing rule; document legacy namespace collision remediation; self-hosted/Cloud parity; site tests account for draft pages. Off: no routing guide page is published (drafts, no sidebar entry in the production build); generated scope-table rows and OpenAPI entries exist and are documented as disabled; live guides carry no routing prose beyond b1's scope-table sentence |
| e4b — Operator setting plumbing | `ROUTING_FORMS_ENABLED` parser (`true`/`false`, unset or empty = `false`, other values rejected), effective-state computation with a1c's startup collision check and warning, all tested with injected configuration; production composition still passes the hard-off constant | None | e4a | Hard-off | Parser accepts `true`/`false`, treats unset and empty as `false` and rejects other values; effective state is off with a legacy `route` handle and logs the remedy; every “turning the setting off later” effect above has a test with injected configuration; a mutation that wires the parsed value into production composition fails a real assertion. Off: the environment variable still changes nothing; the a1b–e4a off checks pass unchanged |
| e4c — Enablement and documentation release | Wire the parsed setting into server composition in place of the constant; `docker-compose.yml` entry `${ROUTING_FORMS_ENABLED:-}`; empty `ROUTING_FORMS_ENABLED=` in `.env.example` with a comment that empty means the server default; README and OpenAPI/MCP/CLI descriptions name the setting; publish the e4a pages with sidebar entries, and add routing prose to the existing live guides `cli.md`, `mcp.md`, `rest.md`, `index.md`, the `api-keys.md` prose, the configuration reference and the after-booking guide “Current limits” | None new; `GET /instance` now reports the setting-derived effective state | e4b | Setting introduced, default `false` | `true` runs the full flow in an integration test with environment-derived config, with all eleven routing tools listed; unset and empty both mean `false`; invalid value fails startup; a collision forces off with a warning; the after-booking guide states that bookings made through a routing form, on `/route/continue` or with a `routeToken` over REST/MCP/CLI, receive no after-booking continuation even when the event type has one; built site includes the routing pages and links. Off: with the setting unset, empty or `false`, the a1b–e4b off checks pass unchanged and the published pages describe the setting as off by default and how to enable it |
| e5 — Independent acceptance and default on | Complete synthetic public → route → booking → host/invitee/export acceptance; change the `ROUTING_FORMS_ENABLED` default (unset or empty) to `true` and update the `.env.example` comment, README, the configuration reference and every documented default, keeping `ROUTING_FORMS_ENABLED=` empty | None | e4c (therefore every earlier step) | Merging e5 changes the default to `true`; explicit `false` opts out | Default configuration (no environment value, the Compose default, and a `.env` copied from the e4c `.env.example`) end-to-end matrix; upgrading an instance with no forms only adds the navigation entry, the `/route` pages and the eleven routing tools in `tools/list`; a legacy collision still keeps routing off; privacy/replay/deletion mutation controls; full gates and CI including e2e using fakes; author-side review followed by project-lead independent acceptance. e5 merges only after that acceptance passes. Off: explicit `false` reruns every earlier step's off checks |

Each implementation step adds assertion-failing source-copy mutations for its protections
and owns its focused tests and generated artifacts. The final e5 step runs the full release
matrix rather than deferring missing implementation to acceptance. This design's doc-fact
test checks only the numeric register, the unescaped and fully escaped maximum submission
against the cap and the server's default body limit, and mutation controls; it does not
claim to test routing behavior that does not exist yet. The design PR introduced no schema
changes or product surfaces; the storage step now installs migration 0072 without adding
product strings or UI.

## Out of scope and known limitations

Deferred: external redirects, narrowing a pool to a member subset, CRM/attribute routing, expression
nesting/contains/ranges, extra question types, conditional/hidden fields, routing embeds,
paid/group targets, routing-continuation waitlist enrollment, imported forms, automatic translation of author content, experiments,
aggregate analytics and abandoned-lead exports. Public system strings will use all shipped
public locales; author-written labels/messages remain in the author's language initially.
No CAPTCHA, verified lead identity, routing-only access gate or slot reservation. Users can
share ordinary booking URLs and infer policies from repeated public outcomes. Expired
answers may remain in operator backups; physical purge depends on working maintenance.

- Archiving frees one of the 100 non-archived form slots, but retained archived forms
  still count toward the 1000 total-forms storage cap. No public purge or unarchive
  operation is provided by this storage step.
- After-booking redirects are not offered for routing-continuation bookings, for listed and
  hidden targets alike and including exact replays. A host who relies on a redirect for a
  thank-you or conversion page does not get it for routed bookings; direct bookings of the
  same event keep it. The after-booking guide's “Current limits” section states this (e4c).
- Routing answers of team-form bookings are not exported: team exports keep the
  team-admin whitelist, so those answers are visible only in authorized host booking detail.
- While routing is off, the export's routing columns are unavailable; booking detail and
  invitee snapshots keep showing stored routing answers.

No decisions in this document alter the accepted team-admin data whitelist.
