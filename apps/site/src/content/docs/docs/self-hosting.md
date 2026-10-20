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
`app.hourmere.com`. **Publish only an A record with the bundled configuration.** Its
ingress network is IPv4-only: IPv6 connections can arrive through Docker's userland proxy
with the bridge gateway as their source, putting all IPv6 visitors in one rate-limit bucket.
Do not publish AAAA merely because the host has IPv6. Supporting it requires a custom
ingress network with `enable_ipv6`, a fixed Caddy IPv6 address, and both exact Caddy
addresses in the app's `TRUSTED_PROXIES` override, followed by independent IPv6 client-IP
rate-limit testing. Make TCP ports 80 and 443 and UDP 443 (HTTP/3) reachable;
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

In setup, accept the default `proxy` mode, explicitly enter your exact HTTPS origin (the example is
`https://app.hourmere.com`), then enter your SMTP URL and sender. Use your own hostname in
all commands. A path prefix and a nonstandard public HTTPS port are not supported by this
bundled proxy setup. Use a sender your SMTP provider accepts, for example
`Hourmere <bookings@example.com>`. `smtp://…:587` requires STARTTLS; `smtps://…:465` uses TLS
from the start. Percent-encode special characters in SMTP credentials. Setup hides SMTP
input on a terminal, and quotes values for Compose.

