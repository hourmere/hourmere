import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

test('booking activity reports real personal actions and enforces current team permissions', async ({
  page,
  app,
}) => {
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
  expect((await replay.json()).manageToken).toBeNull()
  expect(await app.rows()).toHaveLength(1)
  await app.authorizeHost()
  await page.goto(`${app.url}/app/analytics`)
  await expect(page.getByRole('table', { name: 'Daily booking activity' })).toBeVisible()
  await expect(page.locator('dl.details dd').first()).toHaveText('1')
  const today = Temporal.Now.plainDateISO('UTC').toString()
  await page.getByLabel('Start date').fill(today)
  await page.getByLabel('End date').fill(today)
  await page.getByRole('button', { name: 'Update report' }).click()
  await expect(page.getByRole('rowheader', { name: today, exact: true })).toHaveCount(1)
  await expect(page.locator('dl.details dd').first()).toHaveText('1')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await app.authorizeHost('member')
  await page.reload()
  await expect(page.getByText(/Your current team role does not permit this report/)).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await app.authorizeHost('owner')
  await page.reload()
  await expect(page.getByText('No booking activity was recorded in this range.')).toBeVisible()
  await expect(page.locator('dl.details dd').first()).toHaveText('0')
})
