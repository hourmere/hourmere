# Contributing to Hourmere

Thanks for your interest. Hourmere is maintained by one person, so the notes below are about
keeping contributions easy to review. Issues and pull requests are handled in written
English.

- **Security vulnerabilities:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Bugs and feature ideas:** open a [GitHub issue](https://github.com/hourmere/hourmere/issues/new/choose)
  using one of the templates.
- **Anything larger than a small fix:** open an [issue](https://github.com/hourmere/hourmere/issues)
  first so we can agree on the approach before you write the code.

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

The repository is one npm workspace (`apps/*`, `packages/*` and `tools/*`) with a single
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

## Database upgrade tests

`packages/db/src/upgrade-path.test.ts` runs in the unit suite and CI. It upgrades populated
databases from checkpoints 0012, 0023 and 0030, compares their `auth`/`public` schema with a
fresh install, checks data preservation and documented backfills, and verifies that running
migrations again is a no-op. New migration files are picked up automatically; never edit
merged migrations to make the test pass.

Run it locally with the database-creation account:

```sh
DATABASE_URL=postgres://hourmere:hourmere@localhost:5432/hourmere npm test -- packages/db/src/upgrade-path.test.ts --maxWorkers=2
```

The URL is used only by the throwaway-database helper to create and drop isolated databases;
the test never reads or writes application data in the named development database. Keep
pool counts bounded and close every pool in teardown; CI uses PostgreSQL's default
`max_connections=100`.

When adding tables or columns, extend the seed at a checkpoint whose schema contains them.
The early checkpoint ends at migration 0012; use a later checkpoint for newer tables, or
add a later checkpoint when needed. Seed realistic related rows through that historical
schema so subsequent migrations exercise existing data, including non-default settings and
nullable values. Preserve the snapshot of existing columns. For intentional transformations,
document the reason and assert the exact expected change or backfill instead of silently
excluding the affected columns from preservation checks. Keep migration-specific tests for
behavior that needs additional fixtures.

## Browser tests

Install Google Chrome separately if it is not already available. The Playwright suite uses
that installed browser through its `chrome` channel, with fresh isolated contexts; it does
not download a browser or use an existing profile. Build the web app, then run:

```sh
npm run build --workspace @hourmere/web
HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere npm run test:e2e
```

The bootstrap PostgreSQL account must be able to create and drop databases. Every test
creates and migrates its own disposable database, runs the real web server on a random
unused port, and closes its servers and drops the database in teardown. The bootstrap
connection is used only for database creation/deletion. There is no `DATABASE_URL` or `.env`
fallback. The fixture uses synthetic identities, closed signup and the web-only role, so
queued notifications are never delivered. Browser requests outside the two owned local
origins are blocked. No real mailbox, calendar credentials or external API is required.

`tools/e2e/specs/*.spec.ts` covers public personal/team booking, private-link rescheduling
and cancellation, a stale-form booking conflict, cross-origin popup/privacy behavior and
the account sign-in gate. Each scenario runs at desktop and mobile viewport sizes. These
are genuine SPA/HTTP/PostgreSQL flows, without API response mocks. CI runs the suite in a
separate job with its own PostgreSQL service and the runner's installed Chrome.

Traces, videos, screenshots and automatic failure DOM snapshots are disabled to keep
one-time management capabilities out of artifacts. Playwright's pinned
`PLAYWRIGHT_NO_COPY_PROMPT` switch disables fallback DOM capture. Always import `test` and
`expect` from the project fixture: its automatic teardown also removes matcher-generated
DOM diagnostics before context artifacts are finalized, keeping the failure/message/stack.
Recheck both protections when upgrading the dependency. `npm run test:e2e:privacy` uses a
non-secret DOM marker and a removed-guard control to verify actual locator assertion
failures. CI runs it after the browser suite; intentional failures are checked internally
and all probe files are deleted. Per-test artifacts under ignored `temp/` are not retained;
runner status metadata can remain. No browser artifacts are uploaded by CI. Do not enable
debugging artifacts or log request headers, management fragments or response bodies
containing capabilities. Assert capability handling as booleans rather than comparing or
printing the actual token strings.

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
- A DCO sign-off on every commit, if you are an external contributor (see below).

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

Instead, external contributors sign off their commits, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): in short, that you
wrote the change or otherwise have the right to submit it under the project's license.

- **Who signs off:** every external contributor, on every commit in the pull request. The
  sign-off must name the commit's author, with the same name and email address as the commit's
  author fields (case does not matter).
- **Who is exempt:** commits authored by Dependabot, by `adrian@cobaltmere.com` (also used by
  Cobaltmere's AI coding agents), and by the maintainer's GitHub account (ID 167077805), on
  commits made in GitHub's web UI. The account's numeric ID stays the same when its login
  changes. That code is Cobaltmere's own work, so there is no outside contribution to certify.
  The exemptions are kept in
  [`scripts/check-dco.ts`](scripts/check-dco.ts). In a pull request from a fork the exemptions
  do not apply, because anyone can put any email address on a commit.
- **Clean merge commits** need no sign-off: their tree must exactly match the conflict-free
  automatic merge of their two parents (`git merge-tree --write-tree`). The commits they
  bring in are checked on their own. A merge with extra content, conflict resolutions or
  more than two parents needs its author's sign-off, subject to the same author exemptions
  above. Neither `git merge` nor GitHub's "Update branch" button adds a sign-off by default.

CI checks this on every pull request ([`.github/workflows/dco.yml`](.github/workflows/dco.yml))
and lists each commit that is missing a sign-off.

Add the sign-off with `git commit -s`, which appends a line using your `user.name` and
`user.email`:

```text
Signed-off-by: Your Name <you@example.com>
```

Use a name you are known by and an email address you can be reached at, and commit under the
same identity so that the sign-off matches the author. Keep the line in the last paragraph of
the message, where git looks for trailers.

If you forgot, add the sign-off to your last commit with `git commit --amend -s --no-edit`, or
to every commit on your branch with `git rebase --signoff origin/main`. Both rewrite your
branch, so update the pull request with `git push --force-with-lease`; this is the one case
where rewriting a branch that is under review is fine. To check your branch before you push,
run `node scripts/check-dco.ts origin/main HEAD`.
