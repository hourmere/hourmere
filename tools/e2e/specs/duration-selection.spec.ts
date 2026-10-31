import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

for (const surface of ['personal', 'team', 'embed'] as const) {
  test(`chooses a meeting length by keyboard on the ${surface} booking page`, async ({
    page,
    app,
  }) => {
    await app.configureDurations()
    await page.goto(
      surface === 'embed'
        ? app.parentUrl
        : app.url + (surface === 'team' ? app.teamPath : app.personalPath),
    )
    const scope =
      surface === 'embed'
        ? page.locator('[data-hourmere-inline] iframe').contentFrame().locator('body')
        : page.locator('body')
    if (surface === 'embed')
      await expect(page.locator('[data-hourmere-inline] iframe')).not.toHaveAttribute('inert', '')
    const group = scope.getByRole('group', { name: 'Meeting length', exact: true })
    const initial = group.getByRole('radio', { name: '30 min', exact: true })
    await expect(initial).toBeChecked()
    await initial.focus()
    const selectedSlots = page.waitForResponse(
      (response) =>
        response.url().includes('/slots?') &&
        new URL(response.url()).searchParams.get('durationMinutes') === '60' &&
        response.status() === 200,
    )
    await initial.press('ArrowRight')
    await expect(group.getByRole('radio', { name: '1 h', exact: true })).toBeChecked()
    const slots = (await (await selectedSlots).json()) as {
      data: { start: string; end: string }[]
    }
    expect(
      slots.data.every((slot) => Date.parse(slot.end) - Date.parse(slot.start) === 3_600_000),
    ).toBe(true)
    await pickSlot(scope, page)
    await fillInvitee(scope)
    const creating = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
    )
    await scope.getByRole('button', { name: 'Confirm booking', exact: true }).click()
    const response = await creating
    expect(response.status()).toBe(201)
    expect(response.request().postDataJSON().durationMinutes).toBe(60)
    const result = (await response.json()) as {
      booking: { start: string; end: string }
    }
    expect(Date.parse(result.booking.end) - Date.parse(result.booking.start)).toBe(3_600_000)
    await expect(scope.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    const calendarLink = scope.getByRole('link', { name: /\.ics/ })
    const href = await calendarLink.getAttribute('href')
    const endStamp = result.booking.end.replace(/[-:]/g, '').replace('.000', '')
    expect(decodeURIComponent(href ?? '')).toContain(`DTEND:${endStamp}\r\n`)
    expect(await app.rows()).toEqual([
      { source: surface === 'embed' ? 'embed' : 'web', status: 'confirmed' },
    ])
  })
}
