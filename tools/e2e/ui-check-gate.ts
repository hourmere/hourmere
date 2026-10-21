import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { auditLocales, auditPages } from './audit-pages.ts'
import type { AuditFinding, AuditReport, FindingCode } from './reports.ts'

export type BlockingSuite = 'layout' | 'a11y' | 'cross-engine'
export type ReportIdentity = Pick<AuditReport, 'kind' | 'page' | 'theme' | 'locale' | 'viewport'>
export interface AuditExecution {
  suite: string
  exitCode: number
  blocking: boolean
}
export interface UiCheckException extends Omit<ReportIdentity, 'kind'> {
  suite: 'layout' | 'a11y'
  category: FindingCode
  rule?: string
  reason: string
  expires: string
}

const layoutCategories = new Set([
  'document-overflow',
  'element-overflow',
  'oversized-fixed',
  'small-input-font',
  'small-target',
  'obscured-focus',
  'outside-viewport-focus',
  'keyboard-limit',
])
const axeCategories = new Set(['axe-serious', 'axe-critical'])
const locales = new Set(['en-US', 'zh-CN', 'en-GB'])
const themes = new Set(['light', 'dark'])
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

export function reportIdentity(report: ReportIdentity): string {
  return [
    report.kind,
    report.page,
    report.viewport.width,
    report.viewport.height,
    report.locale,
    report.theme,
  ].join(':')
}

function exceptionIdentity(exception: UiCheckException): string {
  return reportIdentity({ ...exception, kind: exception.suite })
}

function validException(value: unknown): value is UiCheckException {
  if (!value || typeof value !== 'object') return false
  const entry = value as UiCheckException
  return (
    (entry.suite === 'layout' || entry.suite === 'a11y') &&
    auditPages.some(({ id }) => id === entry.page) &&
    Boolean(entry.viewport) &&
    positiveInteger(entry.viewport.width) &&
    positiveInteger(entry.viewport.height) &&
    locales.has(entry.locale) &&
    themes.has(entry.theme) &&
    (entry.suite === 'layout' ? layoutCategories : axeCategories).has(entry.category) &&
    (entry.suite !== 'a11y' || typeof entry.rule === 'string') &&
    (entry.rule === undefined ||
      (typeof entry.rule === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(entry.rule))) &&
    typeof entry.reason === 'string' &&
    entry.reason.trim().length > 0 &&
    typeof entry.expires === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.expires) &&
    Number.isFinite(Date.parse(`${entry.expires}T00:00:00Z`)) &&
    new Date(`${entry.expires}T00:00:00Z`).toISOString().startsWith(entry.expires)
  )
}

function matches(exception: UiCheckException, report: AuditReport, finding: AuditFinding) {
  return (
    exceptionIdentity(exception) === reportIdentity(report) &&
    exception.category === finding.code &&
    (exception.rule === undefined || exception.rule === finding.rule)
  )
}

export function evaluateUiGate({
  suite,
  reports,
  executions,
  unreadable = 0,
  expected,
  allExpected = expected,
  exceptions,
  today = new Date().toISOString().slice(0, 10),
}: {
  suite: BlockingSuite
  reports: AuditReport[]
  executions: AuditExecution[]
  unreadable?: number
  expected: ReportIdentity[]
  allExpected?: ReportIdentity[]
  exceptions: unknown
  today?: string
}) {
  const failures: string[] = []
  const laneExecutions = executions.filter((execution) => execution.suite === suite)
  if (laneExecutions.length !== 1) failures.push('Expected exactly one browser execution report')
  if (laneExecutions.some((execution) => execution.exitCode !== 0))
    failures.push('Browser execution failed')
  if (unreadable) failures.push(`Unreadable reports: ${unreadable}`)

  const expectedIds = new Set(expected.map(reportIdentity))
  const allExpectedIds = new Set(allExpected.map(reportIdentity))
  const seen = new Set<string>()
  let duplicate = 0
  let unexpected = 0
  for (const report of reports) {
    const identity = reportIdentity(report)
    if (seen.has(identity)) duplicate++
    seen.add(identity)
    if (!expectedIds.has(identity)) unexpected++
  }
  const missing = [...expectedIds].filter((identity) => !seen.has(identity)).length
  if (missing) failures.push(`Missing reports: ${missing}`)
  if (duplicate) failures.push(`Duplicate reports: ${duplicate}`)
  if (unexpected) failures.push(`Unexpected reports: ${unexpected}`)
  if (reports.some((report) => (report.exempted ?? 0) > 0))
    failures.push('Legacy axe exemptions must move to ui-check-exceptions.json')

  const active: UiCheckException[] = []
  if (!Array.isArray(exceptions)) failures.push('Invalid UI check exceptions file')
  else
    for (const [index, entry] of exceptions.entries()) {
      if (!validException(entry)) {
        failures.push(`Invalid UI check exception: ${index + 1}`)
        continue
      }
      if (entry.expires < today) {
        failures.push(`Expired UI check exception: ${index + 1}`)
        continue
      }
      // Exact selectors assign each entry to one report, hence one layout shard.
      // Missing selectors fail everywhere; valid selectors are stale-checked by
      // their owning shard only, rather than falsely failing unrelated shards.
      if (entry.suite !== suite) continue
      const identity = exceptionIdentity(entry)
      if (!allExpectedIds.has(identity)) {
        failures.push(`Stale UI check exception: ${index + 1}`)
        continue
      }
      if (!expectedIds.has(identity)) continue
      if (
        !reports.some((report) =>
          report.findings.some((finding) => matches(entry, report, finding)),
        )
      )
        failures.push(`Stale UI check exception: ${index + 1}`)
      else active.push(entry)
    }

  let exemptedFindings = 0
  let blockingFindings = 0
  for (const report of reports)
    for (const finding of report.findings) {
      if (active.some((entry) => matches(entry, report, finding))) exemptedFindings++
      else blockingFindings++
    }
  if (blockingFindings) failures.push(`Unexcepted findings: ${blockingFindings}`)
  return {
    suite,
    passed: failures.length === 0,
    expectedReports: expected.length,
    actualReports: reports.length,
    exemptedFindings,
    blockingFindings,
    failures,
  }
}

