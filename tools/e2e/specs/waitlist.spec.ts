import { expect, test } from '../fixtures.ts'

for (const kind of ['personal', 'team', 'embed'] as const)
  test(`a full ${kind} booking range joins and verifies through the real mail sink`, async ({
    page,
    app,
  }) => {
    const occupiedDay = await app.configureWaitlist(kind === 'team' ? 'team' : 'personal')
    const requests: { queryHasCapability: boolean; hasReferrer: boolean }[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname !== '/booking/waitlist/verify' || request.method() !== 'POST') return
      requests.push({
        queryHasCapability: [...url.searchParams.keys()].some((name) =>
          /token|capability/i.test(name),
        ),
        hasReferrer: Boolean(request.headers().referer),
      })
    })
    await page.goto(
      kind === 'embed'
        ? app.parentUrl
        : app.url + (kind === 'team' ? app.teamPath : app.personalPath),
    )
    const scope =
      kind === 'embed' ? page.locator('[data-hourmere-inline] iframe').contentFrame() : page
    await expect(scope.locator('.calendar-grid')).toBeVisible()
    if (!(await scope.locator(`[data-day="${occupiedDay}"]`).count()))
      await scope.getByRole('button', { name: 'Next month', exact: true }).click()
    await expect(scope.locator(`[data-day="${occupiedDay}"]`)).toBeVisible()
    await expect(
      scope.getByRole('button', { name: 'Join the waitlist', exact: true }),
    ).toBeVisible()
    await expect(scope.locator('button.day-available')).toHaveCount(0)
    expect(await app.rows()).toEqual([{ source: 'api', status: 'confirmed' }])
    await scope.getByRole('button', { name: 'Join the waitlist', exact: true }).click()
    await expect(
      scope.getByText(
        'If a time opens, everyone eligible may be notified. Nothing is reserved; the first successful booking wins.',
        { exact: true },
      ),
    ).toBeVisible()
    await scope.getByLabel('Email', { exact: true }).fill('fixture-waitlist@hourmere.invalid')
    await scope.getByLabel(/^Your name/).fill('Fixture Waitlist Invitee')
    await scope
      .getByRole('checkbox', {
        name: 'I agree to receive waitlist emails for this period. I can leave using the link in any waitlist email.',
      })
      .check()
    const joining = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/waitlist'),
    )
    await scope.getByRole('button', { name: 'Join the waitlist', exact: true }).click()
    const response = await joining
    expect(response.status()).toBe(202)
    expect(await response.json()).toEqual({ accepted: true })
    const window = response.request().postDataJSON().preferredWindow
    expect(Date.parse(window.start) <= Date.parse(`${occupiedDay}T09:00:00Z`)).toBe(true)
    expect(Date.parse(window.end) >= Date.parse(`${occupiedDay}T09:30:00Z`)).toBe(true)
    await expect(
      scope.getByRole('heading', { name: 'Check your email to confirm', exact: true }),
    ).toBeVisible()
    expect(await app.waitlistState()).toEqual({
      states: ['pending_verification'],
      acceptedEmails: 0,
      messages: 0,
    })

    // Run the real durable sender with the isolated in-memory mail sink, then
    // open its actual confirmation link without putting a capability in logs.
    await app.openWaitlistVerification(page)
    await expect(
      page.getByRole('heading', { name: 'Confirm your waitlist email', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirm email', exact: true })).toBeVisible()
    expect(await page.evaluate(() => location.hash === '')).toBe(true)
    expect(await app.waitlistState()).toEqual({
      states: ['pending_verification'],
      acceptedEmails: 1,
      messages: 1,
    })
    await page.getByRole('button', { name: 'Confirm email', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText(
      'Your email is confirmed. You are on the waitlist. Emails are sent when possible and do not guarantee a booking.',
    )
    expect(await app.waitlistState()).toEqual({
      states: ['active'],
      acceptedEmails: 1,
      messages: 1,
    })
    expect(requests).toEqual([{ queryHasCapability: false, hasReferrer: false }])
    expect(await app.rows()).toEqual([{ source: 'api', status: 'confirmed' }])
  })
