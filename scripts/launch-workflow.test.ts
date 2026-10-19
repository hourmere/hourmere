import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Job {
  if?: string
  environment?: string
  needs?: string[]
  permissions?: Record<string, string>
  steps?: Array<{ name?: string; run?: string }>
}

const workflow = parse(
  readFileSync(
    process.env.HOURMERE_RELEASE_WORKFLOW ??
      new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  ),
) as { jobs: Record<string, Job> }

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
