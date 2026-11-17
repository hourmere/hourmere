# Audit event journal

Every self-hosted and Cloud instance records the audit events listed below without plan
gating; actions that are not listed are not recorded (see [Not recorded](#not-recorded)).
Owners and admins read it on the admin page and through REST, MCP and the CLI
([Reading the journal](#reading-the-journal)); owners choose how long it is kept
([Retention](#retention)). Export is future work. It is separate from booking activity
analytics.
Existing changes are not backfilled. Recording starts with the upgraded application;
stop old application/worker processes during rollout because old binaries do not
write this journal.

## Fields and transaction boundary

`audit_events` has a monotonically allocated bigint `id`, nullable UUID
`organization_id`, UTC `occurred_at` (`timestamptz`, database clock at insertion),
`actor_type` and `actor_id`, credential type/identifier/scope and OAuth client/grant
identifiers, stable dotted `action`, `target_type`, `target_id`, JSON `details`, and
nullable server-generated `request_id`. IDs order events with equal timestamps;
sequence gaps are normal after rollback and IDs do not promise commit ordering.
Indexes cover organization plus time, actor, or action, with ID tie breakers.

Actors form a database-checked closed set: `user`, `api_key`, `oauth_client`,
`system` (job/service name as ID), `scim_token` (a SCIM provisioning token's ID, always with
credential `none`, because the token is the credential), `external_api_key`,
`external_oauth_client`, `external_user` and `anonymous` (the last four without IDs). Credentials are
`session` (optional session ID), `api_key` (ID and actual scope), `oauth` (client
and grant IDs), or `none`. Legacy internal calls without an authenticated
principal may have a null API-key scope (unknown); HTTP and MCP authenticated
requests preserve the actual scope. Unknown scope is never recorded as full. OAuth authorized actions retain the consenting user
and client/grant; same-organization API-key actions retain the exact key used by the agent.
A booking made with another organization's API key uses `external_api_key`, and one
made through another organization's OAuth grant (for example MCP `create_booking` on a
public booking page) uses `external_oauth_client`. Both have credential `none`: the
booked organization's journal holds no foreign key, user, client or grant ID, or key
scope. A credential that can no longer be resolved to the booked organization (a key
or grant deleted while the request ran) is treated the same way. A signed-in person who
is not a member, such as an invitee declining a team invitation, is `external_user`. The
database rejects any external actor with a credential other than `none`. Organization comparisons use
the canonical UUID form, so a differently spelled organization ID in key metadata is
still the same organization.
Unauthenticated OAuth client registration has no organization and is instance-wide;
a future organization reader must not infer access to these rows.

The helper requires an existing transaction and executes exactly one INSERT.
The business change and its event commit or roll back together. Audit errors
propagate and abort the change. This adds an INSERT, three index updates, WAL and
storage per event, and holds the transaction open for that write. There is no
asynchronous queue or best-effort fallback. Native credential and session operations
also enumerate and lock their affected rows before mutation so concurrent revocations
cannot invent events or omit targets beyond a pagination boundary; bulk operations
therefore incur these snapshot reads and one audit INSERT per affected entity.
The one exception is the bounded SSO security-failure writer, which has no business
transaction and may drop failures past its bound (see [SSO actions](#sso-actions)).

## Stable actions and detail allow-lists

The application and database reject extra detail keys. Role changes allow only
`oldRole` and `newRole`; API key creation and the reserved rotation action allow
only `scope`; all webhook and Slack destination actions allow only `events` (the
subscribed event list), which the database checks is an array of distinct event names
from that destination's catalogue, at least one and at most the catalogue size (Slack's
leaves out the attendee no-show change); OAuth token revocation allows only `familySize`
(see below).
Branding updates allow only `logo` (`uploaded`, `selected` or `removed`) and
`primaryColor` (`set` or `cleared`), at least one of them; the database also checks
these values. Attendee no-show changes require exactly `attendeeId` (the attendee's
stored ID, a lowercase UUID) and `noShow` (`marked` or `unmarked`); the database checks
both values. Every other action, including the SCIM provisioning token and User actions,
requires an empty object. No key or token names, webhook or Slack URLs, secrets,
images, logo hashes, colours, attendee names, email addresses or free text are
recorded. New detail keys require deliberate schema and documentation review. The
[SSO actions](#sso-actions) have their own allow-lists and value checks.

| Area | Actions |
| --- | --- |
| Membership | `membership.invited`, `membership.accepted`, `membership.invitation_rejected`, `membership.removed`, `membership.left`, `membership.role_changed`, `membership.invitation_cancelled` |
| Organization | `organization.created`, `organization.updated`, `organization.branding_updated` |
| API keys | `api_key.created`, `api_key.updated`, `api_key.revoked`, `api_key.reenabled` |
| SCIM provisioning tokens | `scim_token.created`, `scim_token.rotated`, `scim_token.revoked` |
| SCIM Users | `scim_user.created`, `scim_user.claimed` |
| Webhooks | `webhook.created`, `webhook.updated`, `webhook.paused`, `webhook.resumed`, `webhook.deleted`, `webhook.secret_rotated` |
| Slack destinations | `slack_destination.created`, `slack_destination.updated`, `slack_destination.paused`, `slack_destination.resumed`, `slack_destination.tested`, `slack_destination.deleted` |
| OAuth | `oauth.client_registered`, `oauth.consent_granted`, `oauth.token_revoked` |
| Account | `session.revoked`, `sign_in_method.added`, `sign_in_method.removed` |
| Bookings | `booking.created`, `booking.rescheduled`, `booking.cancelled`, `booking.reschedule_requested`, `booking.attendee_no_show_changed` |
| Event types | `event_type.created`, `event_type.updated`, `event_type.deleted`, `event_type.notifications_updated`, `event_type.waitlist_updated`, `event_type.round_robin_activated` |
| Audit log | `audit_log.retention_updated` |

`organization.ownership_transferred` and `api_key.rotated` are reserved action
names, not currently emitted. Ownership transfer is blocked by the existing
role policy. Key rotation uses replacement-key creation followed by revocation,
recorded as `api_key.created` and `api_key.revoked`.

Session revocation and sign-out belong to the user's personal organization. Bulk
revocation records each affected session in the same transaction, including more
than 100 sessions. Sign-in method linking records the account's user; when the
provider callback supplies identity proof without an existing app session, its
credential is `none` rather than retaining a provider token. Initial signup before
a personal organization exists is not a sign-in-method change. Native OAuth token
revocation identifies the OAuth client and grant; browser disconnection identifies
the user and app session. Revoking a refresh family after its grant was already
disconnected keeps native invalidation and response behavior; absent grants do not
cause audit failure.

Presenting an already revoked refresh token, either for revocation
(`/api/auth/oauth2/revoke`) or for a refresh outside the 30-second retry window
(`/api/auth/oauth2/token`), makes Better Auth invalidate the client's whole
refresh-token family for that user, across every grant and organization. Both paths
are recorded the same way: one `oauth.token_revoked` event per affected grant, each
with `familySize` (the number of refresh tokens invalidated for that client and user
in all organizations, so another organization's event can reveal that count, never
which grants or organizations). The OAuth client is the actor. The grant whose token
was presented is the target and credential of its event, in its own organization (on
revocation, with no organization once that grant was disconnected). Every other
affected grant gets an event in its own organization with credential `none`, so the
presenting grant's ID never reaches another tenant. Deleting the family's access tokens
and refresh tokens and writing these events commit in one transaction: if an event
cannot be written, nothing of the family is deleted and the request fails.

At the token endpoint Hourmere first checks the presented token's grant, consent and
membership; a refresh refused there (for example after disconnection or after the
user left the organization) invalidates nothing and records nothing. If a client
presents another client's revoked token for revocation, Better Auth invalidates the
presenting client's own family for that user: those grants get events with credential
`none`, and the presented token's grant, which lost nothing, gets no event.

API-key updates, disables, re-enables and deletes are matched to the requested key in
canonical UUID form; the request may spell the key ID in any letter case. An invitee
rejecting an invitation is recorded in the inviting team as
`membership.invitation_rejected` with actor `external_user`, credential `none` and the
invitation as target. The invitee never joined, so the team's journal keeps no user or
session ID of theirs.

Branding changes through REST, MCP or the CLI record `organization.branding_updated`
on the organization, attributed to the caller's credential: a logo upload records
`logo: uploaded`, and an update records each setting it sets (`logo: selected` or
`removed`, `primaryColor: set` or `cleared`), even when the stored value was already
the same. An update without fields and a refused change record nothing; reading
branding or the logo is not recorded.

A host asking the invitee to pick a new time records `booking.reschedule_requested`
on the booking, attributed to the host's credential; an idempotent replay records
nothing. The invitee's response is the ordinary `booking.rescheduled` or
`booking.cancelled` through the manage link. A request that times out is resolved by
the system and not recorded.

Marking or unmarking an attendee as a [no-show](../apps/site/src/content/docs/docs/no-shows.md)
through REST, MCP `set_attendee_no_show` or CLI `set-no-show` records
`booking.attendee_no_show_changed` on the booking, attributed to the caller's
credential, with the attendee's ID and `noShow: marked` or `unmarked`. The event is
written in the transaction that changes the marker, so a change that rolls back
records nothing. Repeating the current state (an exact replay, or a concurrent request
that loses the race) changes nothing and records nothing; refused requests record
nothing.

Webhook updates that change the active state record `webhook.paused` or
`webhook.resumed`. A change to the subscribed events, or an update that changes
neither, records `webhook.updated`; one request that resumes and edits records both.

[Slack destinations](../apps/site/src/content/docs/docs/slack.md) follow the same rules
through REST, MCP and the CLI, with target type `slack_destination`: an update that
changes the active state records `slack_destination.paused` or `slack_destination.resumed`,
and one that replaces the URL, changes the events or the event-type filter, or changes
nothing records `slack_destination.updated`. Queuing a test message records
`slack_destination.tested`. When Slack answers a delivery with 404 or 410, the delivery
worker pauses the destination and records `slack_destination.paused` with actor `system`
(`webhook-delivery`) and credential `none`, in the same transaction; later deliveries to
the paused destination are skipped and record nothing. No URL, masked URL or event-type
filter is recorded.

SCIM provisioning token creation, rotation and revocation record `scim_token.created`,
`scim_token.rotated` and `scim_token.revoked` on the token ID, attributed to the owner or
admin session that made the change, with empty details: like API keys, no token name,
secret or digest is recorded. Revoking an already revoked token records nothing, and a
refused rotation (a revoked token or an active overlap) records nothing.

SCIM User creation (`POST /Users`, which production does not register yet) records
`scim_user.created` on the new resource ID, attributed to the provisioning token that made the
request (actor `scim_token`, credential `none`), with empty details: no `userName`, address,
name or other attribute value is recorded. The invitation it issues records
`membership.invited` with the same attribution; a create whose claim records no invitation
(a member's address, or one another pending invitation holds) records only
`scim_user.created`. Both are written in the transaction that
creates the entry, its claim and the invitation, so a create that fails or is refused records
nothing.

Accepting the invitation of a SCIM User's pending claim (which production does not wire yet)
completes the claim and records `scim_user.claimed` on the resource ID, beside the usual
`membership.accepted`, both attributed to the accepting person's session, with empty details.
They are written in the acceptance transaction, with the new membership and the link, so a
refused or failed acceptance records neither. An acceptance that admits without completing a
claim (an expired claim, or a claim without an invitation) records only `membership.accepted`.

An event-type update records visibility and host changes without copying the
configuration. Target IDs identify the affected entity by its stored ID, whatever UUID
spelling the request used; removal events preserve those IDs after the entity
disappears.

## SSO actions

The [organization SSO](sso.md) actions are defined, with their detail allow-lists in the
application (`packages/db/src/sso-audit.ts`) and in the database check (migration 0085).
The browser provider-draft service records creation, update, retirement and secret rotation
in the same transaction as its change, using only protocol, provider ID and revision details.
An idempotent repeat retirement records nothing. Both protocols remain hard-off, so these
writes are unavailable in production. Each later
SSO step records the events of the changes it builds with `writeSsoAuditEvent`, inside the
transaction of that change, so the event and the change commit or roll back together, and its
security failures with `writeSsoSecurityFailure`. The existing actions above are unchanged.

Details hold only these keys, each with a checked value:

- `method`: the protocol, `oidc` or `saml`;
- `providerId`: the provider's ID;
- `revision`: a configuration revision from 1 to 2147483647, the provider's revision, or the
  policy revision for enforcement changes;
- `outcome`: the result of a provider test or a domain renewal check;
- `reason`: a reason code from the list below;
- `correlationId`: the ID of the SSO attempt (sign-in, test, link or mailbox ceremony).

Provider and attempt IDs must be IDs the database generated (lowercase UUIDv7 values). The
checks enforce that shape, so a secret, a token, an assertion, a mailbox capability, an address
or an IdP subject in any other shape is refused in their place; they cannot tell a stored ID
from another value of the same shape, so writers pass the IDs of the rows they loaded. Extra
keys, missing required keys and any other value fail in the application and in the database.
The application also requires the target to be a stored ID (a lowercase UUID) with a type
name, and a user, API key or system actor to be a stored ID or a service name. No issuer,
client ID, domain name, DNS challenge, email address, subject, provider error text or request
body is recorded.

| Actions | Required | Optional | Outcomes |
| --- | --- | --- | --- |
| `sso_provider.created`, `sso_provider.updated`, `sso_provider.enabled`, `sso_provider.disabled`, `sso_provider.deleted`, `sso_provider.secret_rotated`, `sso_provider.certificate_rotated`, `sso_maintenance.key_rotated` | `method`, `providerId`, `revision` | | |
| `sso_provider.tested` | `method`, `providerId`, `revision`, `outcome` | `reason`, `correlationId` | `passed`, `failed` |
| `sso_domain.renewed` | `outcome` | | `passed`, `failed`, `unknown` |
| `sso_link.linked`, `sso_link.unlinked`, `sso_link.conflicted`, `sso_authentication.succeeded`, `sso_authentication.replay_rejected`, `sso_jit.admitted`, `sso_delegation.bound`, `sso_delegation.revoked`, `sso_proof.revoked` | `method`, `providerId` | `revision`, `correlationId` | |
| `sso_authentication.failed`, `sso_jit.refused` | `method`, `providerId`, `reason` | `revision`, `correlationId` | |
| `sso_enforcement.enabled`, `sso_enforcement.disabled`, `sso_enforcement.updated`, `sso_maintenance.enforcement_disabled` | `revision` | | |
| `sso_recovery.used` | | `correlationId` | |
| `sso_domain.challenged`, `sso_domain.verified`, `sso_domain.expired`, `sso_domain.released`, `sso_maintenance.domain_retired`, `sso_recovery.nominated`, `sso_recovery.enrolled`, `sso_member.suspended`, `sso_member.reinstated`, `sso_member.scim_suspended`, `sso_member.scim_reinstated` | | | |

Reason codes: `attempt_invalid`, `attempt_expired`, `browser_mismatch`, `provider_error`,
`provider_unreachable`, `token_exchange_failed`, `response_malformed`, `signature_invalid`,
`algorithm_refused`, `issuer_mismatch`, `audience_mismatch`, `destination_mismatch`,
`nonce_mismatch`, `timing_invalid`, `subject_invalid`, `authentication_stale`,
`configuration_changed`, `provider_disabled`, `domain_unverified`, `mailbox_unproven`,
`jit_disabled`, `unclassified`.

Security failures (`sso_authentication.failed`, `sso_authentication.replay_rejected`,
`sso_jit.refused` and `sso_link.conflicted`) have no business transaction, so
`writeSsoSecurityFailure` writes each in a short transaction of its own, with the provider as
target, once the request's own transaction has settled, never inside it; the request's
rollback does not remove it, and the change writer refuses these actions. The actor is
anonymous, an external user or the signed-in user, with no credential or that user's session.
Their details are redacted: a reason that is not on the list, such as a provider error, is
recorded as `unclassified`, and a revision or correlation ID that is not a valid value is left
out. At most 20 failures are recorded per provider and source (the failure action) in any 3,600
seconds ([Audit limits](sso.md#audit-limits)); later failures in that window are dropped, so
failed attempts cannot flood the journal. The tradeoff is that junk failures can fill a window
and hide later failures of the same source until it slides; the writer reports each drop to
its caller. When later steps emit them, SSO sign-ins and these bounded failures are the
exception to the access-log exclusion under [Not recorded](#not-recorded).

## Privacy, append-only behavior, and exclusions

The journal does not store IP addresses or user agents: these are unnecessary to
attribute management actions and would expand personal data retention. It stores
no secrets, token values, passwords, key values, raw messages, attendee names,
email addresses, invitee answers, booking notes, or configuration text. Public
invitee self-service uses anonymous identity and entity IDs only. Request IDs are
locally generated correlation identifiers, never copied from untrusted headers.

No application journal update path exists, and the only delete path is the retention
purge ([Retention](#retention)). Entity identifiers deliberately have no cascading
foreign keys, preserving history when a subject is removed.

## Not recorded

Management operations not recorded are waitlist sign-ups, email verification and
removal (by the invitee or the host); one-time link creation and revocation; schedules
and date overrides; profile edits, including display names; calendar
and conference connections, calendar selection and resource retry operations;
OAuth old-grant revocation during re-consent; and event-type deactivation as a
side effect of member removal (the membership removal itself is recorded).
Initial personal-organization provisioning and trusted server-side
`auth.api.createOrganization` provisioning without an HTTP request are not
recorded; interactive team creation is recorded. Invitation delivery resends and
automatic expiry/replacement cancellation are not separate management events
(new replacement invitations retain their invitation event).
Automatic API-key expiry cleanup is not a user management action and is not
recorded, including cleanup triggered by another user’s key endpoint.
When an authorization code is presented a second time, Better Auth deletes the tokens
already issued for it. This automatic replay response is not recorded: it concerns
the one connection whose code was replayed, and Better Auth ignores its failures, so
making it depend on the journal could leave those tokens valid.
A SCIM token's last-use time, which every authenticated provisioning request updates,
is not a management event and is not recorded. Routing forms, meeting polls,
organization SSO configuration and booking workflows have no reachable management
operation yet and record nothing.
Paid-booking holds (creating, confirming and cancelling a payment hold) are service
functions that no route reaches yet; wiring them to a route must add booking audit
events. Automatic payment-hold expiry and unpaid-hold personal-data erasure are system
housekeeping and are not recorded. The operator [Cal.com import](calcom-import.md),
a command-line tool with direct database access, is not recorded, like other
operator database changes.

This is a management journal, not an access log: reads (including CSV booking
exports), failed attempts, ordinary sign-ins and session refreshes, third-party
provider internals, email contents, and database changes made directly by an operator
are not recorded. Existing booking provenance columns remain intact. Once later SSO steps
emit them, SSO sign-ins and bounded SSO security failures are the exception
([SSO actions](#sso-actions)); today nothing records them.

## Reading the journal

`GET /api/v1/audit-events` (`listAuditEvents`), MCP `list_audit_events` and CLI
`audit-log list` share one service (`listAuditEvents` in
`packages/scheduling/src/audit-log.ts`), so they authorize, validate and answer identically.

- **Who.** The organization the caller acts in, never another: its personal owner, or a
  verified team owner or admin, by session, a `full` API key or MCP OAuth (which keeps its
  user's role). Members, removed or unverified users, and session callers whose
  `X-Expected-Organization-Id` names another team, an unknown ID or a malformed one all get
  the same `403 team_management_access_denied` without a message, so the answer reveals
  nothing about other organizations. REST checks membership before validating filters;
  MCP can reject malformed tool arguments before the service checks membership.
- **Scope.** API keys need `full` scope (operation class `audit_read`); `read` and `bookings`
  keys get `403 insufficient_scope` and do not see the tools. The journal says who did what
  with which key, grant and role change, which is account-security information rather than
  reporting data: a `read` key handed to an analytics agent should not learn it.
- **Filters.** `from` (inclusive) and `to` (exclusive) are RFC 3339 instants with an offset;
  values finer than a microsecond round up, because stored times have microseconds.
  `actorType` (with optional `actorId`) and an exact `action`. Unknown actions match nothing.
- **Order and pages.** Newest first by `(occurred_at, id)`. `limit` 1–100 (default 50).
  `nextCursor` is opaque and bound to the organization and the filters: reusing it with other
  filters or in another organization is `400 invalid_cursor`. Pages continue below the last
  row's position, so events written after the first page never repeat or shift earlier rows.
  An event is visible once its transaction commits; because `occurred_at` is taken at insert,
  a long transaction can commit an event older than rows already paged past. It then appears
  on a later page if older than the cursor, or on a fresh first page.
- **What is returned.** Stored fields only, with session identifiers redacted: ID (decimal string), `occurredAt` in
  UTC with microseconds, action, actor type and ID, target, details (the allow-listed values,
  so redacted SSO security-failure details stay redacted), request ID and the credential type.
  For API-key credentials the key ID and its scope, for OAuth the client and grant IDs.
  **Session IDs are never returned**: they belong to the member's account, and a team admin
  cannot list another member's sessions. Session targets have `target.id: null`. Rows without an organization (unauthenticated OAuth
  client registration) are never returned to anyone. Reads are not recorded.

The web page `/app/audit-log` uses the same endpoint, converts its date filters from the
viewer's profile time zone (local midnight of the first day to local midnight after the last,
so a 23- or 25-hour day is covered exactly) and shows times in that zone, naming it.

## Retention

Each organization keeps its journal according to one rule:

| Choice | Set by | Effect |
| --- | --- | --- |
| Instance default (no row) | operator, `AUDIT_LOG_RETENTION_DAYS` | `forever` (the default) or 30–3650 days |
| `forever` | owner | never deleted |
| `days` | owner | deleted once older than 30–3650 days |

Owners (a personal space's owner or a team owner) change it with `PUT
/api/v1/audit-log/settings`, MCP `set_audit_log_settings` or CLI `audit-log set-retention`;
owners and admins read it. Admins are refused with `insufficient_role`. A change is stored in
`audit_log_settings` (migration 0090) and recorded as `audit_log.retention_updated` on the
organization, with empty details; repeating the current value records nothing. Deleting an
organization removes its choice; any events it left behind, and instance-wide rows, follow
the instance default.

The worker's `audit-log-retention-v1` job runs hourly (`purgeAuditEvents`):

- It finds the organizations that have events past their own retention through the
  organization/time index (a skip scan). Discovery visits all organizations; only eligible
  organizations consume delete batches. It then deletes at most 1,000 rows per statement and 50 statements per run, one batch per
  organization per pass. Later organizations may wait across runs while earlier ones remain
  backlogged; the deletion bound does not bound discovery work.
- It never waits on locks: an organization whose retention is being changed (its writer holds
  the organization's retention advisory lock) is skipped until the next run; rows locked by
  anything else are skipped (`FOR UPDATE SKIP LOCKED`); the search and every delete give up
  after 100 ms behind a table lock (for example a migration) and leave the rest to the next run. A retention change waits at most for one running batch of
  its organization, so a purge sees either the old or the new choice, never a mix.
- It is idempotent and safe to run twice at once: a repeated or concurrent run deletes nothing
  already deleted, and new events are never eligible.
- It never deletes an event younger than 30 days, whatever is stored: the 30-day minimum is
  enforced by the setting's check, in the service and in the purge itself. This keeps every
  reader of recent events whole, such as the SSO security-failure bound, which counts the last
  3,600 seconds.
- Purges are system housekeeping and are not recorded in the journal.

**What retention means for compliance.** Retention is a deletion schedule, not an archive:
deleted events are gone from the database (backups follow the operator's backup policy). No
foreign key references journal rows, so nothing is kept because another row points to it; the
only rows the purge always keeps are those younger than 30 days. There is no legal hold:
an organization that must keep records for a dispute or an audit chooses `forever` (or the
operator keeps the instance default at `forever`) before the period runs out. Changing from a
longer to a shorter period deletes older events at the next run, and the change itself is in
the journal for at least 30 days. Choose a period that satisfies both your record-keeping
obligations and data minimisation: the journal holds user, key and grant IDs, not names or
email addresses.

## Known limitations

- No export (CSV or JSON download) yet; page through the API instead.
- No filter by target, credential or free text, and no "any of these actions" filter.
- Actors are shown by stored ID. An API key actor is its key ID: the key's owner is not
  resolved (look for the matching `api_key.created` event). Users who left keep their ID.
- The operator cannot cap what an owner chooses (for example forbid `forever`), and there is
  no legal hold beyond choosing `forever`.
- The purge only runs on worker processes; an instance without a worker never deletes.
