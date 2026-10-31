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

The deployment documentation's interactive PTY paste checks are skipped locally when
`zsh` or `python3` is missing from `PATH`, with a skip reason naming the missing tool.
Both are required in CI (`sudo apt-get install zsh python3` on Debian/Ubuntu); a missing
tool makes CI fail immediately.

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

All test database creation goes through `createTestDatabase` from `@hourmere/db/testing`.
It uses `hourmere_test_<tag>_<pid>_<hex>` names, connects to `postgres` for administration,
and drops a failed setup before returning. Close additional pools before calling the
owner's `drop()` in `finally` or `afterAll`; the helper force-drops lingering connections.
Vitest also registers a final cleanup hook for databases whose normal teardown failed.
That hook uses a lightweight registry, so files can mock database dependencies before
loading them. Fork workers also attempt cleanup when their parent's IPC channel disconnects,
including when only the Vitest parent receives SIGINT or SIGTERM. Signal and disconnect
cleanup are best effort, bounded to 15 seconds: forced termination, worker crashes and
unavailable PostgreSQL can still leave databases behind.

On slow machines, set `HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS` to a positive integer
number of milliseconds (at most 2147482647). It changes the helper's CREATE/ALTER
statement timeout from the default 5000 ms. DROP uses at least 30000 ms, or the configured
value when higher. Each client query timeout is its statement timeout plus 1000 ms.
The connection timeout remains 5000 ms and shutdown cleanup still has its independent
15-second deadline.

Inspect those leftovers manually (the default is **dry run**):

```sh
DATABASE_URL=postgres://hourmere:hourmere@localhost:5432/hourmere npm run db:cleanup-tests
# After reviewing the output:
DATABASE_URL=postgres://hourmere:hourmere@localhost:5432/hourmere npm run db:cleanup-tests -- --yes
```

`--admin-url <url>` overrides `DATABASE_URL`; administration always connects to `postgres`,
never `hourmere`. `--older-than-hours <hours>` changes the default 24-hour threshold (must
be positive). The script lists test databases only and skips unknown ages, databases with
connections, and names carrying a PID that is still live on this machine. Legacy names
without a PID rely on age and connection checks. Run it on the machine that created the
databases: local PID checks cannot identify processes on other hosts, and PID reuse can
conservatively retain an old database. Age uses the server's `PG_VERSION` modification
time, which can be newer after maintenance and delay cleanup. The account needs permission
to inspect that file metadata. Before dropping, the script rechecks age, connections, PID
and database OID, and uses ordinary DROP so an arriving connection prevents deletion.
Cleanup is manual; test startup never sweeps other runs' databases.
If another cleanup removes a candidate after its final recheck, the script reports
`SKIP <name>: already gone` and continues. Other database failures report only a safe
SQLSTATE code when available, without the driver's connection details.

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

CI also builds a disposable static-site fixture and checks documentation table geometry at
360px and 1280px, including page overflow, identifier line counts and mid-word header wraps.
Touch copy controls are checked at both widths. These site tests use only a local static
server, block external requests and create no database. Rendered negative controls verify
that the assertions detect the rejected wrapping, overflow and copy-button overlap. The site
tests are skipped outside CI; any local browser run requires an escalated shell. CI restores
the legal-date source and deletes the fixture output after the browser suite.

Traces, videos, screenshots and automatic failure DOM snapshots are disabled to keep
one-time management capabilities out of artifacts. Playwright's pinned
`PLAYWRIGHT_NO_COPY_PROMPT` switch disables fallback DOM capture. Always import `test` and
`expect` from the project fixture: its automatic teardown also removes matcher-generated
DOM diagnostics before context artifacts are finalized, keeping the failure/message/stack.
Recheck both protections when upgrading the dependency. `npm run test:e2e:privacy` uses a
non-secret DOM marker and a removed-guard control to verify actual locator assertion
failures. CI runs it after the browser suite; intentional failures are checked internally
and all probe files are deleted. Per-test artifacts under ignored `temp/` are not retained;
runner status metadata can remain. The required functional job uploads no browser artifacts;
the visual measurement lane below uploads only explicitly masked baselines. Do not enable
debugging artifacts or log request headers, management fragments or response bodies
containing capabilities. Assert capability handling as booleans rather than comparing or
printing the actual token strings.

