import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditLocales, auditPages } from '../tools/e2e/audit-pages.ts'
import { layoutViewports } from '../tools/e2e/layout.ts'
import type { AuditFinding, AuditReport } from '../tools/e2e/reports.ts'
import type { ReportIdentity, UiCheckException } from '../tools/e2e/ui-check-gate.ts'

const {
  evaluateUiGate,
  expectedFromPlaywrightList,
  loadExpectedReports,
  reportIdentity,
  uiGateFindingsSummary,
}: typeof import('../tools/e2e/ui-check-gate.ts') = await import(
  process.env.HOURMERE_UI_GATE_MODULE ??
    new URL('../tools/e2e/ui-check-gate.ts', import.meta.url).href
)

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function report(findings: AuditFinding[] = []): AuditReport {
  return {
    version: 1,
    kind: 'layout',
    page: 'booking',
    viewport: { width: 320, height: 568 },
    locale: 'en-US',
    theme: 'light',
    findings,
  }
}

function exception(overrides: Partial<UiCheckException> = {}): UiCheckException {
  return {
    suite: 'layout',
    page: 'booking',
    viewport: { width: 320, height: 568 },
    locale: 'en-US',
    theme: 'light',
    category: 'element-overflow',
    reason: 'Synthetic reviewed issue',
    expires: '2099-01-01',
    ...overrides,
  }
}

function gate(overrides: Partial<Parameters<typeof evaluateUiGate>[0]> = {}) {
  return evaluateUiGate({
    suite: 'layout',
    reports: [report()],
    executions: [{ suite: 'layout', exitCode: 0, blocking: false }],
    expected: [report()],
    exceptions: [],
    today: '2030-01-02',
    ...overrides,
  })
}

describe('blocking UI gate', () => {
  it('passes a complete clean scan', () => {
    expect(gate().passed).toBe(true)
  })

  it.each([
    'document-overflow',
    'element-overflow',
    'oversized-fixed',
    'small-input-font',
    'small-target',
    'obscured-focus',
    'outside-viewport-focus',
    'keyboard-limit',
    'scan-error',
  ] as const)('fails layout category %s', (code) => {
    const result = gate({ reports: [report([{ code }])] })
    expect(result.passed).toBe(false)
    expect(result.blockingFindings).toBe(1)
  })

  it.each(['axe-serious', 'axe-critical'] as const)('fails %s', (code) => {
    const input = { ...report([{ code, rule: 'button-name' }]), kind: 'a11y' as const }
    const result = gate({
      suite: 'a11y',
      reports: [input],
      expected: [input],
      executions: [{ suite: 'a11y', exitCode: 0, blocking: false }],
    })
    expect(result.passed).toBe(false)
    expect(result.blockingFindings).toBe(1)
  })

  it('passes informational incomplete, moderate and minor axe results', () => {
    const input = {
      ...report(),
      kind: 'a11y' as const,
      axe: {
        passes: 10,
        incomplete: 3,
        moderate: 2,
        minor: 1,
        moderateRules: ['region'],
        minorRules: ['landmark-one-main'],
      },
    }
    expect(
      gate({
        suite: 'a11y',
        reports: [input],
        expected: [input],
        executions: [{ suite: 'a11y', exitCode: 0, blocking: false }],
      }).passed,
    ).toBe(true)
  })

  it('fails missing reports', () => {
    expect(gate({ reports: [] }).failures).toContain('Missing reports: 1')
    expect(gate({ reports: [] }).passed).toBe(false)
  })

  it('rejects duplicates replacing a lost scan even when totals match', () => {
    const expected = [report(), { ...report(), theme: 'dark' as const }]
    const result = gate({ expected, reports: [report(), report()] })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Missing reports: 1')
    expect(result.failures).toContain('Duplicate reports: 1')
  })

  it('rejects unexpected states', () => {
    const result = gate({ reports: [report(), { ...report(), theme: 'dark' }] })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Unexpected reports: 1')
  })

  it('fails unreadable reports', () => {
    const result = gate({ unreadable: 1 })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Unreadable reports: 1')
  })

  it('fails missing browser execution metadata', () => {
    expect(gate({ executions: [] }).passed).toBe(false)
  })

  it('fails duplicate browser execution metadata', () => {
    const execution = { suite: 'layout', exitCode: 0, blocking: false }
    expect(gate({ executions: [execution, execution] }).passed).toBe(false)
  })

  it.each(['layout', 'a11y', 'cross-engine'] as const)('fails nonzero %s browser exit', (suite) => {
    const result = gate({
      suite,
      reports: [],
      expected: [],
      executions: [{ suite, exitCode: 7, blocking: false }],
    })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `Browser execution failed (exit 7); see the Run ${suite} measurement step log`,
    )
  })

  it('passes a successful cross-engine execution', () => {
    expect(
      gate({
        suite: 'cross-engine',
        reports: [],
        expected: [],
        executions: [{ suite: 'cross-engine', exitCode: 0, blocking: true }],
      }).passed,
    ).toBe(true)
  })

  it('rejects scan-time legacy axe suppression', () => {
    const result = gate({ reports: [{ ...report(), exempted: 1 }] })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Legacy axe exemptions must move to ui-check-exceptions.json')
  })
})

