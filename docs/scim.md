# SCIM provisioning design and token foundation

Status: token administration and identity storage; design sources reviewed on **2026-11-06**.
The connection identity and User schema step now provides internal storage, including
credential bindings, claim intents and retained resource identities. It adds no resource
handlers or membership lifecycle behavior. The discovery representations step adds
ServiceProviderConfig, ResourceTypes and Schemas handlers that only test harnesses inject,
under the resource test flag described in the implementation plan; production registers none.
The query parser step adds the shared filter, projection and pagination parser those handlers
will use; it adds no endpoint, and production imports none of it.
`SCIM_PROVISIONING_ENABLED` defaults to off (an empty value means "use the default"). Enabling
it permits credential creation and rotation, not user provisioning. Listing and revocation remain
available while it is off, and every `/scim/v2` resource remains unavailable either way.
The proposed protocol and lifecycle sections below are implementation requirements,
not a description of shipped Users or Groups handlers. Every instance, including
self-hosted installations, gets the same feature without a license or subscription.

## Sources and interoperability boundaries

The dated observations here are deliberately separate from Hourmere's decisions.

| Official source | What it establishes |
|---|---|
| [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643), sections 3–8 | Core User, Group, enterprise extension, metadata and discovery schemas. |
| [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644), sections 3.2–3.12 | HTTP resource operations, filtering, pagination, PATCH, errors and optional capabilities. |
| [Okta SCIM 2.0 reference](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/) | User matching uses `userName eq`; imports paginate with integer counters and consistent ordering. AIW user updates use PUT; OIN uses PUT except documented PATCH cases. Deactivation sets `active` false rather than deleting the user. |
| [Entra provisioning implementation](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups) | Examples cover Users and Groups, PATCH, matching, deletion and schema discovery. Group retrieval can exclude members. Group provisioning is optional. |
| [Entra compliance issues](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility) | Documents legacy PATCH forms and `aadOptscim062020`, including string booleans and member removal values; the flag does not work with on-demand provisioning according to this page. Older customappsso behavior is not recommended. |

These sources do not certify Hourmere or establish native SCIM support in Google
Workspace or Keycloak. Google Workspace through a third-party connector and Keycloak
through a separately chosen plugin are future test targets, not verified integrations.
The RFC Editor pages list later updates to these RFCs; this first implementation
explicitly targets the bounded RFC 7643/7644 subset below, not every newer extension.

The accepted [SSO design](sso.md) defines shared admission tombstones and identity
linking; its authentication and admission implementation remains a prerequisite.
SCIM controls membership lifecycle; SSO controls authentication proof. Before enabling
Users, reconcile its exact linking, admission tombstones and revocation transactions
with the accepted SSO implementation. Token administration does not depend on SSO.

## Protocol surface planned for the next tasks

Use `<PUBLIC_URL>/scim/v2/{organizationId}` as the organization base URL. The bearer
token selects one immutable organization and must match that exact URL organization;
no body, query parameter, cookie or alternate URL organization can override it.
Separate credentials for independent IdPs must eventually refer to a stable
provisioning-connection identity; rotating a credential must never change resource IDs
or ownership. Initially support one authoritative connection per organization.

All discovery and resource requests require SCIM authentication. Use
`application/scim+json`, opaque non-reusable resource IDs, absolute `meta.location`,
server-owned `meta.created` and `meta.lastModified`. Never expose auth user IDs as
SCIM identifiers or enumerate another organization's resources.

| Surface | Planned subset |
|---|---|
| `GET /ServiceProviderConfig` | `patch.supported=true`, filter supported with maxResults 100; bulk, sort, changePassword and etag unsupported; bearer authentication advertised. Advertise only implemented capabilities. |
| `GET /ResourceTypes`, `GET /ResourceTypes/{id}` | User and, only once implemented, Group resource descriptors and supported schema extensions. |
| `GET /Schemas`, `GET /Schemas/{id}` | Exact implemented User/core enterprise fields and Group fields; no unsupported writable attributes advertised. |
| `GET /Users`, `GET /Users/{id}` | Scoped list/read, including inactive managed entries; never a global email lookup. |
| `POST /Users` | Create a managed provisioning entry; 201 with representation and Location; duplicate live scoped identity gets 409; retired entries do not conflict. |
| `PUT /Users/{id}` | Full replacement of writable mapped fields, preserving server identity and local authorization controls; necessary for Okta. |
| `PATCH /Users/{id}` | Atomic ordered add/replace/remove of supported fields and compatible forms below; return 200 with current representation. |
| `DELETE /Users/{id}` | Retire the scoped entry and deactivate its membership; 204; no account or personal-data deletion. |
| `GET /Groups`, `GET /Groups/{id}`, `POST /Groups`, `PUT /Groups/{id}`, `PATCH /Groups/{id}`, `DELETE /Groups/{id}` | Deferred until the hierarchy and authorization prerequisite below; scoped managed teams only. |
| `/Bulk`, `/.search`, sorting, passwords | Unsupported initially; do not advertise these operations. |

