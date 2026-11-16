import { revealEventSetting } from '../event-settings.ts'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

for (const embedded of [false, true]) {
  test(`editor continuation reaches the configured target (${embedded ? 'embed without parent opt-in' : 'public page'})`, async ({
    page,
    context,
    app,
  }) => {
    const { personalId } = await app.authorizeTeamSession()
    const switched = await page.request.post(`${app.url}/api/auth/organization/set-active`, {
      headers: { Origin: app.url },
      data: { organizationId: personalId },
    })
    expect(switched.ok()).toBe(true)
    const response = await page.request.get(`${app.url}/api/v1/event-types`)
    expect(response.ok()).toBe(true)
    const { data } = (await response.json()) as { data: { id: string; slug: string }[] }
    const event = data.find((item) => item.slug === 'call')
    expect(Boolean(event)).toBe(true)
    if (!event) return
    await page.goto(`${app.url}/app/event-types/${event.id}`)
    await revealEventSetting(page.getByLabel(/^Continue to URL/))
    await expect(page.getByRole('heading', { name: 'After booking', exact: true })).toBeVisible()
    if (!embedded) {
      await page.getByLabel(/^Continue to URL/).fill('http://continuation.example/thanks')
      const refusing = page.waitForResponse(
        (result) =>
          result.request().method() === 'PATCH' &&
          result.url() === `${app.url}/api/v1/event-types/${event.id}`,
      )
      await page.getByRole('button', { name: 'Save changes', exact: true }).click()
      const refused = await refusing
      expect(refused.status()).toBe(400)
      expect(await refused.json()).toMatchObject({
        error: 'invalid_success_redirect',
        field: 'successRedirect.url',
      })
      await expect(page.getByLabel(/^Continue to URL/)).toHaveAttribute('aria-invalid', 'true')
    }
    const target = 'https://continuation.example/thanks?flag&a;b&campaign=fixture%20value#done'
    await page.getByLabel(/^Continue to URL/).fill(target)
    await expect(page.getByText(/target site and its analytics/)).toBeVisible()
    const personalData = page.getByRole('checkbox', {
      name: 'Allow sharing invitee name and email',
      exact: true,
    })
    await expect(personalData).not.toBeChecked()
    await personalData.check()
    for (const label of [
      'Event type slug',
      'Start time',
      'End time',
      'Time zone',
      'Host name',
      'Invitee name',
      'Invitee email',
    ])
      await page.getByRole('checkbox', { name: label, exact: true }).check()
    await expect(
      page.getByRole('checkbox', {
        name: 'Allow embedded bookings to open the parent page',
        exact: true,
      }),
    ).not.toBeChecked()
    const saving = page.waitForResponse(
      (result) =>
        result.request().method() === 'PATCH' &&
        result.url() === `${app.url}/api/v1/event-types/${event.id}`,
    )
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    const saved = await saving
    expect(saved.status()).toBe(200)
    expect(saved.request().postDataJSON().successRedirect).toEqual({
      url: target,
      parameters: [
        'eventTypeSlug',
        'start',
        'end',
        'timeZone',
        'hostName',
        'inviteeName',
        'inviteeEmail',
      ],
      includeInviteePersonalData: true,
      allowEmbedParent: false,
    })
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    // The synthetic target is fulfilled in-process; no third-party traffic is permitted.
    await context.route('https://continuation.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Editor continuation target</title><h1>Target reached</h1>',
      }),
    )
    await page.goto(embedded ? app.parentUrl : app.url + app.personalPath)
    const iframe = page.locator('[data-hourmere-inline] iframe')
    const scope = embedded ? iframe.contentFrame().locator('body') : page.locator('body')
    if (embedded) {
      await expect(iframe).not.toHaveAttribute('inert', '')
      expect(
        (await iframe.getAttribute('sandbox'))?.includes('allow-top-navigation-by-user-activation'),
      ).toBe(false)
    }
    await pickSlot(scope, page)
    const inviteeName = 'Fixture & 李 + #'
    const inviteeEmail = 'fixture+redirect@hourmere.invalid'
    await scope.getByLabel('Your name', { exact: true }).fill(inviteeName)
    await scope.getByLabel('Email', { exact: true }).fill(inviteeEmail)
    const creating = page.waitForResponse(
      (result) => result.request().method() === 'POST' && result.url().endsWith('/bookings'),
    )
    await scope.getByRole('button', { name: 'Confirm booking', exact: true }).click()
    const created = await creating
    expect(created.status()).toBe(201)
    const result = (await created.json()) as {
      booking: { start: string; end: string }
      successRedirect: { url: string; allowEmbedParent: boolean }
    }
    await expect(scope.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    await expect(scope.getByLabel('Your link to change or cancel this booking')).toBeVisible()
    const continuation = scope.getByRole('link', { name: /Continue/ })
    await expect(continuation).toHaveAttribute('rel', 'noopener noreferrer')
    const destination = await continuation.getAttribute('href')
    expect(destination).toBe(result.successRedirect.url)
    expect(destination?.startsWith(target.replace('#done', '&'))).toBe(true)
    const url = new URL(destination as string)
    expect(url.hash).toBe('#done')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      flag: '',
      'a;b': '',
      campaign: 'fixture value',
      eventTypeSlug: 'call',
      start: result.booking.start,
      end: result.booking.end,
      timeZone: 'UTC',
      hostName: 'Fixture Host',
      inviteeName,
      inviteeEmail,
    })
    if (embedded) {
      await expect(continuation).toHaveAttribute('target', '_blank')
      const opened = page.waitForEvent('popup')
      await continuation.click()
      const popup = await opened
      await expect(popup.getByRole('heading', { name: 'Target reached' })).toBeVisible()
      await expect(popup).toHaveURL(destination as string)
      expect(page.url()).toBe(`${app.parentUrl}/`)
      await popup.close()
    } else {
      await continuation.click()
      await expect(page.getByRole('heading', { name: 'Target reached' })).toBeVisible()
      await expect(page).toHaveURL(destination as string)
    }
    expect(await app.rows()).toEqual([{ source: embedded ? 'embed' : 'web', status: 'confirmed' }])
  })
}

