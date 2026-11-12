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

## Stable actions and detail allow-lists

The application and database reject extra detail keys. Role changes allow only
`oldRole` and `newRole`; API key creation and the reserved rotation action allow
only `scope`; all webhook and Slack destination actions allow only `events` (the
subscribed event list); OAuth token revocation allows only `familySize` (see below).
Branding updates allow only `logo` (`uploaded`, `selected` or `removed`) and
`primaryColor` (`set` or `cleared`), at least one of them; the database also checks
these values. Attendee no-show changes require exactly `attendeeId` (the attendee's
stored ID, a lowercase UUID) and `noShow` (`marked` or `unmarked`); the database checks
both values. Every other action, including the SCIM provisioning token and User actions,
requires an empty object. No key or token names, webhook or Slack URLs, secrets,
images, logo hashes, colours, attendee names, email addresses or free text are
recorded. New detail keys require deliberate schema and documentation review.

| Area | Actions |
| --- | --- |
| Membership | `membership.invited`, `membership.accepted`, `membership.invitation_rejected`, `membership.removed`, `membership.left`, `membership.role_changed`, `membership.invitation_cancelled` |
| Organization | `organization.created`, `organization.updated`, `organization.branding_updated` |
| API keys | `api_key.created`, `api_key.updated`, `api_key.revoked`, `api_key.reenabled` |
| SCIM provisioning tokens | `scim_token.created`, `scim_token.rotated`, `scim_token.revoked` |
| SCIM Users | `scim_user.created` |
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

SCIM User creation (`POST /Users`, which production does not register yet) records
`scim_user.created` on the new resource ID, attributed to the provisioning token that made the
request (actor `scim_token`, credential `none`), with empty details: no `userName`, address,
name or other attribute value is recorded. The invitation it issues records
`membership.invited` with the same attribution; a create whose claim records no invitation
(a member's address, or one another pending invitation holds) records only
`scim_user.created`. Both are written in the transaction that
creates the entry, its claim and the invitation, so a create that fails or is refused records
nothing.

An event-type update records visibility and host changes without copying the
configuration. Target IDs identify the affected entity by its stored ID, whatever UUID
spelling the request used; removal events preserve those IDs after the entity
disappears.

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
are not recorded. Existing booking provenance columns remain intact.
