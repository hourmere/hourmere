# SCIM provisioning design and token foundation

Status: token administration and identity storage; design sources reviewed on **2026-11-06**.
The connection identity and User schema step now provides internal storage, including
credential bindings, claim intents and retained resource identities. It adds no resource
handlers or membership lifecycle behavior. The discovery representations step adds
ServiceProviderConfig, ResourceTypes and Schemas handlers that only test harnesses inject,
under the resource test flag described in the implementation plan; production registers none.
The query parser step adds the shared filter, projection and pagination parser those handlers
will use; it adds no endpoint, and production imports none of it. The User reads step adds
`GET /Users` and `GET /Users/{id}` handlers under the same resource test flag, and the User
creation step adds `POST /Users` under it, with pending claims and invitations through the
existing invitation service; production registers none of them either. The claim completion
step completes a claim when its invitation is accepted, through a dependency that only test
harnesses pass to `createAuth`; production acceptance completes none.
The User profile replacement step adds `PUT /Users/{id}` under the resource test flag.
The User PATCH normalization step adds `PATCH /Users/{id}` under that same flag.
The User retirement step adds `DELETE /Users/{id}` under the resource test flag.
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
projection for mapped attributes; standard attributes that are not mapped are never
returned. Never let projection hide mandatory identity fields.

One shared query parser implements this subset; its refusals are 400 SCIM Errors whose detail
is fixed text that never echoes the request. A filter is at most 4,096 UTF-16 code units and
exactly one comparison, `attribute eq "value"` with single spaces: names and the operator are
ASCII case-insensitive, a core attribute or `externalId` may carry the core schema URN, and
the value is a JSON string decoded exactly as RFC 7159 specifies, except that a lone
surrogate or U+0000 is refused because no stored identifier can hold it. Every other filter
(a longer one, `and`, `or`, `not`, grouping, value paths, `pr`, another operator, an
unquoted value, an unlisted attribute or a second `filter`) gets `invalidFilter`. An attribute list names at most 64
attributes in at most 4,096 UTF-16 code units, in standard attribute notation: extension
attributes must be fully qualified, the extension URN alone names its whole object, and the
common attributes `id`, `externalId` and `meta` may carry the core schema URN, because
RFC 7643 section 3.1 makes them part of every base resource schema. Projection always keeps
`schemas`, `id` and `userName`, omits a complex or multi-valued attribute left empty, and
names in `schemas` only the core schema and the extensions whose objects remain; only
top-level core attributes may be returned always, and a schema attribute returned other than
always or by default is refused when the schema loads. An attribute that RFC 7643 defines
for the resource but Hourmere does not map, such as `groups`, `phoneNumbers` or `addresses`,
is never returned: excluding it changes nothing and requesting it adds nothing. An unknown
name, a longer list, both lists at once or a repeated list gets `invalidValue`, the keyword
RFC 7644 assigns to GET. So does a `startIndex` or `count` that is not a decimal integer of
at most 32 characters, is repeated, or is a startIndex above 2^53 − 1. Parameter names are
case-sensitive: a known name in another case, such as `Filter`, is refused (with
`invalidFilter` for the filter) rather than ignored, so a filtered request never becomes an
unfiltered list.

User reads see only the live entries of the connection the token is bound to, in its own
organization, ordered by resource ID. Inactive entries are listed and read with
`active: false`. Retired entries, accounts, memberships and other organizations' entries are
never read, so an unknown, retired, account, membership or other-organization ID gets the
same 404 SCIM Error, and a filter naming any of them gets the same empty list as a name that
exists nowhere. A `userName` filter compares the trimmed, lower-cased name, as live
uniqueness does; `externalId` compares exactly. Resource IDs are case-exact, so only the
canonical lower-case form names an entry. Representations hold exactly the advertised
fields: `emails` carries the one work address as the primary `work` value, and `manager`
names only a live entry, with `displayName` derived from it; a retired manager is omitted.
The list counts and reads its page in one snapshot.

