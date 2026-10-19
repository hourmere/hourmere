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
`## [Unreleased → 1.0.0]` section is the matching candidate for `v1.0.0`; its date is a
planned launch date, not an assertion that publication happened. The owner reviews this
exact candidate at the publication approval. Subsequent releases use a matching dated
heading such as `## [1.0.1] - 2026-12-07`, with `### Added`, `### Changed`, `### Fixed`,
`### Security` and `### Upgrade notes` as applicable. The workflow extracts only the
matching section and refuses missing or ambiguous notes. Keep upgrade instructions with
their release, including migrations, changed defaults and secrets that must stay stable.

## One-time owner setup

Before the first tag, configure a GitHub Actions environment named **`release`** with only
the release owner(s) as required reviewers, and disable administrator bypass. Select the
release tag pattern `v*.*.*` in its deployment policy; a protected-branches-only policy
would reject these tag deployments. Protect creation/update of release tags with a
repository ruleset. Keep normal protection and required checks on `main`. A sole owner who
pushes the tag must be allowed to review their deployment; enable **prevent self-review**
only when another designated owner will approve. Environment protection is a repository
setting: the workflow checks that required reviewers exist but cannot configure the owner
list or inspect the administrator-bypass setting. Without this setup the owner-approval
gate is incomplete, so do not push a release tag. An absent environment or empty reviewer
list fails the workflow before publication.

The release job uses the repository's `GITHUB_TOKEN` with only the needed release/package
and attestation permissions; no long-lived registry credential is required. Confirm
Actions can create packages and that `ghcr.io/hourmere/hourmere` will be public. A newly
created GHCR package may need its visibility changed to public by the owner after the
first push; retain this as a first-release check, not a claim that a public image exists
already.

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
attestations and public unauthenticated GHCR access after publication. Smoke-test the
intended deployment and check the upgrade notes before announcing availability. Only
after the first successful public publish should the separate documentation follow-up
replace statements that no stable release/public image exists. Source-build Compose
instructions remain valid until explicitly revised. Releasing the self-hosted software
does not establish that Hourmere Cloud has launched or that real provider integrations
have passed live acceptance.

Image pushes and GitHub Release creation are separate external operations. A failed run
can leave an image published without a release, or some moving aliases updated. Inspect
the completed steps before rerunning, keep the original version tag/commit immutable,
and request owner approval again for a retry. Never move a published tag or force-push it;
fix product content in a new patch release. A package-publicity failure is not fixed by
claiming that an image is public in documentation.
