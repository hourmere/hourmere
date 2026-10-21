import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AuditTheme = 'light' | 'dark'
export type AuditLocale = 'en-US' | 'zh-CN' | 'en-GB'
export type FindingCode =
  | 'document-overflow'
  | 'element-overflow'
  | 'oversized-fixed'
  | 'small-input-font'
  | 'small-target'
  | 'obscured-focus'
  | 'outside-viewport-focus'
  | 'keyboard-limit'
  | 'axe-serious'
  | 'axe-critical'
  | 'expired-exemption'
  | 'invalid-exemption'
  | 'scan-error'
export interface AuditFinding {
  code: FindingCode
  element?: { tag: string; index: number; selector?: string }
  actual?: number
  expected?: number
  rule?: string
  count?: number
  phase?: 'navigate' | 'layout' | 'keyboard' | 'axe' | 'exemptions'
}
export interface AuditReport {
  version: 1
  kind: 'layout' | 'a11y'
  page: string
  theme: AuditTheme
  locale: AuditLocale
  viewport: { width: number; height: number }
  findings: AuditFinding[]
  exempted?: number
  axe?: { passes: number; incomplete: number; incompleteRules?: string[] }
}

const codes = new Set<FindingCode>([
  'document-overflow',
  'element-overflow',
  'oversized-fixed',
  'small-input-font',
  'small-target',
  'obscured-focus',
  'outside-viewport-focus',
  'keyboard-limit',
  'axe-serious',
  'axe-critical',
  'expired-exemption',
  'invalid-exemption',
  'scan-error',
])
const phases = new Set(['navigate', 'layout', 'keyboard', 'axe', 'exemptions'])
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

// Rebuild field by field. Selector hints accept only tag/class/test-id tokens;
// never serialize browser errors, URLs, HTML, names or raw axe node targets.
export function safeAuditReport(report: AuditReport): AuditReport {
  if (
    report.version !== 1 ||
    !['layout', 'a11y'].includes(report.kind) ||
    !/^[a-z][a-z-]{0,40}$/.test(report.page) ||
    !['light', 'dark'].includes(report.theme) ||
    !['en-US', 'zh-CN', 'en-GB'].includes(report.locale) ||
    !finite(report.viewport.width) ||
    !finite(report.viewport.height)
  )
    throw new Error('Invalid UI audit report metadata')
  return {
    version: 1,
    kind: report.kind,
    page: report.page,
    theme: report.theme,
    locale: report.locale,
    viewport: { width: report.viewport.width, height: report.viewport.height },
    findings: report.findings.map((finding) => {
      const safe: AuditFinding = { code: codes.has(finding.code) ? finding.code : 'scan-error' }
      if (
        finding.element &&
        /^[a-z][a-z0-9]{0,20}$/.test(finding.element.tag) &&
        finite(finding.element.index)
      ) {
        safe.element = { tag: finding.element.tag, index: finding.element.index }
        const selector = finding.element.selector
        if (
          selector &&
          !/(?:token|secret|canary)/i.test(selector) &&
          /^[a-z][a-z0-9]{0,20}(?:\.[a-zA-Z_][a-zA-Z0-9_-]{0,63}){0,8}(?:\[data-testid="[a-zA-Z_][a-zA-Z0-9_-]{0,63}"\])?$/.test(
            selector,
          ) &&
          selector.split(/[.[]/, 1)[0] === finding.element.tag
        )
          safe.element.selector = selector
      }
      if (finite(finding.actual)) safe.actual = Math.round(finding.actual * 100) / 100
      if (finite(finding.expected)) safe.expected = Math.round(finding.expected * 100) / 100
      if (finite(finding.count)) safe.count = finding.count
      // Axe rule ids are scanner constants, never node targets or page content.
      if (finding.rule && /^[a-z][a-z0-9-]{0,79}$/.test(finding.rule)) safe.rule = finding.rule
      if (finding.phase && phases.has(finding.phase)) safe.phase = finding.phase
      return safe
    }),
    ...(finite(report.exempted) ? { exempted: report.exempted } : {}),
    ...(report.axe && finite(report.axe.passes) && finite(report.axe.incomplete)
      ? {
          axe: {
            passes: report.axe.passes,
            incomplete: report.axe.incomplete,
            ...(Array.isArray(report.axe.incompleteRules)
              ? {
                  incompleteRules: [
                    ...new Set(
                      report.axe.incompleteRules.filter(
                        (rule) => typeof rule === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(rule),
                      ),
                    ),
                  ].sort(),
                }
              : {}),
          },
        }
      : {}),
  }
}

export async function writeAuditReport(report: AuditReport, directory?: string) {
  const safe = safeAuditReport(report)
  const destination = directory ?? process.env.HOURMERE_UI_REPORT_DIR ?? 'temp/ui-audit-reports'
  await mkdir(destination, { recursive: true })
  const name = `${safe.kind}-${safe.page}-${safe.theme}-${safe.locale}-${safe.viewport.width}x${safe.viewport.height}-${randomUUID()}.json`
  await writeFile(join(destination, name), `${JSON.stringify(safe, null, 2)}\n`)
}

export function auditIsBlocking(environment: NodeJS.ProcessEnv = process.env) {
  return environment.HOURMERE_UI_BLOCKING === '1'
}

export function assertAuditFindings(reports: AuditReport[], blocking = auditIsBlocking()) {
  const count = reports.reduce((total, report) => total + report.findings.length, 0)
  // A plain Error intentionally contains only counts, never Playwright's DOM diagnostics.
  if (blocking && count)
    throw new Error(`UI audit found ${count} findings across ${reports.length} pages`)
}

export function summarizeAuditReports(reports: AuditReport[]) {
  const rows = new Map<
    string,
    { scans: number; overflow: number; axe: number; other: number; scanErrors: number }
  >()
  for (const input of reports) {
    const report = safeAuditReport(input)
    const row = rows.get(report.page) ?? { scans: 0, overflow: 0, axe: 0, other: 0, scanErrors: 0 }
    row.scans++
    for (const finding of report.findings) {
      const count = finding.count ?? 1
      if (finding.code === 'scan-error') row.scanErrors += count
      if (finding.code === 'document-overflow' || finding.code === 'element-overflow')
        row.overflow += count
      else if (finding.code === 'axe-serious' || finding.code === 'axe-critical') row.axe += count
      else row.other += count
    }
    rows.set(report.page, row)
  }
  return [...rows]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([page, counts]) => ({ page, ...counts }))
}

