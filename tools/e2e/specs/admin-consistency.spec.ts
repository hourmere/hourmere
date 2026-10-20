import { openAuditPage } from '../audit-pages.ts'
import {
  LONG_BOOKING_SLUG,
  measureEventTypesTable,
  setLongBookingSlug,
  useLongBookingSlug,
} from '../event-types-table.ts'
import { expect, test } from '../fixtures.ts'

test.use({ uiAudit: true })

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`analytics dates fit narrow screens and align when paired ${locale}`, async ({
    page,
    app,
  }) => {
    await openAuditPage(page, app, 'analytics', { locale })
    for (const width of [320, 360, 520]) {
      await page.setViewportSize({ width, height: 844 })
      const geometry = await page.locator('.analytics-date-range').evaluate((pair) => {
        const [start, end] = [...pair.querySelectorAll('input')].map((input) =>
          input.getBoundingClientRect(),
        )
        if (!start || !end) throw new Error('Date pair missing')
        return {
          startWidth: start.width,
          endWidth: end.width,
          stacked: end.top >= start.bottom,
          aligned: Math.abs(start.bottom - end.bottom) < 1,
        }
      })
      expect(geometry.startWidth).toBeGreaterThanOrEqual(180)
      expect(geometry.endWidth).toBeGreaterThanOrEqual(180)
      expect(width < 520 ? geometry.stacked : geometry.aligned).toBe(true)
    }
  })

  test(`edited save bar stays compact and clears keyboard focus ${locale}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await openAuditPage(page, app, 'event-type-editor', { locale })
    const title = page.locator('#title')
    await title.fill(`${await title.inputValue()} edited`)
    const bar = page.locator('.sticky-form-actions')
    await expect(bar).toHaveAttribute('data-sticky', 'true')
    expect(await bar.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(
      568 * 0.25,
    )
    await expect(bar.locator('a')).toHaveCount(0)
    const description = page.locator('#description')
    await page.locator('#slug').focus()
    await page.locator('#slug').press('Tab')
    await expect(description).toBeFocused()
    const isClear = () =>
      description.evaluate((field) => {
        const bar = document.querySelector('.sticky-form-actions')?.getBoundingClientRect()
        const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
        const rect = field.getBoundingClientRect()
        return Boolean(bar && topbar && rect.bottom < bar.top && rect.top > topbar.bottom)
      })
    await expect.poll(isClear).toBe(true)
    await description.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(description).toBeFocused()
    await expect.poll(isClear).toBe(true)
    // Simulate enlarged text / a wrapped status exceeding the same measured budget.
    await bar.evaluate((node) => {
      node.style.minHeight = '180px'
    })
    await expect(bar).toHaveAttribute('data-sticky', 'false')
    await expect(bar).toHaveCSS('position', 'static')
  })

  test(`desktop event-types table keeps its title column beside a long slug ${locale}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openAuditPage(page, app, 'event-types', { locale })
    await useLongBookingSlug(page, app)
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await measureEventTypesTable(page, LONG_BOOKING_SLUG)
      expect(geometry.tableMode, `${width}px table mode`).toBe(true)
      // The link column follows its percentage width instead of the whole nowrap path.
      expect(
        geometry.titleColumnWidth / geometry.tableWidth,
        `${width}px title share`,
      ).toBeGreaterThanOrEqual(0.35)
      expect(geometry.titleLines, `${width}px title lines`).toBeLessThanOrEqual(3)
      expect(geometry.linkLines, `${width}px link lines`).toBe(1)
      expect(geometry.linkOverflow, `${width}px link clips`).toBe(true)
      expect(geometry.linkEllipsis, `${width}px ellipsis`).toBe('ellipsis')
      expect(geometry.handleOverflow, `${width}px long handle clips`).toBe(true)
      expect(geometry.slugStartVisible, `${width}px slug start visible`).toBe(true)
      expect(geometry.fullUrlTitle, `${width}px full URL title`).toBe(true)
      expect(geometry.copyBeside, `${width}px copy button beside`).toBe(true)
      expect(geometry.documentOverflow, `${width}px document`).toBe(false)
    }
  })

  test(`editor booking-link preview truncates a long slug on narrow screens ${locale}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await setLongBookingSlug(page, app)
    await openAuditPage(page, app, 'event-type-editor', { locale })
    const preview = page.locator('.booking-link .preview').filter({ hasText: LONG_BOOKING_SLUG })
    await expect(preview).toBeVisible()
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 568 })
      const geometry = await preview.evaluate((node) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        return {
          lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
          overflow: node.scrollWidth > node.clientWidth,
          ellipsis: getComputedStyle(node).textOverflow,
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        }
      })
      expect(geometry.lines, `${width}px lines`).toBe(1)
      expect(geometry.overflow, `${width}px clips`).toBe(true)
      expect(geometry.ellipsis, `${width}px ellipsis`).toBe('ellipsis')
      expect(geometry.documentFits, `${width}px document`).toBe(true)
    }
  })

  test(`long booking links retain one line and ellipsis with touch ${locale}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await openAuditPage(page, app, 'event-types', { locale })
    const documentFits = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 568 })
      await expect.poll(documentFits).toBe(true)
    }
    await page.setViewportSize({ width: 320, height: 568 })
    const state = await app.auditState()
    const slug = `long-${'booking-'.repeat(6)}link`
    const response = await page.request.patch(
      `${app.url}/api/v1/event-types/${state.eventTypeId}`,
      {
        headers: { origin: app.url },
        data: { slug },
      },
    )
    expect(response.status()).toBe(200)
    await page.reload()
    const link = page.locator('.booking-link a').filter({ hasText: slug })
    await expect(link).toBeVisible()
    await expect(link.locator('wbr')).toHaveCount(0)
    const geometry = await measureEventTypesTable(page, slug)
    expect(geometry.linkOverflow).toBe(true)
    expect(geometry.linkEllipsis).toBe('ellipsis')
    expect(geometry.linkLines).toBe(1)
    expect(geometry.slugStartVisible).toBe(true)
    expect(geometry.fullUrlTitle).toBe(true)
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 568 })
      await expect.poll(documentFits).toBe(true)
    }
  })
}