List filters support a single quoted equality expression: Users `userName eq` and
`externalId eq`; Groups `displayName eq` and `externalId eq`. Attribute/operator casing
follows SCIM rules, while identifier value comparison follows each schema's
`caseExact`. Normalize userName consistently for uniqueness; externalId remains
case-sensitive. Parse escaped quoted strings, never interpolate filters into SQL.
Reject unsupported expressions with 400 `invalidFilter`, not an unfiltered list.
Entra must be configured to match `userName`, not its optional work-email query form.

Discovery follows RFC 7644 section 4. `/Schemas` and `/ResourceTypes` answer with a
`ListResponse`, and their IDs return the single resource (a schema URI may arrive with its
colons percent-encoded). Paging, sorting and projection parameters are ignored there; a
`filter` parameter is refused with 403, any method other than GET or HEAD with 501, and an
unknown resource type or schema ID with 404. Schemas lists the User schema and the enterprise
extension with exactly the mapped fields of the table below, without the deferred `groups` or
the refused `roles`, `entitlements` and `password`; `id`, `externalId` and `meta` are common
attributes, not schema fields. `userName` is the one required field and is returned always;
derived `manager.displayName` is read-only. ResourceTypes lists User only, with the
enterprise extension optional, until Groups ship. Discovery representations carry
`meta.resourceType` and an absolute `meta.location`, without `created`, `lastModified` or
`version`.

Use `ListResponse` with integer `totalResults`, `startIndex`, `itemsPerPage` and
`Resources`. Offset pagination starts at 1, defaults to 100, caps at 100, uses stable
resource-ID ordering, and reports the actual returned count. A count of zero returns
only totals and an empty resource list; out-of-range pages are empty. Negative count
is treated as zero and startIndex below 1 as 1. Pagination is not a cross-request
snapshot: concurrent additions/removals may affect later pages. Support
`excludedAttributes=members` on Groups and bounded `attributes`/`excludedAttributes`
projection for mapped attributes. Never let projection hide mandatory identity fields.

One shared query parser implements this subset; its refusals are 400 SCIM Errors whose detail
is fixed text that never echoes the request. A filter is at most 4,096 characters and exactly
one comparison, `attribute eq "value"` with single spaces: names and the operator are ASCII
case-insensitive, a core attribute may carry the core schema URN, and the value is a JSON
string decoded exactly as RFC 7159 specifies, except that a lone surrogate or U+0000 is
refused because no stored identifier can hold it. Every other form (`and`, `or`, `not`,
grouping, value paths, `pr`, another operator, an unquoted value, an unlisted attribute or a
second `filter`) gets `invalidFilter`. An attribute list names at most 64 attributes in at
most 4,096 characters, in standard attribute notation: extension attributes must be fully
qualified, the extension URN alone names its whole object, and the common attributes `id`,
`externalId` and `meta` are never qualified. `schemas`, `id` and `userName` are always
returned. An unknown or unmapped name, both lists at once or a repeated list gets
`invalidValue`, the keyword RFC 7644 assigns to GET. So does a `startIndex` or `count` that
is not a decimal integer of at most 32 characters, is repeated, or is a startIndex above
2^53 − 1.

No ETags or `meta.version` in the first release; advertise `etag.supported=false`.
Reject conditional writes with 412 rather than pretend to honor If-Match. Serialize
writes under the resource lock; ordinary concurrent writes otherwise use commit order.
IdP retries must not duplicate memberships, notifications or revocation operations.

SCIM failures use `schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"]`, a **string**
`status`, optional `scimType` and redacted `detail`. Use 400 `invalidSyntax`,
`invalidValue`, `invalidPath`, `noTarget` or `mutability` as appropriate; 409
`uniqueness` for duplicate identifiers; 401 for invalid credentials; 403 for forbidden
changes; 404 for unknown scoped IDs; 429 with Retry-After for throttling. Do not reuse
Hourmere's `/api/v1` error envelope on this surface. Errors must not echo bearer values,
raw requests, SQL, mailbox existence outside the connection or sensitive attribute values.

### PATCH compatibility

Implement RFC ordered, atomic `Operations` with add, replace and remove. Validate the
whole document before committing and roll back all operations on any failure. Support
pathless object updates, scalar paths, `name.givenName`, `name.familyName`,
`emails[type eq "work"].value`, colon-qualified enterprise paths, and Group
`members[value eq "<id>"]`. Members must resolve to Users in the same connection.
Read-only `id`, metadata, memberships-derived User `groups`, and authorization roles
cannot be made writable through PUT, dotted paths or pathless values.

Compatibility tests must cover the specific forms documented by Entra:

- Case-insensitive operation names such as `Replace`, `Add` and `Remove`.
- For the `active` field only, normalize the documented string boolean form
  `"False"` (and its true counterpart) to a boolean; never JavaScript truthiness.
