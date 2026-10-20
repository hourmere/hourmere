---
title: Configuration reference
description: Environment variables for the Hourmere server, workers and Docker Compose.
---

Server variables below come from `apps/server/src/config.ts`. Empty optional values usually
mean unset; `AUTO_MIGRATE` must be omitted or explicitly `true`/`false`. Direct processes read
their environment; Compose interpolates `.env` into the variables explicitly listed in
`docker-compose.yml`. Adding an arbitrary entry to `.env` does not pass it to a container.
Restart/recreate affected processes after changing configuration. The interactive
`scripts/setup.sh` creates a private `.env` from `.env.example` and selects either the
plain Compose file or the optional automatic HTTPS override; see
[self-hosting](/docs/self-hosting) for the complete command sequence.

## Server and database

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | Required | PostgreSQL connection URL. Direct connections must preserve custom startup options; PgBouncer is unsupported. Compose fixes this to `postgres://hourmere@db:5432/hourmere`. |
| `PGPASSWORD` | Unset | PostgreSQL client password when absent from the URL. Compose sets it from `POSTGRES_PASSWORD`; do not percent-encode this separate value. |
| `PORT` | `3000` | Direct-server TCP port (`0`–`65535`). `0` lets the OS choose a port and requires an explicit `PUBLIC_URL`; links always use that configured external origin. In plain Compose, `.env` `PORT` changes the loopback host port; the container still listens on `3000`. The HTTPS override removes that host mapping, so `PORT` has no effect there. |
| `PUBLIC_URL` | `http://localhost:<PORT>` | External HTTP(S) origin, with no path/query. Use HTTPS publicly. Plain Compose defaults to `http://localhost:3000` independently of its host port setting. Bundled Caddy requires an HTTPS hostname origin; setup does not accept a public port or path. |
| `HOSTED_SIGNUP_URL` | `https://hourmere.com` | Hosted service destination for public attribution and confirmation links. Set the hosted sign-up page URL when available; HTTP(S), no credentials, query or fragment. Independent of this instance’s `PUBLIC_URL`; attribution cannot be disabled. |
| `PRIVACY_POLICY_URL` | Unset | This instance operator's privacy policy. Absolute HTTP(S) URL, at most 2048 characters, without credentials, whitespace or control characters. Empty hides the privacy link. |
| `TERMS_URL` | Unset | This instance operator's terms. Same URL rules as `PRIVACY_POLICY_URL`. Empty hides the terms link. |
| `BETTER_AUTH_SECRET` | Required | At least 32 non-whitespace random characters. Signs sessions and protects sign-in tokens. Changing it signs people out. |
| `AUTO_MIGRATE` | `true` | Apply SQL/job migrations on startup. `false` requires manual migrations first; startup still needs database access. Forwarded by the default Compose file with a default of `true`. |
| `WEB_DIST` | Unset | Built SPA directory. Not forwarded by the default Compose file: Docker sets `/app/apps/web/dist`; development uses Vite instead. |
| `EMBED_ALLOWED_ORIGINS` | Unset | Up to 32 comma-separated exact HTTPS website origins permitted to embed public booking pages. Empty disables embedding; no wildcards or paths. Loopback HTTP is accepted for local development. |
| `WEBHOOKS_ENABLED` | `false` | Capture new organization booking events for outbound HTTPS webhooks. No backfill; set identically on web and worker. See repository `docs/webhooks.md`. |
| `WEBHOOK_ENCRYPTION_KEY` | Unset | Independent 32-byte base64 key required when webhooks are enabled. Encrypts signing secrets; keep stable and backed up. |
| `WEBHOOK_PRIVATE_TARGETS` | Unset | Self-hosting only: up to 32 comma-separated exact `hostname:port`, `IPv4[/CIDR]:port[-port]` or `[IPv6[/CIDR]]:port[-port]` entries permitting private HTTP(S) webhook destinations. Empty preserves public HTTPS-only delivery. Set identically on web and worker. |
| `MCP_OAUTH_ENABLED` | `false` | Enable MCP OAuth connectors alongside API keys. Requires HTTPS except on loopback; explicit organization approval and revocation at `/app/connected-apps`. No calendar/provider client credentials needed. Set identically on web and worker. |
| `HOURMERE_ROLE` | `all` | `all`: API and workers; `web`: API/queues only; `worker`: jobs and health endpoint only. The separate-worker Compose overlay fixes the app to `web` and the worker to `worker`, independently of this `.env` setting. |

