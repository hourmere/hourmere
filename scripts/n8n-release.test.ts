import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const workflows = join(root, '.github/workflows')
const releaseFile = 'n8n-release.yml'
const release = parse(readFileSync(join(workflows, releaseFile), 'utf8'))
const buildJob = release.jobs.build
const releaseJob = release.jobs.stage
const workdir = 'tools/n8n-nodes-hourmere'
const tarball = 'hourmere-n8n-release.tgz'
const stageCommand = `npm stage publish "$RUNNER_TEMP/n8n-artifact/${tarball}" --registry=https://registry.npmjs.org/ --provenance --access public --ignore-scripts`

const runBash = (command: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-eo', 'pipefail', '-c', command], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  })

it('limits release credentials to the reviewed stage job after a successful manual tag build', () => {
  expect(Object.keys(release.on)).toEqual(['workflow_dispatch'])
  expect(release.on.workflow_dispatch.inputs.bootstrap).toMatchObject({
    type: 'boolean',
    default: false,
  })
  expect(release.permissions).toEqual({})
  expect(Object.keys(release.jobs).sort()).toEqual(['build', 'stage'])
  expect(buildJob).toMatchObject({
    if: "github.repository == 'hourmere/hourmere' && github.ref_type == 'tag' && startsWith(github.ref_name, 'n8n-v')",
    defaults: { run: { 'working-directory': workdir } },
  })
  expect(buildJob).not.toHaveProperty('environment')
  expect(buildJob.permissions).toEqual({ contents: 'read' })
  expect(JSON.stringify(buildJob)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|ACTIONS_ID_TOKEN/)
  expect(releaseJob).toMatchObject({
    needs: 'build',
    'runs-on': 'ubuntu-latest',
    environment: 'n8n-npm-release',
  })
  expect(releaseJob).not.toHaveProperty('if')
  expect(releaseJob.permissions).toEqual({ actions: 'read', contents: 'read', 'id-token': 'write' })
})

describe('deployment environment guard', () => {
  const environment = {
    can_admins_bypass: false,
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  }
  const tagRule = { name: 'n8n-v*', type: 'tag' }
  const policies = { total_count: 1, branch_policies: [tagRule] }
  const check = (environmentResponse: unknown, policyResponse: unknown) =>
    runBash(
      `gh() {
        case "$*" in
          'api repos/hourmere/hourmere/environments/n8n-npm-release') printf '%s' "$ENVIRONMENT" ;;
          'api repos/hourmere/hourmere/environments/n8n-npm-release/deployment-branch-policies') printf '%s' "$POLICIES" ;;
          *) return 1 ;;
        esac
      }
      ${releaseJob.steps[0].run}`,
      {
        ENVIRONMENT: JSON.stringify(environmentResponse),
        POLICIES: JSON.stringify(policyResponse),
      },
    )

  it('allows reviewers, disabled admin bypass and exactly one matching tag rule', () => {
    const result = check(environment, policies)
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    ['no reviewers', { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }],
    ['admin bypass enabled', { can_admins_bypass: true }],
    ['admin bypass missing', { can_admins_bypass: undefined }],
    ['no custom policies', { deployment_branch_policy: undefined }],
    [
      'protected branches enabled',
      { deployment_branch_policy: { custom_branch_policies: true, protected_branches: true } },
    ],
  ])('rejects an environment with %s', (_, overrides) => {
    const result = check({ ...environment, ...overrides }, policies)
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('Require reviewers, disable admin bypass')
  })

  it.each([
    ['a missing tag rule', []],
    ['a broad tag rule', [{ ...tagRule, name: '*' }]],
    ['a branch rule instead of a tag rule', [{ ...tagRule, type: 'branch' }]],
    ['an extra branch rule', [tagRule, { name: 'main', type: 'branch' }]],
  ])('rejects %s', (_, rules) => {
    const result = check(environment, { total_count: rules.length, branch_policies: rules })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('Configure n8n-v* as the only deployment tag policy')
  })

  it('fails closed when GitHub returns no environment or policy response', () => {
    expect(check(null, policies).status).toBe(1)
    expect(check(environment, null).status).toBe(1)
  })
})

it('validates, builds and tests before staging the same verified tarball', () => {
  expect(buildJob.steps.slice(2, -2).map((step: { run?: string }) => step.run)).toEqual([
    'node scripts/check-release.mjs',
    'npm ci --ignore-scripts',
    'npm run lint',
    'npm run typecheck',
    'npm run build',
    'npm test',
  ])
  const pack = buildJob.steps.at(-2)
  const upload = buildJob.steps.at(-1)
  expect(pack.id).toBe('pack')
  expect(pack.env).toEqual({ HOURMERE_N8N_PUBLISH: '1' })
  expect(pack.run).toContain(`node scripts/pack-smoke.mjs "$RUNNER_TEMP/${tarball}"`)
  expect(upload).toMatchObject({
    id: 'upload',
    uses: expect.stringMatching(/^actions\/upload-artifact@[a-f0-9]{40}$/),
    with: { path: `\${{ runner.temp }}/${tarball}`, archive: false, 'if-no-files-found': 'error' },
  })
  expect(buildJob.outputs).toEqual({
    'artifact-id': '${{ steps.upload.outputs.artifact-id }}',
    sha512: '${{ steps.pack.outputs.sha512 }}',
    sha1: '${{ steps.pack.outputs.sha1 }}',
  })
  expect(
    releaseJob.steps.map(
      (step: { name?: string; uses?: string }) => step.uses?.split('@')[0] ?? step.name,
    ),
  ).toEqual([
    'Require reviewers and restrict the environment to release tags',
    'actions/download-artifact',
    'Verify the downloaded tarball against the build SHA-512',
    'actions/checkout',
    'actions/setup-node',
    'Require the version tag and changelog on main',
    'Stage the verified tarball with npm provenance',
  ])
  const [, download, verify, checkout, setupNode, guard] = releaseJob.steps
  expect(download).toMatchObject({
    uses: expect.stringMatching(/^actions\/download-artifact@[a-f0-9]{40}$/),
    with: {
      'artifact-ids': '${{ needs.build.outputs.artifact-id }}',
      path: '${{ runner.temp }}/n8n-artifact',
      'skip-decompress': true,
    },
  })
  expect(verify.env).toEqual({ BUILD_SHA512: '${{ needs.build.outputs.sha512 }}' })
  expect(checkout.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false })
  expect(setupNode.with).toMatchObject({ 'package-manager-cache': false })
  expect(guard.run).toBe(`node ${workdir}/scripts/check-release.mjs`)

  const stage = releaseJob.steps.at(-1)
  expect(stage.env.NODE_AUTH_TOKEN).toBe(
    "${{ inputs.bootstrap && secrets.N8N_NPM_BOOTSTRAP_TOKEN || '' }}",
  )
  expect(stage['working-directory']).toBe('${{ runner.temp }}')
  expect(stage.run).toContain('test "$GITHUB_REF" = refs/tags/n8n-v0.1.0')
  expect(stage.run).toContain('test "$status" = 404')
  expect(stage.run.trimEnd().split('\n').at(-1)).toBe(stageCommand)
  const stageCommands: string[] = releaseJob.steps.flatMap(
    (step: { run?: string }) =>
      step.run?.split('\n').filter((line) => /^\s*(npm|node)\s/.test(line)) ?? [],
  )
  expect(stageCommands.map((command) => command.trim())).toEqual([guard.run, stageCommand])
})

