import { pickSlot } from '../fixtures.ts'
import { expect, test } from '../invitation-signup-fixtures.ts'

test.use({ signupMode: 'open' })

test('a new account confirms a magic link and completes personal setup', {
  tag: '@cross-engine',
}, async ({ page, context, invitationSignupApp: app }) => {
  await page.goto(`${app.url}/app/event-types`)
  await expect(page.getByRole('heading', { name: 'Sign in to Hourmere' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('next')).toBe('/app/event-types')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.recipientEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect.poll(() => Boolean(app.mailLink('sign-in', app.recipientEmail))).toBe(true)
  const link = app.mailLink('sign-in', app.recipientEmail)
  if (!link) throw new Error('The loopback mailbox did not receive a sign-in link')
  try {
    await page.goto(link)
  } catch {
    throw new Error('The browser could not open the fixture sign-in link')
  }
  expect(await app.state()).toMatchObject({ accountExists: false, signedIn: false })
  try {
    await page.getByRole('button', { name: 'Sign in to Hourmere', exact: true }).click()
  } catch {
    throw new Error('The browser could not confirm the fixture sign-in link')
  }
  await expect.poll(() => new URL(page.url()).pathname).toBe('/app/event-types')
  expect(await app.state()).toMatchObject({ accountExists: true, signedIn: true, memberships: 0 })

  const setup = page.getByRole('region', { name: 'Set up your booking page' })
  const currentStep = setup.locator('[aria-current="step"]')
  await expect(currentStep.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
  await setup.getByRole('link', { name: 'Complete your profile' }).click()
  await page.getByLabel('Display name', { exact: true }).fill('New Fixture Host')
  await page.getByRole('button', { name: 'Save display name' }).click()
  await expect(page.getByText('Display name saved.', { exact: true })).toBeVisible()
  await page.getByLabel('Handle', { exact: true }).fill('new-fixture-host')
  await page.getByRole('button', { name: 'Create profile' }).click()
  await expect(page.getByText('Profile created. Your booking links are ready.')).toBeVisible()

  await page.goto(`${app.url}/app/event-types`)
  await expect(currentStep.getByRole('heading', { name: 'Default availability' })).toBeVisible()
  await setup.getByRole('button', { name: 'Use Monday–Friday, 09:00–17:00' }).click()
  await expect(currentStep.getByRole('heading', { name: 'First event type' })).toBeVisible()
  await setup.getByRole('link', { name: 'Create your first event type' }).click()
  await page.getByLabel('Title', { exact: true }).fill('First fixture meeting')
  await page.getByLabel('Booking link', { exact: true }).fill('first-meeting')
  await page.getByRole('button', { name: 'Create event type' }).click()
  await expect(page.getByRole('heading', { name: 'Edit “First fixture meeting”' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to event types' }).click()

  const complete = page.getByRole('region', { name: 'Your booking page is ready' })
  const linkToBooking = complete.getByRole('link', { name: /^View booking page/ })
  const [booking] = await Promise.all([context.waitForEvent('page'), linkToBooking.click()])
  await expect(booking).toHaveURL(`${app.url}/new-fixture-host/first-meeting`)
  await expect(booking.getByRole('heading', { name: 'First fixture meeting' })).toBeVisible()
  await pickSlot(booking, booking)
  await expect(booking.getByRole('button', { name: 'Confirm booking' })).toBeVisible()
})
