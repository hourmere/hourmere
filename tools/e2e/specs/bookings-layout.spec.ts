import { zoned } from '../../../apps/web/src/format.ts'
import { openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

test.use({ uiAudit: true })

for (const locale of ['en-US', 'zh-CN', 'en-GB'] as const) {
  test(`booking date/time pieces fit narrow cards and preserve table geometry ${locale}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await openAuditPage(page, app, 'bookings', { locale })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const when = page.locator('.table-bookings tbody tr').first().locator('td').first()
    const pieces = when.locator('time > .nowrap')
    await expect(pieces).toHaveCount(2)
    const format = zoned('UTC', locale)
    // Cover every weekday/month shape and two-digit days, including overnight ranges.
    // Use the product formatter against fixed synthetic instants, independent of run time.
    const samples = Array.from({ length: 366 }, (_, index) =>
      [
        { hour: 10, minute: 0, duration: 30 },
        { hour: 23, minute: 30, duration: 45 },
      ].map(({ hour, minute, duration }) => {
        const start = new Date(Date.UTC(2032, 0, index + 1, hour, minute)).toISOString()
        const end = new Date(new Date(start).getTime() + duration * 60_000).toISOString()
        return [format.date(start), format.timeRange(start, end)]
      }),
    ).flat()
    const geometry = await when.evaluate((cell, samples) => {
      const value = cell.querySelector('.table-value') as HTMLElement
      const pieces = [...cell.querySelectorAll('time > .nowrap')] as HTMLElement[]
      const originals = pieces.map((piece) => piece.textContent)
      const measure = () => {
        const valueBox = value.getBoundingClientRect()
        const boxes = pieces.map((piece) => {
          const range = document.createRange()
          range.selectNodeContents(piece)
          return { text: range.getBoundingClientRect(), lines: range.getClientRects().length }
        })
        return {
          fits: boxes.every(
            ({ text }) => text.left >= valueBox.left && text.right <= valueBox.right,
          ),
          whole: boxes.every(({ lines }) => lines === 1),
          separate: (boxes[1]?.text.top ?? 0) >= (boxes[0]?.text.bottom ?? 0),
        }
      }
      const allFit = () =>
        samples
          .map((sample) => {
            pieces.forEach((piece, index) => {
              piece.textContent = sample[index] ?? ''
            })
            const result = measure()
            return result.fits && result.whole && result.separate
          })
          .every(Boolean)
      const loadedFits = allFit()
      // A user with unavailable web fonts must still see complete date/time pieces.
      value.style.fontFamily = 'Arial, sans-serif'
      const fallbackFits = allFit()
      value.style.removeProperty('font-family')
      pieces.forEach((piece, index) => {
        piece.textContent = originals[index] ?? ''
      })
      return {
        loadedFits,
        fallbackFits,
        width: value.getBoundingClientRect().width,
        documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }
    }, samples)
    expect(geometry, 'Every fixed date and overnight range fits with loaded fonts').toMatchObject({
      loadedFits: true,
    })
    expect(
      geometry.fallbackFits,
      'Every fixed date and overnight range fits with fallback fonts',
    ).toBe(true)
    expect(geometry.documentFits, 'The 320px document fits').toBe(true)
    expect(geometry.width, 'The date/time value uses the full card width').toBeGreaterThan(240)

    await page.setViewportSize({ width: 1280, height: 900 })
    const table = await when.evaluate((cell) => {
      const header = cell.closest('table')?.querySelector('thead')
      return {
        headerVisible: header && getComputedStyle(header).position !== 'absolute',
        cellDisplay: getComputedStyle(cell).display,
        piecesInline: [...cell.querySelectorAll('time > .nowrap')].every(
          (piece) => getComputedStyle(piece).display === 'inline',
        ),
        labelShown: getComputedStyle(cell, '::before').content !== 'none',
      }
    })
    expect(table.headerVisible, 'Desktop headers remain in table flow').toBe(true)
    expect(table.cellDisplay, 'Desktop When cell retains table geometry').toBe('table-cell')
    expect(table.piecesInline, 'Desktop date/time pieces retain inline wrapping').toBe(true)
    expect(table.labelShown, 'Desktop does not repeat the card label').toBe(false)
  })
}