for (const mode of ['new-tab', 'parent', 'enabled-after-load'] as const) {
  test(`saved continuation uses the active iframe sandbox (${mode})`, async ({
    page,
    context,
    app,
  }) => {
    const parentEnabled = mode === 'parent'
    await app.configureSuccessRedirect(parentEnabled)
    // Fulfill the synthetic destination locally; no third-party request is made.
    await context.route('https://continuation.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Continuation fixture</title>',
      }),
    )
    const documentIds: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.isNavigationRequest() && url.pathname.startsWith('/embed/'))
        documentIds.push(url.searchParams.get('embedId') ?? '')
    })
    await page.goto(app.parentUrl)
    const iframe = page.locator('[data-hourmere-inline] iframe')
    const body = iframe.contentFrame().locator('body')
    await expect(body.getByRole('heading', { name: 'Fixture call', exact: true })).toBeVisible()
    await expect(iframe).not.toHaveAttribute('inert', '')
    await expect(iframe).toHaveCSS('pointer-events', 'auto')
    expect(
      (await iframe.getAttribute('sandbox'))?.includes('allow-top-navigation-by-user-activation'),
    ).toBe(parentEnabled)
    expect(documentIds).toHaveLength(parentEnabled ? 2 : 1)
    expect(new Set(documentIds).size).toBe(documentIds.length)
    if (mode === 'enabled-after-load') await app.configureSuccessRedirect(true)
    await pickSlot(body, page)
    await fillInvitee(body)
    await body.getByRole('button', { name: 'Confirm booking' }).click()
    await expect(body.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    const continuation = body.getByRole('link', { name: /Continue/ })
    await expect(continuation).toHaveAttribute('target', parentEnabled ? '_top' : '_blank')
    await expect(continuation).toHaveAttribute('rel', 'noopener noreferrer')
    const destination = await continuation.getAttribute('href')
    expect(
      destination?.startsWith('https://continuation.example/thanks?x=%zz&flag&a;b&start='),
    ).toBe(true)
    if (parentEnabled) {
      await continuation.click()
      await expect(page).toHaveURL(destination as string)
    } else {
      const opened = page.waitForEvent('popup')
      await continuation.click()
      const popup = await opened
      await expect(popup).toHaveURL(destination as string)
      expect(page.url()).toBe(`${app.parentUrl}/`)
      await popup.close()
    }
    expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
  })
}