Policy links belong to the instance's operator and are independent of `PUBLIC_URL` and
`HOSTED_SIGNUP_URL`. Self-hosted instances have no policy URL defaults: configure your own
legal pages before inviting users. Setup preserves the empty example values; Compose forwards
both variables to the app and its inherited worker. The app's public instance endpoint exposes
each configured URL so signed-out, signed-in, booking and MCP consent pages can link to it.

For the Hourmere hosted instance, set these values in its deployment environment and recreate
the app after deployment:

```dotenv
PRIVACY_POLICY_URL=https://hourmere.com/privacy
TERMS_URL=https://hourmere.com/terms
```

These values are explicit deployment settings; the server does not infer policies from a hostname.

`npm run dev` points the application at Vite (`http://localhost:5173`) and defaults signup to
open only when neither signup setting was supplied. Node 26 runs TypeScript sources
directly. The Docker image sets `NODE_ENV=production`; this is a runtime/library setting,
not a separate Hourmere mode switch. When MCP OAuth is enabled, registration, authorization
and token endpoint rate limits are explicitly enabled in every `NODE_ENV`, including when
it is unset. Their per-IP limits are 5, 30 and 20 requests per minute respectively; code
exchanges, refreshes and failed token requests share the token endpoint budget. Provider
429 responses carry `X-Retry-After` seconds; the authorization entrance limiter uses
`Retry-After`.

### Private webhook receivers

**Hourmere Cloud MUST NEVER set `WEBHOOK_PRIVATE_TARGETS`.** There is no hosted execution
mode in this codebase; `HOSTED_SIGNUP_URL` only controls attribution links. Every process
with a nonempty allowlist prints a startup warning without its values. This setting trusts
operators to choose the exact internal services an organization administrator may contact.

