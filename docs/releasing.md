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

[CHANGELOG.md](../CHANGELOG.md) is the source of GitHub Release notes. The prepared
`## [Unreleased → 1.0.0]` section is the matching, undated candidate for `v1.0.0`; the
planned launch date appears in the introduction above the first `##` heading, outside
the extracted release body. The owner reviews the exact candidate at the publication
approval. Use absolute HTTPS links in release sections so they work on GitHub Release
pages. Subsequent releases use a matching dated
heading such as `## [1.0.1] - 2026-12-07`, with `### Added`, `### Changed`, `### Fixed`,
`### Security` and `### Upgrade notes` as applicable. The workflow extracts only the
matching section and refuses missing or ambiguous notes. Keep upgrade instructions with
their release, including migrations, changed defaults and secrets that must stay stable.

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
to create packages; in the GHCR package's **Manage Actions access** settings, grant this
repository **Write** access. After the first authorized push, set the package visibility
to **Public** and verify unauthenticated access. A new package may initially be private;
retain this as a first-release check, not a claim that a public image exists already.

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
Tags on other commits, invalid versions, or missing changelog sections fail before any
registry push or release creation. There is no manual or branch-push publication trigger.

The [release workflow](../.github/workflows/release.yml) runs the existing CI workflow
against the tagged source, including lint, types, tests, generated-type parity, builds,
the Compose smoke test and browser/privacy checks. Once those succeed, the publishing
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
marked as such. It does not publish npm workspaces.

## Verify publication and handle failures

Confirm the GitHub Release, image digest, both architecture manifests, labels,
attestations and public unauthenticated GHCR access after publication. For v1.0.0, run the
pull while logged out of GHCR (or with an empty Docker credential configuration):

```sh
docker pull ghcr.io/hourmere/hourmere:1.0.0
gh attestation verify oci://ghcr.io/hourmere/hourmere:1.0.0 -R hourmere/hourmere
```

Smoke-test the intended deployment and check the upgrade notes before announcing
availability. After the first successful public publish, complete this documentation
checklist in a separate follow-up:

- Rename the changelog heading to `## [1.0.0] - 2026-11-30` and remove the introductory
  candidate note above the first `##` heading.
- Replace the no-stable-release/public-image sentences in `README.md`, `SECURITY.md`,
  the site's self-hosting, comparison and index guides, homepage, site description and
  legal pages. Update `apps/site/src/legal-content.test.ts` (currently line 79, asserting
  `no prebuilt public image is published`) together with the corresponding docs sentences.
  Keep source-build Compose instructions until explicitly revised.
- Retain Cloud nonavailability and its separate legal timing until Cloud launch is
  approved. Releasing the self-hosted software does not establish that Hourmere Cloud has
  launched or that real provider integrations have passed live acceptance.

Image pushes and GitHub Release creation are separate external operations. A failed run
can leave an image published without a release, or some moving aliases updated. Inspect
the completed steps before rerunning, keep the original version tag/commit immutable,
and request owner approval again for a retry. Never move a published tag or force-push it;
fix product content in a new patch release. A package-publicity failure is not fixed by
claiming that an image is public in documentation.
