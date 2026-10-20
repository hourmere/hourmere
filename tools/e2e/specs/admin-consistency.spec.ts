import { openAuditPage } from '../audit-pages.ts'
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

  test(`long booking links retain one line and ellipsis with touch ${locale}`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await openAuditPage(page, app, 'event-types', { locale })
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
    const geometry = await link.evaluate((node) => {
      const style = getComputedStyle(node)
      const range = document.createRange()
      range.selectNode(node.firstChild as Node)
      return {
        overflow: node.scrollWidth > node.clientWidth,
        ellipsis: style.textOverflow,
        display: style.display,
        lineCount: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
      }
    })
    expect(geometry.overflow).toBe(true)
    expect(geometry.ellipsis).toBe('ellipsis')
    expect(geometry.display).toBe('block')
    expect(geometry.lineCount).toBe(1)
  })
}