User creation records one live entry in the connection the token is bound to and answers 201
with the read representation and its location. Within the organization update lock that team
management takes, it rechecks that the token is unrevoked, then inserts the entry: a live
entry of the connection with the same trimmed, lower-cased `userName` or the same
`externalId` gets 409 `uniqueness`, while retired entries and other connections never
conflict. Read-only and server-owned attributes (`id`, `meta`, `groups`,
`manager.displayName`) are ignored, as are the RFC 7643 attributes Hourmere does not map,
`password` included, which is never stored or recorded; an unknown attribute or extension
gets 400 `invalidValue`, a nonempty `roles` or `entitlements` gets 403 `mutability`, and a
`manager` must name a live entry of the same connection. `active` defaults to true. An
inactive create stores the directory entry and its `scim_user.created` audit event without
starting a claim or sending an invitation. The work address is chosen from `emails` in this order:
the primary `work` email, the first `work` email, a primary email without `type`, then the
only email when it has no `type` (an empty `type` counts as none); a nonempty `emails` that
none of these selects, or that marks more than one address primary, gets 400 `invalidValue`
rather than losing the address.
When an active User has a work address, the same transaction records a pending claim and issues
its invitation through the existing invitation service, with the same address rules,
member-role invitation, mail admission limits, pending cap and delivery queue as an
invitation sent from the app: the earliest current owner of the organization whose email
address is verified is the inviter (with no such owner the create gets 403, whatever the
address), a pending invitation of that owner to the same address is reused rather than sent
again, and its delivery generation is queued only after commit. Existing same-email accounts
get the same claim flow: an address that already belongs to a member of the organization,
that another administrator's, a legacy, a duplicated or a departed inviter's pending
invitation holds, or whose pending invitation another entry's claim already holds, gets the
same entry and a pending claim without an invitation, nothing is sent, and the answer is
the same 201 as any other create. Linking proceeds through the applicable proof described
below. Only a duplicate live identity of the connection gets 409. Exhausted admission limits get 429 with
`Retry-After`. Sign-up
policy is decided from the instance settings alone: a restricted instance (`SIGNUP` set to
`closed` or `first-user`) refuses a work address whose domain is not in
`SIGNUP_ALLOWED_DOMAINS` with 403, whether or not an account exists. No account, membership
or session is created, no address is marked verified and nothing is linked: admission waits
for the claim. The entry, its claim, the invitation and the `scim_user.created` and
`membership.invited` events commit or roll back together; the events name the provisioning
token as their actor. When the address's pending invitation expires while the create waits for
its delivery row, the mail budget or another administrator's invitation, admission runs once
more from its savepoint: the expired invitation is retired and a new one issued, exactly as the
provider's retry would get, never a claim without an invitation and so without an email.

Claim completion rides on the existing acceptance of the invitation the create bound to the
claim (`/organization/accept-invitation`); it adds no operation. The person proves the mailbox
and their own current account exactly as acceptance requires: a signed-in account whose
verified address is the invitation's, rechecked after the acceptance's locks. An existing
same-email personal account accepts the same way, in its own session, and nothing else links
it; the create's answer and the invitation are the same whether or not that account exists.
After the organization and invitation locks, acceptance locks the claim and then its entry.
A live inactive entry pauses acceptance of its SCIM-issued invitation. Reactivation leaves
the original invitation usable until its normal expiration.
A SCIM-issued invitation never clears an admission blocker: while a live local or SCIM
suspension or removal names the accepting account or the proven mailbox, admission is refused
with the acceptance's uniform 403 `TEAM_MANAGEMENT_ACCESS_DENIED` and nothing is written.
Otherwise the native acceptance adds the ordinary member membership and, in the same
transaction, the entry is linked to the account and that membership, the claim is marked
completed and `scim_user.claimed` is recorded; all of it commits or rolls back together. No
address is marked verified, and neither the account's profile, address or sign-in methods nor
the entry's provisioned profile or timestamps change. A second or concurrent acceptance of the
invitation is refused as before, so a claim completes once. An expired invitation admits
nobody and completes nothing. A claim expires after 48 hours, as its invitation does, judged
at the same instant as the invitation's expiry, and an administrator's resend can extend or
replace that invitation: an expired claim is then never completed, while its still-valid
invitation admits the person as an ordinary acceptance, the administrator's resend being the
consent, and the entry stays unlinked. An account that
another live entry of the connection already links is admitted the same way, without a second
link. Claims without an invitation expire after 48 hours without renewal. They require the
retirement re-admission proof below or the planned SSO linking proof. `ScimClaimCompletion` in
`packages/auth/src/scim-claims.ts` is the extension point where that step adds its proof.

User profile replacement requires `userName` and replaces the mapped profile, including
`userName`, `externalId` and the work address, on a live User in the token's connection.
Omitted or null optional profile attributes and an empty `emails` array clear those fields.
The response is 200 with the current representation. The server preserves the resource
ID, scope, creation time and account and membership links. It ignores supplied read-only
attributes, including `id`, `meta`, `groups` and `manager.displayName`, and refuses
nonempty roles or entitlements. Omitted or null `active` preserves its current value. A
boolean sets the desired lifecycle state in the same transaction as the profile. Profile
fields belong to the directory entry. The linked account, email and role are managed through
ordinary team administration.

A different normalized work address, or clearing the address, invalidates any unfinished
claim atomically with the profile change. An existing invitation can still be accepted
under its usual rules, but its old mailbox proof cannot complete the invalidated claim.
Replacement issues no invitation, creates no claim, and preserves any completed claim and
its link. The organization lock serializes replacement with invitation acceptance. If
acceptance completes the claim first, replacement keeps that link and stores the new work
address as profile data only.

No ETags or `meta.version` in the first release; advertise `etag.supported=false`.
PUT rejects `If-Match`, `If-None-Match` and `If-Unmodified-Since` with 412. Serialize
writes under the resource lock; ordinary concurrent writes otherwise use commit order.
Repeating an identical profile replacement preserves `meta.lastModified` and writes no
additional audit event.
IdP retries must not duplicate memberships, notifications or revocation operations.

SCIM failures use `schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"]`, a **string**
`status`, optional `scimType` and redacted `detail`. Use 400 `invalidSyntax`,
`invalidValue`, `invalidPath`, `noTarget` or `mutability` as appropriate; 409
`uniqueness` for duplicate identifiers; 401 for invalid credentials; 403 for forbidden
changes; 404 for unknown scoped IDs; 429 with Retry-After for throttling. Do not reuse
Hourmere's `/api/v1` error envelope on this surface. Errors must not echo bearer values,
raw requests, SQL, mailbox existence outside the connection or sensitive attribute values.

