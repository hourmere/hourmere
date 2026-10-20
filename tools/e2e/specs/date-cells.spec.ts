import { expect, test } from '../fixtures.ts'

test('Chinese public calendar days stay on one line and clear the today marker', async ({
  page,
  app,
}) => {
  // Exercise a two-digit current day within the fixture's booking window, independently of
  // the date on which the suite runs. Only the browser's clock changes; the API is real.
  const today = new Date()
  today.setUTCMonth(today.getUTCMonth() + 1, 10)
  today.setUTCHours(9, 0, 0, 0)
  await page.clock.setFixedTime(today)
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'zh-CN'))
  await page.goto(app.url + app.personalPath)
  await expect(page.getByRole('combobox', { name: '界面语言' })).toHaveValue('zh-CN')
  const current = page.locator('.calendar-grid [aria-current="date"]')
  await expect(current).toHaveText('10日')
  await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')

  const days = await page.locator('.calendar-grid .day').evaluateAll((buttons) =>
    buttons.map((button) => {
      const range = document.createRange()
      range.selectNodeContents(button)
      const text = range.getBoundingClientRect()
      const box = button.getBoundingClientRect()
      const marker = getComputedStyle(button, '::after')
      return {
        lines: range.getClientRects().length,
        textFits: text.left >= box.left && text.right <= box.right,
        todayClear:
          button.getAttribute('aria-current') !== 'date' ||
          text.bottom + 1 <=
            box.bottom - Number.parseFloat(marker.bottom) - Number.parseFloat(marker.height),
      }
    }),
  )
  expect(days.length).toBeGreaterThanOrEqual(28)
  expect
    .soft(
      days.every((day) => day.lines === 1),
      'Every day label fits on one line',
    )
    .toBe(true)
  expect
    .soft(
      days.every((day) => day.textFits),
      'Every day label fits within its button',
    )
    .toBe(true)
  expect
    .soft(
      days.every((day) => day.todayClear),
      'The today marker clears the day label',
    )
    .toBe(true)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})
