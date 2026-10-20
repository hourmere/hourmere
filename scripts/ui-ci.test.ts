import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import functionalConfig from '../tools/e2e/playwright.config.ts'

interface Step {
  name?: string
  run?: string
  if?: string
  uses?: string
  with?: Record<string, string>
}
interface Job {
  needs?: string
  if?: string
  'continue-on-error'?: boolean
  env?: Record<string, string>
  services?: { postgres: { options: string } }
  steps: Step[]
}
const root = fileURLToPath(new URL('../', import.meta.url))
const workflow = parse(
  readFileSync(
    process.env.HOURMERE_UI_CI_WORKFLOW ?? join(root, '.github/workflows/ci.yml'),
    'utf8',
  ),
) as { jobs: Record<string, Job> }

describe('UI measurement CI contract', () => {
  it('keeps measurement specs out of the existing two functional projects', () => {
    expect(functionalConfig.testIgnore).toEqual(['**/{layout,a11y,visual,cross-engine}.spec.ts'])
    expect(functionalConfig.projects?.map((project) => project.name)).toEqual(['desktop', 'mobile'])
  })
  // Canonical job definitions before board 219. Changes need explicit owner review.
  it.each([
    ['check', '7454d8fe440d98ff3ae3a93a0674f4201fed921f3193225883c340296f1bd78b'],
    ['e2e', '449d779d527fd6945be1b58632afe54a16bd3ff2b046dce85141a23011ed50b4'],
    ['docker', '2594f351267b97c37981b7889ae22495076c653543f5cd8ee11825ac4ed63d9a'],
  ])('preserves required job %s and its behavior', (id, digest) => {
    expect(workflow.jobs[id ?? '']).toBeDefined()
    expect(
      createHash('sha256')
        .update(JSON.stringify(workflow.jobs[id ?? '']))
        .digest('hex'),
    ).toBe(digest)
  })

  it.each(['e2e-layout', 'e2e-a11y', 'e2e-cross-engine', 'e2e-visual', 'visual-baselines'])(
    'keeps %s advisory with default PostgreSQL connection limits',
    (id) => {
      const job = workflow.jobs[id]
      expect(job?.['continue-on-error']).toBe(true)
      expect(job?.services?.postgres.options).not.toContain('max_connections')
      expect(job?.env?.HOURMERE_UI_BLOCKING).not.toBe('1')
    },
  )

  it.each(['e2e-layout', 'e2e-a11y', 'e2e-cross-engine'])(
    'publishes only sanitized reports after %s even on failures',
    (id) => {
      const steps = workflow.jobs[id]?.steps ?? []
      expect(steps.find((step) => step.name === 'Summarize measurements')?.if).toBe('always()')
      const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
      expect(upload?.if).toBe('always()')
      expect(upload?.with?.path).toBe('temp/ui-audit-reports/')
      expect(steps.some((step) => step.run?.includes('node tools/e2e/run-audit.ts'))).toBe(true)
    },
  )

  it('skips visual comparison until reviewed baselines exist; generation is dispatch-only', () => {
    expect(workflow.jobs['e2e-visual']?.needs).toBe('visual-baseline-status')
    expect(workflow.jobs['e2e-visual']?.if).toBe(
      "needs.visual-baseline-status.outputs.present == 'true'",
    )
    const generation = workflow.jobs['visual-baselines']
    expect(generation?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.visual_baselines",
    )
    expect(generation?.steps.some((step) => step.run?.includes('--update-snapshots'))).toBe(true)
    expect(generation?.steps.some((step) => step.run === 'npm run test:e2e:privacy')).toBe(true)
    expect(
      generation?.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))?.with
        ?.path,
    ).toBe('tools/e2e/snapshots/**/*.png')
  })

  it('installs and caches both cross-engine browsers', () => {
    const steps = workflow.jobs['e2e-cross-engine']?.steps ?? []
    expect(steps.some((step) => step.uses?.startsWith('actions/cache@'))).toBe(true)
    expect(
      steps.some((step) => step.run === 'npx playwright install --with-deps webkit firefox'),
    ).toBe(true)
  })
})

describe('report-only browser command', () => {
  it('resolves native WebKit and Firefox projects without inheriting the Chrome channel', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-config-'))
    try {
      const reporter = join(directory, 'projects.mjs')
      writeFileSync(
        reporter,
        `export default class {
          onBegin(config, suite) {
            console.log(JSON.stringify({projects:config.projects.map(({name,use})=>({name,browserName:use.browserName,channel:use.channel})),tests:suite.allTests().length}))
          }
        }`,
      )
      // --list resolves the actual merged Playwright configuration without launching browsers.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve('@playwright/test/cli')),
          'test',
          '--config',
          process.env.HOURMERE_UI_AUDIT_CONFIG ?? 'tools/e2e/playwright.audit.config.ts',
          '--list',
          '--reporter',
          reporter,
        ],
        {
          cwd: root,
          env: { ...process.env, HOURMERE_UI_SUITE: 'cross-engine' },
          encoding: 'utf8',
          timeout: 30_000,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toEqual({
        projects: [
          { name: 'webkit-desktop', browserName: 'webkit' },
          { name: 'webkit-iphone', browserName: 'webkit' },
          { name: 'firefox-desktop', browserName: 'firefox' },
        ],
        tests: 9,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    'records browser failures and blocking=%s controls the exit',
    (blocking) => {
      const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-runner-'))
      try {
        const child = join(directory, 'fake-cli.mjs')
        writeFileSync(child, 'process.exitCode = 7\n')
        const runnerSource = readFileSync(
          process.env.HOURMERE_UI_RUNNER ?? join(root, 'tools/e2e/run-audit.ts'),
          'utf8',
        )
          .replace("fileURLToPath(new URL('../../', import.meta.url))", JSON.stringify(root))
          .replace(
            "fileURLToPath(import.meta.resolve('@playwright/test/cli'))",
            JSON.stringify(child),
          )
        const runner = join(directory, 'runner.mts')
        writeFileSync(runner, runnerSource)
        const result = spawnSync(process.execPath, [runner, 'layout'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOURMERE_UI_REPORT_DIR: directory,
            HOURMERE_UI_BLOCKING: blocking ? '1' : '0',
          },
        })
        expect(result.status, result.stderr).toBe(blocking ? 7 : 0)
        expect(JSON.parse(readFileSync(join(directory, 'layout-execution.json'), 'utf8'))).toEqual({
          schemaVersion: 1,
          kind: 'execution',
          suite: 'layout',
          exitCode: 7,
          blocking,
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