### PATCH compatibility

User PATCH applies one to 100 operations in order to the locked connection-local profile
and commits the result through the same replacement transaction as PUT. The request body
limit is 64 KiB and each path can contain up to 512 characters. PATCH uses the same
conditional-write refusal, claim invalidation and response projection as PUT. If a successful
PATCH leaves the mapped profile unchanged, it preserves `meta.lastModified` and adds no audit
event.

The User allowlist covers the mapped profile, including `externalId`, complex `name` and
enterprise `manager` updates, whole `emails` arrays and the work-email value filter below.
Complex add and replace preserve unspecified subattributes. For an add to `emails`, the
existing primary work address remains selected unless the new values designate a different
primary work address. A filtered replace or remove without a work
address returns `noTarget`. A filtered add can supply the missing address. Read-only
attributes and removal of required `userName` return 400 `mutability`.

PATCH accepts a boolean or the documented string boolean for `active`. The last assignment
sets the committed state. Any `active:false` operation on a current owner or admin returns
403 `mutability`, including when a later operation would restore the original value.
Removing `active` or assigning null also returns 403 `mutability`.

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

Authorization uses the live SCIM suspension for the account and team. Existing team API
keys, SSO delegation and MCP OAuth tokens lose authorization for that team. REST and
MCP check the blocker when resolving the caller. A credential resolved before suspension
can finish a read. Team writes in SCIM-managed organizations take the team lock and
check suspension on the committing connection. SSO JIT admission checks live blockers
for the proven mailbox under the team lock. Authorization and credential revocation are
separate steps in the implementation plan below.

The shared suspension write locks the organization row `FOR UPDATE` first, before
locking or deleting sessions, browser proofs, API keys or OAuth grants. A concurrent
team write takes its organization lock before checking live authority on the writing
connection. If the write holds the lock first, it can commit before suspension. A write
that waits for suspension to commit must recheck and refuse the suspended member.

The suspension transaction records the blocker, deletes the account's sessions whose
active organization is that team and removes that team's browser proofs on surviving sessions.
Personal and other-team sessions stay usable, and team selection refuses the suspended
team. Rolling refresh only updates an existing session, so it cannot recreate a deleted
one. Team selection and proof issuance check the blocker under the same team lock.
The transaction also deletes the member's API keys assigned to the team and their team's
MCP OAuth grants, including the matching provider consents, token rows and delegation
bindings. Keys and grants in personal space and other teams, and those of other team
members, are retained. A session-bound OAuth access token still depends on its issuing
session. Clearing the blocker during later reactivation cannot restore deleted keys or
grants. The member must create a new key or authorize a new OAuth grant. Reactivation clears
only the SCIM suspension recorded for the linked User, and requires the linked account
to have a current membership and the account and verified mailbox to have no local blocker. Otherwise
it returns 403 `mutability`. An unchanged `active:true` echo updates only the directory profile
and preserves any local removal or suspension. On an unlinked User, `active:true` changes only
the directory entry. It does not make a new invitation or claim.

Production still registers no SCIM resource handler. Preserve global social sign-in
accounts, calendar connections, personal bookings, historical bookings and attribution.
Existing departure and booking-host handling policy must be reused: suspend eligibility for
new team work and surface outstanding-booking handling to authorized admins; do not silently
cancel meetings.

DELETE performs the same team-scoped revocation, keeps the membership blocked, and
permanently tombstones the SCIM resource. Success returns 204 with an empty body.
Every subsequent operation on that ID, including repeated DELETE, returns 404
(RFC 7644 §3.6). DELETE on a live ID with `If-Match` returns 412 before the protected-role
check, matching PUT and PATCH. Retirement invalidates unfinished claims and cancels pending invitations
issued by SCIM for those claims. An invitation independently issued or renewed by a team
administrator remains available for ordinary acceptance. Retirement, credential revocation
and related audit events commit together. Account, membership, booking and authorship history
is retained.
Retired tombstones never participate in userName or externalId uniqueness conflicts.
A later POST with the same identifiers gets a fresh resource ID and requires explicit
re-admission. It starts unlinked and leaves existing blockers and revoked credentials
in place. For a retained ordinary member, an active POST that reuses the retired entry's
normalized `userName` or `externalId` creates a pending claim without an invitation.
The directory operator provides the new resource ID to the returning person, who signs in to
the same Hourmere account with the verified work address on the claim and confirms it with
`POST /api/auth/organization/complete-scim-readmission` using a browser session and JSON
fields `organizationId` and `scimUserId` (the new ID). Confirmation returns 204.

Under the organization lock, confirmation checks the current account, session, member
role and unexpired claim for the active, unlinked User. It clears only the original
account's SCIM suspension for the retired User of that connection, links the fresh
entry to the retained membership and records `scim_user.claimed` in the same transaction.
A live SCIM suspension, a local suspension or removal of the account or verified mailbox,
or a claim from a different account refuses confirmation. Ordinary invitations and SSO JIT
continue to check the same blockers. The person can select the team after confirmation
subject to its usual SSO requirements. Revoked credentials stay revoked.
Database retention and purge follow the eventual audited retention policy.
Retirement and confirmation are available only through the resource test flag.

