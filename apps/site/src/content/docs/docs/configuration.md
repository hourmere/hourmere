---
title: Configuration reference
description: Environment variables for the Hourmere server, workers and Docker Compose.
---

Server variables below come from `apps/server/src/config.ts`. Empty optional values usually
mean unset; `AUTO_MIGRATE` must be omitted or explicitly `true`/`false`. Direct processes read
their environment; Compose interpolates `.env` into the variables explicitly listed in
`docker-compose.yml`. Adding an arbitrary entry to `.env` does not pass it to a container.
Restart/recreate affected processes after changing configuration.

## Server and database

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | Required | PostgreSQL connection URL. Direct connections must preserve custom startup options; PgBouncer is unsupported. Compose fixes this to `postgres://hourmere@db:5432/hourmere`. |
| `PGPASSWORD` | Unset | PostgreSQL client password when absent from the URL. Compose sets it from `POSTGRES_PASSWORD`; do not percent-encode this separate value. |
| `PORT` | `3000` | Listening port for a direct server. In Compose, `.env` `PORT` changes the host port; the container still listens on `3000`. |
| `PUBLIC_URL` | `http://localhost:<PORT>` | External HTTP(S) origin, with no path/query. Use HTTPS publicly. Compose defaults to `http://localhost:3000` independently of its host port setting. |
| `BETTER_AUTH_SECRET` | Required | At least 32 non-whitespace random characters. Signs sessions and protects sign-in tokens. Changing it signs people out. |
| `AUTO_MIGRATE` | `true` | Apply SQL/job migrations on startup. `false` requires manual migrations first; startup still needs database access. Not forwarded by the default Compose file. |
| `WEB_DIST` | Unset | Built SPA directory. Docker sets `/app/apps/web/dist`; development uses Vite instead. |
| `EMBED_ALLOWED_ORIGINS` | Unset | Up to 32 comma-separated exact HTTPS website origins permitted to embed public booking pages. Empty disables embedding; no wildcards or paths. Loopback HTTP is accepted for local development. |
| `WEBHOOKS_ENABLED` | `false` | Capture new organization booking events for outbound HTTPS webhooks. No backfill; set identically on web and worker. See repository `docs/webhooks.md`. |
| `WEBHOOK_ENCRYPTION_KEY` | Unset | Independent 32-byte base64 key required when webhooks are enabled. Encrypts signing secrets; keep stable and backed up. |
| `MCP_OAUTH_ENABLED` | `false` | Enable MCP OAuth connectors alongside API keys. Requires HTTPS except on loopback; explicit organization approval and revocation at `/app/connected-apps`. No calendar/provider client credentials needed. Set identically on web and worker. |
| `HOURMERE_ROLE` | `all` | `all`: API and workers; `web`: API/queues only; `worker`: jobs and health endpoint only. |

`npm run dev` points the application at Vite (`http://localhost:5173`) and defaults signup to
open only when neither signup setting was supplied. Node 26 runs TypeScript sources
directly. The Docker image sets `NODE_ENV=production`; this is a runtime/library setting,
not a separate Hourmere mode switch.

## Email and registration

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_URL` | Unset | `smtps://user:password@host:465` or `smtp://…:587`; special credential characters must be percent-encoded. Remote SMTP requires TLS/STARTTLS. Without SMTP, emails go to logs. |
| `MAIL_FROM` | Unset | Required with SMTP, for example `Hourmere <bookings@example.com>`. Use a sender your SMTP provider accepts. |
| `SIGNUP` | `first-user` | `first-user`, `closed` or `open`; existing users can always sign in. |
| `SIGNUP_ALLOWED_DOMAINS` | Unset | Comma-separated exact email domains, without `@` or wildcards. These domains may register even with `closed`. List subdomains separately. Invalid with `open`. |

With `first-user`, the first person who signs in can register; after that the domain allowlist
applies. In either restricted mode, a pending, unexpired team invitation also permits its
exact email address to register. With `closed` and no domains, only these invitees can
register. They must still prove ownership of the email address and accept the invitation
separately to join the team. Canceled, expired and accepted invitations grant no registration
exception. New addresses that are not allowed get the same sign-in response, but no email.

## Proxy, security headers and timeouts

| Variable | Default | Meaning |
|---|---|---|
| `TRUSTED_PROXIES` | Unset | Comma-separated proxy IPs/CIDRs trusted to send `X-Forwarded-For`. Use addresses as seen by the app. |
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

## Google Calendar

These three settings are a separate client/key from social sign-in. Configure all three
together or leave them unset. See [Google Calendar](/docs/google-calendar).

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | Unset | Web client for `{PUBLIC_URL}/api/calendar/google/callback`. |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Unset | Matching OAuth client secret. |
| `MICROSOFT_CALENDAR_CLIENT_ID` | Unset | Separate Entra Web client for `{PUBLIC_URL}/api/calendar/microsoft/callback`; supports organizational and personal accounts. |
| `MICROSOFT_CALENDAR_CLIENT_SECRET` | Unset | Matching Entra secret value. Requests delegated `Calendars.ReadBasic` with identity and offline access; lists calendars only, without busy-time synchronization or event writes. |
| `CALENDAR_ENCRYPTION_KEY` | Unset | Exactly 32 random bytes in base64 (`openssl rand -base64 32`). Back up securely; losing/changing it makes saved tokens unreadable. |

Each provider requires its client ID, secret and `CALENDAR_ENCRYPTION_KEY` together. Calendar
connections require HTTPS except on loopback development hosts. Disabled configuration
keeps local connections visible so people can disconnect or stop using their calendars.

## Compose-only settings and overrides

`POSTGRES_PASSWORD` is required by Compose for its PostgreSQL service and is forwarded as
`PGPASSWORD` to the app. It is not a server configuration key. Changing it in `.env` does
not change the password of an already initialized PostgreSQL volume; arrange database
credential changes separately. `PORT` publishes `127.0.0.1:<PORT>:3000`; update `PUBLIC_URL`
if people use a different origin.

To set server options not forwarded by the default file, add explicit service environment
entries in a Compose override, including the worker if you enabled one. For example:

```yaml
# compose.override.yaml
services:
  app:
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
