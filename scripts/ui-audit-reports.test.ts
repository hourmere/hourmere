import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { type AuditReport, summarizeFindingTypes, writeAuditReport } from '../tools/e2e/reports.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-ui-reports-'))
  directories.push(directory)
  return directory
}
function fixture(): AuditReport {
  return {
    version: 1,
    kind: 'layout',
    page: 'booking',
    theme: 'dark',
    locale: 'zh-CN',
    viewport: { width: 320, height: 568 },
    findings: [
      { code: 'element-overflow', element: { tag: 'p', index: 12 }, actual: 400, expected: 320 },
    ],
  }
}
it('writes isolated JSON report files with only the public measurement schema', async () => {
  const directory = await temporaryDirectory()
  const report = fixture()
  Object.assign(report, { url: '#token=REPORT_PRIVACY_CANARY_NONSECRET' })
  Object.assign(report.findings[0] ?? {}, { html: 'REPORT_PRIVACY_CANARY_NONSECRET' })
  await writeAuditReport(report, directory)
  await writeAuditReport(report, directory)
  const files = await readdir(directory)
  expect(files).toHaveLength(2)
  expect(new Set(files).size).toBe(2)
  for (const file of files) {
    expect(file).toMatch(/^layout-booking-dark-zh-CN-320x568-[\da-f-]+\.json$/)
    const content = await readFile(join(directory, file), 'utf8')
    expect(content).not.toContain('REPORT_PRIVACY_CANARY_NONSECRET')
    expect(JSON.parse(content)).toEqual(fixture())
  }
})
it('publishes per-page JSON and human summaries and preserves browser execution failures', async () => {
  const directory = await temporaryDirectory(),
    summary = join(directory, 'job.md')
  await writeAuditReport(fixture(), directory)
  await writeAuditReport(
    {
      ...fixture(),
      kind: 'a11y',
      findings: [
        { code: 'axe-critical', rule: 'button-name', count: 2 },
        { code: 'scan-error', phase: 'navigate' },
      ],
    },
    directory,
  )
  await writeFile(
    join(directory, 'layout-execution.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'execution',
      suite: 'layout',
      exitCode: 1,
      blocking: false,
    }),
  )
  await writeFile(join(directory, 'invalid.json'), 'REPORT_PRIVACY_CANARY_NONSECRET')
  const result = spawnSync(process.execPath, ['tools/e2e/reports-summary.ts', directory], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary, HOURMERE_UI_BLOCKING: '0' },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toContain('REPORT_PRIVACY_CANARY_NONSECRET')
  expect(result.stdout).toContain('| booking | 2 | 1 | 2 | 1 | 1 |')
  expect(result.stdout).toContain('layout — exit / 退出码 1')
  expect(result.stdout).toContain('Unreadable reports / 无法读取的报告：1')
  expect((await readFile(summary, 'utf8')).trim()).toBe(result.stdout.trim())
  expect((await readFile(join(directory, 'summary.md'), 'utf8')).trim()).toBe(result.stdout.trim())
  expect(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))).toEqual({
    version: 1,
    pages: [{ page: 'booking', scans: 2, overflow: 1, axe: 2, other: 1, scanErrors: 1 }],
    findings: summarizeFindingTypes([
      fixture(),
      {
        ...fixture(),
        kind: 'a11y',
        findings: [
          { code: 'axe-critical', rule: 'button-name', count: 2 },
          { code: 'scan-error', phase: 'navigate' },
        ],
      },
    ]),
    executions: [{ suite: 'layout', exitCode: 1, blocking: false }],
    unreadable: 1,
  })
})
