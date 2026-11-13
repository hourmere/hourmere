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
`hourmere.example.com`. **Publish only an A record with the bundled configuration.** Its
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
./scripts/setup.sh --source
./scripts/compose-up.sh -d --build --wait
curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://hourmere.example.com/api/health
```

In setup, accept the default `proxy` mode, explicitly enter your exact HTTPS origin (the example is
`https://hourmere.example.com`), then enter your SMTP URL and sender. Use your own hostname in
all commands. Every deployment must serve Hourmere at the root of its own host name,
without a path prefix. The bundled proxy additionally requires an HTTPS host name without
a port. Use a sender your SMTP provider accepts, for example
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

For missing sign-in mail or spam placement, follow
[email troubleshooting](/docs/troubleshooting#sign-in-emails-do-not-arrive-or-go-to-spam).

The script copies `.env.example`, generates independent `POSTGRES_PASSWORD` and
`BETTER_AUTH_SECRET` values with `openssl rand -base64 32`, and writes `.env` with mode
`600`. It never prints the secrets or overwrites an existing `.env`. Keep this file private
and out of Git; do not paste a rendered `docker compose config` into an issue. To change an
existing deployment, edit its `.env` rather than rerunning setup. The development example
`DATABASE_URL` is omitted: Compose supplies its own container database URL and password.

Setup selects both Compose files using
`COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml'`, persists
`COMPOSE_PROJECT_NAME=hourmere`, and sets `SIGNUP=first-user`
and `AUTO_MIGRATE=true`. `./scripts/compose-up.sh` then builds the checked-out application,
starts PostgreSQL 18, and applies application and job migrations before serving requests.
`--wait` waits for the app and database health checks; the curl command also checks the
public TLS/proxy path. A health response checks the process/database, not SMTP delivery or
external calendar access. For an independent installation, choose a unique lowercase project
name before setup, for example `COMPOSE_PROJECT_NAME=hourmere-staging ./scripts/setup.sh --source`.
Run every later Compose command from that checkout so it reads the persisted project and
file selection. Avoid exporting a conflicting `COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` in
your shell, which would override `.env`.

Open `https://hourmere.example.com/sign-in` and sign in immediately with your own email. There
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
applies to existing invitations too. The inviter must also still belong to the invitation's
team; demotion while retaining membership preserves eligibility. Otherwise the invitation
grants no registration exception or sign-in email to an ineligible address.
Registration authority is non-transitive: an invitee outside those domains cannot admit
another address by creating a team and inviting it;
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

## Turn off app installation

App installation and the static offline shell are enabled by default. To disable them,
set `VITE_PWA_ENABLED=false` in the repository-root `.env`, then rebuild and redeploy your
source installation:

```sh
./scripts/compose-up.sh -d --build --wait
```

Compose passes this setting to the Docker build as `VITE_PWA_ENABLED`; `.env` stays outside
the image build context. A shell-exported value overrides `.env`, so remove any conflicting
export before building. Empty or omitted means the current default (`true`); only `true`
and `false` are otherwise accepted. Invalid values fail the build with an error naming the
setting. Leave the example value empty if the installation should follow future defaults.

Direct web builds also read the root `.env`. To override it for one build, use
`VITE_PWA_ENABLED=false npm run build --workspace @hourmere/web`, then deploy that output.
A direct image build requires `docker build --build-arg VITE_PWA_ENABLED=false -t hourmere:local .`,
then deployment of that image. A prebuilt image's setting is fixed at build time; changing
only its runtime environment cannot disable PWA support. There is no runtime off switch
for image installs. `docker-compose.image.yml` pins the published image, ignores
`APP_IMAGE`, and disables builds, so tagging a replacement `hourmere:local` or adding
`--build` while keeping that overlay does not replace the served app.

To convert an existing image install, first follow the backup and version-selection steps
in [upgrade and roll back](#upgrade-and-roll-back), retaining the source checkout matching
the deployed release. Before editing `.env`, set the shell's `HOURMERE_VERSION` to the
exact version of the currently running image (without the tag's leading `v`) and verify
that the checkout is at that release tag:

```sh
test "$(git describe --tags --exact-match --match 'v[0-9]*')" = "v$HOURMERE_VERSION" ||
  { echo 'Stop: the checkout is not at the running release tag.' >&2; false; }
```

Stop if the check fails: older code must not run against a newer database schema.
After the check succeeds, in your existing private `.env`, remove only
`docker-compose.image.yml` from `COMPOSE_FILE`, preserving the base file, proxy, worker
and any custom overlays. Unset `HOURMERE_VERSION` in both `.env` and the shell so a
separate worker also uses the local image; clear any shell-exported `COMPOSE_FILE` so
Compose reads the edited list. Set `VITE_PWA_ENABLED=false`, then use the source rebuild
command above to deploy all roles. Do not rerun `setup.sh --source` over an existing
installation: setup refuses to overwrite `.env`. Retain your secrets, project name and
volumes, and use the documented backup/restore procedure if a deployment fails.

The disabled build stops registering workers but keeps `/app/sw.js` available as a minimal
retirement worker. Existing clients receive it at their next online worker update check:
it activates, deletes only Hourmere app-shell caches and unregisters itself, without
intercepting requests or forcing a page reload. Browser update timing varies; offline
clients cannot receive it until they reconnect. Keep serving this worker for returning
clients instead of deleting the endpoint. Already open pages may remain controlled until
they close or reload. The change does not delete cookies or remove installed icons; users
can uninstall those through the browser or operating system. Set the value back to `true`
or empty and rebuild/redeploy to enable installation again. See the
[install guide](/docs/install-app) for device sign-in limitations and offline behavior.

## Google sign-in and calendar publishing

To add the **Continue with Google** button, follow the
[step-by-step client setup](/docs/configuration#sign-in-with-google). Sign-in requests only
`openid`, `email` and `profile`; connecting Google Calendar requires its own OAuth client
and consent.

External Google projects in **Testing** issue non-basic calendar refresh tokens that expire
after **7 days**, causing weekly disconnections. Google's official
[expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
explain the basic identity-scope exception. For ongoing calendar use, publish **In production**.
External unverified apps requesting sensitive or restricted scopes still show an
**unverified app warning screen** and have a **100-user cap**; see Google's
[app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).
Any required sensitive-scope verification is your responsibility as the self-hoster for
your own project. Follow the [Google Calendar publishing guide](/docs/google-calendar#publishing-status-and-verification)
for verification requirements, exceptions and reconnecting expired grants.

## CalDAV foundation

CalDAV connections are not available in the app yet. The
[design and foundation](https://github.com/hourmere/hourmere/blob/main/docs/caldav.md)
provides encrypted credentials and guarded discovery for later integration, with no
busy-time synchronization or booking writes. Relative discovery hrefs resolve against
the request URI, including nested endpoints that respond without redirects. Internal
decrypted credentials hide usernames and passwords from routine serialization and
spread/clone copies; explicit field reads remain sensitive. Raw caller inputs are not
protected by that wrapper. Real-provider compatibility testing is still pending.

Future CalDAV workers will need outbound DNS and verified HTTPS to the calendar server;
no new inbound port is needed. For private Nextcloud installations, the internal
interface accepts trusted operator host/port or private-network exceptions. These are
not application settings yet, and `WEBHOOK_PRIVATE_TARGETS` remains webhook-specific.
Private exceptions do not bypass TLS verification, allow cloud metadata/link-local
addresses, or authorize sending passwords to another origin. Use a certificate trusted
by the process; there is no “ignore certificate errors” option. Apply narrow egress
rules and, when configuration is introduced, keep web and worker policy consistent.

## Private identity providers (reserved)

Organization SSO is not available yet. `SSO_PRIVATE_TARGETS` is reserved for identity
providers on a private network or on a port other than 443, and is empty by default; leave
it empty unless you prepare for a later release. It accepts only exact `host:port` entries,
permits private routing or a public non-default port for exactly those entries but never
plain HTTP, and is separate from `WEBHOOK_PRIVATE_TARGETS`. An invalid value stops startup;
a valid one changes nothing yet. See the
[configuration reference](/docs/configuration#private-identity-providers).

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
filter replaces the complete request URI with `REDACTED` and deletes request
headers and response headers (a redirect `Location` can repeat the URI), including on
upstream errors. This also protects encoded capability paths
and query strings. Retain this filter when customizing the root `Caddyfile`; the upgrade
helper reads that same file without rewriting operator customizations. Review upstream
filter changes alongside your edits before starting a new revision. Use
`./scripts/compose-up.sh` after edits so the running proxy loads them; a direct
`docker compose up` does not refresh the content digest. Configure the same URI,
request-header and response-header protections on any existing proxy.

For your own proxy or CDN, redact capabilities in both access and error logs, including
upstream failures: the segment after `/waitlist/` on personal and team booking suggestions
(`/{handle}/{slug}/waitlist/{entryId}.{token}/...` and
`/team/{teamSlug}/{slug}/waitlist/{entryId}.{token}/...`), and the token after `/book/`
on `/book/{token}`, `/embed/book/{token}` and `/api/v1/book/{token}/...`. Cover encoded
path segments as well as query strings, capability-bearing headers and response `Location` headers. Omitting the entire
request URI, as the bundled proxy does, avoids missing an encoded variant.

If you already operate a proxy, select `plain` during setup. This selects only
[`docker-compose.yml`](https://github.com/hourmere/hourmere/blob/main/docker-compose.yml), which publishes `127.0.0.1:${PORT:-3000}:3000`; PostgreSQL remains
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
./scripts/compose-up.sh -d --build --wait
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
and `./scripts/compose-up.sh -d --wait`. Verify HTTPS health, sign-in and a booking before
reopening traffic. Do not recreate or delete the database volume. If the old installation
used a custom Compose override, carry its settings over deliberately; `.env` entries alone
do not forward arbitrary server variables. If resizing an already deployed `/29` ingress
network, stop app/worker/proxy, remove only that project's obsolete ingress network, then
start again; Docker cannot resize an existing network. Keep database volumes intact.

## Follow-up host notes

Self-hosting enables host-written follow-up notes by default. They are sent from your
instance's mail domain to invitee and guest addresses that Hourmere has not verified.
To disable note writes and omit even previously saved notes from outgoing follow-ups,
set `FOLLOW_UP_HOST_NOTES_ENABLED=false` in the deployment's private `.env` or process
environment. Built-in follow-up mail still sends, and stored notes are retained.

Hourmere Cloud must explicitly use `FOLLOW_UP_HOST_NOTES_ENABLED=false` before exposing
notification writes to tenants, and keep it disabled until reviewed host eligibility,
recipient consent and complaint controls are implemented. Existing mail-volume limits do
not provide those controls. Set the same value on every web and worker process, including
the combined `all` role, and recreate all affected processes together. The bundled Compose
worker inherits it from the app; supply it to both roles in a custom deployment. See the
[configuration reference](/docs/configuration#email-and-registration) and
[host-note abuse policy](/docs/notifications#host-notes-and-hosted-email-abuse-controls).

## Run workers separately

The default `HOURMERE_ROLE=all` runs the API, booking email jobs and calendar synchronization
in one container. After setup, run these commands from the deployment checkout.
In every guarded block below, plain mode requires removing both lines of the proxy
verification (the `grep -qx proxy` line and its following failure-message line) before
pasting:

```sh
(
  unset COMPOSE_FILE &&
  ./scripts/enable-worker.sh &&
  compose_services=$(docker compose config --services) &&
  { printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  ./scripts/compose-up.sh -d --build --wait
)
```

The helper rewrites only
`COMPOSE_FILE` in your private `.env`, keeps its mode `600`, and preserves the existing
proxy selection. It accepts quoted, unquoted and `export COMPOSE_FILE=` assignments, adds
the setting if missing, and can be run again safely. It refuses a symlink `.env`.
A shell-exported `COMPOSE_FILE` overrides `.env`. Each guarded block unsets it only inside
its own subshell; standalone Compose commands need their own `unset COMPOSE_FILE` so they
read `.env` too.

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
jobs; no separate role edit or change to [`docker-compose.yml`](https://github.com/hourmere/hourmere/blob/main/docker-compose.yml) is needed. The worker uses
the same image, environment and secrets as the base app, and its port stays unpublished.
A web-only deployment needs a running worker for queued sign-in email, booking email and
calendar updates. The worker exposes only `/api/health` for health checks. Keep web and
worker on the same version and secrets. Development's [`docker-compose.dev.yml`](https://github.com/hourmere/hourmere/blob/main/docker-compose.dev.yml) and
`hourmere-dev` project remain independent of this production selection.

If moving from the old commented worker block, follow
[Upgrading from a pre-1.0 checkout](#upgrading-from-a-pre-10-checkout) before changing the source revision.

### Switch back to a single container

Remove the worker container while the overlay is still selected:

```sh
unset COMPOSE_FILE && docker compose rm -sf worker
```

Remove any old `HOURMERE_ROLE=web` setting from `.env`. Then deselect the overlay with the helper:

```sh
(
  unset COMPOSE_FILE &&
  ./scripts/disable-worker.sh &&
  compose_services=$(docker compose config --services) &&
  { ! printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "Worker service is still enabled; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  ./scripts/compose-up.sh -d --build --wait
)
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
(
  unset COMPOSE_FILE &&
  compose_services=$(docker compose config --services) &&
  { printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  ./scripts/compose-up.sh -d --build --wait
)
```

Create a webhook endpoint using
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
commit, the host `Caddyfile` (including operator customizations), and Caddy's data/configuration.
Protect backups as sensitive data. Preserve all
signing/encryption keys: for example, losing `CALENDAR_ENCRYPTION_KEY` makes saved calendar
tokens unreadable. The saved `.env` includes `COMPOSE_FILE`, so the backup also records
whether the tracked worker overlay is enabled. Do not generate replacement secrets during
a restore.

For the default HTTPS deployment, stop the app before taking a logical custom-format dump.
Stop any separate worker too. The database stays running; these commands do not remove
volumes. Store the backup outside the checkout:

```sh
(
  umask 077 &&
  unset COMPOSE_FILE &&
  backup_dir="$HOME/hourmere-backups/$(date -u +%Y%m%dT%H%M%SZ)" &&
  mkdir -p "$backup_dir" &&
  compose_services=$(docker compose config --services) &&
  if printf '%s\n' "$compose_services" | grep -qx worker; then
    docker compose stop worker
  fi &&
  docker compose stop app proxy &&
  docker compose exec -T db pg_dump -U hourmere -d hourmere -Fc > "$backup_dir/hourmere.dump" &&
  install -m 600 .env "$backup_dir/.env" &&
  install -m 600 Caddyfile "$backup_dir/Caddyfile" &&
  git rev-parse HEAD > "$backup_dir/commit" &&
  docker compose cp proxy:/data "$backup_dir/caddy-data" &&
  docker compose cp proxy:/config "$backup_dir/caddy-config" &&
  ./scripts/compose-up.sh -d --wait &&
  printf '%s\n' "$backup_dir"
)
```

The chained commands stop on failure, and the subshell leaves your operator shell open.
The final line prints the backup directory after a successful restart. Check that the
backup succeeded before continuing. For plain mode, stop only `app` and
omit the two proxy-copy commands. A dump exports one database, not cluster roles. Keep
successful copies encrypted off-host, set a retention schedule (for example, seven daily
and four weekly copies), monitor backup failures and periodically test a restore. PostgreSQL
volumes are persistent storage, not a backup.

If backup fails after stopping the app, proxy or worker and before the final restart,
those services remain stopped. A failed restart may leave some services unhealthy.
Inspect the failed command and partial backup, fix the cause, then resume the existing
deployment from its checkout:

```sh
unset COMPOSE_FILE && ./scripts/compose-up.sh -d --wait
```

Treat the partial backup as incomplete and take a new successful backup before continuing.

Set `backup_dir` to the chosen backup directory before running the restore commands; the
backup block keeps its variables inside its subshell.

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
install -m 600 "$backup_dir/Caddyfile" Caddyfile
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
unset COMPOSE_FILE
docker compose up -d --wait db
docker compose exec -T db \
  pg_restore -U hourmere -d hourmere --exit-on-error --single-transaction < "$backup_dir/hourmere.dump"
docker compose exec -T db \
  psql -U hourmere -d hourmere -Atc 'SELECT count(*) FROM auth."user";'
```

Restore the saved host `Caddyfile` before creating the proxy so operator customizations are
preserved; the `/config` volume does not contain this bind-mounted source file. For older
backups without a saved `Caddyfile`, recover the operator's copy separately before continuing.
Use the checked-out revision's file only if the deployment never customized it.

The separate `APP_IMAGE` tag also prevents restore builds from replacing the original deployment's
local image tag. Compare the count with your expected account data, and inspect other
expected records privately. Persisting `COMPOSE_PROJECT_NAME=hourmere-restore` ensures later
backup, upgrade and log commands in this checkout target the restored project too. These
assignments also work with backups from before the deployment settings existed, provided
the selected source revision contains [`Caddyfile`](https://github.com/hourmere/hourmere/blob/main/Caddyfile) and [`docker-compose.proxy.yml`](https://github.com/hourmere/hourmere/blob/main/docker-compose.proxy.yml). If the
backup commit predates this kit, select a reviewed newer revision containing these files
instead of that old commit before using the HTTPS commands; startup will apply its pending
migrations, so retain the original dump for rollback. The rewrite preserves only the exact
`docker-compose.worker.yml` filename in a `COMPOSE_FILE=` assignment, including setup's
quoted values. It does not recognise `./docker-compose.worker.yml` or
`export COMPOSE_FILE=` forms. Before running the rewrite, replace those forms with the
complete quoted line for your deployment shown under [Run workers separately](#run-workers-separately).
For backups with a separate worker, verify the rewritten selection before starting any app
or worker. For plain mode, remove both proxy-verification lines and the trailing `&&` on
the worker-verification failure-message line, since the worker check becomes the final
command:

```sh
(
  unset COMPOSE_FILE &&
  compose_services=$(docker compose config --services) &&
  { printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; }
)
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
unset COMPOSE_FILE
docker compose build
docker compose create proxy
docker compose cp "$backup_dir/caddy-data/." proxy:/data
docker compose cp "$backup_dir/caddy-config/." proxy:/config
compose_services=$(docker compose config --services) &&
docker compose up -d --wait app db &&
if printf '%s\n' "$compose_services" | grep -qx worker; then
  docker compose up -d --wait --no-deps worker
fi &&
docker compose up -d --wait --force-recreate --no-deps proxy
```

Starting app/database and the selected worker explicitly leaves the proxy untouched
until the final command, preserving its restored certificate/data volumes and avoiding
a second restart. The last command briefly restarts only the proxy and binds the restored
host `Caddyfile`, including when the backed-up revision predates the upgrade helper. For plain mode, omit
it and remove the preceding `&&`.

Keep the free `PROXY_SUBNET`, `PROXY_IP` and `PROXY_DYNAMIC_RANGE` selected before the
database restore; overlapping ingress networks cannot coexist. Plain mode omits the proxy
restoration. Verify health, expected data, sign-in and a booking before
reopening traffic. Keep the old volumes and backup until recovery is accepted.

## Upgrade and roll back

The November 2026 security update pins the Better Auth family, including its schema
CLI, to 1.7.16. This is the smallest release containing the published November 3
security fixes, including [unverified sign-in email claims](https://github.com/better-auth/better-auth/security/advisories/GHSA-9hm7-xhfp-cx58),
[cached session revocation](https://github.com/better-auth/better-auth/security/advisories/GHSA-fvxx-76fc-893x),
[padded organization roles](https://github.com/better-auth/better-auth/security/advisories/GHSA-c85h-5mrr-mgx4),
[invitations accepted by an unverified account](https://github.com/better-auth/better-auth/security/advisories/GHSA-fmh4-wcc4-5jm3)
and [email-change links after an address changes hands](https://github.com/better-auth/better-auth/security/advisories/GHSA-hwq2-v29r-p69r).
Hourmere already requires a verified email before an invitation can be accepted, and it
does not enable email changes, so the last two were blocked or do not apply.
It requires no new database migration. Use the upgrade procedure below to rebuild
and restart every application role. Hourmere stores sessions in PostgreSQL and does
not enable Better Auth secondary storage or cookie caching, so there is no session
cache to migrate or clear.

Both sign-in providers now reject false email-verification claims encoded as strings.
Microsoft users whose provider does not confirm their address must use
an email link or configure the verified email claims described in
[configuration](/docs/configuration). Social token and signing-key requests now reject
HTTP redirects; provider/proxy endpoints must return their response directly.
Malformed MCP client-metadata responses return `invalid_client`. Better Auth also
restricts pending-invitation listing to roles allowed to manage invitations;
Hourmere retains its existing owner/admin management and member-only invitation policy.
The [upstream release notes](https://github.com/better-auth/better-auth/releases/tag/v1.7.16)
cover plugins that Hourmere does not enable.

Read the intended release's changes and take the backup above first. Record the current
branch name or tag before upgrading, alongside the backup's saved commit, and preserve
its `.env`, host `Caddyfile` customizations and Caddy state. Use
`git branch --show-current` for a branch, or `git describe --tags --exact-match` for a tag,
so a checkout-only rollback can return to that named revision without relying on a bare commit.
For 1.0 and later, check out the intended release tag
rather than following `main`: replace `vX.Y.Z` in the commands below with the reviewed tag.
No stable release has been published yet; these are the upgrade steps for future releases.
Keep tracked Compose files unchanged and preserve the worker selection in `.env` so the
upgrade rebuilds/recreates any separate worker. If starting from a pre-1.0 checkout, read
[its migration notes](#upgrading-from-a-pre-10-checkout) before either sequence.

Use `./scripts/compose-up.sh` in the commands below. Each invocation computes a fresh
SHA-256 of the root `Caddyfile` and supplies it to the proxy's Compose label. If the
content changed, Compose recreates the proxy and its single-file bind mount points at the
current file, whether Git replaced it or an operator edited it in place. The proxy has a
brief restart during that recreation; unchanged content does not restart it. Other
services follow Compose's usual update behavior. The helper leaves the file untouched;
retain customizations and the global privacy filter when reconciling upstream changes.
Direct `docker compose up` does not update the digest.

For operators upgrading from a release without this fix, check that the running proxy
sees the current host file by comparing the two hashes below (on macOS, use
`shasum -a 256 Caddyfile` for the host command):

```sh
sha256sum Caddyfile
docker compose exec -T proxy sha256sum /etc/caddy/Caddyfile
```

The hashes must match. If they differ, run the following from the deployment checkout,
then repeat the comparison. This briefly restarts only the proxy and also works on older
revisions without the helper:

```sh
unset COMPOSE_FILE && docker compose up -d --wait --force-recreate --no-deps proxy
```

Scoped API keys require all key-authenticating processes to use the new code. Stop every
old web/all/worker and other old process that can authenticate or write keys before
migration, then restart all roles with the new version. **Do not run old and new servers
side by side once scoped keys exist:** old code treats scoped keys as full access.
Follow backup/restore for rollback; do not simply restart an old binary against scoped
keys or rewrite them to `full`. See [API keys](/docs/api-keys#upgrade-safely).

### Single-container upgrade

The app keeps the default `all` role. From the deployment checkout:

```sh
(
  git fetch --tags &&
  git checkout vX.Y.Z &&
  unset COMPOSE_FILE &&
  compose_services=$(docker compose config --services) &&
  { ! printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "This deployment runs a separate worker; use the separate-worker upgrade."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  docker compose pull proxy db &&
  docker compose stop app &&
  ./scripts/compose-up.sh -d --build --wait &&
  curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://hourmere.example.com/api/health
)
```

If a guard, `docker compose pull` or `docker compose stop` fails after checkout,
return with `git checkout <previous branch or tag>` using the recorded name **only before
the new-version `docker compose up` command runs**. Complete this rollback with the
[pre-start recovery block](#checkout-only-recovery-before-startup) below, including its
proxy recreation, even if the app and worker were never stopped.
Once that `up` is attempted, follow [Back up and restore](#back-up-and-restore), even if
it fails: a new app or worker may already have applied migrations; old code against the
new schema is unsafe.

### Separate-worker upgrade

From the deployment checkout, verify both the worker and the bundled HTTPS proxy before
stopping the old app and worker:

```sh
(
  git fetch --tags &&
  git checkout vX.Y.Z &&
  unset COMPOSE_FILE &&
  ./scripts/enable-worker.sh &&
  compose_services=$(docker compose config --services) &&
  { printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  docker compose pull proxy db &&
  docker compose stop app worker &&
  ./scripts/compose-up.sh -d --build --wait &&
  curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://hourmere.example.com/api/health
)
```

If a guard, `docker compose pull` or `docker compose stop` fails after checkout,
return with `git checkout <previous branch or tag>` using the recorded name **only before
the new-version `docker compose up` command runs**. Complete this rollback with the
[pre-start recovery block](#checkout-only-recovery-before-startup) below, including its
proxy recreation, even if the app and worker were never stopped.
Once that `up` is attempted, follow [Back up and restore](#back-up-and-restore), even if
it fails: a new app or worker may already have applied migrations; old code against the
new schema is unsafe.

Git does not undo [`enable-worker.sh`](https://github.com/hourmere/hourmere/blob/main/scripts/enable-worker.sh)'s private `.env` edit. Before checking out the prior
revision, restore only the pre-upgrade `COMPOSE_FILE` assignment from the saved private
`.env` (remove the assignment if it was absent), preserving the proxy/custom overlays
and other current settings. If a worker was already selected before the upgrade, keep
that selection.

### Checkout-only recovery before startup

In the supplied Compose files, `AUTO_MIGRATE=true` runs application and pg-boss migrations
at process startup for every role (`all`, `web` and `worker`), not during `pull` or `stop`;
there is no separate migrate service. The separate worker uses the same server entry point
and can migrate as soon as it starts, including before the web app during `up`. A separately
started new-version worker, `npm run db:migrate` or a custom migration job can migrate earlier;
if any has started, use [Back up and restore](#back-up-and-restore) even before this Compose `up`.

For a pre-start failure, if the app or worker was already stopped (including a partial
`stop` failure), bring the old version back with the block below after restoring the
pre-upgrade `COMPOSE_FILE` selection as described above. Replace `PREVIOUS_BRANCH_OR_TAG`
with the recorded name. Run the block even if no service was stopped: checkout can replace
the host Caddyfile while the running proxy still holds its old inode. The block uses the
existing old application image; do not add `--build` or pull an application image during
this recovery. The subshell clears an inherited `COMPOSE_FILE` so Compose reads the
restored selection from `.env`, and a failed checkout prevents startup.

```sh
(
  git checkout "PREVIOUS_BRANCH_OR_TAG" &&
  unset COMPOSE_FILE &&
  compose_services=$(docker compose config --services) &&
  docker compose up -d --wait app db &&
  if printf '%s\n' "$compose_services" | grep -qx worker; then
    docker compose up -d --wait --no-deps worker
  fi &&
  docker compose up -d --wait --force-recreate --no-deps proxy
)
```

Starting app/database and the selected worker explicitly leaves the proxy untouched
until the final command, avoiding a second HTTPS interruption. Named certificate and
data volumes are preserved. The explicit final proxy recreation works even if the old
revision has no upgrade helper, and briefly interrupts HTTPS while binding that revision's actual host `Caddyfile`. For
plain mode, omit the final command and remove the preceding `&&`.

For plain mode, remove both lines of the proxy verification before pasting either
sequence, pull only `db`, and use your deployment's health URL.

No public image can currently be pulled as a substitute for building the source.
Plain mode pulls only `db`. Caddy is pinned to the `2.11` minor line (`caddy:2.11-alpine`),
and PostgreSQL to major 18 (`postgres:18-alpine`): pulling refreshes their patch/security
updates, then `up` recreates affected containers. Review Caddy releases and deliberately
test newer minor versions before updating that pin; review PostgreSQL release notes before
patch updates, and plan a separate database migration for a future major upgrade. Container
image updates are separate from host apt updates. Rebuild any separate worker too.

**Before starting a version whose migrations drop columns, stop every old app and worker
process**, including processes on other hosts or outside this Compose project. The sequences
above stop the Compose roles before new startup migrations; stop separately managed
processes explicitly before the new app or a manual migration runs. Restart every role with
the same upgraded code after migration; do not run old and new versions together across a
column drop.

Future column removals use two phases: release N stops writing the column, and release N+1
drops it. Review each release's migration and upgrade notes even with this policy; schema
downgrade remains unsupported.

`AUTO_MIGRATE=true` applies pending application and job migrations on startup; applied
migrations have checksums and must not be edited. Keep the same secrets across upgrades.
PostgreSQL password changes in `.env` do not change an already-initialized database role's
password.

Schema downgrade is not automatic. An old application image may not work against the new
schema. After new-version startup or an earlier migration, stop all app/worker processes
and restore the pre-upgrade database
into a fresh volume, restore its original revision and configuration, then verify the result
before switching traffic back. Recovery loses writes made after that backup; decide your
maintenance window and recovery plan before upgrading.

### Upgrading from a pre-1.0 checkout

Before moving an early `main` checkout to a release tag, check the historical migration
notes below. To continue tracking pre-1.0 `main` instead, replace `git fetch --tags` and
`git checkout vX.Y.Z` in the appropriate guarded sequence with `git pull --ff-only`;
retain the remaining verification, stop, build and health steps.
For a failed main-tracking update, the backup's saved commit identifies the exact pre-upgrade
revision: `git pull` advances `main`, so its branch name alone does not undo the update.
Apply the same checkout-only limit above; otherwise use backup/restore. If rollback leaves
this `main`-tracking checkout detached, run `git switch main` before the next upgrade so
`git pull --ff-only` works.

**Migration 0040 requires stopping all old senders to enforce the mail budgets.** Build
first, stop every old `web`, `all` and `worker` process (including any on other hosts), then
start all roles with the upgraded code: build → stop app (and any separate worker) → up.
With Compose, run `docker compose build`, `docker compose stop app`,
`docker compose stop worker` if configured, then `./scripts/compose-up.sh -d --wait`.
Leave PostgreSQL running. With `AUTO_MIGRATE=true`, the first new process applies
`0040_notification_mail_limits.sql` on startup. Mixed old/new processes are
schema-compatible during the switch: old inserts default to `outcome = 'sent'` and NULL
`suppression_reason`, and old reads filter `outcome = 'sent'`. Old workers would still send
without being counted or enforcing the new limits, so all old senders must stop before
new processes start. The unchanged backfill counts legacy sends toward the instance cap,
but their old hashes do not match the new keyed recipient counters; that recipient-window
gap lasts at most 24 hours, and ledger rows are purged after two days. See
[email abuse controls](/docs/notifications#email-abuse-controls).

**Migration 0039 requires stopping all old processes; do not use a rolling deployment.**
Before any new process applies `0039_calendar_busy_all_day_dates.sql`, stop every old `web`,
`all` and `worker` process, including any on other hosts. With Compose, run
`docker compose stop app` and, if the separate worker is configured, `docker compose stop worker`.
Leave PostgreSQL running, then start every role with the upgraded code and let Google
calendar re-sync complete before relying on affected hosts' availability. With
`AUTO_MIGRATE=true`, the first new process applies the migration on startup. Snapshot
version 2 makes mixed versions fail closed for affected hosts; round-robin pools can still
offer fresh slots from other hosts. See the
[Google busy-time upgrade notes](/docs/google-calendar#busy-time-and-recurring-event-synchronization).

**Migration 0038 requires stopping all old processes; do not use a rolling deployment.**
Before any new process applies `0038_booking_ical_identity.sql`, stop every old `web`, `all`
and `worker` process, including any on other hosts. With Compose, run
`docker compose stop app` and, if the separate worker is configured, `docker compose stop worker`. Leave
PostgreSQL running, then apply the migration and start every role with the new code. With
`AUTO_MIGRATE=true`, the first new process applies the migration on startup. See the
[calendar identity migration notes](/docs/notifications#identity-and-recipients).

Migration `0037_conference_pending_timeout.sql` is the project's first column drop:
old versions still write the removed `booking_conferences.retry_conference` column.
Stop every old app and worker before it runs, then restart every role with the upgraded
code. See the [0037 migration notes](https://github.com/hourmere/hourmere/blob/main/packages/db/migrations/0037_conference_pending_timeout.md).

**If you uncommented the old worker block in [`docker-compose.yml`](https://github.com/hourmere/hourmere/blob/main/docker-compose.yml), migrate it before
changing revisions.** Those tracked edits make `git pull --ff-only` refuse the upgrade
and can prevent checking out a release tag. If your checkout already has
[`scripts/enable-worker.sh`](https://github.com/hourmere/hourmere/blob/main/scripts/enable-worker.sh), run it first. Otherwise replace or add the
complete `COMPOSE_FILE` line in `.env` before restoring the tracked file. For bundled HTTPS:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml'
```

For plain mode:

```dotenv
COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml'
```

Keep any additional custom overlays within the quotes. Then restore the tracked Compose
file before changing revisions:

```sh
git restore docker-compose.yml
```

Restoring the Compose file without selecting the worker overlay leaves the old worker
container orphaned on the old image, and the app may remain web-only if `.env` still sets
`HOURMERE_ROLE=web`. Select the overlay before restoring so the upgrade recreates both
services on the new image. Installations already using the tracked overlay skip this legacy
restoration step.

## Logs, health and host hardening

Use `docker compose ps`, `docker compose logs --tail=100 app`,
`docker compose logs --tail=100 proxy` and `docker compose logs --tail=100 db` for service
status and startup failures. `docker compose logs -f app` follows app/jobs output. Do not
share log-email links or secrets. The health URL is `GET /api/health` on the public origin;
verify it after deployments and monitor failures externally.

Use [Troubleshooting](/docs/troubleshooting) for email/worker failures, Caddy certificates,
AAAA records and unsupported connection poolers.

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

For example, in [Zoho Mail's filter-based forwarding settings](https://www.zoho.com/mail/help/email-forwarding.html),
open **Settings → Filters → New Filter**, set the tested conditions and select **Forward to**
with the verified host address. Save the filter and keep the original message. For dedicated
whole-mailbox forwarding, open **Settings → Mail Accounts → Forwards** and leave
**Delete original email copy after forwarding** unchecked; this setting belongs to the
whole-mailbox forwarding page.
Monitor forwarding health; Zoho can disable forwarding after repeated delivery failures.

Test accept, tentative and decline, then a reply after
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

## SMS foundation

An optional [operator-configured Twilio provider](/docs/sms-provider) supplies internal
SMS sending with durable per-number, instance and organization limits. Costs are billed
to your Twilio account. There are no user-facing SMS reminders or workflow actions yet;
no SMS sending jobs or status callback endpoint are enabled by configuration.
