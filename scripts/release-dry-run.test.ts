import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Step {
  name?: string
  id?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string | number | boolean>
}

interface Job {
  needs?: string | string[]
  uses?: string
  permissions?: Record<string, string>
  secrets?: unknown
  outputs?: Record<string, string>
  steps?: Step[]
}

interface Workflow {
  on: Record<
    string,
    { inputs?: Record<string, { default?: string; description?: string; type?: string }> }
  >
  permissions: Record<string, string>
  concurrency?: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, Job>
}

interface Action {
  inputs: Record<string, { default?: string }>
  outputs: Record<string, { value: string }>
  runs: { using: string; steps: Step[] }
}

const root = new URL('../', import.meta.url)
const workflowPath =
  process.env.HOURMERE_DRY_RUN_WORKFLOW ??
  fileURLToPath(new URL('.github/workflows/release-dry-run.yml', root))
const actionPath =
  process.env.HOURMERE_RELEASE_BUILD_ACTION ??
  fileURLToPath(new URL('.github/actions/release-build/action.yml', root))
const read = <T>(path: string | URL) => parse(readFileSync(path, 'utf8')) as T
const dryRun = () => read<Workflow>(workflowPath)
const buildAction = () => read<Action>(actionPath)
const ci = () =>
  read<Workflow>(
    process.env.HOURMERE_RELEASE_CI_WORKFLOW ?? new URL('.github/workflows/ci.yml', root),
  )
const sharedAction = './.github/actions/release-build'
const expression = (value: string) => `\${{ ${value} }}`
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function step(job: string, id: string) {
  const found = dryRun().jobs[job]?.steps?.find((candidate) => candidate.id === id)
  expect(found, `${job} must include step ${id}`).toBeDefined()
  return found as Step
}

