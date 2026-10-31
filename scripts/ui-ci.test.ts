import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import functionalConfig from '../tools/e2e/playwright.config.ts'

interface Step {
  id?: string
  name?: string
  run?: string
  if?: string
  'continue-on-error'?: boolean
  uses?: string
  with?: Record<string, string>
  env?: Record<string, string>
}
interface Job {
  needs?: string
  if?: string
  'continue-on-error'?: boolean
  env?: Record<string, string>
  services?: { postgres: { options: string } }
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } }
  steps: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, Job>
}
const root = fileURLToPath(new URL('../', import.meta.url))
const workflow = parse(
  readFileSync(
    process.env.HOURMERE_UI_CI_WORKFLOW ?? join(root, '.github/workflows/ui-checks.yml'),
    'utf8',
  ),
) as Workflow
const requiredSource = readFileSync(
  process.env.HOURMERE_UI_REQUIRED_WORKFLOW ?? join(root, '.github/workflows/ci.yml'),
  'utf8',
)
const requiredWorkflow = parse(requiredSource) as Workflow
const releaseSource = readFileSync(
  process.env.HOURMERE_UI_RELEASE_WORKFLOW ?? join(root, '.github/workflows/release.yml'),
  'utf8',
)

describe('UI measurement CI contract', () => {
  it('keeps measurement specs out of every functional project', () => {
    const measurementSpecs = '**/{layout,a11y,visual,cross-engine}.spec.ts'
    expect(functionalConfig.testIgnore).toEqual([measurementSpecs])
    const projects = functionalConfig.projects ?? []
    // The two application projects plus the documentation-site layout projects from PR #58.
    expect(projects.map((project) => project.name)).toEqual([
      'desktop',
      'mobile',
      'site-desktop',
      'site-mobile',
    ])
    // A project-level testIgnore replaces the top-level list, so each project repeats it.
    for (const project of projects) {
      const ignore =
        project.testIgnore === undefined ? functionalConfig.testIgnore : project.testIgnore
      expect([ignore].flat(), project.name).toContain(measurementSpecs)
    }
    const names = (predicate: (project: (typeof projects)[number]) => boolean) =>
      projects.filter(predicate).map((project) => project.name)
    expect(names((project) => project.testMatch === 'site-layout.spec.ts')).toEqual([
      'site-desktop',
      'site-mobile',
    ])
    expect(
      names((project) => [project.testIgnore].flat().includes('**/site-layout.spec.ts')),
    ).toEqual(['desktop', 'mobile'])
  })

  it('lists measurement specs in no functional project and the site spec only in its own', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-functional-'))
    try {
      const reporter = join(directory, 'tests.mjs')
      writeFileSync(
        reporter,
        `export default class {
          onBegin(config, suite) {
            console.log(JSON.stringify(suite.allTests().map((test) => [test.parent.project().name, test.location.file.split('/').pop()])))
          }
        }`,
      )
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve('@playwright/test/cli')),
          'test',
          '--config',
          'tools/e2e/playwright.config.ts',
          '--list',
          '--reporter',
          reporter,
        ],
        { cwd: root, encoding: 'utf8', timeout: 60_000 },
      )
      expect(result.status, result.stderr).toBe(0)
      const tests = JSON.parse(result.stdout.trim()) as [string, string][]
      expect(tests.length).toBeGreaterThan(0)
      const files = (project: string) =>
        new Set(tests.filter(([p]) => p === project).map(([, f]) => f))
      for (const project of ['desktop', 'mobile', 'site-desktop', 'site-mobile']) {
        expect(
          [...files(project)].filter((file) =>
            /^(layout|a11y|visual|cross-engine)\.spec\.ts$/.test(file),
          ),
          project,
        ).toEqual([])
      }
      expect(files('desktop').has('site-layout.spec.ts')).toBe(false)
      expect(files('mobile').has('site-layout.spec.ts')).toBe(false)
      expect([...files('site-desktop')]).toEqual(['site-layout.spec.ts'])
      expect([...files('site-mobile')]).toEqual(['site-layout.spec.ts'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('runs UI measurements only for pull requests, main pushes and manual baseline review', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ branches: ['main'] })
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: {
        visual_baselines: {
          description:
            'Generate masked Linux visual baselines for review / 生成供审核的脱敏 Linux 视觉基线',
          type: 'boolean',
          default: false,
        },
      },
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal.
      group: 'ui-checks-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      'e2e-a11y',
      'e2e-cross-engine',
      'e2e-layout',
      'e2e-visual',
      'visual-baseline-status',
      'visual-baselines',
    ])
    expect(workflow.jobs['e2e-layout']?.strategy).toEqual({
      'fail-fast': false,
      matrix: { shard: [1, 2, 3, 4] },
    })
  })

  it('isolates UI jobs from reusable CI and releases', () => {
    expect(Object.keys(requiredWorkflow.jobs).sort()).toEqual([
      'check',
      'cli-compatibility',
      'docker',
      'e2e',
    ])
    expect(requiredSource).not.toContain('ui-checks.yml')
    expect(releaseSource).not.toContain('ui-checks.yml')
    expect(releaseSource).toContain('uses: ./.github/workflows/ci.yml')
    for (const id of Object.keys(workflow.jobs)) {
      expect(requiredWorkflow.jobs[id]).toBeUndefined()
      expect((parse(releaseSource) as Workflow).jobs[id]).toBeUndefined()
    }
  })

  // Canonical required job definitions after merging main. Changes need owner review.
  it.each([
    // Parity gaps compare against event-base Git history; PostgreSQL limits stay unchanged.
    ['check', '2ac262fd2886d7e2434ed955f7905dc2e7591c39ce0ecf7298b3ec1a3dabdbe6'],
    ['cli-compatibility', 'e6baff5e1cbf2e5b3339c961747ed5be373cc5d0b7874200d54b903f13a3e194'],
    // PR #58 builds a disposable documentation-site fixture before the browser regressions.
    // The owner approved a 20-minute job limit because the suite now runs close to 10 minutes.
    ['e2e', 'dc8078e78f6723dd71fa1c0e3769aee6b6a32dc0d8cb40e9cd6a315592fee208'],
    ['docker', '2594f351267b97c37981b7889ae22495076c653543f5cd8ee11825ac4ed63d9a'],
  ])('preserves required job %s and its behavior', (id, digest) => {
    expect(requiredWorkflow.jobs[id ?? '']).toBeDefined()
    expect(
      createHash('sha256')
        .update(JSON.stringify(requiredWorkflow.jobs[id ?? '']))
        .digest('hex'),
    ).toBe(digest)
  })

  it.each(Object.keys(workflow.jobs))('keeps %s on default PostgreSQL connection limits', (id) => {
    expect(workflow.jobs[id]?.services?.postgres.options ?? '').not.toContain('max_connections')
  })

  it.each(['e2e-layout', 'e2e-a11y', 'e2e-cross-engine'])(
    'makes %s fail on the terminal gate while preserving reports on failure',
    (id) => {
      const job = workflow.jobs[id]
      expect(job?.['continue-on-error']).toBeUndefined()
      const suite = id.slice('e2e-'.length)
      const summary = job?.steps.find((step) => step.name === 'Summarize measurements')
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal.
      const shard = suite === 'layout' ? ' --shard=${{ matrix.shard }}/4' : ''
      expect(summary?.run).toBe(`node tools/e2e/reports-summary.ts --suite=${suite}${shard}`)
      expect(summary?.if).toBe('always()')
      const browser = job?.steps.find((step) => step.run?.includes('node tools/e2e/run-audit.ts'))
      expect(browser?.run).toBe(`node tools/e2e/run-audit.ts ${suite}${shard}`)
      if (suite === 'cross-engine') expect(browser?.env?.HOURMERE_UI_BLOCKING).toBe('1')
      else {
        // Findings are evaluated after all scans so checked-in exceptions can apply.
        expect(browser?.env?.HOURMERE_UI_BLOCKING).toBeUndefined()
        expect(job?.env?.HOURMERE_UI_BLOCKING).toBeUndefined()
        expect(browser?.env?.HOURMERE_UI_FAIL_ON_EXIT).toBe('1')
      }
    },
  )

  it.each(['visual-baseline-status', 'e2e-visual', 'visual-baselines'])(
    'keeps %s advisory until reviewed visual baselines exist',
    (id) => {
      expect(workflow.jobs[id]?.['continue-on-error']).toBe(true)
      expect(
        workflow.jobs[id]?.steps.find((step) => step.name === 'Summarize measurements')?.run ?? '',
      ).not.toContain('--suite=')
    },
  )

  it.each(['e2e-layout', 'e2e-a11y', 'e2e-cross-engine', 'e2e-visual'])(
    'publishes only sanitized reports after %s even on failures',
    (id) => {
      const steps = workflow.jobs[id]?.steps ?? []
      expect(steps.find((step) => step.name === 'Summarize measurements')?.if).toBe('always()')
      const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
      expect(upload?.if).toBe('always()')
      if (id !== 'e2e-visual') expect(upload?.['continue-on-error']).toBe(true)
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

  it('keys browser downloads by Playwright version and installs them only on cache misses', () => {
    const steps = workflow.jobs['e2e-cross-engine']?.steps ?? []
    const version = steps.find((step) => step.id === 'playwright-version')
    expect(version?.run).toContain("require('@playwright/test/package.json').version")
    expect(version?.run).toContain('$GITHUB_OUTPUT')
    const cache = steps.find((step) => step.uses?.startsWith('actions/cache@'))
    expect(cache?.id).toBe('playwright-cache')
    expect(cache?.with).toEqual({
      path: '~/.cache/ms-playwright',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal.
      key: 'playwright-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright-version.outputs.version }}',
    })
    const install = steps.find((step) => step.run === 'npx playwright install webkit firefox')
    expect(install?.if).toBe("steps.playwright-cache.outputs.cache-hit != 'true'")
    expect(steps.some((step) => step.run?.includes('--with-deps'))).toBe(false)
  })

  it.each([false, true])(
    'installs host dependencies only when Playwright reports missing packages (%s)',
    (missing) => {
      const steps = workflow.jobs['e2e-cross-engine']?.steps ?? []
      const dependencies = steps.find(
        (step) => step.name === 'Install only missing browser system dependencies',
      )
      // Browser cache entries cannot preserve apt packages on a fresh runner.
      expect(dependencies?.if).toBeUndefined()
      expect(dependencies?.run).toBe(
        'npx playwright install-deps --dry-run webkit firefox || npx playwright install-deps webkit firefox',
      )
      const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-dependencies-'))
      try {
        const command = join(directory, 'npx')
        const calls = join(directory, 'calls.jsonl')
        writeFileSync(
          command,
          `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.HOURMERE_DEPENDENCY_CALLS, JSON.stringify(args) + '\\n')
process.exitCode = args.includes('--dry-run') && process.env.HOURMERE_DEPENDENCIES_MISSING === '1' ? 1 : 0
`,
        )
        chmodSync(command, 0o755)
        const result = spawnSync('bash', ['-e', '-c', dependencies?.run ?? 'exit 1'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            HOURMERE_DEPENDENCY_CALLS: calls,
            HOURMERE_DEPENDENCIES_MISSING: missing ? '1' : '0',
          },
        })
        expect(result.status, result.stderr).toBe(0)
        const expected = [['playwright', 'install-deps', '--dry-run', 'webkit', 'firefox']]
        if (missing) expected.push(['playwright', 'install-deps', 'webkit', 'firefox'])
        expect(
          readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual(expected)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
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
        tests: 12,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('records browser failures with blocking=%s and failOnExit=%s', (blocking, failOnExit) => {
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
          HOURMERE_UI_FAIL_ON_EXIT: failOnExit ? '1' : '0',
        },
      })
      expect(result.status, result.stderr).toBe(blocking || failOnExit ? 7 : 0)
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
  })
})