`MAIL_FROM` becomes the organizer for new calendar invitations. Do not use a Gmail or
Google Workspace address, or any address registered as a Google account: Gmail may treat it
as a Google organizer (unconfirmed). Use a mailbox that can receive mail, and monitor or
forward it: calendar RSVP replies go there regardless of Reply-To, and a no-reply address
that rejects mail bounces them. `RSVP=FALSE` does not stop Gmail from sending calendar
responses. A calendar decline does not cancel an Hourmere booking or automatically notify
its host; use Cancel booking in Hourmere or the original email's cancellation link. See
[Handle calendar replies](#handle-calendar-replies) for the operator procedure.

The script copies `.env.example`, generates independent `POSTGRES_PASSWORD` and
`BETTER_AUTH_SECRET` values with `openssl rand -base64 32`, and writes `.env` with mode
`600`. It never prints the secrets or overwrites an existing `.env`. Keep this file private
and out of Git; do not paste a rendered `docker compose config` into an issue. To change an
existing deployment, edit its `.env` rather than rerunning setup. The development example
`DATABASE_URL` is omitted: Compose supplies its own container database URL and password.

Setup selects both Compose files using
`COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml'`, persists
`COMPOSE_PROJECT_NAME=hourmere`, and sets `SIGNUP=first-user`
and `AUTO_MIGRATE=true`. `docker compose up` then builds the checked-out application,
starts PostgreSQL 18, and applies application and job migrations before serving requests.
`--wait` waits for the app and database health checks; the curl command also checks the
public TLS/proxy path. A health response checks the process/database, not SMTP delivery or
external calendar access. For an independent installation, choose a unique lowercase project
name before setup, for example `COMPOSE_PROJECT_NAME=hourmere-staging ./scripts/setup.sh`.
Run every later Compose command from that checkout so it reads the persisted project and
file selection. Avoid exporting a conflicting `COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` in
your shell, which would override `.env`.

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

The HTTPS override publishes TCP **80 and 443** and UDP **443** (HTTP/3), on Caddy's `proxy` service. Neither
`app` nor PostgreSQL publishes a host port. Caddy obtains and renews certificates, redirects
HTTP to HTTPS, and preserves the original Host while setting `X-Forwarded-For` and
`X-Forwarded-Proto`. The app's `PUBLIC_URL` is the external HTTPS origin used by origin
checks, redirects and Secure cookies. HTTPS origins also enable the app's HSTS header.

Caddy has a fixed address (`PROXY_IP=172.30.62.2`) on a dedicated ingress network
(`PROXY_SUBNET=172.30.62.0/28`). Dynamic app and one-off app container addresses are allocated from
`PROXY_DYNAMIC_RANGE=172.30.62.8/29`, keeping Caddy's address outside that range. The worker
uses only the default network shared with PostgreSQL. The override sets `TRUSTED_PROXIES`
to Caddy's address so client-IP rate limits use the visitor address and ignore
client-supplied forwarding headers.
Do not replace this with a broad private-network range. If the subnet overlaps an existing
network or another deployment, change all three values (`PROXY_SUBNET`, `PROXY_IP` and
`PROXY_DYNAMIC_RANGE`) in `.env` before starting. Choose a free private subnet, a dynamic
range inside it and a free usable proxy address outside that dynamic range. Caddy's
certificates and state persist in `caddy-data` and `caddy-config` volumes. Caddy's global log
filter replaces query strings with `?REDACTED` and deletes request headers, including on
upstream errors; retain this filter when customizing the Caddyfile.

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
bundled public HTTPS path: sign-in requires email delivery. For a private HTTPS proxy test
without SMTP, run setup with synthetic SMTP settings, then clear `SMTP_URL` and `MAIL_FROM`
in the private `.env` before starting. Restrict the test to your machine or a private network,
use synthetic accounts and read sign-in mail privately from app/worker logs. The log mailer
is supported behind Caddy too, but must never be used for a public deployment. Never copy
those logs into reports. For a simple trial, prefer the loopback plain-mode sequence above.

## Migrate an existing installation to Caddy

Take a full backup using your current configuration first. Update to the reviewed source
revision and keep the existing secrets, database volume and **existing Compose project
name**. Determine that name with `docker compose ls` or the containers' Compose labels;
old default installations use `hourmere`. Changing it would select a different database.
Stop the old app and any worker during the switch; stop an existing proxy before Caddy
claims 80/443. Configure a real SMTP provider and explicit HTTPS `PUBLIC_URL` in `.env`,
point only DNS A at the host, and allow the ports listed above.

Older `.env` files may lack every deployment setting below. This sequence replaces or adds
the keys, rather than silently relying on `sed` matching an existing key. Set the project
name to the original one and select a free subnet before running it. It preserves the
separate-worker overlay when selected in `.env`:

```sh
umask 077
env_update=$(mktemp .env.update.XXXXXXXX)
awk '
  /^COMPOSE_FILE=/ {
    selection = $0
    sub(/[[:space:]]+#.*$/, "", selection)
    if (selection ~ /[=:"\047]docker-compose\.worker\.yml([:"\047[:space:]]|$)/)
      worker = ":docker-compose.worker.yml"
  }
  !/^(COMPOSE_PROJECT_NAME|COMPOSE_FILE|APP_IMAGE|PROXY_SUBNET|PROXY_IP|PROXY_DYNAMIC_RANGE|DATABASE_URL)=/ { print }
  END { print "COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml" worker }
' .env > "$env_update"
cat >> "$env_update" <<'EOF'
COMPOSE_PROJECT_NAME=hourmere
APP_IMAGE=hourmere:local
PROXY_SUBNET=172.30.62.0/28
PROXY_IP=172.30.62.2
PROXY_DYNAMIC_RANGE=172.30.62.8/29
EOF
chmod 600 "$env_update"
mv "$env_update" .env
```

Review the private file locally, then run `docker compose build`, `docker compose pull proxy db`
and `docker compose up -d --wait`. Verify HTTPS health, sign-in and a booking before
reopening traffic. Do not recreate or delete the database volume. If the old installation
used a custom Compose override, carry its settings over deliberately; `.env` entries alone
do not forward arbitrary server variables. If resizing an already deployed `/29` ingress
network, stop app/worker/proxy, remove only that project's obsolete ingress network, then
start again; Docker cannot resize an existing network. Keep database volumes intact.

## Run workers separately

The default `HOURMERE_ROLE=all` runs the API, booking email jobs and calendar synchronization
in one container. After setup, run these commands from the deployment checkout:

```sh
unset COMPOSE_FILE
./scripts/enable-worker.sh
docker compose config --services | grep -qx worker ||
  { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }
# Bundled HTTPS only; omit this check in plain mode.
docker compose config --services | grep -qx proxy ||
  { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }
docker compose up -d --build --wait
```

Continue to `up` only if all applicable verification commands succeed. The helper rewrites only
`COMPOSE_FILE` in your private `.env`, keeps its mode `600`, and preserves the existing
proxy selection. It accepts quoted, unquoted and `export COMPOSE_FILE=` assignments, adds
the setting if missing, and can be run again safely. It refuses a symlink `.env`.
A shell-exported `COMPOSE_FILE` overrides `.env`; unset it before these commands.

Unsupported or ambiguous `COMPOSE_FILE` syntax, including YAML-style `COMPOSE_FILE: ...`,
is refused without changes. A leading UTF-8 BOM is also refused: save `.env` as UTF-8
without BOM, then rerun. The helper preserves LF or CRLF line endings when appending a
missing setting. If old instructions left a suffix outside the quotes, such as
`COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml':docker-compose.worker.yml`,
move `:docker-compose.worker.yml` inside the closing quote, retaining every existing file.
Use the complete HTTPS or plain-mode line below and keep any custom overlays inside the quotes.

For a manual edit, replace the **whole line**, including its quotes. Bundled HTTPS uses:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'
```

Plain mode uses:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml'
```

Run the verification command above after any manual edit. The tracked overlay
automatically sets the app to `HOURMERE_ROLE=web` and the worker to
`HOURMERE_ROLE=worker`, so exactly one service runs
jobs; no separate role edit or change to `docker-compose.yml` is needed. The worker uses
the same image, environment and secrets as the base app, and its port stays unpublished.
A web-only deployment needs a running worker for queued sign-in email, booking email and
calendar updates. The worker exposes only `/api/health` for health checks. Keep web and
worker on the same version and secrets. Development's `docker-compose.dev.yml` and
`hourmere-dev` project remain independent of this production selection.

If moving from the old commented worker block, follow the migration steps under
[Upgrade and roll back](#upgrade-and-roll-back) before pulling the new source.

### Switch back to a single container

Remove the worker container while the overlay is still selected:

```sh
docker compose rm -sf worker
```

Remove any old `HOURMERE_ROLE=web` setting from `.env`. Then deselect the overlay with the helper:

```sh
unset COMPOSE_FILE
./scripts/disable-worker.sh
! docker compose config --services | grep -qx worker ||
  { echo "Worker service is still enabled; check COMPOSE_FILE before continuing."; exit 1; }
# Bundled HTTPS only; omit this check in plain mode.
docker compose config --services | grep -qx proxy ||
  { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }
docker compose up -d --build --wait
```

Its default `all` role resumes job processing.
Removing the container before deselecting the overlay prevents an orphaned worker from
continuing to process jobs.

Compose allows 35 seconds to stop a process, leaving margin around the server's 10-second
HTTP drain and 20-second job drain. Preserve that grace period in deployment overrides.

## Private webhook receivers

The default webhook policy accepts only public HTTPS receivers. Self-hosted operators may
set `WEBHOOK_PRIVATE_TARGETS` to exact trusted private destinations; see the
[configuration reference](/docs/configuration#private-webhook-receivers) for syntax and
restrictions. **Hourmere Cloud MUST NEVER set this setting.** It is empty by default, and
nonempty configurations print a startup warning without listing destinations.

For an n8n receiver on the same Compose network, keep the tracked files unchanged and
create your own `docker-compose.webhooks.yml` override. This example adds a dedicated
receiver network to both the web process and job runner, while retaining their database
network and the proxy's existing ingress network:

```yaml
services:
  app:
    networks:
      default:
      webhook-receivers:
  worker:
    networks:
      default:
      webhook-receivers:
  n8n:
    image: ${N8N_IMAGE:?set a pinned n8n image in .env}
    networks:
      webhook-receivers:
    volumes:
      - n8n-data:/home/node/.n8n
    restart: unless-stopped

networks:
  webhook-receivers:

volumes:
  n8n-data:
```

Set these entries in your private `.env`, retaining the proxy overlay only when you use
the bundled HTTPS proxy. Keep the custom override after the worker overlay:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml:docker-compose.webhooks.yml'
WEBHOOKS_ENABLED=true
WEBHOOK_PRIVATE_TARGETS=n8n:5678
```

Also set the independent `WEBHOOK_ENCRYPTION_KEY` as described in the configuration
reference, and set `N8N_IMAGE` to the pinned n8n image you operate. Configure n8n's own
authentication, backups and private editor access separately; this example publishes no
n8n port. Verify the worker selection and recreate both app and worker:

```sh
unset COMPOSE_FILE
docker compose config --services | grep -qx worker ||
  { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }
# Bundled HTTPS only; omit this check in plain mode.
docker compose config --services | grep -qx proxy ||
  { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }
docker compose up -d --build --wait
```

Continue only if verification succeeds. Create a webhook endpoint using
`http://n8n:5678/webhook/<your-workflow-path>` through the REST API.
The service name resolves inside that network, and the worker sends the event with the
usual HMAC headers. Require signature verification in the receiving workflow. HTTP is
unencrypted within the selected network; use HTTPS where transport confidentiality is
required. The allowlist trusts a host and port, not a single URL path.

For an existing LAN receiver, list its exact private IP and port, for example
`192.168.1.10:8080`, and use `http://192.168.1.10:8080/hook`. A narrow CIDR and port can
cover a controlled receiver network. `localhost` or `127.0.0.1` refers to the delivering
container itself, rather than the Docker host or another service. Keep operator-selected
destinations narrow: organization owners/admins can configure any path at an allowed
destination. IP/CIDR entries also allow every virtual host resolving entirely into the
range: administrators choose the URL hostname and HTTP Host header, so a reverse proxy
routing by Host may expose multiple internal services. Delivery records include HTTP
status (`httpStatus`, stored as `http_status`) and reveal whether an allowed internal
destination responded; this visibility is inherent to allowing it.
Configure the same setting on every web and worker process and recreate them
together when changing it. Saving an endpoint performs no DNS lookup or network probe;
delivery re-resolves and revalidates every DNS answer on every attempt.

## Back up and restore

Back up the full database (`auth`, `public` and `pgboss` schemas), `.env`, the checked-out
commit, and Caddy's data/configuration. Protect backups as sensitive data. Preserve all
signing/encryption keys: for example, losing `CALENDAR_ENCRYPTION_KEY` makes saved calendar
tokens unreadable. The saved `.env` includes `COMPOSE_FILE`, so the backup also records
whether the tracked worker overlay is enabled. Do not generate replacement secrets during
a restore.

For the default HTTPS deployment, stop the app before taking a logical custom-format dump.
Stop any separate worker too. The database stays running; these commands do not remove
volumes. Store the backup outside the checkout:

```sh
umask 077
backup_dir="$HOME/hourmere-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
if docker compose config --services | grep -qx worker; then
  docker compose stop worker
fi
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
networks even when only `db` is targeted. The example below uses `172.30.63.0/28`; confirm
that it does not overlap any host, Docker or VPN network before using it:

```sh
git clone https://github.com/hourmere/hourmere.git hourmere-restore
cd hourmere-restore
git checkout --detach "$(cat "$backup_dir/commit")"
install -m 600 "$backup_dir/.env" .env
umask 077
env_update=$(mktemp .env.update.XXXXXXXX)
awk '
  /^COMPOSE_FILE=/ {
    selection = $0
    sub(/[[:space:]]+#.*$/, "", selection)
    if (selection ~ /[=:"\047]docker-compose\.worker\.yml([:"\047[:space:]]|$)/)
      worker = ":docker-compose.worker.yml"
  }
  !/^(COMPOSE_PROJECT_NAME|COMPOSE_FILE|APP_IMAGE|PROXY_SUBNET|PROXY_IP|PROXY_DYNAMIC_RANGE|DATABASE_URL)=/ { print }
  END { print "COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml" worker }
' .env > "$env_update"
cat >> "$env_update" <<'EOF'
COMPOSE_PROJECT_NAME=hourmere-restore
APP_IMAGE=hourmere:restore
PROXY_SUBNET=172.30.63.0/28
PROXY_IP=172.30.63.2
PROXY_DYNAMIC_RANGE=172.30.63.8/29
EOF
chmod 600 "$env_update"
mv "$env_update" .env
docker compose up -d --wait db
docker compose exec -T db \
  pg_restore -U hourmere -d hourmere --exit-on-error --single-transaction < "$backup_dir/hourmere.dump"
docker compose exec -T db \
  psql -U hourmere -d hourmere -Atc 'SELECT count(*) FROM auth."user";'
```

Set `backup_dir` to the chosen backup directory if using a new shell. The separate
`APP_IMAGE` tag also prevents restore builds from replacing the original deployment's
local image tag. Compare the count with your expected account data, and inspect other
expected records privately. Persisting `COMPOSE_PROJECT_NAME=hourmere-restore` ensures later
backup, upgrade and log commands in this checkout target the restored project too. These
assignments also work with backups from before the deployment settings existed, provided
the selected source revision contains `Caddyfile` and `docker-compose.proxy.yml`. If the
backup commit predates this kit, select a reviewed newer revision containing these files
instead of that old commit before using the HTTPS commands; startup will apply its pending
migrations, so retain the original dump for rollback. The rewrite preserves only the exact
`docker-compose.worker.yml` filename in a `COMPOSE_FILE=` assignment, including setup's
quoted values. It does not recognise `./docker-compose.worker.yml` or
`export COMPOSE_FILE=` forms. Before running the rewrite, replace those forms with the
complete quoted line for your deployment shown under [Run workers separately](#run-workers-separately).
For backups with a separate worker, verify the rewritten selection before starting any app
or worker:

```sh
unset COMPOSE_FILE
docker compose config --services | grep -qx worker ||
  { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }
# Bundled HTTPS only; omit this check in plain mode.
docker compose config --services | grep -qx proxy ||
  { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }
```

Continue only if verification succeeds. For a plain-mode restore, replace the whole line
with `COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml'` when a separate worker
was selected, or `COMPOSE_FILE='docker-compose.yml'` otherwise, and omit the Caddy steps.
Keep any additional custom overlays within the quotes. Do not start the restored app or
workers for a drill until SMTP, provider credentials and outbound webhooks
have been isolated: restored queued jobs can otherwise send duplicate messages or modify
real calendars. Never restore over a running app, and never delete a production `db-data`
volume as an upgrade or troubleshooting step.

For actual recovery, take the old deployment offline before reusing its hostname/ports.
Use the backed-up secrets and revision with the new persisted deployment settings above;
do not overwrite the prepared `.env` again. Restore the database as above, then create the
proxy container and copy its saved state into the new volumes before starting it:

```sh
docker compose build
docker compose create proxy
docker compose cp "$backup_dir/caddy-data/." proxy:/data
docker compose cp "$backup_dir/caddy-config/." proxy:/config
docker compose up -d --wait
```

Keep the free `PROXY_SUBNET`, `PROXY_IP` and `PROXY_DYNAMIC_RANGE` selected before the
database restore; overlapping ingress networks cannot coexist. Plain mode omits the proxy
restoration. Verify health, expected data, sign-in and a booking before
reopening traffic. Keep the old volumes and backup until recovery is accepted.

## Upgrade and roll back

Read the intended release's changes and take the backup above first. Record its commit and
preserve its `.env` and Caddy state. If using separate workers, select them with
`./scripts/enable-worker.sh`, keeping the tracked Compose files unchanged so local
deployment choices do not block `git pull --ff-only`. The persisted file selection also
rebuilds/recreates any separate worker during upgrades. In the deployment checkout, a branch
following `main` can be updated with the commands below.

**Migration 0038 requires stopping all old processes; do not use a rolling deployment.**
Before any new process applies `0038_booking_ical_identity.sql`, stop every old `web`, `all`
and `worker` process, including any on other hosts. With Compose, run
`docker compose stop app` and, if the separate worker is configured, `docker compose stop worker`. Leave
PostgreSQL running, then apply the migration and start every role with the new code. With
`AUTO_MIGRATE=true`, the first new process applies the migration on startup.

**If you uncommented the old worker block in `docker-compose.yml`, migrate it before
pulling.** Those tracked edits make `git pull --ff-only` refuse the upgrade. If your
checkout already has `scripts/enable-worker.sh`, run it first. Otherwise replace or add the
complete `COMPOSE_FILE` line in `.env` before restoring the tracked file. For bundled HTTPS:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'
```

For plain mode:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml'
```

Keep any additional custom overlays within the quotes. Then restore the tracked Compose
file before pulling:

```sh
git restore docker-compose.yml
```

Restoring the Compose file without selecting the worker overlay leaves the old worker
container orphaned on the old image, and the app may remain web-only if `.env` still sets
`HOURMERE_ROLE=web`. Select the overlay before restoring so the upgrade recreates both
services on the new image. Installations already using the tracked overlay skip this legacy
restoration step. Choose the upgrade sequence for your existing deployment below.

### Single-container upgrade

The app keeps the default `all` role. From the deployment checkout:

```sh
git pull --ff-only
unset COMPOSE_FILE
! docker compose config --services | grep -qx worker ||
  { echo "This deployment runs a separate worker; use the separate-worker upgrade."; exit 1; }
# Bundled HTTPS only; omit this check in plain mode.
docker compose config --services | grep -qx proxy ||
  { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }
docker compose pull proxy db
docker compose stop app
docker compose up -d --build --wait
curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://app.hourmere.com/api/health
```

### Separate-worker upgrade

From the deployment checkout, verify both the worker and the bundled HTTPS proxy before
stopping the old app and worker:

```sh
git pull --ff-only
unset COMPOSE_FILE
./scripts/enable-worker.sh
docker compose config --services | grep -qx worker ||
  { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }
# Bundled HTTPS only; omit this check in plain mode.
docker compose config --services | grep -qx proxy ||
  { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }
docker compose pull proxy db
docker compose stop app worker
docker compose up -d --build --wait
curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://app.hourmere.com/api/health
```

Continue only if all applicable verification commands succeed. For plain mode, omit the
proxy verification, pull only `db`, and use your deployment's health URL in either sequence.

For a pinned release, fetch and check out the reviewed tag/commit instead of pulling the
branch. No public image can currently be pulled as a substitute for building the source.
Plain mode pulls only `db`. Caddy is pinned to the `2.11` minor line (`caddy:2.11-alpine`),
and PostgreSQL to major 18 (`postgres:18-alpine`): pulling refreshes their patch/security
updates, then `up` recreates affected containers. Review Caddy releases and deliberately
test newer minor versions before updating that pin; review PostgreSQL release notes before
patch updates, and plan a separate database migration for a future major upgrade. Container
image updates are separate from host apt updates. Rebuild any separate worker too.

**Before starting a version whose migrations drop columns, stop every old app and worker
process.** Migration `0037_conference_pending_timeout.sql` is the project's first column
drop: old versions still write the removed `booking_conferences.retry_conference` column.
The separate-worker sequence's `stop app worker` stops both Compose roles before new startup migrations.
For a single-container deployment, `docker compose up -d --build` already stops the old app
container before starting its replacement. Separately managed workers, including processes
outside this Compose project, must be stopped explicitly before the new app or a manual
migration runs. Restart every role with the same upgraded code after migration; do not run
old and new versions together across a column drop.

Future column removals use two phases: release N stops writing the column, and release N+1
drops it. Review each release's migration and upgrade notes even with this policy; schema
downgrade remains unsupported.

`AUTO_MIGRATE=true` applies pending application and job migrations on startup; applied
migrations have checksums and must not be edited. Keep the same secrets across upgrades.
PostgreSQL password changes in `.env` do not change an already-initialized database role's
password.

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

On Linux, Caddy's quic-go may warn about small UDP buffers for HTTP/3. The
[quic-go guidance](https://quic-go.net/docs/quic/optimizations/#udp-buffer-sizes) recommends
raising the host's receive/send maxima (keep any already higher values):

```sh
sudo sysctl -w net.core.rmem_max=7340032 net.core.wmem_max=7340032
```

These changes last until reboot; persist them in the host's sysctl configuration if needed.

A startup error about `hourmere.*` settings usually means a connection pooler stripped
PostgreSQL startup options. Connect directly to PostgreSQL; PgBouncer is unsupported. The
database is needed at startup even with `AUTO_MIGRATE=false`. Repeated restarts do not fix
incorrect secrets, SMTP settings or a missing worker; consult the
[configuration reference](/docs/configuration).

On Ubuntu 24.04, allow SSH before enabling the firewall. For the standard SSH port:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
sudo ufw status verbose
```

Allow your actual SSH port instead if it differs from the OpenSSH profile. Mirror these
rules in the VPS/network firewall. [Docker-published ports bypass ufw rules](https://docs.docker.com/engine/install/ubuntu/);
the supplied proxy configuration therefore publishes only 80/tcp, 443/tcp and 443/udp.
Keep app/database ports unpublished and verify them from another machine. Restrict SSH
source addresses when practical.

Verify a second key-based SSH session works before changing authentication. Keep the
current session open. Create `/etc/ssh/sshd_config.d/00-hardening.conf`:

```sh
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sudo sshd -t
sudo systemctl restart ssh
```

Run the restart only after `sshd -t` succeeds, then verify a new key-based login.
The `00-` prefix sorts before `50-cloud-init.conf`: [OpenSSH uses the first value for
most settings](https://ubuntu.com/server/docs/openssh-server/). Root key login remains
possible; use a regular sudo account for routine administration.

Ubuntu 24.04 normally has unattended security upgrades enabled. Verify the machine's
policy and timers (`systemctl list-timers 'apt-daily*'`), especially on minimal/cloud images.
Docker's apt repository is absent from `Unattended-Upgrade::Allowed-Origins` by default.
To opt into automatic Docker package updates, confirm its Origin/Suite in the locally
downloaded `InRelease` metadata (normally `Docker` / `noble`) and add:

```sh
sudo tee /etc/apt/apt.conf.d/52unattended-upgrades-docker >/dev/null <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "Docker:${distro_codename}";
};
EOF
sudo unattended-upgrade --dry-run --debug
```

Review the dry run and plan service restarts/reboots. See Ubuntu's
[automatic update policy and origin configuration](https://ubuntu.com/server/docs/how-to/software/automatic-updates/).
This updates host packages; refresh container images through the upgrade procedure above.

Use `sudo docker …` unless your deployment account is already authorized for Docker.
Membership in the [docker group grants root-level privileges](https://docs.docker.com/engine/install/linux-postinstall/),
including access to container secrets; grant it only to trusted administrators. Keep `.env`
mode `600` and maintain tested off-host backups. Before admitting public traffic, configure
real SMTP, claim the first account, review signup policy and check health, sign-in and a
booking through the HTTPS hostname.

## Handle calendar replies

Hourmere sends invitations with `RSVP=FALSE` and has no automatic two-way calendar sync.
Gmail can still offer Yes/No/Maybe and send replies to the pinned calendar organizer,
`MAIL_FROM` for new bookings. Older bookings keep their original organizer, which may be
the host's mailbox. Reply-To controls ordinary email replies, not calendar responses.
Declining in a calendar neither cancels the booking nor automatically notifies its host.

Keep `MAIL_FROM` monitored. Archive incoming calendar replies, identify the booking and
contact the actual host manually. Cancel only through an explicit action in Hourmere;
receiving a calendar reply does not change booking status.

For an instance with **one fixed host**, a mail-provider filter may forward a copy of calendar
replies to that host. Verify the destination, choose conditions tested against real replies,
retain the original and monitor forwarding failures. If other private or support mail shares
the mailbox, forward only reliably classified replies or sort them manually. Whole-mailbox
forwarding is suitable only for a dedicated invitation mailbox or a host authorized to
receive everything in that mailbox.

In [Zoho Mail](https://www.zoho.com/mail/help/email-forwarding.html), open **Settings → Filters →
New Filter**, set the tested conditions, choose **Forward to**, verify a new destination and
save. Keep the original message; for whole-mailbox forwarding, leave **Delete original email
copy after forwarding** unchecked. Check forwarding health regularly because repeated
delivery failures can disable it. Test accept, tentative and decline, then a reply after
rescheduling: each should reach the host and remain archived, while Hourmere stays confirmed
until explicitly cancelled. Subject prefixes vary by client and language, so a subject filter
alone cannot guarantee complete calendar-reply detection or decline-only forwarding.

This does not work as general routing for multi-host instances: mailbox rules cannot map a
calendar UID to the booking's actual host(s). Names, subjects and senders are unreliable;
forwarding everything to every host exposes other bookings. Use monitored manual handling
instead. Forwarding lets a person read the reply; it does not sync attendance into their
calendar or make them the organizer.

## Public attribution

The application image built from this repository keeps a small “Powered by Hourmere” link
on public booking pages and a “Create your own booking link” link on booking confirmations,
including embedded pages. Self-hosted and hosted instances both retain these links; there
is no setting to hide them. `HOSTED_SIGNUP_URL` configures their hosted service destination
and defaults to `https://hourmere.com`, independently of your instance's `PUBLIC_URL`. Set
the hosted sign-up page URL when available. The links send no booking details or tracking
parameters, and suppress the referrer. Removing attribution may become an
enterprise-license entitlement later; it is outside the current configuration.
