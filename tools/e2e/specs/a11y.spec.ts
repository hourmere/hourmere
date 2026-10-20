import { readFile } from 'node:fs/promises'
import { a11yFindings, assertAxeCanary, scanA11y } from '../a11y.ts'
import { auditLocales, auditPages, openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import {
  type AuditLocale,
  type AuditReport,
  assertAuditFindings,
  writeAuditReport,
} from '../reports.ts'

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en-US', 'zh-CN', 'en-GB'] as const) {
    test.describe(`${theme} ${locale}`, () => {
      test.use({ locale, colorScheme: theme })
      test('scan serious and critical WCAG violations', async ({ page, app }) => {
        test.setTimeout(240_000)
        const viewport = page.viewportSize()
        if (!viewport) throw new Error('UI audit requires a CSS viewport')
        await page.emulateMedia({ colorScheme: theme })
        let exemptions: unknown
        try {
          exemptions = JSON.parse(
            await readFile(new URL('../a11y-exemptions.json', import.meta.url), 'utf8'),
          )
        } catch {
          // Invalid files are findings too; never hide them as an empty exemption list.
          exemptions = undefined
        }
        const reports: AuditReport[] = []
        for (const state of auditPages) {
          if (!(auditLocales(state.id) as readonly AuditLocale[]).includes(locale)) continue
          const report: AuditReport = {
            version: 1,
            kind: 'a11y',
            page: state.id,
            theme,
            locale,
            viewport,
            findings: [],
          }
          let phase: 'navigate' | 'axe' = 'navigate'
          try {
            await openAuditPage(page, app, state.id, { locale })
            phase = 'axe'
            const result = await scanA11y(page)
            const scan = a11yFindings(state.id, result.violations, exemptions)
            report.findings = scan.findings
            report.exempted = scan.exempted
            report.axe = { passes: result.passes, incomplete: result.incomplete }
          } catch {
            report.findings.push({ code: 'scan-error', phase })
          }
          await writeAuditReport(report)
          reports.push(report)
        }
        assertAuditFindings(reports)
      })
    })
  }
}

test('CI canary detects known violations through the in-browser axe pipeline', async ({
  page,
  app,
}) => {
  test.skip(!process.env.CI, 'The intentionally invalid fixture is only served in CI')
  await page.goto(`${app.parentUrl}/axe-canary`)
  const result = await scanA11y(page)
  const scan = a11yFindings('axe-canary', result.violations, [])
  assertAxeCanary(scan)
  expect(scan.findings.every((finding) => Boolean(finding.element?.selector))).toBe(true)
  expect(result.passes).toBeGreaterThan(0)
  expect(result.incomplete).toBeGreaterThanOrEqual(0)
})
