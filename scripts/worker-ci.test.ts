import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(
    process.env.HOURMERE_WORKER_CI_WORKFLOW ??
      fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
    'utf8',
  ),
) as {
  jobs: {
    docker: {
      env: Record<string, string>
      steps: { name?: string; run?: string; if?: string; 'timeout-minutes'?: number }[]
    }
  }
}
const job = workflow.jobs.docker
const smoke = job.steps.find((step) => step.name === 'Smoke test the separate worker overlay')
const teardown = job.steps.find((step) => step.name === 'Tear down the self-hosting stack')

function run(script: string, scenario = 'ok') {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-worker-ci-'))
  try {
    const callLog = join(directory, 'calls')
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  'compose -f docker-compose.yml -f docker-compose.worker.yml config --format json')
    app=web; worker=worker; image=hourmere:ci
    case "$SCENARIO" in app-role) app=all ;; worker-role) worker=web ;; image) image=hourmere:old ;; esac
    printf '{"services":{"app":{"image":"hourmere:ci","environment":{"HOURMERE_ROLE":"%s"}},"worker":{"image":"%s","environment":{"HOURMERE_ROLE":"%s"}}}}\\n' "$app" "$image" "$worker" ;;
  'compose -f docker-compose.yml -f docker-compose.worker.yml up -d --no-build --wait --wait-timeout 75') ;;
  'compose -f docker-compose.yml -f docker-compose.worker.yml logs --no-color app')
    if [ "$SCENARIO" != app-log ]; then printf '%s\\n' 'jobs: queued for a worker'; fi ;;
  'compose -f docker-compose.yml -f docker-compose.worker.yml logs --no-color worker')
    if [ "$SCENARIO" != worker-log ]; then printf '%s\\n' 'Hourmere worker running jobs'; fi ;;
  'compose -f docker-compose.yml -f docker-compose.worker.yml down --remove-orphans') ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    )
    const result = spawnSync('sh', ['-eu', '-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        CALL_LOG: callLog,
        SCENARIO: scenario,
      },
    })
    return { ...result, calls: readFileSync(callLog, 'utf8').trim().split('\n') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('CI separate worker smoke', () => {
  it('reuses the built image with a disposable project and a bounded startup wait', () => {
    expect(job.env.COMPOSE_PROJECT_NAME).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expands these expressions.
      'hourmere-ci-${{ github.run_id }}-${{ github.run_attempt }}',
    )
    expect(smoke?.['timeout-minutes']).toBe(2)
    expect(smoke?.run).toBeDefined()
    const result = run(smoke?.run ?? 'exit 1')
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toEqual([
      'compose -f docker-compose.yml -f docker-compose.worker.yml config --format json',
      'compose -f docker-compose.yml -f docker-compose.worker.yml up -d --no-build --wait --wait-timeout 75',
      'compose -f docker-compose.yml -f docker-compose.worker.yml logs --no-color app',
      'compose -f docker-compose.yml -f docker-compose.worker.yml logs --no-color worker',
    ])
  })

  it.each(['app-role', 'worker-role', 'image', 'app-log', 'worker-log'])(
    'fails when the rendered or running roles are wrong: %s',
    (scenario) => {
      const result = run(smoke?.run ?? 'exit 1', scenario)
      expect(result.status).not.toBe(0)
      if (['app-role', 'worker-role', 'image'].includes(scenario)) {
        expect(result.calls).toHaveLength(1)
      }
    },
  )

  it('always tears down app, worker and db without deleting volumes', () => {
    expect(teardown?.if).toBe('always()')
    expect(teardown?.run).toBeDefined()
    const result = run(teardown?.run ?? 'exit 1')
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toEqual([
      'compose -f docker-compose.yml -f docker-compose.worker.yml down --remove-orphans',
    ])
  })
})