interface ListedSuite {
  title: string
  specs?: { title: string; tests: { projectName: string }[] }[]
  suites?: ListedSuite[]
}
interface PlaywrightList {
  errors?: unknown[]
  suites: ListedSuite[]
}
type ProjectViewports = Map<string, { width: number; height: number }>

// Expand the tests Playwright actually selected, including its shard algorithm,
// by the same pages/locales the scan loops use. Never infer shard sizes by division.
export function expectedFromPlaywrightList(
  listing: PlaywrightList,
  suite: 'layout' | 'a11y',
  projectViewports: ProjectViewports,
): ReportIdentity[] {
  if (!Array.isArray(listing.suites) || listing.errors?.length)
    throw new Error('Unable to enumerate UI measurement matrix')
  const expected: ReportIdentity[] = []
  const visit = (node: ListedSuite, parents: string[]) => {
    const titles = [...parents, node.title]
    for (const spec of node.specs ?? []) {
      if (
        spec.title !==
        (suite === 'layout' ? 'measure every page' : 'scan serious and critical WCAG violations')
      )
        continue
      const state = titles
        .map((title) =>
          suite === 'layout'
            ? /^(\d+)x(\d+) (light|dark) (en-US|zh-CN|en-GB)$/.exec(title)
            : /^(light|dark) (en-US|zh-CN|en-GB)$/.exec(title),
        )
        .find((match) => match !== null)
      if (!state) throw new Error('Unknown UI measurement test state')
      for (const test of spec.tests) {
        const viewport =
          suite === 'layout'
            ? { width: Number(state[1]), height: Number(state[2]) }
            : projectViewports.get(test.projectName)
        if (!viewport || !positiveInteger(viewport.width) || !positiveInteger(viewport.height))
          throw new Error('Unknown UI measurement project viewport')
        const theme = state[suite === 'layout' ? 3 : 1] as AuditReport['theme']
        const locale = state[suite === 'layout' ? 4 : 2] as AuditReport['locale']
        for (const page of auditPages) {
          if (!(auditLocales(page.id) as readonly string[]).includes(locale)) continue
          expected.push({ kind: suite, page: page.id, theme, locale, viewport })
        }
      }
    }
    for (const child of node.suites ?? []) visit(child, titles)
  }
  for (const node of listing.suites) visit(node, [])
  if (!expected.length || new Set(expected.map(reportIdentity)).size !== expected.length)
    throw new Error('Empty or duplicate UI measurement matrix')
  return expected
}

export async function loadExpectedReports(suite: BlockingSuite, shard?: string) {
  if (suite === 'cross-engine') return { expected: [], allExpected: [] }
  if (shard && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error('Invalid UI shard')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const previousSuite = process.env.HOURMERE_UI_SUITE
  process.env.HOURMERE_UI_SUITE = suite
  let projectViewports: ProjectViewports
  try {
    const configurationUrl = new URL('./playwright.audit.config.ts', import.meta.url)
    configurationUrl.searchParams.set('suite', suite)
    const configuration = await import(configurationUrl.href)
    projectViewports = new Map(
      configuration.default.projects.map(
        (project: { name: string; use: { viewport: { width: number; height: number } } }) => [
          project.name,
          project.use.viewport,
        ],
      ),
    )
  } finally {
    if (previousSuite === undefined) delete process.env.HOURMERE_UI_SUITE
    else process.env.HOURMERE_UI_SUITE = previousSuite
  }
  const list = (selectedShard?: string) => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('@playwright/test/cli')),
        'test',
        '--config',
        'tools/e2e/playwright.audit.config.ts',
        '--list',
        '--reporter=json',
        ...(selectedShard ? [`--shard=${selectedShard}`] : []),
      ],
      {
        cwd: root,
        env: { ...process.env, HOURMERE_UI_SUITE: suite },
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      },
    )
    if (child.status !== 0) throw new Error('Unable to enumerate UI measurement matrix')
    return expectedFromPlaywrightList(JSON.parse(child.stdout), suite, projectViewports)
  }
  const expected = list(shard)
  return { expected, allExpected: shard ? list() : expected }
}