### Responsive, accessibility and visual measurements / 响应式、无障碍与视觉检测

The reusable [CI workflow](.github/workflows/ci.yml) keeps exactly its existing `check`,
`cli-compatibility`, `docker` and `e2e` jobs. The separate
[UI checks workflow](.github/workflows/ui-checks.yml) runs on pull requests, pushes to main
and manual dispatches. Layout shards fail on every layout finding, scan error, browser
failure or missing report; axe fails on serious/critical violations and scan/execution
errors or missing reports. Cross-engine test failures fail the job. The layout/axe run steps
return browser failures immediately; their summaries still run and gate UI findings after
exceptions apply. Sanitized-report uploads remain advisory. Visual-baseline detection, visual
comparison and baseline generation remain advisory with `continue-on-error: true`. The workflow
is not called by CI or the release workflow and does not run on release tags.

Layout covers 16 CSS viewport sizes, light/dark, English and Simplified Chinese, plus
British English on booking. Layout and axe include the booking calendar, form, confirmation,
time-zone panel, embedded and team booking, and OAuth consent states. Axe checks WCAG
2.0/2.1/2.2 A/AA tags, records passes/incomplete and moderate/minor counts and reports
serious/critical violations.
A CI-only canary with known violations verifies the in-browser scan pipeline. Cross-engine
smoke covers booking, sign-in and the embed popup in desktop WebKit, iPhone WebKit and
Firefox. These measurements use synthetic data and the disposable-database fixture.
Every audit page pins the browser clock to the fixture's `AUDIT_NOW` before navigation,
including form submissions that create rows read by later pages. After content readiness,
audits await `document.fonts.ready` and 100 ms of stable DOM and geometry across paints;
failure to settle within five seconds is a scan error.
Browser downloads are cached by the pinned Playwright version. The system dependency check
runs even on cache hits because a browser cache does not preserve runner apt packages;
Playwright installs system packages only when its dry-run check finds packages missing.

可复用 CI 保留原有四个任务。独立的 **UI checks** 工作流在拉取请求、主分支推送和手动触发时运行，
布局、axe 严重/致命问题和跨引擎测试回归会使任务失败；视觉检测仍为建议项。
CI 和发布工作流都不调用它，发布标签不会运行这些检测。
布局检测覆盖 16 种 CSS 视口、明暗主题、中英文，预约页另测英式英语；axe 记录通过、待人工确认、
中等和轻微项数，并报告严重和致命问题；漏扫也会导致失败。
检测涵盖预约表单、确认页、时区面板、嵌入页、团队预约和 OAuth 授权页。
跨引擎冒烟覆盖 WebKit 桌面版、iPhone 预设和 Firefox 的预约、登录及嵌入弹窗。

Build the web app as above, then run from the repository root. In Codex, **every command
that launches a browser requires `sandbox_permissions: "require_escalated"`**; never run
these in its default sandbox. If escalation is denied, use CI and record the local skip.

先构建网页，再从仓库根目录运行以下命令。在 Codex 中，启动浏览器的命令必须申请提升权限；
禁止在默认沙箱运行。若提升权限被拒绝，请使用 CI，并注明本地未运行。

```sh
export HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere
(
  export HOURMERE_UI_REPORT_DIR="$(mktemp -d)"
  node tools/e2e/run-audit.ts layout --shard=1/4
  node tools/e2e/reports-summary.ts --suite=layout --shard=1/4
) # repeat 2/4, 3/4, 4/4 in new directories / 其余分片各用新目录
(
  export HOURMERE_UI_REPORT_DIR="$(mktemp -d)"
  node tools/e2e/run-audit.ts a11y
  node tools/e2e/reports-summary.ts --suite=a11y
)
npx playwright install --with-deps webkit firefox
(
  export HOURMERE_UI_REPORT_DIR="$(mktemp -d)"
  node tools/e2e/run-audit.ts cross-engine
  node tools/e2e/reports-summary.ts --suite=cross-engine
)
```

