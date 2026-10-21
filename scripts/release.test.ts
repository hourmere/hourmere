import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Mutation probes point at a source copy; the worktree implementation stays intact.
const script =
  process.env.HOURMERE_RELEASE_SCRIPT ?? fileURLToPath(new URL('./release.ts', import.meta.url))
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(
  changelog = '## [Unreleased → 1.0.0]\n\n### Added\n\n- Scheduling.\n',
  version: unknown = '1.0.0',
) {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-release-test-'))
  scratch.push(dir)
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Release fixture',
    GIT_COMMITTER_NAME: 'Release fixture',
    GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_EMAIL: 'release@example.invalid',
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: join(dir, 'output'),
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
  git('init', '--quiet', '--initial-branch=main')
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hourmere', version }))
  git('add', 'CHANGELOG.md', 'package.json')
  git('commit', '--quiet', '-m', 'Prepare fixture')
  const sha = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', sha)
  git('tag', 'v1.0.0')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8' })
  return { dir, git, sha, run, output: () => readFileSync(env.GITHUB_OUTPUT, 'utf8') }
}

function refused(repo: ReturnType<typeof fixture>, ...args: string[]) {
  const result = repo.run(...args)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Release preparation failed')
  expect(existsSync(join(repo.dir, 'output'))).toBe(false)
  expect(existsSync(join(repo.dir, 'hourmere-release-notes.md'))).toBe(false)
}