- A pathless replacement object can contain dotted and colon-qualified attribute
  names; apply the same allowlist as explicit paths.
- `Remove` with path `members` and an array of `{value: id}` removes only those IDs;
  it must never accidentally clear the whole group. Also accept the standard filtered
  removal path without a value.

These are narrow compatibility decisions, not permission to accept arbitrary malformed
JSON or old dotted extension URIs. Record normalized operation type without attribute
values. Keep fixtures for both Entra flag modes and on-demand-shaped requests; do not
assume the tenant flag eliminates legacy requests. Okta fixtures cover pathless active
replacement, profile PUT, group member adds/removes and repeated identical requests.

## Identity, membership and trust

A future `scim_users` row belongs to `(organization, connection)` with its own ID,
externalId, normalized userName, lifecycle status and nullable linked account/membership.
The mapping is not keyed solely by email. Persist uniqueness among nondeleted entries within the connection and
never recycle retired IDs. A provisioned entry can exist before the person claims an
account; SCIM `active` describes desired lifecycle state, not proof of login eligibility.

| SCIM field | Hourmere mapping decision |
|---|---|
| `id`, `externalId`, `userName` | Opaque server identity, IdP correlation ID and connection-local login name respectively; none changes an existing account identity. |
| `name.givenName`, `name.familyName`, `name.formatted`, `displayName`, `nickName` | Store in the organization-local provisioned profile; do not overwrite a shared personal profile. |
| `emails` | One primary work address used for the invitation/claim workflow; preserve mapped typed values locally. A claimed mailbox change requires new verification and does not relink an account. |
| `active` | Desired organization-membership state; false denies access immediately once linked. |
| `locale`, `timezone`, `title`, `userType` | Optional organization-local profile metadata, validated and bounded; no scheduling availability or global preference changes. |
| Enterprise `employeeNumber`, `costCenter`, `organization`, `division`, `department` | Optional local profile metadata, not authority or tenant selectors. |
| Enterprise `manager.value` | Optional same-connection SCIM User reference; no permission inheritance; unresolved references fail validation. `manager.displayName` is derived, not trusted. |
| `groups` | Read-only derived membership once Groups ships. |
| `roles`, `entitlements`, `password`, unsupported extension fields | No privilege mapping or password provisioning. Empty roles from provider fixtures may be ignored; nonempty role/entitlement writes are rejected, not silently escalated. |

Default admission is **invitation/claim**, not direct creation of a login-capable auth
account. POST creates the provisioning entry and a bounded, deduplicated invitation
intent, using the existing mail queue and admission policy. It does not set
`emailVerified=true`, create a sign-in session, or bypass restricted signup. The recipient
must independently prove the mailbox or authenticate through an explicitly bound,
accepted SSO linking flow. Only then create the account/personal organization if needed
and atomically attach ordinary member access. Existing same-email personal accounts
receive the same claim flow and require their own current account proof. No email-only
link, password reset, personal-profile overwrite or new social-account link is allowed.
Responses do not disclose whether a personal account exists.

Direct membership is allowed only for an account already explicitly bound to this
connection through the accepted linking flow; active=true still checks current admission
and suspension state. Replaying provisioning does not resend invitations indefinitely.
SCIM is never a signup-domain authority. Implement enrollment and claim on the existing
invitation/SSO interfaces, not an undocumented credential bypass.

### Deactivation, deletion and manual control

For `active:false`, lock the organization then membership/resource in the established
order, set a persistent SCIM suspension, remove effective team access and revoke that
organization's session authorization, API keys and MCP OAuth grants/bindings in the
same transaction. Persist revocation work before success if an existing integration
needs an outbox. Every REST/MCP/native auth path must check current membership/suspension;
a previously issued token or cached proof must not keep granting access.

Sessions are account-wide today. Delete sessions whose active organization is the affected
team and invalidate team-scoped proofs on all others; shared personal sessions can remain
usable for personal/other-team work but cannot reselect the suspended team. Do not delete
global social sign-in accounts, calendar connections, personal bookings or credentials for
other organizations. Preserve historical bookings and attribution. Existing departure and
booking-host handling policy must be reused: suspend eligibility for new team work and
surface outstanding-booking handling to authorized admins; do not silently cancel meetings.

DELETE performs the same revocation and permanently tombstones this SCIM resource;
every subsequent operation on that resource, including repeated DELETE, returns 404
(RFC 7644 §3.6). Retired tombstones never participate in userName or externalId uniqueness
conflicts. A later POST with the same identifiers gets a fresh resource ID and requires
explicit re-admission. Database retention/purge follows the eventual
audited retention policy, not an IdP's DELETE command. `active:true` never resurrects
revoked keys/grants or overrides a local suspension/removal tombstone.