it('reports both build digests and fails to stage changed bytes or a missing build digest', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hourmere-n8n-digest-test-'))
  try {
    const bytes = 'release tarball fixture'
    const sha512 = createHash('sha512').update(bytes).digest('hex')
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const pack = buildJob.steps.at(-2).run
    const output = join(scratch, 'output')
    const summary = join(scratch, 'summary')
    const built = runBash(`node() { printf '%s' "$BYTES" > "$2"; }\n${pack}`, {
      RUNNER_TEMP: scratch,
      BYTES: bytes,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REF_NAME: 'n8n-v0.1.0',
    })
    expect(built.status, built.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(`sha512=${sha512}\nsha1=${sha1}\n`)
    const buildSummary = readFileSync(summary, 'utf8')
    expect(buildSummary).toContain(`SHA-512 \`${sha512}\``)
    expect(buildSummary).toContain(`SHA-1 \`${sha1}\``)

    mkdirSync(join(scratch, 'n8n-artifact'))
    const downloaded = join(scratch, 'n8n-artifact', tarball)
    const verify = (digest: string) =>
      runBash(releaseJob.steps[2].run, { RUNNER_TEMP: scratch, BUILD_SHA512: digest })
    writeFileSync(downloaded, readFileSync(join(scratch, tarball)))
    expect(verify(sha512).status).toBe(0)
    writeFileSync(downloaded, 'changed tarball fixture')
    const mismatch = verify(sha512)
    expect(mismatch.status).toBe(1)
    expect(mismatch.stderr).toContain('tarball SHA-512 differs from the build output')
    expect(verify('').status).toBe(1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

type Step = {
  run?: string
  uses?: string
  'working-directory'?: string
  with?: { publish?: string }
}

const registryWrite =
  /\b(?:npm(?:@[^\s;&|]+)?|pnpm|yarn|bun)(?=[ \t])[^;&|]*[ \t](?:publish|pub|pu|stage)(?=$|[\s;&|)<>])|\bnpm\s+run(?:-script)?\s+release\b|\bn8n-node\s+release\b/
const inlineNodeEval = /\bnode[ \t]+(?:-e|--eval)(?:[ \t]+|=)$/
const execSyncLiteral = /\bexecSync\s*\(\s*(['"])(.*?)\1/g

function publishCommands(step: Step): string[] {
  const commands = (step.run ?? '')
    .replace(/\\\r?\n/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line.startsWith('#')) return false
      let inlineRegistryWrite = false
      const words = line.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted, offset: number) => {
        const contents = quoted.slice(1, -1)
        if (inlineNodeEval.test(line.slice(0, offset))) {
          const source = quoted.startsWith('"') ? contents.replace(/\\(["\\$`])/g, '$1') : contents
          inlineRegistryWrite ||= [...source.matchAll(execSyncLiteral)].some(
            ([, , command]) => command !== undefined && registryWrite.test(command),
          )
        }
        // Keep commands in double-quoted substitutions visible while masking quoted prose.
        if (quoted.startsWith('"') && /\$\(|`/.test(quoted)) return quoted
        return contents.replace(/[\s;&|]/g, '_')
      })
      return inlineRegistryWrite || registryWrite.test(words)
    })
  const action = step.uses?.split('@')[0]?.toLowerCase() ?? ''
  if (
    /publish|semantic-release/.test(action) ||
    (action === 'changesets/action' && step.with?.publish)
  ) {
    commands.push(`uses: ${step.uses}`)
  }
  return commands
}

it.each([
  ['versioned npm via npx', 'npx -y npm@11 publish'],
  ['Bun', 'bun publish'],
  ['Node execSync', `node -e "require('node:child_process').execSync('npm publish')"`],
])('flags %s publishing in a workflow step', (_, run) => {
  const { steps } = parse(`steps:\n  - run: |\n      ${run}\n`) as { steps: Step[] }
  expect(steps.flatMap(publishCommands)).toEqual([run])
})

it('allows quoted publishing examples in shell and Node output', () => {
  const run = `echo 'bun publish'\nnode -e "console.log('npm publish')"`
  expect(publishCommands({ run })).toEqual([])
})

it('reserves n8n npm credentials and publishing commands for the manual workflow', () => {
  type Job = Step & { if?: string; steps?: Step[] }
  const releaseEntrypoints = /N8N_NPM_BOOTSTRAP_TOKEN|HOURMERE_N8N_PUBLISH|n8n-npm-release/

  const writes = []
  for (const file of readdirSync(workflows)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()) {
    const yaml = readFileSync(join(workflows, file), 'utf8')
    if (file !== releaseFile) expect(yaml, file).not.toMatch(releaseEntrypoints)
    const { jobs } = parse(yaml) as { jobs: Record<string, Job> }
    for (const [job, config] of Object.entries(jobs)) {
      for (const step of [config, ...(config.steps ?? [])]) {
        for (const command of publishCommands(step)) {
          writes.push({
            file,
            job,
            condition: config.if,
            directory: step['working-directory'],
            command,
          })
        }
      }
    }
  }
  expect(writes).toEqual([
    {
      file: releaseFile,
      job: 'stage',
      condition: releaseJob.if,
      directory: `\${{ runner.temp }}`,
      command: stageCommand,
    },
    {
      file: 'release.yml',
      job: 'publish-cli',
      condition: `\${{ false }}`,
      directory: 'tools/cli',
      command: 'npm publish --provenance --access public',
    },
  ])
  const actions = join(root, '.github/actions')
  for (const file of readdirSync(actions, { encoding: 'utf8', recursive: true }).filter((file) =>
    /\.ya?ml$/.test(file),
  )) {
    const yaml = readFileSync(join(actions, file), 'utf8')
    expect(yaml, file).not.toMatch(releaseEntrypoints)
    const { runs } = parse(yaml)
    for (const step of (runs.steps ?? []) as Step[]) {
      expect(publishCommands(step), file).toEqual([])
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
