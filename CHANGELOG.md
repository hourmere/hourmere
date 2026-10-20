# Changelog

User-visible changes to Hourmere are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases use
[Semantic Versioning](https://semver.org/).

Release candidate notes for the first stable release, planned for **2026-11-30**.
This section does not mean that a release or public image has been published. The owner
must approve publication through the [release workflow](https://github.com/hourmere/hourmere/blob/main/docs/releasing.md).

## [Unreleased → 1.0.0]

### Added

- `security.txt` on hourmere.com and www.hourmere.com lists Hourmere's private vulnerability
  reporting channels.
- Self-hosted operators can allow exact private webhook hosts or IP/CIDR and port ranges
  with `WEBHOOK_PRIVATE_TARGETS`, including signed HTTP delivery to same-network n8n/LAN
  receivers. The default remains public HTTPS only; metadata addresses remain forbidden.
  Web and worker must share the setting; Hourmere Cloud must never set it.
- Personal booking pages and direct-link unlisted event types, with configurable duration,
  booking questions, locations, buffers, minimum notice, booking windows and daily limits.
  Working-hours schedules, date overrides and IANA time zones account for daylight saving.
- Team invitations and organization roles; single-host team events, collective meetings
  with two to eight required hosts, and explicitly activated equal-rotation round-robin
  pools with one to eight hosts.
- Invitee and host booking management: create, reschedule, cancel and browse history.
  Invitees manage bookings without an account through private links; host moves preserve
  their existing links. Transactional conflict checks prevent double-booking, and booking
  creation supports idempotent retries.
- Passwordless email-link sign-in, optional Google and Microsoft sign-in, verified-email
  accounts, controlled registration, organization-bound API keys and account settings.
- A versioned REST API with OpenAPI types, remote MCP tools and an API-key command-line
  client for discovering configuration, finding slots and managing bookings. Optional MCP
  OAuth adds explicit organization consent and revocable connected apps.
- Independent Google Calendar connections with selected busy-time synchronization and
  owned-calendar booking writeback. Microsoft Calendar connections support account and
  calendar-list management; Microsoft busy-time synchronization and event writes are not
  implemented.
- The user's own API keys can change their non-credential calendar settings and select
  their own authorized Zoom connection on event types they actually host, subject to the
  same organization permissions as browser sessions. Provider authorization and
  disconnect still require a browser session.
- Explicitly opted-in automatic Google Meet for individual, collective and round-robin
  bookings; automatic Zoom for personal and single-host team bookings. Durable meeting
  state, pinned organizers and safe retries preserve the same meeting through moves and
  cancellations. Zoom identity-only connections remain separate from meeting permission.
- Durable confirmation, reschedule, cancellation and reminder emails with calendar
  invitations; queued sign-in emails; optional signed organization booking webhooks with
  bounded retries; first-party daily booking activity reports without visitor tracking.
- Inline and popup booking widgets with an explicit parent-origin allowlist, plus English
  and Simplified Chinese web interfaces.
- Docker Compose self-hosting with PostgreSQL-backed jobs, optional separate web/worker
  processes, health checks, security headers, request limits and graceful shutdown.

### Deprecated

- The Zoom conflict code `zoom_refresh_in_progress` is deprecated in favor of the additive
  `errorAlias: "zoom_operation_busy"`. The original `error` code remains for all of
  `/api/v1`; it will not be renamed or removed within v1. New clients may use a documented
  alias when present and must retain support for the original code on older servers.

### Fixed

- Unknown `/.well-known/*` paths on application instances return a plain-text 404 instead
  of the web app.
- Email-sent and public booking success screens suggest checking spam or junk and adding
  the sender to contacts, in English and Simplified Chinese.
- Booking confirmations, management pages and calendar invitations explain that calendar
  responses do not cancel a booking. REQUEST emails put invitee guidance beside the
  cancellation links, direct guests to the booker or host, and give hosts a clear Hourmere
  cancellation instruction. Calendar descriptions contain no management secrets; existing
  RSVP and calendar identity fields stay unchanged. Operator docs cover monitored replies
  and forwarding for one fixed host; declines still do not automatically notify hosts.
- Booking emails now use English or Simplified Chinese for each recipient, including
  subjects, bodies, dates and calendar summaries/descriptions. Guests follow the booking
  language; hosts use their profile language. Sign-in emails follow the requesting
  interface language. Calendar-decline footers appear on confirmations and reschedules
  only when a REQUEST invitation is included, and never on cancellations.
- Calendar and conference settings now translate integration errors and provider notices in
  English and Simplified Chinese. Calendar destinations require a profile, and a profile
  lookup failure leaves connected calendars usable with a retry hint. Calendar controls
  show each name once with clearer separation. Private booking links recover a concurrent
  host reschedule with one bounded read and keep the invitee's existing management access.
- Simplified Chinese public booking calendars keep date labels on one line and separate
  today's marker from the date at mobile and desktop widths.
- Booking email invitations align new calendar organizers with the configured sending
  mailbox, distinguish calendar acceptance from booking confirmation, and use calendar MIME
  alternatives with downloadable ICS copies. Hosts with pinned provider copies receive
  ordinary notifications; legacy meeting identities remain stable through updates/cancels.
  Host calendar summaries name the invitee, and an invalid Reply-To no longer blocks delivery.
- Separate-worker setup now uses `scripts/enable-worker.sh` (and
  `scripts/disable-worker.sh` to deselect it), preserving quoted `COMPOSE_FILE` values and
  the proxy overlay. Verify `docker compose config --services | grep -qx worker` and, for
  bundled HTTPS, `docker compose config --services | grep -qx proxy` before recreating a
  separate-worker stack. Ambiguous settings, YAML-style assignments and a leading UTF-8
  BOM are refused without changes; diagnostics explain how to repair old quoted suffixes.
  Appended settings preserve CRLF when the existing file uses it.
- Automatic Google Meet now imports the private calendar copy first and requests its
  conference through a separate conditional PATCH. Retries preserve the event and request
  identity, including recovery of legacy import-created pending requests.
- Exhausted automatic Meet polling reports `conference_pending_timeout`, distinct from
  transport/provider failures, and explains the safe host retry in both interface languages.

### Security

- Calendar, conference, sign-in and webhook credentials use separate protection domains;
  tokens and private booking management links are excluded from public catalogs and
  webhook snapshots. Optional provider integrations retain explicit ownership checks.
- Public booking and invitee-link writes have bounded inputs and per-address rate limits;
  authenticated REST APIs and MCP have bounded inputs and API-key rate limits, with
  per-consent limits for MCP OAuth; origin checks apply to cookie-authenticated writes and
  browser-originated MCP requests; calendar/conference provider authorization requires a
  same-origin session and is rate limited. Session-authenticated REST requests have no
  general rate limit. Optional embedding is disabled until exact origins are configured.
  See [SECURITY.md](https://github.com/hourmere/hourmere/blob/main/SECURITY.md) for reporting
  and supported-version policy.

### Upgrade notes

These notes apply to existing installations of the development source tree. Back up the
full database (`auth`, `public` and `pgboss`), deployment configuration and original secrets
before upgrading. Review [self-hosting recovery guidance](https://github.com/hourmere/hourmere/blob/main/apps/site/src/content/docs/docs/self-hosting.md#back-up-and-restore);
schema downgrade is not automatic. Direct source deployments require Node.js 26.
Hourmere requires PostgreSQL 18+ because migrations use `uuidv7()`; the provided Compose
stack includes PostgreSQL 18.

- **Restart web and worker processes together for localized sign-in mail.** Stop all
  old web/all/worker processes and restart every role with the upgraded code. New sign-in
  outbox payloads include `language`; an old worker rejects that unknown field and
  discards the email instead of delivering it. Updated workers accept additive outbox
  metadata and fall back to English for unsupported languages, but cannot change the
  behavior of an old worker that is still running.
- **Coordinate the calendar-email upgrade.** Stop all old web/all/worker processes before
  applying `0038_booking_ical_identity.sql`, including processes on other hosts, then restart
  every role with the new code. This upgrade does not support rolling deployment.
  Existing roots retain their original host/conference organizer and UID; new roots pin
  the sending mailbox from `MAIL_FROM`. Previously changed/deleted organizer identities
  without a saved snapshot cannot be recovered. Keep `MAIL_FROM` stable for future updates;
  a changed sender is declared with SENT-BY, which some clients ignore. `MAIL_FROM` must be
  one bare mailbox or `Display name <mailbox>` (quote names containing commas); lists,
  groups, comments, quoted local parts and address-literal domains are unsupported and now
  fail startup with a value-free error. Arbitrary ordinary domains and IDN domains work.
  Do not use a Gmail or Google Workspace address, or any address registered as a Google
  account: Gmail may treat it as a Google organizer (unconfirmed). The sending mailbox must
  receive mail, because calendar RSVP replies go to it; a no-reply address that rejects mail
  bounces them.
  Invitee calendar replies are not requested or processed; monitor/forward the sending
  mailbox for unsolicited responses. Human email replies reach the host via Reply-To.
  Calendar declines do not cancel bookings. Some clients show only the calendar card;
  open the original confirmation body to access management links. See
  [calendar invitations](https://github.com/hourmere/hourmere/blob/main/docs/notifications.md#calendar-invitations).
- **Guests require renewed host opt-in.** Migration
  `0015_guest_email_controls.sql` adds `allow_guests=false` to **all existing event types**
  as well as defaulting new types to false. Hosts must re-enable **Allow invitees to add
  guests** where wanted. New bookings with guests otherwise fail with
  `guests_not_allowed`. Existing attendees, their updates and successful booking replays
  are preserved.
- **Keep encryption keys independent and stable.** `CALENDAR_ENCRYPTION_KEY` must differ
  from `WEBHOOK_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`; reused keys now prevent startup.
  Rotating the calendar key makes stored calendar tokens undecryptable: affected accounts
  must reconnect. `CONFERENCE_ENCRYPTION_KEY` must also differ from the auth, calendar and
  webhook keys; changing it makes saved Zoom credentials unreadable. Changing
  `WEBHOOK_ENCRYPTION_KEY` makes stored webhook signing secrets undecryptable; deliveries
  fail with `secret_unavailable`. Back up the original keys rather than replacing them
  during an upgrade. Keep `BETTER_AUTH_SECRET` stable too: it protects sign-in OAuth
  tokens, queued sign-in links and enabled MCP signing keys.
- **Compose now forwards `AUTO_MIGRATE`, defaulting to `true`.** An existing `.env` entry
  of `AUTO_MIGRATE=false` now takes effect in the app and inherited worker. Configuration
  accepts only lowercase `true` or `false`; previously ignored values such as `0`, `no`
  or `False` now fail startup. With `false`, run `npm run db:migrate` against the deployment
  database before starting the new version; it applies application migrations and
  pg-boss's own schema migration. The server still requires database access at startup.
  Connect directly to PostgreSQL: the sign-up check requires preserved `options` startup
  settings (`hourmere.*` and `search_path`), and PgBouncer is unsupported. Use read committed
  or serializable isolation for first-user registration.
- **Move old worker edits to the tracked overlay before pulling.** If you uncommented the
  old worker block, `git pull --ff-only` refuses to overwrite the edited
  `docker-compose.yml`. Run `./scripts/enable-worker.sh` if available. On an older checkout,
  first replace or add the entire `.env` line with
  `COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml'`, or
  `COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'`
  for bundled HTTPS; keep custom overlays inside the quotes. Then restore the tracked
  Compose file and pull. Run `./scripts/enable-worker.sh` and verify
  `docker compose config --services | grep -qx worker` and, for bundled HTTPS,
  `docker compose config --services | grep -qx proxy` succeed before recreating the
  stack. Restoring without selecting the overlay leaves the old worker container orphaned
  on the old image and the app possibly web-only. See the
  [worker upgrade steps](https://github.com/hourmere/hourmere/blob/main/apps/site/src/content/docs/docs/self-hosting.md#upgrade-and-roll-back).
- **Stop every old role before a column drop.** Migration 0037 is the first column drop;
  old app and worker binaries still write its removed `retry_conference` flag. Stop all
  old web/all/worker processes before the new app or a manual migration runs, including
  separately managed workers. Single-container `docker compose up -d --build` already
  stops the old app before starting its replacement; separate workers need an explicit
  stop. Restart every role on the upgraded code. Future removals use two phases: release N
  stops writing the column, and release N+1 drops it. Column drops (with or without the
  `COLUMN` keyword), table drops and column renames require an upgrade-note sidecar,
  checked by the migration policy test. See the labelled single-container and
  separate-worker upgrade sequences in the self-hosting guide.
- **Sign-in ID tokens are discarded.** Migration `0031_discard_sign_in_id_tokens.sql`
  clears existing `auth.account."idToken"` values, and account create/update hooks keep
  them NULL. Other account data is preserved; sign-in access/refresh tokens remain
  encrypted. Calendar connections and MCP grants are independent.
- **Unused Better Auth account endpoints are disabled.** `/api/auth/account-info`,
  `/api/auth/get-access-token`, `/api/auth/refresh-token`, `/api/auth/link-social` and
  `/api/auth/list-accounts` now return HTTP 404, including for signed-in sessions and with
  MCP OAuth enabled. Social sign-in and its callbacks continue to work. Integrations must
  use Hourmere's separate calendar/conference connection flows.
- **MCP OAuth is optional.** `MCP_OAUTH_ENABLED` defaults to `false`; API keys continue
  working. To enable connectors, set it identically on web and worker processes and use
  HTTPS outside loopback development. Grants authorize MCP tools only, not REST account
  or settings access. Connected apps manages revocation. Offline access has an absolute
  30-day consent lifetime; expired connections must reconnect. Workers clean up unused
  dynamic registrations after 24 hours without consent or at least 90 days without use.
- **Registration invitations no longer delegate authority.** Migration
  `0012_invited_signup.sql` lets a pending, unexpired team invitation admit its exact email
  address under `SIGNUP=closed` or `first-user`. If upgrading from before 0012, revoke any
  unwanted pending invitations before upgrading. Migration
  `0027_nontransitive_invited_signup.sql` restricts that exception to invitations whose
  inviter has a currently allowed email domain or is the earliest remaining auth user,
  applying the current domain allowlist to existing invitations too. Creating a team or
  accepting an invitation gives no right to admit further accounts. Existing users can
  still sign in.
  Google/Microsoft sign-in requires verified email; Microsoft registrations need the
  documented verified-email claims or email-link sign-in. Proving a formerly unverified
  address revokes its old API keys, sessions and linked sign-in accounts (migrations
  0004/0005).
- **Web-only deployments need workers for sign-in mail too.** Migration 0014 introduces
  an encrypted, expiring sign-in outbox. Requests queue mail before a worker checks current
  registration eligibility; no running worker means no sign-in or booking mail. Configure
  SMTP before public use, keep web/worker versions and secrets aligned, and allow at least
  35 seconds for container shutdown.
- **Review public addresses and clients.** Signed-in pages are under `/app`; personal
  booking pages remain at `/{handle}/{slug}` and team pages at `/team/{teamSlug}/{slug}`.
  Previously stored reserved handles/team slugs are not rewritten, but their public
  pages are unavailable until renamed. New writes reject reserved names. Invitee secrets
  belong in the URL fragment and `X-Manage-Token` API header. API/MCP validation rejects
  unknown fields and malformed text; clients must follow the current OpenAPI/tool schema.
- **HTTPS enables a one-year HSTS policy by default.** For an HTTPS `PUBLIC_URL` on a DNS
  hostname other than `localhost` or a `.localhost` subdomain, responses send
  `Strict-Transport-Security: max-age=31536000`. IP literals are excluded. Review TLS and
  hostname configuration before upgrading; `HSTS_MAX_AGE=0` clears a previous policy.
- **Team routing needs deliberate activation and original hosts.** Migration 0020 leaves
  legacy round-robin pools inactive; a normal save or `isActive` toggle does not activate
  them. Hosts use current default schedules. Rescheduling preserves original required
  hosts (and the original round-robin winner); a departed, deleted or unverified required
  host prevents moving the booking, while cancellation remains available. Migration 0019
  backfills only host identities still present at upgrade time; previously deleted hosts
  cannot be reconstructed.
- **Automatic meetings remain explicit opt-ins.** `GOOGLE_MEET_ENABLED` and
  `ZOOM_MEETINGS_ENABLED` default to `false`; existing passive Meet/Zoom locations are not
  converted. Migration 0021 initializes `calendars.supports_google_meet=false` for existing
  calendars: refresh the connected account's calendar list before enabling automatic Meet.
  Calendar synchronization may need renewed consent for older list-only Google
  connections, followed by explicit conflict-calendar and write-destination selection.
  Zoom migration 0025 preserves connected identity credentials but rejects unfinished v1
  authorization attempts without redeeming their codes: restart those attempts. Existing
  pre-0023 Meet roots retain their documented legacy organizer behavior; new roots pin
  invitation identity and ordinary calendar-copy targets at creation.
- **Review legacy Meet requests and terminal PATCH errors.** Migration 0036 leaves existing
  conference PATCH markers empty: pending import-created requests receive one automatic
  same-UUID PATCH and a fresh bounded polling budget; failed rows need the pinned host's
  explicit retry. Google may ignore the duplicate UUID. Exhausted pending requests now
  report `conference_pending_timeout`; host retry retains the UUID and polls the known
  event again, without repeating an acknowledged PATCH. A request that stays pending needs
  the [quiesced operator repair](https://github.com/hourmere/hourmere/blob/main/docs/google-calendar.md#automatic-meet-projection)
  before deliberate UUID rotation; no host/CLI force-create path is added. Migration 0037
  adds the timeout classification and drops the unused database `retry_conference` flag;
  the public retry endpoint, MCP tool and CLI command remain available. Existing error
  codes and terminal rows are preserved, not reclassified or requeued.
  Stop old web/all/worker processes before applying 0037: old binaries still write the
  removed column. Resume every role with the upgraded code.
  A Google HTTP 400 from PATCH on a known event, including conference creation, rescheduling
  and cancellation, intentionally becomes terminal `invalid_response` rather than retryable
  `provider_unavailable`: Google's [error guidance](https://developers.google.com/workspace/calendar/api/guides/errors#400_bad_request)
  identifies 400 as a permanent request error. Fix the request/integration before explicit
  retry; the known event is retained and a replacement import is never authorized.
- **Optional integrations and attribution need explicit configuration.** Embedding stays
  disabled until `EMBED_ALLOWED_ORIGINS` lists exact allowed origins. Booking webhooks
  default off (`WEBHOOKS_ENABLED=false`) and do not backfill past booking changes when
  enabled. Public booking and confirmation pages retain Hourmere attribution; set
  `HOSTED_SIGNUP_URL` to the desired hosted sign-up destination (default
  `https://hourmere.com`), separately from the instance's `PUBLIC_URL`.
- **Inspect terminal delivery failures after upgrading.** Conference notification
  migration 0024 gives each row one initial attempt plus twelve retries; old rows preserve
  due times and delivery flags and receive one finite post-upgrade budget. Migration 0026
  distinguishes obsolete notices as skipped, with `delivered=false`. Webhook migration
  0028 supports interrupted/lost-job reconciliation within finite retry accounting.
  Repair the delivery cause before deliberately retrying exhausted work; queued jobs do
  not authorize unlimited sends or replacement meetings. See
  [notification diagnostics](https://github.com/hourmere/hourmere/blob/main/docs/notifications.md#conference-outbox-delivery-budget) and
  [webhook operations](https://github.com/hourmere/hourmere/blob/main/docs/webhooks.md).
