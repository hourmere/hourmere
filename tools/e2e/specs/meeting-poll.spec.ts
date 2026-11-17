import { auditPages, openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

// Real B2 reads/writes under the production router. Capabilities stay out of goto,
// diagnostics and retained screenshots; the helper owns every database row.
for (const width of [320, 1280]) {
  test.describe(`public poll page at ${width}px`, () => {
    test.use({ viewport: { width, height: 720 }, uiAudit: true })
    for (const locale of ['en-US', 'zh-CN'] as const) {
      test(`opens every voter state without login in ${locale}`, async ({ page, app }) => {
        for (const entry of auditPages.filter((entry) => entry.id.startsWith('poll-'))) {
          await openAuditPage(page, app, entry.id, { locale })
          await expect(page.locator('.meeting-poll')).toBeVisible()
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true)
          expect(new URL(page.url()).hash).toBe('')
        }
      })
    }
  })
}
