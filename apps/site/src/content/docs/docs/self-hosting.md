---
title: Self-hosting
description: Deploy and operate Hourmere with Docker Compose and optional automatic HTTPS.
---

## Prepare the host

Use Git, OpenSSL, curl, Docker Engine and Docker Compose **2.24.4 or newer** on Linux.
The production setup targets Ubuntu 24.04 LTS, x86_64, with 2 vCPU and 4 GB RAM. Compose
builds the application from source: **no prebuilt public image is published yet**. The
release workflow is being prepared separately. Allow disk space for the source, image
builds, PostgreSQL data and backups. Choose a dedicated deployment directory and volumes.

For the bundled HTTPS proxy, point your hostname's DNS A record at the VPS, for example
`app.hourmere.com`. Publish an AAAA record only if IPv6 actually reaches this host. Make
TCP ports 80 and 443 reachable for Caddy's certificate validation, HTTPS and HTTP redirects;
keep SSH available on TCP 22. PostgreSQL and the application port must stay private.

## First start with automatic HTTPS

Run this sequence from a directory where you want the checkout:

```sh
git clone https://github.com/hourmere/hourmere.git
cd hourmere
./scripts/setup.sh
docker compose up -d --build --wait
curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://app.hourmere.com/api/health
```

In setup, accept the default `proxy` mode, enter your exact HTTPS origin (the example is
`https://app.hourmere.com`), then enter your SMTP URL and sender. Use your own hostname in
all commands. A path prefix and a nonstandard public HTTPS port are not supported by this
bundled proxy setup. Use a sender your SMTP provider accepts, for example
`Hourmere <bookings@example.com>`. `smtp://…:587` requires STARTTLS; `smtps://…:465` uses TLS
from the start. Percent-encode special characters in SMTP credentials. Setup hides SMTP
input on a terminal, and quotes values for Compose.

The script copies `.env.example`, generates independent `POSTGRES_PASSWORD` and
`BETTER_AUTH_SECRET` values with `openssl rand -base64 32`, and writes `.env` with mode
`600`. It never prints the secrets or overwrites an existing `.env`. Keep this file private
and out of Git; do not paste a rendered `docker compose config` into an issue. To change an
existing deployment, edit its `.env` rather than rerunning setup.

Setup selects both Compose files using
`COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml`, and sets `SIGNUP=first-user`
and `AUTO_MIGRATE=true`. `docker compose up` then builds the checked-out application,
starts PostgreSQL 18, and applies application and job migrations before serving requests.
`--wait` waits for the app and database health checks; the curl command also checks the
public TLS/proxy path. A health response checks the process/database, not SMTP delivery or
external calendar access.

Open `https://app.hourmere.com/sign-in` and sign in immediately with your own email. There
is no separate sign-up page and no initial password: proving an eligible email address
creates the account. The first account belongs to whoever completes sign-in first, so
claim it before sharing the instance. Verify the email arrives and its confirmation button
signs you in before inviting others. Email links require pressing that button, so mail
scanners do not consume them merely by opening the URL.

With `SIGNUP=first-user`, after the first account, new addresses need an email domain in
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
before using `closed`. `SIGNUP=open` permits anyone who can reach the app and cannot be
combined with a domain list.

In the app, set a profile handle and time zone, create working hours, then create an active
event type. Its public booking page is `/{handle}/{slug}`. Configure calendars explicitly
through [Google Calendar](/docs/google-calendar), then use the [REST](/docs/rest) or
[MCP](/docs/mcp) guides for agent access. Test one booking before inviting others.

## Proxy behavior and an existing proxy

The HTTPS override publishes only TCP **80 and 443**, on Caddy's `proxy` service. Neither
`app` nor PostgreSQL publishes a host port. Caddy obtains and renews certificates, redirects
HTTP to HTTPS, and preserves the original Host while setting `X-Forwarded-For` and
`X-Forwarded-Proto`. The app's `PUBLIC_URL` is the external HTTPS origin used by origin
checks, redirects and Secure cookies. HTTPS origins also enable the app's HSTS header.

Caddy has a fixed address (`PROXY_IP=172.30.62.2`) on a dedicated ingress network
(`PROXY_SUBNET=172.30.62.0/29`). Dynamic app/worker addresses are allocated only from
`PROXY_DYNAMIC_RANGE=172.30.62.4/30`, keeping Caddy's address outside that range. The
override sets `TRUSTED_PROXIES` to Caddy's address so client-IP rate limits use the visitor
address and ignore client-supplied forwarding headers.
Do not replace this with a broad private-network range. If the subnet overlaps an existing
network or another deployment, change all three values (`PROXY_SUBNET`, `PROXY_IP` and
`PROXY_DYNAMIC_RANGE`) in `.env` before starting. Choose a free private subnet, a dynamic
range inside it and a free usable proxy address outside that dynamic range. Caddy's
certificates and state persist in `caddy-data` and `caddy-config` volumes.

