# Hourmere
Open-source scheduling for people and AI agents. Self-host or use the cloud.

> Early development. Nothing here is ready to use yet.

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
| `packages/mail` | Outgoing email: SMTP, or the server log when SMTP is not configured. |

## Development

Requires Node.js 26 and Docker.

```sh
cp .env.example .env   # set BETTER_AUTH_SECRET, e.g. `openssl rand -base64 32`
npm install
npm run db:up      # Postgres on localhost:5432
npm run dev        # API on :3000, web app on http://localhost:5173
```

Without `SMTP_URL`, sign-in links are printed in the `npm run dev` output instead of being emailed.

Other commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run db:migrate`, `npm run db:down`.

The website runs on its own: `npm run dev --workspace @hourmere/site` (http://localhost:4321). `npm run build` writes it to `apps/site/dist`. `npm run deploy --workspace @hourmere/site` builds it and publishes it as Cloudflare Workers static assets on hourmere.com and www.hourmere.com (config in `apps/site/wrangler.jsonc`); it needs `wrangler login` to the Cobaltmere Cloudflare account.

## Self-hosting

```sh
cp .env.example .env   # set POSTGRES_PASSWORD, BETTER_AUTH_SECRET and PUBLIC_URL
docker compose up -d
```

The app listens on `127.0.0.1:3000` and applies database migrations on start. Put a reverse proxy with TLS in front of it, and set `TRUSTED_PROXIES` to the proxy's address as the app sees it (for a proxy on the host or on the compose network that is the Docker network, e.g. `172.16.0.0/12`), so rate limits apply per visitor rather than to everyone behind the proxy.

People sign in with a link sent by email (no passwords), or with Google or Microsoft once their
client ids are set in `.env`. Accounts are only created for email addresses the provider
confirms: for Microsoft, add the optional ID token claims `verified_primary_email` and
`verified_secondary_email` in the Entra app registration (Token configuration), or Microsoft
users get `EMAIL_NOT_VERIFIED` and have to use an email link. Until `SMTP_URL` and `MAIL_FROM` are set, the server prints each
sign-in link to its log (`docker compose logs app`), so you can sign in right after the first
start. Anyone who can read that log can sign in as anyone: configure SMTP before inviting
anyone else, and always on a hosted or internet-facing instance.

`SIGNUP` decides who may create an account; existing users can always sign in. With
`first-user` (the default), the first person to sign in gets an account, and after that only
addresses in `SIGNUP_ALLOWED_DOMAINS` (comma-separated email domains, e.g.
`example.com,example.org`; exact match, so list subdomains separately). So sign in right
after the first start: the first account should be yours. `closed` allows only those domains
(nobody, if the list is empty); `open` lets anyone who can reach the instance sign up. A new
address that may not sign up gets no sign-in email, and the request is answered the same way
as for any other address.

Sign-in links open a page with a "Sign in to Hourmere" button, and only pressing it signs
in: email security scanners that open every link (such as Microsoft Safe Links) would
otherwise use up the one-time link before the person clicks it.

Agents use API keys (`hm_…`) sent as `Authorization: Bearer <key>`. For now keys are created
with Better Auth's endpoints while signed in (`POST /api/auth/api-key/create`, `GET
/api/auth/api-key/list`, `POST /api/auth/api-key/delete`). The API is described at
`/api/v1/openapi.json`; its conventions are in [docs/api-conventions.md](docs/api-conventions.md).

## License

[AGPL-3.0](LICENSE)