SCIM never grants owner or admin, and never deactivates, deletes or demotes a member
who currently has either role, even if other owners remain. This applies to User and
Group operations, including indirect removal of effective access through group changes.
New membership is member; optional group-to-role mapping is a separate future design.
Serialize the role check with native role/departure writes under the organization lock.
Reject each forbidden change atomically with HTTP 403 and a SCIM Error containing
`status: "403"`, `scimType: "mutability"` and safe detail explaining that privileged
membership must be changed through ordinary administration first. The same 403 error
applies to attempts to grant either role through any mapped field or PATCH form. A write of
an empty or unassigned role list on a linked owner or admin is also refused.
Ordinary administration retains its last-owner protection. Provisioning tokens are not
recovery credentials.

The IdP owns mapped profile attributes and managed group membership; manual writes to
those fields return a managed-resource conflict. Unmanaged memberships remain manual.
Local security suspension/removal wins over IdP reactivation; IdP suspension wins over
manual reactivation. Both controls must explicitly clear their own blocker before access
returns. Existing management interfaces must display the managed state and refuse bypasses
on the server, including native Better Auth routes. SSO JIT cannot recreate a suspended
SCIM membership; SSO enforcement still requires a valid team proof after provisioning.

When SCIM resources are enabled, the display name cannot be changed through a manual profile
write while acting in the team where the account has a live SCIM-managed membership. The check
uses the account link and does not infer management from the provisioned email address. Personal settings
and edits in other teams continue to affect only the global account profile. Existing
team administration can change local roles and remove a managed member subject to its
ordinary owner and administrator rules. Removal and departure record a local decision for
the account and its mailbox even when OIDC is off. Invitation issuance, renewal and
cancellation retain their ordinary rules. Accepting an invitation or adding a member
checks live admission blockers under the organization lock. A newer ordinary invitation
can clear local removal. SCIM suspension and local suspension each require clearance by
the authority that recorded them. SSO JIT uses the same blockers for the proven mailbox.

With the resource test flag enabled, **Settings → Team members** labels directory-managed
memberships and shows any active directory suspension, local suspension or local removal.
Owners and admins can see these labels for the requested team rows. Other members can see
them on their own row. A directory-suspended member cannot be promoted to admin until the
directory restores the membership. The display-name form directs a member to their identity
provider if a name change in the acting team returns a managed-resource conflict. When the
member readiness check is unavailable, the page continues to show neutral check feedback.

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
- User creation, available only to test harnesses so far, issues its invitations within the
  existing invitation admission limits: by default 20 an hour and 100 a day per inviter, 50
  an hour and 200 a day per team, 5 an hour and 20 a day per recipient address, and 100
  pending invitations per team. The inviter is the earliest verified owner, so provisioning
  spends that owner's own invitation budget too. An identity provider's first
  synchronization of a larger organization therefore gets 429 with `Retry-After: 3600`
  until capacity returns; the pending cap only frees up as invitations are accepted or
  expire after 48 hours. The `INVITATION_*` limits can be raised.
- User creation records an existing member's address, or one that another pending
  invitation or another entry's claim already holds, as an entry with a pending claim and no
  invitation, and sends nothing. These claims expire after 48 hours and require either the
  retained-member re-admission confirmation or the planned SSO linking proof.
- A claim also lasts 48 hours when it has an invitation. An administrator who resends or
  replaces that invitation gives it a new lifetime but not the claim: once the claim has
  expired, accepting the invitation admits the person as an ordinary member and leaves the
  entry unlinked.
- While the admission limits are exhausted, only a create whose invitation would queue an
  email (a new invitation, or a first delivery for a legacy pending one) gets 429; one that
  reuses a pending invitation's delivery or records a claim without an invitation still gets
  201. A token holder can therefore tell, while the limits are exhausted, whether an address
  needs a new invitation in the organization; the per-recipient limit also counts other
  organizations' invitations, as it does for invitations sent from the app, and only
  addresses that need a new invitation wait for the shared mail-budget lock.
- When creation reuses the inviting owner's pending invitation, that invitation keeps its
  delivery state; if its email already failed, an administrator resends it from the team's
  pending invitations.


## Groups to teams hierarchy authorization

### Decisions

- The hierarchy has one level of child teams. Each team remains a separate
  `auth.organization` with its own members, data and administration. Permissions never inherit.
- One explicit mapping authorizes a parent's SCIM connection to manage a child's name and
  directory-managed roster. Both teams' current owners approve each ordinary link or unlink
  using fresh proof for their own team.
- Local owners and admins retain their own roles and recovery paths. An instance operator
  can stop directory authority for one mapping offline and detach it when departure is safe.
- Existing manual memberships stay manual. Group retirement and unlink preserve the teams
  and their history. Team deletion requires all affected links to be detached first.

SCIM resources remain hard-off during design.

### Scope and topology

A parent can link multiple children. A child has at most one live parent and one live Group
mapping, including while the mapping awaits Group creation. The link and mapping have the
same lifetime and bind the immutable parent and child organization IDs to the parent's stable
provisioning connection. Reject a personal organization on either side, a self-link, a cycle,
a child acting as a parent, and a parent with live children becoming a child. The maximum
depth is one edge. A child already linked to any parent or connection, including the requested
one, cannot take another mapping. Reparenting requires a completed unlink and a new link
with new consent and a new mapping ID. Reject topology conflicts atomically.

