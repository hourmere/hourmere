# Release the n8n community node

`n8n-nodes-hourmere` is released from the public `hourmere/hourmere` repository. The
manual **Release n8n community node** workflow builds and tests the tagged source,
prepares a release copy in the approved job, and stages the checked tarball with npm
provenance. The npm package owner approves that staged version with 2FA to make it
public. The committed `private` flag, placeholder registry and `prepublishOnly` guard
stay in place. GitHub Actions provenance is required for n8n verification.
[n8n submission requirements](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes.md).

Use `npm pack` to inspect a local build. npm can contact its selected registry before
refusing a publish attempt on a private package, and a publish dry-run skips that refusal.

## One-time setup

1. **GitHub repository admin.** In `hourmere/hourmere`, open **Settings → Environments**
   and create `n8n-npm-release`. Enable **Required reviewers** and add the release owner
   or a designated release reviewer. Turn off **Allow administrators to bypass
   configured protection rules**. Enable **Prevent self-review** if a second GitHub
   account can dispatch or review. Under **Deployment branches and tags**, select
   **Selected branches and tags** and add a **Tag** rule `n8n-v*`. Leave the branch
   allowlist empty. Restrict release-tag creation, updates and deletion to authorized
   maintainers using a GitHub tag ruleset.
   [GitHub environment settings](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
2. **npm package owner, before the first release.** Use an npm account with 2FA enabled
   that will own the unscoped package. npm needs an existing package before you can
   configure its trusted publisher. For the first release into an unused name, create a
   granular access token with the shortest expiration and **Read and write (stage
   only)** for **All Packages**. Leave **Bypass two-factor authentication** unchecked
   and select **No access** for organizations. The new unscoped package cannot yet be
   selected by name. Use a dedicated maintainer account with no unrelated package
   write access if possible. [npm token settings](https://docs.npmjs.com/creating-and-viewing-authentication-tokens/),
   [Stage-only permissions](https://docs.npmjs.com/about-access-tokens/#about-stage-only-tokens).
3. **GitHub repository admin, before the first release.** Add that token as the
   `N8N_NPM_BOOTSTRAP_TOKEN` secret in the `n8n-npm-release` environment. The workflow
   uses it only for an explicit bootstrap of `0.1.0` while the package name is absent
   from the registry. Use the regular trusted publishing path if the package already
   exists under Hourmere's ownership.
4. **npm package owner, after bootstrap and before the next release.** Open
   **Package → Settings → Trusted publishing → Add a publisher → GitHub Actions**
   on npmjs.com.
   Set **Organization or user** to `hourmere`, **Repository** to `hourmere`,
   **Workflow filename** to `n8n-release.yml`, and **Environment name** to
   `n8n-npm-release`. Leave direct publishing and dist-tag management disabled so the
   publisher can only stage versions. Configure this just before the next release and
   complete the first OIDC release within two days to validate the connection.
   Under **Publishing access**, select **Require two-factor authentication and
   disallow tokens** and save. Trusted publishing uses GitHub OIDC and continues
   to work without an npm token. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Run a release

1. **GitHub release maintainer.** Confirm the approved commit is on `main`, CI is green,
   the package and lockfile agree on the version, and
   `tools/n8n-nodes-hourmere/CHANGELOG.md` has the matching release entry. Fetch `main`,
   then tag that exact commit and push only the release tag. Replace `APPROVED_MAIN_SHA`
   with the reviewed SHA.

   ```sh
   git fetch origin main
   git tag -a n8n-v0.1.0 APPROVED_MAIN_SHA -m 'Release n8n-nodes-hourmere 0.1.0'
   git push origin refs/tags/n8n-v0.1.0
   ```

2. **GitHub release maintainer.** For the first release into the unused npm name,
   dispatch the workflow with `bootstrap=true`.

   ```sh
   gh workflow run n8n-release.yml --repo hourmere/hourmere --ref n8n-v0.1.0 -f bootstrap=true
   ```

   On later releases, replace the ref with the matching `n8n-v<version>` tag and omit
   `-f bootstrap=true` so the job uses the configured trusted publisher.
   If GitHub requires a first run on the default branch before accepting a tag dispatch,
   run the workflow once with `--ref main`, then dispatch on the tag. The staging job
   skips branch runs. [GitHub manual dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
3. **GitHub required reviewer.** In **Actions → Release n8n community node**, open the
   run and check the tag, commit and version. Select **Review deployments**, select
   `n8n-npm-release`, and approve. [GitHub deployment review](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments).
4. **npm package owner.** After the workflow stages the tarball, open **Staged Packages**
   in your npmjs.com account settings. Match the stage ID in the workflow log and the
   package, version and tarball SHA-1 in the job summary. Review the tarball, select
   **Approve** and complete the 2FA challenge. For the first release, npm lists a
   `0.0.0-stage` placeholder until you promote the staged `0.1.0` version. If a run
   stops after staging, check **Staged Packages** before dispatching again. If you need
   to restage and the placeholder still exists, verify your account owns it, configure
   the trusted publisher, and dispatch without `bootstrap=true`.
   [npm staged publishing](https://docs.npmjs.com/staged-publishing/).
5. **npm package owner.** Check the expected version and its provenance on the
   [npm package page](https://www.npmjs.com/package/n8n-nodes-hourmere).
   Confirm the source repository, workflow and commit shown by npm, then install that
   version on a self-hosted n8n instance. After a successful bootstrap, revoke the
   granular token. [npm provenance information](https://docs.npmjs.com/viewing-package-provenance/).
6. **GitHub repository admin.** After a successful bootstrap, delete the
   `N8N_NPM_BOOTSTRAP_TOKEN` environment secret.

## Submit for n8n verification

1. **Hourmere package maintainer.** Review n8n's technical and UX criteria before
   applying. The current self-hosted package uses AGPL-3.0-only and ships Simplified
   Chinese parameter translations. n8n's published verification guidelines require MIT
   and an English-only interface and documentation. Get n8n's guidance or resolve those
   differences with the rights holders before submitting. Any licensing change needs
   separate approval. [n8n verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines.md).
2. **Hourmere package maintainer.** Once eligible, run `npx @n8n/scan-community-package n8n-nodes-hourmere`
   against the public package and check that npm shows GitHub Actions provenance for
   the version you will submit. Ensure the npm maintainer and repository identities match.
3. **n8n Creator Portal account for Hourmere.** Sign in, submit `n8n-nodes-hourmere` for
   verification and follow the review status in the portal. Keep n8n Cloud availability
   conditional on approval from n8n. [n8n Creator Portal](https://creators.n8n.io/nodes).
