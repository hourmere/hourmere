import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const workflows = join(root, '.github/workflows')
const releaseFile = 'n8n-release.yml'
const release = parse(readFileSync(join(workflows, releaseFile), 'utf8'))
const releaseJob = release.jobs.stage
const workdir = 'tools/n8n-nodes-hourmere'
const tarball = '"$RUNNER_TEMP/hourmere-n8n-release.tgz"'
const stageCommand = `npm stage publish ${tarball} --provenance --access public --ignore-scripts`

it('requires manual tag dispatch, a reviewed environment and GitHub OIDC', () => {
  expect(Object.keys(release.on)).toEqual(['workflow_dispatch'])
  expect(release.on.workflow_dispatch.inputs.bootstrap).toMatchObject({
    type: 'boolean',
    default: false,
  })
  expect(release.permissions).toEqual({})
  expect(Object.keys(release.jobs)).toEqual(['stage'])
  expect(releaseJob).toMatchObject({
    if: "github.repository == 'hourmere/hourmere' && github.ref_type == 'tag' && startsWith(github.ref_name, 'n8n-v')",
    'runs-on': 'ubuntu-latest',
    environment: 'n8n-npm-release',
    permissions: { actions: 'read', contents: 'read', 'id-token': 'write' },
    defaults: { run: { 'working-directory': workdir } },
  })
  expect(releaseJob.steps[0].run).toContain('select(.type == "required_reviewers")')
})

it.each([
  [0, 1],
  [1, 0],
])('exits %i-reviewer environments with status %i', (reviewers, exitCode) => {
  const result = spawnSync(
    'bash',
    ['-e', '-c', `gh() { echo ${reviewers}; }\n${releaseJob.steps[0].run}`],
    {
      encoding: 'utf8',
    },
  )
  expect(result.status, result.stderr).toBe(exitCode)
  if (exitCode !== 0)
    expect(result.stderr).toContain('Configure required reviewers before releasing')
})

it('validates, builds and tests before staging the same verified tarball', () => {
  const commands = releaseJob.steps.flatMap((step: { run?: string }) => step.run ?? []) as string[]
  expect(commands.slice(1, -2)).toEqual([
    'node scripts/check-release.mjs',
    'npm ci --ignore-scripts',
    'npm run lint',
    'npm run typecheck',
    'npm run build',
    'npm test',
  ])
  const pack = releaseJob.steps.at(-2)
  expect(pack.env).toEqual({ HOURMERE_N8N_PUBLISH: '1' })
  expect(pack.run).toContain(`node scripts/pack-smoke.mjs ${tarball}`)
  const stage = releaseJob.steps.at(-1)
  expect(stage.env.NODE_AUTH_TOKEN).toBe(
    `\${{ inputs.bootstrap && secrets.N8N_NPM_BOOTSTRAP_TOKEN || '' }}`,
  )
  expect(stage.run).toContain('test "$GITHUB_REF" = refs/tags/n8n-v0.1.0')
  expect(stage.run).toContain('test "$status" = 404')
  expect(stage.run.trimEnd().endsWith(stageCommand)).toBe(true)
})

it('reserves n8n npm credentials and publishing commands for the manual workflow', () => {
  type Step = { run?: string; 'working-directory'?: string }
  type Job = { if?: string; steps?: Step[] }
  const registryWrite =
    /\bnpm\s+(?:(?:stage\s+)?(?:publish|pu|pub)\b|run\s+release\b)|\bn8n-node\s+release\b/
  const releaseEntrypoints = /N8N_NPM_BOOTSTRAP_TOKEN|HOURMERE_N8N_PUBLISH|n8n-npm-release/
  const writes = []
  for (const file of readdirSync(workflows)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()) {
    const yaml = readFileSync(join(workflows, file), 'utf8')
    if (file !== releaseFile) expect(yaml, file).not.toMatch(releaseEntrypoints)
    const { jobs } = parse(yaml) as { jobs: Record<string, Job> }
    for (const [job, config] of Object.entries(jobs)) {
      for (const step of config.steps ?? []) {
        if (step.run && registryWrite.test(step.run)) {
          writes.push({ file, job, condition: config.if, directory: step['working-directory'] })
        }
      }
    }
  }
  expect(writes).toEqual([
    { file: releaseFile, job: 'stage', condition: releaseJob.if, directory: undefined },
    { file: 'release.yml', job: 'publish-cli', condition: `\${{ false }}`, directory: 'tools/cli' },
  ])
  const actions = join(root, '.github/actions')
  for (const file of readdirSync(actions, { encoding: 'utf8', recursive: true }).filter((file) =>
    /\.ya?ml$/.test(file),
  )) {
    const { runs } = parse(readFileSync(join(actions, file), 'utf8'))
    for (const step of (runs.steps ?? []) as Step[]) {
      expect(step.run ?? '', file).not.toMatch(registryWrite)
      expect(step.run ?? '', file).not.toMatch(releaseEntrypoints)
    }
  }
})

describe('release tag and changelog gate', () => {
  it('accepts only the matching tag and version on main with a changelog entry', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hourmere-n8n-release-test-'))
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: scratch,
        encoding: 'utf8',
      }).trim()
    const changelog = join(scratch, 'CHANGELOG.md')
    const check = (ref = 'refs/tags/n8n-v0.1.0') =>
      spawnSync(process.execPath, ['scripts/check-release.mjs'], {
        cwd: scratch,
        env: { ...process.env, GITHUB_REF: ref },
        encoding: 'utf8',
      })
    try {
      mkdirSync(join(scratch, 'scripts'))
      writeFileSync(
        join(scratch, 'scripts/check-release.mjs'),
        readFileSync(join(root, workdir, 'scripts/check-release.mjs')),
      )
      writeFileSync(join(scratch, 'package.json'), JSON.stringify({ version: '0.1.0' }))
      writeFileSync(changelog, '# Changelog\n\n## 0.1.0\n\n- Add Hourmere.\n')
      git('init', '--quiet')
      git('add', '.')
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'Release',
      )
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      expect(check().status).toBe(1)
      git('tag', 'n8n-v0.1.0')
      const valid = check()
      expect(valid.status, valid.stderr).toBe(0)

      const wrongRef = check('refs/tags/n8n-v0.2.0')
      expect(wrongRef.status).toBe(1)
      expect(wrongRef.stderr).toContain('Dispatch the workflow on refs/tags/n8n-v0.1.0')

      writeFileSync(changelog, '# Changelog\n\n## 0.1.0\n\n## 0.1.01\n\n- Unrelated.\n')
      const missingEntry = check()
      expect(missingEntry.status).toBe(1)
      expect(missingEntry.stderr).toContain('Add a ## 0.1.0 entry to CHANGELOG.md')
      git('checkout', '--', 'CHANGELOG.md')

      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '--quiet',
        '-m',
        'Unmerged',
      )
      const wrongCommit = check()
      expect(wrongCommit.status).toBe(1)
      expect(wrongCommit.stderr).toContain('tag must point to the checked-out commit')
      git('tag', '--force', 'n8n-v0.1.0')
      const unmerged = check()
      expect(unmerged.status).toBe(1)
      expect(unmerged.stderr).toContain('tag must point to a commit on origin/main')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