Each team authorizes access using its own current membership, role, session or credential,
and applicable SSO proof. A parent role grants no access to child team data, bookings, member
lists, audit history, settings or administrative actions. The same holds from child to parent
and between siblings. A hierarchy link changes neither billing nor membership eligibility.
The only cross-team authority is the mapped connection's SCIM Group authority over the
approved child name and managed roster. The bearer still authenticates to the exact parent URL.
It cannot use the child's SCIM URL or manage its credentials, SSO policy, invitations, roles,
bookings or other team settings. A credential rotated on the same connection retains that
connection's live mappings. Child admins continue to administer their own team subject to the
managed membership guards.

### Linking and unlinking

Each ordinary change requires an explicit approval from a current verified owner of each
team. A single person who owns both approves separately in each team. A browser-only
approval consumes that owner's [fresh administration proof](sso.md#fresh-proof) with the
existing Origin and session checks and records consent on the server. Without enforcement,
require mailbox proof. Mapping-only mailbox proof follows the SCIM resource gate even
when both SSO protocols are off. Under enforcement, require that team's own SSO step-up
with the documented mailbox fallback. Admins, SCIM tokens, delegated clients and SSO
recovery authority cannot approve either side.

Both owners approve one intent bound to the exact action, direction, organization IDs and
connection. A link intent includes the reserved Group `externalId`, authority for the
connection to retire the Group and detach its managed roster, the expected absence
of a live mapping and the child's current link generation. Each link or unlink advances
that generation. An unlink intent includes the exact live mapping ID. Each consent is
bound to the approving owner, their current membership and browser session, and has the
same deadline as the fresh proof that produced it. At commit, recheck both deadlines,
roles, sessions, blockers and applicable team proof and policy. An approved input change
or loss of owner authority invalidates consent.

One of the two approving owners finalizes through mapping administration. REST, MCP and
CLI use the same server-side consent records and consume both once in the mutation
transaction. MCP and CLI also require ordinary write scope and, for an enforced team, a
live delegation for the submitting owner's team. They never receive the original browser
proofs. Stale consent requires new approval. A replay cannot apply a second change.

Mapping reads expose only safe link metadata to current owners and admins authorized in their
own team. Before consent, do not expose a candidate team's private metadata or roster. Use a
uniform denial for an unauthorized or unknown target and report topology conflicts only to
authorized parties. Record `scim_mapping.linked` or `scim_mapping.unlinked` in each team's
[audit journal](audit-log.md) on the same opaque mapping ID. Attribute an ordinary change to
that team's approving owner and identify the action and time. Keep foreign user, credential
and session IDs, mailboxes, proof values and request bodies out of the events and notices.
Queue a notice to each side's current owners at their verified mailboxes in the same
transaction, using the existing notification worker and locale fallback. Rollback and
no-op retries produce no duplicate event or notice.

### Existing teams and Group writes

Owners can choose an existing eligible team or create one through ordinary team creation,
which establishes its local owner before any mapping. Each exact, case-sensitive
`externalId` has at most one live reservation per connection, including pending and
suspended mappings. Retired reservations release the identifier. Group POST can activate
only the unused mapping that reserves that identifier. The selector stays fixed for the life of
the mapping. Group POST cannot create an organization, grant an owner role or adopt a
team by display name. An absent or unavailable reservation gets a generic 409 that reveals
no unrelated team or name. Once created, the Group has its own non-reusable resource ID.
Group reads and writes stay within live mappings of that connection that still allow
directory authority. Ordinary team name constraints apply to the mapped child. Reject
Group-as-member references and all indirect or transitive membership.

Activation makes the child name directory-managed. Existing manual members, owners and
admins keep their membership and roles. Group `members` contains only the memberships
created by that mapping. Resolve additions to an active User in the same connection whose
account link was independently proven. If the account already has a manual membership or a
membership from another source in the child, refuse the entire Group write with 409. A
child membership has one source and cannot be adopted or converted by a directory write.
Full replacement and removal operate only on the mapped roster, and responses never
disclose manual membership details. Refuse conflicting manual changes to the mapped name
or roster while directory authority is active. Child-side role management,
authorized local suspension and removal continue through ordinary administration.

New Group membership grants only the child member role. Check the child's current admission
blockers for the linked account and its verified mailbox. Local suspension or removal in the
child wins over directory writes. A parent team's local blocker affects only the parent.
On a mapping with directory authority, deactivating its source User suspends that User's
retained managed child memberships. Retiring the User removes those memberships through
the managed departure checks below. Revoke the affected child credentials in either case.
The directory suspension follows the retained membership source and ends if the source
is removed. Reactivation lifts only this source's suspension on retained memberships.
A child's own blockers still deny access there and do not decide access in the parent or
siblings. Reactivation does not recreate removed memberships or revoked credentials.
Following User retirement, a new explicitly claimed User needs a new Group member add
for child access. No membership change clears local blockers or blockers from another source.
The Group membership step applies the child lifecycle checks atomically with the source
User write. Refuse the entire SCIM write with 403 `mutability` if it would grant a
privileged role or suspend, delete or demote a current owner or admin on either side.

### Recovery and retirement

