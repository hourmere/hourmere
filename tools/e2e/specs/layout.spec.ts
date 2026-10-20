import { auditLocales, auditPages, openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { layoutViewports, measureKeyboard, measureLayout } from '../layout.ts'
import {
  type AuditLocale,
  type AuditReport,
  assertAuditFindings,
  writeAuditReport,
} from '../reports.ts'

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`prepare additional required page states ${locale}`, async ({ page, app }) => {
    const selectors = {
      'booking-form': '.details-step form input[type="email"]',
      'booking-confirmation': '.confirmation .booking-details',
      'booking-time-zone': '.tz-panel [role="listbox"]:visible',
      'embedded-booking': '.public-embedded .event-title',
      'team-booking': '.event-host',
      'oauth-consent': 'button.button-primary',
    } as const
    for (const { id } of auditPages) {
      await openAuditPage(page, app, id, { locale })
      if (!(id in selectors)) continue
      const selector = selectors[id as keyof typeof selectors]
      await expect(page.locator(selector)).toBeVisible()
      if (id === 'team-booking') await expect(page.locator(selector)).toHaveText('FixtureTeam')
      if (id === 'oauth-consent')
        await expect(page.locator(selector)).toHaveText(/^(Allow access|允许访问)$/)
      const viewport = page.viewportSize()
      if (!viewport) throw new Error('UI audit requires a CSS viewport')
      const findings = await page.evaluate(measureLayout, viewport)
      expect(findings.some((finding) => finding.code === 'scan-error')).toBe(false)
    }
  })
}

for (const viewport of layoutViewports) {
  const mobileViewport = viewport.width <= 480 || (viewport.width <= 960 && viewport.height <= 430)
  for (const theme of ['light', 'dark'] as const) {
    for (const locale of ['en-US', 'zh-CN', 'en-GB'] as const) {
      test.describe(`${viewport.width}x${viewport.height} ${theme} ${locale}`, () => {
        test.use({
          viewport,
          locale,
          colorScheme: theme,
          isMobile: mobileViewport,
          hasTouch: mobileViewport,
        })
        test('measure every page', async ({ page, app }) => {
          test.setTimeout(240_000)
          await page.emulateMedia({ colorScheme: theme })
          const reports: AuditReport[] = []
          for (const state of auditPages) {
            if (!(auditLocales(state.id) as readonly AuditLocale[]).includes(locale)) continue
            const report: AuditReport = {
              version: 1,
              kind: 'layout',
              page: state.id,
              theme,
              locale,
              viewport,
              findings: [],
            }
            let phase: 'navigate' | 'layout' | 'keyboard' = 'navigate'
            try {
              await openAuditPage(page, app, state.id, { locale })
              phase = 'layout'
              report.findings.push(...(await page.evaluate(measureLayout, viewport)))
              phase = 'keyboard'
              report.findings.push(...(await measureKeyboard(page)))
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
}
