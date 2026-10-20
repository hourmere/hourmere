import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Step {
  id?: string
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, string | boolean | number>
}

interface Job {
  if?: string
  environment?: string
  needs?: string | string[]
  uses?: string
  permissions?: Record<string, string>
  steps?: Step[]
}

interface Workflow {
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

const source = readFileSync(
  process.env.HOURMERE_RELEASE_WORKFLOW ??
    new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const workflow = parse(source) as Workflow
const ci = parse(
  readFileSync(
    process.env.HOURMERE_RELEASE_CI_WORKFLOW ??
      new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ),
) as Workflow

const expression = (value: string) => `\${{ ${value} }}`

function step(job: string, name: string) {
  const found = workflow.jobs[job]?.steps?.find((candidate) => candidate.name === name)
  expect(found, `${job}: ${name}`).toBeDefined()
  return found as Step
}

function permissionScopes(value: unknown, path = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {}
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key
      return key === 'permissions' ? { [childPath]: child } : permissionScopes(child, childPath)
    }),
  )
}

function runSummary(script: string | undefined, env: Record<string, string>, notes?: string) {
  expect(script).toBeTypeOf('string')
  expect(script).not.toContain('${{')
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-release-summary-'))
  try {
    const summary = join(dir, 'summary with spaces.md')
    const notesFile = join(dir, 'notes with spaces $literal.md')
    writeFileSync(summary, 'Earlier summary.\n')
    if (notes !== undefined) writeFileSync(notesFile, notes)
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script ?? 'exit 99'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        GITHUB_STEP_SUMMARY: summary,
        NOTES_FILE: notesFile,
        ...env,
      },
      encoding: 'utf8',
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, 'should-not-exist'))).toBe(false)
    return readFileSync(summary, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('release approval visibility', () => {
  it('preserves every release permission scope and the existing required job IDs', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['prepare', 'ci', 'publish', 'publish-cli'])
    expect(permissionScopes(workflow)).toEqual({
      permissions: {},
      'jobs.prepare.permissions': { contents: 'read', actions: 'read' },
      'jobs.ci.permissions': { contents: 'read' },
      'jobs.publish.permissions': {
        actions: 'read',
        contents: 'write',
        packages: 'write',
        'id-token': 'write',
        attestations: 'write',
      },
      'jobs.publish-cli.permissions': { contents: 'read', 'id-token': 'write' },
    })
    expect(Object.keys(ci.jobs)).toEqual(['check', 'cli-compatibility', 'docker', 'e2e'])
    expect(permissionScopes(ci)).toEqual({ permissions: { contents: 'read' } })
  })

  it('prepares visible notes and an artifact before CI and the protected publishing jobs', () => {
    const prepare = workflow.jobs.prepare
    expect(prepare?.environment).toBeUndefined()
    expect(prepare?.needs).toBeUndefined()
    const names = prepare?.steps?.map((candidate) => candidate.name) ?? []
    const validation = names.indexOf('Validate the version, main ancestry and changelog')
    const ownerGate = names.indexOf('Require a configured owner approval gate')
    const summary = names.indexOf('Summarize the release notes for approval')
    const artifact = names.indexOf('Upload the extracted release notes')
    expect(validation).toBeGreaterThan(-1)
    expect(ownerGate).toBeGreaterThan(validation)
    expect(summary).toBeGreaterThan(ownerGate)
    expect(artifact).toBeGreaterThan(summary)
    for (const name of [names[summary], names[artifact]]) {
      expect(source.indexOf(`      - name: ${name}\n`)).toBeLessThan(source.indexOf('\n  ci:\n'))
      expect(source.indexOf(`      - name: ${name}\n`)).toBeLessThan(
        source.indexOf('    environment: release\n'),
      )
    }
    expect(workflow.jobs.ci?.needs).toBe('prepare')
    expect(workflow.jobs.ci?.uses).toBe('./.github/workflows/ci.yml')
    for (const job of ['publish', 'publish-cli']) {
      expect(workflow.jobs[job]?.needs).toEqual(['prepare', 'ci'])
      expect(workflow.jobs[job]?.environment).toBe('release')
    }
  })

  it('uses the extracted notes for both approval surfaces with a versioned SHA-pinned upload', () => {
    expect(step('prepare', 'Validate the version, main ancestry and changelog').id).toBe('release')
    const summary = step('prepare', 'Summarize the release notes for approval')
    expect(summary.env).toEqual({
      VERSION: expression('steps.release.outputs.version'),
      NOTES_FILE: expression('steps.release.outputs.notes_file'),
      PRERELEASE: expression('steps.release.outputs.prerelease'),
    })
    const artifact = step('prepare', 'Upload the extracted release notes')
    expect(artifact.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/)
    expect(source).toMatch(/uses: actions\/upload-artifact@[a-f0-9]{40} # v\d+\.\d+\.\d+\n/)
    expect(artifact.with).toEqual({
      name: 'release-notes',
      path: expression('steps.release.outputs.notes_file'),
      'if-no-files-found': 'error',
    })
  })

  it.each(['false', 'true'])(
    'appends exact notes and approval metadata (prerelease=%s)',
    (prerelease) => {
      const version = prerelease === 'true' ? '1.2.3-rc.1' : '1.2.3'
      const tag = `v${version}`
      const sha = '0123456789abcdef0123456789abcdef01234567'
      const notes =
        '### Fixed\n\nVerbatim: $(touch should-not-exist) `touch should-not-exist` "quotes" $HOME %s \\n\n[Upgrade](https://github.com/hourmere/hourmere/blob/v1.2.3/docs/releasing.md)\n'
      const summary = runSummary(
        step('prepare', 'Summarize the release notes for approval').run,
        { VERSION: version, GITHUB_REF_NAME: tag, GITHUB_SHA: sha, PRERELEASE: prerelease },
        notes,
      )
      expect(summary).toBe(
        `Earlier summary.\n## Release notes for approval\n\n- Version: ${version}\n- Tag: ${tag}\n- Commit SHA: ${sha}\n- Prerelease: ${prerelease}\n\n${notes}`,
      )
    },
  )

  it('summarizes the pushed digest and attestation outputs after both operations', () => {
    const steps = workflow.jobs.publish?.steps ?? []
    const build = steps.findIndex((candidate) => candidate.id === 'build')
    const attest = steps.findIndex((candidate) => candidate.id === 'attest')
    const summary = steps.findIndex(
      (candidate) => candidate.name === 'Summarize the published image',
    )
    const release = steps.findIndex(
      (candidate) => candidate.name === 'Create the GitHub Release from the changelog',
    )
    expect(build).toBeGreaterThan(-1)
    expect(steps[build]?.with?.push).toBe(true)
    expect(attest).toBeGreaterThan(build)
    expect(steps[attest]?.uses).toMatch(/^actions\/attest@[a-f0-9]{40}$/)
    expect(summary).toBeGreaterThan(attest)
    expect(release).toBeGreaterThan(summary)
    expect(step('publish', 'Summarize the published image').env).toEqual({
      IMAGE_DIGEST: expression('steps.build.outputs.digest'),
      IMAGE_TAGS: expression('steps.image.outputs.tags'),
      ATTESTATION_URL: expression('steps.attest.outputs.attestation-url'),
      ATTESTATION_ID: expression('steps.attest.outputs.attestation-id'),
    })
  })

  it.each([
    [
      'ghcr.io/hourmere/hourmere:1.2.3',
      'ghcr.io/hourmere/hourmere:1.2',
      'ghcr.io/hourmere/hourmere:latest',
    ],
    ['ghcr.io/hourmere/hourmere:1.2.3-rc.1'],
  ])('appends the digest, every pushed tag and attestation URL/ID (%j)', (...tags) => {
    const digest = `sha256:${'a'.repeat(64)}`
    const url = 'https://github.com/hourmere/hourmere/attestations/12345'
    const id = '12345'
    const summary = runSummary(step('publish', 'Summarize the published image').run, {
      IMAGE_DIGEST: digest,
      IMAGE_TAGS: tags.join('\n'),
      ATTESTATION_URL: url,
      ATTESTATION_ID: id,
    })
    expect(summary).toBe(
      `Earlier summary.\n## Published image\n\n- Digest: ${digest}\n- Attestation URL: ${url}\n- Attestation ID: ${id}\n\n### Pushed tags\n\n\`\`\`text\n${tags.join('\n')}\n\`\`\`\n`,
    )
  })
})

