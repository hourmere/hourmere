import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

test('booking activity charts real personal actions and enforces current team permissions', async ({
  page,
  app,
}, testInfo) => {
  const slots = page.waitForResponse(
    (response) => response.url().includes('/slots') && response.status() === 200,
  )
  await page.goto(app.url + app.personalPath)
  await slots
  await pickSlot(page, page)
  await fillInvitee(page)
  const creating = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: 'Confirm booking' }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  const original = await creating
  const idempotencyKey = original.headers()['idempotency-key']
  expect(Boolean(idempotencyKey)).toBe(true)
  const replay = await page.request.post(original.url(), {
    headers: { 'idempotency-key': idempotencyKey ?? '' },
    data: original.postDataJSON(),
  })
  expect(replay.status()).toBe(200)
  expect((await replay.json()).manageToken === null).toBe(true)
  expect(await app.rows()).toHaveLength(1)
  await app.authorizeHost()
  const mobile = testInfo.project.name === 'mobile'
  if (mobile) await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(`${app.url}/app/analytics`)
  const chartHeading = page.getByRole('heading', { name: 'Booking actions over time' })
  const plots = page.locator('.analytics-chart svg')
  const table = page.getByRole('table', { name: 'Daily booking activity' })
  await expect(chartHeading).toBeVisible()
  await expect(plots).toHaveCount(3)
  await expect(table).toBeVisible()
  await expect(page.locator('dl.metric-cards dd').first()).toHaveText('1')
  if (mobile) {
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(320)
    const bounds = await plots.evaluateAll((elements) =>
      elements.map((element) => {
        const { left, right, width, height } = element.getBoundingClientRect()
        return { left, right, width, height }
      }),
    )
    expect(bounds).toHaveLength(3)
    for (const { left, right, width, height } of bounds) {
      expect(left).toBeGreaterThanOrEqual(0)
      expect(right).toBeLessThanOrEqual(320)
      expect(width).toBeGreaterThan(0)
      expect(height).toBeGreaterThan(0)
    }
  }
  const today = Temporal.Now.plainDateISO('UTC').toString()
  const todayLabel = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${today}T00:00:00Z`))
  await page.getByLabel('Start date').fill(today)
  await page.getByLabel('End date').fill(today)
  await page.getByRole('button', { name: 'Update report' }).click()
  await expect(table.getByRole('rowheader')).toHaveCount(1)
  await expect(table.getByRole('rowheader', { name: todayLabel, exact: true })).toBeVisible()
  await expect(table.getByRole('cell')).toHaveText(['1', '0', '0', '0'])
  await expect(page.locator('dl.metric-cards dd').first()).toHaveText('1')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await app.authorizeHost('member')
  await page.reload()
  await expect(page.getByText(/Your current team role does not permit this report/)).toBeVisible()
  await expect(table).toHaveCount(0)
  await expect(chartHeading).toHaveCount(0)
  await expect(plots).toHaveCount(0)
  await app.authorizeHost('owner')
  await page.reload()
  await expect(page.getByText('No booking activity was recorded in this range.')).toBeVisible()
  await expect(page.locator('dl.metric-cards dd').first()).toHaveText('0')
  await expect(plots).toHaveCount(0)
})
