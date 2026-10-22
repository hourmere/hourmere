import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type Step = { name?: string; run?: string; shell?: string; [key: string]: unknown }
type Job = { steps: Step[]; [key: string]: unknown }
type Response = { status: string; contentType: string; body: string; exit: number }

const source = readFileSync(
  process.env.HOURMERE_UPTIME_CI_WORKFLOW ??
    fileURLToPath(new URL('../.github/workflows/uptime.yml', import.meta.url)),
  'utf8',
)
const workflow = parse(source) as {
  on: Record<string, unknown>
  jobs: Record<string, Job>
  [key: string]: unknown
}
const job = workflow.jobs.check
const step = job?.steps.find((item) => item.name === 'Check public endpoints')
const endpoints = [
  ['App health', 'https://app.hourmere.com/api/health'],
  ['Website', 'https://hourmere.com/'],
  ['Security policy', 'https://hourmere.com/.well-known/security.txt'],
] as const

function run(overrides: Record<string, Partial<Response>> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-uptime-ci-'))
  try {
    const callLog = join(directory, 'calls.jsonl')
    const responses = Object.fromEntries(
      endpoints.map(([, url]) => [
        url,
        {
          status: '200',
          contentType: url.endsWith('/api/health')
            ? 'application/json'
            : url.endsWith('security.txt')
              ? 'text/plain'
              : 'text/html',
          body: url.endsWith('/api/health') ? '{"status":"ok","database":"ok"}' : 'public response',
          exit: 0,
          ...overrides[url],
        },
      ]),
    )
    // This executable has no network implementation or fallback to the real curl.
    writeFileSync(
      join(directory, 'curl'),
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n')
const response = JSON.parse(process.env.RESPONSES)[args.at(-1)]
const output = args[args.indexOf('--output') + 1]
if (!response || !args.includes('--output') || !output) process.exit(99)
writeFileSync(output, response.body)
process.stdout.write(response.status + ' ' + response.contentType)
process.exitCode = response.exit
`,
      { mode: 0o755 },
    )
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step?.run ?? 'exit 99'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          CALL_LOG: callLog,
          RESPONSES: JSON.stringify(responses),
        },
      },
    )
    const calls = readFileSync(callLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    return { ...result, calls, directory }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function expectAllChecked(calls: string[][]) {
  expect(calls.map((args) => args.at(-1))).toEqual(endpoints.map(([, url]) => url))
}

describe('scheduled uptime workflow', () => {
  it('checks every 15 minutes and supports manual dispatch', () => {
    expect(workflow.name).toBe('Uptime')
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(workflow.on.schedule).toEqual([{ cron: '*/15 * * * *' }])
    expect(workflow.on.workflow_dispatch).toBeNull()
    const comment = source.match(/^(?:#.*\n)+/)?.[0] ?? ''
    expect(comment).toContain('Monitors app.hourmere.com health, hourmere.com')
    expect(comment).toContain('security.txt')
    expect(comment).toMatch(/GitHub emails the workflow's last committer[\s\S]*on failure/)
    expect(comment).toMatch(/GitHub disables schedules[\s\S]*60 days without repository activity/)
  })

  it('has no token permissions, secrets or actions', () => {
    expect(workflow.permissions).toEqual({})
    expect(workflow.env).toBeUndefined()
    expect(source).not.toMatch(/\bsecrets\s*(?:\.|\[)/i)
    for (const item of Object.values(workflow.jobs)) {
      expect(item.permissions).toBeUndefined()
      expect(item.env).toBeUndefined()
      expect(item.uses).toBeUndefined()
      for (const action of item.steps) {
        expect(action.uses).toBeUndefined()
        expect(action.env).toBeUndefined()
      }
    }
  })

  it('bounds one non-overlapping job without canceling an active check', () => {
    expect(workflow.concurrency).toEqual({ group: 'uptime', 'cancel-in-progress': false })
    expect(Object.keys(workflow.jobs)).toEqual(['check'])
    expect(job?.['runs-on']).toBe('ubuntu-latest')
    expect(job?.['timeout-minutes']).toBe(5)
    expect(job?.['continue-on-error']).toBeUndefined()
    expect(job?.steps).toHaveLength(1)
    expect(step?.shell).toBe('bash')
    expect(step?.['continue-on-error']).toBeUndefined()
    expect(step?.if).toBeUndefined()
  })

  it('checks all three URLs with bounded curl requests and accepts healthy responses', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expectAllChecked(result.calls)
    for (const [index, args] of result.calls.entries()) {
      expect(args).toEqual([
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '20',
        '--retry',
        '2',
        '--retry-delay',
        '10',
        '--output',
        join(result.directory, 'uptime-body'),
        '--write-out',
        '%{http_code} %{content_type}',
        endpoints[index]?.[1],
      ])
    }
  })

  it.each(
    endpoints.flatMap(([name, url]) =>
      [204, 302, 404, 500].map((status) => ({ name, url, status })),
    ),
  )('fails $name with HTTP $status while checking the other endpoints', ({ name, url, status }) => {
    const result = run({ [url]: { status: String(status) } })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain(`${name} failed (HTTP ${status})`)
    expectAllChecked(result.calls)
  })

  it.each(endpoints)('fails %s on transport errors and prints its HTTP status', (name, url) => {
    const result = run({ [url]: { status: '000', exit: 28 } })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain(`${name} failed (HTTP 000)`)
    expectAllChecked(result.calls)
  })

  it.each([
    '',
    '{',
    'null',
    '{}',
    '{"status":"ok"}',
    '{"database":"ok"}',
    '{"status":"error","database":"ok"}',
    '{"status":"ok","database":"error"}',
    '{"status":"ok","database":"ok"}\n{"status":"ok","database":"ok"}',
  ])('rejects unhealthy or invalid health JSON: %j', (body) => {
    const result = run({ [endpoints[0][1]]: { body } })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('App health failed (HTTP 200)')
    expectAllChecked(result.calls)
  })

  it.each(['', 'text/html', 'application/json', 'text/plain-other'])(
    'rejects a security policy with content type %j',
    (contentType) => {
      const result = run({ [endpoints[2][1]]: { contentType } })
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('Security policy failed (HTTP 200)')
      expectAllChecked(result.calls)
    },
  )

  it.each(['text/plain; charset=utf-8', 'Text/Plain; charset=UTF-8'])(
    'accepts a security policy with content type %j',
    (contentType) => {
      const result = run({ [endpoints[2][1]]: { contentType } })
      expect(result.status, result.stderr).toBe(0)
      expectAllChecked(result.calls)
    },
  )

  it('reports each failed endpoint in one run', () => {
    const result = run(
      Object.fromEntries(endpoints.map(([, url]) => [url, { status: '503', exit: 22 }])),
    )
    expect(result.status, result.stderr).toBe(1)
    for (const [name] of endpoints) expect(result.stderr).toContain(`${name} failed (HTTP 503)`)
    expectAllChecked(result.calls)
  })
})
