import { expect, test } from '../fixtures.ts'

test('Chinese double quotes use full-width CJK glyphs without widening Latin apostrophes', async ({
  page,
  app,
}) => {
  await app.authorizeHost()
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'zh-CN'))
  await page.goto(`${app.url}/app/event-types/new`)
  const title = 'O’Brien / Ada’s plan'
  await page.getByLabel('标题', { exact: true }).fill(title)
  await page.getByRole('button', { name: '创建活动类型', exact: true }).click()
  await expect(page.getByRole('heading', { name: `编辑“${title}”`, exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toMatch(/^\/app\/event-types\/[0-9a-f-]+$/)
  await expect(page.getByRole('region', { name: '保存后的配置检查', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '返回活动类型', exact: true }).click()
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible()
  await page.getByRole('link', { name: title, exact: true }).click()
  await page.getByRole('button', { name: '删除活动类型', exact: true }).click()
  const prompt = page.getByRole('group', { name: `删除“${title}”？此操作无法撤销。` })
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('.cjk-quote')).toHaveText(['“', '”'])
  const quotes = await prompt.locator('.cjk-quote').evaluateAll((spans) =>
    spans.map((span) => {
      const styles = getComputedStyle(span)
      return {
        widthInEm: span.getBoundingClientRect().width / Number.parseFloat(styles.fontSize),
        firstFont: styles.fontFamily.split(',')[0]?.trim().replaceAll('"', ''),
      }
    }),
  )
  for (const quote of quotes) {
    expect(quote.firstFont).toBe('PingFang SC')
    // macOS's SF font has curly quote glyphs but no fwid support. Linux runners need
    // separately installed CJK fonts before their glyph advances are comparable.
    if (process.platform === 'darwin') {
      expect(quote.widthInEm).toBeGreaterThanOrEqual(0.95)
      expect(quote.widthInEm).toBeLessThanOrEqual(1.05)
    }
  }
})

test('Chinese Analytics dates stay whole at 320px', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await app.authorizeHost()
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'zh-CN'))
  await page.goto(`${app.url}/app/analytics`)
  await expect(page.getByRole('table', { name: '每日预约统计' })).toBeVisible()
  await page.getByLabel('开始日期', { exact: true }).fill('2026-09-21')
  await page.getByLabel('结束日期', { exact: true }).fill('2026-10-20')
  await page.getByRole('button', { name: '更新统计', exact: true }).click()
  const heading = page.getByRole('heading', { name: '2026-09-21 至 2026-10-20' })
  await expect(heading).toBeVisible()
  expect(await heading.evaluate((element) => getComputedStyle(element).textWrap)).toBe('balance')
  const dates = await heading.locator('.nowrap').evaluateAll((spans) =>
    spans.map((span) => {
      const range = document.createRange()
      range.selectNodeContents(span)
      return { date: span.textContent, lines: range.getClientRects().length }
    }),
  )
  expect(dates).toEqual([
    { date: '2026-09-21', lines: 1 },
    { date: '2026-10-20', lines: 1 },
  ])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})

test('Chinese calendar day 20 stays on one line at 320px', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  const today = new Date()
  today.setUTCMonth(today.getUTCMonth() + 1, 20)
  today.setUTCHours(9, 0, 0, 0)
  await page.clock.setFixedTime(today)
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'zh-CN'))
  await page.goto(app.url + app.personalPath)
  const day = page.locator('.calendar-grid [aria-current="date"]')
  await expect(day).toHaveText('20日')
  await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')
  const measured = await day.evaluate((button) => {
    const range = document.createRange()
    range.selectNodeContents(button)
    const text = range.getBoundingClientRect()
    const box = button.getBoundingClientRect()
    return {
      lines: range.getClientRects().length,
      textFits: text.left >= box.left && text.right <= box.right,
    }
  })
  expect(measured).toEqual({ lines: 1, textFits: true })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})
