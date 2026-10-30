# Hourmere
Open-source scheduling for people and AI agents. Self-host from source; Hourmere Cloud is coming.

> Early development. Nothing here is ready to use yet.

## Features

- Personal and team booking pages, including [collective meetings](https://hourmere.com/docs/collective-scheduling)
  and [round-robin scheduling](https://hourmere.com/docs/round-robin-scheduling).
- [Google Calendar](https://hourmere.com/docs/google-calendar) busy-time sync and booking writeback.
- [REST](https://hourmere.com/docs/rest), [MCP](https://hourmere.com/docs/mcp) and
  [CLI](https://hourmere.com/docs/cli) access for agents and scripts.
- [Booking emails](https://hourmere.com/docs/notifications), optional signed
  [webhooks](https://hourmere.com/docs/webhooks) and first-party [booking activity](https://hourmere.com/docs/analytics).

## Repository layout

| Path | What it is |
|---|---|
| `apps/server` | API server (Hono). Serves the built web app in production. |
| `apps/web` | Web app (React + Vite). Talks to the server only through the public API. |
| `apps/site` | Website for hourmere.com (Astro + Starlight): homepage, legal pages, docs. Static; not part of the Docker image. |
| `packages/core` | Scheduling logic with no I/O or framework code, such as the availability engine. |
| `packages/db` | Database access (Kysely) and SQL migrations in `packages/db/migrations`. |
| `packages/scheduling` | Service layer shared by the REST API and the MCP server: reads and writes the database, enforces permissions, throws `DomainError`. |
| `packages/auth` | Sign-in (Better Auth: email links, Google, Microsoft), sessions, organizations, API keys. |
| `packages/calendars` | Separate Google Calendar OAuth, encrypted credentials, incremental busy-time sync and booking writeback. See [Google Calendar](https://hourmere.com/docs/google-calendar). |
| `packages/conferences` | Independent Zoom connections and single-host automatic meetings; see [automatic Zoom](https://hourmere.com/docs/automatic-zoom), separate from sign-in. |
| `packages/mail` | Outgoing email: SMTP, or the server log when SMTP is not configured; booking email templates and calendar invitations. |
| `packages/jobs` | Background jobs on Postgres (pg-boss): typed job definitions, enqueueing inside a transaction, workers. |
| `packages/webhooks` | Optional signed organization booking webhooks, transactional delivery and bounded retries. See [webhooks](https://hourmere.com/docs/webhooks). |
| `packages/notifications` | Durable booking and sign-in email delivery, retries and the encrypted credential outbox. See [notifications](https://hourmere.com/docs/notifications). |
| `tools/api-types` | Generates the web app's API types from the server's OpenAPI document (`npm run api:types`). |
| `tools/cli` | API-key command-line client using the existing MCP tools (`npm run --silent cli -- --help`). See [CLI](https://hourmere.com/docs/cli). |

## Development

Requires Node.js 26 and Docker.

```sh
cp .env.example .env   # set BETTER_AUTH_SECRET, e.g. `openssl rand -base64 32`
npm install
npm run db:up      # Postgres on localhost:5432
npm run dev        # API on :3000, web app on http://localhost:5173
```

Without `SMTP_URL`, sign-in links are printed in the `npm run dev` output instead of being emailed.
In development anyone may sign up unless `SIGNUP` or `SIGNUP_ALLOWED_DOMAINS` is set (see Self-hosting).

Open the app at http://localhost:5173. Vite serves it and proxies `/api/` and `/sign-in/confirm` (the server's page for emailed sign-in links) to the API server (on `PORT` from the environment or `.env`, default 3000), so the browser talks to one origin, as in production. To run the two separately, start the API with sign-in links and cookies pointing at Vite (and open sign-up, as `npm run dev` does), then Vite:

```sh
PUBLIC_URL=http://localhost:5173 SIGNUP=open npm run dev --workspace @hourmere/server
npm run dev --workspace @hourmere/web
```

Signed-in pages live under `/app` (`/app/event-types`, `/app/availability`, `/app/bookings`, `/app/api-keys`, `/app/settings`); `/sign-in` stays at the top level, and the rest of the root is for public booking pages (`/{handle}/{slug}` for personal types and
`/team/{teamSlug}/{slug}` for individual, collective and activated round-robin team types). After signing in, people only return to pages under `/app`.

The web app only uses the public API (`/api/v1/*` and Better Auth's `/api/auth/*`). Its types for `/api/v1` are generated from the server's OpenAPI document: after changing a route, run `npm run api:types` (no database needed) and commit `apps/web/src/api/schema.d.ts`; CI fails if it is out of date.

Other commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run db:migrate`, `npm run db:down`, `npm run api:types`.

The website runs on its own: `npm run dev --workspace @hourmere/site` (http://localhost:4321). `npm run build` writes it to `apps/site/dist`. A small Cloudflare Worker handles the Hourmere Cloud waitlist and serves the static assets on hourmere.com and www.hourmere.com (config in `apps/site/wrangler.jsonc`). The D1 database already exists. See [website operations](docs/website.md) for local D1/form testing and the migration the lead must apply before running `npm run deploy --workspace @hourmere/site` in the Cobaltmere Cloudflare account.

The privacy policy's effective and last-updated dates and the terms' effective date share
`LEGAL_PUBLICATION_DATE` in `apps/site/src/data/legal.ts`, currently `2026-10-22`.
Keep that date on later deployments, including documentation and homepage changes; change it
only when publishing revised legal text. A placeholder or invalid date stops the site build.
Environment variables cannot override the source date. CI retains a fixture-date substitution
for a placeholder source date; with the current committed date, that substitution makes no
change. Its build steps restore the source with an exit trap and delete the generated site
output. Never deploy fixture output or commit a fixture date.

## Self-hosting

The Starlight documentation includes a [self-hosting guide](https://hourmere.com/docs/self-hosting),
[configuration reference](https://hourmere.com/docs/configuration),
and [REST](https://hourmere.com/docs/rest) / [MCP](https://hourmere.com/docs/mcp) quickstarts.

Requires Git, OpenSSL, Docker Engine and Docker Compose 2.24.4 or newer. Point your hostname
at the host with an A record only and allow TCP 80/443 and UDP 443 (plus SSH) before using automatic HTTPS:

```sh
git clone https://github.com/hourmere/hourmere.git
cd hourmere
./scripts/setup.sh --source
docker compose up -d --build --wait
curl --retry 20 --retry-delay 3 --retry-all-errors --fail https://hourmere.example.com/api/health
```

Accept `proxy`, enter your HTTPS origin (replace `hourmere.example.com` with your hostname),
and configure SMTP and its sender. Setup generates separate secrets directly into a mode
`600` `.env`, refuses to overwrite an existing file, and selects the optional Caddy override.
Caddy obtains/renews TLS certificates; only TCP 80/443 and UDP 443 are published, and the app trusts only
the proxy's dedicated address for forwarded client IPs. If its network overlaps an existing
network or another instance, change `PROXY_SUBNET`, `PROXY_IP` and `PROXY_DYNAMIC_RANGE` together
in `.env` before starting. **No prebuilt public image is
published yet**; Compose builds the checked-out source. Application and job migrations run
automatically (`AUTO_MIGRATE=true`). Open `/sign-in` and claim the first account immediately;
`SIGNUP=first-user` restricts later registration as described below.

Select `plain` for an existing proxy or an explicitly acknowledged private loopback trial.
It keeps the app on `127.0.0.1:3000` and PostgreSQL unpublished. For your own proxy, set its
exact address as the app sees it in `TRUSTED_PROXIES` and preserve Host/forwarded headers;
see the [self-hosting guide](https://hourmere.com/docs/self-hosting) for the complete
TLS, backup/restore, upgrade and host-hardening procedures. The default app also runs
background jobs; to split them after setup, run:

```sh
(
  unset COMPOSE_FILE &&
  ./scripts/enable-worker.sh &&
  compose_services=$(docker compose config --services) &&
  { printf '%s\n' "$compose_services" | grep -qx worker ||
    { echo "Worker service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  { printf '%s\n' "$compose_services" | grep -qx proxy ||
    { echo "Proxy service is missing; check COMPOSE_FILE before continuing."; exit 1; }; } &&
  docker compose up -d --build --wait
)
```

For plain mode, remove both lines of the proxy verification (the `grep -qx proxy` line
and its following failure-message line) before pasting the block.

The helper safely updates `COMPOSE_FILE`
in the private `.env`, preserving the proxy selection. The tracked overlay automatically
selects `web` for the app and `worker` for the separate worker, using the same image and
secrets.
The block unsets a shell-exported `COMPOSE_FILE` only inside its subshell; unset it
separately before standalone Compose commands so they read `.env` too.
The `.env` backup preserves this choice, and upgrades need no tracked Compose edits.
Give containers at least 35 seconds to stop.

Before upgrading, take a full backup and record the current branch name or tag alongside
the backup's saved commit. A checkout-only rollback with
`git checkout <previous branch or tag>` is safe if a guard, `docker compose pull` or
`docker compose stop` fails before the new-version `docker compose up` command runs.
Once that `up` is attempted, follow [Back up and restore](https://hourmere.com/docs/self-hosting#back-up-and-restore),
even if it fails: a new app or worker may already have applied migrations; old code against
the new schema is unsafe. In the supplied Compose files, `AUTO_MIGRATE=true` runs application
and pg-boss migrations at process startup for every role (`all`, `web` and `worker`),
not during `pull` or `stop`; there is no separate migrate service. A separately started
new-version worker, `npm run db:migrate` or a custom migration job can migrate earlier;
if any has started, use backup/restore even before this Compose `up`.
For a failed main-tracking pull, the backup's saved commit identifies
the exact pre-upgrade revision: `git pull` advances `main`, so its branch name alone does
not undo the update. If rollback leaves a pre-1.0 `main`-tracking checkout detached, run
`git switch main` before the next upgrade so `git pull --ff-only` works.

Git does not undo `enable-worker.sh`'s private `.env` edit. Before checking out the prior
revision, restore only the pre-upgrade `COMPOSE_FILE` assignment from the saved private
`.env` (remove the assignment if it was absent), preserving the proxy/custom overlays
and other current settings. See the [guarded upgrade procedures](https://hourmere.com/docs/self-hosting#upgrade-and-roll-back).

For a pre-start failure, if the app or worker was already stopped (including a partial
`stop` failure), bring the old version back with the block below after restoring that
selection. Replace `PREVIOUS_BRANCH_OR_TAG` with the recorded name. If no service was
stopped, only the checkout is needed. The block uses the existing old application image;
do not add `--build` or pull an application image during this recovery.

```sh
(
  git checkout "PREVIOUS_BRANCH_OR_TAG" &&
  unset COMPOSE_FILE &&
  docker compose up -d --wait
)
```

The application image retains small public attribution and booking-confirmation links to the
hosted service. `HOSTED_SIGNUP_URL` sets their destination (default `https://hourmere.com`);
there is no setting to hide them.

Set `PRIVACY_POLICY_URL` and `TERMS_URL` to your operator's absolute HTTP(S) legal-page
URLs to display them in the app. Both default to empty, which hides the corresponding
link; self-hosted installations do not inherit Hourmere Cloud's policies. The hosted
instance must explicitly set `https://hourmere.com/privacy` and `https://hourmere.com/terms`.

Team owners and admins can configure [collective meetings](https://hourmere.com/docs/collective-scheduling)
with two to eight required hosts, or [round-robin pools](https://hourmere.com/docs/round-robin-scheduling)
with one to eight hosts and explicit activation.

Website widgets support inline and popup booking; see [embedding](https://hourmere.com/docs/embedding) for the
explicit parent-origin allow list, integration snippets and privacy contract.

Responses carry security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (except explicitly approved dedicated embed pages),
a `Referrer-Policy`, and on pages a Content-Security-Policy that lets only Hourmere's own
scripts, styles and requests run. When `PUBLIC_URL` is https, browsers are also told to use
only https for that host, for a year (`HSTS_MAX_AGE`). Clients that send too slowly are
disconnected: 20 s to send a request's headers and 60 s for the whole request
(`HTTP_HEADERS_TIMEOUT`, `HTTP_REQUEST_TIMEOUT`). Idle connections stay open for 125 s
(`HTTP_KEEP_ALIVE_TIMEOUT`): keep it above your reverse proxy's idle timeout for connections to
the app, or the proxy may reuse a connection the app has just closed and answer 502. The
default is above the usual ones: nginx's upstream keepalive and AWS ALB 60 s, Traefik 90 s,
Caddy 120 s.

People sign in with a link sent by email (no passwords), or with Google or Microsoft once their
client ids are set in `.env`. Accounts are only created for email addresses the provider
confirms: for Microsoft, add the optional ID token claims `verified_primary_email` and
`verified_secondary_email` in the Entra app registration (Token configuration), or Microsoft
users get `EMAIL_NOT_VERIFIED` and have to use an email link. Until `SMTP_URL` and `MAIL_FROM` are set, the server prints each
sign-in link to its log (`docker compose logs app`), so you can sign in right after the first
start. Anyone who can read that log can sign in as anyone: configure SMTP before inviting
anyone else, and always on a hosted or internet-facing instance. The setup script requires
SMTP for public deployment; empty SMTP is accepted only for an explicitly acknowledged
private loopback trial.

`SIGNUP` decides who may create an account; existing users can always sign in. With
`first-user` (the default), the first person to sign in gets an account, and after that only
addresses in `SIGNUP_ALLOWED_DOMAINS` (comma-separated email domains, e.g.
`example.com,example.org`; exact match, so list subdomains separately). So sign in right
after the first start: the first account should be yours. `closed` allows those domains and
the invitation exception below. With an empty domain list, only invitations from the first
user admit new accounts, so bootstrap an empty instance in `first-user` mode or through an
administrator before using `closed`. `open` lets anyone who can reach the instance sign up.
A pending, unexpired team invitation allows its exact email address in either restricted
mode only if the inviter's current email domain is allowed or the inviter is the instance's
first user (the earliest remaining auth user by creation time, with user id breaking ties).
Invitation-based registration is non-transitive: an invitee outside the allowed domains
cannot admit another address by creating a team and inviting it. Team creation and invitation
acceptance grant no registration authority. These rules apply to existing invitations too,
using the current domain allowlist. Sign-up still requires proving that email address;
joining the team requires accepting the invitation separately. Expired, canceled or already
accepted invitations do not allow new accounts. A new
address that may not sign up gets no sign-in email, and the request is answered the same way
as for any other address. Every request queues an encrypted, short-lived email job before eligibility is checked by
a worker; the request does not wait for SMTP or check whether the address has an account.
Workers make at most four delivery attempts and discard expired links. Request a new link
if delivery fails. In web-only mode, a separate worker
is required for sign-in emails as well as booking notifications. Failures appear in the log
without the recipient or link.

Team invitation links open `/app/join?invitationId=<uuid>`. Sign in with the exact email
address that received the invitation; email-link and enabled social sign-in return to that
page. Signing in does not join the team: review the invitation and choose **Accept invitation**.

The signed-in header's space menu switches between **Personal** and your member organizations
and shows your role in the current space. Switching asks before discarding unsaved changes
and starts the page over in the selected space. A failed switch keeps the current page;
returning to personal after team access or active context changes shows a notice. Switching
the web app does not change an API key's organization or an existing MCP OAuth grant.

The database enforces the sign-up rules too, using settings the app passes in the `options`
startup parameter when it connects (`search_path` and `hourmere.*`), and it needs read
committed isolation (Postgres's default) or serializable. Connect the app to Postgres
directly, as the compose file does; connection poolers such as PgBouncer are not supported,
since they do not pass custom startup settings like `hourmere.*` on to Postgres. The app reads
the settings back at startup and refuses to start if they are missing.

That check looks at one connection, once, at startup: a pooler slipped in later at the same
address would turn the database's check off without notice (the app's own check still
applies). It also means the app needs the database at startup even with `AUTO_MIGRATE=false`;
if the database is down, the app exits and compose restarts it.

Sign-in links open a page with a "Sign in to Hourmere" button, and only pressing it signs
in: email security scanners that open every link (such as Microsoft Safe Links) would
otherwise use up the one-time link before the person clicks it.

Agents use API keys (`hm_…`) sent as `Authorization: Bearer <key>`. Create them on the web
app's API keys page (`/app/api-keys`), or with Better Auth's endpoints while signed in (`POST
/api/auth/api-key/create`, `GET /api/auth/api-key/list`, `POST /api/auth/api-key/delete`). The API is described at
`/api/v1/openapi.json`; its conventions are in [API conventions](https://hourmere.com/docs/api-conventions).
The same keys connect MCP clients such as Claude Code to the remote MCP server at `/mcp`; see
[MCP](https://hourmere.com/docs/mcp).

For terminal scripts, the dependency-free [CLI](https://hourmere.com/docs/cli) supports configuration discovery,
slots, booking, host history, rescheduling and cancellation with the same API key.

Organization owners can view first-party [booking activity](https://hourmere.com/docs/analytics) at
`/app/analytics`: daily creations, reschedules and actual cancellations, without visitor
tracking or attendee details.

## Integrations

Optional [independent Zoom account connections](https://hourmere.com/docs/zoom-connections)
provide a separate minimum-scope identity foundation. Explicit opt-in [automatic Zoom](https://hourmere.com/docs/automatic-zoom) supports personal and single-host team
bookings with durable reconciliation, same-meeting rescheduling and cancellation, ready-only
invitations and an optional ordinary Google calendar copy. Zoom is not a sign-in provider. See the
[Zoom account guide](https://hourmere.com/docs/zoom-connections) before configuring a real client.

Optional [automatic Google Meet](https://hourmere.com/docs/automatic-google-meet) creates one conference per explicitly opted-in individual, collective or round-robin booking, with durable pending/failure state and final invitations held until its link is ready.

## Known limitations

See the [consolidated limitations](https://hourmere.com/docs#known-limitations)
and linked operating guides before deploying:

- Public booking and sign-in pages have no CAPTCHA; invitee/guest addresses remain unverified.
  [Email abuse limits](https://hourmere.com/docs/notifications#email-abuse-controls) apply per
  instance/database; separate instances do not share budgets. Per-IP request limits remain
  in process memory.
- Microsoft Calendar lists calendars only; no busy-time sync or event writes. Microsoft sign-in and
  calendar connections have not had real-account acceptance.
- Automatic Zoom supports personal event types and individual team event types with one
  actual host; collective and round-robin event types are unsupported.
- Calendar RSVP replies are not processed; declining in a calendar does not cancel a booking.
- PostgreSQL 18+ is required; PgBouncer is unsupported.
- Hourmere must be served at the root of its own host name (no path prefix) in every deployment.
  Bundled Caddy additionally requires ports 80/443, an HTTPS host name without a port,
  and an IPv4-only ingress network.
- Rate limiting uses in-process memory; multiple web replicas multiply the limits. Run a
  single web process; a separate worker is supported.
- [Public booking pages and emails](https://hourmere.com/docs/interface-languages) support English,
  Simplified Chinese, German and French. Account and sign-in interfaces support English and
  Simplified Chinese. Missing translations fall back to English; dates follow the active locale.
- No automatic schema downgrade; some migrations require stopping all old app and worker
  processes. Review the [migration notes](docs/data-model.md#changing-the-schema).

## Contributing

Bug reports and ideas are welcome in [GitHub Issues](https://github.com/hourmere/hourmere/issues),
as are pull requests. [CONTRIBUTING.md](CONTRIBUTING.md) covers
setup, checks, conventions and the DCO sign-off; everyone follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately through the repository's
[Security tab](https://github.com/hourmere/hourmere/security) or to
[security@hourmere.com](mailto:security@hourmere.com), not in a public issue. See [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE)
