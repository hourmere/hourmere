import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Job {
  needs?: string | string[]
  if?: string
  env?: Record<string, string>
  services?: { postgres?: { image?: string } }
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } }
  steps?: { name?: string; run?: string }[]
}
interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, Job>
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const ciSource = read('.github/workflows/ci.yml')
// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal.
const shardOption = '--shard=${{ matrix.shard }}'
const results = ['success', 'failure', 'cancelled', 'skipped'] as const

/** Branch protection and the merge queue require these check names; they must not move. */
const requiredChecks = {
  '.github/workflows/ci.yml': ['check', 'e2e', 'docker'],
  '.github/workflows/dco.yml': ['sign-off'],
}

/** Runs the aggregator's shell step with the given results for its needs. */
function aggregate(job: Job, outcome: Record<string, string>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [name, value] of Object.entries(job.env ?? {})) {
    const need = value.match(/^\$\{\{ needs\.([\w-]+)\.result \}\}$/)?.[1]
    if (need === undefined) throw new Error(`${name} is not a needs result`)
    env[name] = outcome[need] ?? ''
  }
  const runs = (job.steps ?? []).map((step) => step.run ?? '')
  return runs.every(
    (run) => spawnSync('bash', ['-eo', 'pipefail', '-c', run], { env }).status === 0,
  )
}

function verify(source: string) {
  const { on, jobs } = parse(source) as Workflow
  // Reusable from the release workflows, and run in the merge queue.
  expect(on).toHaveProperty('workflow_call')
  expect(on).toHaveProperty('merge_group')

  const check = jobs.check
  expect(check).toBeDefined()
  const needs = [check?.needs ?? []].flat()
  // Every part of the split check is aggregated, and nothing else.
  const parts = Object.keys(jobs).filter((id) => id.startsWith('check-'))
  expect(parts.sort()).toEqual(['check-static', 'check-tests'])
  expect([...needs].sort()).toEqual(parts)
  // Without always(), a failed or cancelled part skips `check`, and a skipped required
  // check counts as passing.
  expect(check?.if).toBe('always()')
  // The aggregator passes only when every part succeeded.
  expect(aggregate(check as Job, Object.fromEntries(needs.map((id) => [id, 'success'])))).toBe(true)
  for (const id of needs) {
    for (const result of results.filter((value) => value !== 'success')) {
      const outcome = Object.fromEntries(needs.map((need) => [need, 'success']))
      outcome[id] = result
      expect(aggregate(check as Job, outcome), `${id} ${result}`).toBe(false)
    }
  }

  // The static part keeps every non-suite gate the single job used to run.
  const staticRuns = (jobs['check-static']?.steps ?? []).map((step) => step.run ?? '')
  for (const gate of [
    'npm run lint',
    'npm run typecheck',
    'npm run db:types -- --verify',
    'npm run api:types',
    'npm run build',
    'npm run cli:pack-smoke',
    'npm run mcp:registry:validate',
  ]) {
    expect(
      staticRuns.some((run) => run.includes(gate)),
      gate,
    ).toBe(true)
  }

  // Every test file runs in exactly one shard: Vitest splits the files by --shard=i/N, so the
  // matrix must list exactly 1..N for the same N, and a failing shard must not cancel others.
  const tests = jobs['check-tests']
  const shards = tests?.strategy?.matrix?.shard ?? []
  expect(shards.length).toBeGreaterThan(1)
  expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index + 1))
  expect(tests?.strategy?.['fail-fast']).toBe(false)
  const suite = (tests?.steps ?? []).filter((step) => step.run?.startsWith('npm test'))
  expect(suite.map((step) => step.run)).toEqual([
    `npm test -- --maxWorkers=2 ${shardOption}/${shards.length}`,
  ])
  // Each shard has its own database server, with the default connection limit.
  expect(tests?.services?.postgres?.image).toBe('postgres:18-alpine')
  expect(JSON.stringify(tests?.services)).not.toContain('max_connections')
  expect(tests?.env?.DATABASE_URL).toBe('postgres://hourmere:hourmere@localhost:5432/hourmere')
}

describe('required check aggregation in CI', () => {
  it.each(Object.entries(requiredChecks))('%s keeps the required job names', (path, ids) => {
    const { jobs } = parse(read(path)) as Workflow
    for (const id of ids) expect(Object.hasOwn(jobs, id), id).toBe(true)
  })

  it('aggregates every check part and runs every test file in exactly one shard', () => {
    verify(ciSource)
  })

  it.each([
    [
      'always() on the aggregator',
      '    needs: [check-static, check-tests]\n    if: always()\n',
      '    needs: [check-static, check-tests]\n',
    ],
    ['a part from needs', 'needs: [check-static, check-tests]', 'needs: [check-tests]'],
    ['the static result', 'test "$STATIC_RESULT" = success && ', ''],
    ['the success comparison', 'test "$TESTS_RESULT" = success', 'test "$TESTS_RESULT" != failure'],
    ['a shard from the matrix', 'shard: [1, 2, 3, 4]', 'shard: [1, 2, 3]'],
    ['the shard count in the command', `${shardOption}/4`, `${shardOption}/5`],
    ['the shard option', ` ${shardOption}/4`, ''],
    [
      'fail-fast: false',
      '      fail-fast: false\n      matrix:\n        shard:',
      '      matrix:\n        shard:',
    ],
    ['the lint gate', '      - run: npm run lint\n', ''],
  ])('detects removal of %s', (_name, from, to) => {
    const mutant = ciSource.replace(from, to)
    expect(mutant).not.toBe(ciSource)
    expect(() => verify(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
