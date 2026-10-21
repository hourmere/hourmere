---
title: Troubleshooting
description: Diagnose self-hosted email delivery, worker, HTTPS, DNS and database problems.
---

Run these checks from your deployment checkout so Docker Compose reads the same private
`.env` and project selection used at startup. Start with [logs and health](#read-logs-and-check-health),
then follow the relevant symptom below. See [self-hosting](/docs/self-hosting) for installation
and [configuration](/docs/configuration) for environment variables.

## Sign-in emails do not arrive or go to spam

1. Check the recipient's spam folder and your SMTP provider's delivery, rejection and
   suppression records. An accepted SMTP message is not a guarantee of inbox placement.
2. Check [registration policy](/docs/configuration#email-and-registration). Existing accounts
   can sign in, but a new address must be eligible under `SIGNUP`, `SIGNUP_ALLOWED_DOMAINS`
   or the invitation exception. Ineligible addresses receive the same response without mail.
3. Confirm `SMTP_URL` and `MAIL_FROM` are set on the process that runs jobs, and recreate
   affected containers after changes. Without SMTP, Hourmere prints delivered sign-in links
   to private app/worker logs instead of sending them. Anyone who reads a link can sign in;
   configure real SMTP before inviting users. Remote SMTP requires TLS/STARTTLS, and special
   characters in URL credentials must be percent-encoded.
4. Use a transactional email provider and a verified sending domain you control. Set
   `MAIL_FROM` to an address that provider authorizes, such as `Hourmere <bookings@example.com>`.
   Do not use `@gmail.com`, `@outlook.com`, `@yahoo.com` or another consumer domain as the
   sender through an unrelated relay: you cannot configure that domain's authentication.
5. Publish the provider's **SPF**, **DKIM** and **DMARC** records in your sending domain's DNS.
   SPF must include your actual senders; enable DKIM signing at the provider. Check a received
   message's authentication results and ensure the From domain aligns with the SPF or DKIM
   domain for DMARC. Follow your provider's exact record values and
   [Google's email sender guidelines](https://support.google.com/mail/answer/81126) when testing
   Gmail delivery. Authentication improves delivery but cannot guarantee inbox placement.
6. Check that a job runner is active as described [below](#worker-is-not-running-so-no-email-is-sent).
   After repairing delivery, request a new link: its five-minute lifetime starts at the
   request, and expired links are discarded rather than sent later.

`MAIL_FROM` is also the organizer of new calendar invitations. Use a monitored mailbox that
can receive calendar replies. Avoid a Gmail/Google Workspace address, or any address
registered as a Google account, for the separate calendar-organizer concern described in
[email configuration](/docs/configuration#email-and-registration). Hourmere does not process
calendar replies automatically; follow the [calendar-reply runbook](/docs/self-hosting#handle-calendar-replies).

## Worker is not running, so no email is sent

The default `HOURMERE_ROLE=all` runs the API and jobs together. `HOURMERE_ROLE=web` only
queues jobs; it needs a separate running worker for **sign-in emails as well as booking
notifications** and scheduled calendar updates. A healthy web process alone does not show
that delivery is running.

For a separate-worker deployment, check:

```sh
docker compose ps
docker compose logs --tail=100 worker
```

Confirm the worker service is selected, running and healthy, and that it uses the same
image version, database, `PUBLIC_URL`, `BETTER_AUTH_SECRET` and mail settings as the web
process. Follow [Run workers separately](/docs/self-hosting#run-workers-separately) to select
the tracked overlay and recreate the stack. Keep the worker port private. After restoring
the worker, request a fresh sign-in link. See
[notifications and background jobs](/docs/notifications)
for delivery and retry behavior.

## Caddy cannot obtain or renew a certificate

Inspect `docker compose logs --tail=100 proxy`, then check:

1. Public DNS resolves your hostname to the server running Caddy. Remove stale records and
   allow DNS changes to propagate; a local hosts-file entry does not change public DNS.
2. **TCP ports 80 and 443** reach Caddy from the internet. Check the host firewall, VPS
   firewall/security group, and any router forwarding. Ensure another proxy or web server
   is not already listening on those ports. UDP 443 enables HTTP/3; opening it alone does
   not make the TCP certificate challenges reachable.
3. `PUBLIC_URL` is your exact HTTPS hostname origin, without a path or nonstandard public
   port for the bundled proxy. Keep Caddy's `caddy-data` and `caddy-config` volumes persistent;
   deleting certificate state is not a repair for DNS or firewall problems.

Caddy documents the [automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https)
and [common certificate/network failures](https://caddyserver.com/docs/troubleshooting).
See [proxy setup](/docs/self-hosting#proxy-behavior-and-an-existing-proxy) for the bundled
ports, persistent volumes and existing-proxy alternative.

## AAAA records and the bundled IPv4-only Caddy network

Publish **only an A record** with the bundled ingress network. Remove an AAAA record even
if the VPS has an IPv6 address: this deployment's Caddy network is IPv4-only. An unreachable
AAAA address can break certificate validation or IPv6 visitors. Even when Docker forwards
IPv6 traffic, its userland proxy can replace client addresses with the bridge gateway,
putting all IPv6 visitors in one rate-limit bucket.

IPv6 needs a custom ingress network with `enable_ipv6`, a fixed Caddy IPv6 address, both
exact Caddy addresses in `TRUSTED_PROXIES`, and independent IPv6 client-IP rate-limit testing.
Follow [Prepare the host](/docs/self-hosting#prepare-the-host) before enabling AAAA.

## Database startup fails behind PgBouncer

**PgBouncer and other connection poolers are unsupported.** Connect Hourmere directly to
PostgreSQL, as the supplied Compose file does. Connections must preserve the `search_path`
and custom `hourmere.*` startup settings used to enforce registration policy. A startup
error about missing `hourmere.*` settings often means a pooler stripped them; changing the
pool mode is not a supported workaround.

The application needs a reachable database at startup even with `AUTO_MIGRATE=false`.
Check database status and connection settings in private logs. Changing `POSTGRES_PASSWORD`
in `.env` does not change an already initialized database role's password. See
[server and database configuration](/docs/configuration#server-and-database) and
[upgrade guidance](/docs/self-hosting#upgrade-and-roll-back). Keep the database volume intact.

## Read logs and check health

```sh
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 proxy
docker compose logs --tail=100 db
curl --fail https://hourmere.example.com/api/health
```

Replace `hourmere.example.com` with your own hostname. Omit the proxy command in plain mode;
include `docker compose logs --tail=100 worker` when using a separate worker. To follow new
output, use `docker compose logs -f app` or `docker compose logs -f worker` for that role.
Look for the first startup or job failure before repeated restart messages.

`GET /api/health` checks process/database health; a worker also checks its job runtime.
The public web health endpoint does not test SMTP delivery, a separate worker or external
calendar access. After changes, verify health through your HTTPS hostname, then request a
new sign-in email and test a booking with an address you control.

Read logs privately. Never share `.env`, rendered Compose configuration, SMTP credentials,
sign-in links, booking management links or provider tokens. Remove sensitive data before
sharing diagnostics. See [logs and host hardening](/docs/self-hosting#logs-health-and-host-hardening)
for ongoing monitoring and host setup.