If you already operate a proxy, select `plain` during setup. This selects only
`docker-compose.yml`, which publishes `127.0.0.1:${PORT:-3000}:3000`; PostgreSQL remains
unpublished. Supply the exact public HTTPS origin and SMTP settings, then configure your
proxy to preserve the Host, set `X-Forwarded-Proto: https`, and replace untrusted incoming
`X-Forwarded-For` with the actual visitor address. Forward every path unchanged, including
`/api`, `/mcp`, `/sign-in/confirm`, `/app` and public booking pages.

Set `TRUSTED_PROXIES` to your controlled proxy's address **as the app sees it**, which can
be a Docker gateway rather than `127.0.0.1` for a host proxy. Keep the app's
`HTTP_KEEP_ALIVE_TIMEOUT` above the proxy's upstream idle timeout. A proxy in another
container cannot reach the host's loopback binding; give it a private shared network and
remove the app's host mapping in your own override. Do not expose port 3000 publicly.

For a private local trial, select `plain`, accept `http://localhost:3000`, leave SMTP empty,
and explicitly acknowledge the private trial prompt. Then use:

```sh
docker compose up -d --build --wait
curl --fail http://127.0.0.1:3000/api/health
```

Without SMTP, sign-in links and ordinary booking emails appear in `docker compose logs app`.
Anyone who can read those links can act as their recipient. Setup requires SMTP for the
bundled public HTTPS path; use log email only for a private loopback trial.

## Run workers separately

The default `HOURMERE_ROLE=all` runs the API, booking email jobs and calendar synchronization
in one container. To split them, set `HOURMERE_ROLE=web` in `.env` and enable the commented
`worker` service in `docker-compose.yml`. It uses the same image and database with
`HOURMERE_ROLE=worker`; its port stays unpublished. A web-only deployment needs a running
worker for queued sign-in email, booking email and calendar updates. The worker exposes
only `/api/health` for health checks. Keep web and worker on the same version and secrets.

Compose allows 35 seconds to stop a process, leaving margin around the server's 10-second
HTTP drain and 20-second job drain. Preserve that grace period in deployment overrides.

## Back up and restore

Back up the full database (`auth`, `public` and `pgboss` schemas), `.env`, the checked-out
commit, and Caddy's data/configuration. Protect backups as sensitive data. Preserve all
signing/encryption keys: for example, losing `CALENDAR_ENCRYPTION_KEY` makes saved calendar
tokens unreadable. Do not generate replacement secrets during a restore.

For the default HTTPS deployment, stop the app before taking a logical custom-format dump.
Stop any separate worker too. The database stays running; these commands do not remove
volumes. Store the backup outside the checkout:

```sh
umask 077
backup_dir="$HOME/hourmere-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
docker compose stop app proxy
docker compose exec -T db pg_dump -U hourmere -d hourmere -Fc > "$backup_dir/hourmere.dump"
install -m 600 .env "$backup_dir/.env"
git rev-parse HEAD > "$backup_dir/commit"
docker compose cp proxy:/data "$backup_dir/caddy-data"
docker compose cp proxy:/config "$backup_dir/caddy-config"
docker compose up -d --wait
```

Check that each command succeeds before continuing. For plain mode, stop only `app` and
omit the two proxy-copy commands. A dump exports one database, not cluster roles. Keep
successful copies encrypted off-host, set a retention schedule (for example, seven daily
and four weekly copies), monitor backup failures and periodically test a restore. PostgreSQL
volumes are persistent storage, not a backup.

To test restoration, clone a separate checkout, use the backed-up revision and secrets,
and select a **new, unused** project name so Compose creates a fresh database volume;
`hourmere-restore` below is an example. Keep the original deployment running and start only
the restore project's database. Before even this database-only start, choose a free ingress
subnet and change all three proxy network settings: Compose can create the declared
networks even when only `db` is targeted. The example below uses `172.30.63.0/29`; confirm
that it does not overlap any host, Docker or VPN network before using it:

```sh
git clone https://github.com/hourmere/hourmere.git hourmere-restore
cd hourmere-restore
git checkout --detach "$(cat "$backup_dir/commit")"
install -m 600 "$backup_dir/.env" .env
sed -i 's/^APP_IMAGE=.*/APP_IMAGE=hourmere:restore/' .env
sed -i -e 's|^PROXY_SUBNET=.*|PROXY_SUBNET=172.30.63.0/29|' \
  -e 's/^PROXY_IP=.*/PROXY_IP=172.30.63.2/' \
  -e 's|^PROXY_DYNAMIC_RANGE=.*|PROXY_DYNAMIC_RANGE=172.30.63.4/30|' .env
docker compose --project-name hourmere-restore up -d --wait db
docker compose --project-name hourmere-restore exec -T db \
  pg_restore -U hourmere -d hourmere --exit-on-error --single-transaction < "$backup_dir/hourmere.dump"
docker compose --project-name hourmere-restore exec -T db \
  psql -U hourmere -d hourmere -Atc 'SELECT count(*) FROM auth."user";'
```

