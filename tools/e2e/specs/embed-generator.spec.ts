import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

for (const mode of ['inline', 'popup'] as const) {
  test(`copied ${mode} code books on an allowed website and is rejected elsewhere`, async ({
    page,
    context,
    app,
  }) => {
    await app.authorizeTeamSession()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url })
    await page.goto(`${app.url}/app/event-types`)
    await page
      .getByRole('button', { name: 'More actions for Team fixture call', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Embed', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(app.parentUrl, { exact: true })).toBeVisible()
    await dialog.getByLabel('Embed mode', { exact: true }).selectOption(mode)
    if (mode === 'inline') {
      await expect(dialog.getByLabel('Initial height (pixels)')).toHaveValue('720')
      await dialog.getByLabel('Initial height (pixels)').fill('840')
    } else {
      await expect(dialog.getByLabel('Button text', { exact: true })).toHaveValue('Book a meeting')
      await dialog.getByLabel('Button text', { exact: true }).fill('Book <our> meeting & chat')
    }
    const displayed = await dialog.getByLabel('Embed code', { exact: true }).inputValue()
    await dialog.getByRole('button', { name: 'Copy embed code', exact: true }).click()
    await expect(dialog.getByRole('status').filter({ hasText: /^Copied$/ })).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(displayed)
    expect(copied).toContain(`data-hourmere-${mode}`)
    expect(copied).toContain(`${app.url}${app.teamPath}`)
    if (mode === 'inline') expect(copied).toContain('data-hourmere-height="840"')
    else expect(copied).toContain('Book &lt;our&gt; meeting &amp; chat')
    app.setEmbedSnippet(copied)
    // The copied bytes are served as HTML by the owned parent server, including its script.
    // Remove the host session so the booking also proves anonymous invitee access.
    await context.clearCookies()
    await page.goto(`${app.parentUrl}/generated-embed`)
    if (mode === 'popup')
      await page.getByRole('button', { name: 'Book <our> meeting & chat', exact: true }).click()
    const frame = page.frameLocator('iframe')
    await expect(page.locator('iframe')).toHaveCount(1)
    await pickSlot(frame, page)
    await fillInvitee(frame)
    await frame.getByRole('button', { name: 'Confirm booking', exact: true }).click()
    await expect(frame.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])

    // The app origin is intentionally absent from EMBED_ALLOWED_ORIGINS. Only this
    // synthetic parent document is supplied here; widget, iframe and API stay real.
    await page.route(`${app.url}/generated-embed`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>Disallowed website</title>${copied}`,
      }),
    )
    const rejected = page.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith('/embed/'),
    )
    await page.goto(`${app.url}/generated-embed`)
    if (mode === 'popup')
      await page.getByRole('button', { name: 'Book <our> meeting & chat', exact: true }).click()
    const response = await rejected
    expect(response.status()).toBe(403)
    // Chromium may substitute its own error document for a denied frame. Inspect
    // the same real URL directly as well to verify the server's denial contract.
    const denial = await page.request.get(response.url())
    expect(denial.status()).toBe(403)
    expect(await denial.json()).toEqual({ error: 'embedding_not_allowed' })
    expect(denial.headers()['x-frame-options']).toBe('DENY')
    await expect(frame.locator('.calendar-month')).toHaveCount(0)
    expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
  })
}