For example, `n8n:5678,192.168.1.0/24:8080,[fd12:3456::/64]:8443-8444` permits those exact
hosts/networks and ports. Hostnames use ASCII DNS labels, match case-insensitively and
allow one explicit decimal port; IPs and CIDRs may use an inclusive ascending port range.
Ports are 1–65535 without leading zeros. IPv6 entries require brackets around the address
and optional prefix. CIDRs must name their network base, without host bits. Wildcards,
missing ports, public IPs, unspecified addresses, link-local addresses and metadata endpoints
are rejected at startup, even when webhooks are disabled. Eligible addresses are RFC1918
IPv4, IPv4 loopback, IPv6 unique-local and IPv6 loopback. Always refused are the entire
`169.254.0.0/16` link-local range (including metadata at `169.254.169.254`), Alibaba metadata
at `100.100.100.200`, AWS's reserved service range `fd00:ec2::/32` (including metadata at
`fd00:ec2::254`), GCP metadata at `fd20:ce::254` and OCI metadata at
`fd00:c1::a9fe:a9fe`. CIDRs overlapping those ranges or containing those endpoints are
refused at startup; the same addresses are refused in DNS answers at delivery. IPv4-mapped
IPv6 (`::ffff:0:0/96`) and NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48` are ineligible too.

An allowed destination may use HTTP or HTTPS, a dotless hostname, an IP literal and a
nonstandard port. Matching uses the URL's effective port: omitted HTTP/HTTPS ports mean
80/443, which must still be explicit in the allowlist. Credentials and fragments remain
forbidden. Saving configuration does no DNS lookup or verification request, so acceptance
does not prove that a receiver exists or can be reached. At each delivery attempt all DNS
answers must fit one matching entry: hostname entries require every answer to be eligible
private/loopback space, while IP/CIDR entries require every answer inside that IP/network.
Mixed public/private answers and unions across entries are refused. An exact hostname entry
binds that host and port to private addresses, including after a DNS change; unrelated
ordinary public HTTPS URLs retain their public-only delivery path. The checked address is pinned to the socket;
redirects, proxies from environment variables and cookies remain disabled. HTTP requests
carry the same HMAC signature headers as HTTPS.

Organization administrators can choose any path on an allowed host and port. IP/CIDR
entries also permit every virtual host resolving entirely into the allowed range: the
administrator chooses the URL hostname and therefore the HTTP Host header, so an internal
reverse proxy routing by Host may expose multiple services. Delivery records include the
HTTP status (`httpStatus`, stored as `http_status`), revealing whether an allowed internal
destination responded. This visibility is inherent to allowing that destination.

Recreate web and worker together after changing the setting; pending attempts use the new
policy. See the [same-network n8n example](/docs/self-hosting#private-webhook-receivers)
and repository `docs/webhooks.md` for configuration and delivery behavior.

## Email and registration

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_URL` | Unset | `smtps://user:password@host:465` or `smtp://…:587`; special credential characters must be percent-encoded. Remote SMTP requires TLS/STARTTLS. Without SMTP, emails go to logs. |
| `MAIL_FROM` | Unset | Required with SMTP, for example `Hourmere <bookings@example.com>`. Use a sender your SMTP provider accepts that can also receive calendar replies; see the requirements below. |
| `SIGNUP` | `first-user` | `first-user`, `closed` or `open`; existing users can always sign in. |
| `SIGNUP_ALLOWED_DOMAINS` | Unset | Comma-separated exact email domains, without `@` or wildcards. These domains may register even with `closed`. List subdomains separately. Invalid with `open`. |

`MAIL_FROM` is the organizer for new calendar invitations. Avoid a Gmail or Google Workspace
address, or any other address registered as a Google account: Gmail may treat it as a Google
organizer (unconfirmed). The mailbox must receive mail because calendar RSVP replies go to
it, independently of the email's Reply-To; a no-reply address that rejects mail bounces those
replies. Monitor or forward the mailbox. Declining in a calendar does not cancel an Hourmere
booking; use the confirmation email's cancellation link.

With `first-user`, the first person who signs in can register; after that the domain allowlist
applies. In either restricted mode, a pending, unexpired team invitation also permits its
exact email address to register only when the inviter's current email domain is in
`SIGNUP_ALLOWED_DOMAINS` or the inviter is the first user: the earliest remaining auth user
by creation time, with user id breaking ties. This check uses the current allowlist, including
for existing invitations. An invitee outside those domains cannot admit another address by
creating a team and inviting it; neither team creation nor invitation acceptance delegates
registration authority. With `closed` and no domains, only invitations from the first user
admit new accounts, so an empty instance must first be bootstrapped in `first-user` mode or
by an administrator. Invitees must still prove ownership of the email address and accept the
invitation separately to join the team. Canceled, expired and accepted invitations grant no
registration exception. New addresses that are not allowed get the same sign-in response,
but no email.

## Proxy, security headers and timeouts