describe('launch-only npm release scaffold', () => {
  it('disables every job that could publish a package', () => {
    const publishers = Object.values(workflow.jobs).filter((job) =>
      (job.steps ?? []).some((step) => /\bnpm publish\b/.test(step.run ?? '')),
    )
    expect(publishers).toHaveLength(1)
    for (const job of publishers) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
      expect(job.if).toBe('${{ false }}')
      expect(job.environment).toBe('release')
    }
  })

  it('requires release preparation and CI with only npm provenance permissions', () => {
    const job = workflow.jobs['publish-cli']
    expect(job?.needs).toEqual(['prepare', 'ci'])
    expect(job?.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
  })

  it('refuses an unstamped or mismatched CLI release version', () => {
    const guard = workflow.jobs['publish-cli']?.steps?.find((step) =>
      step.name?.startsWith('Require the committed CLI version'),
    )?.run
    expect(guard).toBeTypeOf('string')
    const dir = mkdtempSync(join(tmpdir(), 'hourmere-cli-release-'))
    try {
      mkdirSync(join(dir, 'tools/cli'), { recursive: true })
      for (const [version, tag, expected] of [
        ['0.0.0', 'v0.0.0', 1],
        ['1.0.0', 'v1.0.1', 1],
        ['1.0.0', 'main', 1],
        ['1.0.0', 'v1.0.0', 0],
      ] as const) {
        writeFileSync(join(dir, 'tools/cli/package.json'), JSON.stringify({ version }))
        const result = spawnSync('sh', ['-c', guard ?? 'exit 99'], {
          cwd: dir,
          env: { PATH: process.env.PATH, GITHUB_REF_NAME: tag },
          encoding: 'utf8',
        })
        expect(result.error).toBeUndefined()
        expect(result.status, `${version} with ${tag}`).toBe(expected)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
