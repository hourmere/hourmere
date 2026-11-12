import { expect, fillInvitee, test, waitUntilAtRest } from '../fixtures.ts'

test('a weekly limit saved in the editor closes the rest of that week on the public page', async ({
  page,
  app,
}) => {
  await app.auditSignIn(true)
  await page.goto(`${app.url}/app/event-types`)
  await page.getByRole('link', { name: 'Edit Fixture call', exact: true }).click()
  await page.getByLabel(/^Weekly limit/).fill('1')
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && response.url().includes('/api/v1/event-types/'),
  )
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const saved = await saving
  expect(saved.status()).toBe(200)
  expect(saved.request().postDataJSON().maxBookingsPerWeek).toBe(1)
  expect((await saved.json()).maxBookingsPerWeek).toBe(1)
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel(/^Weekly limit/)).toHaveValue('1')
  await app.auditSignIn(false)

  // Keep this complete week and the following Monday in one visible month, safely
  // beyond minimum notice. Only the browser clock changes; the server/DB stay real.
  const month = Temporal.Now.plainDateISO('UTC').with({ day: 1 }).add({ months: 1 })
  const eighth = month.with({ day: 8 })
  const monday = eighth.add({ days: (8 - eighth.dayOfWeek) % 7 })
  const nextMonday = monday.add({ days: 7 })
  await page.clock.setFixedTime(new Date(`${month.toString()}T00:00:00Z`))
  await page.goto(app.url + app.personalPath)
  await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')
  for (let offset = 0; offset < 5; offset++) {
    await expect(page.locator(`[data-day="${monday.add({ days: offset })}"]`)).toHaveAttribute(
      'aria-disabled',
      'false',
    )
  }
  await page.locator(`[data-day="${monday}"]`).click()
  const slot = page.locator('.slots button').first()
  await waitUntilAtRest(slot, page)
  await slot.click()
  await fillInvitee(page)
  const creating = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  const created = await creating
  expect(created.status()).toBe(201)
  const result = (await created.json()) as { booking: { start: string } }
  expect(result.booking.start.slice(0, 10)).toBe(monday.toString())
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()

  await page.goto(app.url + app.personalPath)
  await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')
  for (let offset = 0; offset < 7; offset++) {
    await expect(page.locator(`[data-day="${monday.add({ days: offset })}"]`)).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  }
  await expect(page.locator(`[data-day="${nextMonday}"]`)).toHaveAttribute('aria-disabled', 'false')
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
})
