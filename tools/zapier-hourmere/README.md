# Hourmere for Zapier

Private Zapier Platform CLI app for Hourmere's existing REST API. **Not yet published
in the Zapier directory.** No Zapier account is needed for local tests or offline
validation. The app is deployed separately and excluded from Hourmere's Docker image.

See the [Zapier guide](https://hourmere.com/docs/zapier) for setup, examples, permissions,
signature verification, replay boundaries and sample-data limitations.

## Runtime and dependencies

Zapier runs integrations on **Node.js 22**. This package uses CommonJS JavaScript compatible
with that runtime; it does not import Hourmere's Node.js 26 server packages. Repository
development and the generated-OpenAPI contract test still use Node.js 26. Test the runtime
under Node.js 22 before uploading a version.

Both `zapier-platform-core` and `zapier-platform-cli` are pinned to **19.2.1** (released
October 14, 2026), more than two weeks before selection on November 6, 2026. CLI 19 uses
`zapier-platform`; it removed the older `zapier` command. Dependencies are recorded in
this package's committed `package-lock.json`. It is outside the root npm workspaces;
root installs do not download Zapier's Platform Agreement–licensed dependencies.
`index.js` reads `platformVersion` from the exact `zapier-platform-core` pin in
`package.json` instead of loading the package, so the root contract test runs without
the Zapier packages.
The `overrides` keep development-only transitive packages on releases at least two weeks
old; they do not change any production dependency.

Official references checked for this implementation:

- [CLI overview and Node.js requirements](https://docs.zapier.com/integrations/build-cli/overview).
- [Core API: rawRequest, subscribeData and errors](https://docs.zapier.com/integrations/build-cli/core).
- [appTester and mocked HTTP with nock](https://docs.zapier.com/integrations/build-cli/testing-and-debugging).
- [CLI commands](https://github.com/zapier/zapier-platform/blob/main/packages/cli/docs/cli.md).
- [Pinned platform release](https://github.com/zapier/zapier-platform/releases/tag/zapier-platform-core%4019.2.1).

## Local checks

The generated-OpenAPI contract test needs only the repository's root `npm ci`:

```sh
npm test -- tools/zapier-hourmere/test/contract.test.ts --maxWorkers=2 --no-fsModuleCache
```

The package's own checks need its separate install:

```sh
cd tools/zapier-hourmere
npm ci --ignore-scripts
npm test
npm run build
npm run validate
npm run build:verify
```

The test suite uses `zapier-platform-core`'s `createAppTester`, synthetic fixtures and
mocked HTTP, with real network access disabled. Contract tests generate Hourmere's OpenAPI
document without a database in the root Node.js 26 test runner. `build:verify` checks the
CLI-built production dependency tree against the package lockfile without uploading, then
deletes `build/build.zip` and `build/source.zip` whether the check passes or fails.
Validation runs with `DISABLE_ZAPIER_ANALYTICS=1` and
`NO_UPDATE_NOTIFIER=1`, using `zapier-platform validate --without-style --skip-build` to skip remote
style validation. These commands do not log in, register, push or create tokens.

## Authentication and scope

Enter your API key and required HTTPS instance origin, such as
`https://hourmere.example.com`. There is no default Cloud API URL. The connection test
requests `GET /api/v1/me`; the connection label identifies the instance.

| Operation | Allowed API key scopes |
|---|---|
| Connection test, find booking, find slots, event-type dropdown | `read`, `bookings`, `full` |
| Create booking, cancel booking, reschedule booking | `bookings`, `full` |
| Subscribe/unsubscribe all three booking triggers | `full` |

Use `read` for read-only workflows and `bookings` for booking actions. Reserve `full`
for a separate hook connection. Hook management additionally requires organization
owner/admin permissions; host booking reads and mutations require their existing host
authority. API key scope does not override membership or ownership.

Webhook `perform` verifies raw-body HMAC with the secret saved in `subscribeData`.
A one-hour timestamp tolerance accommodates asynchronous Zapier queueing after intake
has already acknowledged delivery. Valid events claim `hm:<subscription ID>:<event ID>`
atomically with Zapier's durable cache (`nx`), retained for 24 hours to cover Hourmere's
12 retries capped at one hour each, plus queueing. A refused claim (`false`) can also
mean the cache did not store it, for example under its rate limit, so the app reads the
key back: only an existing claim is a duplicate and returns `[]`. Otherwise it accepts
the event and logs `replay_cache_unavailable`. Different subscriptions retain their own
claims. Invalid deliveries return `[]` with code-only logs; stale timestamps and bad
signatures have distinct reasons. Cache outages accept authenticated events with a masked
warning to avoid losing acknowledged deliveries.
There is no exactly-once guarantee: cache outages/expiry and downstream failures still
require downstream idempotency by signed event ID. Delays beyond one hour are dropped
and cannot trigger a retry after Zapier has acknowledged intake.
The hook's polling method supplies host-visible
booking samples, not an organization-wide historical event log. See the guide for details.

## Owner-operated private deployment

These are **later operator steps**, requiring your own Zapier account and network access
to Zapier. They are not part of repository tests, builds or server deployment.

Switch only this shell to Node.js 22 after installing the package dependencies. From the
repository root, enter the package and use the locally installed, pinned CLI:

```sh
cd tools/zapier-hourmere
node_modules/.bin/zapier-platform login
node_modules/.bin/zapier-platform register "Hourmere Private"
HOURMERE_ZAPIER_PUSH_APPROVED=1 node_modules/.bin/zapier-platform push
```

Follow Zapier's prompts with your own developer account. Keep the resulting
`.zapierapprc` association and deployment credentials private and out of Git. Do not
commit `.env` files or API keys. The build hook refuses deployment builds unless
`HOURMERE_ZAPIER_PUSH_APPROVED=1` is explicitly set. Review the source and lockfile
before setting it; the variable is an operator acknowledgement, not an authorization system.

Do not run `zapier-platform upload` directly. It sends whatever `build/build.zip` holds and
runs no app hook, so the package cannot refuse it. `npm run upload` applies the same
approval check first, and `build:verify` leaves no archive behind. Use `push`.

After the first push, run the guide's one-time duplicate check before relying on
deduplication: local tests cannot show how Zapier's production cache answers.

A newly pushed integration version is private by default. Use synthetic bookings to
verify it in your own Zapier account, invite only intended testers, and keep public
publication/review as a separate owner decision. Revoking an API key stops access;
disable its Zaps first so subscriptions can be removed while the key still works.
