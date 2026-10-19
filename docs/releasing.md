# Preparing the CLI release

This change prepares launch artifacts only. It does not publish npm packages, create a
release/tag, or submit MCP listings. The owner performs those actions after reviewing the
final artifacts. Directory preparation is in [mcp-directories.md](mcp-directories.md).

## Package identity

Use **`@hourmere/cli`**, exposing the **`hourmere`** command. It matches the existing
workspace name, groups future packages under the Hourmere scope, and avoids consuming the
bare product name. On 2026-10-19, read-only `npm view hourmere` and
`npm view @hourmere/cli` both returned E404 from the public npm registry. This means no
package metadata was found; it neither reserves the name nor proves scope ownership or
publication permission. The owner must confirm control of the `hourmere` npm organization,
check the name again, and authorize the first public release.

`tools/cli/package.json` stays at **`0.0.0`** during preparation. The first intended public
version is **`1.0.0`**. During the owner-approved release preparation, update the workspace
manifest and lockfile together, review and commit them before creating the release tag:

```sh
npm version 1.0.0 --workspace @hourmere/cli --no-git-tag-version
npm run cli:pack-smoke
git diff -- tools/cli/package.json package-lock.json
```

The CLI reads its version from the packaged manifest, so `hourmere --version` follows the
committed release version. Later releases use the same process with their approved SemVer.
Do not publish the preparation version or change the version only on the CI runner.

## Review the standalone artifact

From the repository root, with Node 26 and the lockfile dependencies installed:

```sh
npm run build --workspace @hourmere/cli
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

## Owner approval and publishing (not enabled)

As checked on 2026-10-19, [PR #8](https://github.com/hourmere/hourmere/pull/8) is open and
`origin/main` at `3cef66af05ae1bf71e90b4cd17aee4bafc19fafb` has no release workflow. The
new `.github/workflows/release.yml` is a **disabled scaffold**: `publish-cli` has the literal
condition `${{ false }}`. No tag or pull request can publish through this scaffold.

Before enabling publication, the owner must:

1. Merge/reconcile PR #8 and fold `publish-cli` into its release workflow with
   `needs: [prepare, ci]`. Preserve the release's main-ancestry, tag/SHA, changelog and
   required-reviewer configuration checks, including revalidation after approval.
2. Make the source repository public for npm provenance and confirm npm scope ownership,
   package availability, publisher access and the approved `1.0.0` package/lockfile diff.
3. Configure the GitHub `release` environment with required owner reviewers. Confirm its
   protections cannot be bypassed for the intended release. Keep `environment: release`
   on the publishing job so the owner reviews the exact tag/SHA and pack contents before
   granting permission.
4. Configure an npm trusted publisher for GitHub organization `hourmere`, repository
   `hourmere`, workflow filename `release.yml`, environment `release`, allowing the intended
   publish action. Use a GitHub-hosted runner, Node 26, npm >=11.5.1 and job-scoped
   `id-token: write`. If npm requires a first-publication bootstrap before package settings
   are available, the owner must explicitly arrange its narrowly scoped credentials in the
   protected workflow; never commit them. Remove bootstrap credentials after OIDC works.
5. Enable the job in a separately reviewed change only after these prerequisites and all
   release gates pass. Then create the approved tag through PR #8's release process and
   approve the protected job. No enabling change, tag, approval or publication is part of
   this preparation task.

The preferred command, from `tools/cli` in that protected GitHub-hosted release job, is:

```sh
npm publish --provenance --access public
```

The job builds through `prepack` and checks the committed package version matches the
approved tag. It must inherit PR #8's completed CI and approval validation before activation.
After an authorized publish, the owner verifies npm's version, tarball, public access and
provenance link. Do not treat a local publish as equivalent to CI provenance.

Official references (recheck before activating): npm's
[provenance instructions](https://docs.npmjs.com/generating-provenance-statements/) and
[trusted publishing configuration](https://docs.npmjs.com/trusted-publishers/).
