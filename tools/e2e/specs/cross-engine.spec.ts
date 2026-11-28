import { openAuditPage } from '../audit-pages.ts'
import {
  LONG_BOOKING_SLUG,
  measureEventTypesTable,
  SHORT_BOOKING_SLUG,
  useLongBookingSlug,
} from '../event-types-table.ts'
import { expect, test } from '../fixtures.ts'

// Table intrinsic sizing differs most between engines: the admin list must keep its title
// column in WebKit and Firefox too, and card mode must keep the link on one clipped line.
test('event-types list beside a long booking link', { tag: '@cross-engine' }, async ({
  page,
  app,
}) => {
  await openAuditPage(page, app, 'event-types')
  const initialWidth = page.viewportSize()?.width ?? 0
  if (initialWidth >= 1024) {
    // A short path that fits its column is shown whole in every engine: measured at 1440,
    // where it has room to spare in each engine's fallback monospace font.
    await page.setViewportSize({ width: 1440, height: 900 })
    const whole = await measureEventTypesTable(page, SHORT_BOOKING_SLUG)
    expect(whole.handleOverflow).toBe(false)
    expect(whole.slugOverflow).toBe(false)
    expect(whole.linkLines).toBe(1)
  }
  await useLongBookingSlug(page, app)
  const widths = initialWidth >= 1024 ? [1280, 1440] : [initialWidth]
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    const geometry = await measureEventTypesTable(page, LONG_BOOKING_SLUG)
    expect(geometry.linkLines).toBe(1)
    expect(geometry.linkOverflow).toBe(true)
    expect(geometry.linkEllipsis).toBe('ellipsis')
    expect(geometry.slugStartVisible).toBe(true)
    // The clipped handle fills the width the slug leaves, within subpixel rounding.
    expect(geometry.unusedPathWidth).toBeLessThan(1)
    expect(geometry.fullUrlTitle).toBe(true)
    expect(geometry.documentOverflow).toBe(false)
    if (width >= 1024) {
      expect(geometry.tableMode).toBe(true)
      expect(geometry.titleColumnWidth / geometry.tableWidth).toBeGreaterThanOrEqual(0.35)
      expect(geometry.titleLines).toBeLessThanOrEqual(3)
      expect(geometry.handleOverflow).toBe(true)
      expect(geometry.copyBeside).toBe(true)
    } else expect(geometry.tableMode).toBe(false)
  }
})
