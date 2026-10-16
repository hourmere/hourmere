# Hourmere
Open-source scheduling for people and AI agents. Self-host or use the cloud.

> Early development. Nothing here is ready to use yet.

## Repository layout

| Path | What it is |
|---|---|
| `apps/server` | API server (Hono). Serves the built web app in production. |
| `apps/web` | Web app (React + Vite). Talks to the server only through the public API. |
| `packages/db` | Database access (Kysely) and SQL migrations in `packages/db/migrations`. |
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

## Self-hosting

```sh
cp .env.example .env   # set POSTGRES_PASSWORD, BETTER_AUTH_SECRET and PUBLIC_URL
docker compose up -d
```

The app listens on `127.0.0.1:3000` and applies database migrations on start. Put a reverse proxy with TLS in front of it.

People sign in with a link sent by email (no passwords), or with Google or Microsoft once their
client ids are set in `.env`. Until `SMTP_URL` and `MAIL_FROM` are set, the server prints each
sign-in link to its log (`docker compose logs app`), so you can sign in right after the first
start; configure SMTP before inviting anyone else.

Agents use API keys (`hm_…`) sent as `Authorization: Bearer <key>`. For now keys are created
with Better Auth's endpoints while signed in (`POST /api/auth/api-key/create`, `GET
/api/auth/api-key/list`, `POST /api/auth/api-key/delete`). The API is described at
`/api/v1/openapi.json`.

## License

[AGPL-3.0](LICENSE)
