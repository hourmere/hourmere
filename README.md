# Hourmere
Open-source scheduling for people and AI agents. Self-host or use the cloud.

> Early development. Nothing here is ready to use yet.

## Repository layout

| Path | What it is |
|---|---|
| `apps/server` | API server (Hono). Serves the built web app in production. |
| `apps/web` | Web app (React + Vite). Talks to the server only through the public API. |
| `packages/db` | Database access (Kysely) and SQL migrations in `packages/db/migrations`. |

## Development

Requires Node.js 26 and Docker.

```sh
cp .env.example .env
npm install
npm run db:up      # Postgres on localhost:5432
npm run dev        # API on :3000, web app on http://localhost:5173
```

Other commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run db:migrate`, `npm run db:down`.

## Self-hosting

```sh
cp .env.example .env   # set POSTGRES_PASSWORD and PUBLIC_URL
docker compose up -d
```

The app listens on `127.0.0.1:3000` and applies database migrations on start. Put a reverse proxy with TLS in front of it.

## License

[AGPL-3.0](LICENSE)
