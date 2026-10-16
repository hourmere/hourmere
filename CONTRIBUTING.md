# Contributing to Hourmere

Thanks for your interest. Hourmere is maintained by one person, so the notes below are about
keeping contributions easy to review. Issues and pull requests are handled in written
English.

- **Security vulnerabilities:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Bugs and feature ideas:** open an issue using one of the templates.
- **Anything larger than a small fix:** open an issue first so we can agree on the approach
  before you write the code.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js at the version in [`.node-version`](.node-version) (currently 26) and Docker
for the development database.

```sh
cp .env.example .env   # set BETTER_AUTH_SECRET, e.g. `openssl rand -base64 32`
npm install
npm run db:up          # Postgres 18 on localhost:5432 (docker-compose.dev.yml)
npm run dev            # API on :3000, web app on http://localhost:5173
```

The server applies database migrations when it starts. `npm run db:down` stops the database
and keeps its data.

The repository is one npm workspace (`apps/*` and `packages/*`) with a single
`package-lock.json` at the root. Add a dependency to the workspace that uses it, e.g.
`npm install <package> --workspace @hourmere/scheduling`, and commit the updated lockfile.

## Checks

CI runs these on every pull request; run them before you push:

```sh
npm run lint        # Biome: formatting and lint rules (`npm run format` fixes most of it)
npm run typecheck
npm test            # Vitest; database tests are skipped unless DATABASE_URL is set (.env sets it)
npm run build
```

When you add a migration, apply it and regenerate the table types, then commit
`packages/db/src/tables.ts` with it (CI checks that they match):

```sh
npm run db:migrate
npm run db:types
```

## Conventions

- **API:** [docs/api-conventions.md](docs/api-conventions.md). Changes within `/api/v1` are
  additive only, and errors use the shared shape and codes described there.
- **Data:** [docs/data-model.md](docs/data-model.md). Migrations in `packages/db/migrations`
  are never edited once merged; add a new one instead.
- **Layers:** see the repository layout in the [README](README.md#repository-layout).
  `packages/core` stays free of I/O, and behavior shared by the REST API and agents belongs in
  `packages/scheduling`.
- **Style:** Biome formats and lints everything (`biome.json`); don't format by hand or
  reformat code you are not changing.
- **Tests** live next to the code as `*.test.ts`.

## Commits

- Subject in the imperative mood, about 50 characters and at most 72, no trailing period:
  "Add booking cancellation endpoint", not "Added…" or "Adds…".
- A body, wrapped at 72 characters, that explains why the change is needed when that is not
  obvious from the subject.
- A DCO sign-off on every commit (see below).

## Pull requests

- Keep each pull request small and about one thing. Split refactors, formatting and
  dependency updates from behavior changes, and leave out unrelated changes.
- Add or update tests for every behavior change, and update the docs when behavior or the API
  changes.
- Describe what changes and why, and how you tested it. The template has a checklist.
- CI must pass before review. Keep your branch current by merging `main` into it.

## License and sign-off

Hourmere is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`). Contributions are accepted under the same license (inbound = outbound).
There is no Contributor License Agreement (CLA): you keep the copyright to your work.

Instead, every commit must carry a sign-off certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): in short, that you
wrote the change or otherwise have the right to submit it under the project's license. Add it
with `git commit -s`, which appends a line using your `user.name` and `user.email`:

```text
Signed-off-by: Your Name <you@example.com>
```

Use a name you are known by and an email address you can be reached at. If you forgot, add
the sign-off to your last commit with `git commit --amend -s --no-edit`, or to every commit on
your branch with `git rebase --signoff origin/main`. Both rewrite your branch, so update the
pull request with `git push --force-with-lease`; this is the one case where rewriting a branch
that is under review is fine.
