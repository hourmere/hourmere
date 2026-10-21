import { AUDIT_BOOKING_START, AUDIT_NOW } from '../audit-data.ts'
import { openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

test.use({
  uiAudit: true,
  viewport: { width: 320, height: 568 },
  isMobile: true,
  hasTouch: true,
})

// The matrix creates a confirmation booking before visiting the host's list.
// Ambient times on either side of a one/two-digit hour must yield the same rows.
for (const ambient of ['2030-01-07T08:59:00.000Z', '2030-01-07T09:59:00.000Z'])
  test(`audit booking rows ignore ambient clock ${ambient}`, async ({ page, app }) => {
    await page.clock.setFixedTime(new Date(ambient))
    await openAuditPage(page, app, 'booking-confirmation')
    await openAuditPage(page, app, 'bookings')
    const starts = await page
      .locator('.table-bookings tbody time')
      .evaluateAll((times) => times.map((time) => time.getAttribute('datetime')))
    expect(starts).toEqual([AUDIT_NOW, AUDIT_BOOKING_START])

    const geometry = () =>
      page.locator('.table-bookings tbody .table-value').evaluateAll((values) => ({
        fonts: document.fonts.status,
        values: values.map((value) => {
          const rect = value.getBoundingClientRect()
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            clientWidth: value.clientWidth,
            scrollWidth: value.scrollWidth,
          }
        }),
      }))
    const measured = await geometry()
    expect(measured.fonts).toBe('loaded')
    expect(measured.values.length).toBeGreaterThan(0)
    expect(measured.values.every((value) => value.scrollWidth <= value.clientWidth + 1)).toBe(true)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)
    expect(await geometry()).toEqual(measured)
  })
