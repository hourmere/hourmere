# SCIM provisioning design and token foundation

Status: token foundation only, reviewed against official sources on **2026-11-06**.
`SCIM_PROVISIONING_ENABLED=false` by default. Enabling it permits credential
administration, not user provisioning: every `/scim/v2` resource remains unavailable.
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

The SSO proposal in [PR #247](https://github.com/hourmere/hourmere/pull/247)
(`docs/sso.md` on that branch, inspected 2026-11-06) is still subject to acceptance.
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
| `POST /Users` | Create a managed provisioning entry; 201 with representation and Location; duplicate scoped identity gets 409. |
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

Use `ListResponse` with integer `totalResults`, `startIndex`, `itemsPerPage` and
`Resources`. Offset pagination starts at 1, defaults to 100, caps at 100, uses stable
resource-ID ordering, and reports the actual returned count. A count of zero returns
only totals and an empty resource list; out-of-range pages are empty. Negative count
is treated as zero and startIndex below 1 as 1. Pagination is not a cross-request
snapshot: concurrent additions/removals may affect later pages. Support
`excludedAttributes=members` on Groups and bounded `attributes`/`excludedAttributes`
projection for mapped attributes. Never let projection hide mandatory identity fields.

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
The mapping is not keyed solely by email. Persist uniqueness within the connection and
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
subsequent GET returns 404 and repeated DELETE returns 204. A later POST needs a fresh
resource ID and explicit re-admission. Database retention/purge follows the eventual
audited retention policy, not an IdP's DELETE command. `active:true` never resurrects
revoked keys/grants or overrides a local suspension/removal tombstone.

SCIM never grants owner or admin. New membership is member; optional group-to-role
mapping is a separate future design. Preserve the last owner under the same organization
lock used by native role/departure writes: reject a deactivation, delete or group change
that would remove the final owner's effective access. An owner must appoint a replacement
through ordinary administration first. Provisioning tokens are not recovery credentials.

The IdP owns mapped profile attributes and managed group membership; manual writes to
those fields return a managed-resource conflict. Unmanaged memberships remain manual.
Local security suspension/removal wins over IdP reactivation; IdP suspension wins over
manual reactivation. Both controls must explicitly clear their own blocker before access
returns. Existing management interfaces must display the managed state and refuse bypasses
on the server, including native Better Auth routes. SSO JIT cannot recreate a suspended
SCIM membership; SSO enforcement still requires a valid team proof after provisioning.

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
ordinary administration. Retain local owners/recovery access separately; do not allow a
Group replacement to demote/delete them. Deleting a group detaches managed memberships
and archives its managed mapping, preserving team bookings/history and requiring the
last-owner/departure checks. Nested Groups and indirect/transitive membership are
unsupported: reject Group-as-member references. Group membership never grants owner.

## Credential foundation and security

Provisioning tokens are independent bearer credentials with the `scim_` prefix.
Generate cryptographically random secrets, display the complete value only in the
successful create/rotate response, and use the API-key SHA-256/base64url hashing approach for storage.
Store only current/previous digests plus safe ID/name, organization, creation, overlap
expiry, revocation and last-used metadata. The current credential has no lifetime
expiry and the foundation does not yet record the issuing actor; future audit events
must supply that attribution. Never store plaintext or reversible ciphertext;
never include secrets in list responses, logs, audit events, URLs, exception messages,
analytics, localStorage or sessionStorage. Secret-bearing responses use no-store.
A lost response requires a new token, not a retrieve-secret endpoint.

Token write requests require `X-Expected-Organization-Id` matching the route and active
session organization. Only current owner/admin browser sessions in a nonpersonal organization can create,
list, rotate or revoke tokens. Bind requests to the expected organization and recheck
role/scope inside writes. A user's loss of admin rights cannot be worked around through
a stale session. Credentials belong to the organization rather than the issuing person's
future role; administrators must revoke a compromised organizational credential explicitly.

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

The audit log is being built separately. Token foundation must never claim full audit
coverage. Required future actions: token.create, token.rotate, token.revoke;
scim.authentication_failed and scim.rate_limited (bounded aggregation); scim.user.create,
update, claim, deactivate, reactivate, delete; scim.group.create, update, delete;
scim.group.member.add/remove; scim.mapping.link/unlink; scim.conflict;
scim.last_owner_blocked; scim.membership.suspended; scim.credentials.revoked.
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
| `GET /api/v1/organizations/{organizationId}/provisioning-tokens` | List safe metadata | Browser session, owner/admin; no MCP/CLI |
| `POST /api/v1/organizations/{organizationId}/provisioning-tokens` | Create and show once | Browser-session-only credential administration exemption |
| `POST /api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate` | Rotate with overlap and show once | Same exemption |
| `DELETE /api/v1/organizations/{organizationId}/provisioning-tokens/{id}` | Revoke | Same exemption |

Regenerate `apps/web/src/api/schema.d.ts`; response objects remain additive/open per
[API conventions](api-conventions.md). Admin UI ships English and Simplified Chinese,
clears the one-time secret when dismissed or when organization changes, and distinguishes
loading/forbidden/error from an empty token list. Public invitee strings are not added by
this foundation. No UI calls `/scim/v2` or bypasses the generated `/api/v1` client.

## Ordered implementation plan

Each row is approximately one working day and owns only the listed interfaces. Dependencies
name earlier rows; no row silently depends on a later UI or management route. All future
flags below are planned, not current environment settings. Split further if acceptance
cannot fit a day. SSO integration uses the accepted SSO foundation when it becomes available;
keep enrollment disabled until its prerequisite security fixes are accepted.

| Step | Earlier dependencies | Owned endpoints / tools / commands | Flag state | Acceptance checks |
|---|---|---|---|---|
| Token foundation (this change) | None | Four `/api/v1/organizations/{organizationId}/provisioning-tokens` routes above; SCIM unavailable handler; no MCP/CLI | `SCIM_PROVISIONING_ENABLED` off by default; resources always unavailable | Hash-only, one-time display, role/scope isolation, rotate/revoke races, predecessor migration, jsdom en/zh-CN UI, source-copy mutations |
| Connection identity and User schema | Token foundation | No new endpoint/tool/command; stable connection/resource/claim/tombstone storage | Resources off | Predecessor-data migration, unique identities, cross-org references rejected, rotation retains connection |
| Discovery and query parser | Connection identity and User schema | GET ServiceProviderConfig, ResourceTypes and Schemas (collections and IDs); no MCP/CLI | Resource test flag only | Correct schemas/capabilities, bounded filters/projections/pagination, protocol errors, other-token refusal |
| User reads | Discovery and query parser | GET Users and Users/{id}; no MCP/CLI | Resource test flag only | Filtered/unfiltered pagination, inactive entries, scoped not-found, no personal-account enumeration |
| User creation and claim intent | User reads | POST Users; existing invitation issuance service; no MCP/CLI | Resource test flag only; no automatic admission | Duplicate/replay race, durable deduplicated notification, signup policy, pending claim, no verified-email mutation |
| Claim completion and admission | User creation and claim intent | Existing invitation acceptance and accepted SSO linking completion interfaces; no new operation/tool/command | Resource test flag only | Own-account/mailbox proof, same-email conflict, expired invitation, manual/SCIM tombstones, claim replay |
| User profile replacement | Claim completion and admission | PUT Users/{id}; no MCP/CLI | Resource test flag only | Okta replacement fixtures; server-owned fields protected; no global profile/email takeover |
| User PATCH normalization | User profile replacement | PATCH Users/{id} profile operations; active changes still refused; no MCP/CLI | Resource test flag only | Ordered atomic patch, Entra forms, invalid-path rollback, bounded input, mutation assertions |
| Organization access revocation | User PATCH normalization | Shared REST/MCP/native authorization and revocation services; no new route/tool/command | Resource test flag only | Team access denied on all credentials, personal/other-team preservation, cached/session race, pool cleanup, audit integration |
| User lifecycle | Organization access revocation | Enable active writes on POST/PUT/PATCH; DELETE Users/{id}; no MCP/CLI | Resource test flag only | Last-owner lock races, tombstones, no resurrection, booking history, replay and audit atomicity |
| Hierarchy authorization design | User lifecycle | No runtime interface; finalize parent/child permission contract | Groups off | Lead accepts scope, owner recovery, explicit linking and existing-team conflicts |
| Hierarchy storage and guards | Hierarchy authorization design | No new public endpoint/tool/command; parent/child/mapping tables and authorization guards | Groups off | Predecessor-data preservation, cycle/cross-parent prevention, no sibling authority, last-owner races |
| Mapping administration | Hierarchy storage and guards | GET/POST `/api/v1/scim/team-mappings`, DELETE `/api/v1/scim/team-mappings/{id}`; MCP `create_scim_team_mapping`, `delete_scim_team_mapping`; CLI `scim-team-mappings create`, `scim-team-mappings delete` | Groups test flag only | General administration uses REST/MCP/CLI parity; explicit parent and child owner authority; safe mapping metadata; en/zh-CN generated-client UI |
| Group reads and creation | Mapping administration | GET Groups, GET Groups/{id}, POST Groups; discovery adds Group; no SCIM MCP/CLI | Groups test flag only | Managed child only, displayName collisions, externalId matching, members projection, no nested groups |
| Group name and replacement | Group reads and creation | PUT Groups/{id}, PATCH Groups/{id} nonmember fields; no MCP/CLI | Groups test flag only | Manual edit conflicts, full replacement semantics, protected owners, transactional audit |
| Group membership changes | Group name and replacement | PATCH Groups/{id} member operations; no MCP/CLI | Groups test flag only | Entra filtered/legacy removal, same-connection users, replay, local blockers, concurrent replacement |
| Group retirement | Group membership changes | DELETE Groups/{id}; no MCP/CLI | Groups test flag only | Managed access removed, team history retained, last owner and outstanding bookings, idempotent delete |
| RFC and provider corpus | Group retirement | No new endpoint/tool/command | Both resource flags off by default | RFC errors/filters/PATCH fixtures, Okta PUT and Entra variants, source-copy negative controls, bounded Postgres pools |
| Local IdP acceptance and release docs | RFC and provider corpus | No new endpoint/tool/command; operator/provider docs | Enable only after acceptance; self-hosters receive full feature | Pinned Keycloak/plugin local fixture run, rotation/deprovision/recovery drills, rate limits/audit acceptance, explicit tested-provider matrix, rollback and limitations |

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
provisioning ingress. Disabling the flag is not token revocation.

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
