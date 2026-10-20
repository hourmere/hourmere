import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(
    process.env.HOURMERE_WELL_KNOWN_CI_WORKFLOW ??
      fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
    'utf8',
  ),
) as { jobs: { docker: { steps: { name?: string; run?: string }[] } } }
const smoke = workflow.jobs.docker.steps.find((step) => step.name === 'Smoke test')
const unknownPath = 'http://127.0.0.1:3000/.well-known/does-not-exist'

function run(status: number, curlExit = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-well-known-ci-'))
  try {
    const callLog = join(directory, 'calls')
    writeFileSync(
      join(directory, 'curl'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
for argument do url=$argument; done
case "$url" in
  http://127.0.0.1:3000/api/health) printf '%s' '{"status":"ok"}' ;;
  http://127.0.0.1:3000/) printf '%s' '<title>Hourmere</title>' ;;
  ${unknownPath}) printf '%s' "$HTTP_STATUS"; exit "$CURL_EXIT" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    )
    const result = spawnSync('sh', ['-eu', '-c', smoke?.run ?? 'exit 1'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        CALL_LOG: callLog,
        HTTP_STATUS: String(status),
        CURL_EXIT: String(curlExit),
      },
    })
    return { ...result, calls: readFileSync(callLog, 'utf8').trim().split('\n') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('CI unknown well-known route smoke', () => {
  it('requests the unknown path and accepts its 404', () => {
    const result = run(404)
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls.some((call) => call.endsWith(` ${unknownPath}`))).toBe(true)
  })

  it('fails when an unknown well-known route falls through to the SPA', () => {
    const result = run(200)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown well-known route returned HTTP 200; expected 404')
  })

  it('fails when curl cannot reach the unknown path', () => {
    expect(run(0, 7).status).toBe(7)
  })
})