Both teams keep their own last-owner protection. The last owner cannot depart, be removed
or be demoted through a link, managed lifecycle operation or ordinary membership change.
Each enforced team also keeps its own last accepted recovery owner under the
[SSO recovery rules](sso.md#recovery). A counterpart or parent owner has no recovery
authority in the affected team. Owners recover through that team's existing owner and SSO
flows, then resume ordinary administration. If the IdP or recovery mailbox is unavailable,
an instance operator can use the [SSO recovery runbook](sso.md#operator-recovery-runbook)
for the affected team. Turning off its enforcement gives no membership or mapping authority.

When consent is unavailable, an instance operator can target the exact mapping ID and
both organization IDs offline against the instance database. The operator can stop
directory authority on the mapping while preserving existing membership and suspension
state. This blocks Group reads and writes and any directory User changes to that child's
managed access, even while booking or privileged-role guards prevent detachment. The
child's administrators regain manual control of its name immediately and can still use
ordinary local security and departure controls. Managed membership guards still apply.
Record `scim_mapping.suspended` as a `system` action in both journals and queue owner
notices in the same transaction. Directory authority can return only after detachment and
a new link with both owners' approval.

The operator can also detach the mapping offline using the normal unlink transaction and
its privileged-member and departure guards. If a guard refuses, the affected team's
authorized administrators resolve the departure impact through ordinary administration
before retrying. Record the unlink as a `system` action in both journals and queue owner
notices. Repeating an already applied offline action is a no-op. Offline authority permits
only suspension and detachment of the identified mapping. It grants no product permissions,
owner appointments, new links or clearance of admission blockers.

Group DELETE and authorized unlink both retire the mapping, end its hierarchy link and
retire any live Group resource ID. Group DELETE requires the scoped credential and a live
mapping with directory authority. Both owners authorize Group retirement as part of the
original link consent. Record the Group deletion and mapping unlink with the token actor
in the parent journal. Record the mapping unlink with the `system` actor in the child
journal, with no foreign token ID. Queue the same owner notices as for manual unlink.
The retirement transaction removes only the mapping's managed child memberships, using the
existing privileged-role and safe-departure checks for current host assignments and
unfinished bookings. Refuse the whole operation if a guard fails. Revoke credentials whose
child authority ends. Keep the child team, its local memberships and blockers, its current name
under manual control, and all booking and audit history. Retired Group IDs return the scoped
404 and cannot be reused. A new mapping needs new owner consent even if it uses the same
`externalId`. Ordinary team deletion, if available, is refused while either side has a live
link. There is no cascade removal of the other team, its memberships or its history.

### Transaction order

Follow the [team membership and host lock order](data-model.md#team-membership-and-host-lock-order).
Acquire every affected organization row `FOR UPDATE` in ascending organization ID order
before locking credentials, consent, hierarchy, Group, membership or booking rows. Any
existing actor identity share locks keep their place in the order. Re-read topology, roles,
blocking decisions, connection authority, approvals and departure impact under the locks
before committing. Pre-read the affected IDs for a write that spans more than one child.
If a recheck finds another affected team, restart with the new sorted set. Never acquire
an additional organization lock after locking a dependent row. Link, unlink, retirement and
native team changes must serialize on these organization locks, including role changes,
local suspension, mapping edits, team deletion and owner departure.
For bulk credential revocation, acquire the existing per-account SCIM revocation advisory
locks in ascending account ID order, after the organization rows and before the credential
rows they protect.

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

The [audit journal](audit-log.md) records token administration as `scim_token.created`,
`scim_token.rotated` and `scim_token.revoked`: the token ID and the session that made the
change, never the name, secret or digest. User creation records `scim_user.created` on the
new resource ID, with the provisioning token as actor (`scim_token`, credential `none`) and
empty details; the invitation it issues records `membership.invited` the same way. Claim
completion records `scim_user.claimed` on the resource ID with empty details, attributed to the
accepting person's session like the `membership.accepted` event beside it, in the acceptance
transaction. Profile replacement records `scim_user.updated` on the resource ID with the
same token attribution as creation, in the profile transaction. PUT leaves details empty.
PATCH records only the ordered operation types, normalized to lowercase.
The shared suspension write records `scim_user.credentials_revoked`. Each active state
transition records `scim_user.deactivated` or `scim_user.reactivated`. These events have
empty details and identify the SCIM resource and the provisioning token actor. The profile,
active state, blocker, credential deletions and corresponding audit rows commit or roll back
together. Repeating a write with the same state adds no lifecycle audit row.
Token foundation must never claim full audit coverage. SCIM action names follow the journal's
one-dot form `<resource>.<past-tense verb>`, as `scim_user.created` does, because the action
check allows exactly one dot. Required future actions:
`scim_connection.authentication_failed` and `scim_connection.rate_limited` (bounded
aggregation); `scim_user.deleted`; `scim_group.created`, `scim_group.updated`,
`scim_group.deleted`; `scim_group.member_added`, `scim_group.member_removed`;
`scim_mapping.linked`, `scim_mapping.suspended`, `scim_mapping.unlinked`; `scim_user.conflicted`;
`scim_user.privileged_member_blocked`; `scim_user.last_owner_blocked`;
`scim_user.membership_suspended`.
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
The harness also passes `scimResourcesEnabled: true` to `createAuth` so native team API key
writes serialize with suspension even when a connection is created concurrently.
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
| Claim completion through invitation acceptance | User creation and claim intent | Existing invitation acceptance; no new operation/tool/command | Resource test flag only | Mailbox and own-account proof through acceptance, same-email account without disclosure, expired invitation, expired claim with a resent invitation, local/SCIM tombstones, claim replay, claims without an invitation untouched |
| Claim completion through SSO linking | Claim completion through invitation acceptance; SSO design PR #247 and accepted linking implementation | SSO linking completion; no new operation/tool/command | Resource test flag only | Own-account proof through the accepted linking flow, claims without an invitation and their 48-hour expiry, same-email conflict, local/SCIM tombstones, claim replay |
| User profile replacement | Claim completion through invitation acceptance | PUT Users/{id}; no MCP/CLI | Resource test flag only | Okta replacement fixtures, server-owned fields protected, no global profile/email takeover |
| User PATCH normalization | User profile replacement | PATCH Users/{id} profile operations; active changes refused; no MCP/CLI | Resource test flag only | Ordered atomic patch, Entra forms, invalid-path rollback, bounded input, mutation assertions |
| Suspension checks on authorization | User PATCH normalization; SSO design PR #247 and accepted linking implementation | Shared REST/MCP/native membership authorization; no new interface | Resource test flag only | Every credential/cached proof refuses suspended team, personal/other-team preservation, native selection and JIT cannot bypass |
| Session authorization revocation | Suspension checks on authorization | Shared session and team-proof revocation; no new interface | Resource test flag only | Active-team sessions revoked, other sessions cannot reselect suspended team, transaction/lock races, bounded pools |
| API-key and OAuth revocation | Session authorization revocation; audit log PR #246 | Organization API-key and MCP grant/binding revocation; no new interface | Resource test flag only | Both credential types revoked atomically or durable outbox persisted before success, other-team credentials preserved, audit atomicity |
| User lifecycle: suspension and reactivation | API-key and OAuth revocation; audit log PR #246 | Enable active writes on POST/PUT/PATCH; no MCP/CLI | Resource test flag only | Every owner/admin deactivation or demotion and role grant returns 403 mutability, role-change races serialize, no key/grant resurrection, local blockers win, audit atomicity |
| User lifecycle: retirement and re-admission | User lifecycle: suspension and reactivation | DELETE Users/{id}; native POST /organization/complete-scim-readmission; no MCP/CLI | Resource test flag only | Unsupported If-Match returns 412, owner/admin deletion returns 403 mutability, retired IDs return 404, the original account can claim a fresh entry, live SCIM and local blockers deny re-admission, history retained, audit atomicity |
| Managed membership server guards | User lifecycle: retirement; SSO design PR #247 and accepted linking implementation | Existing member/invitation/role management REST and native Better Auth writes and shared MCP services; no new operation/tool/command | Resource test flag only | Manual profile/membership changes cannot bypass management, local suspension wins, native/JIT and concurrent reactivation checks, protected owner/admin authority |
| Managed membership UI | Managed membership server guards | Existing member-management UI; no new endpoint/tool/command | Resource test flag only | en/zh-CN managed status and blockers, forbidden manual actions explained, unknown readiness stays neutral, generated-client errors handled |
| [Hierarchy authorization design](#groups-to-teams-hierarchy-authorization) | Managed membership UI | No runtime interface; parent/child permission contract | Resources hard-off | Lead accepts scope, owner/admin recovery, explicit linking and existing-team conflicts |
| Hierarchy storage and guards | Hierarchy authorization design | Parent/child/mapping tables and guards; no new public interface | Resource test flag only | Predecessor preservation, cycle/cross-parent prevention, no sibling authority, privileged-member races |
| Mapping administration | Hierarchy storage and guards; audit log PR #246 | GET/POST `/api/v1/scim/team-mappings`, DELETE `/api/v1/scim/team-mappings/{id}`; MCP `create_scim_team_mapping`, `delete_scim_team_mapping`; CLI `scim-team-mappings create`, `scim-team-mappings delete`; browser consent and offline operator recovery | Resource test flag only | REST/MCP/CLI parity, independent owner approvals, safe metadata, en/zh-CN generated-client UI, audited suspension and detachment |
| Group reads and creation | Mapping administration | GET Groups, GET Groups/{id}, POST Groups; discovery adds Group; no SCIM MCP/CLI | Resource test flag only | Managed child only, name collisions, externalId matching, members projection, no nested groups |
| Group name and replacement | Group reads and creation; audit log PR #246 | PUT Groups/{id}, PATCH Groups/{id} nonmember fields; no MCP/CLI | Resource test flag only | Manual conflicts, replacement, any owner/admin demotion/removal or role grant returns 403 mutability, transactional audit |
| Group membership changes | Group name and replacement | PATCH Groups/{id} member operations; no MCP/CLI | Resource test flag only | Entra removal forms, same-connection Users, replay, blockers, concurrent replacement, source User lifecycle checks across managed memberships, owner/admin access cannot be removed |
| Group retirement | Group membership changes | DELETE Groups/{id}; no MCP/CLI | Resource test flag only | Managed access removed, team history retained, privileged-member and booking checks, subsequent operations 404, retired uniqueness excluded |
| RFC and provider corpus | Group retirement | No new endpoint/tool/command | Resources hard-off | RFC errors/filters/PATCH, Okta PUT/Entra variants, source-copy controls, bounded Postgres pools |
| Local Keycloak harness | RFC and provider corpus | Pinned local image/plugin fixture and synthetic identities; no new interface | Resources hard-off | Document actual SCIM capability, deterministic startup/cleanup, no live third-party calls, reproducible protocol capture without secrets |
| Local lifecycle acceptance | Local Keycloak harness; audit log PR #246; SSO design PR #247 and accepted linking implementation | Local fixture scenarios; no new interface | Resources hard-off | Create/rename/deactivate/reactivate/delete/groups, owner/admin refusal, credential rotation/revocation, recovery, rate limits and audit acceptance |
| Release documentation and registration | Local lifecycle acceptance | Operator/provider docs and production resource registration; no new protocol operation | Enable only after all prior acceptance; same feature for self-hosters | Tested-provider matrix, limitations, rollback drill documented, any intermediate release hard-off proven; complete Users/Groups/conformance before registering handlers; default of `SCIM_PROVISIONING_ENABLED` changed to on, and an install whose `.env` was copied from an earlier `.env.example` (empty value) is on after upgrade without editing `.env` |

The retirement flow above defines proof for a retained member's re-admission. The SSO linking
completion row still needs to define how to prove the other claims without invitations and
apply their 48-hour expiry.

Mapping administration is ordinary product configuration, not credential minting, so it
ships MCP and CLI parity rather than borrowing the browser-only exemption. Additional
writes discovered during implementation need their own row and interfaces before coding.

## Mapping administration in the resource test harness

Open **Settings → SCIM team mappings** from the team you administer. Owners and admins
can see that team's live mappings. To link an existing team, the child owner privately
shares the child Team ID and current link generation with the parent owner. The parent
owner prepares the request using their team's provisioning connection and the directory's
exact Group `externalId`. The request authorizes the directory to retire the Group and
detach its managed roster. To unlink, prepare a request from an existing mapping instead.

Share the exact request privately with the other owner's team. Each owner opens and
reviews it in their own team's Settings and approves it with fresh proof. Both approvals
are required even when one person owns both teams. Either approving owner then applies the
request before both approvals expire. Prepare and approve a fresh request if it expires or
the selected teams, mapping, Group identifier or generation change.

REST exposes the acting team's live links at `GET /api/v1/scim/team-mappings`. To apply
an approved request, send `{ "intentId": "…" }` to `POST /api/v1/scim/team-mappings` or
`DELETE /api/v1/scim/team-mappings/{id}`. Browser sessions bind the request to their
current team with `X-Expected-Organization-Id`. The matching MCP tools are
`create_scim_team_mapping` and `delete_scim_team_mapping`. The latter takes `id` and
`intentId`. The test CLI exposes `scim-team-mappings create` and
`scim-team-mappings delete` with the same JSON inputs as MCP. Machine writes require
the normal write scope and live delegation for an enforced team.

### Offline mapping recovery runbook

Use the resource test checkout and confirm the database, mapping UUID and both organization
UUIDs. Prepare the database and background jobs schema with the usual migrations and
use the harness's configured database connection. The resource-enabled harness passes its
job queue to `createApp` as `scim.mappingNotices`. On its background worker, use
`scimMappingResourceJobs` in place of the ordinary mailbox-proof job definitions so the
same worker handles SSO proof, mapping proof, and mapping owner notices. Use the configured
mailer for delivery. The offline script uses the existing queue without running migrations.

```sh
node scripts/scim-team-mapping-recovery.ts --resource-test suspend MAPPING_UUID PARENT_UUID CHILD_UUID
node scripts/scim-team-mapping-recovery.ts --resource-test detach MAPPING_UUID PARENT_UUID CHILD_UUID
```

1. Suspend the mapping to stop its directory authority immediately. Existing membership
   and suspension state stays in place. The mapping keeps its reserved external ID until
   detachment. A successful suspension records `scim_mapping.suspended` in both journals.
2. Detach when the managed roster can depart safely. If the command reports a conflict,
   have the child team's authorized administrators resolve privileged roles, host
   assignments and unfinished bookings through normal administration, then retry with
   the same UUIDs. Detachment records `scim_mapping.unlinked` and releases the external
   ID. A team with live links must detach them before any future supported team deletion.
3. Both actions record a `system` actor and queue notices for verified current owners in
   the same transaction. A retry of an applied action reports no changes. An incorrect
   UUID combination is refused. Check the worker's delivery status after a successful
   command. Owner notices use their saved language with the usual fallback.

普通关联和解除关联可在团队的「设置 → SCIM 团队映射」中办理。关联前，子团队所有者应私下
提供本团队 ID 和当前关联代次，父团队所有者再用本团队的配置连接及群组 `externalId` 准备
请求。解除关联时，从已有映射准备请求。双方所有者在各自团队内核对并验证同一份请求，
然后由任一批准人提交。即使同一人拥有两个团队，也要分别批准。批准过期后，须重新准备请求。

需要离线恢复时，先核对测试数据库和三个 UUID，再用上述 `suspend` 命令暂停目录管理。现有
成员关系和暂停状态会保留。若要解除映射，请运行 `detach`。如存在受保护的角色、主持安排或
尚未结束的预约，请由子团队的授权管理员先通过常规管理流程处理，再重试。成功后，双方团队
都会在审计日志中看到系统操作，后台任务会向当前所有者的已验证邮箱发送通知。

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