describe('release preparation', () => {
  it('extracts publishable notes from the real changelog', () => {
    const changelog = readFileSync(
      process.env.HOURMERE_RELEASE_CHANGELOG ??
        fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)),
      'utf8',
    )
    const repo = fixture(changelog)
    expect(repo.run('prepare', 'v1.0.0', repo.sha).status).toBe(0)
    const notes = readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')
    expect(notes).toContain('### Upgrade notes')
    expect(notes).not.toContain('Release candidate notes')
    expect(notes).not.toContain('does not mean that a release')
    expect(notes).not.toMatch(/\]\((?!https?:\/\/)/i)
    expect(notes).not.toMatch(/(?<![\w/])#\d+\b/)
    expect(notes).toContain('https://github.com/hourmere/hourmere/blob/v1.0.0/')
    expect(notes).not.toContain('https://github.com/hourmere/hourmere/blob/main/')
  })

  it('pins relocated and existing site guides in the real changelog to the released version', () => {
    const changelog = readFileSync(
      process.env.HOURMERE_RELEASE_CHANGELOG ??
        fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)),
      'utf8',
    )
    const repo = fixture(changelog)
    expect(repo.run('prepare', 'v1.0.0', repo.sha).status).toBe(0)
    const notes = readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')
    const guides = [
      'microsoft-calendar.md',
      'automatic-zoom.md',
      'notifications.md#email-headers-mime-and-replies',
      'configuration.md#server-and-database',
      'self-hosting.md#prepare-the-host',
      'interface-languages.md',
      'notifications.md#identity-and-recipients',
      'self-hosting.md#back-up-and-restore',
      'notifications.md#calendar-invitations',
      'self-hosting.md#upgrade-and-roll-back',
      'google-calendar.md#automatic-meet-projection',
      'notifications.md#conference-outbox-delivery-budget',
      'webhooks.md',
    ]
    for (const guide of guides) {
      expect(notes).toContain(
        `https://github.com/hourmere/hourmere/blob/v1.0.0/apps/site/src/content/docs/docs/${guide}`,
      )
    }
    expect(notes).not.toContain('https://hourmere.com/docs')
  })

  it.each(['v1.0.0', 'v1.2.0-rc.1'])('pins repository guidance to the published tag %s', (tag) => {
    const repository = 'https://github.com/hourmere/hourmere'
    const otherRepository = 'https://github.com/example/other/blob/main/docs.md'
    const repo = fixture(
      `## [${tag.slice(1)}] - 2026-11-30\n\n[Upgrade](${repository}/blob/main/docs/releasing.md#upgrade)\n[Other](${otherRepository})\n`,
      tag.slice(1),
    )
    if (tag !== 'v1.0.0') repo.git('tag', tag)
    expect(repo.run('prepare', tag, repo.sha).status).toBe(0)
    expect(readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')).toBe(
      `[Upgrade](${repository}/blob/${tag}/docs/releasing.md#upgrade)\n[Other](${otherRepository})\n`,
    )
  })

  it('extracts only the candidate version notes without publishing or changing git', () => {
    const repo = fixture(
      '# Changelog\n\n## [Unreleased → 1.0.0]\n\n### Added\n\n- Scheduling.\n\n## [0.9.0] - 2026-10-01\n\n- Older.\n',
    )
    const before = repo.git('show-ref')
    expect(repo.run('prepare', 'v1.0.0', repo.sha).status).toBe(0)
    expect(repo.output()).toBe(
      `version=1.0.0\nmajor_minor=1.0\nprerelease=false\nnotes_file=${join(repo.dir, 'hourmere-release-notes.md')}\n`,
    )
    expect(readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')).toBe(
      '### Added\n\n- Scheduling.\n',
    )
    expect(repo.git('show-ref')).toBe(before)
    expect(repo.git('status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  it('accepts an annotated tag on a main ancestor and a dated version section', () => {
    const repo = fixture('## [1.0.0] - 2026-11-30\n\n- Ready.\n')
    repo.git('tag', '-d', 'v1.0.0')
    repo.git('tag', '-a', 'v1.0.0', '-m', 'Release fixture')
    repo.git('commit', '--quiet', '--allow-empty', '-m', 'Advance main')
    repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD'))
    repo.git('checkout', '--quiet', '--detach', repo.sha)
    expect(repo.run('prepare', 'v1.0.0', repo.sha).status).toBe(0)
    expect(readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')).toBe('- Ready.\n')
  })

  it('marks prereleases explicitly so they cannot advance stable aliases', () => {
    const repo = fixture('## [1.2.0-rc.1] - 2026-11-01\n\n- Candidate.\n', '1.2.0-rc.1')
    repo.git('tag', 'v1.2.0-rc.1')
    expect(repo.run('prepare', 'v1.2.0-rc.1', repo.sha).status).toBe(0)
    expect(repo.output()).toContain('version=1.2.0-rc.1\nmajor_minor=1.2\nprerelease=true\n')
  })

  it.each(['0.0.0', '1.0.1', '1.0.0-rc.1', 'v1.0.0', '', null, 1])(
    'rejects root package version %j when the tag and changelog identify 1.0.0',
    (version) => {
      const repo = fixture(undefined, version)
      refused(repo, 'prepare', 'v1.0.0', repo.sha)
    },
  )

  it.each([
    '1.0.0',
    'v01.0.0',
    'v1.0',
    'v1.0.0-01',
    'v1.0.0-rc.01',
    'v1.0.0+build.1',
    `v1.0.0-${'a'.repeat(124)}`,
    'v1.0.0\nlatest',
    '--help',
  ])('rejects invalid or non-registry-compatible version %j', (tag) => {
    const repo = fixture(`## [${tag.slice(1)}] - 2026-11-30\n\n- Invalid candidate.\n`)
    if (tag.startsWith('v') && !tag.includes('\n')) repo.git('tag', tag)
    refused(repo, 'prepare', tag, repo.sha)
  })

  it('rejects a side-branch commit even when its changelog and tag are valid', () => {
    const repo = fixture()
    repo.git('checkout', '--quiet', '-b', 'side')
    repo.git('commit', '--quiet', '--allow-empty', '-m', 'Side branch')
    const side = repo.git('rev-parse', 'HEAD')
    repo.git('tag', '-f', 'v1.0.0')
    refused(repo, 'prepare', 'v1.0.0', side)
  })

  it('rejects a mismatched event SHA', () => {
    const repo = fixture()
    refused(repo, 'prepare', 'v1.0.0', 'a'.repeat(40))
  })

  it('rejects a checkout different from the tagged event commit', () => {
    const repo = fixture()
    repo.git('commit', '--quiet', '--allow-empty', '-m', 'Wrong checkout')
    refused(repo, 'prepare', 'v1.0.0', repo.sha)
  })

  it('rejects a moved tag even when the event SHA and checkout still agree', () => {
    const repo = fixture()
    repo.git('commit', '--quiet', '--allow-empty', '-m', 'New tag target')
    repo.git('tag', '-f', 'v1.0.0')
    repo.git('checkout', '--quiet', '--detach', repo.sha)
    refused(repo, 'prepare', 'v1.0.0', repo.sha)
  })

  it.each([
    '## [Unreleased → 2.0.0]\n\n- Wrong release.\n',
    '## [Unreleased → 1.0.0]\n\n## [0.9.0] - 2026-10-01\n\n- Older.\n',
    '## [Unreleased → 1.0.0]\n\n- First.\n\n## [1.0.0] - 2026-11-30\n\n- Duplicate.\n',
  ])('rejects missing, empty or ambiguous notes', (changelog) => {
    const repo = fixture(changelog)
    refused(repo, 'prepare', 'v1.0.0', repo.sha)
  })
})

describe('owner approval prerequisite', () => {
  it.each(['User', 'Team'])('accepts a required %s reviewer', (type) => {
    const repo = fixture()
    const path = join(repo.dir, 'environment.json')
    writeFileSync(
      path,
      JSON.stringify({
        protection_rules: [
          { type: 'required_reviewers', reviewers: [{ type, reviewer: { id: 1 } }] },
        ],
      }),
    )
    expect(repo.run('check-environment', path).status).toBe(0)
  })

  it.each([
    {},
    { protection_rules: [] },
    { protection_rules: [{ type: 'wait_timer', wait_timer: 30 }] },
    { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
    { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] },
    {
      protection_rules: [
        { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: -1 } }] },
      ],
    },
    {
      protection_rules: [
        { type: 'required_reviewers', reviewers: [{ type: 'Bot', reviewer: { id: 1 } }] },
      ],
    },
  ])('rejects an absent or unprotected environment %j', (environment) => {
    const repo = fixture()
    const path = join(repo.dir, 'environment.json')
    writeFileSync(path, JSON.stringify(environment))
    refused(repo, 'check-environment', path)
  })
})

