import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AuditReport,
  auditSummary,
  safeAuditReport,
  summarizeAuditReports,
  summarizeFindingTypes,
} from './reports.ts'
import {
  type AuditExecution,
  type BlockingSuite,
  evaluateUiGate,
  loadExpectedReports,
  UiMatrixEnumerationError,
  uiGateFindingsSummary,
} from './ui-check-gate.ts'

const arguments_ = process.argv.slice(2)
const suiteArgument = arguments_.find((argument) => argument.startsWith('--suite='))?.slice(8)
if (suiteArgument && !['layout', 'a11y', 'cross-engine'].includes(suiteArgument))
  throw new Error('Expected a blocking UI measurement suite')
const suite = suiteArgument as BlockingSuite | undefined
const shard = arguments_.find((argument) => argument.startsWith('--shard='))?.slice(8)
const directory =
  arguments_.find((argument) => !argument.startsWith('--')) ??
  process.env.HOURMERE_UI_REPORT_DIR ??
  'temp/ui-audit-reports'
const reports: AuditReport[] = []
const executions: AuditExecution[] = []
let unreadable = 0
try {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith('.json') || file.endsWith('summary.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(directory, file), 'utf8'))
      if (
        parsed.kind === 'execution' &&
        parsed.schemaVersion === 1 &&
        ['layout', 'a11y', 'visual', 'cross-engine'].includes(parsed.suite) &&
        Number.isInteger(parsed.exitCode) &&
        parsed.exitCode >= 0 &&
        typeof parsed.blocking === 'boolean'
      ) {
        executions.push({
          suite: parsed.suite,
          exitCode: parsed.exitCode,
          blocking: parsed.blocking,
        })
      } else reports.push(safeAuditReport(parsed))
    } catch {
      // Do not echo file names or parser diagnostics from untrusted artifacts.
      unreadable++
    }
  }
} catch {
  unreadable++
}
let gate: ReturnType<typeof evaluateUiGate> | undefined
if (suite) {
  // Layout/axe findings remain report-only during scans: this terminal gate owns
  // exceptions and completeness, and repeats browser-execution failures for context.
  process.env.HOURMERE_UI_BLOCKING = '1'
  let exceptions: unknown
  try {
    exceptions = JSON.parse(
      await readFile(new URL('./ui-check-exceptions.json', import.meta.url), 'utf8'),
    )
  } catch {
    // A missing or unreadable exception file must not become an empty allowlist.
  }
  let matrix: Awaited<ReturnType<typeof loadExpectedReports>> = { expected: [], allExpected: [] }
  let matrixError: string | undefined
  try {
    matrix = await loadExpectedReports(suite, shard)
  } catch (error) {
    // Only the listing child's status/signal/stderr are safe infrastructure diagnostics.
    matrixError =
      error instanceof UiMatrixEnumerationError
        ? error.message
        : 'Unable to enumerate UI measurement matrix'
  }
  gate = evaluateUiGate({ suite, reports, executions, unreadable, ...matrix, exceptions })
  if (matrixError) {
    gate.passed = false
    gate.failures.push(matrixError)
  }
}
const summary = [
  auditSummary(reports),
  ...executions.map(
    (execution) =>
      `Browser execution / 浏览器执行：${execution.suite} — exit / 退出码 ${execution.exitCode}`,
  ),
  '',
  `Unreadable reports / 无法读取的报告：${unreadable}`,
  '',
  ...(gate
    ? [
        `Gate / 阻断检查：${gate.passed ? 'PASS / 通过' : 'FAIL / 失败'}`,
        `Expected reports / 预期报告：${gate.expectedReports}; actual / 实际：${gate.actualReports}; excepted findings / 豁免问题：${gate.exemptedFindings}`,
        ...gate.failures.map((failure) => `- ${failure}`),
        '',
        uiGateFindingsSummary(gate),
        '',
      ]
    : []),
].join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
if (reports.length || executions.length) {
  await writeFile(join(directory, 'summary.md'), summary)
  await writeFile(
    join(directory, 'summary.json'),
    `${JSON.stringify({ version: 1, pages: summarizeAuditReports(reports), findings: summarizeFindingTypes(reports), executions, unreadable, ...(gate ? { gate } : {}) }, null, 2)}\n`,
  )
}
if (gate && !gate.passed) process.exitCode = 1