| Variable | Default | Meaning |
|---|---|---|
| `TRUSTED_PROXIES` | Unset | Comma-separated proxy IPs/CIDRs trusted to send `X-Forwarded-For`. Use addresses as seen by the app. The Caddy override sets this to the exact `PROXY_IP` regardless of this variable's `.env` value; do not trust the entire Docker/private subnet. |
| `HSTS_MAX_AGE` | `31536000` | Whole non-negative seconds. Sent only for HTTPS `PUBLIC_URL` outside localhost; `0` asks browsers to forget the policy. Configure subdomains/preload at the proxy if desired. |
| `HTTP_HEADERS_TIMEOUT` | `20` | Whole seconds, 1–3600, to receive request headers. Must not exceed request timeout. |
| `HTTP_REQUEST_TIMEOUT` | `60` | Whole seconds, 1–3600, to receive the request. |
| `HTTP_KEEP_ALIVE_TIMEOUT` | `125` | Whole seconds, 1–3600, for an idle HTTP connection. Keep above the proxy's upstream idle timeout. |

## Social sign-in

Set both ID and secret for a provider, or neither. These authorize signing in, separately
from connecting a calendar.

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Unset | Google sign-in client; callback `{PUBLIC_URL}/api/auth/callback/google`. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Unset | Microsoft sign-in client; callback `{PUBLIC_URL}/api/auth/callback/microsoft`. |

Microsoft sign-in requires an email claim the auth library treats as verified. In Entra Token
configuration add optional ID token claims `verified_primary_email` and
`verified_secondary_email`; without verified email, the user gets `EMAIL_NOT_VERIFIED` and
must use an email link. Microsoft calendar synchronization is not implemented yet.

Microsoft sign-in requests only `openid`, `profile` and `email`. It establishes an Hourmere
session; subsequent requests and session renewal use that session without refreshing the
Microsoft access token. No sign-in feature consumes that token after authentication, and
the unused Better Auth token retrieval/refresh endpoints are disabled. Sign-in therefore
does not request `offline_access` or need a Microsoft refresh token. Microsoft requires
[`offline_access` to issue refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-offline_access-scope).
The separate [Microsoft Calendar connection](/docs/microsoft-calendar) requests it with
`Calendars.ReadBasic`, uses the `MICROSOFT_CALENDAR_*` client credentials and stores its own
encrypted tokens; Microsoft sign-in credentials never authorize calendar access.

## Google Calendar

These three settings are a separate client/key from social sign-in. Configure all three
together or leave them unset. See [Google Calendar](/docs/google-calendar).

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | Unset | Web client for `{PUBLIC_URL}/api/calendar/google/callback`. |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Unset | Matching OAuth client secret. |
| `MICROSOFT_CALENDAR_CLIENT_ID` | Unset | Separate Entra Web client for `{PUBLIC_URL}/api/calendar/microsoft/callback`; supports organizational and personal accounts. |
| `MICROSOFT_CALENDAR_CLIENT_SECRET` | Unset | Matching Entra secret value. Requests delegated `Calendars.ReadBasic` with identity and offline access; lists calendars only, without busy-time synchronization or event writes. |
| `CALENDAR_ENCRYPTION_KEY` | Unset | Exactly 32 random bytes in base64 (`openssl rand -base64 32`), independent of authentication and webhook keys. Startup rejects reused keys. Back up securely; losing/changing it makes saved tokens unreadable. |

Each provider requires its client ID, secret and `CALENDAR_ENCRYPTION_KEY` together. Calendar
connections require HTTPS except on loopback development hosts. Disabled configuration
keeps local connections visible so people can disconnect or stop using their calendars.

## Compose-only settings and overrides

