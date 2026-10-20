import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script =
  process.env.HOURMERE_RELEASE_BUILD_SUMMARY_SCRIPT ??
  fileURLToPath(new URL('./release-build-summary.ts', import.meta.url))
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const vertex = (digest: string, name: string, start: number, end?: number) => ({
  digest,
  name,
  started: `2026-10-20T00:00:${String(start).padStart(2, '0')}.000Z`,
  ...(end === undefined
    ? {}
    : { completed: `2026-10-20T00:00:${String(end).padStart(2, '0')}.000Z` }),
})
const amd64 = vertex('a', '[linux/amd64 build 1/2] RUN npm ci', 2, 8)
const arm64 = vertex('b', '[linux/arm64 build 1/2] RUN npm ci', 3, 20)
const events = (...vertexes: unknown[]) => JSON.stringify({ vertexes })

function run(progress: string, destination = true) {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-build-summary-'))
  scratch.push(dir)
  const input = join(dir, 'progress.jsonl')
  const output = join(dir, 'summary.md')
  writeFileSync(input, progress)
  const result = spawnSync(process.execPath, [script, input], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: destination ? output : '' },
  })
  return { result, output }
}

describe('release build duration summary', () => {
  it('reports overlapping platform spans from rawjson updates, excluding shared/export work', () => {
    const progress = [
      events(vertex('export', 'exporting to OCI image format', 0, 59)),
      events(vertex('a', amd64.name, 2)),
      JSON.stringify({ logs: [{ vertex: 'a', data: 'aWdub3JlZA==' }] }),
      events(amd64, arm64),
      events({ digest: 'a', cached: true }),
      events(vertex('c', '[linux/amd64 build 2/2] COPY . .', 10, 12)),
      events(vertex('d', '[linux/arm64/v8 build 2/2] COPY . .', 21, 23)),
      '',
    ].join('\n')
    const { result, output } = run(progress)
    expect(result.status, result.stderr).toBe(0)
    const text = readFileSync(output, 'utf8')
    expect(text).toContain('| linux/amd64 | 10.0 s |\n| linux/arm64 | 20.0 s |')
    expect(text).toContain(
      'Platforms overlap; shared work and the final OCI/SBOM/provenance export',
    )
    expect(text).toContain('including cached steps')
  })

  it.each([
    ['missing arm64', events(amd64)],
    ['missing amd64', events(arm64)],
    ['no platform vertices', events(vertex('c', '[internal] load Dockerfile', 0, 1))],
    ['incomplete vertex', events(amd64, vertex('b', arm64.name, 3))],
    ['failed vertex', events(amd64, { ...arm64, error: 'build failed' })],
    ['invalid timestamp', events(amd64, { ...arm64, started: 'invalid' })],
    ['negative duration', events(amd64, vertex('b', arm64.name, 20, 3))],
    ['invalid JSON', 'not json'],
  ])('fails without writing misleading timings: %s', (_name, progress) => {
    const { result, output } = run(progress)
    expect(result.status).toBe(1)
    expect(existsSync(output)).toBe(false)
  })

  it('requires a job summary destination', () => {
    const { result, output } = run(events(amd64, arm64), false)
    expect(result.status).toBe(1)
    expect(existsSync(output)).toBe(false)
  })
})
