# Team custom roles and credential compatibility

**Proposed design. Custom roles are unavailable today.** Start implementation only after
multi-role browser acceptance and the Chinese team handoff are complete, and the release
follow-up plan confirms customer demand, scope and capacity. Shipping the initial release
does not enable custom roles. [Cal.com's role editor](https://website.cal.com/blog/role-based-access-control)
is a reference for grouping permissions. Hourmere uses explicit grants within one team
and keeps its existing identity and resource boundaries.

## Current gates and proposed catalogue

The operation IDs, gate predicates and target and projection exceptions in this section
record the v1 fixed-policy reference. Add a new catalogue version to change the
reference used by saved revisions or credential ceilings.

**Owner** and **Admin** mean the current fixed team roles. **Member** means an effective
team member, including owners and admins. **Host** means an assigned host authorized by
the existing booking relationship. **Custom** marks actions eligible for explicit grants.
**Fixed** marks actions that retain their current role or relationship predicate.
An operation missing from the catalogue always uses its current fixed-role or relationship check.

Each proposed ID identifies a specific operation, target predicate and response projection.
Team booking detail and host booking detail are separate operations. A grant covers only
the named action. Read presets expand to explicit IDs at save time. Wildcards, implied
grants and automatic inclusion of future actions are forbidden. An endpoint with multiple
effects checks each required permission. The same boundaries apply to alternate entry
points, optional response sections and exported columns.

Phase one grants only the **scheduling coordinator** permissions marked **Custom (phase one)**.
These grants expose no invitee personal data and give no authority to configure new paths
for data to leave the instance. Permissions marked **Custom (phase two, personal data)**
are deferred to phase two. Team booking reads include invitee personal data even in the
limited projection. Waitlist settings govern collection and contact, and access to entries
stays Fixed. Open-time snippets may reflect host availability. `analytics.read` is
aggregate-only in phase one. Any future permission that adds identifiable analytics needs
a distinct ID and a personal-data label. All **Fixed** operations keep their existing
predicates in both phases.

| Current resource and actions | Current team gate | Proposed permission IDs and classification |
| --- | --- | --- |
| Team creation, context, roster and settings | Verified browser session creates a team with the creator as fixed Owner. Member switches team and reads shared roster names, IDs and roles. Owner/Admin read the expanded roster projection and update team name, slug, logo and metadata with existing SCIM restrictions. Better Auth's advisory `has-permission` read uses fixed-role results in the native vocabulary. | **Fixed** `team.create`, `team.switch`, `members.read`, `members.read_private`, `team.update`, `team.read_native_permission`. |
| Invitations | Owner/Admin list and inspect invitation and delivery state, invite, resend, replace expired invitations and cancel. Only fixed Member is issuable, including on the trusted native add-member path. The verified addressed recipient accepts or rejects using existing proof and lifecycle checks. | **Fixed** `invitations.read`, `invitations.create`, `invitations.resend`, `invitations.replace`, `invitations.cancel`, `invitations.respond_self`, `members.add_trusted`. |
| Member roles and removal | Only Owner may assign Admin or Member to a different non-owner. Owner removes Admin or Member. Admin removes Member only. Owner targets are never administratively removed or demoted. Member can leave safely and inspect own departure impact. Owner/Admin can inspect others' impact and post-removal handling. | **Fixed** `members.assign_role`, `members.remove`, `members.leave_self`, `members.read_own_departure`, `members.read_departure`, `members.read_removal_handling`. Direct Owner assignment and team deletion stay unavailable. The separate proposed ownership transfer remains Fixed. |
| Readiness and host picker | Member sees own readiness. Owner/Admin see team readiness, host picker and display-safe coarse readiness of other current members. | **Fixed** `readiness.read_self`. **Custom (phase one)** `readiness.read_team`, `event_types.list_host_candidates`. Host picker rights exclude private schedules and accounts. Preserve the weekly-hours hint and neutral unknown or unavailable states. |
| Event types and notifications | Member can read the team catalogue, detail and saved notification settings. Owner/Admin create, duplicate, edit, change hosts and notifications, set the success redirect, activate round-robin and soft-delete. | **Fixed** `event_types.read`, `event_notifications.read`, `event_types.update_success_redirect`. **Custom (phase one)** `event_types.create`, `event_types.duplicate`, `event_types.update`, `event_types.assign_hosts`, `event_types.activate_round_robin`, `event_types.delete`, `event_notifications.update`. On create, duplicate and patch check the effective write, including host, notification, waitlist and success-redirect settings supplied or copied. Provider consent, redirect/personal-data opt-ins and host validation still apply. |
| Availability, waitlist and booking links | Owner/Admin troubleshoot availability, generate open-time snippets, read/change waitlist settings, list/remove waitlist entries and create/list/revoke one-time links on team-owned events. | **Custom (phase two, personal data)** `event_types.generate_open_time_snippet`, `waitlists.read_settings`, `waitlists.update_settings`. **Fixed** `event_types.diagnose_availability`, `waitlists.list_entries`, `waitlists.remove_entry`, `one_time_links.create`, `one_time_links.read`, `one_time_links.revoke`. Keep diagnostic privacy and one-time secret and creator-email handling. |
| Team bookings and CSV | Owner/Admin browser sessions list and view the limited team booking projection, cancel eligible bookings, look up an authorized booking's organization and export team CSV. Hosts have their separate booking lookup. | **Custom (phase two, personal data)** `team_bookings.read`, including the authorized organization lookup. **Fixed** `team_bookings.cancel`, `team_bookings.export`. Preserve field whitelists, opaque lookup errors and the session-only team paths. |
| Attendance, no-shows and group occurrences | Host or Owner/Admin browser session can view attendees, mark/unmark no-shows, view group-occurrence rosters and cancel an entire occurrence. Key and MCP OAuth callers use the distinct host path only. Host-only booking list/detail, cancellation, reschedule/slots, requests to pick a new time and calendar/conference repair retain host authorization. | **Fixed** `attendance.read`, `attendance.mark_no_show`, `attendance.unmark_no_show`, `group_occurrences.read_attendees`, `group_occurrences.cancel`. A team role cannot grant host operations or access to a private manage token. |
| Meeting polls | Owner/Admin of the team event list/read polls and results, create, close, cancel, invite/resend, remove voters or unverified voters, rotate the public link, delete and finalize. | **Fixed** `polls.read`, `polls.read_results`, `polls.create`, `polls.close`, `polls.cancel`, `polls.invite`, `polls.resend`, `polls.remove_voter`, `polls.remove_unverified`, `polls.rotate_link`, `polls.delete`, `polls.finalize`. Public voting and voter links use their own authority. |
| Branding and booking activity | Owner/Admin read team branding, update branding, upload logos and read aggregate booking analytics. Public branding lookup is independent. | **Custom (phase one)** `branding.read`, `branding.update`, `branding.upload_logo`, `analytics.read`. |
| Webhooks and Slack | Owner/Admin list/create/update/delete endpoints including webhook subscriptions and pause, rotate webhook signing secrets, read delivery metadata and send a Slack test. | **Fixed** `webhooks.read`, `webhooks.create`, `webhooks.update`, `webhooks.delete`, `webhooks.rotate_secret`, `webhooks.read_deliveries`, `slack_destinations.read`, `slack_destinations.create`, `slack_destinations.update`, `slack_destinations.delete`, `slack_destinations.test`. Endpoint creation and subscription changes can disclose booking data off-instance. Preserve existing output masking and one-time secret exposure. |
| Routing forms | Owner/Admin list/read, create, edit, archive, publish and preview. Feature, tenant, target and revision checks apply. Public submission is separate. | **Custom (phase one)** `routing_forms.read`, `routing_forms.preview`. **Fixed** `routing_forms.create`, `routing_forms.update`, `routing_forms.archive`, `routing_forms.publish`. Preserve synthetic draft preview and its full-key boundary. |
| Workflows | Owner/Admin list/read definitions and run history, create, preview, edit, enable/disable and delete. Owning scope and feature gate apply. | **Custom (phase one)** `workflows.read`, `workflows.read_runs`, `workflows.preview`. **Fixed** `workflows.create`, `workflows.update`, `workflows.enable`, `workflows.disable`, `workflows.delete`. Keep preview synthetic and history metadata-only, without invitee identities. Team-owned jobs retain their existing execution-time scope and recipient checks. |
| Audit journal | Owner/Admin list events and read retention settings. Only Owner changes retention. REST uses a browser session or full key. MCP also supports OAuth and the CLI uses a key. The purge job acts under instance authority. | **Fixed** `audit.read`, `audit.read_retention`, `audit.update_retention`. |
| Billing and booking payments | Price settings and Stripe Checkout are limited to eligible personal event types. Test-mode admission defaults to off and live admission remains closed. Team billing and standalone refund administration are unavailable. Authorized cancellation of an eligible paid booking requests a refund, while rescheduling retains the same payment. Stripe configuration, signed webhook handling, refunds and reconciliation belong to the operator and provider flows. | **Fixed** booking cancellation and refund obligations stay together. No `billing.*` or `payments.*` grant and no standalone refund action. |

Sources include [native role policy](../packages/auth/src/team-role-policy.ts),
[member read privacy](../packages/auth/src/member-read-privacy.ts),
[team management](../packages/auth/src/team-management.ts), [REST routes](../apps/server/src/routes),
[event-type service](../packages/scheduling/src/event-types.ts), [team booking projection](team-admin-bookings.md),
[routing forms](routing-forms.md), [workflows](workflows.md), [audit journal](audit-log.md)
and [payment boundaries](payments.md).

For phase-one event type creation and duplication, a disabled waitlist and absent redirect
are neutral defaults. Enabling a waitlist or setting a redirect, including when copied from
the source event type, requires its separate authorization.

### Identity, directory and credential operations

All rows in this table are **Fixed**. Existing identity authority remains reserved.
SSO, SAML and SCIM retain their independent feature and proof gates.

| Proposed operation family | Current authority and actions |
| --- | --- |
| `sso.read_providers`, `sso.read_policy`, `sso.read_links` | Owner/Admin read safe provider/policy summaries with the applicable proof and existing session, read/full key or MCP OAuth surface. The identity-link management view uses browser authorization and existing target privacy. |
| `sso.create_provider`, `sso.update_provider`, `sso.test_provider`, `sso.retire_provider`, `sso.set_admission` | Owner/Admin use browser configuration and admission-only paths, with fresh proof where required and existing availability and continuity checks. |
| `sso.activate_provider`, `sso.deactivate_provider`, `sso.set_enforcement` | Only fixed Owner activates or deactivates a provider or changes required SSO, with existing fresh proof and any narrowly scoped recovery exception. |
| `sso.challenge_domain`, `sso.verify_domain`, `sso.retire_domain`, `sso.retire_member_link` | Browser Owner/Admin with the operation's required proof and safeguards. Retiring an Owner's link requires Owner authority. |
| `sso.link_self`, `sso.unlink_self`, `sso.bind_credential_self`, `sso.revoke_binding_self` | Self-service uses the same current eligibility, verified identity, expected team and browser checks. Link and unlink retain their own proof rules. Binding requires fresh SSO and ownership of the exact key or grant. Users revoke their own binding through the existing safe path. |
| `sso.nominate_recovery`, `sso.accept_recovery`, `sso.use_recovery` | Current fixed owners under the existing nomination, acceptance and fresh independent mailbox proof rules. Recovery use authorizes only the designated repair. Operator recovery remains separate. |
| `scim.read_tokens`, `scim.revoke_token`, `scim.create_token`, `scim.rotate_token` | Browser Owner/Admin list token metadata and revoke. Only fixed browser Owner creates or rotates. Authorization-bearing requests are refused. Preserve proof, expected team and availability rules, including revocation when provisioning is off. |
| `scim.read_mappings`, `scim.approve_mapping`, `scim.link_team`, `scim.unlink_team` | Owner/Admin list mappings. Preparation and independent approval use fixed owners of the respective teams and existing browser, generation and proof checks. Finalization requires the approving fixed Owner and valid authorization for the exact mapping, with current binding/proof on supported bearer paths. Preserve child, parent, connection and generation checks. |
| `scim.provision_users`, `scim.provision_groups` | Exact connection and organization provisioning token under the existing SCIM discovery and Users/Groups operation allowlist. Only fixed Member is provisioned. Preserve protections for existing fixed Owners and Admins, directory blocks and managed-membership rules. Team grants have no meaning at the SCIM endpoint. |
| `credentials.manage_own_key`, `credentials.manage_own_oauth_grant` | Credential-owner browser and trusted-native checks control keys. MCP OAuth approval, grant listing and revocation retain the browser owner's binding and consent rules. Team role editing provides no authority to mint, copy, retarget or re-scope someone else's credentials. |

See [SSO](sso.md), [SCIM](scim.md), [SCIM token policy](../packages/auth/src/scim-tokens.ts),
[SCIM hierarchy proofs](../apps/server/src/scim-team-hierarchy-proof.ts),
[API-key operations](../packages/auth/src/api-key-operations.ts), [API keys](api-keys.md),
[MCP](mcp.md) and [CLI](../tools/cli/README.md) for operation-specific restrictions.

API keys act in one organization at a time. Native key metadata updates can currently
move an owned key between eligible organizations without changing its scope. The scope
registry classifies REST operations, MCP modes and CLI aliases. All three scopes allow
booking-workflow reads,
and full/bookings allow booking actions. Other reads generally accept full/read.
Account settings writes, audit reads and availability diagnostics require full.
Session-only operations have no key scope. The team CSV shares a REST path with personal
CSV, where scoped keys can still use their existing access. A valid OAuth grant can
call MCP only, under its live grant and team checks. CLI uses the configured API key
through MCP or a documented REST path. An invalid Authorization header never falls
back to a browser session or independent anonymous capability.

Personal schedules, calendars, conference accounts, calendars' busy times, public booking
and independent invitation or booking capabilities keep their own authorization. A new team
permission grants no authority over any of those objects or over another team.
The separate event-owner branch for one-time links keeps its own ownership and
per-member limit even when the event is in a team context.

## Role model and safe writes

- A membership keeps its fixed role or selects one custom role. A custom assignment
  requires an eligible fixed-Member base row, which retains ordinary Member self-service
  and shared reads without Admin inheritance. Fixed Owner and Admin remain immutable
  role definitions. Fixed-role transitions keep their current owner-only API. An Admin
  must first be explicitly demoted through that API before a separate custom assignment.
  Store custom identity separately from Better Auth's `member.role`. When a custom
  member is explicitly promoted to fixed Admin, clear the custom assignment, advance
  authorization and audit the transition in the same transaction.
  If a member with a custom assignment confirms an ownership transfer, clear their custom
  assignment, advance their authorization generation and audit the change in the same
  transaction as the Owner promotion. Keep the proof and continuity guards of the
  [ownership transfer design](https://github.com/hourmere/hourmere/pull/599).
- Only a current fixed Owner in a verified browser session can create, revise, archive
  and assign custom roles. Require the expected team, same-origin checks and fresh
  reauthentication, including current SSO proof for an enforced team. Emergency recovery
  cannot authorize role management. Reject self-assignment, fixed or custom self-promotion,
  editing a role that controls the actor, and inclusion of reserved actions. Check
  membership identity and targets again inside the write.
- Serialize role and membership changes on the same organization `FOR UPDATE` lock that
  governs owner continuity. Keep the established context fence and lock order. Re-read
  the live actor, session, target memberships, SCIM blocks, assignment and role revisions
  under those locks. Retain the defensive last-Owner count and last-recovery-owner guard
  in the same transaction. Owner targets stay protected on native, REST, trusted, SCIM
  and background write paths. Archive in use returns a conflict. Moving a member to
  another role or back to base Member is explicit and audited.
- A custom grant augments only the base Member's explicit actions in that team. Missing,
  revoked, unrecognised or malformed assignments, permissions and revisions deny the
  custom operation. They never fall back to Admin or a legacy management decision.
  Labels, Better Auth strings, feature flags, route parameters and
  `X-Expected-Organization-Id` confer no authority. Cross-team reads and stale writes
  preserve the existing uniform denials and validated context-conflict behavior.
  Filter team, object and projection before disclosure. Recheck dependencies such as
  host membership, target ownership and permitted field changes on every operation.

## Storage, migration and credential versions

**Proposed storage.** Use stable, team-scoped role IDs, an immutable positive revision
per role, a stable ID for each membership incarnation, and a monotonic authorization
generation per member. Store an explicit permission set and catalogue version in each
revision. Use team-scoped foreign keys for assignments and active revisions. Publish a
revision and advance affected authorization generations atomically. Frozen built-in
manifests use stable permission and operation IDs. A new catalogue or preset cannot
rewrite a saved revision or widen an issued credential. Unknown versions, IDs and
ambiguous assignments fail closed.

**Fixed-role backfill.** Keep legacy `auth.member` values, owner counts, invitations and
tenancy unchanged. Snapshot the known fixed-role predicates, including exact trimmed
comma-separated role tokens and operation-specific exceptions. Map existing known rows
to the matching fixed policy and record one baseline generation for each membership.
Avoid a blanket precedence rule for legacy multi-token rows. Leave an ambiguous row on
the fixed path while the team is off and block activation until the owner resolves it.

The membership lifecycle keeps the snapshot in sync with live native role tokens. New
teams receive a disabled policy at commit, after personal-space classification. New
members receive a baseline authorization row. A missing policy or member row always
uses the fixed path and grants no custom permissions. Promotion and ownership-transfer
writes clear an ineligible assignment, advance its generation and record the automatic
clearance in the same transaction even when both switches are off.
Backfill cannot infer an owner or promote a member. Verify a fresh install, repeat
migration and representative predecessor data. While hard-off, ordinary fixed-role
traffic uses the existing path and custom roles cannot be written, assigned or resolved.

**Activation.** The instance-wide master switch and each team's custom roles setting
default to off. Both must be on for custom roles. After the final implementation row is
accepted, require explicit opt-in for each team. Only a freshly verified fixed Owner can
enable or disable custom roles for a team through browser REST. Use the same proof checks
as for role management. Preflight lists only currently custom-assigned memberships whose
custom authorization needs renewal and shows the impact. An initial opt-in without
assignments has no affected credentials. Drain older authorization writers before
activation and enforce a minimum compatible binary across web, worker, auth and job entry
points. Opt-in advances a team policy epoch under the organization lock.
Complete the [enablement checklist](#enablement-checklist) before rollout.

**Version boundary.** A version-bound team operation is an operation authorized through
a custom grant. Authority the credential already holds under a fixed-role or independent
relationship check uses that existing path. Fixed roles keep their current
decision path and credentials across enable, disable and re-enable. Existing fixed-role
browser sessions, API keys, OAuth grants and integrations, including Zapier and n8n,
continue to authorize the same operations without renewal.

Apply the version boundary only to memberships with a custom assignment change.
Creating, replacing or clearing a custom assignment advances that member's authorization
generation. Publishing a revision counts as an assignment change for every member assigned
to that role and advances their generations.
A credential issued before the member's current authorization generation can lose
access, but cannot gain it. A credential issued before assignment clearance requires
explicit renewal for newly acquired fixed Admin or Owner authority, including after a
later, separate promotion. Ordinary base Member access continues under the existing checks.

For a membership subject to this boundary, carry forward prior elevated team authority
only if a trustworthy record establishes a ceiling for that specific legacy credential
and member incarnation. Intersect that ceiling with a frozen manifest of pre-custom operations,
targets and projections. When older records cannot establish the ceiling, refuse
version-bound team operations and newly acquired fixed-role authority until explicit renewal.
Deriving the ceiling from the current role alone could silently grant a promotion and
is forbidden.

**On use.** Allow a version-bound team operation only if the feature and transport allow it, the
credential's issued ceiling explicitly contains it, and current team membership,
credential scope, role revision, identity proof and object/field predicates allow it.
For that operation the team policy epoch, member incarnation, membership authorization
generation and credential generation must match the accepted record. Writes repeat the checks after
contended locks on the same transaction as the write. Reads and discovery use current
facts. Permission removals take effect as soon as the change commits. Older credentials
may lose access, and a later increase cannot restore or widen them automatically.
Compare-and-swap edits use the expected role and membership revisions and return a
conflict when stale. Idempotent replays recheck authorization before returning a receipt.
Standalone public, self-service and SCIM operations keep their own authorization.
Step-up, approved owner recovery and safe credential removal stay reachable through
their existing identity checks even when the team version needs renewal.

Apply the credential rules below where a custom-assignment boundary applies. SCIM tokens
keep a separate directory protocol ceiling.

| Credential | Compatibility and explicit renewal |
| --- | --- |
| Browser session | Bind the team's authorization ceiling to the current session and team membership incarnation. Renew through fresh interactive sign-in or step-up that explicitly confirms the selected team and current version and replaces its team authorization record. An ordinary active-space switch, cookie refresh or rolling expiry cannot confer greater authority. Keep personal and other teams isolated. |
| API key | Preserve immutable `full`, `read`, `bookings` scopes and the original team/member binding. A legacy `full` key gets at most its bounded legacy operations. For increased authority issue an explicitly approved replacement with a new ID and pinned ceiling. Updating metadata or creating an SSO binding cannot expand the old key. |
| MCP OAuth | Keep `mcp:tools` and existing consent, client, team, session and offline-access checks. Present changed authority at explicit re-consent and issue a fresh grant identity, invalidating superseded codes, access and refresh generations. Recheck the ceiling at code exchange, refresh and tool use, including cached tool calls. Refresh keeps the original ceiling. |
| SCIM token | Pin the existing directory method/resource allowlist to the token, connection and team under a separate protocol version. Current and overlapping secrets may continue with the same ceiling. Recheck token revocation, connection and current target protections under the protocol write locks. Team opt-in and ordinary secret rotation cannot add an action. Future protocol expansion requires a new version and explicit owner issuance without broader overlap. Directory tokens never call role management. |

To issue a key or OAuth grant with custom authority, require a current versioned browser
authorization and an explicit review of the issued scope and team authority.
A stale browser session cannot mint a credential with a higher ceiling than it holds.
Reject key retargeting when either the old or requested binding is subject to a
custom-assignment version boundary, including a null metadata update that would target
personal. Fixed-only bindings keep their existing retargeting rules. Recheck both
organizations, relevant memberships and the key row in one transaction, locking
organizations in a stable order. Apply this to native HTTP and trusted calls. Metadata
edits within the same organization can preserve the ceiling. Disabling and revoking
a key remain available under the existing credential-owner checks.

SSO enforcement, provider/link trust and delegation remain additional checks. An SSO
delegation binds one user, member, team, key or grant and its current proof generations
and deadline. It conveys proof only. It cannot renew a permission version, replace an
OAuth consent, change a key scope or replace a new credential's separate binding.

For SCIM-managed members, local owners may assign a custom role to an active, eligible
Member. Directory writes can revoke that access through existing suspension and
deprovisioning. A suspended, removed or blocked member cannot be promoted through a
local edit. Readmission starts with fixed Member and a new authorization generation.
Historical assignments and credentials do not resume automatically. Preserve fixed
Owner/Admin and recovery protection, cross-team mapping isolation and revocations.

**Disable and recover.** After opt-in, turning the feature off freezes custom management
and denies custom grants while retaining the affected memberships' version boundaries
and current fixed authority. Fixed-role promotions, ownership transfer, departure and
SCIM revocation still clear dormant assignments and advance the affected authorization
generation in the same transaction while either switch is off. Advance the policy epoch
on both disable and re-enable.

Turning off the instance runtime switch after use makes
`POST /api/v1/teams/{teamId}/permissions/renew` return `404 custom_roles_disabled`.
Members with an authorization generation greater than 1 cannot renew while that switch
is off. Affected sessions waiting to use newly acquired fixed Admin or Owner authority
remain restricted until the operator restores the switch and the member renews.

The instance-wide master switch also advances the effective policy epoch for opted-in
teams on both transitions, without changing their opt-in settings. These epoch changes
apply only to custom authority. Explicit renewal is required before restored custom
rights can be used. A custom membership never becomes Admin through this transition,
and policy epochs never go backward. Role history remains available through supported
repair operations. The operator uses the
supported backup/restore procedure for binary downgrade. Revoke restored, potentially
stale credentials for affected memberships and reissue explicitly before resuming
traffic, so older binaries never serve teams with custom authorization state or
reactivate superseded credentials.

## Interfaces and acceptance

- **REST.** Proposed browser routes under `/api/v1/teams/{teamId}` include
  `GET /permissions` for the caller's effective team actions, `GET/POST /roles`,
  `GET/PATCH/DELETE /roles/{roleId}`, `PUT /members/{memberId}/custom-role`
  and `PUT /permissions-mode` for enable and disable. Role definitions, assignments
  and team enablement are managed only through browser REST by a freshly verified fixed Owner.
  `DELETE` archives, and the assignment request explicitly names a role or clears it.
  Include expected team and revisions on writes. Use bounded lists, strict inputs,
  stable opaque IDs and open response enums.
  Use `404 custom_roles_disabled` before target lookup only when the instance is hard-off.
  Otherwise authorize the caller and team context before returning any team-specific
  disabled state. Use `403 team_management_access_denied` for inaccessible callers or
  targets and `409 role_revision_conflict` for authorized stale edits. Preserve existing
  scope, context, not-found and owner continuity errors.
  Native Better Auth and trusted calls keep fixed-role restrictions and reject custom
  strings. Native `has-permission` stays advisory. The new permission read is the
  effective view for the browser caller's team and current credential.
- **MCP and CLI.** Existing tools and commands use the same checked service and
  credential scope registries. Apply equivalent team-policy and credential-version
  checks to `tools/list` and direct `tools/call`, including cached tools. Keep known
  scope denials as `insufficient_scope`, resource masking and CLI exit conventions.
  API keys, MCP and CLI cannot manage role definitions, assignments or team enablement.
  A later release may expose only read-only self-permissions to MCP and CLI.
- **Audit.** Use the append-only team journal for `custom_role.created`,
  `custom_role.revised`, `custom_role.archived`,
  `membership.custom_role_assigned`, `membership.custom_role_cleared` and
  `team.custom_roles_enabled`/`team.custom_roles_disabled`. Store actual actor and
  target IDs, role IDs, old/new revisions and policy versions, outcome and time in a
  fixed detail allowlist. Commit the change and event atomically. Refusals, no-ops
  and replay create no success event. Exclude display names, raw configuration, secrets,
  proof/session IDs and member personal data. Keep current reader and retention rules.
  Record the personal-data permission IDs in assignment and clearance events when the role
  includes them.
- **UI.** Settings → **Roles and permissions** / 设置 → **角色与权限** shows fixed
  roles as read-only and lets an owner edit a custom role by area using
  **No additional access / Read only / Custom** and **不增加权限 / 只读 / 自定义**.
  Explain the base Member access retained by each preset and label fixed
  and owner-only actions. The member screen previews added and removed effective actions
  before assignment. When phase two ships, group its personal-data permissions separately
  in the editor and assignment preview under **Personal data / 个人数据**. Explain
  what each grant exposes, including invitee data in the limited team booking projection.
  Explain browser verification, key replacement and OAuth re-consent for affected members.
  Localize labels and conflict, denial and reauthorization states in English and
  Simplified Chinese. Keep the roles screen unavailable while hard-off and present
  readiness errors and unknown states neutrally.

### Team setup and credential renewal

Custom roles are staged behind the instance and team switches, which both start off.
After operator rollout, a fixed Owner can open **Settings → Roles and permissions**,
review the affected memberships, and verify their identity to enable or disable the
team setting. An Owner can publish a role's first revision from the editor, publish
later revisions with the changes shown, and archive a role after removing its
assignments. **Settings → Members** shows which permissions change before a fixed
Member receives a role or returns to base Member. Saving a role or assignment does
not add authority to an existing session, key, or OAuth grant.

Affected members can review their team's current authorization and verify their
identity in Settings. To give an API key the updated authority, use the reviewed
browser session to create a replacement key for that team and select its immutable
scope. To update an MCP OAuth connection, select the same team and approve its
current authorization. The new consent supersedes the previous team grant for
that client. Ordinary browser refreshes, team switches, and OAuth token refreshes
carry the existing ceilings.

During staging, verify with the same team and client before and after disabling and
re-enabling the team setting. Affected credentials lose custom actions as soon as
either switch closes or the membership generation changes. Bringing a switch back
does not restore a previously issued custom ceiling. Fixed-role credentials for
memberships outside this boundary continue to work across switch changes.

The event types, routing forms and workflows pages still use fixed roles to decide
which controls to show. A Member with a custom grant may have access through the
service while the browser hides the action. An affected Admin awaiting renewal may
see controls whose requests return 403. Server authorization is authoritative for
every request.

中文：活动类型、路由表单和工作流页面仍按固定角色显示控件。获得自定义授权的普通成员可能
无法在浏览器中看到相关操作，等待续签的管理员也可能看到提交后返回 403 的控件。每次请求
以服务端授权为准，正式启用前须对齐这三个页面的权限显示。

实例使用过此功能后，如果关闭实例运行时开关，浏览器权限续签接口将返回
`404 custom_roles_disabled`。授权代际大于 1 的成员须等到开关恢复后才能续签；受影响的
会话须完成续签后才能使用新取得的固定管理员或所有者权限。

### Enablement checklist

- Align the event types, routing forms and workflows pages with effective permissions.
  Verify that custom-granted Members can reach allowed actions and that affected Admins
  awaiting renewal are guided to renew before using newly acquired authority. Preserve
  all server authorization checks.
- Rehearse disabling the instance runtime switch after use. Verify that browser renewal
  returns `404 custom_roles_disabled` while it is off and that members with an
  authorization generation greater than 1 can renew after the operator turns it back on.

## Test plan for the implementation

| Area | Acceptance checks |
| --- | --- |
| Fixed-role compatibility | Compare operation, target and field decisions against the pre-custom path for Owner, Admin, Member, legacy multi-token roles and personal spaces. Verify existing fixed-role sessions, all key scopes, OAuth grants and Zapier/n8n integrations keep working across enable, disable and re-enable without renewal. Include native and trusted calls and fixed Member invitations. Verify predecessor upgrade, fresh install, no-op migration and transactional audit coverage. |
| Authorization and races | Reject self-assignment, reserved IDs, wildcards, foreign roles/members and stale revisions. Confirm a custom-assigned member's ownership transfer atomically clears the assignment, advances the generation and audits the change. Exercise idempotent replay, concurrent owner departures, recovery-owner continuity, SCIM-managed membership and deprovision or role changes racing a write. Check compound create/duplicate/patch effects and opaque disabled-team lookups. Assert no forbidden write, data disclosure, welcome email, refund or audit success. |
| Credentials | With old and new browser sessions, all key scopes, online/offline OAuth grants and SCIM current/overlap tokens, test cutover, replay, refresh, switching teams, leave/rejoin, re-consent, disable/re-enable and rollback. Race native key retargeting against opt-in and assignment changes, including legacy personal fallback. Assert immediate loss on revocation/suspension, explicit renewal for gains after a custom assignment change, separate new bindings under SSO enforcement and reachable renewal/revoke/recovery paths. Verify team opt-in is unavailable while the master switch is off and only a freshly verified fixed Owner can change the team setting through browser REST. |
| Interface parity and privacy | Verify permitted and denied REST, cached MCP direct calls, CLI error handling, native fixed-role requests, narrow responses, session-only team CSV, non-host booking privacy and independent feature gates. Check phase-one analytics, previews and workflow run history for the documented privacy limits. Verify browser acceptance in both locales with Owner, Admin, Member and custom role, including neutral weekly-hours readiness. In phase two verify the separate personal-data label and assignment audit details. |

### Implementation follow-ups

| Row | Engineering scope and exit criteria |
| --- | --- |
| Storage and migration · about one day | Add versioned catalogue and team-scoped role, assignment and credential storage, legacy fixed-role mapping, migration coverage and predecessor/fresh/no-op verification. Land with custom roles hard-off. |
| Resolution engine and versioned reads · about one day | Centralize per-operation decisions with the epoch and membership generation, add browser `GET /permissions` and test fail-closed resolution. A registry test requires every team-scoped operation, including those in `api-key-operations.ts`, the MCP tool list and session-only routes, to map to a catalogue entry marked Fixed or Custom. Land with custom roles hard-off. |
| Role and assignment writes · about one day | Add owner-only browser REST role and assignment writes with fresh proof, append-only audit and organization-lock rechecks. Test conflicts, ownership transfer, last-owner and recovery-owner guards and concurrent membership changes. Land with custom roles hard-off. |
| Phase-one grants wired into services · about one day | Wire only scheduling coordinator grants into the existing services and recheck team, target, fields and compound writes under the appropriate locks. Exercise phase-one authorization and privacy across existing entry points. Land with custom roles hard-off. |
| Credential ceilings and enable flow · about one day | Apply browser, key and OAuth ceilings, preserve SCIM protocol authority, and add master-switch enforcement and the fixed-Owner team preflight and opt-in. Test enable, disable and re-enable and the key retargeting race. Land with custom roles hard-off. |
| Edit and assignment UI · about one day | Add the bilingual editor and member assignment preview for phase one. Use jsdom tests for presets, fixed permissions, freshness prompts and stale or denied writes. Land with custom roles hard-off. |
| Cross-interface and browser acceptance · about one day | Verify REST/MCP/CLI and both browser locales with fixed and custom credentials. Rehearse disable and repair. Land with custom roles hard-off. Keep hard-off until this row is accepted and the lead explicitly authorizes rollout. Both enablement switches default to off. |

Before scheduling, the lead confirms target users and the entry criteria above.
Each implementation PR needs passing tests and CI and
review by someone other than its author. Split any row that exceeds one workday while
retaining all protections and gates.
