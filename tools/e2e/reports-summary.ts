import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AuditReport,
  auditSummary,
  safeAuditReport,
  summarizeAuditReports,
} from './reports.ts'

const directory = process.argv[2] ?? process.env.HOURMERE_UI_REPORT_DIR ?? 'temp/ui-audit-reports'
const reports: AuditReport[] = []
const executions: { suite: string; exitCode: number; blocking: boolean }[] = []
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
const summary = [
  auditSummary(reports),
  ...executions.map(
    (execution) =>
      `Browser execution / 浏览器执行：${execution.suite} — exit / 退出码 ${execution.exitCode}`,
  ),
  '',
  `Unreadable reports / 无法读取的报告：${unreadable}`,
  '',
].join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
if (reports.length || executions.length) {
  await writeFile(join(directory, 'summary.md'), summary)
  await writeFile(
    join(directory, 'summary.json'),
    `${JSON.stringify({ version: 1, pages: summarizeAuditReports(reports), executions, unreadable }, null, 2)}\n`,
  )
}
