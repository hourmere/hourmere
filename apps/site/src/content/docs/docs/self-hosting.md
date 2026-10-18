---
title: Self-hosting
description: Run the current development version of Hourmere with Docker Compose.
---

## Prepare an instance

Use a machine with Git, Docker Engine and Docker Compose. The repository is currently
private; cloning requires repository access. No prebuilt public image is published. Choose
an unused deployment directory and database volume, separate from development or other
instances.

```sh
git clone https://github.com/cobaltmere/hourmere.git
cd hourmere
cp .env.example .env
chmod 600 .env
```

Edit `.env` before starting. Set `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` to separate
random values; `openssl rand -base64 32` can generate each value. Use `PUBLIC_URL=http://localhost:3000`
for a local trial, or the exact HTTPS origin people will open, such as
`https://meet.example.com`. A path prefix is not supported. Keep secrets out of Git.

For an internet-facing instance, also set `SMTP_URL` and `MAIL_FROM` before starting:

```dotenv
PUBLIC_URL=https://meet.example.com
SMTP_URL=smtps://user:percent-encoded-password@smtp.example.com:465
MAIL_FROM=Hourmere <bookings@example.com>
SIGNUP=first-user
```

Use your own SMTP account and sender. `smtp://…:587` requires STARTTLS unless the mail
server is local. Percent-encode special characters in SMTP credentials. Single-quote Compose
values containing `$`, `#` or spaces. Without SMTP, Hourmere prints sign-in links and booking
emails to logs: anyone who reads those links can act as their recipient. Use that mode only
for a private local trial.

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

Compose builds the application from the checked-out source, starts PostgreSQL 18 and applies
application and job migrations at startup. A healthy response is a liveness/database check;
it does not prove SMTP delivery or external calendar access.

Sign in immediately after the first start. With the default `SIGNUP=first-user`, the first
account belongs to whoever signs in first; further new accounts need an email domain in
`SIGNUP_ALLOWED_DOMAINS` or the invitation exception below. Existing accounts can always
sign in. `SIGNUP=closed` still allows the listed domains. In either restricted mode, a
pending, unexpired team invitation admits its exact email address only if the inviter's
current email domain is in the allowlist or the inviter is the first user: the earliest
remaining auth user by creation time, with user id breaking ties. The current allowlist
applies to existing invitations too. Registration authority is non-transitive: an invitee
outside those domains cannot admit another address by creating a team and inviting it;
neither team creation nor invitation acceptance grants that authority. Invitees must still
prove email ownership and accept the invitation separately to join the team.
With `closed` and an empty domain list, only invitations from the first user admit new
accounts, so bootstrap an empty instance in `first-user` mode or through an administrator
before using `closed`.
`SIGNUP=open` permits anyone who can reach the app and cannot be combined with a domain list.

In the app, set a profile handle and time zone, create working hours, then create an active
event type. Its public booking page is `/{handle}/{slug}`. Configure calendars explicitly
through [Google Calendar](/docs/google-calendar), then use the [REST](/docs/rest) or
[MCP](/docs/mcp) guides for agent access.

## Public attribution

The official image keeps a small “Powered by Hourmere” link on public booking pages and a
“Create your own booking link” link on booking confirmations, including embedded pages.
Self-hosted and hosted instances both retain these links; there is no setting to hide them.
`HOSTED_SIGNUP_URL` configures their hosted service destination and defaults to
`https://hourmere.com`, independently of your instance’s `PUBLIC_URL`. Set the hosted
sign-up page URL when available. The links send no booking details or tracking parameters,
and suppress the referrer. Removing attribution may become an enterprise-license
entitlement later; it is outside the current configuration.

## Put a TLS proxy in front

Compose publishes the app only on `127.0.0.1:3000`; PostgreSQL is not published. Forward your
chosen HTTPS hostname to that app port using your reverse proxy. Proxy `/api`, `/mcp`,
`/sign-in/confirm`, `/app` and public booking routes to the same application, preserving the
path and request body. Serve the app at the hostname root. `PUBLIC_URL` must match that
external origin so links, cookies and OAuth redirects agree.