Reports go to ignored `temp/ui-audit-reports/` (override `HOURMERE_UI_REPORT_DIR`). Each
**UI checks** job appends per-page finding counts and execution status to its GitHub Actions
summary. Download the `ui-layout-*`, `ui-a11y`, `ui-cross-engine` and `ui-visual` artifacts
from that workflow run for sanitized JSON/Markdown; artifacts are retained for seven days.
The `ui-visual` artifact contains browser execution metadata only. Local masked expected,
actual and diff PNGs from failed screenshot comparisons are in `temp/ui-visual-results/`;
CI does not upload those diff images. Findings include static selector hints made from tag,
class tokens and `data-testid`, without DOM text, emails, URLs or tokens. Review missing scans,
incomplete axe results and execution errors alongside counts. Visually hidden and ellipsis
content and form-control internal scrolling are excluded from element overflow, which reports
only the innermost cause. Intentional horizontal scrollers such as the mobile admin navigation
use `data-layout-scroll="horizontal"`; this does not excuse document overflow.

报告写入忽略目录 `temp/ui-audit-reports/`，可用 `HOURMERE_UI_REPORT_DIR` 指定位置。
CI 摘要按页面统计问题和执行状态，脱敏报告保留七天。报告不含 DOM 文本、邮箱、网址或令牌。
评审时须同时查看未完成的扫描和运行错误。预期的横向滚动容器用上述数据属性明确标记，
该标记不豁免文档级溢出。可在 **UI checks** 运行页面下载报告；视觉任务仅上传执行状态，
本地脱敏截图差异位于 `temp/ui-visual-results/`，CI 不上传这些差异图片。

Visual comparisons are skipped until reviewed PNG baselines exist in `tools/e2e/snapshots/`.
To generate them, dispatch the **UI checks** workflow on the review branch with `visual_baselines`
enabled. The Linux-only `visual-baselines` job runs `--update-snapshots` with Noto CJK,
fixed browser time, disabled animations, hidden carets and masked private fields. Download
`visual-baselines-linux`, inspect every image, then commit reviewed baselines with a DCO
sign-off. Do not commit local macOS baselines. Only masked PNG baselines are uploaded;
traces, videos and failure DOM remain disabled. Continue to run `npm run test:e2e:privacy`
when changing fixtures or Playwright. Real-device, screen-reader and pixel review remain
manual; WebKit's iPhone preset does not establish real iOS compatibility.

在已审核 PNG 基线提交前，CI 跳过视觉比较。在评审分支手动触发 **UI checks** 工作流并启用
`visual_baselines`，即可下载 Linux 生成的脱敏基线。逐张审核后以 DCO 签署提交；不要提交
macOS 本地基线。仍需人工检查真机、读屏和视觉效果，iPhone 预设不能替代真机验收。

The terminal summary gates layout and axe after every scan has reported, allowing scoped,
dated exceptions to apply without aborting the matrix early. It derives the expected report
identities from Playwright's selected matrix (`--list` with the same suite/shard), rather
than fixed counts; missing, duplicate or unexpected reports fail. Browser failures and
unreadable reports fail too. Axe `incomplete`, moderate and minor results remain informational:
summaries print their counts and rule IDs for review. Use a separate report directory for
each local lane/shard (`HOURMERE_UI_REPORT_DIR`); rerun into an empty directory so old reports
cannot mask a loss.

The summary lists the first 20 unexcepted findings with page, viewport, locale, theme,
category, axe rule ID and sanitized selector hint, followed by the remaining count.
Browser failures include the exit code and point to the measurement run-step log;
matrix-enumeration failures include the listing child's status, signal and stderr tail.

仓库中的终端汇总会核对 Playwright 实际矩阵的每项报告；缺失、重复、多余、无法读取的报告和
浏览器执行错误均导致失败。axe 待人工确认项、中等和轻微问题只显示数量和规则 ID，不阻断检测。
每次本地运行使用独立、空的报告目录，避免旧报告掩盖漏扫。

