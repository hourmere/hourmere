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

function fixture(changelog = '## [Unreleased → 1.0.0]\n\n### Added\n\n- Scheduling.\n') {
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
  git('add', 'CHANGELOG.md')
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
    const repo = fixture('## [1.2.0-rc.1] - 2026-11-01\n\n- Candidate.\n')
    repo.git('tag', 'v1.2.0-rc.1')
    expect(repo.run('prepare', 'v1.2.0-rc.1', repo.sha).status).toBe(0)
    expect(repo.output()).toContain('version=1.2.0-rc.1\nmajor_minor=1.2\nprerelease=true\n')
  })

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

function stepScript(name: string) {
  const source = workflow().split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0] ?? ''
  const block = /^ {8}run: \|\n((?: {10}.*(?:\n|$))*)/m.exec(source)?.[1]
  expect(block, `Missing executable workflow step: ${name}`).toBeDefined()
  return (block ?? '').replace(/^ {10}/gm, '')
}

describe('release workflow boundaries', () => {
  it('permits only version tag pushes and requires reusable CI and protected approval', () => {
    const source = workflow()
    expect(source).toMatch(/on:\n {2}push:\n {4}tags: \['v\*\.\*\.\*'\]\n\npermissions: \{\}/)
    expect(source).not.toMatch(/workflow_dispatch:|pull_request:|branches:/)
    expect(source).toMatch(
      / {2}ci:\n {4}needs: prepare\n[\s\S]*?uses: \.\/\.github\/workflows\/ci.yml/,
    )
    expect(source).toMatch(
      / {2}publish:\n {4}needs: \[prepare, ci\][\s\S]*? {4}environment: release\n/,
    )
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
    for (const match of source.matchAll(/uses: ([^\n]+)/g)) {
      if (match[1]?.startsWith('./')) continue
      expect(match[1]).toMatch(/^[\w/-]+@[a-f0-9]{40}(?: #.*)?$/)
    }
    expect(source).toContain('platforms: linux/amd64,linux/arm64')
    expect(source).toContain('provenance: mode=max')
    expect(source).toContain('sbom: true')
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
    expect(source).toContain('org.opencontainers.image.licenses=AGPL-3.0-only')
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
