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
    // The language control stays in a compact top-right header at both project widths.
    const header = page.locator('.public-language')
    const language = header.getByRole('combobox', { name: 'Interface language' })
    await expect(language).toBeVisible()
    const headerBox = await header.boundingBox()
    const languageBox = await language.boundingBox()
    const cardBox = await page.locator('.booking-layout').boundingBox()
    const mainBox = await page.locator('.public-main').boundingBox()
    expect(Boolean(headerBox && languageBox && cardBox && mainBox)).toBe(true)
    if (headerBox && languageBox && cardBox && mainBox) {
      expect(headerBox.y).toBeLessThan(20)
      expect(headerBox.height).toBeLessThan(80)
      expect(languageBox.x + languageBox.width).toBeGreaterThan(mainBox.x + mainBox.width - 50)
      expect(cardBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height)
      expect(cardBox.y).toBeLessThan(160)
    }
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

test('a host moves a booking on the web and the original invitee link opens its successor', async ({
  page,
  app,
}) => {
  await page.goto(app.url + app.personalPath)
  await pickSlot(page, page)
  await fillInvitee(page)
  const creating = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: 'Confirm booking' }).click()
  const original = (await (await creating).json()) as {
    booking: { id: string; start: string }
  }
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  const inviteeLink = await page
    .getByLabel('Your link to change or cancel this booking')
    .inputValue()
  expect(Boolean(new URL(inviteeLink).hash)).toBe(true)

  await app.authorizeHost()
  const hostRequests: { hasManageToken: boolean }[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith(`/api/v1/bookings/${original.booking.id}/`)) return
    const headers = request.headers()
    hostRequests.push({
      hasManageToken: Boolean(headers['x-manage-token']),
    })
  })
  await page.goto(`${app.url}/app/bookings/${original.booking.id}`)
  const slots = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/bookings/${original.booking.id}/slots` &&
      response.status() === 200,
  )
  await page.getByRole('button', { name: 'Reschedule', exact: true }).click()
  await slots
  await pickSlot(page, page)
  const moving = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/bookings/${original.booking.id}/reschedule`,
  )
  await page.getByRole('button', { name: 'Confirm new time', exact: true }).click()
  const response = await moving
  expect(response.status()).toBe(200)
  const moved = (await response.json()) as {
    booking: { id: string; start: string; status: string; rescheduledFromId: string }
    manageToken: unknown
  }
  expect(moved.manageToken === null).toBe(true)
  expect(moved.booking.id !== original.booking.id).toBe(true)
  expect(moved.booking.start !== original.booking.start).toBe(true)
  expect(moved.booking.status).toBe('confirmed')
  expect(moved.booking.rescheduledFromId).toBe(original.booking.id)
  expect(response.request().postDataJSON()).toEqual({ start: moved.booking.start })
  await expect(page).toHaveURL(`${app.url}/app/bookings/${moved.booking.id}`)
  await expect(
    page.getByText('The booking is moved to the new time.', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.when time')).toHaveAttribute('datetime', moved.booking.start)
  expect(hostRequests.length >= 2).toBe(true)
  expect(hostRequests.every((request) => !request.hasManageToken)).toBe(true)

  await page.goto(`${app.url}/booking`)
  await expect(page.getByRole('heading', { name: 'Open your booking link' })).toBeVisible()
  const opening = page.waitForResponse(
    (result) => new URL(result.url()).pathname === '/api/v1/bookings/manage',
  )
  await page.evaluate((link) => {
    window.location.hash = new URL(link).hash
  }, inviteeLink)
  const opened = await opening
  expect(opened.status()).toBe(200)
  expect(Boolean(opened.request().headers().authorization)).toBe(false)
  const managed = (await opened.json()) as { id: string; start: string; status: string }
  expect(managed.id).toBe(moved.booking.id)
  expect(managed.start).toBe(moved.booking.start)
  expect(managed.status).toBe('confirmed')
  await expect(page.getByRole('heading', { name: 'Your booking', exact: true })).toBeVisible()
  await expect(page.locator('.booking-details time')).toHaveAttribute(
    'datetime',
    moved.booking.start,
  )
  await expect(page.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.location.hash === '')).toBe(true)
  expect((await app.bookingState()).successors).toBe(1)
  expect(await app.rows()).toEqual([
    { source: 'web', status: 'cancelled' },
    { source: 'api', status: 'confirmed' },
  ])
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
  await page.addStyleTag({
    content:
      'div { text-transform: uppercase; } h2 { color: red !important; text-transform: uppercase !important; } button { all: unset !important; } dialog { display: none !important; }',
  })
  await page.evaluate(() => {
    const policy = document.createElement('meta')
    policy.httpEquiv = 'Content-Security-Policy'
    policy.content = "style-src 'none'"
    document.head.append(policy)
  })
  const opener = page.getByRole('button', { name: 'Book a meeting', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog'),
    frame = dialog.locator('iframe').contentFrame()
  await expect(dialog).toHaveCSS('color-scheme', 'light dark')
  await expect(dialog.getByRole('heading', { name: 'Book a meeting' })).toHaveCSS(
    'text-transform',
    'none',
  )
  await expect(dialog.getByRole('button', { name: 'Close booking' })).toHaveCSS('width', '44px')
  await expect(dialog.getByRole('button', { name: 'Close booking' })).toHaveCSS('height', '44px')
  await expect(frame.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  expect(
    await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth
    }),
  ).toBe(true)
  expect(
    await frame
      .locator('body')
      .evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
  await frame.getByRole('button', { name: 'Next month', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await dialog.evaluate((element, url) => {
    const state = window as unknown as {
      Hourmere: { openPopup: (options: { url: string }) => unknown }
      retiredCloseCount: number
    }
    state.retiredCloseCount = 0
    element.addEventListener('close', () => state.retiredCloseCount++)
    state.Hourmere.openPopup({ url })
  }, app.url + app.personalPath)
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { retiredCloseCount: number }).retiredCloseCount),
    )
    .toBe(1)
  await expect(dialog).toHaveCount(1)
  const rejected = await dialog.evaluate((element) => {
    const current = element as HTMLDialogElement,
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
        return current.isConnected && current.open
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
