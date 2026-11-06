# Audit event journal

Every self-hosted and Cloud instance records audit events without plan gating. The
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
`system` (job/service name as ID), `external_api_key` and `anonymous` (both without IDs). Credentials are
`session` (optional session ID), `api_key` (ID and actual scope), `oauth` (client
and grant IDs), or `none`. Legacy internal calls without an authenticated
principal may have a null API-key scope (unknown); HTTP and MCP authenticated
requests preserve the actual scope. Unknown scope is never recorded as full. OAuth authorized actions retain the consenting user
and client/grant; same-organization API-key actions retain the exact key used by the agent.
A foreign organization key booking uses `external_api_key` with credential `none`,
without the key ID, user ID or scope in the booked organization’s journal.
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

## Stable actions and detail allow-lists

The application and database reject extra detail keys. Role changes allow only
`oldRole` and `newRole`; API key creation and the reserved rotation action allow
only `scope`; all webhook actions allow only `events` (the subscribed event list).
Every other action requires an empty object. No key names, webhook URLs or secrets
are recorded. New detail keys require deliberate schema and documentation review.

| Area | Actions |
| --- | --- |
| Membership | `membership.invited`, `membership.accepted`, `membership.removed`, `membership.left`, `membership.role_changed`, `membership.invitation_cancelled` |
| Organization | `organization.created`, `organization.updated` |
| API keys | `api_key.created`, `api_key.updated`, `api_key.revoked`, `api_key.reenabled` |
| Webhooks | `webhook.created`, `webhook.updated`, `webhook.deleted`, `webhook.secret_rotated` |
| OAuth | `oauth.client_registered`, `oauth.consent_granted`, `oauth.token_revoked` |
| Account | `session.revoked`, `sign_in_method.added`, `sign_in_method.removed` |
| Bookings | `booking.created`, `booking.rescheduled`, `booking.cancelled` |
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

An event-type update records visibility and host changes without copying the
configuration. Target IDs identify the affected entity; removal events preserve
those IDs after the entity disappears.

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

Management operations not recorded are host removal of waitlist entries; one-time
link creation and revocation; schedules and date overrides; profile edits; calendar
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

This is a management journal, not an access log: reads, failed attempts, ordinary
sign-ins and session refreshes, third-party provider internals, email contents,
and database changes made directly by an operator are not recorded. No-show,
reschedule-request, and branding features absent from the current main branch are
not introduced by this work. Existing booking provenance columns remain intact.