const workflowPath =
  process.env.HOURMERE_RELEASE_WORKFLOW ??
  fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
const workflow = () => readFileSync(workflowPath, 'utf8')
const buildAction = () =>
  readFileSync(
    process.env.HOURMERE_RELEASE_BUILD_ACTION ??
      fileURLToPath(new URL('../.github/actions/release-build/action.yml', import.meta.url)),
    'utf8',
  )

function stepScript(name: string) {
  const source = workflow().split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0] ?? ''
  const block = /^ {8}run: \|\n((?: {10}.*(?:\n|$))*)/m.exec(source)?.[1]
  expect(block, `Missing executable workflow step: ${name}`).toBeDefined()
  return (block ?? '').replace(/^ {10}/gm, '')
}

describe('release workflow boundaries', () => {
  // Version tags were checked against these registry index digests on 2026-10-19
  // with `docker buildx imagetools inspect`; no images were run or published.
  it.each([
    [
      'docker/setup-qemu-action',
      'image: docker.io/tonistiigi/binfmt:latest@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 # qemu-v10.2.3',
    ],
    [
      'docker/setup-buildx-action',
      'driver-opts: image=docker.io/moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea # v0.33.1',
    ],
    [
      'docker/build-push-action',
      'sbom: generator=docker.io/docker/buildkit-syft-scanner:stable-1@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9 # 1.12.0',
    ],
  ])('pins and names the verified supporting image for %s', (action, image) => {
    const step = buildAction().split(`uses: ${action}@`)[1]?.split('\n    - ')[0] ?? ''
    expect(step.split('\n').map((line) => line.trim())).toContain(image)
  })

  it('builds and verifies the standalone CLI before the disabled publisher can publish', () => {
    const cli = workflow().split('  publish-cli:\n')[1] ?? ''
    const smoke = cli.indexOf('      - run: npm run cli:pack-smoke\n')
    expect(smoke).toBeGreaterThan(-1)
    expect(smoke).toBeLessThan(cli.indexOf('        run: npm publish --provenance --access public'))
  })

  it('permits only version tag pushes and requires reusable CI and protected approval', () => {
    const source = workflow()
    expect(source).toMatch(/on:\n {2}push:\n {4}tags: \['v\*\.\*\.\*'\]\n\npermissions: \{\}/)
    expect(source).not.toMatch(/workflow_dispatch:|pull_request:|branches:/)
    expect(source).toMatch(
      / {2}ci:\n {4}needs: prepare\n[\s\S]*?uses: \.\/\.github\/workflows\/ci.yml/,
    )
    const publishing = source.split('  publish:\n')[1]?.split('\n  # Enable')[0] ?? ''
    expect(publishing).toMatch(/^ {4}needs: \[prepare, ci\]$/m)
    expect(publishing).toMatch(/^ {4}environment: release$/m)
    expect(stepScript('Validate the version, main ancestry and changelog')).toContain(
      'node scripts/release.ts prepare "$GITHUB_REF_NAME" "$GITHUB_SHA"',
    )
    expect(stepScript('Require a configured owner approval gate')).toContain(
      'node scripts/release.ts check-environment "$RUNNER_TEMP/release-environment.json"',
    )
    const revalidate = stepScript('Revalidate the approved release')
    expect(revalidate).toContain(
      'git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main',
    )
    expect(revalidate).toContain('node scripts/release.ts prepare "$GITHUB_REF_NAME" "$GITHUB_SHA"')
    expect(revalidate).toContain(
      'node scripts/release.ts check-environment "$RUNNER_TEMP/release-environment.json"',
    )
    expect(source.indexOf('Revalidate the approved release')).toBeLessThan(
      source.indexOf('Sign in to GHCR'),
    )
    for (const match of `${source}\n${buildAction()}`.matchAll(/uses: ([^\n]+)/g)) {
      if (match[1]?.startsWith('./')) continue
      expect(match[1]).toMatch(/^[\w/-]+@[a-f0-9]{40}(?: #.*)?$/)
    }
    expect(buildAction()).toContain('platforms: linux/amd64,linux/arm64')
    expect(buildAction()).toContain('provenance: mode=max')
    expect(buildAction()).toMatch(/sbom: generator=\S+@sha256:[a-f0-9]{64}/)
    expect(source).toMatch(
      /id: build\n {8}uses: \.\/\.github\/actions\/release-build\n {8}with:\n {10}push: true\n {10}version: \$\{\{ steps.release.outputs.version \}\}\n {10}tags: \$\{\{ steps.image.outputs.tags \}\}/,
    )
    expect(buildAction()).toMatch(/push: \$\{\{ inputs.push \}\}/)
    expect(buildAction()).toMatch(/value: \$\{\{ steps.build.outputs.digest \}\}/)
    expect(source).toMatch(/subject-digest: \$\{\{ steps.build.outputs.digest \}\}/)
    expect(source).toContain("if: github.repository == 'hourmere/hourmere'")
    expect(source).toContain('subject-name: ghcr.io/hourmere/hourmere')
    expect(source).toContain('push-to-registry: true')
    expect(source).toContain('create-storage-record: false')
    expect(source).not.toContain('artifact-metadata: write')
    const prepare = source.split('  prepare:\n')[1]?.split('  ci:\n')[0] ?? ''
    expect(prepare).not.toMatch(
      /contents: write|packages: write|id-token: write|attestations: write/,
    )
    const publish = source.split('  publish:\n')[1] ?? ''
    const permissions = publish.split('    permissions:\n')[1]?.split('    steps:\n')[0] ?? ''
    expect(
      Array.from(
        permissions.matchAll(/^ {6}([a-z-]+): (read|write)/gm),
        (match) => `${match[1]}:${match[2]}`,
      ).sort(),
    ).toEqual([
      'actions:read',
      'attestations:write',
      'contents:write',
      'id-token:write',
      'packages:write',
    ])
    expect(buildAction()).toContain('org.opencontainers.image.licenses=AGPL-3.0-only')
  })

  it.each([
    [
      'false',
      '1.0.0',
      [
        'ghcr.io/hourmere/hourmere:1.0.0',
        'ghcr.io/hourmere/hourmere:1.0',
        'ghcr.io/hourmere/hourmere:latest',
      ],
    ],
    ['true', '1.0.0-rc.1', ['ghcr.io/hourmere/hourmere:1.0.0-rc.1']],
  ] as const)('selects real image tags with prerelease=%s', (prerelease, version, tags) => {
    const repo = fixture()
    const output = join(repo.dir, 'tags')
    const result = spawnSync('bash', ['-e', '-c', stepScript('Select image tags')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        VERSION: version,
        MAJOR_MINOR: '1.0',
        PRERELEASE: prerelease,
      },
    })
    expect(result.status).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(`tags<<IMAGE_TAGS\n${tags.join('\n')}\nIMAGE_TAGS\n`)
  })

  it.each(['true', 'false'])(
    'passes exact notes, verified tag and release flags (prerelease=%s)',
    (prerelease) => {
      const repo = fixture()
      const notes = join(repo.dir, 'notes with spaces.md')
      const argsFile = join(repo.dir, 'gh-args')
      writeFileSync(notes, 'Reviewed changelog notes.\n')
      // Only this local function handles gh: the real CLI is never invoked.
      const fake = 'gh() { printf "%s\\0" "$@" > "$TEST_ARGS_FILE"; }\n'
      const result = spawnSync(
        'bash',
        ['-e', '-c', fake + stepScript('Create the GitHub Release from the changelog')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_ARGS_FILE: argsFile,
            GITHUB_REF_NAME: 'v1.0.0',
            GITHUB_REPOSITORY: 'hourmere/hourmere',
            NOTES_FILE: notes,
            PRERELEASE: prerelease,
          },
        },
      )
      expect(result.status).toBe(0)
      expect(readFileSync(argsFile, 'utf8').split('\0').filter(Boolean)).toEqual([
        'release',
        'create',
        'v1.0.0',
        '--repo',
        'hourmere/hourmere',
        '--verify-tag',
        '--title',
        'v1.0.0',
        '--notes-file',
        notes,
        ...(prerelease === 'true' ? ['--prerelease', '--latest=false'] : ['--latest']),
      ])
    },
  )
})

