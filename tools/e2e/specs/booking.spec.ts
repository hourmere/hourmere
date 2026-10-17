import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

for (const kind of ['personal', 'team'] as const)
  test(`anonymous ${kind} booking uses the real API without a session`, async ({ page, app }) => {
    let sessionReads = 0
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/v1/me' || path.startsWith('/api/auth/')) sessionReads++
    })
    const slots = page.waitForResponse(
      (response) => response.url().includes('/slots') && response.status() === 200,
    )
    await page.goto(app.url + (kind === 'team' ? app.teamPath : app.personalPath))
    await slots
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
    await pickSlot(page, page)
    await expect(page.getByRole('button', { name: 'Add a guest' })).toHaveCount(0)
    await fillInvitee(page)
    await page.getByRole('button', { name: 'Confirm booking' }).click()
    await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    expect(sessionReads).toBe(0)
    expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
  })

test('an invitee can reschedule then cancel through a scrubbed manage-token fragment', async ({
  page,
  app,
}) => {
  const managedRequests: { hasHeader: boolean; queryHasToken: boolean; hasReferrer: boolean }[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/v1/bookings/manage')) return
    const headers = request.headers()
    managedRequests.push({
      hasHeader: Boolean(headers['x-manage-token']),
      queryHasToken: [...url.searchParams.keys()].some((key) => /token/i.test(key)),
      hasReferrer: Boolean(headers.referer),
    })
  })
  const slots = page.waitForResponse((r) => r.url().includes('/slots') && r.status() === 200)
  await page.goto(app.url + app.personalPath)
  await slots
  await pickSlot(page, page)
  await fillInvitee(page)
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: 'Confirm booking' }).click()
  const result = (await (await created).json()) as { manageToken: string }
  expect(typeof result.manageToken === 'string').toBe(true)
  await page.goto(`${app.url}/booking`)
  await expect(page.getByRole('heading', { name: 'Open your booking link' })).toBeVisible()
  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString()
  }, result.manageToken)
  await expect.poll(() => page.evaluate(() => window.location.hash === '')).toBe(true)
  const movingSlots = page.waitForResponse((r) => r.url().includes('/slots') && r.status() === 200)
  await page.getByRole('button', { name: 'Reschedule', exact: true }).click()
  await movingSlots
  await pickSlot(page, page)
  await page.getByRole('button', { name: 'Confirm new time', exact: true }).click()
  await expect(
    page.getByText('Your booking is moved to the new time.', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cancel this booking?' })).toBeVisible()
  await page.getByLabel(/Reason/).fill('Fixture cleanup')
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cancelled booking', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([
    { source: 'web', status: 'cancelled' },
    { source: 'web', status: 'cancelled' },
  ])
  expect(managedRequests.length >= 4).toBe(true)
  expect(managedRequests.every((r) => r.hasHeader && !r.queryHasToken && !r.hasReferrer)).toBe(true)
})

test('a stale public form recovers from a real database booking conflict', async ({
  page,
  context,
  app,
}) => {
  const second = await context.newPage()
  for (const current of [page, second]) {
    const slots = current.waitForResponse((r) => r.url().includes('/slots') && r.status() === 200)
    await current.goto(app.url + app.personalPath)
    await slots
    await pickSlot(current, current)
    await fillInvitee(current)
  }
  await page.getByRole('button', { name: 'Confirm booking' }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  const conflict = second.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
  )
  await second.getByRole('button', { name: 'Confirm booking' }).click()
  const response = await conflict
  expect(response.status()).toBe(409)
  expect(((await response.json()) as { error: string }).error).toBe('slot_unavailable')
  await expect(
    second.getByText('That time is no longer available. Please pick another one.', { exact: true }),
  ).toBeVisible()
  expect((await app.rows()).length).toBe(1)
  await expect(second.locator('.calendar-month')).toBeVisible()
  await expect(second.getByRole('button', { name: 'Confirm booking' })).toHaveCount(0)
  await pickSlot(second, second)
  await second.getByRole('button', { name: 'Confirm booking' }).click()
  await expect(second.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([
    { source: 'web', status: 'confirmed' },
    { source: 'web', status: 'confirmed' },
  ])
})

test('popup booking keeps completion data private and supports cross-frame Escape', async ({
  page,
  app,
}) => {
  await page.goto(app.parentUrl)
  const opener = page.getByRole('button', { name: 'Book a meeting', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog'),
    frame = dialog.locator('iframe').contentFrame()
  await expect(frame.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  expect(
    await page.evaluate(() => {
      const bounds = document.querySelector('dialog')?.getBoundingClientRect()
      return Boolean(bounds && bounds.left >= 0 && bounds.right <= innerWidth)
    }),
  ).toBe(true)
  expect(
    await frame
      .locator('body')
      .evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
  await frame.getByRole('button', { name: 'Next month' }).focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await page.evaluate((url) => {
    const state = window as unknown as {
      Hourmere: { openPopup: (options: { url: string }) => unknown }
      retiredCloseCount: number
    }
    state.retiredCloseCount = 0
    document.querySelector('dialog')?.addEventListener('close', () => state.retiredCloseCount++)
    state.Hourmere.openPopup({ url })
  }, app.url + app.personalPath)
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { retiredCloseCount: number }).retiredCloseCount),
    )
    .toBe(1)
  await expect(dialog).toHaveCount(1)
  const rejected = await page.evaluate(() => {
    const current = document.querySelector('dialog'),
      widget = (
        window as unknown as { Hourmere: { openPopup: (options: { url: string }) => unknown } }
      ).Hourmere
    return [
      'https://*',
      'https://*.example.invalid',
      'https://%2a',
      'https://%2A.example.invalid',
      'https://＊.example.invalid',
      'https://%EF%BC%8A.example.invalid',
      'https://foo.%2a.example.invalid',
      'https://＊。example.invalid',
    ].every((origin) => {
      try {
        widget.openPopup({ url: `${origin}/fixture-host/call` })
        return false
      } catch {
        return document.querySelector('dialog') === current && Boolean(current?.open)
      }
    })
  })
  expect(rejected).toBe(true)
  await pickSlot(dialog.locator('iframe').contentFrame().locator('body'), page)
  const body = dialog.locator('iframe').contentFrame().locator('body')
  await fillInvitee(body)
  await body.getByRole('button', { name: 'Confirm booking' }).click()
  await expect(body.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { fixtureMessages: Record<string, unknown>[] }
          ).fixtureMessages.filter((value) => value.type === 'hourmere:booked').length,
      ),
    )
    .toBe(1)
  const contract = await page.evaluate(() => {
    const values = (window as unknown as { fixtureMessages: Record<string, unknown>[] })
      .fixtureMessages
    return {
      booked: values.filter((value) => value.type === 'hourmere:booked').length,
      keys: values.every((value) =>
        Object.keys(value).every((key) => ['type', 'id', 'height'].includes(key)),
      ),
      privateEmail: JSON.stringify(values).includes('fixture-invitee@hourmere.invalid'),
    }
  })
  expect(contract).toEqual({ booked: 1, keys: true, privateEmail: false })
  expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
  await page.getByRole('button', { name: 'Close booking' }).click()
  await expect(opener).toBeFocused()
})

test('account pages require sign-in while public booking remains anonymous', async ({
  page,
  app,
}) => {
  await page.goto(`${app.url}/app/settings`)
  await expect(page.getByRole('heading', { name: 'Sign in to Hourmere' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/sign-in')
})