function fixture(
  changelog = '## [Unreleased → 1.0.0]\n\n- Candidate release.\n',
  version = '1.0.0',
) {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-release-dry-run-'))
  scratch.push(dir)
  const env = {
    PATH: process.env.PATH,
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
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ version })}\n`)
  git('add', 'CHANGELOG.md', 'package.json')
  git('commit', '--quiet', '-m', 'Prepare fixture')
  // Fetching this origin never uses a network or any publication credentials.
  git('remote', 'add', 'origin', dir)
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'))
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(
    process.env.HOURMERE_RELEASE_PREPARE_SCRIPT ?? new URL('scripts/release.ts', root),
    join(dir, 'scripts/release.ts'),
  )
  const sha = git('rev-parse', 'HEAD')
  const run = (source: string, extra: Record<string, string>) =>
    spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', source], {
      cwd: dir,
      env: { ...env, GITHUB_SHA: sha, ...extra },
      encoding: 'utf8',
    })
  return { dir, git, sha, run, output: () => readFileSync(env.GITHUB_OUTPUT, 'utf8') }
}

function allSteps() {
  return [
    ...Object.values(dryRun().jobs).flatMap((job) => job.steps ?? []),
    ...Object.values(ci().jobs).flatMap((job) => job.steps ?? []),
    ...buildAction().runs.steps,
  ]
}

describe('release dry-run workflow boundaries', () => {
  it('runs only by manual dispatch with a version input matching the manifest and changelog', () => {
    const workflow = dryRun()
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.on.workflow_dispatch?.inputs?.version?.type).toBe('string')
    expect(workflow.on.workflow_dispatch?.inputs?.version?.description).toContain(
      'must equal the root package.json version',
    )
    const version = workflow.on.workflow_dispatch?.inputs?.version?.default
    expect(version).toBeTypeOf('string')
    const repo = fixture(readFileSync(new URL('CHANGELOG.md', root), 'utf8'), version)
    const tag = repo.run(step('prepare', 'tag').run ?? 'exit 99', { VERSION: version ?? '' })
    expect(tag.status, tag.stderr).toBe(0)
    const prepare = repo.run(step('prepare', 'release').run ?? 'exit 99', {
      RELEASE_TAG: `v${version}`,
    })
    expect(prepare.status, prepare.stderr).toBe(0)
    expect(readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')).toContain(
      '### Upgrade notes',
    )
  })

  it.each(['check', 'e2e', 'docker'])(
    'preserves the required branch-protection CI job id %s',
    (id) => {
      expect(Object.hasOwn(ci().jobs, id)).toBe(true)
    },
  )

  it('grants only contents read, including every caller job and reusable CI override', () => {
    const workflow = dryRun()
    expect(workflow.permissions).toEqual({ contents: 'read' })
    for (const job of Object.values(workflow.jobs)) {
      if (job.uses !== undefined) expect(job.uses).toBe('./.github/workflows/ci.yml')
      if (job.permissions !== undefined) expect(job.permissions).toEqual({ contents: 'read' })
    }
    const reusable = ci()
    expect(reusable.on).toHaveProperty('workflow_call')
    expect(reusable.permissions).toEqual({ contents: 'read' })
    for (const job of Object.values(reusable.jobs)) {
      expect(job.uses).toBeUndefined()
      if (job.permissions !== undefined) expect(job.permissions).toEqual({ contents: 'read' })
    }
    for (const source of [workflow, reusable, buildAction()]) {
      expect(JSON.stringify(source)).not.toMatch(
        /"secrets"|\bsecrets\s*\.|\bgithub\s*\.\s*token\b/i,
      )
    }
  })

  it('requires successful preparation and all reusable CI gates before building', () => {
    const workflow = dryRun()
    expect(workflow.jobs.ci?.uses).toBe('./.github/workflows/ci.yml')
    expect(workflow.jobs.ci?.needs).toBe('prepare')
    expect(workflow.jobs.build?.needs).toEqual(['prepare', 'ci'])
    expect(workflow.jobs.prepare?.outputs?.version).toBe(
      expression('steps.release.outputs.version'),
    )
    expect(workflow.jobs.build?.uses).toBeUndefined()
    expect(ci().concurrency).toEqual({
      group: `ci-${expression('github.workflow')}-${expression('github.ref')}`,
      'cancel-in-progress': true,
    })
  })

  it('never logs in, attests a publication, runs a publishing command or adds a hidden action', () => {
    const steps = allSteps()
    expect(steps.length).toBeGreaterThan(0)
    for (const candidate of steps) {
      if (candidate.uses?.startsWith('./')) {
        expect(candidate.uses).toBe(sharedAction)
      } else if (candidate.uses !== undefined) {
        expect(candidate.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/)
        expect(candidate.uses).not.toMatch(/(?:login|attest)/i)
      }
      expect(candidate.run ?? '').not.toMatch(
        /\b(?:git|docker)\s+(?:-[^\s]+\s+)*push\b|\bgh\s+(?:release|attestation)\b|\bnpm\s+publish\b|(?:^|\s)--push(?:\s|$)/,
      )
    }
    for (const candidate of Object.values(dryRun().jobs).flatMap((job) => job.steps ?? [])) {
      if (candidate.uses?.startsWith('docker/build-push-action@')) {
        expect(candidate.with?.push).toBe(false)
        expect(candidate.with?.outputs).not.toMatch(/type=(?:registry|image)/)
      }
    }
    expect(buildAction().runs.using).toBe('composite')
  })

  it('checks out full history without retaining credentials in every dry-run checkout', () => {
    const checkouts = Object.values(dryRun().jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))
    expect(checkouts).toHaveLength(2)
    for (const checkout of checkouts) {
      expect(checkout.with?.['fetch-depth']).toBe(0)
      expect(checkout.with?.['persist-credentials']).toBe(false)
    }
  })

  it('uses the same combined architecture build with local OCI output and literal push false', () => {
    const caller = step('build', 'build')
    expect(caller.uses).toBe(sharedAction)
    expect(caller.with?.push).toBe(false)
    expect(caller.with?.outputs).toBe(
      `type=oci,dest=${expression('runner.temp')}/hourmere-dry-run.oci.tar`,
    )
    expect(caller.with?.version).toBe(expression('needs.prepare.outputs.version'))
    expect(caller.with?.tags).toBe(
      `hourmere-dry-run:${expression('needs.prepare.outputs.version')}`,
    )
    const steps = buildAction().runs.steps
    expect(buildAction().inputs.push?.default).toBe('false')
    expect(buildAction().outputs['build-ref']?.value).toBe(
      expression(
        "steps.build.outputs.metadata && fromJSON(steps.build.outputs.metadata)['buildx.build.ref']",
      ),
    )
    expect(steps.some((candidate) => candidate.uses?.startsWith('docker/setup-qemu-action@'))).toBe(
      true,
    )
    expect(
      steps.some((candidate) => candidate.uses?.startsWith('docker/setup-buildx-action@')),
    ).toBe(true)
    const builds = steps.filter((candidate) =>
      candidate.uses?.startsWith('docker/build-push-action@'),
    )
    expect(builds).toHaveLength(1)
    const config = builds[0]?.with
    expect(config?.context).toBe('.')
    expect(config?.file).toBe('./Dockerfile')
    expect(config?.platforms).toBe('linux/amd64,linux/arm64')
    expect(config?.push).toBe(expression('inputs.push'))
    expect(config?.outputs).toBe(expression('inputs.outputs'))
    expect(config?.provenance).toBe('mode=max')
    expect(config?.sbom).toBeTypeOf('string')
    expect(config?.sbom).toMatch(/^generator=\S+@sha256:[a-f0-9]{64}$/)
  })

  it.each(['1.0.0', '1.0.0-rc.0'])(
    'passes input as data, then prepares the local tag through the real release validator: %s',
    (version) => {
      const tag = step('prepare', 'tag')
      expect(tag.name).toBe('Create a runner-local version tag')
      expect(tag.env?.VERSION).toBe(expression('inputs.version'))
      expect(tag.run).not.toContain('${{')
      const prepare = step('prepare', 'release')
      expect(prepare.env?.RELEASE_TAG).toBe(expression('steps.tag.outputs.tag'))
      expect(prepare.run).toContain('node scripts/release.ts prepare "$RELEASE_TAG" "$GITHUB_SHA"')
      const repo = fixture(`## [Unreleased → ${version}]\n\n- Candidate release.\n`, version)
      const result = repo.run(tag.run ?? 'exit 99', { VERSION: version })
      expect(result.status, result.stderr).toBe(0)
      expect(repo.git('tag', '--list')).toBe(`v${version}`)
      expect(repo.git('rev-parse', `v${version}`)).toBe(repo.sha)
      expect(JSON.parse(repo.git('show', 'HEAD:package.json'))).toEqual({ version })
      expect(repo.output()).toBe(`tag=v${version}\n`)
      const prepared = repo.run(prepare.run ?? 'exit 99', { RELEASE_TAG: `v${version}` })
      expect(prepared.status, prepared.stderr).toBe(0)
      expect(readFileSync(join(repo.dir, 'hourmere-release-notes.md'), 'utf8')).toBe(
        '- Candidate release.\n',
      )
      expect(repo.git('tag', '--list')).toBe(`v${version}`)
    },
  )

  it('refuses a dry-run version that differs from the committed root manifest', () => {
    const repo = fixture('## [Unreleased → 1.0.0-rc.0]\n\n- Candidate release.\n', '1.0.0')
    const tagged = repo.run(step('prepare', 'tag').run ?? 'exit 99', {
      VERSION: '1.0.0-rc.0',
    })
    expect(tagged.status, tagged.stderr).toBe(0)
    const prepared = repo.run(step('prepare', 'release').run ?? 'exit 99', {
      RELEASE_TAG: 'v1.0.0-rc.0',
    })
    expect(prepared.status).toBe(1)
    expect(prepared.stderr).toContain('Release preparation failed')
    expect(existsSync(join(repo.dir, 'hourmere-release-notes.md'))).toBe(false)
    expect(repo.output()).toBe('tag=v1.0.0-rc.0\n')
  })

  it.each(['1.0.0; touch injected', '1.0.0\nextra', '1.0.0..1'])(
    'refuses malformed input without creating tags: %j',
    (version) => {
      const repo = fixture()
      const result = repo.run(step('prepare', 'tag').run ?? 'exit 99', { VERSION: version })
      expect(result.status).not.toBe(0)
      expect(repo.git('tag', '--list')).toBe('')
    },
  )

  it('preserves an existing tag and fails validation if it names a different commit', () => {
    const repo = fixture()
    repo.git('tag', 'v1.0.0')
    repo.git('commit', '--quiet', '--allow-empty', '-m', 'Advance reviewed candidate')
    const sha = repo.git('rev-parse', 'HEAD')
    const tagged = repo.run(step('prepare', 'tag').run ?? 'exit 99', {
      VERSION: '1.0.0',
      GITHUB_SHA: sha,
    })
    expect(tagged.status, tagged.stderr).toBe(0)
    expect(repo.git('rev-parse', 'v1.0.0')).toBe(repo.sha)
    const prepared = repo.run(step('prepare', 'release').run ?? 'exit 99', {
      RELEASE_TAG: 'v1.0.0',
      GITHUB_SHA: sha,
    })
    expect(prepared.status).not.toBe(0)
    expect(prepared.stderr).toContain('Release preparation failed')
  })

  it('uploads the validated notes and fails if the file is absent', () => {
    const uploads = dryRun().jobs.prepare?.steps?.filter((candidate) =>
      candidate.uses?.startsWith('actions/upload-artifact@'),
    )
    expect(uploads).toHaveLength(1)
    expect(uploads?.[0]?.with?.path).toBe(expression('steps.release.outputs.notes_file'))
    expect(uploads?.[0]?.with?.['if-no-files-found']).toBe('error')
  })

  it('reports per-platform duration from the actual combined build metadata', () => {
    const summary = dryRun().jobs.build?.steps?.find((candidate) =>
      candidate.run?.includes('node scripts/release-build-summary.ts'),
    )
    expect(summary).toBeDefined()
    expect(summary?.env?.BUILD_REF).toBe(expression('steps.build.outputs.build-ref'))
    expect(summary?.run).toContain(
      'docker buildx --builder "$builder" history logs --progress rawjson "$build_id" 2> "$RUNNER_TEMP/release-build-progress.jsonl"',
    )
    expect(summary?.run).toContain(
      'node scripts/release-build-summary.ts "$RUNNER_TEMP/release-build-progress.jsonl"',
    )
    const repo = fixture()
    copyFileSync(
      new URL('scripts/release-build-summary.ts', root),
      join(repo.dir, 'scripts/release-build-summary.ts'),
    )
    const output = join(repo.dir, 'summary.md')
    const args = join(repo.dir, 'docker-args')
    const progress = JSON.stringify({
      vertexes: ['amd64', 'arm64'].map((arch) => ({
        digest: arch,
        name: `[linux/${arch} build 1/1] RUN npm ci`,
        started: '2026-10-20T00:00:00Z',
        completed: '2026-10-20T00:00:02Z',
      })),
    })
    const fake =
      'docker() { printf "%s\\0" "$@" > "$TEST_ARGS_FILE"; printf "%s\\n" "$TEST_PROGRESS" >&2; }\n'
    const result = repo.run(fake + summary?.run, {
      BUILD_REF: 'rehearsal-builder/rehearsal-node/build-id',
      TEST_ARGS_FILE: args,
      TEST_PROGRESS: progress,
      GITHUB_STEP_SUMMARY: output,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(args, 'utf8').split('\0').filter(Boolean)).toEqual([
      'buildx',
      '--builder',
      'rehearsal-builder',
      'history',
      'logs',
      '--progress',
      'rawjson',
      'build-id',
    ])
    expect(readFileSync(output, 'utf8')).toContain(
      '| linux/amd64 | 2.0 s |\n| linux/arm64 | 2.0 s |',
    )
  })
})