export function auditSummary(reports: AuditReport[]): string {
  const rows = summarizeAuditReports(reports)
  const findingTypes = summarizeFindingTypes(reports)
  const axe = reports.reduce(
    (total, report) => {
      const safe = safeAuditReport(report)
      return {
        passes: total.passes + (safe.axe?.passes ?? 0),
        incomplete: total.incomplete + (safe.axe?.incomplete ?? 0),
        incompleteRules: new Set([...total.incompleteRules, ...(safe.axe?.incompleteRules ?? [])]),
      }
    },
    { passes: 0, incomplete: 0, incompleteRules: new Set<string>() },
  )
  return [
    '## UI measurement report / 界面测量报告',
    '',
    `Mode / 模式：${auditIsBlocking() ? 'blocking / 阻断' : 'report-only / 仅报告'}`,
    '',
    '| Page / 页面 | Scans / 扫描 | Overflow / 溢出 | Axe serious + critical / 严重问题 | Other / 其他 | Scan errors / 扫描错误 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.page} | ${row.scans} | ${row.overflow} | ${row.axe} | ${row.other} | ${row.scanErrors} |`,
    ),
    '',
    `Reports / 报告：${reports.length}`,
    '',
    '| Finding / 问题类型 | Count / 数量 | Known issue / 已知问题 |',
    '| --- | ---: | --- |',
    ...findingTypes.map(
      ({ code, count, issues }) => `| ${code} | ${count} | ${issues.join(', ') || '—'} |`,
    ),
    '',
    `Axe rule results / Axe 规则结果：passes ${axe.passes}, incomplete ${axe.incomplete}`,
    `Axe incomplete rules / Axe 待人工确认规则：${[...axe.incompleteRules].sort().join(', ') || '—'}`,
    '',
    'Counts are findings across all scanned states, not unique defects. / 数量为所有扫描状态的问题总数，并非独立缺陷数。',
    'JSON contains only page identifiers, static selector hints, audit codes and measurements. / JSON 仅含页面标识、静态选择器提示、检查代码与测量值。',
    '',
  ].join('\n')
}

export function summarizeFindingTypes(reports: AuditReport[]) {
  const counts = new Map([...codes].map((code) => [code, 0]))
  for (const report of reports)
    for (const finding of safeAuditReport(report).findings)
      counts.set(finding.code, (counts.get(finding.code) ?? 0) + (finding.count ?? 1))
  const issues: Partial<Record<FindingCode, string[]>> = {
    'document-overflow': ['UI-01', 'UI-02', 'UI-03', 'UI-08'],
    'element-overflow': ['UI-01', 'UI-02', 'UI-03', 'UI-08'],
    'oversized-fixed': ['UI-05', 'UI-06'],
    'small-input-font': ['B6'],
    'small-target': ['UI-38'],
  }
  // Issue links identify related defects, not a claim that every occurrence is
  // that defect. Page and selector hints determine the precise attribution.
  return [...counts].map(([code, count]) => ({ code, count, issues: issues[code] ?? [] }))
}
