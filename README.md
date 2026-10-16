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
| `tools/api-types` | Generates the web app's API types from the server's OpenAPI document (`npm run api:types`). |

## Development

Requires Node.js 26 and Docker.

```sh
cp .env.example .env   # set BETTER_AUTH_SECRET, e.g. `openssl rand -base64 32`
npm install
npm run db:up      # Postgres on localhost:5432
npm run dev        # API on :3000, web app on http://localhost:5173
```

Without `SMTP_URL`, sign-in links are printed in the `npm run dev` output instead of being emailed.

Open the app at http://localhost:5173. Vite serves it and proxies `/api` to the API server (on `PORT` from the environment or `.env`, default 3000), so the browser talks to one origin, as in production. To run the two separately, start the API with sign-in links and cookies pointing at Vite, then Vite:

```sh
PUBLIC_URL=http://localhost:5173 npm run dev --workspace @hourmere/server
npm run dev --workspace @hourmere/web
```

The web app only uses the public API (`/api/v1/*` and Better Auth's `/api/auth/*`). Its types for `/api/v1` are generated from the server's OpenAPI document: after changing a route, run `npm run api:types` (no database needed) and commit `apps/web/src/api/schema.d.ts`; CI fails if it is out of date.

Other commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run db:migrate`, `npm run db:down`, `npm run api:types`.

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

Agents use API keys (`hm_…`) sent as `Authorization: Bearer <key>`. Create them on the web
app's API keys page, or with Better Auth's endpoints while signed in (`POST
/api/auth/api-key/create`, `GET /api/auth/api-key/list`, `POST /api/auth/api-key/delete`). The API is described at
`/api/v1/openapi.json`; its conventions are in [docs/api-conventions.md](docs/api-conventions.md).

## License

[AGPL-3.0](LICENSE)