SCIM never grants owner or admin, and never deactivates, deletes or demotes a member
who currently has either role, even if other owners remain. This applies to User and
Group operations, including indirect removal of effective access through group changes.
New membership is member; optional group-to-role mapping is a separate future design.
Serialize the role check with native role/departure writes under the organization lock.
Reject each forbidden change atomically with HTTP 403 and a SCIM Error containing
`status: "403"`, `scimType: "mutability"` and safe detail explaining that privileged
membership must be changed through ordinary administration first. The same 403 error
applies to attempts to grant either role through any mapped field or PATCH form.
Ordinary administration retains its last-owner protection. Provisioning tokens are not
recovery credentials.

The IdP owns mapped profile attributes and managed group membership; manual writes to
those fields return a managed-resource conflict. Unmanaged memberships remain manual.
Local security suspension/removal wins over IdP reactivation; IdP suspension wins over
manual reactivation. Both controls must explicitly clear their own blocker before access
returns. Existing management interfaces must display the managed state and refuse bypasses
on the server, including native Better Auth routes. SSO JIT cannot recreate a suspended
SCIM membership; SSO enforcement still requires a valid team proof after provisioning.

The storage foundation retains local and SCIM blockers, including cleared history,
after account deletion. `scim_membership_blocks.user_id` becomes null through its FK;
the account-deletion trigger first captures the account's normalized mailbox in
`identity_email`, on that account's rows only. This is the team-local admission tombstone
shared with the SSO design, not an additional SSO-only tombstone store. It identifies a
removal decision, never an account link or authentication proof. Captured mailbox identity
is immutable and cannot be redirected or attached to another account; explicit reinstatement
clears the appropriate blocker rather than deleting or rewriting its identity. The database
also freezes the captured decision itself: its authority, kind, resource reference and
creation time cannot change, `cleared_at` moves from null to a timestamp exactly once, the
row cannot be deleted while its organization exists (whole-organization deletion still
cascades), and the account reference may only become null once that account no longer
exists. One live tombstone exists per organization, normalized mailbox, authority and
kind, mirroring the per-account rule for live blockers.

The later shared SSO/SCIM admission service must check live blockers by both current
account ID and proven normalized mailbox under the organization lock. A newly registered
account with the same proven mailbox must therefore still encounter the retained local
removal decision. It cannot gain access merely by claiming a fresh SCIM resource or
receiving `active:true`. A new current invitation can explicitly clear local removal as
specified by SSO; SCIM suspension still needs its own authority's reactivation. Mailbox
matching happens only after independent proof and cannot auto-link accounts. The retained
mailbox is organization-local personal data, limited to 320 characters, not exposed through
SCIM resources or logged; whole-organization deletion removes it, and any later purge
requires the audited retention policy. This foundation adds storage only, not admission
handlers or enforcement.

Retired resource rows are immutable, including their profile and timestamps. Native
account/member deletion may only clear their nullable links; it cannot relink a retired
resource. Stored userName and claim mailbox values are bounded before trimming as well
as checked for nonblank normalized values. Referencing-column indexes cover cleanup and
FK checks over live rows and history.

