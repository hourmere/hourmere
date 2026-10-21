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

  it('passes incomplete-only axe results', () => {
    const input = { ...report(), kind: 'a11y' as const, axe: { passes: 10, incomplete: 3 } }
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
    expect(result.failures).toContain('Browser execution failed')
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
    const first = join(directory, 'report-0.json')
    const original = await readFile(first, 'utf8')
    const failingReport = JSON.parse(original) as AuditReport
    failingReport.findings = [{ code: 'axe-serious', rule: 'button-name' }]
    await writeFile(first, JSON.stringify(failingReport))
    expect(summarize().status).toBe(1)
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
    expect(summarize().status).toBe(1)
  }, 30_000)
})