These settings control Docker Compose rather than the server configuration loader. Compose
2.24.4 or newer is required for the HTTPS and worker overlays' `!reset` tags. Setup defaults to the
HTTPS path and writes the combined `COMPOSE_FILE`; copying `.env.example` without setup
keeps the plain path.

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | Required | Initializes the PostgreSQL role and becomes the app's `PGPASSWORD`. Changing `.env` does not change an already initialized database role's password. |
| `COMPOSE_FILE` | `docker-compose.yml` | Not forwarded by the default Compose file: consumed by the Compose CLI. Setup writes `docker-compose.yml:docker-compose.proxy.yml` for bundled HTTPS, or `docker-compose.yml` for plain mode. After setup, run `./scripts/enable-worker.sh` to select the separate-worker overlay safely; it preserves the proxy selection and automatically switches the app to `web`. The saved `.env` preserves this choice for backups and upgrades without editing tracked Compose files. |
| `COMPOSE_PROJECT_NAME` | `hourmere` | Not forwarded by the default Compose file: consumed by the Compose CLI to select containers, networks and volumes. Setup persists this name; set it in setup's environment to choose an independent deployment. Keep the original name when migrating an existing installation; persist the new name when restoring to a separate project. |
| `APP_IMAGE` | `hourmere:local` | Local image tag built from this checkout; `pull_policy: never` remains in force. Use a distinct tag for independent deployments on one Docker host. No prebuilt public image is published yet. |
| `PROXY_SUBNET` | `172.30.62.0/28` | Not forwarded by the default Compose file: the HTTPS override uses this dedicated IPv4 ingress subnet. Change it together with `PROXY_IP` and `PROXY_DYNAMIC_RANGE` before starting if it overlaps another network or another deployment. |
| `PROXY_IP` | `172.30.62.2` | Not forwarded by the default Compose file: the HTTPS override assigns Caddy this address and forwards it as the app's `TRUSTED_PROXIES`. Must be a free usable address in `PROXY_SUBNET`, outside `PROXY_DYNAMIC_RANGE`. |
| `PROXY_DYNAMIC_RANGE` | `172.30.62.8/29` | Not forwarded by the default Compose file: the HTTPS override allocates app and one-off app container addresses from this range inside `PROXY_SUBNET`, keeping Caddy's `PROXY_IP` outside it. Workers use only the default network. Change all three network settings together for another subnet/deployment. |

Enable a separate worker from the deployment checkout, then verify that Compose selects it
before recreating the stack:

```sh
unset COMPOSE_FILE
./scripts/enable-worker.sh
docker compose config --services | grep -qx worker
docker compose up -d --build --wait
```

