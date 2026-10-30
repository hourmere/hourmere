import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

test('a team owner creates a collective type and a public invitee books every required host', async ({
  page,
  app,
}) => {
  await app.authorizeHost('owner')
  await page.goto(`${app.url}/app/event-types/new`)
  await page.getByLabel('Title', { exact: true }).fill('Panel interview')
  await page.getByLabel('Scheduling', { exact: true }).selectOption('collective')
  await page.getByLabel('Second Required Host', { exact: true }).check()
  await page.getByRole('button', { name: 'Create event type', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Edit “Panel interview”', exact: true }),
  ).toBeVisible()
  expect(new URL(page.url()).pathname).toMatch(/^\/app\/event-types\/[0-9a-f-]+$/)
  await expect(
    page.getByRole('region', { name: 'Saved version readiness', exact: true }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Back to event types', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Event types', exact: true })).toBeVisible()
  await page.goto(`${app.url}/team/FixtureTeam/panel-interview`)
  await expect(page.getByRole('heading', { name: 'Panel interview', exact: true })).toBeVisible()
  await pickSlot(page, page)
  await fillInvitee(page)
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  expect(await app.hostCounts()).toEqual([2])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})

test('a collective popup embeds the shared slots and records both hosts with source embed', async ({
  page,
  app,
}) => {
  await page.goto(`${app.parentUrl}/collective`)
  await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
  const frame = page.getByRole('dialog').locator('iframe').contentFrame()
  await expect(
    frame.getByRole('heading', { name: 'Collective fixture call', exact: true }),
  ).toBeVisible()
  // The iframe scope keeps private booking capabilities inside the application frame.
  for (let month = 0; month < 4; month++) {
    await expect(frame.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
    const days = frame.locator('button.day-available')
    if (await days.count()) {
      await days.last().click()
      await frame.locator('.slots button').first().click()
      break
    }
    await frame.getByRole('button', { name: 'Next month' }).click()
  }
  await frame.getByLabel('Your name', { exact: true }).fill('Fixture Invitee')
  await frame.getByLabel('Email', { exact: true }).fill('fixture-invitee@hourmere.invalid')
  await frame.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  await expect(frame.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
  expect(await app.hostCounts()).toEqual([2])
  const messages = await page.evaluate(
    () => (window as unknown as { fixtureMessages: unknown[] }).fixtureMessages,
  )
  expect(messages.every((message) => !JSON.stringify(message).includes('token'))).toBe(true)
})
