import { zoned } from '../../../apps/web/src/format.ts'
import { openAuditPage, settleAuditLayout } from '../audit-pages.ts'
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
    const timeZone = 'America/New_York'
    const format = zoned(timeZone, locale)
    // Cover every weekday/month shape and two-digit days, including overnight ranges.
    // Use the product formatter against fixed synthetic instants, independent of run time.
    const samples = Array.from({ length: 366 }, (_, index) =>
      [
        { hour: 10, minute: 0, duration: 30 },
        { hour: 23, minute: 30, duration: 45 },
      ].map(({ hour, minute, duration }) => {
        const from = Temporal.PlainDate.from('2032-01-01')
          .add({ days: index })
          .toZonedDateTime({ timeZone, plainTime: { hour, minute } })
        const start = from.toInstant().toString()
        const end = from.add({ minutes: duration }).toInstant().toString()
        return [format.date(start), format.timeRange(start, end)]
      }),
    ).flat()
    // Include the exclusive 440px container boundary and the widest card mode too.
    for (const width of [320, 360, 375, 390, 414, 471, 472, 911]) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate(settleAuditLayout)
      const stacked = width < 472
      const geometry = await when.evaluate(
        (cell, { samples, stacked }) => {
          const value = cell.querySelector('.table-value') as HTMLElement
          const pieces = [...cell.querySelectorAll('time > .nowrap')] as HTMLElement[]
          const originals = pieces.map((piece) => piece.textContent)
          let maxTextWidth = 0
          const measure = () => {
            const valueBox = value.getBoundingClientRect()
            const boxes = pieces.map((piece) => {
              const range = document.createRange()
              range.selectNodeContents(piece)
              const text = range.getBoundingClientRect()
              maxTextWidth = Math.max(maxTextWidth, text.width)
              return { text, lines: range.getClientRects().length }
            })
            return {
              fits:
                boxes.every(
                  // Inline ranges can round a fraction of a CSS pixel past the line box.
                  ({ text }) =>
                    text.left >= valueBox.left - 0.5 && text.right <= valueBox.right + 0.5,
                ) &&
                cell.scrollWidth <= cell.clientWidth &&
                value.scrollWidth <= value.clientWidth,
              whole: boxes.every(({ lines }) => lines === 1),
              separate: !stacked || (boxes[1]?.text.top ?? 0) >= (boxes[0]?.text.bottom ?? 0),
              documentFits:
                document.documentElement.scrollWidth <= document.documentElement.clientWidth,
              widths: [cell.scrollWidth, cell.clientWidth, value.scrollWidth, value.clientWidth],
              pieceEdges: boxes.map(({ text, lines }) => [text.left, text.right, lines]),
              valueEdges: [valueBox.left, valueBox.right],
            }
          }
          let firstFailure: ReturnType<typeof measure> | undefined
          const allFit = () =>
            samples
              .map((sample) => {
                pieces.forEach((piece, index) => {
                  piece.textContent = sample[index] ?? ''
                })
                const result = measure()
                if (!result.fits || !result.whole || !result.separate || !result.documentFits)
                  firstFailure ??= result
                return result.fits && result.whole && result.separate && result.documentFits
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
            firstFailure,
            fallbackFits,
            maxTextWidth,
            width: value.getBoundingClientRect().width,
            documentFits:
              document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            fieldsStacked: [
              ...(cell.closest('tr')?.querySelectorAll('td[data-label]') ?? []),
            ].every((field) => getComputedStyle(field).gridTemplateColumns.split(' ').length === 1),
          }
        },
        { samples, stacked },
      )
      expect(
        geometry.maxTextWidth + (stacked ? 8 : 0),
        'Widest date/time piece retains room for platform font variation',
      ).toBeLessThanOrEqual(geometry.width)
      expect(geometry.firstFailure, `${width}px every sample fits`).toBeUndefined()
      expect(
        geometry,
        `${width}px fixed dates and overnight ranges fit with loaded fonts`,
      ).toMatchObject({
        loadedFits: true,
      })
      expect(
        geometry.fallbackFits,
        'Every fixed date and overnight range fits with fallback fonts',
      ).toBe(true)
      expect(geometry.documentFits, `The ${width}px document fits`).toBe(true)
      expect(geometry.width, 'The date/time value uses the full card width').toBeGreaterThan(240)
      expect(geometry.fieldsStacked, `${width}px booking labels use a consistent layout`).toBe(
        stacked,
      )
      const seededCellsFit = await page
        .locator('.booking-when')
        .evaluateAll((cells) =>
          cells.every((cell) =>
            [cell, ...cell.querySelectorAll('*')].every(
              (element) => element.clientWidth === 0 || element.scrollWidth <= element.clientWidth,
            ),
          ),
        )
      expect(seededCellsFit, `${width}px seeded same-day and overnight When cells fit`).toBe(true)
    }

    for (const width of [912, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(settleAuditLayout)
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
    }
  })
}