Continue only if verification succeeds. The helper rewrites only `COMPOSE_FILE` in `.env`,
handles quoted/unquoted and `export COMPOSE_FILE=` assignments, keeps mode `600` and
refuses symlinks. Run `./scripts/disable-worker.sh` to deselect it, after removing the
worker container as described in [self-hosting](/docs/self-hosting#switch-back-to-a-single-container).
If editing manually, replace the whole quoted line, for example:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'
```

Keep custom overlays inside the quotes. A shell-exported `COMPOSE_FILE` overrides `.env`;
unset it before using the helper and Compose commands.

Plain mode publishes `127.0.0.1:<PORT>:3000` for your own host proxy or a private local
trial. The HTTPS override removes all app host mappings, publishes TCP 80/443 and UDP 443 on
`proxy`, and keeps PostgreSQL unpublished. Caddy preserves Host and sets forwarded
client/protocol headers; `PUBLIC_URL` must remain the exact external HTTPS origin for
origin checks, redirects and Secure cookies. Its `caddy-data` and `caddy-config` volumes
persist certificates and state across recreations. Keep them in the backup/recovery plan.
Publish only DNS A with the IPv4-only bundled ingress network; see the self-hosting guide
before enabling IPv6/AAAA. Proxy setup requires SMTP for sign-in; private log-mailer tests
are described there too. Setup omits the development `DATABASE_URL` from the generated `.env`.

To disable automatic migrations, set `AUTO_MIGRATE=false` in `.env`; the default Compose
file forwards it to the app and the worker overlay inherits it. The overlay inherits the
base app's configuration, so custom app-only overrides do not also configure the worker.
For example, to disable automatic migrations in a custom override when using a worker,
set both services explicitly:

```yaml
# compose.override.yaml
services:
  app:
    environment:
      AUTO_MIGRATE: 'false'
    stop_grace_period: 35s
  worker:
    environment:
      AUTO_MIGRATE: 'false'
    stop_grace_period: 35s
```

Before disabling automatic migrations, run both migration sets using the same image/config,
for example `docker compose run --rm --no-deps app npm run db:migrate` while PostgreSQL is
already running and application traffic/workers are stopped. Keep the database, signing
secret and calendar key consistent across all roles. Never commit a rendered Compose config
containing secrets.

## Queued sign-in emails

All sign-in link requests use the same durable queue path, including addresses that cannot
register. Workers check the current registration policy, invitations and existing accounts
before delivery. `HOURMERE_ROLE=web` therefore requires a separate worker for sign-in email.
The five-minute token lifetime starts when the link is requested, not when a worker sends
it; expired or consumed links are discarded.

Jobs store only an outbox ID. The outbox encrypts the recipient and fragment URL with a
purpose-specific key derived from `BETTER_AUTH_SECRET`, and binds the ciphertext to its row
and `PUBLIC_URL` origin. Delivery removes the row; a worker cleans expired rows every minute.
Changing the secret or public origin makes pending mail unreadable, so request new links
after such a change. An SMTP acceptance followed by a lost database commit can produce a
duplicate copy of the same one-time link. Configure SMTP before inviting others: the log
mailer still prints delivered links, and anyone reading them can sign in.

## Independent Zoom account connections

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZOOM_CLIENT_ID` | Unset | Confidential user OAuth client; identity scope `user:read:user`, S256 PKCE, fixed `{PUBLIC_URL}/api/conference/zoom/callback`. |
| `ZOOM_CLIENT_SECRET` | Unset | Matching confidential client secret; never expose it to the browser. |
| `CONFERENCE_ENCRYPTION_KEY` | Unset | Independent canonical 32-byte base64 key for conference credentials and OAuth verifiers. Keep stable and back up privately. |
| `ZOOM_MEETINGS_ENABLED` | `false` | Explicit meeting authorization and automatic Zoom for personal/individual single-host events; requires all three settings above. |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Unset | Secret Token from the Zoom app's webhook configuration; independently enables signed `POST {PUBLIC_URL}/api/conference/zoom/events` for endpoint validation and app deauthorization. Empty leaves this endpoint at 404; a configured token must have at least 16 characters. Configured `ZOOM_CLIENT_ID` must match the signed deauthorization payload or the event is ignored, including old-app events after switching apps. Use the same URL for Event Subscriptions and the Deauthorization Notification Endpoint URL; see repository `docs/automatic-zoom.md`. Forwarded by Compose with an empty default. |

The OAuth client ID, client secret and encryption key are required together when either Zoom client field is configured. A key alone
does not enable Zoom. These settings do not enable sign-in, calendar access or meeting
creation by themselves. Automatic creation also requires the flag, explicit meeting permissions
and the actual host's session or own API-key account selection on each opted-in event. Existing passive
Zoom labels remain inert. Collective/round-robin automatic Zoom is unsupported. Existing
committed meeting intents reconcile after disabling the flag. See [Zoom account connections](/docs/zoom-connections/) for the conservative
returned-scope policy, actual-client prerequisites and local-disconnect semantics.

Before inviting real Zoom users, configure the app's public HTTPS event endpoint and matching
Secret Token. This secret is separate from `ZOOM_CLIENT_SECRET` and does not require
`ZOOM_MEETINGS_ENABLED` or OAuth configuration to remain enabled: keep receiving removals
after disabling new connections. Zoom sends production app deauthorization notifications
for public apps; its private/development apps do not trigger those notifications.

## Automatic Google Meet

`GOOGLE_MEET_ENABLED` defaults to `false`. With Google Calendar write configuration it allows explicit individual, collective and round-robin automatic Meet event types. Collective meetings require an explicitly selected eligible organizer; round robin uses its assigned eligible host. Other collective hosts do not need a Google account. Existing committed intents continue reconciling after disabling the flag; no old provider labels are activated. See the repository automatic Google Meet guide for pending/failure and notification semantics.
