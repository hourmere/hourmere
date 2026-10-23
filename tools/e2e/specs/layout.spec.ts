import { auditLocales, auditPages, openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { layoutViewports, measureKeyboard, measureLayout } from '../layout.ts'
import {
  type AuditLocale,
  type AuditReport,
  assertAuditFindings,
  writeAuditReport,
} from '../reports.ts'

// OAuth provider rate limits are process-wide, so a fresh app/database alone must
// not consume the five-per-minute dynamic-registration budget in matrix scans.
test.describe('successive isolated OAuth audit apps', () => {
  test.describe.configure({ mode: 'serial' })
  for (let attempt = 1; attempt <= 7; attempt++)
    test(`prepares consent in isolated app ${attempt}`, async ({ page, app }) => {
      await openAuditPage(page, app, 'oauth-consent')
      await expect(page.getByRole('button', { name: 'Allow access', exact: true })).toBeVisible()
      await expect(page.getByText('Synthetic audit connector', { exact: true })).toBeVisible()
    })
})

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 320, height: 256 },
]) {
  test.describe(`page preparation ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: viewport.width <= 480, hasTouch: viewport.width <= 480 })
    for (const locale of ['en-US', 'zh-CN'] as const)
      test(`prepare additional required page states ${locale}`, async ({ page, app }) => {
        const selectors = {
          'booking-form': '.details-step form input[type="email"]',
          'booking-confirmation': '.confirmation > .booking-details',
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
          if (id === 'booking-confirmation') {
            const supportingDetails = page.locator('.confirmation-secondary > .booking-details')
            await expect(supportingDetails).toBeVisible()
            await expect(page.locator(selector).locator('dt')).toHaveText(
              locale === 'zh-CN' ? ['事项', '时间', '地点'] : ['What', 'When', 'Where'],
            )
            await expect(
              supportingDetails.locator('dt').filter({ hasText: /^(Host|主持人)$/ }),
            ).toBeVisible()
          }
          if (id === 'booking-form') {
            const zone = page.locator('.host-time-zone')
            await expect(zone.locator('wbr')).toHaveCount(1)
            // Chinese permits breaks inside Latin names unless each slash segment stays together.
            expect(
              await zone.locator('.time-zone-segment').evaluateAll((segments) => {
                // Also measure the longer name from the reported 1280px Chinese regression.
                const city = segments.at(-1)
                const original = city?.textContent ?? ''
                if (city) city.textContent = 'Los Angeles'
                try {
                  return segments.every((segment) => {
                    const range = document.createRange()
                    range.selectNodeContents(segment)
                    return range.getClientRects().length === 1
                  })
                } finally {
                  if (city) city.textContent = original
                }
              }),
            ).toBe(true)
          }
          if (id === 'team-booking') await expect(page.locator(selector)).toHaveText('FixtureTeam')
          if (id === 'oauth-consent')
            await expect(page.locator(selector)).toHaveText(/^(Allow access|允许访问)$/)
          const viewport = page.viewportSize()
          if (!viewport) throw new Error('UI audit requires a CSS viewport')
          const findings = await page.evaluate(measureLayout, viewport)
          expect(findings.some((finding) => finding.code === 'scan-error')).toBe(false)
        }
      })
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
