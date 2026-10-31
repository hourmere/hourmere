import { openAuditPage } from '../audit-pages.ts'
import {
  LONG_BOOKING_SLUG,
  measureEventTypesTable,
  SHORT_BOOKING_SLUG,
  useLongBookingSlug,
} from '../event-types-table.ts'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

// Kept deliberately small: each is a complete user path, shared by WebKit desktop,
// the iPhone preset, and Firefox desktop in the independent report-only CI job.
test('booking happy path', async ({ page, app }) => {
  await page.goto(app.url + app.personalPath)
  await pickSlot(page, page)
  await fillInvitee(page)
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
})

test('sign-in page and protected-page redirect', async ({ page, app }) => {
  await page.goto(`${app.url}/app/settings`)
  await expect(page.getByRole('heading', { name: 'Sign in to Hourmere' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/sign-in')
  const email = page.getByRole('textbox', { name: 'Email', exact: true })
  await email.fill('synthetic-sign-in@hourmere.invalid')
  await expect(email).toHaveValue('synthetic-sign-in@hourmere.invalid')
  await expect(
    page.getByRole('button', { name: 'Email me a sign-in link', exact: true }),
  ).toBeEnabled()
})

test('embed popup booking and keyboard dismissal', async ({ page, app }) => {
  await page.goto(app.parentUrl)
  const opener = page.getByRole('button', { name: 'Book a meeting', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog')
  const frame = dialog.locator('iframe').contentFrame()
  await expect(frame.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await frame.getByRole('button', { name: 'Next month', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  const scope = dialog.locator('iframe').contentFrame().locator('body')
  await pickSlot(scope, page)
  await fillInvitee(scope)
  await scope.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  await expect(scope.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
  const safeMessages = await page.evaluate(() =>
    (window as unknown as { fixtureMessages: Record<string, unknown>[] }).fixtureMessages.every(
      (message) =>
        message.type === 'hourmere:ready'
          ? Object.keys(message).sort().join(',') === 'allowEmbedParent,id,type' &&
            typeof message.allowEmbedParent === 'boolean'
          : Object.keys(message).every((key) => ['type', 'id', 'height'].includes(key)),
    ),
  )
  expect(safeMessages).toBe(true)
  await page.getByRole('button', { name: 'Close booking', exact: true }).click()
  await expect(opener).toBeFocused()
})

// Table intrinsic sizing differs most between engines: the admin list must keep its title
// column in WebKit and Firefox too, and card mode must keep the link on one clipped line.
test('event-types list beside a long booking link', async ({ page, app }) => {
  await openAuditPage(page, app, 'event-types')
  const initialWidth = page.viewportSize()?.width ?? 0
  if (initialWidth >= 1024) {
    // A short path that fits its column is shown whole in every engine: measured at 1440,
    // where it has room to spare in each engine's fallback monospace font.
    await page.setViewportSize({ width: 1440, height: 900 })
    const whole = await measureEventTypesTable(page, SHORT_BOOKING_SLUG)
    expect(whole.handleOverflow).toBe(false)
    expect(whole.slugOverflow).toBe(false)
    expect(whole.linkLines).toBe(1)
  }
  await useLongBookingSlug(page, app)
  const widths = initialWidth >= 1024 ? [1280, 1440] : [initialWidth]
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    const geometry = await measureEventTypesTable(page, LONG_BOOKING_SLUG)
    expect(geometry.linkLines).toBe(1)
    expect(geometry.linkOverflow).toBe(true)
    expect(geometry.linkEllipsis).toBe('ellipsis')
    expect(geometry.slugStartVisible).toBe(true)
    // The clipped handle fills the width the slug leaves, within subpixel rounding.
    expect(geometry.unusedPathWidth).toBeLessThan(1)
    expect(geometry.fullUrlTitle).toBe(true)
    expect(geometry.documentOverflow).toBe(false)
    if (width >= 1024) {
      expect(geometry.tableMode).toBe(true)
      expect(geometry.titleColumnWidth / geometry.tableWidth).toBeGreaterThanOrEqual(0.35)
      expect(geometry.titleLines).toBeLessThanOrEqual(3)
      expect(geometry.handleOverflow).toBe(true)
      expect(geometry.copyBeside).toBe(true)
    } else expect(geometry.tableMode).toBe(false)
  }
})
