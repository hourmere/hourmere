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
  await expect(page.getByRole('button', { name: '语言：简体中文' })).toBeVisible()
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

test('coarse-pointer calendars keep 44px day targets without striking unavailable dates', async ({
  page,
  app,
}) => {
  test.skip(!(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)), 'Touch only')
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(app.url + app.personalPath)
    await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')
    const days = await page.locator('.calendar-grid .day').evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect()
        const style = getComputedStyle(button)
        return {
          width: box.width,
          height: box.height,
          unavailable: button.getAttribute('aria-disabled') === 'true',
          opacity: Number(style.opacity),
          decoration: style.textDecorationLine,
        }
      }),
    )
    expect(days.length).toBeGreaterThanOrEqual(28)
    // Seven 44px columns need a 308px track, which 390px phones provide. Narrower phones
    // share the track across the columns instead of overflowing the card (WCAG 2.5.8: 24px).
    const minimumWidth = width >= 390 ? 44 : 24
    expect(
      days.every((day) => day.width >= minimumWidth && day.height >= 44),
      `${width}px targets`,
    ).toBe(true)
    const edges = await page.evaluate(() => {
      const content = document.querySelector('.booking-main') as HTMLElement
      const calendar = document.querySelector('.picker-calendar') as HTMLElement
      const body = document.querySelector('.picker-body') as HTMLElement
      const box = content.getBoundingClientRect()
      const style = getComputedStyle(content)
      const grid = calendar.getBoundingClientRect()
      return {
        contentLeft:
          box.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft),
        contentRight:
          box.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight),
        calendarLeft: grid.left,
        calendarRight: grid.right,
        clipped: body.scrollWidth > body.clientWidth + 1,
      }
    })
    expect(edges.calendarLeft, `${width}px calendar inside the card`).toBeGreaterThanOrEqual(
      edges.contentLeft - 0.5,
    )
    expect(edges.calendarRight, `${width}px calendar inside the card`).toBeLessThanOrEqual(
      edges.contentRight + 0.5,
    )
    expect(edges.clipped, `${width}px picker body overflow`).toBe(false)
    const unavailable = days.filter((day) => day.unavailable)
    expect(unavailable.length).toBeGreaterThan(0)
    expect(unavailable.every((day) => day.opacity < 1 && day.decoration === 'none')).toBe(true)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      `${width}px page fits`,
    ).toBe(true)
  }
})
