# Data model

Google synchronization also records `booking_calendar_targets`: one destination per
reschedule-chain root and host, saved in the booking transaction. It survives changes to the
profile's default calendar and provider retries, and cascades away on booking/user/calendar
deletion. `booking_calendar_events` maps each written booking version to the same external
event. See [Google Calendar synchronization](https://hourmere.com/docs/google-calendar) for the cursor, freshness
and writeback rules.

`calendar_busy` stores each event ID with exactly one representation: a nonempty
`period` (`tstzrange`) for a timed event, or `all_day_start` and `all_day_end` (`date`)
with an exclusive end for an all-day event. The dates are finite, within years 0001–9999,
and strictly increasing. Availability expands all-day dates in each evaluated host's
schedule zone, including collective and round-robin hosts; it does not use the source
calendar's zone. Timed events retain their absolute instants.

Migration `0039_calendar_busy_all_day_dates.sql` invalidates `sync_state` and
`last_synced_at` for every Google calendar, including unselected calendars. Original
all-day dates cannot be reconstructed unambiguously from old instant ranges. Existing
busy rows remain until the next complete sync replaces them atomically. Until that sync
succeeds, affected hosts' personal or collective availability fails with
`calendar_sync_unavailable`; round-robin pools omit affected hosts and can offer fresh
slots from other hosts.
Other providers, bookings and calendar settings are preserved. Stop every old web/all
and worker process before applying the migration, then restart all roles with the new
code. Sync snapshot version 2 makes old web processes reject new snapshots and new code
reject and rebuild version 1 snapshots from old workers, so mixed versions fail closed
for affected hosts.

PostgreSQL is the system of record. The schema is defined by the SQL files in
`packages/db/migrations` (applied in order, never edited once applied); TypeScript table
types in `packages/db/src/tables.ts` are generated from the migrated database.

The [SCIM design and provisioning-token foundation](scim.md) describes organization-scoped
credential storage and the planned user lifecycle and Groups-to-teams mapping. Token
administration and connection/User storage are implemented; SCIM resources remain unavailable.

Migration `0073_scim_identity.sql` adds one stable `scim_connections` identity per
organization and separate `scim_token_connections` bindings. Existing credentials,
including revoked history, are bound without rewriting their fields. New token inserts
receive the same organization connection; rotation retains that binding.

`scim_users` stores organization-local mapped attributes, desired active state and
nullable account/membership links. Its generated trimmed, lowercase user name and
case-sensitive external ID are unique within a connection while the resource is live,
including inactive entries. A linked account can have only one live resource per
connection. Retirement preserves the opaque resource ID permanently while allowing a
new resource to reuse the retired identifiers. Composite foreign keys bind resources,
managers, membership links and invitation claims to their organization and connection.

`scim_user_claims` stores expiring, deduplicated invitation intents, without creating
accounts or verifying mailboxes. `scim_membership_blocks` stores separate local and SCIM
suspension/removal records that survive membership and account deletion. Account deletion
nulls the account reference and retains an immutable normalized mailbox tombstone for the
shared SSO/SCIM admission checks described in [the SCIM design](scim.md); the captured
decision is frozen, cleared at most once, undeletable while its organization exists and
unique per organization, mailbox, authority and kind. A blocker whose mailbox cannot be
stored, or whose decision is already a live tombstone, is dropped so that account deletion
is never refused. These tables provide storage
for later claim and authorization work; this migration does not enforce new admission,
suspension or revocation behavior in application services. Users, Groups and discovery
handlers remain unregistered in production. The User creation handler, which only test
harnesses register, writes a resource and, for its work address, one pending claim whose
`invitation_id` names the invitation it issued or reused, or is null when the address
already belongs to a member or another pending invitation holds it; it never sets an
account or membership link. Claim completion, which only test harnesses wire into invitation
acceptance, sets both links of the claim's entry when its invitation is accepted, together with
the claim's `completed_at`; it reads live blockers, by account and by mailbox, and refuses
admission while one exists, but never writes or clears them.

The [paid-booking design](payments.md) describes pending-payment holds, bounded slot
occupancy, terminal transitions and the future Stripe/refund integration. Checkout is not
available in this foundation release.

## Principles

- **Two schemas.** `auth` belongs to [Better Auth](https://www.better-auth.com) and keeps
  its own naming (`"user"`, `"emailVerified"`). Its SQL is generated by the Better Auth CLI
  so upgrades stay mechanical. Everything else lives in `public` with snake_case names.
- **Ownership.** Identity-level data belongs to a *user* and follows them across
  organizations: profile, working hours, calendar connections. Business data belongs to an
  *organization*: event types and bookings. Every user gets a personal organization at
  sign-up, so a solo user and a 50-person team use the same tables and the same queries.
- **Team-shaped from day one.** Hosts are always rows in `event_type_hosts` /
  `booking_hosts`, even when there is only one. Round-robin and collective scheduling need
  no new host relation.
- **The database enforces what must never be wrong.** Double-booking is prevented by an
  exclusion constraint, not by application code racing against itself.
- **IDs** are UUIDv7 (`uuidv7()`, time-ordered, good index locality) for application
  tables; Better Auth tables use database-generated UUIDs.
- **Public namespaces.** Organization creation and explicit slug updates reject the same
  case-insensitive reserved names as profile handles. Existing rows are not rewritten;
  metadata-only updates remain available for legacy slugs.
- **Instants** use `timestamptz`. All-day calendar events retain a start date and
  exclusive end date; availability expands them at local midnights in the evaluated
  host's schedule zone. Wall-clock rules (working hours) retain their IANA time zone.
  Temporal handles DST when these dates and rules become instants.

## Meeting poll storage

Migration `0071_meeting_polls.sql` adds organization-scoped polls, candidate slots,
voters, votes, purpose-bound capabilities, mailbox counters, operation receipts and
recipient deliveries. Generated database interfaces and selectable row types describe
storage. The internal host lifecycle service in `packages/scheduling/src/meeting-polls.ts`
creates, reads, closes, cancels and deletes polls and rotates public links; it validates
every candidate against the availability engine at creation, fixes every
creation setting, never reopens a closed or canceled poll, and adds no transport. The
internal enrollment and verification service in
`packages/scheduling/src/meeting-poll-voters.ts` enrolls public voters, invites and
re-invites mailboxes, verifies mailbox possession, re-delivers lost credentials and resends
invitations, enforcing the 40-place cap, the per-IP pending cap and the recovery and
resend counters under the poll lock. It queues delivery rows only; no worker, transport,
flag or UI is enabled. The internal ballot service in
`packages/scheduling/src/meeting-poll-ballots.ts` submits and replaces complete ballots,
withdraws and reactivates voters and records reminder opt-outs under the same locks and
database deadline clock. Ballots and withdrawals advance the ballot and results revisions;
no voter write, opt-out included, moves the host revision.
The internal results and removal service in
`packages/scheduling/src/meeting-poll-results.ts` projects host results (separate counts
of counted ballots, the roster and both revisions), removes one voter and bulk-removes
unverified public enrollees. Removal deletes the voter row with its votes, credentials and
deliveries and marks the mailbox counter row removed, which alone outlives it with its mail
counts and opt-out. Removal checks only the host revision and advances the host and results
revisions, so voter activity cannot make it fail.
The internal cleanup service in `packages/scheduling/src/meeting-poll-cleanup.ts`, run by the
hourly `meeting-poll-cleanup-v1` worker job, deletes expired public pending voters and
replay tombstones past their purge instant (and terminal polls once an installation
retention is supplied) in bounded batches that skip locked rows instead of waiting. Poll
deletion and cleanup leave no voter data behind: only the receipts' pseudonymous replay
tombstones remain after a poll is deleted. Migration `0088_meeting_poll_receipt_tombstones.sql`
makes the deletion trigger also replace the request fingerprint of every receipt but `create`
(an invitation's covers invitee names and mailboxes) with a constant, and clears existing
tombstones the same way.
See [the meeting-poll design](meeting-polls.md) for lifecycle, scoped foreign keys,
capacity bounds and the remaining implementation steps. Numeric admission and cleanup
constants live in `packages/scheduling/src/meeting-poll-policy.ts`.

Migration `0084_meeting_poll_key_state.sql` adds the installation-wide
`meeting_poll_key_state` row: a keyed fingerprint of the meeting-poll secret that mailbox
digests, admission IP digests and retained credential ciphertexts were written under, never
the secret. Every voter service checks it first in its transaction
(`packages/scheduling/src/meeting-poll-key.ts`). A secret is recorded, at first use or
replacing another one, only while no voter row or mailbox counter exists; otherwise every
other secret is refused (see
[the key fence](meeting-polls.md#installation-secret-and-key-fence)). The migration writes no
row. Its expectation file is
`packages/db/src/testing/migration-objects/0084_meeting_poll_key_state.json`, and
`meeting-poll-key-state-coverage.test.ts` drops each of its five objects and requires a
protection assertion to fail.

The chosen cleanup schedule is hourly, at most 500 rows per transaction. It persists
closure for abandoned open polls at their deadline, deletes expired public pending
voters and their dependent personal data, and clears expired capability ciphertext.
Capacity and voting expiry are synchronous database-clock decisions, never dependent on
worker punctuality. Normal terminal poll history follows the installation's booking-data
retention policy from its terminal transition (deadline for automatic closure); with no
such policy, the current repository retains booking and terminal poll history until
explicit deletion. This storage step does not install the later cleanup worker.

Mailbox digest counters and terminal delivery receipts remain for the entire retained
poll lifetime so removing/recreating voters cannot reset mail budgets, reminder receipts
or opt-outs. Counters' `purge_at` is unset until the parent is due for retention deletion;
poll deletion cascades them. Delivery ciphertext is cleared immediately at terminal
sent/suppressed/skipped state; retries have at most 5 attempts and 5-minute leases.
Operation receipts lose poll/booking references (`poll_id` and `booking_id`) on poll deletion,
then retain only pseudonymous replay digests for 90 days before the hourly purge: the
organization ID and an unkeyed digest of the acting user, API key or OAuth grant. That
digest can be recomputed from the bare ID, and in a personal space the organization ID
identifies the user.
Organization deletion removes them immediately. Poll deletion preserves the booking;
linked-booking deletion first deletes poll history and clears receipt references.
See [the full cleanup contract](meeting-polls.md#storage-policy-and-cleanup-schedule)
for the later workers and installation retention integration.

## Tables

### Organization branding

Migration `0063_organization_branding.sql` adds `organization_branding`, keyed by organization, with nullable
`brand_logo` and `brand_primary_color`. Keeping these settings outside `auth.organization`
preserves the native Better Auth response boundary. A missing row means both settings
are unset. Existing organizations keep their data and receive no custom
branding. Colours are normalized to uppercase `#RRGGBB`, with a database format constraint.
The logo reference is a SHA-256 digest of normalized PNG bytes in
`organization_brand_logos`. A composite foreign key binds the reference to the same
organization; each organization has at most one image row, capped at 524,288 bytes.
The reference constraint is deferred so replacement can update the image and reference
atomically. Clearing a logo removes its stored bytes; deleting an organization cascades
to its image. Replaced hashes are not retained as a history or public asset catalogue.

The upload service accepts bounded PNG, JPEG and WebP, decodes and re-encodes pixels,
and refuses animation, unsupported types, mismatched media types and oversized images.
Protected image reads serve only normalized PNG with restrictive browser headers.
Personal owners and team owners/admins manage branding through REST, MCP and CLI;
binary uploads use REST or CLI. Writes serialize on the organization, preserve omitted
fields and recheck access before committing. Repeating the same input produces the same
stored settings; concurrent writes are ordered, with the last committed value winning
for a field changed by both callers.

Contrast calculations select black or white text with the greater WCAG 2.x ratio and
report the primary colour's ratio against white separately. These settings do not yet
change public pages, bookings or mail. See [branding](https://hourmere.com/docs/branding)
for limits and client instructions.

### `auth` (Better Auth: core + organization + api-key plugins)

| Table | Purpose |
|---|---|
| `user`, `session`, `account`, `verification` | Accounts, sessions, sign-in methods (Google, Microsoft, email), email verification |
| `organization`, `member`, `invitation` | Tenancy: personal and team organizations, roles, invitations |
| `apikey` | Keys for agents (MCP, REST, CLI); hashed by Better Auth |

Google and Microsoft sign-in ID tokens are used during authentication and are not stored:
`account."idToken"` remains NULL on account creation and every update, including linking,
repeat sign-in and token refresh. Migration 0031 clears existing values without changing
other account data. Retained sign-in OAuth tokens remain encrypted by Better Auth's
`encryptOAuthTokens` option. Calendar credentials and MCP OAuth grants are independent.

Google sign-in requests only `email`, `profile` and `openid`. Better Auth 1.7.10's
`includeGrantedScopes: false` omits `include_granted_scopes`; Google's
[OIDC authorization endpoint](https://developers.google.com/identity/openid-connect/openid-connect#authenticationuriparameters)
includes previous grants only when that parameter is supplied as `true`. This matters even
with separate sign-in/calendar clients: Google's
[combined authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth)
can include grants to other clients in the same project. `accessType` remains unset, so
`access_type` is omitted and Google's default online access applies; no offline access or
forced consent is requested. Hourmere's session renewal needs no Google refresh token.
Google account creation and every account update therefore discard any returned refresh
token and its expiry, and clear legacy refresh credentials on the next successful sign-in,
relink or partial update, even when Google omits a replacement. Updates look up the stored
account's provider, including internal refresh updates that omit `providerId`.
The account's provider/subject/user binding
is retained so automatic account linking and repeat sign-in continue to work. Existing
credentials are not bulk-rewritten or revoked. Calendar connections still explicitly send
`include_granted_scopes=false`, `access_type=offline` and `prompt=consent` for their own
calendar scopes and encrypted refresh credentials.

Microsoft sign-in requests only `openid`, `profile` and `email`: it needs identity once to
create an Hourmere session, whose lifetime and renewal do not depend on Microsoft tokens.
Better Auth's default scopes are disabled, and its Graph profile-photo request is disabled
to avoid `User.Read`. Microsoft's v2 endpoint requires an explicit
[`offline_access` scope](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-offline_access-scope)
to issue refresh tokens; this sign-in flow does not request it. Unexpected Microsoft tokens
retain the existing encrypted-storage behavior.
No application feature reads or refreshes the stored sign-in access token, and the unused
Better Auth token retrieval/refresh HTTP endpoints are disabled. A Microsoft sign-in
refresh token is therefore unnecessary; `offline_access` is intentionally omitted.
Microsoft calendar connections use separate `MICROSOFT_CALENDAR_*` client credentials,
their own callback and the `calendar_connections.credentials` ciphertext. That flow requests
`offline_access` with `Calendars.ReadBasic` and requires a refresh token for continued
calendar-list access.

### `public`

| Table | Owner | Purpose |
|---|---|---|
| `profiles` | user | Public handle (`hourmere.example.com/{handle}/{event}`), time zone, locale, default destination calendar |
| `personal_organizations` | user | Marks the organization created for each user; deleting the user deletes it, and it cannot be deleted on its own |
| `schedules` | user | Named working hours: time zone + weekly intervals (JSON); one default per user |
| `schedule_overrides` | user | Per-date exceptions: unavailable, or replacement intervals |
| `calendar_connections` | user | A connected Google / Microsoft / CalDAV account; credentials encrypted (AES-256-GCM) |
| `calendar_oauth_states` | user + session | Short-lived, single-use calendar connection attempts: state digest, encrypted PKCE verifier and expiry; separate from sign-in |
| `calendars` | user | Calendars inside a connection: conflict checking on/off, sync cursor and push channel |
| `calendar_busy` | user | Timed busy intervals or all-day date ranges mirrored by incremental sync (recurring events expanded) |
| `event_types` | organization | What can be booked: duration, step, buffers, notice, window, daily/weekly/monthly limits, location, questions; soft-deleted |
| `event_type_hosts` | organization | Who hosts an event type, with optional per-host schedule, destination calendar and round-robin weight |
| `one_time_booking_links` | event type + organization | Hash-only booking capabilities, optional expiry and invitee prefill, terminal lifecycle and the confirmed booking that consumed them |
| `bookings` | organization | A booked meeting: instant range, status, resolved location, answers, source (`web`/`embed`/`api`/`mcp`/`import`), idempotency key |
| `import_sources` | instance | Persistent random identity of a real Cal.com/cal.diy source, audited schema/version and creating operator |
| `import_items` | source + owner | Immutable source/target hashes, policy, question/option crosswalk and minimal deletion tombstones |
| `organization_operations` | organization | Minimal actual-actor records for cancellation, member removal/leave and role changes; identifiers, origin, role transition and time only |
| `booking_hosts` | organization | Hosts of an ordinary booking or shared group slot; carries the anti-double-booking constraint |
| `group_slots` | organization | Shared single-host interval, capacity, logistics snapshots and database-owned active-seat count |
| `group_booking_move_receipts` | organization | Authority-scoped immutable seat move/no-op replay results |
| `group_slot_cancel_receipts` | organization | Authority-scoped immutable whole-slot cancellation replay results |
| `group_slot_calendar_events` | group slot | One pinned host calendar event identity and applied count revision |
| `group_slot_conferences` | group slot + organization | Shared pinned conference identity, ready join URL, logistics revision and bounded provider lease/attempt state |
| `group_slot_host_messages` | group slot | Independent host scheduled policy execution and coalesced calendar messages |
| `group_slot_host_mail_receipts` | slot host message | Revision-scoped sent or suppressed delivery receipts |
| `booking_attendees` | organization | The invitee who booked plus guests |
| `booking_calendar_events` | organization | The event each booking wrote to a host calendar, for idempotent updates and cancellation |
| `booking_notifications` | organization | Each email sent about a booking (kind, recipient), refused for good, or suppressed by abuse controls, so a retried job never sends it twice; the SHA-256 of the manage-link secret a sent invitee email carried |
| `notification_email_sends` | instance | Minimal two-day rolling mail accounting: domain-separated invitee/guest or sign-in recipient HMAC-SHA-256 (NULL for hosts) and send timestamp, independent of booking deletion |
| `invitation_deliveries` | invitation | Current delivery generation, bounded attempts, claim lease and safe outcome; deleted with its Better Auth invitation |

## Guarantees and why

Migration 0060 supports the local [Cal.com import CLI](calcom-import.md). Preview reads real
source and target snapshots; applying an explicitly authorized plan uses one atomic target
transaction and a brief target write barrier. Source writes and external provider actions
are forbidden. Imported bookings remain confirmed local busy records with `source=import`,
NULL manage tokens, historical `import_questions` and explicit empty notification settings.
REST/MCP/CLI expose `managementPolicy=local_only_read_only`; ordinary mutation, ICS,
reconnection, repair and delivery paths refuse or ignore them, including stale connected
reschedule chains. Deletion clears all mapping payloads into non-personal tombstones so
reruns cannot restore erased targets. See the [0060 rollout note](../packages/db/migrations/0060_calcom_import_state.md).

- **No double-booking.** `booking_hosts` has
  `EXCLUDE USING gist (user_id WITH =, period WITH &&) WHERE (active)`. Two distinct
  occupied meetings for the same host cannot overlap. Group seats share one slot occupancy;
  their separate database capacity guard permits enrollment up to the pinned capacity. Back-to-back meetings
  are allowed (ranges are half-open). `period` and `active` are never trusted from the
  application: a `BEFORE INSERT OR UPDATE` trigger derives them from the booking (locking
  it `FOR SHARE` against a concurrent reschedule), and a trigger on `bookings` re-derives
  them when the time or status changes. `confirmed` and `pending_payment` occupy the
  host; `cancelled` and `expired` do not. The slot engine ignores holds past their deadline,
  and booking admission releases due holds before checking the exclusion constraint. A multi-host booking is inserted in one transaction, so one taken host rolls back
  the whole booking. Buffers are enforced by the availability engine, not the constraint.
- **Rescheduling** cancels the booking and inserts a new one with `rescheduled_from_id`,
  in one transaction (cancel first, so the new time may overlap the old one).
- **Safe agent retries.** `(organization_id, api_key_id, idempotency_key)` is unique
  (`NULLS NOT DISTINCT`, so anonymous callers share one scope and must use random keys).
  A retry with the same key gets the original booking back; `idempotency_fingerprint`
  (SHA-256 of the request) lets the API refuse a *different* request reusing a key.
  Scoping by caller means two unrelated agents cannot receive each other's booking.
- **Agent audit trail.** `bookings.source` and `bookings.api_key_id` record whether a
  person or an agent made the booking, and with which key. Withdrawals (cancellation or
  the old row of a reschedule) separately record `cancelled_source` and
  `cancelled_api_key_id` in the same transaction. Existing legacy withdrawals remain null;
  key identifiers survive key deletion. These internal fields are not included in public
  booking responses and never overwrite the creation origin.
- **Invitee links without accounts.** Reschedule/cancel links carry a random secret; only
  its SHA-256 is stored: `bookings.manage_token_hash` for the one the booking API returns,
  `booking_notifications.manage_token_hash` for the one each invitee email carries (minted
  when the email is sent, so no raw secret ever sits in the job queue; an email refused for
  good keeps none). One statement looks a token up in both, each through its unique index.
  An invitee reschedule leaves the API's token with its cancelled booking. A host
  reschedule clears the predecessor's hash and transfers it to the successor in the same
  transaction, returning no raw token; the invitee's existing link keeps working. An
  email's token follows `rescheduled_from_id` forward to the latest booking of the chain. See
  [Notifications and background jobs](https://hourmere.com/docs/notifications#which-booking-a-token-opens).
- **An email is sent once, with a narrow duplicate window.** A notification job inserts its `booking_notifications` row
  (primary key: booking, kind, recipient) and keeps that transaction open while the mail
  server takes the email: a failed send rolls the row back for the retry, a concurrent
  attempt waits on the row and skips. The row's foreign key to the booking is checked at
  commit (deferred), so the open transaction never locks the booking against a cancel.
- **Credentials at rest.** Calendar tokens and CalDAV passwords are stored only as
  ciphertext (`calendar_connections.credentials`), with the key from the environment.
  The [CalDAV design](caldav.md) specifies its encrypted credential record and guarded
  discovery foundation; CalDAV is not yet enabled in the product.
- **History survives edits.** Event types are soft-deleted; bookings keep their
  `event_type_id`. A rescheduled booking is a new row linked by `rescheduled_from_id`.
- **Deleting an account** cascades to the user's own data (profile, schedules,
  connections), deletes their personal organization with its bookings and invitee data,
  and deletes their API keys (Better Auth stores the owner as text, so a trigger does it).
  Team organization data is deleted with the organization.
- **Accounts start from a proven email address.** The application refuses to create a user
  whose email the sign-in provider did not verify. Should an unverified user exist anyway,
  they get no social sign-in session, cannot create or change API keys (only switch them
  off), and their keys do not authenticate. The moment the email becomes verified, by any
  route, triggers delete their API keys, sessions and linked sign-in accounts (Google,
  Microsoft), so nothing obtained or linked by whoever held the account before can act as,
  or sign in as, the real owner. A provider that confirms the address links again at the
  owner's next sign-in with it.
- **Only one first user.** Who may create an account follows `SIGNUP` (`open`, `first-user`
  or `closed`, plus `SIGNUP_ALLOWED_DOMAINS`). The application refuses a new user the policy
  does not allow (`SIGNUP_DISABLED`), but checks before the insert, outside its transaction.
  A `BEFORE INSERT` trigger on `auth."user"` checks again inside it: in first-user mode it
  takes a transaction-scoped advisory lock before looking for an existing user, so of two
  first sign-ups at the same moment only one is created. Better Auth's connections carry the
  policy as settings (`hourmere.signup`, `hourmere.signup_allowed_domains`); other
  connections (migrations, psql) are not limited. The server reads the settings back at
  startup and refuses to start if they are missing (e.g. dropped by a connection pooler).
- **Invitation authority is non-transitive.** Migration 0046 replaces 0027's signup policy
  without rewriting existing rows. An invitation admits its exact address only
  when its inviter still belongs to the same team and qualifies through a currently allowed
  email domain or earliest remaining auth user status (creation time, then ID). The application
  checks membership before issuing sign-in mail or creating an account; the signup trigger locks
  the invitation, inviter and inviter's membership rows `FOR SHARE` to serialize admission
  with concurrent removal. A demoted inviter who remains a member retains eligibility.
  Creating a team or accepting an invitation grants no registration authority. Existing
  invitations follow the current policy.
- **Every team retains an owner through membership management.** Departure, removal and
  demotion take the same organization row write lock before checking current owner role
  tokens and writing the membership. Native and REST management paths share this rule.
  Owners cannot be demoted or administratively removed; only their own safe departure
  is allowed. Team deletion and ownership transfer are unavailable at launch; rejected
  deletion requests cannot cascade into booking history.
- **Native team creation and joining commit together.** Better Auth's organization,
  creator-owner membership and session activation use one PostgreSQL transaction.
  Invitation acceptance likewise commits its accepted status, membership and session
  activation together. The policy's user → organization → session → invitation locks
  and native writes share that connection. Acceptance takes the session row
  `FOR NO KEY UPDATE` before the invitation so concurrent trusted API calls on the
  same session queue without a share-to-update lock upgrade. Expiry uses database wall
  time after lock waits, and the membership limit is rechecked under the organization lock. A lost
  connection or process death before commit publishes none of these writes. A lost
  response after commit can still require rereading the team or invitation; these
  operations do not add response replay or repair historical incomplete rows.
  Acceptance also requires the original inviter's current membership in the same team,
  checked inside that transaction after the organization lock. Departure/removal takes the
  same organization lock, so acceptance either commits before that departure or refuses
  without creating membership or rewriting the invitation. Demotion alone retains validity.
- **A personal organization is its user's alone**: no invitations or other members, the
  owner cannot be removed or demoted, and it cannot be deleted on its own.
- **Ownership is enforced where it is cheap to do so.** Composite foreign keys keep a
  booking in its event type's organization and a host's schedule among that host's own
  schedules. Membership of `event_types.owner_user_id` and destination calendars
  belonging to the host are checked by the application.
- **Triggers pin `search_path`**, because they also run on Better Auth's auth-only
  connection (e.g. when it deletes a user).
- **Dates** (`DATE` columns) are returned as `YYYY-MM-DD` strings, never as `Date`
  objects shifted by the server's time zone.

## One-time booking link contract

Migration 0053 adds `one_time_booking_links`. Each link belongs to exactly one event type
and its organization, with the creating user recorded separately. Personal links belong
to the event type's owner; team links belong to the team, rather than to whichever admin
created them. The service returns a cryptographically random 256-bit bearer token exactly
once, on creation. Only its SHA-256 digest is stored, under a unique index. Reads return
metadata without either the raw token or its digest; administrative revocation reports
the authorized link's resulting state. Callers must keep the creation result private; transports must
not log it or place it in analytics.

An optional `expires_at` is an absolute instant. Database wall time decides eligibility,
including after lock waits, independently of the application clock or transaction start.
A link with no expiry remains eligible until consumption or revocation. Optional invitee
name and email are editable booking-form prefill only: they do not prove identity,
verify an address, restrict who can book, or bypass the normal booking validations.

| State | Meaning |
|---|---|
| `active` | Unconsumed, unrevoked and before its optional expiry |
| `used` | A confirmed booking through this link committed with its claim |
| `expired` | The expiry instant has passed; reads derive this even if the stored state is still `active` |
| `revoked` | An authorized owner/admin explicitly withdrew an unused link |

Resolving a token is read-only and never consumes it. Unknown, malformed, expired,
revoked and used tokens return the same `one_time_link_not_found` error, with no lifecycle
details. A digest lookup and constant-time digest comparison avoid comparing raw secrets.
An inactive or deleted event type has the same unavailable result. Hidden event types
remain eligible through their direct one-time links. Links do not bypass event readiness,
host membership, availability, notice, daily limits or any other booking rule.

`claimOneTimeBookingLink` accepts the caller's top-level booking transaction. The caller
must create the confirmed booking and claim the link in that same transaction, and
propagate a failed claim so the booking rolls back. Only a confirmed booking inserted in
that transaction for the exact event type and organization can consume a link; updating
an older booking does not qualify. The database verifies the insertion transaction as
well as the service.
Bookings inserted inside a savepoint are not supported by this claim path.
A conditional row update serializes competing claims; database constraints and a
transition trigger also prevent terminal links from returning to active or changing
their consuming booking. The unique booking reference prevents one
booking from consuming multiple links. A rolled-back booking leaves the link available.
Cancelling or rescheduling the consuming booking never reactivates the link; the original
booking reference remains as evidence of consumption.

Creation and revocation recheck current verified membership and permissions inside their
write transaction. For team-owned event types, only current team owners and admins may
create or revoke links. Ordinary members may manage links only for event types they own;
being a host or the creator of a team link grants no team management permission. The
current organization scopes every operation. The internal revocation helper retains its
empty acknowledgement for unknown, foreign or inaccessible IDs. The authenticated
event-type admin endpoints first authorize the event and link, then report the safe
resulting metadata; an already-revoked or used link is unchanged. Creation and
revocation require API key scope `full` or `bookings`, using the existing
`booking_write` classification; `read` cannot mint or withdraw links. Existing
session, membership and ownership permissions still apply. Administrative reads allow
full/read API keys. Existing authorized MCP OAuth grants retain their scheduling access
for creation, listing and revocation.

REST, MCP and CLI share the administrative services. A creation response adds the full
`<PUBLIC_URL>/book/{token}` URL; list/get/revoke expose neither it nor the token digest.
Migration 0058 stores an optional creation `idempotency_key` separately from the
database-generated UUIDv7 link ID, following booking retries. A partial unique index
scopes the marker to organization, creating user, credential kind and credential record
ID; no bearer credential or raw creation response is stored. Marker columns are immutable
and survive credential deletion with their link. Existing 0053 rows retain their IDs,
capability digests, lifecycle and timestamps, with null markers. The existing row is
looked up under the capacity lock before minting a token. Administrative pages show
newest links first by descending UUIDv7 ID, including keyed creates.
Normalized identical input returns `one_time_link_already_created`; changed input returns
`idempotency_key_reused`. Both are conflicts, never a second creation. No raw-response
cache exists, so even an immediate replay cannot return the original URL. Protection
lasts while the link record survives. See
[one-time booking links](https://hourmere.com/docs/one-time-links) for recovery steps.

Public consumption opens `/book/{token}` and uses `/api/v1/book/{token}` for the
page, with `/slots` and `/bookings` for availability and booking creation. The raw
capability is accepted only in the URL path, never in a query parameter. These
responses use `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; request
logging excludes capability paths; error diagnostics retain sanitized causes and stacks
while redacting capabilities. Dedicated
embeds and framing are refused. The normal duration, questions, readiness and
availability checks apply, and suggested name/email remain editable.
The dedicated one-time page projection omits the reusable handle, event slug and
team slug, and does not offer embed navigation. One-time booking results also omit
saved continuations, including when replaying an older booking with a stored redirect.
These projections prevent automatically exposing reusable booking addresses; they do
not scrub arbitrary host-authored descriptions or meeting content.

Unknown, expired, revoked and used links all show the same neutral unavailable page,
including a browser that loses a simultaneous booking race. Unavailable responses
share the same status, body and headers. Resolution uses one joined digest lookup,
and booking attempts always execute the replay probe, including a no-match probe
when the link or a valid retry key is absent. These paths use the same SQL statement
shapes and counts across unavailable lifecycle states. This is not constant-time:
PostgreSQL row matches, query plans, caches and lock waits can still affect timing.
An exact retry with the winning request's random idempotency key
returns its original booking without another claim; its fingerprint includes the
link identity, so another link or an ordinary booking cannot borrow that replay.
The claim runs immediately after insertion in the existing top-level booking
transaction, before conference and notification work. A later failure rolls back
both. Cancellation and rescheduling use the normal management link and retain the
original link's terminal consumption evidence.

Each personal owner or team organization may have at most 1000 active, unexpired links
across all its event types and creators. An ordinary team member additionally has a
200-link sub-limit across their own event types in that team; owners/admins share the
team total without that sub-limit. Creation serializes capacity checks with a transaction
advisory lock keyed by the personal organization or team, without taking an organization
row write lock. Used, expired and revoked rows do not consume these allowances.

Used links are retained with their consuming booking as evidence, including after
cancellation or rescheduling; the cleanup job never deletes them. A consuming booking
cannot be deleted on its own while its link evidence remains; normal organization/event
deletion removes both together. An hourly job registered in `packages/jobs` deletes at
most 500 unused links per run once 90 days have passed since expiry or revocation. Revoked
links use `revoked_at`, even if their expiry was earlier. Expired links include active
rows whose `expires_at` has elapsed. Retries are idempotent and locked rows are skipped;
a backlog can take additional runs. Active links without expiry are retained.

The creator ID is immutable, non-null historical attribution without an account foreign
key, following migration 0041. Deleting a creator therefore preserves team links and
consumption records. Personal organization deletion still removes personal links, and
physical event type or organization deletion cascades to its links. Soft-deleting an
event type retains its links while making them unavailable. The administrative list
shows lifecycle metadata and the original consuming booking ID without credentials.
Creator labels use current organization membership and display names. Only session
owners/admins can receive an email fallback for an empty name; other callers and departed
members receive a null label, rendered as a neutral unknown member in the editor.

## Booking limit contract

`event_types.max_bookings_per_day`, `max_bookings_per_week` and
`max_bookings_per_month` are independent optional integer ceilings from 1 to 1000;
NULL means that period has no limit. Migration 0057 adds the weekly and monthly
columns as NULL without changing existing event types or bookings. The editor, REST,
MCP and CLI expose all three ceilings as `maxBookingsPerDay`, `maxBookingsPerWeek` and
`maxBookingsPerMonth`. Omitted update fields preserve saved values; explicit null
removes a ceiling. See [booking limits](https://hourmere.com/docs/booking-limits).

Configured ceilings must not descend as periods get longer: day ≤ week, week ≤ month,
and day ≤ month whenever each pair is set. The last rule also applies when week is
NULL. The service rejects an inconsistent write, and database CHECK constraints enforce
the same rule. This keeps a longer-period allowance from silently undercutting a
shorter-period allowance; it is a configuration rule, not a claim that calendar weeks
are wholly contained in calendar months.

All three limits use each evaluated host's effective schedule IANA time zone, matching
the existing daily-limit behavior: the event's selected host schedule, or that host's
default schedule when applicable. They do not use the invitee, profile or database
session time zone. A booking counts by its start instant's local calendar date. A day
contains that date; a week contains Monday through Sunday; a month contains its first
through last local date. These calendar-date intervals include their first date and
exclude the next period's first date. Normal boundaries fall at local midnight, resolved
separately in the schedule zone rather than using fixed elapsed hours, so daylight-saving
transitions, leap days, month ends and year changes retain their local calendar meaning.
A Monday-based week may cross December/January or a calendar month boundary. The start's
local date remains authoritative even when a historical midnight rollback briefly
revisits the preceding day, week or month; query windows conservatively include those
repeated dates.

Counts include only this event type's bookings for the actual evaluated host with
`booking_hosts.active = true`: every booking status except `cancelled` (currently
`confirmed`). All selected durations share the same allowance. Other event types
still block overlapping time but do not consume this event type's ceilings. Personal
and individual team events count their host; collective events require capacity for
every required host in that host's schedule zone; round-robin events evaluate each
candidate host separately and consume only the assigned host's capacity. There is no
separate organization-wide or pool-wide quota.

Availability hides starts whose day, week or month is full. Booking creation and
rescheduling check the same limits under the existing host transaction lock. A successful
idempotent replay returns its original booking even if it consumed the last allowance.
A reschedule checks the target periods while excluding its own predecessor; a failed
move leaves the existing booking intact. Cancellation frees its capacity. Lowering a
limit never cancels or rewrites existing bookings: periods already at or above that
ceiling refuse new bookings until capacity is available.

## Event duration contract

`event_types.duration_minutes` remains the default (`durationMinutes` in service and
REST configuration). `allowed_durations_minutes` / `allowedDurationsMinutes` is a list of
1–12 distinct whole-minute lengths kept in ascending order, each from 1 to 1440 inclusive,
and must include the default. REST, MCP and CLI writes are sorted before storage by the
shared service; existing unsorted lists are displayed in ascending order and normalized on
their next configuration save. Migration 0047 backfills each existing event type to `[duration_minutes]`
without changing existing configuration, bookings or timestamps. Legacy inserts that omit
the list and duration-only edits of singleton types retain singleton behavior. Editing a
multi-duration default requires it to remain in the list, or a replacement list in the
same write. Metadata-only edits preserve the list.

The availability and booking services, public REST endpoints and MCP tools accept optional
`durationMinutes` as the selected length; omission uses the default for new slots and
bookings. The CLI exposes the same selection as `--duration-minutes`. Public personal,
team and embedded booking pages offer a labelled duration choice when multiple lengths are
available, with the default preselected. Changing the selection refreshes availability
before the invitee chooses a time. Single-duration pages retain their existing flow.
If the host changes the available lengths while the page is open, an `invalid_duration`
booking or slots response refreshes the choices and availability in place, asks the invitee
to choose again, and preserves their entered details, guests and answers.

Every candidate's end is its start plus the selected elapsed minutes. The same before/after
buffers apply around that interval; minimum notice and the booking window constrain its
start. An explicit slot step remains fixed; a null step uses the selected duration. Daily
limits count bookings across all durations, without multiplying allowances per option.
Collective scheduling requires every host to fit that same interval; round-robin scheduling
chooses one eligible host whose availability fits it, using the existing assignment rules.

A booking's `start_at` and `end_at` store its actual duration. Configuration edits never
rewrite them. A reschedule with no selected length keeps the original elapsed duration,
even if that option was removed; an explicit new length must belong to the current list.
Managed and host reschedule slot queries follow the same rule. The management page uses
the booking's original elapsed duration for both slot fetching and time-zone day boundaries.
Confirmation details, management details, email times and calendar invitations use the
stored interval rather than the event type's current default.
Existing request fingerprints and exact idempotent replays remain unchanged. An explicitly
supplied selection participates in the fingerprint, so a changed selection cannot reuse
the same key as the same request.

Hosts can configure the list and default in the personal or team event editor, REST
`POST /api/v1/event-types` / `PATCH /api/v1/event-types/{id}`, MCP `create_event_type` /
`update_event_type`, or CLI `create-event` / `update-event`. API-key configuration writes
require `full` scope. See [multiple meeting lengths](https://hourmere.com/docs/multiple-durations)
for host steps, invitee selection and the shared-rule limitations.

## Event location options contract

`event_types.locations` / REST, MCP and service `locations` is an ordered list of 1–5
location options, or SQL/service null for no location. An empty list is invalid.
Each option has a stable `id` (1–64 ASCII letters, digits, `_` or `-`, excluding
`__proto__`, as for question and reminder rule IDs), a `kind`,
optional public single-line `label` (1–100 characters), optional `isDefault: true`,
and the settings below. IDs and kinds must each be distinct within a list: this
version offers at most one option of each kind, rather than several addresses or
phone numbers. Order is preserved. At most one option may be explicitly default;
otherwise the first is the effective default. A single option uses the existing
booking flow without showing a choice.

| Kind | Settings |
|---|---|
| `google_meet`, `zoom` | Optional `autoCreate: true`, preserving today's explicit conference opt-in. Without it, retain today's passive kind-only behavior. Generated URLs are never event-type settings. |
| `phone` | Exactly one of `number` (the host's E.164 number, `+` and 7–15 digits, first digit nonzero) or `askInvitee: true` (collect the invitee's E.164 number at booking). |
| `in_person` | Required single-line `address`, 1–500 characters. |
| `link` | Required absolute HTTP(S) `url`, at most 2000 characters before and after normalization. |

Unknown keys, false default/opt-in flags, malformed Unicode and control characters
in text are rejected. Labels and addresses are trimmed; link URLs are normalized
using the URL parser. Validation belongs to the shared scheduling service; database
constraints also enforce the list envelope, identities, kinds and default count.
Option IDs survive settings edits within the same kind and reordering. A kind change
replaces the option identity. Removing and recreating an option must allocate a new ID
so a stale page cannot accidentally select a different option under the old ID.
Complete-list writers are responsible for these identity rules.

`event_types.location` and service `location` remain compatibility fields derived
from the explicit default, or first/only option, with `id`, `label` and `isDefault`
removed. Legacy updates supplying a value exactly equal to this compatibility projection
(object key order does not matter) are a no-op for the complete list, preserving IDs,
labels, the default marker, settings and order without normalization. A different legacy
value may edit a single unlabelled option: settings change in place and retain its ID
and default marker; a kind change allocates a new ID. Null clears a single unlabelled
option; a later recreation gets a new ID. Creating an event through the legacy field
initially uses `legacy`, as does historical backfill.
A different value, including null, for several options or an option with a label returns
conflict `location_options_conflict` (REST 409; MCP tool error), instructing the client to
use `locations`. Rejecting the ambiguous edit avoids guessing a target or dropping data.
Configuration writes supply `locations` as a complete replacement; specifying both fields in
one service write is invalid. Unrelated edits preserve the list and its order. Migration 0056 wraps every existing non-null
event location in `{ id: "legacy", ...location }` without normalizing its settings
or changing timestamps; existing nulls stay null. A compatibility trigger also
supports old direct inserts and location-only updates with the same identity and conflict
rules (SQLSTATE `P0001`, message prefixed `location_options_conflict`). Explicit changed
lists take precedence in SQL. Later data migrations that echo `location` are harmless;
ones that intentionally change a multi-option or labelled configuration must update
`locations` explicitly instead.

REST, MCP and CLI expose `locations` beside the existing `location`. Configuration
writes use the same validation and conflict rules in every transport. Booking creation
accepts `locationOptionId` and, only for `askInvitee`, `inviteePhone`. Omitting the option
chooses the effective default; an unknown or removed ID returns `invalid_location_choice`,
never silently falls back. Invalid or missing collected phone data returns
`invalid_invitee_phone`. Public personal, team, embedded and one-time booking forms
collect the number when required. The pure `resolveLocationChoice` helper performs
selection without provider I/O; booking-time readiness is rechecked under the locks.
Legacy `location` writes still reject new `askInvitee` configuration with
`invalid_location`; use the complete `locations` list to configure collection. An unchanged
legacy echo remains accepted. The editor preserves that configuration on unrelated edits.
See [meeting location choices](https://hourmere.com/docs/location-choices) for configuration,
public discovery and booking examples.

A new booking stores its chosen configuration snapshot in
`bookings.location_option`, including its ID, kind, label/default marker and settings.
`bookings.location` remains the resolved values used by current protected booking
reads, notifications and calendars: host or collected invitee phone, saved address
or link, or the conference kind/opt-in until its ready join URL is added by existing
conference reconciliation. The resolver returns both `locationOption` and `location`;
for invitee phone, the configuration snapshot retains `askInvitee: true` and the
resolved location contains the normalized E.164 number. Common spaces, parentheses,
hyphens and periods are removed before validating 7–15 total digits including the country
code. Host and invitee notifications can show that number; guest email and ICS payloads
use neutral phone-call wording without it. Neither configuration edits nor
conference URL updates rewrite the chosen snapshot. Snapshot storage is private,
just like resolved contact details, and follows the booking's retention policy.
Migration 0056 backfills each existing non-null resolved booking location as
`{ id: "legacy", ...location }`, including any historical ready URL; null remains
null. These historical snapshots cannot recover the original option settings or
labels. Compatibility inserts that omit a snapshot similarly capture their resolved
location; booking creation explicitly persists the resolver's snapshot.
Historical resolved booking payloads with custom kinds remain intact in snapshots;
this storage compatibility does not admit those kinds into new event options.

Rescheduling keeps the original option snapshot and resolved phone/address/link,
even if the host removes or edits that option. Automatic conferences retain existing
same-conference reschedule behavior and pinned organizer/destination identities.
Changing the location on reschedule is outside this contract. Successors copy `location_option`, including a legacy snapshot. Explicit choice and
collected phone participate in the existing idempotency fingerprint; exact
replays must return the original snapshot and resolved result without reevaluation.

Public option discovery is a whitelist of `id`, `kind`, optional public `label` and
default marker, plus `askInvitee: true` when a phone must be collected. It never
exposes host numbers, addresses, saved link URLs, connection IDs, organizer account
details, credentials or generated URLs. Public discovery adds this whitelist beside the existing kind-only compatibility field. Hosts must treat option labels as public text. Protected
booking results reveal resolved location details under today's access rules; raw
configuration snapshots are not added to public responses.

All options share the event's hosts, durations and booking rules. Team ownership and
write permissions stay unchanged. Every automatic option is checked on configuration
writes, including non-default options. Booking-time readiness must be checked again
under the existing booking locks: individual Meet uses that host's capable destination;
collective Meet uses an explicitly selected required host as organizer; round-robin
Meet filters candidates to Meet-eligible hosts before slot listing and fair assignment
for the selected option, then uses the assigned host and its own capable destination. Do not borrow
another host's account. Automatic Zoom remains limited to individual scheduling with
one explicitly authorized host and that host's pinned meeting-mode connection;
collective and round-robin Zoom are rejected even as non-default choices. The pure
resolver consumes a trusted readiness snapshot rather than querying accounts. If the
chosen automatic option cannot be honored for the actual assigned host/organizer,
return conflict `location_unavailable`, without provider or private account details;
do not substitute a location or a different host after assignment. An event type with
exactly one option, queried or booked without an explicit choice, keeps the
single-location contract whatever the option ID (adding a location or changing its kind
allocates a new one): provider readiness codes such as `automatic_meet_unavailable`
remain, and the booking snapshot stores that option's settings without normalization. Existing service
configuration errors and conference readiness rules remain in force. No readiness
failure is presented as proof that the host has not configured an account.

## JSON columns

Validated by the application (zod), not by the database:

- `schedules.weekly_hours`: weekday name (`"monday"` … `"sunday"`) →
  `[{ "start": "09:00", "end": "17:00" }]`; `"end"` may be `"24:00"`. Missing or empty
  day = unavailable. This is `@hourmere/core`'s `WeeklyHours` type.
- `schedule_overrides.intervals`: `[]` (unavailable) or the same interval list.
- `event_types.locations`: ordered nullable option list, as specified above;
  `event_types.location` is its default/only compatibility projection.
- `bookings.location_option`: chosen option snapshot; `bookings.location` is the
  resolved `{ "kind": "google_meet" | "zoom" | "phone" | "in_person" | "link", ... }`.
- `event_types.questions`: booking-form fields beyond name and email, at most 20:
  `[{ "id": "company", "label": "Company", "type": "short_text", "required": true }]`.
  `id` is 1–64 letters, digits, `_` or `-`, unique within the event type, and not
  `__proto__`; `label` 1–200 characters; `type` is `short_text`, `long_text`, `phone`,
  `select`, `multi_select` or `checkbox`; `required` defaults to false; `options` (1–50
  distinct strings of up to 200 characters) only for `select` and `multi_select`. Labels and
  options are single-line text (no control characters, well-formed Unicode). Unknown fields
  are refused. The web editor allocates an opaque random ID when a question is added and
  keeps it through edits, retries and saves. Existing saved IDs stay unchanged; deleting and
  re-adding the same label gets a new identity so historical answers do not attach to it.
- `bookings.responses`: answers keyed by question id: a string for `short_text` (≤ 500
  characters), `long_text` (≤ 5000) and `phone` (≤ 32), one of the options for `select`, a list
  of distinct options for `multi_select`, a boolean for `checkbox` (true when required).
  Text answers have no control characters; only `long_text` may contain tabs and line
  breaks. Empty optional answers are left out.
- Both are defined once, as zod schemas plus `validateQuestions` (for writes, code
  `invalid_questions`), `parseQuestions` and `validateResponses`, in
  `packages/scheduling/src/questions.ts`; writes of either go through them.
- `calendars.sync_state`: provider sync token / delta link and push channel id + expiry.
- `auth.apikey.metadata`: `{ "organizationId": "<uuid>", "scope": "full" | "read" | "bookings" }`.
  The organization defaults to the owner's personal organization and is rechecked against
  membership on every request. Scope is immutable after creation, including direct storage
  updates; native owner-authorized organization changes preserve it. Migration 0048 backfills
  legacy scopes as `full`, preserving other metadata, and rejects malformed legacy metadata
  atomically. New API creations that omit `metadata.scope` default to `full` for compatibility;
  the web form explicitly defaults to `bookings`. Malformed stored scopes fail closed.
  See [API keys](api-keys.md) for the generated operation tables and the requirement to stop
  all old key-authenticating processes before scoped keys are used.

## Booking continuation contract

Migration 0050 adds nullable `event_types.success_redirect` configuration and
`bookings.success_redirect` snapshots. Existing event types and bookings remain unset;
their data and confirmation behavior are preserved. The service accepts optional
`successRedirect: { url, parameters?, includeInviteePersonalData?, allowEmbedParent? }`
(or null to clear it). Hosts configure it in the event editor, REST event-type
create/PATCH, MCP `create_event_type` / `update_event_type`, or CLI `create-event` /
`update-event`; protected event-type reads include the saved configuration. API-key
configuration writes require `full` scope and retain event-type ownership and team-role
checks. See [after-booking redirects](https://hourmere.com/docs/after-booking) for steps,
examples and error fields. The editor submits only settings changed from its session
baseline, so an untouched redirect is not revalidated by an unrelated save.

URLs must be absolute HTTPS, without userinfo, whitespace/control characters or malformed
Unicode, and at most 2000 characters both before and after URL normalization. IDN hosts
are stored as ASCII and Unicode paths are percent-encoded. IP-literal hosts, including
alternate IPv4 spellings normalized by the URL parser, `localhost`, its subdomains and
single-label hosts (such as `intranet`) are refused unless the operator
sets `SUCCESS_REDIRECT_ALLOW_IP_HOSTS=true` or the host equals the instance's `PUBLIC_URL`
host. These exceptions still require HTTPS. Validation lives in the scheduling service;
the browser never supplies or chooses the target. No server-side destination request is made.

The service validates newly supplied configuration against the current instance policy.
Unrelated event-type updates preserve the saved redirect without revalidating it. If an
operator later tightens `SUCCESS_REDIRECT_ALLOW_IP_HOSTS` or changes `PUBLIC_URL`, a saved
target may no longer qualify. New public bookings still succeed with their normal
confirmation and no redirect snapshot. The server logs `success_redirect_disabled` with
only the event-type ID so the operator can help the host replace or clear the setting;
it never logs the target URL, query or invitee data. Restoring policy cannot add a redirect
to an already-created booking that had none. An explicitly supplied redirect, even an
unchanged value, must pass current policy; null always clears it.

`parameters` defaults to an empty array. Its complete whitelist is `eventTypeSlug`,
`start`, `end` (ISO instants), `timeZone` (invitee IANA zone), `hostName` (selected hosts'
display names), `inviteeName` and `inviteeEmail`. The last two additionally require
`includeInviteePersonalData: true`, which defaults to false. **Warning: opting in sends the
invitee's selected name/email to the target site and its analytics, and can place them in
browser history.** Custom answers, guest addresses, phone numbers, management/reschedule
tokens and internal identifiers are never added. Existing target query text (including
valueless flags, percent sequences and separators) and fragments are preserved verbatim;
only selected new parameters are URL-encoded using URLSearchParams and
appended after existing values, including existing parameters with the same name.

Only successful initial public web/embed booking creation captures a final
`{ url, allowEmbedParent }` snapshot in the booking transaction, from the locked saved
configuration and booking-time values. The additive `successRedirect` creation response
offers that snapshot; an idempotent replay returns the identical target even after
configuration or host-name changes. An unset initial configuration stays unset on replay.
Request body targets are rejected and query targets are ignored. API/MCP-origin creation,
management reads, rescheduling and cancellation do not offer continuations. A rescheduled
successor has no snapshot. Replaying the original creation does not turn a cancellation
or reschedule into a new booking or a new continuation.

The confirmation keeps its calendar information and private manage link, then offers an
accessible, explicit **Continue** link. There is no timed or automatic navigation.
`allowEmbedParent` is a separate opt-in, default false: embeds normally open the target
in a new tab with `rel="noopener noreferrer"`; true permits the invitee's click to open
the parent using `target="_top"`. The public event-type response exposes only the optional
`allowEmbedParentRedirect` capability, never the target or selected parameters. The widget
initially withholds top-navigation permission. After an origin/source/instance-checked
ready message confirms the saved event-type opt-in, it enables
`allow-top-navigation-by-user-activation` and reloads the same booking route before
allowing input in the iframe; sandbox changes apply only to a new document. Reloads rotate the
internal embed instance ID so stale messages cannot complete that handshake. A removed
opt-in triggers a restrictive reload, with further upgrades disabled for that instance.
Ordinary event types retain the default sandbox. A widget marker records the active
permission, so enabling the saved opt-in after loading a restrictive frame still opens
Continue in a new tab. Loading and server-error text remains visible during the handshake.
Error, not-found and unavailable embedded pages signal readiness with the capability false.
If readiness does not arrive within five seconds, the widget enables input with the
restrictive sandbox, replacing the iframe first if a permission upgrade was in progress
so the retiring document cannot retain navigation permission.
Later readiness cannot trigger a reload after input becomes available. An embed instance
ID without the permission marker identifies a legacy widget and keeps Continue in a new
tab. The widget script is served with `Cache-Control: no-cache` and ETag validation so
protocol upgrades reach returning visitors.
The ready message carries only that
capability; no redirect URL or personal data is added to the embed completion message.
Canceling from the confirmation removes the continuation link.

Group seats retain `manage_token_hash` and `responses` on each independent `bookings`
row; they do not move private seat data onto shared slots or attendee rosters.

## Routing form storage

Migration 0072 installs the five tables specified in [Routing forms](routing-forms.md):
`routing_forms`, `routing_form_versions`, `routing_target_dependencies`,
`routing_receipts` and `booking_routing`. Storage alone enables no routing execution,
transport, UI or operator setting.

Each organization may retain **100 non-archived forms**, including disabled forms,
and **1000 total forms**, including archived forms; each form may retain
**1000 published versions**. A transaction advisory lock keyed by
`hourmere.routing-form-quota:<organizationId>` serializes form admission without writing
the organization row. Form creation and unarchiving require `READ COMMITTED`; other
isolation modes fail closed with `40001` and must restart at `READ COMMITTED` so that
quota counts use a fresh snapshot after waiting. Version admission writes the form row,
so stale repeatable-read version writers must retry. Archiving frees a non-archived slot
but not a total-forms slot. Cleanup may free a version slot but cannot lower the form's
`last_version_number` high-water mark or reuse an old version number.

Composite organization foreign keys fence versions, published pointers, dependencies,
receipts and consuming bookings. A published pointer additionally belongs to the same
form and is deferred for atomic publication. Form identity and organization cannot change.
Published versions and booking routing snapshots reject updates. The current pointer and
all receipts (including consumed replay evidence) prevent version deletion; unreferenced
old versions may be cleaned up. Historical target/user UUIDs and booking snapshot
form/version UUIDs have no foreign keys to deletable targets/users/forms, so deletion
cannot cascade away booking history or block event deletion. Organization deletion
cascades all routing rows; booking deletion cascades its snapshot and consumed receipt.

SQL checks enforce the same lowercase slug format as event types (with unique
organization/slug pairs), JSON containers, positive revisions/version numbers, enabled/archive
shape, expiry after creation, digest/rule identity shape and no ciphertext on consumed
receipts. Dependency identity (organization, version, rule and event type) is immutable;
only health metadata changes, with `health_code` restricted to `ok`, `unavailable` or `unknown`. Receipt issuance bindings and nonnull answer ciphertext cannot change; ciphertext can
only be erased. A null ciphertext also permits expiry purge without consuming a receipt.
Consumed receipt evidence cannot be rebound or revived.

Migration 0083 adds `routing_form_operations`, the idempotency records of form creation and
publication requests that carry a client `requestId`. A record holds the organization, the
operation (`create` or `publish`), the acting credential by kind (`session`, `api_key` or
`oauth`) and UUID (the session's user, the API key or the OAuth grant; historical, with no
foreign key, so deleting a key or grant never lets a retained request write again), the
request UUID, a 32-byte SHA-256 fingerprint of the canonical validated input alone and the
result: the form, plus the version exactly for a publication. The request key is unique per
organization and credential kind and ID across both operations. The
result is unique with nulls not distinct, so a form has at most one creation record and a
version at most one publication record. Composite organization foreign keys keep the form and
version in the record's organization and cascade, so a record goes with its form (and
organization) or its version and never blocks version cleanup; retention is therefore bounded
by the form and version quotas, with no purge job of its own. Records reject every update.
Question/rule/target semantics remain the future shared validator's responsibility.
Unconsumed receipt indexes support bounded expiry cleanup and form/instance admission
counts; receipt lifetime, encryption and admission services land in later steps.

## SSO configuration storage

Migration 0074 installs the configuration storage of the [SSO design](sso.md)
(Configuration storage step): `sso_policies`, `sso_providers`, `sso_domains`,
`sso_provider_domains`, `sso_recovery_nominations` and `sso_recovery_owners`. Nothing reads
or writes them yet: there is no route, worker, read path or setting, and OIDC and SAML stay
hard-off. A test keeps every production module outside the storage layer from naming them.

All six belong to a team: a personal organization's rows are refused, and deleting the
organization deletes them. Policies, providers and domain claims are deleted only with
their organization; providers and claims are retired instead, so a trust generation is
never reset, a provider ID never reused and a claim generation never revived by deleting
and inserting a row again.

- **Policy** (one row per team): `require_sso`, `admission` (`invitation_only` or `jit`),
  `policy_revision` and `trust_generation`, both positive and never decreasing. A change of
  enforcement or admission needs a new `policy_revision`; turning enforcement off needs a
  new `trust_generation`, which ends every proof and delegation of the team.
- **Providers** have a never-reused ID, an immutable organization, protocol (`oidc` or
  `saml`) and identity (the OIDC issuer and client ID, or the SAML IdP entity ID in
  `issuer`), a display name and a positive `revision`. The configuration, secrets included,
  is stored only as an AES-256-GCM envelope (version 1, IV, tag, ciphertext), never as
  plaintext JSON; its authenticated data binds organization, provider and revision, so
  ciphertext moved to another organization, provider or revision fails to decrypt. A new
  revision and a new sealed configuration go together, so rotating the operator key re-seals
  every provider that is not retired at a new revision. Retirement disables the provider and
  is permanent.
- **Domain claims** store an exact lowercase IDNA ASCII name (no wildcard, IP address or
  trailing dot; public suffixes are refused by the application), the current `generation`,
  the SHA-256 digest of that generation's TXT challenge and its expiry, verification and
  recheck times, and the latest recheck outcome (`positive`, `failed` or `unknown`). A
  pending challenge reserves nothing. From its first verification until retirement a claim
  is the one active claim for its name on the instance, expired or not. Each new generation
  has a new, unverified challenge. A verified generation keeps its verification time; its
  expiry can be renewed, including by a positive recheck of a frozen claim, only while it
  is unexpired. After a lapse only a new generation can be verified, so the proofs and
  delegations that recorded the old generation never revive. Retirement is permanent.
- **Provider domains** link a provider to its team's own domain claims only; the claims
  may be pending or retired, which the services check.
- **Recovery nominations and recovery owners** are written only for a current owner's
  membership (including `owner` among several roles), checked on insert. Deleting the
  membership, by leaving, removal or the user's deletion, deletes them, and re-joining
  restores nothing. Deleting them on demotion, with its audit event, belongs to the Recovery
  enrollment step. Both are immutable. A team has at most one pending nomination per owner,
  and one recovery record per owner.

`sso-storage-coverage.test.ts` drops every constraint, index, trigger and NOT NULL column
through `checkConstraintCoverage` (expectation file
`packages/db/src/testing/migration-objects/0074_sso_configuration.json`), and every check and
trigger rule also has source-copy mutations that remove or weaken it
(`packages/db/src/sso-storage-protections.ts`), run against the predecessor schema. The
upgrade test preserves a populated predecessor down to row versions and compares fresh and
upgraded schemas. The operator key that seals provider configuration is configured by the
first step that writes it.

## SSO identity storage

Migration 0075 installs the identity storage of the [SSO design](sso.md) (Identity storage
step): `sso_identity_links`, `sso_attempts`, `sso_mailbox_tokens`, `sso_replay_cache`,
`sso_browser_proofs` and `sso_delegation_bindings`. Nothing reads or writes them yet: there
is no route, worker, read path or setting, and OIDC and SAML stay hard-off. The test that
keeps production modules from naming the configuration tables covers these too. Admission
tombstones need no new table: they are the shared `scim_membership_blocks` of the
[SCIM identity storage](scim.md), which keep the team-local mailbox through member and
account deletion; a subject-keyed JIT check adds its column there in the step that needs it.

- **Identity links** bind one person to one IdP subject at one provider of a team. The
  identity, `(organization, provider, issuer, subject)`, is immutable, and the issuer must
  be the provider's (which 0074 already keeps immutable), so one live link per provider and
  subject keeps the whole identity unique, also under concurrent writers; a person has at
  most one live link per provider. A link records the normalized mailbox Hourmere last
  proved for it, never an IdP's email statement, and a new mailbox needs a later proof
  time. A link is retired rather than deleted while its team and account exist; retirement
  is permanent and takes a new link `generation`. New links are made only at an enabled
  provider.
- **Attempts** are a sign-in (before any session), a provider test or self-link (a person
  and their current session), or a fresh proof for one write (a person, their session and
  the team). Each freezes its kind, team, provider and current provider revision, person,
  session, browser-binding digest, operation and canonical input digest, and expires
  within `authenticationAttemptLifetime` (600 seconds). Only a fresh proof can require an
  SSO step-up, and it requires at least one method; the required methods only gain the
  mailbox later, and the mailbox is fixed once chosen. A mailbox proof needs the attempt's
  consumed token and ends with it; a step-up comes from the attempt's own person's live link
  at an enabled provider, authenticated between 60 seconds before the attempt and 60
  seconds after it is recorded, and records the team's current `trustGeneration`. Each
  proof is recorded once, within `freshAdministrationProof` (300 seconds). Nothing changes
  after expiry, and an attempt is consumed once, only while every required proof is live and
  what it relied on is unchanged: its provider still at the frozen revision and not retired
  (and enabled, for a sign-in or link), and its step-up's link live, provider enabled and
  trust generation current. Logging out deletes the session's attempts.
- **Mailbox tokens** store only the SHA-256 digest of the emailed token: one per attempt,
  issued only while the attempt awaits its mailbox proof, valid until the earlier of the
  attempt's expiry and 300 seconds, consumed once before expiry. Resending replaces it.
- **The replay cache** keeps the SHA-256 digest of each consumed SAML request, response and
  assertion ID per provider and kind, so concurrent callbacks consume it once. Entries are
  written at consumption, immutable and kept until `retain_until`, which the service sets to
  at least `max(acceptanceDeadline + clockSkew, requestExpiresAt)` and which is in the future
  and at most 720 seconds after consumption (the largest value that bound can take under the
  pinned limits); only the team's deletion removes them earlier.
- **Browser proofs and delegation bindings** record the membership, the enabled provider,
  the link and its generation, the team's `trustGeneration` (1 before the team has a policy)
  and the domain claim with its generation; all must be current when the row is written,
  and the claim must be one the provider serves, verified and unexpired. Both are immutable,
  and revoking one deletes it. A proof belongs to its person's session (logout deletes it)
  and lasts at most `ssoProofLifetime`, the session's expiry and the claim's verification
  expiry. A binding binds the person's own API key or MCP OAuth grant for the same team, one
  binding per credential, and lasts at most `ssoDelegationLifetime` and the key's expiry.
  Deleting the membership, the credential or the link deletes them. Because a lapsed claim
  generation can never be verified again, a proof or lease that recorded it never revives;
  rebinding inserts a binding at the claim's current generation.

`sso-identity-coverage.test.ts` drops every constraint, index, trigger and NOT NULL column
through `checkConstraintCoverage` (expectation file
`packages/db/src/testing/migration-objects/0075_sso_identity.json`), and every check and
trigger rule also has source-copy mutations that remove or weaken it
(`packages/db/src/sso-identity-protections.ts`), run against the predecessor schema. The
upgrade test preserves a populated predecessor, including the SSO configuration rows of
0074, down to row versions and compares fresh and upgraded schemas.

## Workflow definition storage

Migration 0076 installs the definition storage of the [booking workflows design](workflows.md)
(step 2 of its plan): `workflow_definitions` and `workflow_revisions`. Only the definition
reads of step 4 (`packages/workflows/src/reads.ts`) query them, behind the hard-off guard, so
they answer `workflows_disabled` while workflows stay off behind
`WORKFLOWS_IMPLEMENTED = false`; nothing writes them yet, and no worker or setting uses them.
A test keeps every other production module outside the storage layer from naming them.

- **Definitions** have an immutable ID, organization, owner and creation time. Definition IDs
  are server-generated: every definition takes the column's `uuidv7()` default, and callers
  never supply one. Storage accepts an explicit ID, and if a purged workflow's ID were reused,
  a retained enrollment of it that has no run could get one, so creation never passes an ID
  from a request, tool or command. A personal
  definition belongs to its user in that user's personal organization (`owner_user_id`); a
  team definition (`owner_user_id` NULL) belongs to the team organization, never to the member
  who created it, and is refused in a personal organization. The owner is checked when the
  definition is created; a future change that turns a personal organization into a team must
  handle its personal definitions. `revision` is the current
  revision, which always exists and is the latest one; it never goes back. `enabled` is the
  live switch, false by default, and no revision carries it, so enabling and disabling change
  only the definition row. Deleting a workflow tombstones it (`deleted_at`): a tombstone is
  disabled, final and takes no new revision. A definition row is removed only as a tombstone
  (a later purge), with its organization, or with its personal owner, even when the user no
  longer has a personal organization; its revisions go with it.
- **Revisions** are numbered 1, 2, 3… within their definition, with no gap or repeat, and
  each new one becomes the current revision. They are never updated, and are deleted only
  with their definition. A revision stores the definition that the contract in
  `packages/workflows` validated: its canonical output without `enabled`. The database checks
  mirror the contract's envelope: exactly the keys `name`, `scope`, `trigger`, `conditions`
  and `actions`; a name of 1 to 200 UTF-8 bytes; a known scope; a known trigger with its delay
  (0 to 43200 whole minutes) or its offset (5 to 43200 whole minutes) and nothing else; at
  most five conditions with known fields; exactly one email or webhook action. The service
  validates everything else through the contract before it writes, and a test binds each
  mirrored limit and catalogue to the contract's constants and schemas, in both directions.

Writers lock the organization before the definition, as other organization writers do: a
definition insert locks its organization row through its foreign key, and a new revision
locks the organization and then its definition, so a concurrent organization deletion waits
instead of deadlocking, and concurrent revisions of one workflow are numbered one at a time.
An update of a definition row takes no organization lock, so a transaction that updates a
definition and then adds a revision must lock the organization first. The service steps take
the organization lock before any workflow row.

`workflow-storage-coverage.test.ts` drops every constraint, index, trigger and NOT NULL column
through `checkConstraintCoverage` (expectation file
`packages/db/src/testing/migration-objects/0076_workflow_definitions.json`), including a lock
check of the organization foreign key, and every check and trigger rule also has source-copy
mutations that remove or weaken it (`packages/db/src/workflow-storage-protections.ts`), run
against the predecessor schema. The upgrade test preserves a populated predecessor with
configured reminders, follow-ups, booking snapshots, scheduled messages and receipts down to
row versions, and compares fresh and upgraded schemas.

## Workflow execution storage

Migration 0079 installs the execution storage of the [booking workflows design](workflows.md)
(step 3 of its plan): `workflow_enrollments`, `workflow_runs`, `workflow_recipient_claims`,
`workflow_run_history` and `workflow_mail_reservations`, plus a nullable
`workflow_reservation_id` on the shared mail ledger. Nothing reads or writes them yet: there is
no route, worker, read path or setting, and workflows stay hard-off behind
`WORKFLOWS_IMPLEMENTED = false`. The test that keeps production modules away from the definition
tables covers these tables too.

- **Enrollments** record a booking's capture of one workflow revision at one lifecycle
  occurrence: its creation (the creation trigger and the timers; a reschedule successor
  carries its timer enrollments under this occurrence with their captured revision), its
  reschedule or its cancellation, each occurrence taking only its own triggers. They are
  unique per booking, occurrence and workflow, immutable, and need a live (not tombstoned)
  definition and a stored revision with the named trigger.
- **Runs** are the one due run of an enrollment (a revision has one action), on its booking.
  Their due and expiry instants never change, a worker claims one with a token and a lease,
  and a run starts pending, or skipped with a fixed reason (as capture records `minimum_gap`
  and `offset_not_future`). Completed, skipped and retired runs are final; skip reasons are the
  contract's fixed codes. A partial index holds only unfinished runs for the due scan.
- **Recipient claims** are the recipients of an email run: an attendee or assigned host and
  the workflow-purpose digest of the normalized address, never the address, unique per run
  and digest. A timer email's winning recipient also holds its intent (category, offset,
  digest), which only one workflow can hold on a booking; a losing recipient keeps no intent.
  `dispatching` is the marker committed before SMTP with its attempt's claim token, set only
  while the run is claimed; sent, rejected, `delivery_unknown` and skipped are final. Claims
  are added only to an unfinished run. A partial index finds markers for the repair that ends
  stopped attempts, also under a run that finished after its marker.
- **History** keeps one immutable, content-free record per finished run: workflow, revision,
  trigger, due and finish times, outcome, a fixed reason and aggregate recipient counts. It is
  not linked to the run or booking, so it outlives the booking for its retention window; it
  goes with its workflow, and retention deletes it by finish time.
- **Mail reservations** charge one admitted recipient claim to its owner organization; the
  ledger row in `notification_email_sends` names the reservation, at most one per
  reservation, and always carries a recipient digest. Run and claim are named without foreign
  keys, so deleting a workflow, booking or run never removes a charge. A reservation is
  restamped only forward and is removed only after its ledger row or with its organization.
  Existing and core ledger rows keep NULL; core inserts and count queries are unchanged.

Inserts lock the organization before any parent row, as other organization writers do. An
enrollment or a run takes the organization lock and then a share lock on its definition, so a
capture and the workflow's deletion take turns: the tombstone waits for a capture, and a
capture after it is refused, not skipped, so capture selects the live definitions it enrolls
with a share lock after the organization lock. A recipient claim locks the organization and
then shares its run. A marker shares its run too, so a retirement that commits first prevents
the marker and a marker that commits first holds the retirement back; a marker transaction
locks the run before the recipient, as retirement does. Updates of runs and claims take no
organization lock, so a transaction that claims a run and then adds a recipient must lock the
organization first. Child rows carry their organization in composite foreign keys (as
revisions do), and reservations, which have no parent row, reference the organization
directly.

Two rules order the later workflow writers against each other and against the existing writers
that share their locks:

- **Organization first.** Every workflow writer takes the organization lock first, before the
  mail-budget lock and before any definition or run row. First means first among the workflow
  locks: identity locks that the existing order puts before the organization, such as the
  personal owner's user row that `lockOrganization` share-locks, still come before it. A mail
  admission, including a
  retry's re-admission, locks the owner organization (`FOR KEY SHARE`) before
  `lockNotificationEmailBudget`. Invitation creation holds its team `FOR UPDATE` and then
  takes the budget lock, so an admission that reached the organization only through its
  reservation's foreign key, after the budget lock, would deadlock with it.
- **Definition before runs.** Writers that touch both definitions and runs lock the definition
  before its runs. A deletion tombstones the definition and then retires its pending runs; if
  it retired first, it would miss a pending run that a concurrent capture commits. A
  reschedule or cancellation share-locks the live definitions it may capture, after the
  organization and in ID order, before it retires or writes any run. A reschedule that retired
  the predecessor's run and then carried its timer would wait for the definition in the
  enrollment guard while the deletion, holding the tombstone, waits for that run.

`workflow-storage-lock-order.test.ts` races each reversed order on two connections into a
deadlock (40P01) and each documented order to completion, with the lock statements of
`workflow-storage-lock-order.ts` that later steps reuse.

Execution identity outlives a definition's content. Enrollments name their workflow and
revision without a foreign key to the definition, and enrollments, runs and recipient claims
hold no definition content, rendered text or addresses. They are removed only with their
booking (or, for runs and claims, their parent) or organization, never by retention. Purging a
tombstoned definition (deleting it with its revisions and history) is refused (23514) while one
of its runs is pending or claimed, and keeps every booking's enrollment, run and claim, so a
replayed capture or a repair meets the same unique identity and the same final state and
cannot dispatch again. With its organization or personal owner a definition always goes;
without its personal-organization marker (no production path removes it), a personal owner's
deletion leaves that organization's bookings and their unfinished runs, which dispatch must
end without history because their workflow is gone.

`workflow-storage-execution-coverage.test.ts` drops every constraint, index, trigger and NOT
NULL column through `checkConstraintCoverage` (expectation file
`packages/db/src/testing/migration-objects/0079_workflow_execution.json`), and every check,
default and trigger rule also has source-copy mutations
(`packages/db/src/workflow-storage-execution-protections.ts`), run against the predecessor
schema. Two writers race every capture identity (enrollment, run, recipient, intent,
reservation, ledger charge and history record), and exactly one wins. The upgrade test preserves a
populated predecessor with reminders, follow-ups, workflow definitions and the mail ledger down
to row versions, and compares fresh and upgraded schemas. A notifications test shows the core
ledger counts and purge unchanged on the same rows across the upgrade.

## Planned additions (each a new migration)

The [booking workflows design](workflows.md) specifies proposed triggers, conditions,
email and webhook actions, durable execution records and workflow sub-caps within the shared mail budget.
Only its definition and execution storage exist ([workflow definition
storage](#workflow-definition-storage), [workflow execution storage](#workflow-execution-storage)),
with definition read operations that answer `workflows_disabled` while hard-off; no write API,
worker or runtime enablement exists yet.

| When | Change |
|---|---|
| Cloud billing | `subscriptions` (organization ↔ Stripe customer/subscription, plan, seats) |
| Weeks 5–8 | Better Auth teams (sub-groups for round-robin pools) |
| With Google/Microsoft sign-in | Already configured: Better Auth encrypts sign-in OAuth tokens (`encryptOAuthTokens`) |
| After launch | Better Auth `two-factor` |
| Planned, all instances | Organization SSO (OIDC/SAML): [evaluation and design](sso.md); audit integration |

Background jobs (notification emails, reminders, calendar synchronization and webhook
delivery/retries) use pg-boss (`@hourmere/jobs`), which keeps its queue in its own `pgboss` schema and
installs and upgrades it itself (on start, or with `npm run db:migrate` when
`AUTO_MIGRATE=false`). Our migration runner never touches that schema, `db:types` leaves it
out. Webhook cleanup reads its pinned job state to reconcile orphaned deliveries; no
application foreign keys reference its tables.

## Changing the schema

1. Add `packages/db/migrations/NNNN_description.sql` (four digits, lowercase). Never edit
   an applied file: the runner stores a checksum and refuses changed files.
2. `npm run db:migrate`, then `npm run db:types` to regenerate `tables.ts`. CI fails when
   the types are stale.
3. Better Auth changes (new plugin or upgrade): `npm run auth:sql` against a database at
   the latest migration. It writes only the difference to
   `packages/auth/auth-schema.generated.sql`; prefix it with
   `SET LOCAL search_path TO auth, public;` and save it as the next migration.

Column removals use two releases: release N stops writing the column, and release N+1
removes it. Stop all old app (`all` or `web`) and worker processes before applying a version
whose migrations drop columns; this includes workers managed outside the app's Compose
project. A single-container `docker compose up -d --build` stops the old app before
starting its replacement, but a separate worker must be stopped explicitly before the new
app or a manual migration applies the drop. Restart every role with the upgraded code.
See the [operator upgrade procedure](https://hourmere.com/docs/self-hosting#upgrade-and-roll-back).

Migration `0037_conference_pending_timeout.sql` is the first column drop and a historical
exception to the two-release policy: it removes the write-only
`booking_conferences.retry_conference` flag while old binaries still write it. All old
roles must stop before 0037 runs. Every migration that drops a column (including
`ALTER TABLE ... DROP ...` without `COLUMN`), drops a table or view, renames a table,
view, materialized view, sequence, foreign table or column (including a view column),
moves a table or view with `SET SCHEMA`, or changes a column's type with
`ALTER [COLUMN] ... [SET DATA] TYPE` must have a same-basename Markdown sidecar
in `packages/db/migrations` with a nonempty
`Schema-break upgrade:` note describing compatibility with old binaries, the release
sequence and required operator steps. Historical `Column-drop upgrade:` notes remain
accepted. The migration policy test is a static lint that ignores comments and quoted
strings. Dynamic SQL, `DO` blocks and function bodies are out of scope and need manual
review. It flags missing notes; never edit published SQL to add one.

Also review `DROP NOT NULL` for compatibility with old readers: a table that gains nullable
rows can break an old binary's assumptions even though no column is removed. The static
lint does not identify which tables old code reads, so this requires manual review and
an explicit upgrade note when old readers are incompatible. Migration 0039 is such a case:
old availability queries skip the new date rows because `calendar_busy.period` is NULL.

## Sign-in email outbox

`sign_in_emails` is instance-wide authentication delivery state. Every link request writes
an ID, authenticated ciphertext and the actual verification expiry, then enqueues only that
ID in the same transaction. No plaintext recipient or link is stored in the outbox/job JSON.
The worker rechecks token existence/expiry, current signup rules and account/invitation
eligibility, serializes delivery through the outbox row, and deletes it on success or when
it cannot be used. A periodic job removes expired rows even if their delivery job was lost.
The encryption key is derived from the auth secret, separately from calendar encryption;
row ID and public origin are authenticated associated data.

## Invitation delivery storage

Migration 0045 adds nullable `invitation_deliveries.authorized_by_user_id` without rewriting
existing generations. Each new generation pins the acting administrator for sender authority
checks and the invitation mail's name. Null legacy rows fall back to the invitation's original
inviter. The recorded UUID has no user foreign key: deleting the actor keeps its identity,
so the sender refuses it rather than falling back to a different administrator. The original
`auth.invitation.inviterId` stays unchanged for non-transitive signup eligibility.
Its current team membership also determines invitation validity independently of the
generation's authorizing administrator. If the original inviter no longer belongs to the
team, signup loses its invitation exception, recipient invitation discovery omits the row,
and acceptance, resend and expired-row replacement refuse the invitation; queued/retrying
delivery becomes `skipped/invitation_ineligible`. Both claim and pre-SMTP checks enforce this.
No invitation lifecycle rewrite is needed. A new signup-policy migration also enforces
current inviter membership when creating an account. A current owner/admin can create
a fresh invitation in their own name, and cancellation remains allowed.
Stop old web/all/worker processes before applying this migration and restart every role
with the new code: old senders do not read the generation's authorizing administrator.
Expired invitations never renew in place. Under the team lock, the explicit expired-row
operation atomically cancels the old invitation, finalizes its queued or sending delivery,
and creates a new invitation ID whose inviter is the acting administrator. New-invitation
request budgets, active-duplicate and pending-limit checks apply. Native creation likewise
cancels expired pending rows for the address, so neither path leaves duplicate stored-pending
rows. Signup trust follows the new inviter and the old link stays unusable. Acceptance,
resend and cancellation share team/invitation lock ordering. Cancellation only changes a
pending invitation's status and never deletes a joined membership.

`invitation_deliveries` retains one current generation per `auth.invitation` UUID,
with `ON DELETE CASCADE`. Its five states are `queued`, `sending`, `smtp_accepted`,
`failed` and `skipped`; these never change Better Auth's invitation lifecycle.
Generation is bounded to 1–32 and attempts to 0–4. Only `sending` has a lease ID
and deadline and requires a consumed attempt; only `smtp_accepted` has an SMTP
acceptance timestamp. Failed and skipped outcomes require an allowlisted error code.
The row holds no recipient, link, credential, message or provider response.
A partial `(due_at, invitation_id)` index covers queued and sending records.

The notification package's storage query lists pending, unexpired invitations in one
organization with their delivery summaries. A missing delivery row reads as `unknown`,
which provides no evidence of sending. Callers must authorize access to the organization
before using this internal query; no HTTP endpoint is installed by the storage layer.

The server's session-only `GET /api/v1/team/invitations` separately lists all invitation
lifecycle states for the current team's verified owners/admins. It returns the invited
recipient address only to those managers, alongside a strict safe delivery summary; ordinary
members, other teams and agent credentials cannot read it. No links, tokens, message bodies
or raw provider errors are exposed. It shares resend eligibility and request-budget checks with the write
path. Pending expiry uses a materialized database-clock value, with terminal statuses
preserved. Missing delivery rows read as unknown. Migration 0044 adds nullable
`last_attempt_at` without rewriting or guessing legacy rows. The
`invitation_delivery_attempt_time` trigger owns this column: senders must omit it from
writes. Explicit INSERT or UPDATE values are
overwritten. Inserts with a consumed attempt, attempt-count increases and generation
changes with a consumed attempt record `clock_timestamp()`; zero attempts clear the
column, and other updates preserve its previous value. `lastAttemptAt` is null before any
attempt or when the historical time is unknown; `updated_at` is not treated as an attempt
timestamp. Existing writers that increment attempts need no change. See the
[invitation delivery design notes](https://hourmere.com/docs/notifications#team-invitation-delivery-design-notes).
See the [API contract](https://hourmere.com/docs/api-conventions#team-invitation-delivery-summaries).

Every delivery row remains while its invitation is pending and unexpired, including terminal
delivery outcomes, so unexpired resends retain their generation cap and original validity
length. Cleanup takes bounded batches, locks invitations before delivery records, and skips
locked rows. It deletes expired pending invitations' records and accepted, canceled or
rejected invitations' records once both `expiresAt` and delivery `updated_at` are at least
seven days old and no live lease remains. Unknown invitation statuses are retained. Invitation rows themselves are preserved.

Before applying the invitation-delivery migration, stop all old web/all/worker processes.
Existing pending, unexpired invitations are backfilled as
`failed/legacy_delivery_unknown`, with generation 1 and zero attempts; other invitations
and the sign-in mail tables are preserved. This prevents later repair from silently
resending historic invitations with unknown mail outcomes. Restart every role with the
new version. The migration itself installs storage and queries; management and queue
integration are application code. Explicit resend extends expiry under the approved
protocol, independently of these storage queries.

Invitation admission now writes the invitation and its queued delivery intent in one
transaction. The explicit resend cooldown uses the later of `generation_started_at`
and `updated_at`. The sender updates `updated_at` on every delivery attempt
so attempts restart the post-delivery wait. `expiry_duration_ms` retains the original
validity length across successive renewals. The migration retains delivery creation time as the cooldown anchor
and seeds the known legacy 48-hour validity policy. Historic native resends changed expiry
without changing invitation creation time, so their difference cannot recover original
validity. Invitation status, expiry, attempts and delivery outcomes remain unchanged.

`invitation_email_requests` retains actor/team UUIDs, an invitation-domain recipient HMAC
and request time for rolling inviter/team/recipient limits. It has no foreign keys, so
deleting an invitation, account or team cannot reset the budget. Admission holds the
existing global mail-budget lock without debiting the shared sending allowance in
`notification_email_sends`. The sender checks and debits ordinary, non-reserved
shared capacity at send time. Both ledgers retain two days. Every admission record
requires its recipient hash; migration 0043 creates this ledger without changing earlier
shared mail accounting.
After admission commits, the request dispatches its current queued generation through an
injected dependency. A second short transaction locks invitation before delivery and
commits the exclusive pg-boss job together with `last_job_id`. A queue exception or null
enqueue rolls back only that dispatch; the admitted queued record and its due time remain
available for request retry or periodic repair. A narrow adapter pinned to pg-boss 12.38.0
checks job identity, exact payload, singleton key, live state and expiry without a foreign
key into pg-boss, using pg-boss's own clock for job expiry. An unsupported pg-boss version
fails job startup with a compatibility message. Startup and minute repair scans use bounded,
fair cursor batches. A failed startup scan is logged and the minute schedule retries it.
The repairer skips obsolete business states before enqueueing. If a job's 24-hour waiting
retention or active expiry has passed, an exact-identity adapter cancels that expired job
inside the replacement transaction, preserving its history and releasing the exclusive
key without waiting for maintenance. Live jobs and completed, canceled or failed history
are preserved. The delivery row lock and pg-boss exclusive index serialize replacements;
later scans reuse the retained live job. A queued job may remain after its generation is
skipped or superseded. The sender rereads the current delivery state and generation,
invitation status and expiry before every attempt. An obsolete job cannot modify a
successor's row, and completed job history is not evidence of a live job.

Each generation permits at most four SMTP attempts. A short transaction locks invitation
before delivery, rechecks current authorization and invitation eligibility, registers the attempt,
updates `updated_at`, debits shared mail capacity and commits a random 120-second lease
before SMTP. This reservation is conservatively consumed if a crash or cancellation
prevents the subsequent network call. A second, pre-SMTP transaction rechecks authorization,
the invitation and claim, and reads the current recipient and organization for the message.
`last_attempt_at` is left to its trigger. SMTP waits at most 60 seconds, shortened to the
remaining lease minus a one-second safety margin; less than one second of usable time
prevents a send. Rendering and transaction completion consume that time too. The pg-boss
job expires after 180 seconds. Transient errors persist a 60/120/240-second
backoff; dispatch can add up to one minute repair cycle, plus queue scheduling time.
pg-boss itself has zero retries. A crash consumes the registered attempt. The
repairer recovers expired claims without resetting their count, and a final crashed
attempt becomes failed rather than receiving a fifth attempt. Permanent/configuration
errors and budget exhaustion retain a failed summary with a fixed safe code.

Only a matching current claim can record `smtp_accepted` and its timestamp; future work
observes that terminal state and skips SMTP. This means accepted by the mail server,
without a claim of inbox delivery. If SMTP accepts but the following database commit
fails, the durable row can still say sending and a later retry can send a duplicate.
An SMTP timeout or shutdown abort stops waiting, but cannot recall a message already
submitted or guarantee the underlying exchange stops: it can still be accepted in the
background and overlap a later finite retry. Leases and job identity cannot guarantee
exactly-once external delivery. Cancellation or authorization changes after the final
database check can also race an SMTP call already starting.

## Guest recipients

`event_types.allow_guests` is a non-null boolean, default `false` for both new and existing
event types (migration 0015). Hosts explicitly enable it to let new bookings add up to ten
guest email recipients. Public personal/team pages and REST/MCP booking creation enforce
the current setting in the booking transaction, holding an event-type share lock until
commit. Settings changes wait for an already approved booking; a booking waiting behind a
settings change reads its committed value. Existing `booking_attendees` are preserved for
reminders, rescheduling and cancellation, and successful idempotent replays still work.

## MCP OAuth

Migration 0016 adds the version-matched Better Auth JWT/OAuth provider tables in `auth`.
`mcp_oauth_grants` binds a user, client and organization to an opaque grant ID; native
consent/refresh-token `referenceId` uses that ID. Reconnection after revocation creates a
new ID, so outstanding codes/JWTs cannot revive. `mcp_oauth_intents` binds one signed
request hash and organization to one session for at most five minutes. It is immutable
apart from consumption. These correlation records deliberately avoid cascading foreign
keys: browser approval locks its intent while Better Auth uses a separate connection.
Current sessions, verified email and membership are checked explicitly before approval.

Migration 0030 adds `mcp_oauth_client_activity`: a client-keyed consent completion and last-use
record that survives grant revocation and cascades on client deletion. Existing consent and
retained token timestamps seed the record. It separates DCR clients that never completed
consent (24-hour retention) from previously approved clients (at least 90 days without use,
with one day of grace for coalesced writes). Token issuance and MCP use update activity at most daily; approval records completion immediately.
The absolute offline-access deadline remains the original native consent creation time plus
30 days, independent of this client activity record and browser session lifetime.

Bookings retain `oauth_consent_id` and `cancelled_oauth_consent_id` as historical attribution,
without cascading on credential deletion. OAuth origins require `source=mcp` and no API
key ID. The idempotency index includes both nullable credential columns, preserving existing
anonymous/API-key scopes while isolating each OAuth consent. Public booking representations
expose neither credential identifier.

## Organization operation attribution

`organization_operations` supplements the existing booking source, API-key and OAuth
attribution with the authenticated user who actually cancelled. A small shared table is
needed because membership removal/leave and role changes have no booking row. It stores
only the operation, organization, actor/target UUIDs, source/credential UUIDs, role
transition and occurrence time. It contains no generic payload, names, email addresses,
answers, cancellation reasons, session identifiers or tokens. There is no general operation
log API or audit-management interface. The session-only member-removal handling route
uses a scoped `member_removed` record to identify the removed host after membership is gone
and projects that team's current unfinished bookings through the administration whitelist.
Removal records, membership revocation and affected team event-type deactivation commit
in the same transaction. Booking rows and original hosts remain intact.

Cancellation records use the same source/key/OAuth origin as `bookings.cancelled_*`, in
the booking transaction. Host operations take the actor from the authenticated principal;
the team-management transaction helper takes the actor returned by the shared access
check, scoped to its organization. A private-link cancellation without an authenticated
identity records a null actor; an authenticated MCP private-link caller records that
caller's user, which can differ from the original host and invitee. Holding a link does
not prove the attendee's identity. Reschedule withdrawals retain their existing booking
attribution and do not create cancellation-operation records.

Better Auth's remove-member, leave and update-member-role persistence paths record the
actual changed membership in the same write transaction. Every native adapter transaction
binds the launch role policy to its auth-pool connection, including `deleteMember`:
administrative removal, dependent event deactivation and attribution join that transaction.
Policy writes outside a native transaction, including HTTP role changes, use their own
locked application transaction. Self departure uses the scheduling service's transaction.
Safe departure also commits the session's personal fallback in that transaction after
rechecking current event and booking impact. The policy wraps the native
recorder so neither a second connection nor a second record is needed. A role no-op, rejected request
or rolled-back operation creates no record. Personal-organization maintenance and direct
adapter maintenance are excluded; this recorder does not add authorization or change
caller/session checks. New management services must record through their own authorized
write transaction rather than a post-commit hook.

Writers acquire the organization before the target row. Cancellation takes only the
organization key-share lock before its booking, without locking host identity. HTTP role
changes hold the organization's write lock before updating the target and inserting the
record. Native membership writes reserve
their organization foreign-key lock through the eventual operation INSERT before updating
or removing the member, including perceived role no-ops. A failed conditional update or
successful no-op discards that tentative row; only an actual change retains it, stamped
after the successful write. Tentative rows remain invisible outside their transaction.
This order prevents a cycle with team-management writes that lock organization then member
or booking.

Actor, target, API-key and OAuth identifiers deliberately have no foreign keys: deleting
an account or credential must not erase who performed a retained team operation. They do
not retain the deleted account's name or email, or restore access. Booking deletion
cascades its cancellation record; organization deletion cascades every operation record.
Member records remain with the organization. The additive migration creates an empty
table without rewriting existing booking fields, timestamps or physical rows, and never
guesses historical actors. Older binaries remain schema-compatible but do not create
these records; upgrade every writer to obtain complete attribution from that point on.

## Team membership and host lock order

Every team departure, administrative removal and native Better Auth role change locks
the organization `FOR UPDATE` before locking a member row. Team booking and event-type
writers hold the organization `FOR SHARE` before their host-eligibility member locks.
Acquire the required organization mode directly; do not upgrade competing organization
share locks to update locks. Keep all locks through the write transaction's commit or
rollback, using that transaction's connection for the protected reads and writes.

The phases within that organization boundary are:

- Membership management takes the actor's verified `auth.user` share lock, the organization
  update lock, the actor's member share lock, then the session share lock. Removal and role
  change next take the target member update lock. Removal then locks affected event types
  in ID order before deactivation. The organization update lock excludes booking and
  event-type writers throughout these member and event changes.
- A new team booking takes the organization share lock, then `booking-host:<userId>`
  advisory locks for the complete pre-read host set in sorted user-ID order. It next
  share-locks and rereads the event type, share-locks host `auth.user` rows in sorted ID
  order, then share-locks their member rows in sorted user-ID order. Round-robin bookings
  next lock their assignment state. A changed host set is refused; do not append newly
  discovered advisory locks out of order.
- Routing form creation takes the organization share lock, then the transaction advisory
  lock `hashtextextended('hourmere.routing-form-quota:' || organizationId, 0)` before
  inserting the form. It never upgrades or writes the organization row. Any transaction
  combining form admission with event/form/receipt operations must take this advisory
  lock after the organization lock and before event-type, form and receipt row locks.
  Any future operation that unarchives a form must take the organization lock and then
  this advisory lock explicitly before it locks or updates the form row. The form trigger
  also takes the advisory lock to check capacity, but only as a backstop: a bare
  `UPDATE … SET archived_at = NULL` locks the form row before the trigger runs and can
  deadlock (`40P01`) with a transaction that took the advisory lock first. No unarchive
  operation exists yet.
- Routing form configuration writes (create, save, archive, publish) take the
  organization share lock first, after a personal organization's owner as above, then the
  actor and member share locks. Creation next takes the form-admission advisory lock;
  publication share-locks its target event types in ID order; each write then locks the
  form row. Publication therefore waits for membership management and event-type edits
  instead of deadlocking with them. Preview takes no lock and runs read-only. A create or
  publish that carries a `requestId` takes the transaction advisory lock
  `hashtextextended('hourmere.routing-form-request:<organizationId>:<actorKind>:<actorId>:<requestId>', 0)`,
  with the UUIDs in lowercase (creation after form admission, publication right after the
  actor, member and API-key checks, both before any event-type or form row lock), and then
  share-locks its existing `routing_form_operations` record, so a version cleanup deleting
  that record finishes first. Only routing takes that lock, always after the
  organization and before event types, so it adds no cycle; concurrent retries of one key
  queue on it, and each finds the record the first one committed.
- SCIM User creation takes the organization update lock first, like membership management,
  then a key share lock on its provisioning token row (revocation and rotation take the
  organization lock before their token update lock), then the shared invitation service's
  locks: the address's pending invitation rows, their delivery rows and the mail-budget
  lock, inside a savepoint that is rolled back, releasing them, when the claim records no
  invitation. It locks no member row: the organization lock excludes membership changes while it
  reads the earliest owner who invites. When the address's pending invitation expires during
  one of those waits, it rolls back to the savepoint and runs the invitation service once more.
- Invitation acceptance takes the recipient's `auth.user` share lock, the organization update
  lock, its session no-key-update lock and the invitation update lock. When SCIM claim
  completion is wired, it then locks the claim bound to that invitation and that claim's
  `scim_users` entry, both `FOR UPDATE`, before the native member insert; the entry's link,
  the claim's completion and the audit event follow that insert in the same transaction. A
  SCIM writer that takes the organization lock first therefore waits for, or is waited on by,
  the acceptance, and never holds the claim or entry while the acceptance waits for the
  organization.
- Event-type configuration takes the organization lock before the event-type lock and
  host eligibility checks. Browser configuration also takes the shared management actor
  locks first. Host eligibility locks verified users before their member rows, both in
  sorted user-ID order.

Actor identity checks can therefore take an `auth.user` share lock before the organization,
while public booking host eligibility takes user share locks after it. These user locks
are compatible `SHARE` locks; membership management does not acquire a user update lock.
The common ordering invariant is organization before member, including target members;
never move a target member lock ahead of the organization. The session context advisory
lock, where used, precedes these row locks. Native HTTP context serialization holds only
that advisory lock on its separate connection, allowing Better Auth's own session writes.

Departure impact previews reserve nothing. After waiting for the organization update lock,
leave rereads current owner tokens, event assignments and unfinished bookings in its
`READ COMMITTED` transaction. It refuses current blockers with their handling list and
commits no membership, operation or session change. Administrative removal may deactivate
current affected event types, but neither removal nor leave rewrites existing bookings'
`required_host_user_ids` snapshots.

## Required booking hosts

Migration 0019 adds `bookings.required_host_user_ids`, an immutable UUID-array snapshot.
New bookings save the complete sorted host set, and rescheduled successors copy that set.
`auth.user` deletion cascades the corresponding `booking_hosts` row, so the snapshot is
needed to detect a missing required participant instead of silently moving a smaller meeting.
The snapshot has no foreign keys, is never returned by public APIs, and does not restore
an account or its deleted personal data. Canceling remains possible when a host leaves,
is unverified or is deleted. Rescheduling then returns `booking_hosts_unavailable`.

The backfill captures the booking host rows still present at migration time. A host deleted
before that migration cannot be recovered; these legacy bookings retain only their remaining
identities. A historical booking with no snapshot and no hosts cannot be rescheduled.

See [collective scheduling](https://hourmere.com/docs/collective-scheduling) for assignment, availability and locking.

## Host reschedule tokens

Migration 0029 makes `bookings.manage_token_hash` nullable so a host move can transfer the
invitee's existing hash to its successor without minting or returning a new secret. The
unique constraint remains in place. Existing bookings and email-token hashes are unchanged
by the migration. Host moves lock the personal owner (where applicable), organization and
booking before host locks, matching deletion order; cancellation or invitee rescheduling
that waited for a host transfer resolves the moved hash again under the booking lock.

Invitee reschedule limits count predecessor rows with a retained response-token hash across
the existing `rescheduled_from_id` chain. Host moves transfer and clear that hash; they
neither consume nor reset the invitee count. The current booking's lock serializes moves
and their limit checks. No separate counter or reschedule-schema migration is needed.

## Notification email abuse accounting

Migration 0040 adds terminal `suppressed` notification receipts with a bounded
`suppression_reason` and no manage-token hash. `notification_email_sends` holds only a
normalized invitee/guest or sign-in recipient digest (or NULL for hosts) and timestamp.
Runtime hashes use HMAC-SHA-256 with a key derived from `BETTER_AUTH_SECRET` under a fixed
mail-accounting label, with separate booking and sign-in domains; normalization is trim
and lowercase only. The ledger has no booking foreign key, so cancellation, rebooking and
deletion cannot reset the mail budget. Sign-in suppression deletes the outbox row without
sending; successfully committed sends add a ledger row and delete their outbox row, so a
retried job cannot resend them. An hourly cleanup job removes accounting rows older than
two days.

Existing retained sent receipts seed that ledger on upgrade; deleted recipient identities
cannot be reconstructed. Migration 0040 remains unchanged and backfills legacy unkeyed
SHA-256 hashes. Those rows (and rows from earlier code) count toward the instance cap but
not HMAC recipient windows; the recipient-count gap lasts at most 24 hours and old hashes
are purged after two days. Rotating `BETTER_AUTH_SECRET` likewise resets recipient counters
while preserving instance counts. Mixed old/new processes are schema-compatible: old
inserts default to `outcome = 'sent'` and NULL `suppression_reason`, and old reads filter
`outcome = 'sent'`. Nevertheless, build first, stop every old web/all/worker process, then
start all roles with the new code, since old senders do not enforce or record these budgets.

The send transaction serializes all notification and sign-in mail through one
database-local advisory lock, checks rolling counts, and commits a send plus accounting or
a terminal suppression. Slow SMTP therefore holds up other sends in this instance. All
sends count toward the instance cap; host and sign-in mail share its 20% reserve, and
sign-in and booking recipient windows remain separate. Failed sends roll back. Existing
receipt deduplication and the SMTP acceptance/failed-commit duplicate window remain. See
[email abuse controls](https://hourmere.com/docs/notifications#email-abuse-controls)
for defaults, reserve and diagnostics.

## Configurable booking mail

Migration 0049 adds event-type `notifications` settings and the immutable per-booking
`notification_snapshot`. Existing types receive the previous all-recipient 24-hour reminder;
existing bookings keep NULL, which always means that legacy default. Settings edits affect
only new booking roots. Reschedules materialize or copy the predecessor snapshot and
recompute offsets from the successor's UTC start and end. Internal configuration services
serialize complete replacements with the event-type row lock. Protected REST event types
expose these settings; REST, MCP and CLI writes share service validation and permissions.

The exact default policy retains the existing generic reminder and conference-ready outbox
paths. Every other policy uses `booking_scheduled_messages`, uniquely identified by booking,
kind and stable rule ID. Snapshots, message rows and initial jobs commit with booking creation.
Cancellation and replacement fence pending and processing messages in the same transaction;
terminal history remains. Old jobs never follow a successor.

Configurable receipts add the rule ID as `message_key`; legacy and lifecycle receipts keep
the empty key. Both modes share the existing mail-budget lock and ledger. A suppressed
recipient is terminal for that rule and is never back-filled when capacity returns. Follow-up
mail uses the scheduled UTC end, carries no meeting link, calendar attachment or new manage
capability, and makes no attendance claim.

Durable message rows own the maximum thirteen attempts, exponential backoff and five-minute
claim lease. Short claims commit before network I/O; per-recipient final reads after budget
waits check lifecycle, anchors, claim and conference revision. Reminders expire at start;
follow-ups expire twenty-four elapsed hours after their due time. Startup and minute repair
scan bounded fair batches without resetting attempts or reviving terminal messages. No
booking or message row lock spans SMTP. SMTP acceptance followed by a failed commit, or a
cancellation after the final read, retains the existing unavoidable delivery race.

The populated predecessor test starts at migration 0048 (`0048_api_key_scopes.sql`) and
verifies preservation of scoped API keys, ordered allowed duration lists and bookings whose
actual duration differs from the event default. It also compares the upgraded schema with a
fresh install and verifies no-op reruns. See
[the 0049 upgrade note](../packages/db/migrations/0049_configurable_booking_messages.md)
for the required coordinated worker rollout.

Migration 0052 permits an optional plain-text `hostNote` on follow-up rules and their
immutable booking snapshots. It replaces the existing JSON validation function without
changing defaults or rewriting rows. Notes are limited to 2000 UTF-16 code units, with
tabs and line endings allowed; other C0/C1 controls, bidi embedding/isolate controls and
malformed Unicode are rejected. Reminders cannot carry a note. See
[the 0052 upgrade note](../packages/db/migrations/0052_follow_up_host_note.md) for the
predecessor-preservation checks and rollout constraints.

Public writes apply the 2026-10-31 note contract before storage: CRLF becomes LF, bidi
embedding/isolate controls are removed, and the normalized value must be well-formed,
at most 2000 UTF-16 code units and free of other controls (including tabs). This is stricter
than migration 0052's storage envelope; published migration SQL stays unchanged and
legacy saved snapshots remain readable. `FOLLOW_UP_HOST_NOTES_ENABLED=false` rejects
explicit note writes and omits even saved snapshot notes when sending, without rewriting
stored settings or changing default reminders.

## Internal full-booking waitlists

Migration 0051 adds an opt-in `waitlist_enabled` flag, defaulting to false without importing
historical booking contacts. The services support personal and team individual
event types with exactly one eligible host. Hosts opt in from the event-type editor,
REST, MCP or CLI. Public pages offer enrollment after a successful empty availability
query for the selected date or visible range, including direct hidden links and approved
embeds. The initial bounded automatic month advance still looks for free times before
offering a waitlist for the final visible empty range; selected dates and manually browsed
months stay in place. Waitlists use the event's default meeting length; invitees choosing another length
must switch to that default to join. The delivery layer sends encrypted verification intents and availability
candidates through the shared mail pipeline, without a new schema migration.

`waitlist_entries` keeps fixed UTC preference windows and consent, with pending verification,
active, notified, booked, expired and removed states. Deadlines never renew: verification
lasts thirty elapsed minutes, pending enrollment at most twenty-four hours, and enrollment
at most thirty days or the preference end. Purpose-bound capability digests authorize
verification or self-management. A valid management capability can attribute a new ordinary
booking only when event, verified mailbox and complete preferred interval match. The
existing host locks, availability checks and exclusion constraint decide booking success;
replays do not attach an entry and losing a booking race leaves it waiting.

Admission checks durable rolling mailbox, IP and event limits under database locks, as
well as the fifteen-minute resend cooldown and one hundred pending/live entries per event.
`waitlist_verification_requests` has no cascading foreign keys and retains purpose-separated
mailbox/IP HMACs for two elapsed days. IPv4-mapped socket addresses normalize to IPv4;
IPv6 zone identifiers are stripped and other IPv6 addresses share their /64 bucket. The
service accepts only an IP resolved by a trusted transport and stores no raw address.
Every well-formed, publicly eligible join or resend records an IP/event request before
mailbox-state decisions, including duplicates, cooldowns and suppressed admissions.
A request-only row uses a separate per-request digest in the required email-hash column;
only an admitted verification generation replaces that digest with the mailbox HMAC.
Mailbox budgets therefore count generations, while IP and event budgets count requests
regardless of whether the address is listed. IP refusals remain 429; event refusals remain
the same generic 202. The shared ledger survives removal and retains no readable contacts.
Admission holds the accounting-key fence, then an event share lock compatible with ordinary
bookings. Availability computation precedes the instance-wide admission fence, which covers
only expiry, rolling budgets, duplicate/capacity checks and the bounded write. Database time
is sampled again after waiting for that fence; no host advisory lock is taken.

Transactional triggers append `waitlist_scan_signals` for shared-host changes to bookings,
event rules, schedules, overrides, profiles and cached calendars. Signals have independent
UUIDs, no event foreign key and no unique event key. An indexed, non-locking existence
check limits writes to events with unexpired verified active/notified entries; the
periodic sweep covers newly verified entries. Availability writers never update
shared waitlist work rows, so unrelated bookings sharing hosts do not wait on one another
because of waitlist signaling. Signals commit or roll back with the availability mutation.
Startup/minute maintenance scans committed ordinary availability only, in bounded seven-day
pages with persisted cursors and fair event scheduling. A short event share → work lock
snapshot consumes at most 1,000 committed signals by exact ID and advances the work's exact
`bigint` generation. It never uses UUID order as a commit watermark: older IDs that commit
later remain pending. Scans compute availability outside row locks, then publish under a
short accounting-key → event share → work → entry lock sequence, revalidating the generation,
page cursor and newly committed signals and rereading live recipients. Each signal stores
its writer's top-level `xid8`; a PostgreSQL transaction snapshot captured before computation
distinguishes existing backlog from transactions that commit during computation, including
older UUIDs and savepoint writes. Existing backlog never prevents an event's computation;
consumption remains bounded to 1,000 per pass. Publication acquires no host, booking or
calendar locks. A newly committed signal visible at publication validation discards the
computed page; signals that commit later remain pending for the next scan. Cleanup removes
signals for deleted or disabled events and events without live recipients in separate
1,000-row transactions until caught up or its five-second run budget expires. Each batch's
statement timeout uses the remaining budget; completed batches remain committed.
Every eligible verified recipient in a pass enters the same cohort. Each immutable candidate
contains at most three full matching UTC intervals and expires at the earliest of discovery
plus twenty-four hours, entry expiry or the first slot's current notice cutoff. There is no
hold, rank or intentional delay awaiting another invitee. Senders recheck current
lifecycle, exact availability and the shared ordinary-recipient mail budget before sending;
candidate creation is not evidence of SMTP acceptance or inbox delivery.

Independent `waitlist_slot_tombstones` uniquely identify event, mailbox HMAC and exact UTC
start/end. They survive removal, rejoining, event deletion and delivery cleanup until slot
end plus forty-eight elapsed hours, at most about sixty-four days for newly admitted windows.
Self-removal and event disable/identity changes immediately erase contacts and revoke work;
hourly bounded cleanup erases booked/expired contact data, expires old entries and removes
minimal terminal metadata within seven days. Rotating the accounting secret retires and
erases old entries/ciphertext/capabilities before admission or workers resume. Old secrets
are not retained; mailbox limits and slot dedupe cannot span that explicit key-rotation
exception. Existing global send accounting remains unchanged.

Waitlist settings contain only `enabled`, default false. Omitted PATCH settings preserve
the current value; the editor sends them only when they differ from its session baseline.
Protected event-type configuration includes the setting. The narrow settings endpoint and
paginated entries list require the personal owner or a current team owner/admin.
Ordinary team configuration visibility does not authorize access to contacts. The public
form discloses before consent that authorized managers can see the submitted email, name
and requested period. This approved contact-list scope supersedes the design contract’s
earlier aggregate-only host-view proposal; it adds no export or manual enrollment. Entries
include retained email/name, state, UTC preference window and display zone, creation time
and the latest SMTP-accepted notification time. Cleanup preserves exactly the newest
non-null acceptance receipt per retained entry; older receipts still use bounded cleanup,
and the final receipt cascades with the entry at terminal state plus seven elapsed days.
A null value means no retained accepted notice. Pending and active entries show
“Not notified yet”; notified or booked entries with no retained timestamp show the
unknown-time wording because historical receipts may have been purged. Cleared contact data stays null; no token,
digest or encrypted payload is returned. Host removal is idempotent for retained entries,
immediately erases live contacts and pending work, and sends no removal email. Existing
retention and terminal-state cleanup remain unchanged. API keys need `read` or `full` for
settings/list reads and `full` for settings/removal writes; public join and explicit resend
retain the same admission limits through REST, MCP and CLI.

The populated 0049 predecessor test verifies historical contacts, management hashes,
reschedule chains, calendars, conferences, mail ledgers and retained jobs byte-for-byte,
then compares upgraded/fresh schemas and a no-op rerun. See the
[0051 rollout note](../packages/db/migrations/0051_waitlist.md) for the coordinated process
upgrade requirement; additive storage does not make mixed writer/worker versions safe.

## Booking webhooks

Migration 0017 adds organization-owned `webhooks` (bounded subscriptions, active flag and
authenticated encrypted signing secret) and `webhook_deliveries` (immutable minimal event
snapshot plus bounded attempt metadata). The booking transaction captures subscribed
endpoints and queues only delivery IDs. Composite foreign keys keep deliveries in their
endpoint organization; endpoint/booking/organization deletion cascades snapshots. Runtime
locks use endpoint then delivery so deletion, pause and rotation cannot deadlock delivery
through inverse lock order. Details and retention are in [Booking webhooks](https://hourmere.com/docs/webhooks).

Migration 0028 adds safe `interrupted`/`job_missing` error classifications for finite retry
accounting and orphan reconciliation, preserving existing webhook delivery data.

Migration 0034 adds a partial `webhook_deliveries(id)` index for `status = 'pending'`.
It excludes terminal delivery rows from the index and can supply pending IDs in order.
It does not guarantee an index scan or a reconciliation plan without `Sort`, and does not
index pg-boss's retained job history. The migration uses ordinary `CREATE INDEX`, not
`CREATE INDEX CONCURRENTLY`: creation can wait for writers and blocks writes to
`webhook_deliveries` while it runs. Allow for that lock when upgrading a busy installation.
Retention has no status filter and uses the existing `created_at` index; delivery metadata
pages use the existing `(webhook_id,id)` index in reverse order.


Migration 0068 adds first-class Slack destinations to `webhooks`: `destination_kind`
(default `webhook`), `url_ciphertext`, optional `event_type_id` and `pause_reason`.
`pause_reason` is `url_rejected` from Slack's 404/410 until the URL is replaced or the
destination is enabled (a check constraint requires an inactive Slack row); pausing an
active destination and generic webhooks keep it null. A partial unique index
allows one Slack destination per organization without consuming the ten signed-webhook
slots. The URL field contains only a masked Slack address; AES-256-GCM ciphertext uses
the webhook encryption key with organization, destination ID and URL-specific associated
data. A composite event-type foreign key enforces the same organization; hard deletion of
a filtered event type removes the destination rather than broadening its subscription.
Generic webhook management excludes Slack rows.

Slack captures immutable Block Kit payloads in the booking transaction and reuses bounded
outbox retries and terminal state tracking. The minimum projection contains booking ID,
event kind, event-type title, zoned start/end with UTC offset, status and an authenticated
admin booking link; personal payloads add the invitee name. Team-wide payloads exclude
free-text booking titles, answers, attendee details, meeting links and reschedule-chain identifiers. Slack accepts the
five lifecycle and reschedule-request events only: migration 0070's attendee no-show event is
for signed webhooks, and capture never queues it for Slack. Both capture and delivery check the
current event-type filter. Synthetic test deliveries have a nullable booking ID and bypass
only that filter; active/subscribed checks still apply. One pending test per destination
is enforced under its row lock. A test delivery stores its own event ID in `request_id`:
with migration 0064's `NULLS NOT DISTINCT` key on `(webhook_id, booking_id, event_type,
request_id)`, a null value would make every later sample a duplicate of the first. On rows
with a null `booking_id`, `request_id` is this sample marker, not a reschedule-request ID. Slack requires `WEBHOOKS_ENABLED=true` and
`WEBHOOK_ENCRYPTION_KEY`. Stop all old web and worker
processes before migration and restart every role on the new code. See [Slack notifications](slack.md).

## Independent conference identities

`conference_connections` stores Zoom identities separately from `auth.account` and
`calendar_connections`. It has a stable UUID, owner FK, provider/external-identity uniqueness,
optional bounded display metadata, minimal scopes, a safe status/error and purpose-bound
AES-256-GCM ciphertext. A durable `refreshing` operation holds no reusable credentials.
Browser and worker connection operations use short transactions that lock the owner,
then the session (for browser operations), then the connection/state. State claims and
token retirement commit before bounded provider I/O, which runs without row locks.
Migration 0035 adds `conference_token_operations`: an owner-keyed, expiring operation UUID
lease that cascades on user deletion without changing existing connections or OAuth states.
OAuth only learns the external identity after exchange, so token-changing operations
serialize by owner. Claims and consumption use short owner-first transactions; no lock or
pool connection spans provider I/O. Token-changing provider calls have a hard deadline
(15 seconds by default), with a lease of at least one minute measured by database time.
Completion checks
the live lease ID and expiry under a short share lock before storing credentials. Release
compares the operation ID; a stale operation cannot release a successor. Crash recovery
can take over an expired lease. Callbacks acquire the lease before claiming OAuth state;
an occupied lease returns `busy` immediately without inspecting or consuming state or exchanging
the code. This includes a replay of an already claimed or completed attempt: `busy` does not
prove that the attempt is valid or reusable. After the lease is released, that replay returns
`invalid_state` without a second exchange. See [Zoom connections](https://hourmere.com/docs/zoom-connections#callback-replay-and-busy)
for the distinction from a still-unclaimed retry.
Explicit refresh returns the legacy `zoom_refresh_in_progress` code with the neutral
`errorAlias: "zoom_operation_busy"` and a busy/retry message; workers retry while the lease
is occupied. The legacy code is deprecated but remains unchanged for all of `/api/v1`;
the alias is additive, and removing or renaming the old code requires a new API version.
A newly acquired valid lease that finds `refreshing`
proves the old rotation was abandoned: worker and explicit refresh retire it to
`needs_reauth`, clearing the old operation and credentials so the user can reconnect.
Disconnect/logout/deletion do not wait for token operations. Completion rechecks the session
and claimed state or refresh operation; OAuth additionally checks current acting-organization
membership at connection start, before exchange and before persistence. Workers check
credential revisions around identity/meeting I/O and operation/revision around rotation.
Their best-effort credential retirement skips writes while another token operation owns
a live lease.
OAuth expiry is validated with atomic single-use consumption before exchange, without
rejecting a successful exchange solely because time elapsed. Expiry cleanup retains
claimed attempts. A wrong-mode identity exchange retires an existing meetings grant even
if unrelated metadata changed. Logout or session expiry retires a still-owned browser
refresh claim to `needs_reauth`, clears its operation and credentials, and prevents new
automatic bookings. If observed before provider I/O, it skips the rotation entirely.
Transient refresh transport failures retry at most three times with backoff; if they remain
transient, the operation restores the original encrypted grant as active for later recovery.
Other token rejections or malformed successful responses also preserve the prior grant;
only an explicit invalid grant retires it. Identity/scope mismatches remain fail closed.
Public booking eligibility accepts a pinned meeting-mode connection during `refreshing`,
while selecting a new automatic configuration still requires `active`.

`conference_oauth_states` stores only a state digest plus owner/session, optional expected
connection, encrypted PKCE verifier, single-use claim and ten-minute expiry. A durable claim
clears the verifier. Disconnect invalidates all pending owner attempts and clears credentials;
it retains identity metadata and the stable connection ID. At most five identities can be
connected at once (including reauthorization and incomplete refresh states). Disconnected
tombstones release capacity and are excluded from the default metadata list; reauthorizing the same identity reuses its stable ID. A BEFORE DELETE owner
trigger locks all owner sessions in ID order before clearing connections/states, matching
session logout’s cascade order. It clears credentials, OAuth attempts, scopes, operation, external ID, email and display name before retaining an
unowned secret-free tombstone. Equal email addresses never establish ownership. Identity-only connections create no meeting intents or calendar rows. Explicit meeting mode
uses a separate exact scope set and mode-bound v2 ciphertext; old identity v1 ciphertext remains
usable. New OAuth attempts bind mode and expected connection under v2; retained old v1 attempts
require a restart without code exchange. See the Zoom setup guide for the
explicit local-disconnect versus provider-wide revocation distinction.

The optional signed Zoom event endpoint handles `app_deauthorized` using the globally
unique stored Zoom `external_user_id`. The notification's `account_id` is validated but
is not persisted or used to widen deletion to other users in that Zoom account. Cleanup
shares local disconnect's credential, scope, operation and pending-attempt retirement, and
additionally clears the connection's external ID, email and display name. The secret-free
disconnected row remains for existing references. Like local disconnect, automatic Zoom
event types retain activation and configuration, with the saved account unavailable in the
dashboard editor. Migration 0033 adds nullable `authorized_at`, set on every successful OAuth
connection/reconsent and unchanged by refresh. Removal events older than that time are ignored
under the owner lock, preventing delayed deliveries from retiring a new grant. Existing rows
are not rewritten; a null value uses `created_at` as the only known lower bound.
Existing booking and conference records follow their existing retention policy; cleanup
does not contact Zoom or store the event payload. Repeated notifications and unknown users
make no change. See [automatic Zoom](https://hourmere.com/docs/automatic-zoom#app-removal-and-event-endpoint).

## Automatic conferences

`booking_conferences` retains one provider intent per opted-in root booking, pinned organizer/destination IDs, desired/applied revision, request identity, create ambiguity, bounded state/error and recoverable operation lease. It intentionally survives calendar/connection deletion. `booking_conference_notifications` is the durable release outbox for final linked messages and no-ICS failure notices; recipient deduplication remains in `booking_notifications`. `calendars.supports_google_meet` is cached capability, default false. `provider` defaults to `google_meet` for old roots. New Zoom roots have independent immutable
`zoom_connection_id`/`zoom_user_id` pins, a validated `zoom_meeting_id`, and no Google
calendar/connection/event identity. `event_types.zoom_connection_id` is private host-selected
configuration; it is not exposed in public catalogs. `booking_conference_mirrors` preserves
ordinary calendar targets and unknown-import claims; a single-host Zoom organizer may have
one such optional copy. The join URL is stored only in the current ready protected booking
location. See [Automatic Google Meet](https://hourmere.com/docs/automatic-google-meet) and
[Automatic Zoom for one host](https://hourmere.com/docs/automatic-zoom).

Protected booking reads hydrate every booking's status, cancellation time/reason, resolved
location and optional conference state from one booking-driven LEFT JOIN snapshot, including
the pinned organizer's availability. Authenticated host reads join only that caller's ordinary
calendar copy and derive conference retry ownership from the same snapshot; public/manage
reads neither join copies nor expose host retry controls. If a concurrent reschedule moves
the conference pointer to a successor after the initial lookup, the predecessor still
hydrates as cancelled without a conference or join link. The same applies when the successor
has already been cancelled.
Lifecycle fields still use the existing hydration query without a transaction-held
connection or booking row locks. A preceding bulk import-policy lookup covers the immutable
source policy for the complete selected booking list; no policy query follows lifecycle
hydration or changes its final snapshot boundary. Manage-token resolution and list membership still precede
hydration; a later read follows a moved token according to the existing token rules.

Migration 0032 indexes the mutable `booking_conferences.booking_id` pointer used by
booking reads and cancellation. The index is non-unique: the existing schema guarantees
one intent per `root_booking_id`, but does not constrain distinct roots' current pointers
to be unique. The migration preserves those existing rows without adding a new invariant.

Migration 0024 adds a persisted attempt count, random bounded lease, safe error class and
exhausted timestamp to each conference notification. Existing due times and delivery flags
are preserved. Attempt claims commit before SMTP; lease/attempt comparison protects completion
and the row has a finite initial-attempt-plus-twelve-retry budget across cron executions.
See [Notifications and background jobs](https://hourmere.com/docs/notifications#conference-outbox-delivery-budget) for diagnostics,
legacy-row backfill and the remaining SMTP acceptance/failed-commit duplicate window.

Migration 0026 adds `skipped_at` as a distinct terminal outcome for obsolete conference
notices. Cancellation, replacement or a closed delivery gate records a skip with
`delivered=false`; pending conference reconciliation remains eligible for a later attempt.
The migration preserves existing delivery history and does not update old rows.

Migration 0036 adds nullable `booking_conferences.conference_patch_request_id`. It records
the acknowledged Meet conference PATCH request identity separately from the import claim.
Existing rows remain null and keep their original event/request identity, enabling a
same-ID PATCH for old import-created pending requests. A lost PATCH response reuses the
same persisted request ID; acknowledged pending requests only poll.

Migration 0037 extends `booking_conferences.error_code`'s CHECK constraint with
`conference_pending_timeout` for an exhausted pending-conference polling budget. Existing
error codes and terminal state are preserved without reclassification or requeueing. It
also drops the unused `retry_conference` column: no reader used that write-only flag, and
durable `request_id`/`conference_patch_request_id` already distinguish a new conference
request from safe polling. The public retry endpoint and MCP `retry_conference` tool are
unaffected. A host timeout retry keeps those identities; a known provider
`conference_failed` can rotate the UUID on the same event.
Old web/all/worker processes must stop before applying this migration because they still
write the removed flag; restart every role with the upgraded code.

## Round-robin assignment state

Migration 0020 adds `round_robin_state` (event primary key, monotonic `bigint` sequence,
explicit enabled flag), retained host `last_assigned_sequence`, and immutable booking
`hosts_use_default_schedule`. Activation and mode changes preserve sequence history;
new successful bookings update fairness with the booking/outbox transaction. No legacy
configuration is activated by migration. See [round-robin scheduling](https://hourmere.com/docs/round-robin-scheduling).

## Booking calendar email identity

Migration0038 adds `bookings.ical_version` and nullable organizer-name/email snapshots.
Predecessor rows are v1, with the best surviving host/conference organizer backfilled while
preserving existing timestamps; newly inserted rows default to v2. Notification workers
always read the reschedule-chain root's fields. A new root atomically pins its configured
sending mailbox before its first SMTP invitation; later versions reuse that identity.
See [calendar invitations](https://hourmere.com/docs/notifications#calendar-invitations) for the coordinated upgrade,
legacy compatibility, recipient policy and reply limitations.

## Host requests for another time

Migration 0064 adds `booking_reschedule_requests`. A host of a confirmed future booking
may ask its booker to choose another time, optionally including a plain-text note.
Imported read-only records and group-seat bookings refuse this action. Authorization is
identical to host rescheduling; being a team administrator alone does not grant it.
Booking responses expose optional `isGroupSeat: true` for group-seat bookings and omit
it otherwise. REST, MCP and CLI clients can use the flag to skip unsupported requests;
its absence does not bypass the other booking and authorization rules.

Pending reschedule is an overlay (`Booking.pendingReschedule`), not a new booking status:
the booking remains `confirmed`, its original time remains blocked, and calendar entries,
conferences and reminders remain in force. Releasing the slot immediately would silently
remove an agreed meeting before the invitee accepts a replacement. A request therefore
never promises that any alternative slot is reserved.

`RESCHEDULE_REQUEST_TIMEOUT_HOURS = 48` bounds a request's life to the earlier of 48 elapsed
hours after creation and the original booking's start. Elapsed time makes the timeout
unambiguous across DST changes. Expiry leaves the original booking intact and queues a host
notice; it never cancels or moves the booking. Workers may deliver the notice later. A
second request replaces the first; superseded jobs cannot send a new obsolete invitation.

The invitee uses the ordinary private management link to select an available time or
cancel. Picks use the existing transactional reschedule path and all its current rules:
notice, window, limits, buffers, calendar conflicts and required collective/round-robin
hosts. Calendar writeback, conferences, reminders and host pick confirmations consequently
follow the same path as any invitee reschedule. Requests add no exception to reschedule
limits. A host can still cancel or move the original booking while a request is pending.

Request rows record `pending`, `replaced`, `picked`, `cancelled` or `expired`; terminal
states retain their identity for replay. Requests serialize with booking mutations. A
request's UUID idempotency key is scoped to its booking: the same normalized input returns
the current booking without another email; changed input fails with
`idempotency_key_reused`. Replaying an old key never replaces a newer request.
The optional `rescheduleRequestId` on managed pick/cancel identifies the displayed request.
The web interface submits it. A matching pick replay returns its saved successor without a
new token; a matching cancellation replay returns the cancelled booking. A replaced,
expired or differently answered request fails with `reschedule_request_changed`. Keep the
existing private email link when replay returns `manageToken: null`.

Notes follow follow-up host-note write sanitization: CRLF becomes LF, bidi embedding/isolate
controls are removed, other controls (including tabs) are rejected, and the result must be
well-formed Unicode of at most 2000 UTF-16 code units. The sender defensively normalizes
stored text and HTML-escapes it. Notes appear only in the request email body, never its
subject, headers or webhook payload. Request mail uses existing invitee mail budgets and
bounded retry/deduplication rules. The follow-up-note feature switch does not disable this
separate request capability. Self-hosting includes the complete feature.

Webhook subscriptions add `booking.reschedule_requested` and
`booking.reschedule_request_expired`. Their payload retains `status: confirmed` and includes
`requestId`; delivery uniqueness includes this identity so replacing a request can produce
another event. Existing subscriptions and retained deliveries are preserved by migration.
Deploy web and worker code together after applying the migration; old writers use the
previous delivery uniqueness constraint.

## Pending-payment foundation

Migration `0065_payment_holds.sql` adds `pending_payment` and `expired` booking states,
nullable `payment_hold_expires_at`, `payment_reference`, `payment_confirmed_at`,
`payment_idempotency_key`, `payment_pii_erased_at`, and a default-false
`payment_refund_required` marker. Existing bookings retain their state and data. The
PaymentIntent reference is unique when present; credentials and card data are never stored.
An immutable 30-minute deadline bounds the hold. Expiry releases host occupancy atomically;
confirmation after the deadline records refund intent without reviving the booking.
The transition guard prevents changing retained deadlines/references or resurrecting terminal
holds. Group seats and imported bookings cannot carry payment holds. See the
[paid-booking design](payments.md) for the internal-only rollout boundary, future refund
ledger/retention and operator responsibilities. Stop old app and worker processes before
migration and restart all roles together.

Paid hold confirmation records an immutable `payment_confirmed_at` timestamp through a database
trigger. Booking lists, details and activity include hold-backed rows only after this marker
is present, including paid bookings later cancelled. Unconfirmed terminal holds remain hidden.
Payment hold retry keys use a separate `payment_idempotency_key` column and organization-scoped
unique index, so they cannot collide with ordinary booking idempotency keys.

## Private attendee no-show markers

Migration 0070 adds nullable `booking_attendees.no_show_marked_at` and
`no_show_marked_by` as a paired current-state marker. Existing attendees remain unmarked.
Attribution is the acting account UUID, retained as history rather than a cascading account
foreign key. Unmarking clears both fields. Booking/attendee deletion retains its existing
retention behavior. No invitee projection includes this metadata.

Actual booking hosts may change each attendee independently. Current team owners/admins
may manage bookings they do not host only through a browser session; API keys of any scope
and MCP OAuth retain host-only read and write access. Changes are allowed strictly after
the scheduled start, never on cancelled or imported read-only bookings.
Payment holds follow host booking reads: pending, expired and unpaid-cancelled holds return
`booking_not_found`; confirmed paid bookings stay readable but refuse changes with
`paid_booking_management_unavailable`, as host cancellation and rescheduling do.
Collective hosts share the attendee state; round-robin authority belongs to the assigned
host, not every pool member. Serialized changes preserve idempotent replay attribution.
Rescheduling creates fresh attendee rows; cancellation retains historical marks.
Follow-ups and notifications are unaffected. See [no-shows](https://hourmere.com/docs/no-shows).

The migration only widens the webhook subscription and delivery event checks to add
`booking.attendee_no_show_changed`. Migration 0064's unique delivery key
`(webhook_id, booking_id, event_type, request_id)` with NULLs equal stays unchanged, and so
does capture's `ON CONFLICT` target. Attendance deliveries reuse `request_id` (a plain
`uuid` without a foreign key) as a per-change receipt identity: capture stores the change's
fresh event ID there, in the transaction that changes the marker. Every transition therefore
gets its own delivery, while lifecycle receipts (NULL request) and reschedule-request receipts
(the request's ID) deduplicate exactly as before. The stored value is only a receipt key; it
does not identify a reschedule request and attendance payloads never include
`data.requestId`. Existing subscription arrays and delivery snapshots are preserved. The
migration is safe to apply while the previous version runs: old code writes only the five
older events and keeps its arbiter. Apply it before starting the new version.

## Group slots and independent seats

A group event is a single-host event with `booking_mode = 'group'` and a capacity
of 2–100. A `group_slots` row owns one exact UTC interval, its pinned host, capacity,
location, buffers, calendar destination and notification policy. Each seat is a separate
`bookings` row with `group_slot_id`, one booker and private answers, management capability,
idempotency scope and reschedule chain. Guests and multiple-seat purchases are unsupported.
Group booking is an internal service capability. Application configuration, public
enablement, editor controls and REST/MCP/CLI group configuration are not yet available.

`booking_hosts` has a surrogate primary key and exactly one parent: an ordinary
`booking_id` or a `group_slot_id`. A group slot has one exclusion-bearing host row,
regardless of enrollment. `resolvedBookingHosts` expands this host relation when reading
seat bookings, including cancelled history; it does not grant permission. Host and team
reads retain organization/current-membership checks. Managed reads include only the
selected seat and permitted host details, never sibling seats or their answers.

`bookings.group_booker_key` stores the normalized trimmed, lowercase booker mailbox.
The partial unique index permits only one confirmed seat per mailbox per slot. It is
internal, is not an authentication credential and must not be returned as a public field.
Database triggers serialize capacity updates and enforce one matching booker and the
surviving pinned host at commit. `group_slots_open_tuple` allows only one open generation
for the exact organization, original event, host and start/end tuple. Cancelling the last
seat retires the generation and frees host occupancy; a later booking may create a new
generation. Explicit host cancellation retains its terminal tombstone.

Daily, weekly and monthly event limits count one occupied slot, regardless of its seat
count. Joining an already occupied slot does not consume another limit unit. Different
meeting lengths share these limits. Every seat in a slot uses that slot's one shared
location option and immutable logistics snapshot; seats cannot select different locations.
Changes to the event location, default location option, assigned schedule or selected Zoom
connection apply to new occurrences. Existing open occurrences continue accepting seats
with their original logistics; their already reserved interval is not recalculated against
the edited schedule. Later host time-off overrides, external-calendar busy blocks and
calendar-sync staleness are not rechecked for additional seats or moves into that occurrence.
To stop admission after such a change, the host must cancel the occurrence. New occurrences
still check current schedules, time off, calendar conflicts and sync freshness. New seats
and moves into existing occurrences inherit the shared location and option.
Current event activation, host identity, allowed duration, minimum notice and booking window
still apply (the window uses the occurrence's snapshotted host time zone), and automatic
conferences still require their pinned resources to remain usable. Retiring the last seat
allows a later generation to use current settings.

Full occurrences return the same `slot_taken` / `group_slot_full` error for existing and
unknown mailboxes before checking mailbox duplication. An exact authorized idempotent replay
still returns its original seat without consuming capacity or sending another notification.
For occurrences with spare capacity, duplicate-mailbox rejection is not a non-enumeration
guarantee: a different mailbox can create a real booking and trigger its notifications.
A later failure of the pinned Zoom resource can also return a different error to a new
mailbox while rolling back its tentative seat. Snapshot location-option mismatches are
checked before mailbox duplication and return the same error to both callers.

Moving one seat cancels its predecessor and creates a successor in the same transaction,
so capacity is released/taken atomically and surviving source seats retain their resources.

`group_booking_move_receipts` records scoped authority/fingerprint digests and source/result
seat and slot identities, including no-op moves. `group_slot_cancel_receipts` records scoped
whole-slot cancellation results. Neither table stores raw capabilities or attendee rosters.
A request key grants no authority: services revalidate the caller before returning a receipt.
Matching replay returns the original result with its current lifecycle and no new seat,
notification or recovered raw manage token.

### Group communications contract

Lifecycle confirmations, reschedules and cancellations are per seat and recipient. Host
signup/exit notices may also be per seat; resource cleanup must not send another set of
seat cancellations. Every invitee message and ICS contains only that seat's booker and
permitted organizer identity, never sibling names, mailboxes, answers or capabilities.
The invitee calendar UID follows its own seat chain through moves and cancellations.
Webhooks retain the existing minimal per-seat immutable whitelist, without contacts,
answers, management links or provider identities. Activity counts remain per seat: two
seats are two creations, and one move is one reschedule without a second cancellation.

The host has one private calendar event per slot with safe title, time and seat count;
it has no provider attendee list or invitee data. With a pinned provider destination, host lifecycle
mail does not attach another calendar invitation, including while that provider copy is
pending or needs repair; failure does not create a second fallback calendar item. Otherwise host ICS uses the slot UID
and monotonically increasing slot revision, never a seat UID. Final exit cancels only
that generation's host item; a non-final exit preserves the shared event.

Invitee reminder/follow-up policy is snapshotted per seat root and inherited by a successor.
Host reminder/follow-up policy is snapshotted when the first seat materializes the slot,
then scheduled once per slot, stable rule and host, using separate slot receipts and
leases. Later seats or policy edits cannot replace it. Host recipients are excluded from
per-seat scheduled fan-out. Retirement invalidates slot scheduled work; cancellation of
one seat invalidates only that seat's work. Existing mail budgets and finite retries apply.
Count-only updates cannot release invitations again or close a ready conference gate.
A shared conference link cannot selectively revoke access already copied by an attendee,
and provider participant lists/chat may reveal people during the meeting.

`group_slot_host_messages` owns scheduled host reminders/follow-ups and a coalesced host
calendar update per slot. Its bounded attempt count, random claim and expiring lease are
independent of all seat bookings. `group_slot_host_mail_receipts` deduplicates each message
revision and records terminal suppression under the existing instance mail budget. The
minute dispatcher recovers pending and expired claims directly from durable due rows.
It rechecks slot lifecycle, host membership and conference readiness after budget waits;
SMTP never holds slot or booking row locks. Host calendar organizer name/mailbox are
pinned on the slot before the first host ICS. A host reminder contains title, time and
current seat count only; follow-ups contain no capabilities, join links or calendar files.

Migration 0061 adds the shared location-option snapshot, slot-owned calendar/conference
resources and host mail tables. `booking_notification_conference_context` is a read-only
UNION view that resolves ordinary booking resources or a seat's shared slot resource for
the existing recipient worker; it never transfers ownership to a seat. Logistics readiness
uses the conference's matching applied revision and ready URL, independently of calendar
count writeback. Count failures therefore cannot revoke a ready URL or resend invitations.

### Operator SMS dispatch foundation

Migration `0069_sms_delivery_limits.sql` adds `sms_deliveries`, an internal ledger,
not a reminder queue. No host or invitee SMS surface exists yet. Each logical job has
one purpose-keyed HMAC-SHA256 key digest, globally unique across organizations. The
transaction takes a database-local advisory fence, checks rolling recipient/hour, recipient/day,
instance/hour and organization/day budgets using database time, and commits a
`dispatching` reservation before HTTP. Failed and uncertain attempts consume budget.
Provider 429 responses move to `rate_limited`, release local budgets, and store a bounded
`retry_not_before` time (1–3600 seconds; missing/invalid Retry-After defaults to 60).
Only those known non-sends may reserve again after that time, under the same fence,
after checking the fingerprint and all budgets; this resets `created_at` to the database
time of the new reservation for budget and retention accounting. A crash before dispatch
can lose a message; a crash after dispatch cannot cause its retry to send twice.

Rows contain only a purpose-keyed HMAC of the normalized destination, a last-two-digit
mask, organization ID, a keyed request fingerprint, provider message ID, status and
timestamps. Neither the body, full phone number nor Twilio credentials are persisted.
Request fingerprints bind destination, body and organization so changed retries fail.
Keep SMS_HASH_KEY stable and backed up: rotation changes job-key hashes and therefore
defeats deduplication, as well as resetting recipient accounting. Key rotation requires
a separate data/key migration.
Organization IDs deliberately have no cascading foreign key: organization deletion
must never reopen a consumed job key.

After 720 elapsed hours (30 days) from the latest reserved attempt, hourly maintenance
(registered even when SMS is disabled) and opportunistic maintenance erase all delivery
details in batches of at most 1,000.
Only the job-key digest, timestamps and `expired` status remain indefinitely. These
small tombstones prevent old job retries from sending after detail retention ends.
A stopped worker delays cleanup; resume it to process the backlog. A retained accepted
record can return its provider ID on retry; failed records return `sms_provider_rejected`,
while dispatching, unknown and expired records return `sms_delivery_unknown`. A rate-limited
record returns `sms_rate_limited` and the remaining delay before its retry-not-before time.
Status callbacks and final delivery receipts are deferred, so
`accepted` means Twilio accepted the request, not that a handset received it.

## Audit events

`audit_events` is the append-only management journal available to every instance.
See [Audit event journal](audit-log.md) for fields, actions, privacy, transaction
boundaries, indexes and future retention. Events are recorded but not yet viewable.