Migration 0073 takes transaction-scoped table locks before it reads anything, in the
[documented lock order](data-model.md#team-membership-and-host-lock-order): first
`auth."user"` and then `auth.organization` in `SHARE ROW EXCLUSIVE` mode (reads and
`FOR UPDATE`/`FOR SHARE` row locks continue; inserts, updates and deletes wait), then
`auth.member` and `auth.invitation` in `ACCESS EXCLUSIVE` mode, then
`scim_provisioning_tokens` in `ACCESS EXCLUSIVE` mode. Each lock is taken directly in the
mode the migration's DDL needs, never upgraded, and held to commit. The connection
backfill runs before the organization foreign key is added, so the migration takes no
organization row locks; a team-administration transaction that holds its organization
row `FOR UPDATE` only delays the migration through the member lock it takes next, and
then completes. A concurrent token therefore belongs either to the backfill snapshot or
to the installed trigger, closing the new-organization token creation window.

This lock set serializes the following writers, each of which commits before the
migration or starts after it: token administration (a writer that already counted
tokens, one holding the user, organization and member locks, one caught between its
organization and member locks, and the first token of an organization), team creation,
sign-up, personal-organization creation and invitation creation. It does not serialize
every team write. Two mechanisms still form a deadlock with the migration. A writer that
locks member rows and then writes the organization row: the team-settings update
(`/organization/update` locks the user, organization and member rows, then updates the
organization row while the migration holds the organization table lock and waits for the
member lock). And a writer that reads an invitation row before its member access, while
the migration holds the member lock and waits for the invitation lock: invitation
acceptance (a plain invitation read, then the organization and invitation row locks and
member reads) and invitation cancellation from the team page
(`/organization/cancel-invitation` from a session reads the invitation to find its
organization, then takes the user, organization and member locks; the REST route takes
those locks first and serializes). PostgreSQL resolves such a cycle after
`deadlock_timeout` by aborting one side with `40P01`: either that request fails, or the
migration rolls back whole, is not recorded, and is reapplied on the next start.

Migration 0073 is therefore meant to run with the application stopped, which the
documented Compose upgrade does (`docker compose stop app`, or `app worker`, before the
new version starts with `AUTO_MIGRATE=true`). The migration also bounds every lock wait
with `SET LOCAL lock_timeout = '5s'`: while it waits for the member, invitation or token
lock it already holds the account and organization table locks, so sign-up, email
verification and team writes would otherwise stall behind it for as long as the blocking
transaction lives. After the timeout the migration fails with `55P03`, records nothing,
and the process start fails; the restarted process retries it. The regression tests drive
the serialized writer shapes against the migration and against each weakened lock order,
and hold a conflicting lock on each table the migration locks (derived from the migration
source) against the bounded wait and its retry.

## Known limitations

- Account deletion is the privacy path and is never refused by admission storage. A
  blocker whose mailbox cannot be stored as a tombstone (empty, or longer than 320
  characters after lower-casing and trimming) is dropped with the account instead of being
  captured, so that removal decision is not retained. The same applies to a blocker whose
  decision is already recorded as a live tombstone for the same organization, mailbox,
  authority and kind; the existing tombstone remains. Sign-up and sign-in do not yet cap
  account mailbox length; invitations cap it at 254 characters.


## Groups to teams: required schema decision

Today a Hourmere team **is an `auth.organization`**, not a child object inside one.
Therefore an organization token cannot safely create arbitrary sibling organizations or
claim existing teams by `displayName`. Calling a roster subset a team would be misleading.

**Decision to confirm before Groups implementation:** introduce an explicit parent/child
organization hierarchy and connection-to-child management relation. A parent provisioning
connection may govern only child team organizations explicitly linked beneath its scope,
never unrelated sibling or personal organizations. Define inherited administration,
parent/child owner recovery, data visibility, billing-independent membership and removal
semantics before exposing Groups. This prerequisite does not broaden current token scope.

Each SCIM Group then owns one explicitly created/linked child team, identified by a stable
mapping ID. Names are labels, never authority: collision with a manual team returns 409;
no automatic adoption. Linking a pre-existing eligible child requires explicit owner
approval through the future mapping controls. Mark team name and managed membership as
SCIM-owned; reject conflicting manual changes while keeping unrelated team settings under
ordinary administration. Retain local owner/admin recovery access separately; no Group operation may
deactivate, delete or demote either role. Deleting a group detaches managed memberships
and archives its managed mapping, preserving team bookings/history and requiring the
privileged-member/departure checks. Nested Groups and indirect/transitive membership are
unsupported: reject Group-as-member references. Group membership never grants owner or admin.

## Credential foundation and security

Provisioning tokens are independent bearer credentials with the `scim_` prefix.
Generate cryptographically random secrets, display the complete value only in the
successful create/rotate response, and use the API-key SHA-256/base64url hashing approach for storage.
Store only current/previous digests plus safe ID/name, organization, creation, overlap
expiry, revocation and last-used metadata, plus the creating user ID/creation timestamp
and most recent rotating user ID/rotation timestamp. Actor references become null on
account deletion while timestamps remain. The current credential has no lifetime expiry. Never store plaintext or reversible ciphertext;
never include secrets in list responses, logs, audit events, URLs, exception messages,
analytics, localStorage or sessionStorage. Secret-bearing responses use no-store.
A lost response requires a new token, not a retrieve-secret endpoint.

Token write requests require `X-Expected-Organization-Id` matching the route and active
session organization. Only current owner browser sessions in a nonpersonal organization
can create or rotate tokens, because both operations disclose a new plaintext secret.
Current owners and admins can list metadata and revoke tokens, including while
`SCIM_PROVISIONING_ENABLED=false`; only create and rotate require the switch. Bind requests to the expected organization and recheck
role/scope inside writes. A user's loss of the required role cannot be worked around through
a stale session. Credentials belong to the organization rather than the issuing person's
future role; administrators must revoke a compromised organizational credential explicitly.

Cap each organization at 10 active token rows, checked atomically with creation. One
authoritative connection needs few credentials; ten allows staged IdP transitions and
recovery without unbounded live credential growth. Revoke unused rows before creating
more. List uses `limit` (default 20, maximum 100) and an optional `after` UUID cursor,
with stable ID ordering and `nextCursor`; revoked history remains paginated.

Rotation replaces the current digest on the same stable credential row, retaining one
previous digest until an explicit overlap deadline (default 3,600 seconds; 0–86,400
seconds). The current token has no expiry; the previous token stops at its grace cutoff.
Persist both changes atomically and use database time after waiting for locks. Rotation
while an earlier overlap remains active returns 409, rather than extending or silently
discarding an in-flight migration. Zero overlap makes the preceding secret invalid
immediately. Revocation is terminal, idempotent and removes both usable digests;
rotating a revoked row cannot resurrect it. Concurrent rotates/revokes serialize on the
same row, and revocation wins over any replacement committed before it. Last-used is an
authentication timestamp, not proof that a provisioning operation succeeded; invalid
credentials must not update it.

The SCIM authentication helper accepts tokens only at exact `/scim/v2/{organizationId}`
or a path beneath that organization base. Reject lookalike paths, API keys, MCP OAuth tokens and session cookies there.
Reject SCIM tokens on `/api/v1`, `/mcp`, `/api/auth` and every other authentication surface;
do not fall back to a cookie when an Authorization header is present. Keep SCIM and API
key stores/verifiers separate even though they share a hash primitive.

Before resources ship, add bounded request/body/operation/member counts, per-IP failed
authentication and per-organization authenticated rate limits with 429/Retry-After.
Transport limits today are process-local; document replica multiplication and move
organization mutation budgets to durable/shared storage before claiming cluster-wide
limits. Optional IP allow-listing is initially an operator reverse-proxy control, not an
application feature; trust forwarded addresses only through configured trusted proxies.

Ordinary access logs retain method, route and response status for token administration,
never bearer values, bodies or secret-bearing responses.

The [audit journal](audit-log.md) from [PR #246](https://github.com/hourmere/hourmere/pull/246) does not record token administration yet. Token foundation must never claim full audit
coverage. Required future actions: token.create, token.rotate, token.revoke;
scim.authentication_failed and scim.rate_limited (bounded aggregation); scim.user.create,
update, claim, deactivate, reactivate, delete; scim.group.create, update, delete;
scim.group.member.add/remove; scim.mapping.link/unlink; scim.conflict;
scim.privileged_member_blocked; scim.last_owner_blocked; scim.membership.suspended; scim.credentials.revoked.
Record organization/connection, safe credential ID or human actor, target opaque ID,
request correlation ID, result and time; omit bearer, digest, attribute values and bodies.
Transactional lifecycle audit integration is a release prerequisite for Users/Groups.

## REST, MCP, CLI and browser classification

`scripts/interface-parity.ts` inventories only paths equal to `/api/v1` or beginning
`/api/v1/`. `/scim/v2` is an independently authenticated protocol surface outside that
inventory, not a new exception or frozen gap. SCIM clients use the protocol directly;
there are no MCP/CLI wrappers for SCIM resource operations.

Native API-key administration currently lives under `/api/auth/api-key/*`, requires the
owner session, and refuses Authorization headers even with a cookie. Follow that trust
boundary, but put new token administration in documented `/api/v1` routes so the web app
uses its generated API client. Every write gets an explicit browser-session-only mapping,
a nonempty reason, and OpenAPI security **exactly `[{session: []}]`**, as the parity
script verifies. Runtime authorization must match it. No API-key, OAuth, SCIM bearer,
MCP tool or CLI command may mint or administer these secrets.

| Current token route | Operation | Interface classification |
|---|---|---|
| `GET /api/v1/organizations/{organizationId}/provisioning-tokens` | List safe metadata | Browser session, owner/admin, even while disabled; no MCP/CLI |
| `POST /api/v1/organizations/{organizationId}/provisioning-tokens` | Create and show once | Owner browser session; credential administration exemption |
| `POST /api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate` | Rotate with overlap and show once | Owner browser session; same exemption |
| `DELETE /api/v1/organizations/{organizationId}/provisioning-tokens/{id}` | Revoke | Owner/admin browser session, even while disabled; same exemption |

Regenerate `apps/web/src/api/schema.d.ts`; response objects remain additive/open per
[API conventions](api-conventions.md). Admin UI ships English and Simplified Chinese,
clears the one-time secret when dismissed or when organization changes, and distinguishes
loading/forbidden/error from an empty token list. Public invitee strings are not added by
this foundation. No UI calls `/scim/v2` or bypasses the generated `/api/v1` client.

## Ordered implementation plan

Each row is approximately one working day and owns only the listed interfaces. Dependencies
name earlier rows or explicit external PRs; no row silently depends on a later UI or
management route. Split further if acceptance cannot fit a day. Audit integration depends
on accepted [PR #246](https://github.com/hourmere/hourmere/pull/246); admission and
suspension integration depend on accepted [SSO design PR #247](https://github.com/hourmere/hourmere/pull/247)
and its implemented linking contract.

**Resource test flag** means code-only dependency injection in the test harness. It is
not an environment setting, operator setting, public parameter or production-build option.
Users, Groups and discovery handlers remain unregistered in production code until all
Users, Groups, conformance and release acceptance rows are complete. Every intermediate
main commit can be released safely: `SCIM_PROVISIONING_ENABLED` enables credential
creation/rotation only and cannot activate these resource handlers. The final release row
alone owns changing production registration and changes the default of
`SCIM_PROVISIONING_ENABLED` to on. `.env.example` writes the setting empty and Compose passes
`${SCIM_PROVISIONING_ENABLED:-}`, so installs copied from `.env.example` follow that new default
without editing `.env`; the release row's acceptance checks this. Test-only injection is never
operator-accessible.

| Step | Earlier / external dependencies | Owned endpoints / tools / commands | Flag state | Acceptance checks |
|---|---|---|---|---|
| Token foundation (this change) | None | Four `/api/v1/organizations/{organizationId}/provisioning-tokens` routes above; SCIM unavailable handler; no MCP/CLI | Create/rotate switch off by default; list/revoke available; resources hard-off | Owner-only mint/rotate, owner/admin list/revoke while off, hash-only, one-time display, attribution, cap/pagination, scope isolation, races, migration, en/zh-CN UI, source-copy mutations |
| Connection identity and User schema | Token foundation | No new endpoint/tool/command; connection/resource/claim/tombstone storage | Resources hard-off | Predecessor migration, live identity uniqueness, retired identifiers reusable with fresh IDs, cross-org references rejected, rotation retains connection |
| Discovery representations | Connection identity and User schema | GET ServiceProviderConfig, ResourceTypes and Schemas (collections and IDs); no MCP/CLI | Resource test flag only | Exact schemas, truthful capabilities, organization scope, other-token refusal |
| Query parser | Discovery representations | Shared filter/projection/pagination parser; no new endpoint/tool/command | Resource test flag only | Bounded quoted equality and escaped strings, projections, count/startIndex edge cases, SCIM errors |
| User reads | Query parser | GET Users and Users/{id}; no MCP/CLI | Resource test flag only | Filtered/unfiltered pagination, inactive entries, scoped not-found, no personal-account enumeration |
| User creation and claim intent | User reads; audit log PR #246 | POST Users; existing invitation issuance service; no MCP/CLI | Resource test flag only; no automatic admission | Duplicate/replay race, deduplicated notification, signup policy, pending claim, audit atomicity, no verified-email mutation |
| Claim completion and admission | User creation and claim intent; SSO design PR #247 and accepted linking implementation | Existing invitation acceptance and SSO linking completion; no new operation/tool/command | Resource test flag only | Own-account/mailbox proof, same-email conflict, expired invitation, local/SCIM tombstones, claim replay |
| User profile replacement | Claim completion and admission | PUT Users/{id}; no MCP/CLI | Resource test flag only | Okta replacement fixtures, server-owned fields protected, no global profile/email takeover |
| User PATCH normalization | User profile replacement | PATCH Users/{id} profile operations; active changes refused; no MCP/CLI | Resource test flag only | Ordered atomic patch, Entra forms, invalid-path rollback, bounded input, mutation assertions |
| Suspension checks on authorization | User PATCH normalization; SSO design PR #247 and accepted linking implementation | Shared REST/MCP/native membership authorization; no new interface | Resource test flag only | Every credential/cached proof refuses suspended team, personal/other-team preservation, native selection and JIT cannot bypass |
| Session authorization revocation | Suspension checks on authorization | Shared session and team-proof revocation; no new interface | Resource test flag only | Active-team sessions revoked, other sessions cannot reselect suspended team, transaction/lock races, bounded pools |
| API-key and OAuth revocation | Session authorization revocation; audit log PR #246 | Organization API-key and MCP grant/binding revocation; no new interface | Resource test flag only | Both credential types revoked atomically or durable outbox persisted before success, other-team credentials preserved, audit atomicity |
| User lifecycle: suspension and reactivation | API-key and OAuth revocation; audit log PR #246 | Enable active writes on POST/PUT/PATCH; no MCP/CLI | Resource test flag only | Every owner/admin deactivation or demotion and role grant returns 403 mutability, role-change races serialize, no key/grant resurrection, local blockers win, audit atomicity |
| User lifecycle: retirement | User lifecycle: suspension and reactivation | DELETE Users/{id}; no MCP/CLI | Resource test flag only | Every owner/admin deletion returns 403 mutability, all subsequent operations on retired ID return 404, fresh POST reuses identifiers only with re-admission, history retained, audit atomicity |
| Managed membership server guards | User lifecycle: retirement; SSO design PR #247 and accepted linking implementation | Existing member/invitation/role management REST and native Better Auth writes and shared MCP services; no new operation/tool/command | Resource test flag only | Manual profile/membership changes cannot bypass management, local suspension wins, native/JIT and concurrent reactivation checks, protected owner/admin authority |
| Managed membership UI | Managed membership server guards | Existing member-management UI; no new endpoint/tool/command | Resource test flag only | en/zh-CN managed status and blockers, forbidden manual actions explained, unknown readiness stays neutral, generated-client errors handled |
| Hierarchy authorization design | Managed membership UI | No runtime interface; parent/child permission contract | Resources hard-off | Lead accepts scope, owner/admin recovery, explicit linking and existing-team conflicts |
| Hierarchy storage and guards | Hierarchy authorization design | Parent/child/mapping tables and guards; no new public interface | Resource test flag only | Predecessor preservation, cycle/cross-parent prevention, no sibling authority, privileged-member races |
| Mapping administration | Hierarchy storage and guards; audit log PR #246 | GET/POST `/api/v1/scim/team-mappings`, DELETE `/api/v1/scim/team-mappings/{id}`; MCP `create_scim_team_mapping`, `delete_scim_team_mapping`; CLI `scim-team-mappings create`, `scim-team-mappings delete` | Resource test flag only | REST/MCP/CLI parity, explicit parent/child owner authority, safe metadata, en/zh-CN generated-client UI, audit |
| Group reads and creation | Mapping administration | GET Groups, GET Groups/{id}, POST Groups; discovery adds Group; no SCIM MCP/CLI | Resource test flag only | Managed child only, name collisions, externalId matching, members projection, no nested groups |
| Group name and replacement | Group reads and creation; audit log PR #246 | PUT Groups/{id}, PATCH Groups/{id} nonmember fields; no MCP/CLI | Resource test flag only | Manual conflicts, replacement, any owner/admin demotion/removal or role grant returns 403 mutability, transactional audit |
| Group membership changes | Group name and replacement | PATCH Groups/{id} member operations; no MCP/CLI | Resource test flag only | Entra removal forms, same-connection users, replay, blockers, concurrent replacement, owner/admin access cannot be removed |
| Group retirement | Group membership changes | DELETE Groups/{id}; no MCP/CLI | Resource test flag only | Managed access removed, team history retained, privileged-member and booking checks, subsequent operations 404, retired uniqueness excluded |
| RFC and provider corpus | Group retirement | No new endpoint/tool/command | Resources hard-off | RFC errors/filters/PATCH, Okta PUT/Entra variants, source-copy controls, bounded Postgres pools |
| Local Keycloak harness | RFC and provider corpus | Pinned local image/plugin fixture and synthetic identities; no new interface | Resources hard-off | Document actual SCIM capability, deterministic startup/cleanup, no live third-party calls, reproducible protocol capture without secrets |
| Local lifecycle acceptance | Local Keycloak harness; audit log PR #246; SSO design PR #247 and accepted linking implementation | Local fixture scenarios; no new interface | Resources hard-off | Create/rename/deactivate/reactivate/delete/groups, owner/admin refusal, credential rotation/revocation, recovery, rate limits and audit acceptance |
| Release documentation and registration | Local lifecycle acceptance | Operator/provider docs and production resource registration; no new protocol operation | Enable only after all prior acceptance; same feature for self-hosters | Tested-provider matrix, limitations, rollback drill documented, any intermediate release hard-off proven; complete Users/Groups/conformance before registering handlers; default of `SCIM_PROVISIONING_ENABLED` changed to on, and an install whose `.env` was copied from an earlier `.env.example` (empty value) is on after upgrade without editing `.env` |

Mapping administration is ordinary product configuration, not credential minting, so it
ships MCP and CLI parity rather than borrowing the browser-only exemption. Additional
writes discovered during implementation need their own row and interfaces before coding.

## Self-hosting and provider testing

Use HTTPS with a stable PUBLIC_URL and a proxy that forwards `/scim/v2` unchanged.
Do not put tokens in query strings, shell history, request logging or telemetry. Store
the one-time value in the IdP's protected credential configuration. Keep overlapping
credentials only long enough to switch the provider; test the replacement and let the
previous digest expire at its fixed overlap deadline. Revoking the stable token row
revokes both generations, including the replacement; there is no separate predecessor
revocation operation. If either generation is compromised, revoke that row and create
a fresh credential. Backups contain only hashes, so operators cannot recover lost tokens.
Revocation after a restored backup needs explicit review because restoring old state can
restore a formerly valid credential; revoke/rotate restored credentials before reopening
provisioning ingress. Disabling the flag is not token revocation. Owners/admins can still list and revoke
credentials while disabled, before re-enabling; existing unrevoked rows otherwise become
usable again when the flag is enabled.

Current releases cannot pass an IdP connection test or synchronize users/groups, even
with the flag enabled. Do not configure production provisioning yet. The
[operator guide](https://hourmere.com/docs/scim) states this same limitation.

Future tests use local HTTP protocol fixtures and throwaway Postgres databases first.
Use a pinned local Keycloak image plus a reviewed, pinned SCIM plugin/connector only
after documenting its actual provisioning capability; OIDC/SAML support alone proves
nothing about SCIM. Exercise create, rename, disable, re-enable, delete, groups,
credential overlap and revoked-token retries with synthetic identities. Replay official
Okta/Entra request shapes against the same server in CI without live provider calls.
A later explicitly authorized tenant trial can establish interoperability; never claim
Okta/Entra/Google certification from fixtures alone. The foundation performs no provider
calls and adds no booking reschedule/cancel/DST behavior.