describe('checked-in exceptions', () => {
  it('starts empty', async () => {
    expect(JSON.parse(await readFile('tools/e2e/ui-check-exceptions.json', 'utf8'))).toEqual([])
  })

  it('passes an exact matching layout exception', () => {
    const result = gate({
      reports: [report([{ code: 'element-overflow' }])],
      exceptions: [exception()],
    })
    expect(result.passed).toBe(true)
    expect(result.exemptedFindings).toBe(1)
  })

  it.each([
    { selector: 'div.grid' },
    { viewport: { width: 320, height: 568, selector: 'div.grid' } },
  ])('rejects unknown exception keys instead of silently broadening scope %#', (extra) => {
    const result = gate({
      reports: [report([{ code: 'element-overflow' }])],
      exceptions: [{ ...exception(), ...extra }],
    })
    expect(result.passed).toBe(false)
    expect(result.exemptedFindings).toBe(0)
    expect(result.blockingFindings).toBe(1)
    expect(result.failures).toContain(
      'Invalid UI check exception: 1 (unknown keys; allowed: suite, page, viewport, locale, theme, category, rule, reason, expires; viewport allows only width, height)',
    )
  })

  it.each([
    { page: 'host' },
    { viewport: { width: 360, height: 800 } },
    { locale: 'zh-CN' },
    { theme: 'dark' },
  ] as const)('does not except a second report with a different selector %#', (selector) => {
    const first = report([{ code: 'element-overflow' }])
    const second = { ...first, ...selector }
    const result = gate({
      expected: [first, second],
      reports: [first, second],
      exceptions: [exception()],
    })
    expect(result.passed).toBe(false)
    expect(result.exemptedFindings).toBe(1)
    expect(result.blockingFindings).toBe(1)
  })

  it('does not except another finding category on the same report', () => {
    const result = gate({
      reports: [report([{ code: 'element-overflow' }, { code: 'document-overflow' }])],
      exceptions: [exception()],
    })
    expect(result.passed).toBe(false)
    expect(result.exemptedFindings).toBe(1)
    expect(result.blockingFindings).toBe(1)
  })

  it('matches an axe exception only to its named rule', () => {
    const input = {
      ...report([{ code: 'axe-serious', rule: 'button-name' }]),
      kind: 'a11y' as const,
    }
    const options = {
      suite: 'a11y' as const,
      reports: [input],
      expected: [input],
      executions: [{ suite: 'a11y', exitCode: 0, blocking: false }],
      exceptions: [exception({ suite: 'a11y', category: 'axe-serious', rule: 'button-name' })],
    }
    expect(gate(options).passed).toBe(true)
    expect(
      gate({
        ...options,
        reports: [{ ...input, findings: [{ code: 'axe-serious', rule: 'label' }] }],
      }).passed,
    ).toBe(false)
  })

  it('requires an axe rule instead of allowing a whole severity', () => {
    const result = gate({ exceptions: [exception({ suite: 'a11y', category: 'axe-serious' })] })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Invalid UI check exception: 1')
  })

  it('fails an expired matching exception', () => {
    const result = gate({
      reports: [report([{ code: 'element-overflow' }])],
      exceptions: [exception({ expires: '2030-01-01' })],
    })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Expired UI check exception: 1')
  })

  it('validates expiry globally across lanes', () => {
    const result = gate({
      exceptions: [
        exception({ suite: 'a11y', category: 'axe-serious', rule: 'label', expires: '2030-01-01' }),
      ],
    })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Expired UI check exception: 1')
  })

  it('fails a stale exception that no longer matches a finding', () => {
    const result = gate({ exceptions: [exception()] })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Stale UI check exception: 1')
  })

  it('fails selectors absent from the full matrix', () => {
    const result = gate({ exceptions: [exception({ viewport: { width: 999, height: 999 } })] })
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Stale UI check exception: 1')
  })

  it('leaves another shard to validate its own exact selector', () => {
    const anotherShard = { ...report(), theme: 'dark' as const }
    const result = gate({
      allExpected: [report(), anotherShard],
      exceptions: [exception({ theme: 'dark' })],
    })
    expect(result.passed).toBe(true)
  })

  it.each([
    undefined,
    {},
    [exception({ reason: '' })],
    [exception({ expires: '2030-02-30' })],
    [exception({ category: 'scan-error' })],
    [exception({ category: 'invalid-exemption' })],
    [exception({ category: 'expired-exemption' })],
    [exception({ theme: '*' as 'light' })],
    [exception({ page: 'nonexistent-page' })],
    [exception({ rule: true as unknown as string })],
  ])('fails invalid exception input %#', (exceptions) => {
    expect(gate({ exceptions }).passed).toBe(false)
  })

  it('never excepts scan errors or structural failures', () => {
    const result = gate({
      reports: [report([{ code: 'scan-error' }])],
      exceptions: [exception({ category: 'scan-error' })],
    })
    expect(result.passed).toBe(false)
    expect(result.blockingFindings).toBe(1)
  })
})

