import { expect, fillInvitee, test } from '../fixtures.ts'

for (const mode of ['inline', 'popup', 'iframe'] as const) {
  test(`group seats in ${mode} embed show remaining places and omit full times`, async ({
    page,
    app,
  }) => {
    await app.configureGroupSeats()
    const start = Temporal.Now.instant().add({ hours: 48 })
    const end = start.add({ hours: 7 * 24 })
    const query = new URLSearchParams({ start: start.toString(), end: end.toString() })
    const slotsUrl = `${app.url}/api/v1/public/fixture-host/call/slots?${query}`
    const offered = await page.request.get(slotsUrl)
    expect(offered.status()).toBe(200)
    const slot = (await offered.json()).data[0] as {
      start: string
      end: string
      seatsRemaining: number
      capacity: number
    }
    expect(slot.seatsRemaining).toBe(2)
    const first = await page.request.post(`${app.url}/api/v1/public/fixture-host/call/bookings`, {
      data: {
        start: slot.start,
        invitee: { name: 'Other visitor', email: 'other@hourmere.invalid', timeZone: 'UTC' },
      },
    })
    expect(first.status()).toBe(201)
    const snippet =
      mode === 'iframe'
        ? `<iframe src="${app.url}/embed/fixture-host/call?parentOrigin=${encodeURIComponent(app.parentUrl)}&amp;embedId=groupseatsmanualframe01" title="Booking" style="width:100%;height:900px"></iframe>`
        : `<${mode === 'inline' ? 'div' : 'button'} data-hourmere-${mode} data-hourmere-url="${app.url}${app.personalPath}">Book a meeting</${mode === 'inline' ? 'div' : 'button'}><script src="${app.url}/hourmere-embed.js" defer></script>`
    app.setEmbedSnippet(`<script src="/parent.js" defer></script>${snippet}`)
    await page.goto(`${app.parentUrl}/generated-embed`)
    if (mode === 'popup') await page.getByRole('button', { name: 'Book a meeting' }).click()
    const frame = page.frameLocator('iframe')
    const date = Temporal.Instant.from(slot.start)
      .toZonedDateTimeISO('UTC')
      .toPlainDate()
      .toString()
    await expect(frame.locator('.calendar-month')).toBeVisible()
    for (let month = 0; month < 2; month++) {
      await expect(frame.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
      if (await frame.locator(`[data-day="${date}"]`).count()) break
      await frame.getByRole('button', { name: 'Next month' }).click()
    }
    await frame.locator(`[data-day="${date}"]`).click()
    const remaining = frame.locator('.slots button').filter({ hasText: '1 seat left' })
    await expect(remaining).toHaveCount(1)
    const time = await remaining.evaluate((button) => button.firstChild?.textContent?.trim() ?? '')
    expect(time).not.toBe('')
    await remaining.click()
    await fillInvitee(frame)
    await frame.getByRole('button', { name: 'Confirm booking', exact: true }).click()
    await expect(frame.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    if (mode !== 'iframe') {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const messages = (window as unknown as { fixtureMessages: Record<string, unknown>[] })
              .fixtureMessages
            return messages.some(
              (message) =>
                message.type === 'hourmere:booked' &&
                Object.keys(message).sort().join(',') === 'id,type',
            )
          }),
        )
        .toBe(true)
    }
    const full = await page.request.get(slotsUrl)
    expect(full.status()).toBe(200)
    expect(
      (await full.json()).data.some((value: { start: string }) => value.start === slot.start),
    ).toBe(false)
    await page.reload()
    if (mode === 'popup') await page.getByRole('button', { name: 'Book a meeting' }).click()
    await expect(frame.locator('.calendar-month')).toBeVisible()
    await expect(frame.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
    for (let month = 0; month < 2; month++) {
      if (await frame.locator(`[data-day="${date}"]`).count()) break
      await frame.getByRole('button', { name: 'Next month' }).click()
      await expect(frame.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
    }
    await frame.locator(`[data-day="${date}"]`).click()
    await expect(frame.locator('.slots button')).not.toHaveCount(0)
    // Compare complete time labels: "2:30 PM" must not match an available "12:30 PM".
    await expect
      .poll(() =>
        frame
          .locator('.slots button')
          .evaluateAll((buttons) =>
            buttons.map((button) => button.firstChild?.textContent?.trim() ?? ''),
          ),
      )
      .not.toContain(time)
  })
}