Known findings require an entry in `tools/e2e/ui-check-exceptions.json` (initially `[]`),
with exact `suite` (`layout` or `a11y`), `page`, `viewport: {width, height}`, `locale`, `theme`,
finding `category`, an axe `rule` when applicable, a nonempty `reason` and ISO `expires` date.
Unknown keys are rejected, including extra keys inside `viewport`; DOM selectors cannot
narrow an exception. Expired, invalid and stale entries fail; a stale entry no longer matches a finding in its
selected state. Each layout shard checks the exceptions for its own selected states, and
selectors absent from the full matrix fail in every shard. Scan errors, lost reports and
browser failures cannot be excepted. Legacy scan-time `a11y-exemptions.json` suppressions
are rejected by the gate; use this shared file so every accepted finding remains visible.

已知问题例外须精确指定检测、页面、视口、语言、主题及问题类别（axe 另含规则），并填写原因与
到期日。过期、无效或已不再匹配问题的例外均导致失败；扫描错误、漏扫和浏览器失败不允许豁免。

Only the repository owner decides whether to make these checks required in branch protection:
add the exact check names `e2e-layout (1)`, `e2e-layout (2)`, `e2e-layout (3)`,
`e2e-layout (4)`, `e2e-a11y` and `e2e-cross-engine` from **UI checks**. This change does
not alter repository settings; retain the four existing required CI checks and keep visual
checks advisory until reviewed baselines are committed.

## Conventions

- **API:** [API conventions](https://hourmere.com/docs/api-conventions). Changes within `/api/v1` are
  additive only, and errors use the shared shape and codes described there.
- **MCP tools:** [Adding a tool](docs/mcp-development.md#adding-a-tool) covers extensions to the
  shared MCP tool registry.
- **Data:** [docs/data-model.md](docs/data-model.md). Migrations in `packages/db/migrations`
  are never edited once merged; add a new one instead.
- **Layers:** see the repository layout in the [README](README.md#repository-layout).
  `packages/core` stays free of I/O, and behavior shared by the REST API and agents belongs in
  `packages/scheduling`.
- **Style:** Biome formats and lints everything (`biome.json`); don't format by hand or
  reformat code you are not changing.
- **Tests** live next to the code as `*.test.ts`.

### REST, MCP and CLI parity

New capabilities must be available through REST, MCP and the CLI together, with the REST
operation described in OpenAPI. The write-parity guard in
[`scripts/interface-parity.test.ts`](scripts/interface-parity.test.ts) runs in the existing
CI `check` job. It inventories every `POST`, `PUT`, `PATCH` and `DELETE` under `/api/v1`
from the server's generated `openApiDocument`, the tools registered by `productTools` in
`apps/server/src/server.ts`, and the actual `COMMANDS` table in `tools/cli/src/cli.ts`.
Read operations are outside this guard's required coverage.

When adding or changing a write operation:

1. Give the REST route a stable, unique OpenAPI `operationId` and implement the corresponding MCP
   tool and CLI command using the shared service behavior.
2. Add an entry keyed by that exact `operationId` in
   [`scripts/interface-parity.json`](scripts/interface-parity.json). Set `mcp` to the
   registered tool name and `cli` to the command name, for example:

   ```json
   "createPublicBooking": { "mcp": "create_booking", "cli": "book" }
   ```

3. For an intentional interface restriction or an existing gap, use
   `{ "exemption": "One-line concrete reason." }` instead. Explain the actual restriction
   or missing capability for that operation; blanket exemptions are not accepted. Replace
   an existing gap's exemption with a mapping when parity is implemented.
4. Update or remove the entry when the operation or either interface name changes. Run
   `npm run api:types` and commit the regenerated API types after route changes.
5. Run the guard locally:

   ```sh
   npm test -- scripts/interface-parity.test.ts --maxWorkers=2 --no-fsModuleCache
   ```

The guard reports writes missing a mapping or exemption, nonexistent MCP tools or CLI
commands, and entries for removed operations. Its negative tests inject an unmapped write
and stale mappings to verify these failures. Keep those controls when changing the guard;
do not resolve a failure by inventing an interface name or silently skipping an operation.
List existing MCP/CLI gaps and their reasons in the pull request so later work can close them.

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
