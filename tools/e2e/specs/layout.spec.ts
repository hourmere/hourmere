import { a11yFindings, scanA11y } from '../a11y.ts'
import { AUDIT_GUEST_NAME, AUDIT_TEAM_NAME, AUDIT_TITLE } from '../audit-data.ts'
import { auditLocales, auditPages, openAuditPage, settleAuditLayout } from '../audit-pages.ts'
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
  { width: 375, height: 812 },
  { width: 320, height: 256 },
]) {
  test.describe(`page preparation ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: viewport.width <= 480, hasTouch: viewport.width <= 480 })
    for (const locale of ['en-US', 'zh-CN'] as const)
      test(`prepare additional required page states ${locale}`, async ({ page, app }) => {
        const selectors = {
          host: '.host-header > .host-avatar',
          booking: '.event-title + .host-identity',
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
          if (id === 'host')
            await expect(page.locator('.host-header > .host-avatar + h1')).toBeVisible()
          if (['booking', 'booking-form', 'embedded-booking'].includes(id))
            await expect(page.locator('.event-title + .host-identity > .host-avatar')).toBeVisible()
          if (
            id === 'host' ||
            ['booking', 'booking-form', 'booking-confirmation', 'embedded-booking'].includes(id)
          ) {
            const avatar = page.locator('.host-avatar')
            await expect(avatar).toHaveAttribute('aria-hidden', 'true')
            const bounds = await avatar.boundingBox()
            const viewport = page.viewportSize()
            if (!bounds || !viewport) throw new Error('Host avatar must have visible bounds')
            expect(bounds.width).toBe(id === 'host' ? 64 : 48)
            expect(bounds.height).toBe(bounds.width)
            expect(bounds.x).toBeGreaterThanOrEqual(0)
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
          }
          if (id === 'booking-confirmation') {
            await expect(page.locator('.confirmation > h1 + .host-identity')).toBeVisible()
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
          if (id === 'team-booking') {
            await expect(page.locator(selector)).toHaveText(AUDIT_TEAM_NAME)
            await expect(page.locator('.event-title + .host-identity > .event-host')).toBeVisible()
            await expect(page.locator('.host-avatar')).toHaveCount(0)
          }
          if (id === 'oauth-consent')
            await expect(page.locator(selector)).toHaveText(/^(Allow access|允许访问)$/)
          const viewport = page.viewportSize()
          if (!viewport) throw new Error('UI audit requires a CSS viewport')
          const findings = await page.evaluate(measureLayout, viewport)
          expect(findings.some((finding) => finding.code === 'scan-error')).toBe(false)
          if (
            [
              'host',
              'booking',
              'booking-form',
              'booking-confirmation',
              'embedded-booking',
              'team-booking',
            ].includes(id)
          )
            expect(
              findings.filter((finding) =>
                ['document-overflow', 'element-overflow'].includes(finding.code),
              ),
            ).toEqual([])
        }
      })
  })
}

test.describe('team administrator bookings at 320px', () => {
  const viewport = { width: 320, height: 568 }
  test.use({ viewport, isMobile: true, hasTouch: true })
  for (const locale of ['en-US', 'zh-CN'] as const)
    test(`supports long names, keyboard detail and focus return ${locale}`, async ({
      page,
      app,
    }) => {
      await openAuditPage(page, app, 'team-bookings', { locale })
      const opener = page
        .locator('.team-bookings-list')
        .getByRole('button', { name: AUDIT_TITLE, exact: true })
      await expect(opener).toBeVisible()
      await expect(page.locator('main').getByText(AUDIT_TEAM_NAME, { exact: true })).toBeVisible()
      const inspect = async () => {
        await page.evaluate(settleAuditLayout)
        expect(await page.evaluate(measureLayout, viewport)).toEqual([])
        const scan = await scanA11y(page)
        expect(a11yFindings('team-bookings', scan.violations, []).findings).toEqual([])
      }
      await inspect()
      const filters = page.locator('.team-bookings-filters')
      const filterToggle = filters.locator('summary')
      await filterToggle.focus()
      await page.keyboard.press('Enter')
      await expect(filters).toHaveAttribute('open', '')
      await expect(filters.locator('input[type="datetime-local"]')).toHaveCount(4)
      await inspect()
      await filterToggle.focus()
      await page.keyboard.press('Enter')
      await expect(filters).not.toHaveAttribute('open', '')
      await opener.focus()
      await page.keyboard.press('Enter')
      const detail = page.locator('.team-booking-detail')
      await expect(detail).toBeVisible()
      await expect(detail.locator('h2')).toBeFocused()
      await expect(detail.locator('li').filter({ hasText: AUDIT_GUEST_NAME })).toBeVisible()
      await inspect()
      const cancel = detail.getByRole('button', { name: /^(Cancel booking…|取消预约…)$/ })
      await cancel.focus()
      await page.keyboard.press('Enter')
      await expect(detail.locator('form')).toBeVisible()
      await expect(detail.getByRole('textbox')).toBeFocused()
      await inspect()
      await detail.getByRole('button', { name: /^(Keep booking|保留预约)$/ }).focus()
      await page.keyboard.press('Enter')
      await expect(detail.locator('form')).toHaveCount(0)
      await expect(cancel).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(detail).toHaveCount(0)
      await expect(opener).toBeFocused()
      await page.keyboard.press('Enter')
      const close = detail.getByRole('button', { name: /^(Close details|关闭详情)$/ })
      await close.focus()
      await page.keyboard.press('Enter')
      await expect(detail).toHaveCount(0)
      await expect(opener).toBeFocused()
    })
})

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