describe('blocking finding details', () => {
  it('lists at most 20 unexcepted findings with all exception fields and the remainder', () => {
    const result = gate({
      reports: [
        report([
          { code: 'element-overflow' },
          ...Array.from({ length: 23 }, () => ({
            code: 'axe-serious' as const,
            rule: 'button-name',
            element: { tag: 'button', index: 3, selector: 'button.grid[data-testid="submit"]' },
          })),
        ]),
      ],
      exceptions: [exception()],
    })
    expect(result.blockingFindings).toBe(23)
    expect(result.exemptedFindings).toBe(1)
    expect(result.blockingFindingDetails).toHaveLength(20)
    expect(result.blockingFindingDetails[0]).toEqual({
      page: 'booking',
      viewport: { width: 320, height: 568 },
      locale: 'en-US',
      theme: 'light',
      category: 'axe-serious',
      rule: 'button-name',
      selector: 'button.grid[data-testid="submit"]',
    })
    const summary = uiGateFindingsSummary(result)
    expect(summary).toContain(
      '| booking | 320x568 | en-US | light | axe-serious | button-name | button.grid[data-testid="submit"] |',
    )
    expect(summary.match(/\| booking \|/g)).toHaveLength(20)
    expect(summary).toContain('3 more blocking findings')
    expect(summary).not.toContain('element-overflow')
  })

  it('keeps DOM content, unknown fields and unsafe selectors out of details', () => {
    const input = report([
      {
        code: 'element-overflow',
        element: {
          tag: 'div',
          index: 1,
          selector: 'div[data-email="UI_GATE_PRIVACY_CANARY_NONSECRET"]',
        },
      },
    ])
    Object.assign(input.findings[0] ?? {}, { html: 'UI_GATE_PRIVACY_CANARY_NONSECRET' })
    const result = gate({ reports: [input] })
    const summary = uiGateFindingsSummary(result)
    expect(JSON.stringify(result.blockingFindingDetails)).not.toContain(
      'UI_GATE_PRIVACY_CANARY_NONSECRET',
    )
    expect(summary).not.toContain('UI_GATE_PRIVACY_CANARY_NONSECRET')
    expect(summary).toContain('| element-overflow | — | — |')
    expect(uiGateFindingsSummary(gate())).toBe('Blocking findings / 阻断问题：0')
  })
})

