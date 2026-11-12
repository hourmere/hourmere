# Audit event journal

Every self-hosted and Cloud instance records the audit events listed below without plan
gating; actions that are not listed are not recorded (see [Not recorded](#not-recorded)). The
journal is recorded but not yet viewable: a query UI, REST/MCP/CLI read APIs, export
and retention controls are future work. It is separate from booking activity analytics.
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
`system` (job/service name as ID), `external_api_key`, `external_oauth_client`,
`external_user` and `anonymous` (the last four without IDs). Credentials are
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
subscribed event list); OAuth token revocation allows only `familySize` (see below).
Branding updates allow only `logo` (`uploaded`, `selected` or `removed`) and
`primaryColor` (`set` or `cleared`), at least one of them; the database also checks
these values. Attendee no-show changes require exactly `attendeeId` (the attendee's
stored ID, a lowercase UUID) and `noShow` (`marked` or `unmarked`); the database checks
both values. Every other action, including the SCIM provisioning token actions,
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
| Webhooks | `webhook.created`, `webhook.updated`, `webhook.paused`, `webhook.resumed`, `webhook.deleted`, `webhook.secret_rotated` |
| Slack destinations | `slack_destination.created`, `slack_destination.updated`, `slack_destination.paused`, `slack_destination.resumed`, `slack_destination.tested`, `slack_destination.deleted` |
| OAuth | `oauth.client_registered`, `oauth.consent_granted`, `oauth.token_revoked` |
| Account | `session.revoked`, `sign_in_method.added`, `sign_in_method.removed` |
| Bookings | `booking.created`, `booking.rescheduled`, `booking.cancelled`, `booking.reschedule_requested`, `booking.attendee_no_show_changed` |
| Event types | `event_type.created`, `event_type.updated`, `event_type.deleted`, `event_type.notifications_updated`, `event_type.waitlist_updated`, `event_type.round_robin_activated` |

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

An event-type update records visibility and host changes without copying the
configuration. Target IDs identify the affected entity by its stored ID, whatever UUID
spelling the request used; removal events preserve those IDs after the entity
disappears.

## SSO actions

The [organization SSO](sso.md) actions are defined, with their detail allow-lists in the
application (`packages/db/src/sso-audit.ts`) and in the database check (migration 0085), but
nothing records them yet: no SSO write path exists, and both protocols are off. Each later
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

No application journal update/delete path exists. Entity identifiers deliberately
have no cascading foreign keys, preserving history when a subject is removed.
A later retention worker will delete bounded batches by organization and age
using the organization/time index, outside request transactions, with an explicit
operator policy. There is currently no automatic retention cleanup.

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
