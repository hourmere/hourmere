import type { Page } from '@playwright/test'
import { expect, type FixtureApp, fillInvitee, pickSlot, test } from '../fixtures.ts'
import { CHECKOUT_FIXTURE_ORIGIN } from '../stripe-fixture.ts'

test.use({ paidStripe: true })

async function openCheckout(page: Page, app: FixtureApp) {
  const stripe = app.stripe
  if (!stripe) throw new Error('Missing local Stripe fixture')
  await page.route(`${CHECKOUT_FIXTURE_ORIGIN}/**`, async (route) => {
    const success = stripe.returnUrl(false)
    const cancel = stripe.returnUrl(true)
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Checkout fixture</title><h1>Checkout fixture</h1>
        <a href="${success}">Return after payment</a>
        <a href="${cancel}">Return without paying</a>`,
    })
  })
  await page.goto(app.url + app.personalPath)
  await pickSlot(page, page)
  await fillInvitee(page)
  await expect(page.getByText('Price: USD 42.42', { exact: true })).toBeVisible()
  const creation = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/call/checkout'),
  )
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click()
  const response = await creation
  expect(response.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'Checkout fixture' })).toBeVisible()
  expect(stripe.checkoutSummary()).toEqual({
    amountMinor: 4242,
    currency: 'usd',
    creates: 1,
    refunds: 0,
  })
  return { stripe, request: response.request() }
}

test('a hosted payment confirms once, keeps its price when moved and refunds on cancellation', async ({
  page,
  app,
}) => {
  const { stripe, request } = await openCheckout(page, app)
  const replay = await page.request.post(request.url(), {
    headers: { 'Idempotency-Key': (await request.headerValue('idempotency-key')) ?? '' },
    data: request.postDataJSON(),
  })
  expect(replay.ok()).toBe(true)
  expect(stripe.checkoutSummary().creates).toBe(1)
  expect(await app.rows()).toEqual([{ source: 'web', status: 'pending_payment' }])

  const tampered = new URL(stripe.returnUrl(false))
  tampered.searchParams.set('session_id', 'cs_test_unrelated')
  await page.goto(tampered.href)
  await expect(
    page.getByRole('heading', { name: 'We couldn’t find this payment attempt' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage booking' })).toHaveCount(0)

  await page.goto(stripe.returnUrl(false))
  await expect(
    page.getByRole('heading', { name: 'Waiting for payment confirmation' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage booking' })).toHaveCount(0)
  await expect(page.locator('a[href*="video.example.test"]')).toHaveCount(0)
  expect(await stripe.complete()).toBe(200)
  expect(await stripe.complete()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible()
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])

  await page.getByRole('link', { name: 'Manage booking', exact: true }).click()
  await expect(page.getByText('Paid USD 42.42', { exact: true })).toBeVisible()
  await expect(page.locator('a[href*="video.example.test"]')).toBeVisible()
  await expect(page.locator('a[href*="dashboard.stripe.com"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reschedule', exact: true }).click()
  await pickSlot(page, page)
  const moved = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/bookings/manage/reschedule'),
  )
  await page.getByRole('button', { name: 'Confirm new time', exact: true }).click()
  const { booking } = (await (await moved).json()) as { booking: { id: string } }
  await expect(
    page.getByText('Your booking is moved to the new time.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Paid USD 42.42', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cancel this booking?' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(page.getByText('Refund requested', { exact: true })).toBeVisible()
  await stripe.runRefunds()
  expect(stripe.checkoutSummary()).toEqual({
    amountMinor: 4242,
    currency: 'usd',
    creates: 1,
    refunds: 1,
  })
  await app.authorizeHost()
  await page.goto(`${app.url}/app/bookings/${booking.id}`)
  await expect(page.getByText('Refund issued', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open payment in Stripe' })).toHaveAttribute(
    'href',
    /^https:\/\/dashboard\.stripe\.com\/acct_[a-zA-Z0-9]+\/test\/payments\/pi_[a-zA-Z0-9]+$/,
  )
})

test('a charge after release produces a refund without exposing booking details', async ({
  page,
  app,
}) => {
  const { stripe } = await openCheckout(page, app)
  await page.getByRole('link', { name: 'Return without paying' }).click()
  await page.getByRole('button', { name: 'Release unpaid reservation' }).click()
  await expect(page.getByRole('heading', { name: 'Reservation cancelled' })).toBeVisible()
  expect(await stripe.complete()).toBe(200)
  await stripe.runRefunds()
  await page.reload()
  await expect(
    page.getByText('Payment arrived after the reservation ended. Your booking was not confirmed.'),
  ).toBeVisible()
  await expect(
    page.getByText('Stripe has sent your refund. Your bank may take time to post it.'),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage booking' })).toHaveCount(0)
  await expect(page.locator('a[href*="video.example.test"]')).toHaveCount(0)
  expect(stripe.checkoutSummary().refunds).toBe(1)
  expect(await app.rows()).toEqual([{ source: 'web', status: 'cancelled' }])
})