describe('release publication checklist', () => {
  const docs = () =>
    readFileSync(
      process.env.HOURMERE_RELEASE_DOCS ??
        fileURLToPath(new URL('../docs/releasing.md', import.meta.url)),
      'utf8',
    ).replace(/\s+/g, ' ')

  it('rehearses anonymous native-platform pulls and attestation before image installation', () => {
    const rehearsal =
      docs().split('## RC image installation rehearsal')[1]?.split('## Verify publication')[0] ?? ''
    expect(rehearsal).toContain('No public image is available yet.')
    for (const platform of ['amd64', 'arm64']) {
      expect(rehearsal).toContain(
        `DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/${platform} ghcr.io/hourmere/hourmere:1.0.0-rc.1`,
      )
    }
    expect(rehearsal).toContain(
      'gh attestation verify oci://ghcr.io/hourmere/hourmere:1.0.0-rc.1 -R hourmere/hourmere',
    )
    expect(rehearsal).toContain(
      './scripts/setup.sh --image --version 1.0.0-rc.1 docker compose pull docker compose up -d --wait',
    )
    expect(rehearsal).toContain('never `latest` or `1.0`')
    expect(rehearsal).toContain(
      'Once `up` is attempted (or any migration runs earlier), use the pre-upgrade backup/restore procedure',
    )
  })

  it('holds the image documentation flip for verified release-day publication', () => {
    const checklist =
      docs().split(
        'Make the documentation changes in a separate follow-up after verifying public access:',
      )[1] ?? ''
    expect(checklist).toContain('**Release day: install from the published image**')
    expect(checklist).toContain(
      'only after anonymous pull and attestation verification succeed for stable `1.0.0`',
    )
    for (const file of [
      'README.md:2',
      'apps/site/src/content/docs/docs/self-hosting.md:8',
      'apps/site/src/legal-content.test.ts:80',
      'scripts/deploy-docs.test.ts',
      'scripts/restore-env.test.ts',
    ]) {
      expect(checklist).toContain(file)
    }
    expect(checklist).toContain('without weakening provider-acceptance guards')
  })

  it('completes setup preparation before tagging and leaves only docs in the release-day map', () => {
    const checklist = docs().split('## Verify publication and handle failures')[1] ?? ''
    const completed = checklist.split('**Done before tagging:**')[1]?.split('- After the first')[0]
    expect(completed).toContain('report the selected image version and its source')
    expect(completed).toContain(
      'reject a flag/environment version that differs from the exact checked-out release tag',
    )
    expect(completed).toContain('they do not assert that an image is public')
    const remaining = checklist.split('| File / preparation lines | Release-day change |')[1]
    expect(remaining).toBeDefined()
    for (const file of [
      'scripts/setup.sh',
      'scripts/setup.test.ts',
      '.env.example',
      'docker-compose.yml',
      'docker-compose.worker.yml',
      'scripts/enable-worker.sh',
    ]) {
      expect(completed).toContain(`\`${file}\``)
      expect(remaining).not.toContain(`\`${file}\``)
    }
  })

  it('updates the README introduction only after the first public image is published', () => {
    const checklist =
      docs().split(
        'Make the documentation changes in a separate follow-up after verifying public access:',
      )[1] ?? ''
    expect(checklist).toContain(
      'Update `README.md` line 2 (`Self-host from source`) to describe the published image.',
    )
  })

  it('checks automatic GHCR repository admin access after the first token push', () => {
    const [before, publication = ''] = docs().split('## Verify publication and handle failures')
    expect(before).not.toContain('Manage Actions access')
    expect(publication).toContain(
      "After the first authorized `GITHUB_TOKEN` push, check the GHCR package's **Manage Actions access** settings: publishing a package through a workflow automatically grants the repository **Admin** access",
    )
    expect(publication).toContain('Confirm **Admin** access, repair missing access')
    expect(publication).toContain(
      'https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry',
    )
  })

  it('explains that reusable CLI compatibility checks block release publication', () => {
    expect(docs()).toContain(
      'Its `cli-compatibility` job runs through `workflow_call` inside the release workflow, so a Node 22 compatibility failure blocks a release before publication.',
    )
  })

  it('uses the root CLI build before inspecting and publishing the standalone artifact', () => {
    const source = docs()
    expect(source).toContain('npm run cli:build npm pack --dry-run --workspace @hourmere/cli')
    expect(source).toContain(
      'The smoke command builds the compiled files through `npm run cli:build`',
    )
    expect(source).not.toContain('builds through `prepack`')
  })
})
