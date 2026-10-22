# Releasing

Hourmere releases are published from `main` in the public
[`hourmere/hourmere`](https://github.com/hourmere/hourmere) repository under AGPL-3.0-only.
The first stable release is planned for **2026-11-30**. Preparing or merging release files
does not publish an image, tag, package or GitHub Release.

## Versioning and release notes

Use Semantic Versioning: `MAJOR.MINOR.PATCH`, with `-rc.1` or another SemVer prerelease
suffix when needed. Push tags as `v1.0.0` or `v1.1.0-rc.1`; published image versions omit
the leading `v`. Release tags must fit the registry tag limit (128 characters without
`v`); SemVer build metadata (`+build.1`) is rejected because Docker tags cannot represent
`+` verbatim. Increase the major version for incompatible product changes, the minor
version for compatible capabilities, and the patch version for compatible fixes. The
versioned REST contract remains additive within `/api/v1`; an incompatible API change
requires a new API version too.

The root `package.json` version is the product version used by OpenAPI and MCP.
Its `version` lifecycle synchronizes the standalone CLI's packaged manifest, `server.json`
and the npm lockfile. For an approved version bump (substitute the next version):

```sh
npm version 1.0.1 --no-git-tag-version
npm run api:types
npm test -- apps/server/src/version.test.ts scripts/sync-version.test.ts scripts/release.test.ts --maxWorkers=2
```

Review and commit these metadata changes together before tagging. Release preparation
rejects a tag that differs from the root version, and CI checks all version surfaces.

[CHANGELOG.md](../CHANGELOG.md) is the source of GitHub Release notes. The prepared
`## [Unreleased → 1.0.0]` section is the matching, undated candidate for `v1.0.0`; the
planned launch date appears in the introduction above the first `##` heading, outside
the extracted release body. The owner reviews the exact candidate at the publication
approval. Use absolute HTTPS links in release sections so they work on GitHub Release
pages. Release preparation points this repository's `blob/main` links at the release tag,
so published guidance stays with that version. Subsequent releases use a matching dated
heading such as `## [1.0.1] - 2026-12-07`, with `### Added`, `### Changed`, `### Fixed`,
`### Security` and `### Upgrade notes` as applicable. The workflow extracts only the
matching section and refuses missing or ambiguous notes. Keep upgrade instructions with
their release, including migrations, changed defaults and secrets that must stay stable.

## Renew the hosted security policy

The website publishes `apps/site/public/.well-known/security.txt` on hourmere.com and
www.hourmere.com. Application instances do not publish Hourmere's policy. Review its
contacts and policy link regularly, and renew `Expires` before it is within 30 days.
The site policy test fails at that threshold with a renewal message, or if the new date
is more than one year ahead.

Set `Expires` to a UTC timestamp more than 30 days and at most one year after publication,
keeping both website `Canonical` URLs. Run
`npm test -- apps/site/src/security-txt.test.ts --maxWorkers=2`, commit the reviewed
policy and deploy the website through its normal publication process. Verify both
public URLs serve the renewed plain-text file after deployment.

## One-time owner setup

The real publishing boundary is the combination of a **tag ruleset** restricting
creation, update and deletion of `v*` tags and the **`release` environment** with required
owner review (see GitHub's [ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
and [environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
Tag-triggered runs execute the workflow from the tagged commit: the checks
inside that file cannot replace repository-level protection against unauthorized tags
or a changed workflow. Configure both before the first tag:

- **Environment `release`:** required reviewer = the release owner; disable administrator
  bypass; select deployment **tags** matching `v*.*.*`. A protected-branches-only policy
  would reject these tag deployments. A sole owner who pushes the tag must be allowed to
  review their deployment; enable **prevent self-review** only when another designated
  owner will approve.
- **Active tag ruleset:** target `v*`; restrict creations, updates and deletions; block
  force pushes; bypass = owner only. Keep normal protection and required checks on `main`.

These are repository settings: the workflow checks that required reviewers exist but
cannot configure the owner list, tag ruleset or administrator-bypass setting. Without
both protections the publishing boundary is incomplete, so do not push a release tag.
An absent environment or empty reviewer list fails the workflow before publication.

The release job uses the repository's `GITHUB_TOKEN` with only the needed release/package
and attestation permissions; no long-lived registry credential is required. Allow Actions
to create packages. Check package visibility and repository access after the first
authorized push, as described in the publication checklist below. A new package may
initially be private; this does not claim that a public image exists already.

## Prepare the reviewed commit

1. Complete acceptance on the intended `main` commit, including code review, changelog
   accuracy, upgrade and recovery notes, all CI gates, and local multi-architecture image
   verification. Keep the Compose PostgreSQL service at its default connection limit in
   CI. No real provider grant or external side effect is implied by synthetic tests.
2. Verify `CHANGELOG.md` contains the exact version's section. For v1.0.0 the prepared
   candidate is already eligible; publication still waits for owner approval. Review any
   known limitations against the actual supported scope.
3. Confirm the protected `release` environment and tag ruleset are active. Record the
   intended version and commit for the owner. No preparation automation should push tags,
   publish packages, create releases or approve its own deployment.

## Rehearse without publishing

Run [Release dry run](../.github/workflows/release-dry-run.yml) before the first release,
after changing the Dockerfile, release tooling or build dependencies, and before starting
an approved tag attempt. In GitHub **Actions → Release dry run → Run workflow**, select
`main` and enter the version **without `v`**. The dry-run version input must equal the
root `package.json` version at the chosen commit and have matching, nonempty CHANGELOG
notes. The default `1.0.0` matches the existing root manifest and candidate notes. To
rehearse `1.0.0-rc.0`, first run `npm version 1.0.0-rc.0 --no-git-tag-version`, follow the
versioning procedure above, and commit the synchronized metadata and matching CHANGELOG
section to `main`. The rehearsal does not change the manifest, synthesize notes or bypass
version validation.

The workflow fetches full history and creates a tag only in the disposable runner's local
checkout. It uses the same `scripts/release.ts prepare` entry point as publication to check
the version's equality with root `package.json`, tag/SHA identity, `origin/main` ancestry
and exact CHANGELOG section. Existing tags are reused without moving them, so an existing
tag pointing elsewhere fails validation. Selecting an unmerged branch also fails ancestry
validation. Download the extracted Markdown
from the **release-dry-run-notes** artifact; links are pinned to the rehearsal's local tag,
which may not exist on GitHub yet.

The reusable CI workflow must pass before the image build. A shared composite action keeps
QEMU, Buildx, both platforms (`linux/amd64,linux/arm64`), labels, the SBOM generator and
`mode=max` provenance identical to the publishing build. With `push: false`, the rehearsal
exports a multi-platform OCI archive to runner-local storage so SBOM/provenance generation
actually runs; the archive is discarded with the runner. The build job summary reports each
platform's elapsed span from its first started to last completed platform-labelled Dockerfile
BuildKit vertex. Spans include cached steps and overlap; shared work, scanner-image pulls,
SBOM generation and final OCI/provenance export time are outside them. Missing platform
timing fails the reporting step. Buildx's build record provides the complete build details,
as described in Docker's
[build history logs reference](https://docs.docker.com/reference/cli/docker/buildx/history/logs/).

The workflow has only `contents: read`, uses no secrets and does not sign in to a registry,
push images or tags, submit GitHub attestations, create releases or publish npm packages.
It needs no protected release environment. Success demonstrates the checks and local
multi-architecture build; the owner still reviews and approves the separate publishing run.

## Tag → checks → owner approval → image → release

Only an explicitly authorized owner or release operator pushes the reviewed tag. For
example, after the owner has authorized starting the release attempt:

```sh
git fetch origin main
git tag -a v1.0.0 <reviewed-main-commit> -m 'Release Hourmere 1.0.0'
git push origin refs/tags/v1.0.0
```

These are publication-triggering commands, not preparation steps. Do not run them while
preparing a release PR. The tag must point to a commit reachable from `origin/main`.
Tags on other commits, versions that differ from the root manifest, invalid versions,
or missing changelog sections fail before any
registry push or release creation. There is no manual or branch-push publication trigger.

The [release workflow](../.github/workflows/release.yml) runs the existing CI workflow
against the tagged source, including lint, types, tests, generated-type parity, builds,
the Compose smoke test and browser/privacy checks. Its `cli-compatibility` job runs through
`workflow_call` inside the release workflow, so a Node 22 compatibility failure blocks a
release before publication. Once those checks succeed, the publishing
job waits at the protected **`release`** environment. The owner reviews the tag, immutable
commit, notes and successful checks in that run, then approves this one pending deployment.
That approval is the final action authorizing the image push and GitHub Release. Reject or
leave it pending to publish nothing. The workflow rechecks tag identity and `main`
ancestry after approval, before publishing.

After approval, Docker Buildx builds the repository's `Dockerfile` for **`linux/amd64` and
`linux/arm64`**, using QEMU on the GitHub runner. It publishes one multi-platform image to
`ghcr.io/hourmere/hourmere` with the following tags:

| Release tag | Image tags |
|---|---|
| `v1.0.0` | `1.0.0`, `1.0`, `latest` |
| `v1.1.0-rc.1` | `1.1.0-rc.1` only |

Prereleases never move `latest` or the stable major/minor alias. Version tags identify the
release; major/minor and `latest` are moving aliases, so record the image digest for
reproducible deployments. The image has OCI source, license (`AGPL-3.0-only`), version and
revision labels, plus provenance and SBOM attestations. The workflow then creates a
GitHub Release for the same tag using the exact matching changelog body; prereleases are
marked as such. It does not publish npm workspaces. A disabled `publish-cli` job is included
in the same workflow; enabling it requires the separate owner preparation below.

## What the approver sees

Before CI starts and before the publishing job waits for approval, the `prepare` job writes
the version, tag, immutable commit SHA, prerelease flag and exact extracted release notes
to the run's **Summary** page. Download the same Markdown from the run's **release-notes**
artifact to review or retain it. Links in these notes point at the release tag. Review this
summary and the successful CI jobs before approving the pending **`release`** deployment.

After the image push and attestation succeed, the publishing job appends the image digest,
every pushed image tag, and the attestation URL and ID to its job summary on the same run.
Use these values for publication verification and reproducible deployments.

## RC image installation rehearsal

The owner chose the published GHCR image as the primary self-hosting path on 2026-10-20
(card 197, option A). The installer and `docker-compose.image.yml` are prepared now;
the live README and website must continue to select `setup.sh --source` until publication.
No public image is available yet. Rehearse the image path during the approved November
11–13 RC window, after an RC has actually been published and made public through the
release process above. A successful dry-run build alone does not make an image pullable.

For the approved RC, replace `1.0.0-rc.1` below with its **exact** version. On both an
amd64 host and an arm64 host, pull anonymously with an empty Docker credential directory;
run the matching platform command on each host. Do not reuse a GHCR login:

```sh
(
  anonymous_config=$(mktemp -d) &&
  trap 'rmdir "$anonymous_config"' EXIT &&
  DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/amd64 ghcr.io/hourmere/hourmere:1.0.0-rc.1
)
(
  anonymous_config=$(mktemp -d) &&
  trap 'rmdir "$anonymous_config"' EXIT &&
  DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/arm64 ghcr.io/hourmere/hourmere:1.0.0-rc.1
)
gh attestation verify oci://ghcr.io/hourmere/hourmere:1.0.0-rc.1 -R hourmere/hourmere
```

Record the pulled manifest digest, native architecture, verification result and release
workflow identity from the attestation. Stable releases push the exact version, minor
alias and `latest`; RCs push only the exact prerelease version. Installations must use
`HOURMERE_VERSION=1.0.0` or an exact prerelease such as `1.0.0-rc.1`, without a leading
`v`, never `latest` or `1.0`. Keep the checked-out release tag and image version together.

On each host, use a separate checkout of the approved RC tag and a fresh project/volumes.
Choose `plain`, a free loopback port (for example `http://localhost:4187`), blank SMTP and
explicitly acknowledge the private trial. No real provider credentials are needed:

```sh
COMPOSE_PROJECT_NAME=hourmere-rc-trial ./scripts/setup.sh --image --version 1.0.0-rc.1
docker compose pull
docker compose up -d --wait
curl --fail http://127.0.0.1:4187/api/health
```

Setup persists `HOURMERE_VERSION` and selects
`COMPOSE_FILE='docker-compose.yml:docker-compose.image.yml'`; proxy mode also selects
`docker-compose.proxy.yml`. `./scripts/enable-worker.sh` preserves this selection while
adding `docker-compose.worker.yml`. Repeat with the worker enabled and verify that app
and worker use the same exact GHCR image, neither has a build, and only the worker runs
jobs. Verify fresh application and pg-boss migrations, health, and a synthetic sign-in
link in the private app/worker log without copying that link into evidence. Test the
bundled proxy separately with the documented HTTPS/SMTP prerequisites. Keep provider
acceptance limits: synthetic sign-in and health do not establish real SMTP, Google,
Microsoft or Zoom acceptance.

Before changing the version, back up the database, `.env`, deployed commit/tag and Caddy
state. Change `HOURMERE_VERSION`, then `docker compose pull`, stop every old app/worker,
then `docker compose up -d --wait`. Before new-version startup, revert the version and
checkout/Compose selection to recover. Once `up` is attempted (or any migration runs
earlier), use the pre-upgrade backup/restore procedure; old code against a new schema is
unsafe. Never delete a production volume as part of upgrading or rolling back.

## Verify publication and handle failures

Confirm the GitHub Release, image digest, both architecture manifests, labels,
attestations and public unauthenticated GHCR access after publication. For v1.0.0, run the
pull while logged out of GHCR (or with an empty Docker credential configuration):

```sh
docker pull ghcr.io/hourmere/hourmere:1.0.0
gh attestation verify oci://ghcr.io/hourmere/hourmere:1.0.0 -R hourmere/hourmere
```

Smoke-test the intended deployment and check the upgrade notes before announcing
availability. After the first successful image push, complete this publication checklist.
Make the documentation changes in a separate follow-up after verifying public access:

- **Done before tagging:** `scripts/setup.sh` and `scripts/setup.test.ts` report the
  selected image version and its source, and reject a flag/environment version that
  differs from the exact checked-out release tag. The `.env.example` image/version
  comments, `docker-compose.yml` and `docker-compose.worker.yml` headers, and
  `scripts/enable-worker.sh` image/source startup hints are also prepared. These changes
  belong in the RC and v1.0.0 source; they do not assert that an image is public.
- After the first authorized `GITHUB_TOKEN` push, check the GHCR package's **Manage Actions
  access** settings: publishing a package through a workflow automatically grants the
  repository **Admin** access, as described in GitHub's [Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
  Confirm **Admin** access, repair missing access, set visibility to **Public**, and verify
  unauthenticated access. Check this after the push, when the package exists.
- Rename the changelog heading to `## [1.0.0] - 2026-11-30` and remove the introductory
  candidate note above the first `##` heading.
- Update `README.md` line 2 (`Self-host from source`) to describe the published image.
- Merge the separate **draft** PR titled **Release day: install from the published image**
  together with the release-day docs PR (card 213), only after anonymous pull and
  attestation verification succeed for stable `1.0.0`. It must make the image the primary
  install and upgrade path, retaining source builds as the alternative. Use this line
  map for the remaining release-day changes from the preparation baseline
  (headings/snippets remain the anchors if lines move):

  | File / preparation lines | Release-day change |
  |---|---|
  | `README.md:2`, `:75–134` (Self-hosting) | Describe the published image; clone `--branch v1.0.0`, select image setup, pull, then `up -d --wait` without `--build`; retain explicit `--source` alternative. |
  | `README.md:135–169` (upgrade/recovery) | Record the old exact version; change `HOURMERE_VERSION`, pull and start; revert it before startup, use backup/restore after any migration/startup. |
  | `apps/site/src/content/docs/docs/self-hosting.md:8–79` (Prepare / First start) | Remove the unpublished-image claim, require an exact release tag/version, describe the image overlay and same-version worker. |
  | Same guide `:174–220` (Caddy migration) | Preserve `docker-compose.image.yml` when switching proxy modes; pull the pinned image before recreating app/worker without `--build`, keeping Caddy state and the guarded migration sequence. |
  | Same guide `:122–173`, `:221–397` (plain / worker / webhook) | Preserve the image overlay in every file list and remove image-path builds. |
  | Same guide `:454–551` (restore) | Preserve the backed-up image selection/version and pull instead of building; keep drill isolation and fresh-volume restore. |
  | Same guide `:553–745` (Upgrade and roll back) | Make version edit → `docker compose pull` → stop all old roles → `docker compose up -d --wait` primary; keep startup migration boundary and source/pre-1.0 alternatives. |
  | `apps/site/src/content/docs/docs/configuration.md:259`, `:265`, `:267`, `:296` (Compose-only reference and manual edits) | Describe image-aware setup and `COMPOSE_FILE` selections, published `APP_IMAGE` behavior and exact `HOURMERE_VERSION`; preserve the image overlay in worker examples and explain that source omits it. |
  | `apps/site/src/legal-content.test.ts:80` (comparison introduction guard) | Replace the unpublished-image assertion with a published-image link assertion alongside the comparison copy in card 213; add install/version/rollback guards for README and self-hosting without weakening provider-acceptance guards. |
  | `scripts/deploy-docs.test.ts` and `scripts/restore-env.test.ts` | Update executable paste/restore expectations with the docs, preserving failure guards and private `.env` handling. |

- Replace the no-stable-release/public-image sentences in `README.md`, `SECURITY.md`,
  the site's self-hosting, configuration, comparison and index guides, homepage, site description and
  legal pages. Update `apps/site/src/legal-content.test.ts` (currently line 80, asserting
  `no prebuilt public image is published`) together with the corresponding docs sentences.
  The draft PR above is the prepared revision of the source-build install instructions;
  keep the source-build alternative and exact-version/rollback guidance when merging it.
- Retain Cloud nonavailability and its separate legal timing until Cloud launch is
  approved. Releasing the self-hosted software does not establish that Hourmere Cloud has
  launched or that real provider integrations have passed live acceptance.

Image pushes and GitHub Release creation are separate external operations. A failed run
can leave an image published without a release, or some moving aliases updated. Inspect
the completed steps before rerunning, keep the original version tag/commit immutable,
and request owner approval again for a retry. Never move a published tag or force-push it;
fix product content in a new patch release. A package-publicity failure is not fixed by
claiming that an image is public in documentation.

## CLI package identity

Directory preparation is in [mcp-directories.md](mcp-directories.md).

Use **`@hourmere/cli`**, exposing the **`hourmere`** command. It matches the existing
workspace name, groups future packages under the Hourmere scope, and avoids consuming the
bare product name. On 2026-10-19, read-only `npm view hourmere` and
`npm view @hourmere/cli` both returned E404 from the public npm registry. This means no
package metadata was found; it neither reserves the name nor proves scope ownership or
publication permission. The owner must confirm control of the `hourmere` npm organization,
check the name again, and authorize the first public release.

The first intended public version is **`1.0.0`**, already recorded in the product and CLI
manifests. Stamping this version does not publish the package. For later releases, update
all metadata together using the versioning procedure above, then review the tarball:

```sh
npm run cli:pack-smoke
git diff -- package.json tools/cli/package.json package-lock.json server.json
```

The CLI reads its version from the packaged manifest, so `hourmere --version` follows the
committed release version. The CLI version is tied to the product tag: every product
release must bump/stamp the CLI manifest and lockfile to match that tag, or `publish-cli`
fails its version check. Later releases use the same process with their approved SemVer.
Do not change the version only on the CI runner; publication still requires owner approval.

## Review the standalone CLI artifact

From the repository root, with Node 26 and the lockfile dependencies installed:

```sh
npm run cli:build
npm pack --dry-run --workspace @hourmere/cli
npm run cli:pack-smoke
```

The smoke command inspects the dry-run file list, packs the CLI, installs that tarball into
an isolated temporary directory with lifecycle scripts disabled, and runs its installed
`hourmere --help` and `hourmere --version`. It removes its own temporary directory. The CLI
has no runtime dependencies or workspace imports. The intended six tarball entries are:

```text
LICENSE
README.md
dist/cli.js
dist/client.js
dist/index.js
package.json
```

CI performs this inspection and smoke test on pull requests. The `files` allow-list
limits executable code to the three runtime JavaScript files, alongside the manifest, README
and AGPL-3.0-only license. Tests, TypeScript source, build tools, credentials and workspace
dependencies have no place in the release tarball.

The package's `prepublishOnly` script runs `node dist/index.js --version`. A local
`npm publish` fails if the compiled CLI has not been built; run `npm run cli:build` first.

## CLI owner approval and publishing (not enabled)

The release workflow's `publish-cli` job is a **disabled scaffold**: its literal condition
is `${{ false }}`, and it depends on both `prepare` and the reusable `ci` job through
`needs: [prepare, ci]`. It retains `environment: release` and job-scoped `contents: read`
and `id-token: write` permissions. No tag or pull request can publish through this job
while it is disabled.

Before enabling npm publication, the owner must:

1. Confirm control of the `hourmere` npm organization, package availability, publisher
   access and the approved package/lockfile version diff. The source repository is already
   public, as required for npm provenance.
2. Confirm the protected GitHub `release` environment and tag ruleset described above are
   active. Keep `environment: release` on the CLI publishing job so the owner reviews the
   exact tag/SHA and tarball before granting permission. Preserve the release workflow's
   main-ancestry, tag/SHA, changelog and required-reviewer checks, including revalidation
   after approval, when enabling the CLI job.
3. Configure an npm trusted publisher for GitHub organization `hourmere`, repository
   `hourmere` (`hourmere/hourmere`), workflow filename `release.yml`, environment `release`,
   allowing the intended publish action. Use a GitHub-hosted runner, Node 26, npm >=11.5.1
   and job-scoped `id-token: write` for OIDC. If npm requires a first-publication bootstrap
   before package settings are available, the owner must explicitly arrange its narrowly
   scoped credentials in the protected workflow; never commit them. Remove bootstrap
   credentials after OIDC works.
4. Enable the job in a separately reviewed change only after these prerequisites and all
   release gates pass. Then create the approved tag through the release process above and
   approve the protected job. No enabling change, tag, approval or publication is part of
   this preparation task.

The preferred command, from `tools/cli` in that protected GitHub-hosted release job, is:

```sh
npm publish --provenance --access public
```

The smoke command builds the compiled files through `npm run cli:build`; the job checks
that the committed CLI version matches the approved product tag and verifies the standalone
tarball before publishing. After an authorized publish,
the owner verifies npm's version, tarball, public access and provenance link. A local
publish does not provide the protected job's OIDC provenance.

Official references (recheck before activating): npm's
[provenance instructions](https://docs.npmjs.com/generating-provenance-statements/) and
[trusted publishing configuration](https://docs.npmjs.com/trusted-publishers/).