Set `backup_dir` to the chosen backup directory if using a new shell. The separate
`APP_IMAGE` tag also prevents restore builds from replacing the original deployment's
local image tag. Compare the count with your expected account data, and inspect other
expected records privately. Do not start the
restored app or workers for a drill until SMTP, provider credentials and outbound webhooks
have been isolated: restored queued jobs can otherwise send duplicate messages or modify
real calendars. Never restore over a running app, and never delete a production `db-data`
volume as an upgrade or troubleshooting step.

For actual recovery, take the old deployment offline before reusing its hostname/ports.
Restore the original `.env` and revision, restore the database as above, then create the
proxy container and copy its saved state into the new volumes before starting it:

```sh
docker compose --project-name hourmere-restore create --build proxy
docker compose --project-name hourmere-restore cp "$backup_dir/caddy-data/." proxy:/data
docker compose --project-name hourmere-restore cp "$backup_dir/caddy-config/." proxy:/config
docker compose --project-name hourmere-restore up -d --build --wait
```

Keep the free `PROXY_SUBNET`, `PROXY_IP` and `PROXY_DYNAMIC_RANGE` selected before the
database restore; overlapping ingress networks cannot coexist. Plain mode omits the proxy
restoration. Verify health, expected data, sign-in and a booking before
reopening traffic. Keep the old volumes and backup until recovery is accepted.

## Upgrade and roll back

Read the intended release's changes and take the backup above first. Record its commit and
preserve its `.env` and Caddy state. In the deployment checkout, a branch following `main`
can be updated with:

```sh
git pull --ff-only
docker compose up -d --build --wait
curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://app.hourmere.com/api/health
```

For a pinned release, fetch and check out the reviewed tag/commit instead of pulling the
branch. No public image can currently be pulled as a substitute for building the source.
Rebuild any separate worker too. `AUTO_MIGRATE=true` applies pending application and job
migrations on startup; applied migrations have checksums and must not be edited. Keep the
same secrets across upgrades. PostgreSQL password changes in `.env` do not change an
already-initialized database role's password.

Schema downgrade is not automatic. An old application image may not work against the new
schema. To roll back safely, stop all app/worker processes, restore the pre-upgrade database
into a fresh volume, restore its original revision and configuration, then verify the result
before switching traffic back. Recovery loses writes made after that backup; decide your
maintenance window and recovery plan before upgrading.

## Logs, health and host hardening

Use `docker compose ps`, `docker compose logs --tail=100 app`,
`docker compose logs --tail=100 proxy` and `docker compose logs --tail=100 db` for service
status and startup failures. `docker compose logs -f app` follows app/jobs output. Do not
share log-email links or secrets. The health URL is `GET /api/health` on the public origin;
verify it after deployments and monitor failures externally.

A startup error about `hourmere.*` settings usually means a connection pooler stripped
PostgreSQL startup options. Connect directly to PostgreSQL; PgBouncer is unsupported. The
database is needed at startup even with `AUTO_MIGRATE=false`. Repeated restarts do not fix
incorrect secrets, SMTP settings or a missing worker; consult the
[configuration reference](/docs/configuration).

Before admitting public traffic:

- Allow inbound TCP 22 (or your chosen SSH port), 80 and 443 only in the VPS/network firewall;
  verify PostgreSQL and port 3000 cannot be reached remotely. Docker publishes ports
  independently of some host firewall rules, so retain the supplied private bindings.
- Use SSH keys, verify a second key-based session works, then disable SSH password login and
  direct root login. Restrict SSH source addresses when practical.
- Enable Ubuntu unattended security updates and keep Docker Engine/Compose updated. Plan
  reboots and verify health afterward.
- Keep `.env` mode `600`, restrict Docker/host administrator access, and maintain tested
  off-host backups. Docker access can read container secrets.
- Configure real SMTP, claim the first account, review signup policy and check health,
  sign-in and a booking through the HTTPS hostname.

## Public attribution

The application image built from this repository keeps a small “Powered by Hourmere” link
on public booking pages and a “Create your own booking link” link on booking confirmations,
including embedded pages. Self-hosted and hosted instances both retain these links; there
is no setting to hide them. `HOSTED_SIGNUP_URL` configures their hosted service destination
and defaults to `https://hourmere.com`, independently of your instance's `PUBLIC_URL`. Set
the hosted sign-up page URL when available. The links send no booking details or tracking
parameters, and suppress the referrer. Removing attribution may become an
enterprise-license entitlement later; it is outside the current configuration.