Set `TRUSTED_PROXIES` to the proxy addresses as the app sees them. Trust only your controlled
proxy path: a broad Docker subnet also trusts other containers on that subnet. Only trusted
proxies can supply the client address through `X-Forwarded-For`. Without that setting,
visitors behind a proxy share one rate limit. Keep the app's `HTTP_KEEP_ALIVE_TIMEOUT` above
the proxy's upstream idle timeout. For a proxy in a separate container, `127.0.0.1` means that
container itself; arrange network access to the app before changing its published bindings.

The app sends HSTS for HTTPS origins and security headers including a page CSP. Check
`/api/health`, sign-in email delivery and one booking through the external origin before
inviting others. Email links show a confirmation button before consuming the sign-in token.

## Run workers separately

The default `HOURMERE_ROLE=all` runs the API, booking email jobs and calendar synchronization
in one container. To split them, set `HOURMERE_ROLE=web` in `.env` and enable the commented
`worker` service in `docker-compose.yml`. It uses the same image and database with
`HOURMERE_ROLE=worker`; its port stays unpublished. Use a Compose version that supports the
file's `!reset` tags. A web-only deployment needs a running worker for queued email and
calendar updates. The worker exposes only `/api/health` for health checks.

Allow shutdown time for HTTP requests and running jobs. The Compose file allows
35 seconds, leaving margin around the server's 10-second HTTP drain and 20-second job drain. Keep the same application version and secrets on web
and worker processes.

## Back up and restore

Back up the full application database, including `auth`, `public` and `pgboss` schemas, plus
the deployment configuration and its encryption/signing secrets. Protect backups as sensitive
data. A database backup without `CALENDAR_ENCRYPTION_KEY` cannot decrypt saved calendar
tokens. Keep the checked-out commit ID with each backup.

For a small Compose deployment, make a logical custom-format database export:

```sh
umask 077
docker compose exec -T db pg_dump -U hourmere -d hourmere -Fc > hourmere.dump
```

Check the command's exit status and retain successful copies outside the deployment host.
This exports one database, not cluster roles. Plan backup frequency and recovery separately;
see [PostgreSQL's pg_dump documentation](https://www.postgresql.org/docs/18/app-pgdump.html)
and [Compose exec](https://docs.docker.com/reference/cli/docker/compose/exec/).

Test restoration in a separate, isolated deployment with a new empty database and no public
traffic. Keep application/worker processes stopped while restoring, so restored queued jobs
cannot send duplicate emails or change real calendars during the drill. Using that isolated
deployment's `db` service and original database role:

```sh
docker compose exec -T db pg_restore -U hourmere -d hourmere --exit-on-error < hourmere.dump
```

Start application processes only when you have deliberately arranged test SMTP/calendar
isolation. Do not restore over a running instance. Never remove the `db-data` volume as an
upgrade or troubleshooting step.

## Upgrade and troubleshoot

Back up first, record the old commit and review the changes. Fetch and check out the intended
reviewed revision, then rebuild and recreate the app (and the worker if enabled) with
`docker compose up -d --build`. Database migrations run automatically and have checksums;
do not edit migrations already applied. Schema downgrade is not automatic: test recovery
from your backup before an upgrade, rather than assuming an old image can read a new schema.

`docker compose logs app` shows startup and job failures; logs can contain authentication
links when SMTP is disabled. A startup failure about `hourmere.*` settings usually means a
connection pooler stripped PostgreSQL startup options. Connect directly to PostgreSQL;
PgBouncer is not supported. The database is required at startup even with automatic
migration disabled. Repeated restarts do not fix incorrect secrets, SMTP settings or a
missing worker; use the [configuration reference](/docs/configuration) to correct them.
