import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

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
