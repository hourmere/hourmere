# Routing forms — proposed design

Status: design only; no routing form is available yet. This proposal adds no tables,
routes, UI or plan checks. The eventual feature is free on self-hosted and Cloud alike,
and is on by default once the final acceptance step passes (see [Rollout gating](#rollout-gating)).
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
until an explicit operator-led rename with the owner; never silently take over or
de-serve an existing URL.
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
fit the cap, so clients may send either encoding. Versions and organization form quotas
are chosen and pinned in step a1a; their numeric values are not fixed here. Public
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
- Paid bookings: Hourmere has no payment capability, and none is added here. A receipt is
  consumed when the booking commits; nothing can bind that consumption to payment
  completion or checkout expiry, so a paid target could bypass a required payment or
  consume a receipt for an unpaid booking. Target eligibility is therefore an allowlist
  that fails closed: any payment requirement a later event setting adds is rejected at
  publication (validator a2, publish transaction a3) and treated as a broken target at
  runtime until a paid-event contract exists. Future payment failures must not consume a
  receipt or advance fairness. No provider calls from routing.
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

## Table sketch (proposal, not a migration)

Application tables live in `public`, snake_case; UUIDv7 keys and `timestamptz` instants.
Every organization reference is an FK to `auth.organization`; organization deletion
cascades. Use composite unique keys/FKs to prevent cross-organization associations.

| Table | Columns and constraints | Indexes |
|---|---|---|
| `routing_forms` | `id`, `organization_id`, `slug`, `created_by_user_id` (historical UUID, no user FK), `draft` JSONB, `draft_revision`, nullable `published_version_id`, `enabled`, `archived_at`, timestamps; unique organization/slug and organization/id; positive revision | organization + creation time + id for keyset lists; scoped slug unique |
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
| `GET /public/-/routing/{handle}/{slug}`, `GET /public/-/routing/teams/{teamSlug}/{slug}` | `get_public_routing_form` | `routing-forms public` | Anonymous/public metadata; explicit personal/team paths |
| `POST /public/-/routing/{handle}/{slug}/route`, `POST /public/-/routing/teams/{teamSlug}/{slug}/route` | `route_lead` | `routing-forms route` | Anonymous or bookings/full; explicit personal/team paths |
| `POST /routing-continuations/resolve`, `POST /routing-continuations/slots` | `resolve_routing_continuation`, `find_routed_slots` | `routing-forms resolve`, `routing-forms slots` | Route capability; bookings/full when bearer supplied |
| `POST /routing-continuations/bookings` using the existing booking service with `routeToken` (no event URL selector) | `create_booking` | `book` | Existing booking authority plus route capability |
| Extend `GET /bookings/{id}` | New `get_booking` | New `booking` (flat, like `event` and `schedule`) | Current host/org authority; read/bookings/full |
| Extend `GET /bookings/manage` | No new tool (private manage-token UI) | No new command | Existing invitee manage-token authority; own answer snapshot only |
| Extend `GET /bookings/export.csv` with `includeRoutingAnswers` (`true` or `false`; step e3, once the booking export is on main) | Extend `export_bookings` | Extend `export` | Existing personal export authority (read/full); team exports refuse the option |

While routing is effectively off, every routing operation in this table returns
`404 feature_disabled`: for `create_booking` and `book` only requests carrying `routeToken`,
and an exact committed routed-booking replay still succeeds. The export's
`includeRoutingAnswers` option returns the same error; the two booking-read extensions keep
returning stored routing provenance. See [Rollout gating](#rollout-gating).

Draft create and publish each take a client-generated UUID `requestId` scoped to
actor/organization for idempotency. Publish/update/archive take `expectedRevision`; a
repeated publish with the same requestId and canonical input returns its original version.
Changed input with the same key returns `idempotency_key_reused`. Route submission takes `{
versionId, answers }`; it intentionally has no durable replay cache containing raw tokens.
On lost response the invitee submits again and gets a new expiring receipt, within the
admission ceilings. Each receipt remains single-use; only booking idempotency prevents
duplicate booking retries. CLI JSON input comes from stdin/file, not answer-bearing
command-line arguments; CLI/MCP must treat returned route capabilities as sensitive and
never emit them to diagnostic logs. The CLI already redacts management capabilities on
stdout. `routing-forms route` therefore prints `routeToken` and `continuationUrl` as
`[redacted]` on stdout and writes them only with the existing `--output FILE` flag, into a
new 0600 JSON file, exactly like returned manage tokens. `routing-forms resolve`,
`routing-forms slots` and `book` accept `routeToken` only in JSON input and redact it from
stdout, `--output` files and errors. CLI help and the CLI guide document this. MCP
`route_lead` returns both fields in its result.

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
| 400 `invalid_request` | `includeRoutingAnswers` on a team export |
| 401 `unauthorized`, 403 `insufficient_scope` | Existing credential rules |
| 403 `team_management_access_denied` | Uniform unauthorized team configuration access |
| 404 `routing_form_not_found` | Unknown/out-of-scope private form or unavailable public form, without existence clues |
| 404 `feature_disabled` | Routing is effectively off on this instance. After existing transport checks, the response is identical for every form and token, except that an exact committed routed-booking replay still returns its booking; retry only after the operator enables routing |
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

The later project plan is rescheduled into the named steps below, each budgeted at about
one working day including its focused tests. The order is storage/services (a), complete
configuration interfaces (b), public execution (c), editor and operator setting (d), then
answer surfaces, documentation and release acceptance (e). Each step depends only on the
row directly above it. No step borrows an API, validator or permission check from a later
step. In particular, the editor uses the OpenAPI-generated `/api/v1` client in
`apps/web/src/api/resources.ts`; configuration REST writes, their MCP tools, invoking CLI
commands, scope/parity registrations and generated `apps/web/src/api/schema.d.ts` land
together in the owning b-step. The same rule applies to each public POST, including
read-like resolve/slots operations.

### Rollout gating

Releases are cut by a manual tag on any main commit (`.github/workflows/release.yml`), so
every step below must be safe to ship on its own.

**Hard-off until d4.** From a1b through d3 there is no operator-settable switch. Routing is
off in code: server composition passes `routingFormsEnabled: false` from a code constant,
not from an environment variable or any other setting, so no release tagged in that range
can turn routing on. Server integration tests enable routing only by injecting
`routingFormsEnabled: true` into the app or service dependencies under test, as existing
`slotSnippetsEnabled` tests do; jsdom tests fake the `/instance` response with
`routingFormsEnabled: true`. Before the editor exists, those fixtures author and publish
forms through the already completed configuration APIs.

**Setting from d4.** d4 is the first step after configuration interfaces (b1–b3), public
execution (c1–c7) and the complete editor with archive (d1–d3) are all on main. It replaces
the constant with the operator setting `ROUTING_FORMS_ENABLED`: `true` or `false`; unset or
empty (Docker Compose passes unset variables as empty strings) means the default, `false`;
any other value fails configuration validation at startup. d4 adds the setting to
`docker-compose.yml` as `${ROUTING_FORMS_ENABLED:-}`, so Compose operators can set it and
the server's own default applies otherwise. e5 changes the default to `true` once its
acceptance passes, so self-hosted and Cloud instances get the full feature by default; an
explicit `false` remains the opt-out. An operator who opts in on a release between d4 and e4
gets working forms, editor and public execution, but host answer detail, the export's
routing columns and public documentation arrive only in e1–e4. Routing snapshots stored
after opting in appear in host detail once e1–e2 ship; mapped answers are ordinary booking
answers immediately.

**Effective state.** Before d4, routing is always off outside tests. From d4, routing is
effectively on only when the setting is `true` and no stored personal handle `route` exists
(team slugs cannot collide). The server runs a1c's case-insensitive collision detector at
startup, logs a warning with the remedy when it finds one, and keeps routing off until an
operator-led rename and a restart. Because a1c rejects new `route` handles, no new collision
can appear later. So whenever routing is on, no legacy page exists under `/route`, and while
it is off the legacy pages keep being served. `GET /api/v1/instance` reports the effective
value as `routingFormsEnabled`; the web reads only that field, never a separate build flag.
Publishing never overrides it.

**What the off state exposes.** While routing is effectively off:

- Every routing operation returns `404 feature_disabled` over REST, MCP and CLI:
  configuration list/get/create/update/archive/publish/preview, public metadata and
  submission, and continuation resolve/slots/bookings (including `create_booking` and
  `book` with `routeToken`). Existing transport checks (body cap, credential validation,
  rate limits) run first, unchanged. The guard then runs before any scope/role check,
  organization/form/receipt/token lookup or body validation, so the response is identical
  for every form and token. One exception: on continuation booking, the ordinary booking
  request validation and authority checks run before the guard so that an exact
  authorized replay of an already committed routed booking, matched through the
  idempotency record and the presented token's digest, still returns that booking. No
  receipt is read or consumed; every other request gets `feature_disabled`.
- A booking export request with `includeRoutingAnswers=true` returns `feature_disabled`;
  `false` or omission leaves exports unchanged.
- Operation names stay registered in OpenAPI, the MCP tool list and the CLI command table.
  This is a deliberate choice so every transport returns the same documented
  `feature_disabled`; the parity inventory alone would allow omitting MCP tools while off,
  as is done for the slot-snippet tools. Consequently releases from b1 onward list routing
  tools and commands even while routing is hard-off. No form metadata, tokens, screens,
  navigation entries or writes are reachable, and no answers beyond those already stored
  with bookings.
- The web shows no routing navigation entry and mounts neither the manager screens (they
  render the ordinary not-found page) nor the public `/route/...` pages. Those paths fall
  through to existing public page resolution, so a legacy `route` owner's pages are
  unaffected. `/route/continue` first clears any `#token=` fragment with
  `history.replaceState`, so a web invitee who opens a continuation link while routing is
  off cannot resume from that tab later; only someone still holding the original link can.
- Booking reads keep any routing provenance already stored with a booking (host detail,
  invitee management snapshot). On an instance that never enabled routing, nothing new
  appears.

**Turning the setting off later.** Setting `ROUTING_FORMS_ENABLED=false` and restarting after
routing was in use has exactly these effects:

- Existing forms are kept unchanged: drafts, published versions, enabled/archived states
  and slugs. Nothing is deleted, archived or unpublished. The editor and configuration
  operations are unavailable (`feature_disabled`) until routing is re-enabled; forms are
  then exactly as they were.
- Published links stop working: public pages fall through as above and the public API
  returns `feature_disabled` without metadata. Links never redirect to the target events.
  They work again when routing is re-enabled, with the usual form and target checks.
- Pending continuation tokens (unconsumed receipts) are refused with `feature_disabled`
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
`/public/-/routing/{handle}/{slug}` and `/public/-/routing/teams/{teamSlug}/{slug}`;
`-` cannot be a valid user handle. A row saying “none” introduces no transport operation.
Reuse of an earlier operation is stated explicitly, so it does not imply a later adapter.
“Off:” in each acceptance cell is that step's check that the off state exposes nothing it
adds. “Hard-off” means the code constant above; “fixtures on” means tests inject
`routingFormsEnabled: true`.

| Step (~one day each) | What it builds | Owned REST / MCP / CLI operations | Depends on | Rollout state | Acceptance checks |
|---|---|---|---|---|---|
| a1a — Routing storage | Five-table migration, composite organization FKs, immutable history support, bounded form/version quotas with values chosen and pinned here | None; storage only | None | No routing code path exists | Check main/open-PR migration numbers; realistic predecessor preservation, fresh install and no-op rerun; DB types; cross-org FK negatives; quota boundaries. Off: OpenAPI document, MCP tool list, CLI commands and web routes unchanged |
| a1b — Hard-off guard | Code constant `routingFormsEnabled = false` in server composition (no environment variable); shared guard returning `404 feature_disabled` in the order stated under Rollout gating; effective state in existing public config | Extend `GET /instance` (`routingFormsEnabled`), OpenAPI and generated web types; no new MCP tool/CLI command | a1a | Hard-off constant introduced | Guard ordering and identical response; injected `true` reaches guarded paths in tests only; setting `ROUTING_FORMS_ENABLED` in the environment changes nothing; a mutation flipping the constant fails a real assertion. Off: `/instance` reports `false` |
| a1c — Route namespace | Claim-time rejection of `route`, in any case, wherever a personal handle is claimed or changed (sign-up, profile edit, import); `RESERVED_NAMES`, `servedHandle` and team slugs unchanged; legacy collision detector for a stored personal handle `route`, wired into the effective state in d4 | None; extend existing personal-handle claim validation only | a1b | Hard-off | New or changed handle `route`/`Route`/`ROUTE` rejected on every claim path; a stored `route` handle's pages are still served; team slug `route` unaffected; detector finds the stored handle; no silent rename. Off: a legacy owner's pages resolve as today |
| a2 — Shared validation and evaluation | Question/rule validation, ordered first-match evaluator, target eligibility allowlist (enabled, nondeleted, listed or hidden, same organization, `booking_mode = 'individual'`, no payment requirement), complete answer-mapping validator | None; pure/shared services | a1c | Hard-off | Every type/operator/boundary, optional answers, AND/one-of/fallback; dangling IDs, incompatible destination fields/options and cross-org targets rejected; per-member personal/single-host targets accepted within the same organization; group-mode targets and a synthetic payment-requiring projection rejected with `invalid_routing_target`, for the reasons under Scheduling interactions; unknown modes fail closed. Off: no transport, nothing reachable |
| a3 — Configuration services and publication | Draft CRUD/archive, optimistic revisions, idempotency, atomic immutable publish, dependency generation and side-effect-free preview service | None; service entry points only | a2 | Hard-off | Concurrent publish has one winner; stale save/archive rejected; stable IDs/history; current membership and mapping/target validation inside publish transaction, including group/paid rejection for targets changed after draft save; preview writes no receipt/answers. Off: no transport, nothing reachable |
| a4 — Target lifecycle and retention | Invalidation on event delete/disable, booking-mode change and member departure; derived target health (`ok`, `unavailable`, `unknown`); bounded receipt/version cleanup jobs | None; extend existing mutation services without adding public operations | a3 | Hard-off | Publish/deletion/departure races respect organization → event → form → receipt order; fallback included; `unknown` never shown as missing configuration; no deletion blockers/history cascades; encrypted answers purged after expiry, consumed evidence retained; bounded pools/batches. Off: with no forms, existing event delete/disable/departure responses unchanged and jobs no-op |
| b1 — Configuration read/create/update/archive interfaces | Shared REST/MCP/CLI adapters, key scopes, strict schemas, OpenAPI and generated web types. Both reads return a4's derived target health, rederived on read: per rule and fallback for the published version in `get`, a per-form summary in `list` | `GET /routing-forms`, `GET /routing-forms/{id}`, `POST /routing-forms`, `PATCH /routing-forms/{id}`, `DELETE /routing-forms/{id}`; `list_routing_forms`, `get_routing_form`, `create_routing_form`, `update_routing_form`, `archive_routing_form`; `routing-forms list/get/create/update/archive` | a4 | Hard-off; fixtures on | All transports share organization/role/scope matrix; read/full for reads, full for writes; Origin/Referer and expected-organization checks; create replay/revision conflicts; health present after a missed invalidation job, so d3 needs no API change; parity registry and generated-client checks. Off: every operation returns `feature_disabled` over REST/MCP/CLI before any lookup; no row written |
| b2 — Publish interfaces | Explicit publication adapter and authoritative publish errors | `POST /routing-forms/{id}/publish`; `publish_routing_form`; `routing-forms publish` | b1 | Hard-off; fixtures on | Full scope and current permissions; same-input publish retry vs changed-key input; invalid mappings/targets, including group and paid targets, rejected with `invalid_routing_target` across transports; parity/OpenAPI/types. Off: `feature_disabled`; no version written |
| b3 — Preview interfaces | Author-only draft preview and diagnostics | `POST /routing-forms/{id}/preview`; `preview_routing_form`; `routing-forms preview` | b2 | Hard-off; fixtures on | Full scope; evaluator parity; no anonymous preview, persistence, tokens or notification; CLI stdin/file JSON; parity/OpenAPI/types. Off: `feature_disabled`; no evaluation runs |
| c1 — Receipt and admission services | Purpose-bound encryption/digests with keys derived from `BETTER_AUTH_SECRET`, absolute expiry, `routingSubmission` and `routingContinuation` bucket definitions, form and instance admission ceilings | None; routing submission service only | b3 | Hard-off; fixtures on | Pin bucket and ceiling values and the limiter definitions; live-receipt ceilings counted under their locks without overshoot; depth/unknown keys/overlong raw strings fail before storage; message result retains nothing; key derivation, purpose separation and expiry. Off: service refuses before storing a receipt or counting admission |
| c2 — Public metadata and submission adapters | Personal/team public projection, version-pinned submission and receipt response with server-built `continuationUrl` | `GET P`, `POST P/route`; `get_public_routing_form`, `route_lead`; `routing-forms public/route` | c1 | Hard-off; fixtures on | Anonymous and supplied-bearer scope rules; `page` and `routingSubmission` buckets on the routes, counting refused and invalid requests; unescaped and fully `\uXXXX`-escaped maximum submissions accepted, one byte over the cap `413 payload_too_large`; collision-free personal/team paths; stale version refresh; token/body log redaction; CLI stdout redacts `routeToken`/`continuationUrl` and `--output` writes them to a new 0600 file; no predicates, alternative targets or hidden slugs; parity/OpenAPI/types. Off: both paths return `feature_disabled` without metadata, for existing and unknown forms alike |
| c3 — Public form page | Accessible question UI on `/route/{handle}/{slug}` and `/route/team/{teamSlug}/{slug}`, validation and stale-form recovery in every shipped public locale | None; consumes c2 through generated client | c2 | Hard-off; fixtures on | All question types, keyboard/labels/errors, jsdom/accessibility; preserve compatible answers in memory only; no URL answers; message outcomes and neutral unavailable page; navigates to the returned `continuationUrl`; `apps/web/src/public/routes.test.tsx` accepts `/route` as claim-reserved (not in `RESERVED_NAMES`) and asserts the pages mount only while `routingFormsEnabled` is true. Off: paths fall through to existing public page resolution; no metadata request |
| c4 — Continuation resolution and slots | Token-bound current target projection, mapped prefill and ordinary availability | `POST /routing-continuations/resolve`, `POST /routing-continuations/slots`; `resolve_routing_continuation`, `find_routed_slots`; `routing-forms resolve/slots` | c3 | Hard-off; fixtures on | Thirty-minute absolute lifetime; repeated reads do not consume/extend receipt; `routingContinuation` bucket on both routes, counting refused and invalid requests; guessed/expired/archived/broken target fails neutrally; title/duration and required booking fields without hidden slug/path; mapping revalidation; no assignment advance; CLI redacts the input token; parity/OpenAPI/types. Off: `feature_disabled` for valid, expired and unknown tokens alike; receipts untouched |
| c5a — Routed booking service | Atomic consume, provenance and answer snapshot with ordinary booking/host/outbox writes; receipt identity in the idempotency fingerprint; `successRedirect` snapshot suppression at creation | None; extend the existing booking service only | c4 | Hard-off; fixtures on | Concurrent use yields one booking; rollback leaves receipt usable; same lock order and snapshot labels; no redirect snapshot stored; minimal consumed evidence without token or duplicate ciphertext. Off: service refuses before consuming anything; only an exact committed replay returns |
| c5b — Routed booking interfaces | Route-capability booking adapter, dedicated booking/replay projection without reusable path or redirect fields, one-time-link exclusion | `POST /routing-continuations/bookings`; extend `create_booking` and `book` with mutually exclusive `routeToken` selector; existing direct booking operations unchanged | c5a | Hard-off; fixtures on | Authorized exact replay after expiry; changed input/key rejected; no `successRedirect` response field or Continue link on creation or replay; `routeToken` with a one-time token rejected; `book` bucket; CLI redacts the input token; parity/OpenAPI/types. Off: `feature_disabled` except an exact committed replay; direct booking unchanged |
| c6 — Continuation booking UI and handoff | `/route/continue#token=…`, immediate fragment clearing, editable prefill and booking confirmation using selected-event projection | None; consumes c4/c5b through generated client | c5b | Hard-off; fixtures on | Agent-to-invitee link contains token only; no-referrer/no-store and no persistent browser storage; matched hidden event books without exposing direct path; no after-booking redirect Continue link; expired/consumed neutral recovery; public locales and accessible jsdom tests. Off: page clears the fragment, then falls through; no API call |
| c7 — Scheduling integration matrix | Finish shared booking lifecycle integration across host modes, reschedule/cancel, waitlist and unsupported combinations | Extend existing personal/team booking and host/invitee reschedule/cancel service behavior only; no new endpoint/tool/command | c6 | Hard-off; fixtures on | Round-robin assigns once on commit/replay; collective hosts preserved; DST/duration/notice checks; cancel/reschedule preserve routing snapshot without reviving receipt; routing waitlist controls absent; ordinary direct waitlist unchanged and never inherits answers; paid/group/one-time combinations rejected; no email/ICS/provider/webhook answer expansion. Off: existing booking lifecycle suites pass unchanged |
| d1 — Question editor and archive | Manager list/draft screens, stable-ID question/option ordering and archive with confirmation in en + zh-CN, so every form the web can create can be removed in the web | None; consumes b1 (including `DELETE /routing-forms/{id}`) through generated client | c7 | Hard-off; fixtures on | Create/edit/reorder questions/options; keyboard reorder, jsdom; archived forms leave the active list and block new submissions; natural Chinese/full-width punctuation; preserve weekly-hours hint and neutral loading/403/error states. Off: no navigation entry; manager routes show the ordinary not-found page; no routing request issued |
| d2 — Rule and mapping editor | Ordered rules, targets, fallback and answer-mapping controls in en + zh-CN | None; consumes b1/b3 and the existing `GET /event-types` and `GET /event-types/{id}` reads (targets, destination questions and options) through generated client | d1 | Hard-off; fixtures on | First-match order, per-member event selection, hidden targets, mapping validation and preview; accessible controls and jsdom tests. Off: no rule or mapping control reachable; no routing request issued |
| d3 — Publication and repair editor | Publish, disable and re-enable flows, fallback review, version conflicts and broken-target repair from b1's health in en + zh-CN | None; consumes b1/b2/b3 through generated client | d2 | Hard-off; fixtures on | End-to-end author draft → preview → publish using shipped APIs; stale-editor recovery, disable acknowledgement, health display and repair; no public enablement from editor. Off: no publication or repair control reachable; no routing request issued |
| d4 — Operator setting | Replace the code constant with `ROUTING_FORMS_ENABLED` (unset = `false`); effective state with the startup collision check and warning; `docker-compose.yml` entry `${ROUTING_FORMS_ENABLED:-}`; `.env.example`, README and OpenAPI/MCP/CLI descriptions name the setting | None new; `GET /instance` now reports the setting-derived effective state | d3 | Setting introduced, default `false` | `true` runs the full flow in an integration test with environment-derived config; unset and empty both mean `false`; invalid value fails startup; a collision forces off with a warning; every “turning the setting off later” effect above has a test. Off: with the setting unset or `false`, the a1b–d3 off checks pass unchanged |
| e1 — Host answer detail interfaces | Optional authorized host `routing` projection; explicit MCP host-detail read | Extend `GET /bookings/{id}`; add `get_booking` and CLI `booking` (read/bookings/full); no new REST write | d4 | Setting, default `false` | Positive snapshot/version/rule assertions; live host/org authorization; no routing addition to team-admin list/detail, webhooks or ordinary broad lists; OpenAPI/types and MCP/CLI contract tests. Off: no `routing` field on bookings without provenance; stored provenance still shown |
| e2 — Host and invitee answer screens | Host booking detail in en + zh-CN; invitee private management snapshot in public locales | Extend `GET /bookings/manage` projection; host web consumes e1; no new MCP/CLI operation for private manage UI | e1 | Setting, default `false` | Host sees original routing and final booking answers distinctly; invitee sees only own answer snapshot, no rule IDs/names/diagnostics/other targets; existing manage-token authority; reschedule history and escaping; locale/jsdom checks. Off: screens add nothing for bookings without provenance |
| e3 — Routing columns in booking CSV export | Prerequisite: the server-side booking CSV export (`GET /bookings/export.csv`, `export_bookings`, CLI `export`) is on main; e3 does not start, and builds no substitute, before it is. Adds an opt-in routing column group (`routing_form_id`, `routing_form_version`, `routing_matched_rule_id`, `routing_resolved_rule_id`, `routing_answers` JSON keyed by question ID with label snapshots) to personal exports. Because the chain is linear, a stalled booking export also delays e4 and e5; whether to wait is the project lead's call | Extend `GET /bookings/export.csv` (`includeRoutingAnswers` `true` or `false`), `export_bookings` and `export`; no new operation | e2 | Setting, default `false` | Personal read/full only, same as the export; team exports refuse the option with `invalid_request` and keep the team-admin whitelist; the export's formula protection, JSON escaping, row bounds and streaming apply to the new cells; web en + zh-CN choice; parity/OpenAPI/types. Off: web hides the choice, `includeRoutingAnswers=true` returns `feature_disabled`, `false` and ordinary exports unchanged |
| e4 — Operator and agent documentation | Public documentation-site how-to, all interface examples, capability handoff, limits/privacy, the setting and its off-state effects; after-booking guide “Current limits” sentence | None | e3 | Setting, default `false` | Examples match registered tools/CLI; the site's configuration reference lists the setting; explain hidden targets, token lifetime/single booking use, answer retention, export opt-in and `feature_disabled`; document legacy namespace collision remediation; self-hosted/Cloud parity; the after-booking guide states that bookings made through a routing form, on `/route/continue` or with a `routeToken` over REST/MCP/CLI, receive no after-booking continuation even when the event type has one. Off: pages describe the setting as off by default and how to enable it |
| e5 — Independent acceptance and default on | Complete synthetic public → route → booking → host/invitee/export acceptance; change the `ROUTING_FORMS_ENABLED` default (unset or empty) to `true` and update `.env.example`, README, the configuration reference and every documented default | None | e4 (therefore every c/d step) | Merging e5 changes the default to `true`; explicit `false` opts out | Default configuration (no environment value, and the Compose default) end-to-end matrix; upgrading an instance with no forms only adds the navigation entry and `/route` pages; a legacy collision still keeps routing off; privacy/replay/deletion mutation controls; full gates and CI including e2e using fakes; author-side review followed by project-lead independent acceptance. e5 merges only after that acceptance passes. Off: explicit `false` reruns every earlier step's off checks |

Each implementation step adds assertion-failing source-copy mutations for its protections
and owns its focused tests and generated artifacts. The final e5 step runs the full release
matrix rather than deferring missing implementation to acceptance. This design's doc-fact
test checks only the numeric register, the unescaped and fully escaped maximum submission
against the cap and the server's default body limit, and mutation controls; it does not
claim to test routing behavior that does not exist yet. No schema change, migration,
product strings or UI is part of this design PR.

## Out of scope and known limitations

Deferred: external redirects, narrowing a pool to a member subset, CRM/attribute routing, expression
nesting/contains/ranges, extra question types, conditional/hidden fields, routing embeds,
paid/group targets, routing-continuation waitlist enrollment, imported forms, automatic translation of author content, experiments,
aggregate analytics and abandoned-lead exports. Public system strings will use all shipped
public locales; author-written labels/messages remain in the author's language initially.
No CAPTCHA, verified lead identity, routing-only access gate or slot reservation. Users can
share ordinary booking URLs and infer policies from repeated public outcomes. Expired
answers may remain in operator backups; physical purge depends on working maintenance.

- After-booking redirects are not offered for routing-continuation bookings, for listed and
  hidden targets alike and including exact replays. A host who relies on a redirect for a
  thank-you or conversion page does not get it for routed bookings; direct bookings of the
  same event keep it. The after-booking guide's “Current limits” section states this (e4).
- Routing answers of team-form bookings are not exported: team exports keep the
  team-admin whitelist, so those answers are visible only in authorized host booking detail.
- While routing is off, the export's routing columns are unavailable; booking detail and
  invitee snapshots keep showing stored routing answers.

No decisions in this document alter the accepted team-admin data whitelist.