describe('matrix-derived report completeness', () => {
  it('expands selected states using the page-specific locale matrix', () => {
    const selected = expectedFromPlaywrightList(
      {
        suites: [
          {
            title: '320x568 light en-GB',
            specs: [{ title: 'measure every page', tests: [{ projectName: 'layout' }] }],
          },
        ],
      },
      'layout',
      new Map(),
    )
    expect(selected.map((identity: ReportIdentity) => identity.page)).toEqual(
      auditPages.filter(({ id }) => auditLocales(id).includes('en-GB')).map(({ id }) => id),
    )
  })

  it('takes axe viewports from configured projects', () => {
    const viewport = { width: 777, height: 999 }
    const selected = expectedFromPlaywrightList(
      {
        suites: [
          {
            title: 'dark en-US',
            specs: [
              {
                title: 'scan serious and critical WCAG violations',
                tests: [{ projectName: 'probe' }],
              },
            ],
          },
        ],
      },
      'a11y',
      new Map([['probe', viewport]]),
    )
    expect(selected).toHaveLength(auditPages.length)
    expect(selected.every((identity: ReportIdentity) => identity.viewport === viewport)).toBe(true)
  })

  it('rejects failed, empty or duplicate test enumerations', () => {
    expect(() =>
      expectedFromPlaywrightList({ suites: [], errors: [{}] }, 'layout', new Map()),
    ).toThrow()
    expect(() => expectedFromPlaywrightList({ suites: [] }, 'layout', new Map())).toThrow()
    expect(() =>
      expectedFromPlaywrightList(
        {
          suites: [
            {
              title: '320x568 light en-US',
              specs: [
                {
                  title: 'measure every page',
                  tests: [{ projectName: 'layout' }, { projectName: 'layout' }],
                },
              ],
            },
          ],
        },
        'layout',
        new Map(),
      ),
    ).toThrow()
  })

  it('partitions actual Playwright-selected shards without running browsers', async () => {
    const matrices: Awaited<ReturnType<typeof loadExpectedReports>>[] = []
    for (let shard = 1; shard <= 4; shard++)
      matrices.push(await loadExpectedReports('layout', `${shard}/4`))
    const allExpected = matrices[0]?.allExpected ?? []
    const selected = matrices.flatMap((matrix) => matrix.expected)
    const reportsPerViewportAndTheme = auditPages.reduce(
      (total, page) => total + auditLocales(page.id).length,
      0,
    )
    expect(allExpected).toHaveLength(layoutViewports.length * 2 * reportsPerViewportAndTheme)
    expect(new Set(selected.map(reportIdentity)).size).toBe(selected.length)
    expect(new Set(selected.map(reportIdentity))).toEqual(new Set(allExpected.map(reportIdentity)))
    // Preparation tests occupy shard slots but do not write measurement reports.
    expect(new Set(matrices.map((matrix) => matrix.expected.length)).size).toBeGreaterThan(1)
  }, 30_000)

  it('makes the terminal summary red for regression, loss, unreadable JSON and browser exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-ui-gate-summary-'))
    directories.push(directory)
    const { expected } = await loadExpectedReports('a11y')
    for (const [index, identity] of expected.entries())
      await writeFile(
        join(directory, `report-${index}.json`),
        JSON.stringify({
          ...identity,
          version: 1,
          findings: [],
          axe: { passes: 10, incomplete: 1 },
        }),
      )
    const execution = join(directory, 'a11y-execution.json')
    await writeFile(
      execution,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'execution',
        suite: 'a11y',
        exitCode: 0,
        blocking: false,
      }),
    )
    const summarize = () =>
      spawnSync(
        process.execPath,
        [
          process.env.HOURMERE_UI_SUMMARY_MODULE ?? 'tools/e2e/reports-summary.ts',
          directory,
          '--suite=a11y',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
        },
      )
    const clean = summarize()
    expect(clean.status, clean.stderr).toBe(0)
    expect(clean.stdout).toContain('blocking / 阻断')
    expect(clean.stdout).toContain(`incomplete ${expected.length}`)
    expect(clean.stdout).toContain('Blocking findings / 阻断问题：0')
    const first = join(directory, 'report-0.json')
    const original = await readFile(first, 'utf8')
    const failingReport = JSON.parse(original) as AuditReport
    failingReport.findings = [
      {
        code: 'axe-serious',
        rule: 'button-name',
        element: { tag: 'button', index: 1, selector: 'button.submit' },
      },
    ]
    Object.assign(failingReport.findings[0] ?? {}, { html: 'UI_GATE_PRIVACY_CANARY_NONSECRET' })
    await writeFile(first, JSON.stringify(failingReport))
    const regression = summarize()
    expect(regression.status).toBe(1)
    expect(regression.stdout).toContain(
      `| ${failingReport.page} | ${failingReport.viewport.width}x${failingReport.viewport.height} | ${failingReport.locale} | ${failingReport.theme} | axe-serious | button-name | button.submit |`,
    )
    expect(regression.stdout).not.toContain('UI_GATE_PRIVACY_CANARY_NONSECRET')
    await writeFile(first, original)
    await rm(first)
    const missing = summarize()
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('Missing reports: 1')
    await writeFile(first, 'UI_GATE_PRIVACY_CANARY_NONSECRET')
    const unreadable = summarize()
    expect(unreadable.status).toBe(1)
    expect(unreadable.stdout).not.toContain('UI_GATE_PRIVACY_CANARY_NONSECRET')
    await writeFile(first, original)
    await writeFile(
      execution,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'execution',
        suite: 'a11y',
        exitCode: 7,
        blocking: false,
      }),
    )
    const failedBrowser = summarize()
    expect(failedBrowser.status).toBe(1)
    expect(failedBrowser.stdout).toContain(
      'Browser execution failed (exit 7); see the Run a11y measurement step log',
    )
  }, 30_000)

  it.each(['exit', 'signal', 'invalid-json', 'empty-matrix'] as const)(
    'prints enumeration %s status and the bounded stderr tail',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-ui-list-error-'))
      directories.push(directory)
      const child = join(directory, 'list.mjs')
      await writeFile(
        child,
        `
      process.stderr.write('LIST_DIAGNOSTIC_HEAD' + 'x'.repeat(5000) + 'LIST_DIAGNOSTIC_TAIL');
      ${mode === 'exit' ? 'process.exitCode = 9' : mode === 'signal' ? "process.kill(process.pid, 'SIGTERM')" : `process.stdout.write(${JSON.stringify(mode === 'invalid-json' ? 'UI_GATE_PRIVACY_CANARY_NONSECRET' : '{"suites":[]}')})`};
    `,
      )
      const root = new URL('../', import.meta.url)
      const gateSource = await readFile(
        process.env.HOURMERE_UI_GATE_MODULE ??
          new URL('../tools/e2e/ui-check-gate.ts', import.meta.url),
        'utf8',
      )
      const copiedGate = join(directory, 'gate.mts')
      await writeFile(
        copiedGate,
        gateSource
          .replace(
            "'./audit-pages.ts'",
            JSON.stringify(new URL('tools/e2e/audit-pages.ts', root).href),
          )
          .replace("'./reports.ts'", JSON.stringify(new URL('tools/e2e/reports.ts', root).href))
          .replace(
            "fileURLToPath(new URL('../../', import.meta.url))",
            JSON.stringify(root.pathname),
          )
          .replace(
            "new URL('./playwright.audit.config.ts', import.meta.url)",
            `new URL(${JSON.stringify(new URL('tools/e2e/playwright.audit.config.ts', root).href)})`,
          )
          .replace(
            "fileURLToPath(import.meta.resolve('@playwright/test/cli'))",
            JSON.stringify(child),
          ),
      )
      const summarySource = await readFile(
        process.env.HOURMERE_UI_SUMMARY_MODULE ??
          new URL('../tools/e2e/reports-summary.ts', import.meta.url),
        'utf8',
      )
      const copiedSummary = join(directory, 'summary.mts')
      await writeFile(
        copiedSummary,
        summarySource
          .replace("'./reports.ts'", JSON.stringify(new URL('tools/e2e/reports.ts', root).href))
          .replace("'./ui-check-gate.ts'", JSON.stringify(copiedGate))
          .replace(
            "new URL('./ui-check-exceptions.json', import.meta.url)",
            `new URL(${JSON.stringify(new URL('tools/e2e/ui-check-exceptions.json', root).href)})`,
          ),
      )
      const result = spawnSync(process.execPath, [copiedSummary, directory, '--suite=layout'], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
      })
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toContain('Unable to enumerate UI measurement matrix')
      expect(result.stdout).toContain(
        mode === 'exit'
          ? 'exit status: 9; signal: none'
          : mode === 'signal'
            ? 'exit status: none; signal: SIGTERM'
            : 'exit status: 0; signal: none',
      )
      expect(result.stdout).toContain('LIST_DIAGNOSTIC_TAIL')
      expect(result.stdout).not.toContain('LIST_DIAGNOSTIC_HEAD')
      expect(result.stdout).not.toContain('UI_GATE_PRIVACY_CANARY_NONSECRET')
    },
  )
})
