import type { Frame, Page } from '@playwright/test'
import { bookingEmail } from '../../../packages/mail/src/booking.ts'
import { teamInvitationEmail } from '../../../packages/mail/src/team-invitation.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

async function fits(page: Page | Frame, context = 'public booking') {
  await page.evaluate(() => document.fonts.ready)
  const findings = await page.evaluate(
    measureLayout,
    'viewportSize' in page ? (page.viewportSize() ?? undefined) : undefined,
  )
  expect(
    findings.filter(({ code }) => /overflow|clipped/.test(code)),
    context,
  ).toEqual([])
}

async function chooseSlot(page: Page) {
  for (let month = 0; month < 4; month++) {
    await expect(page.locator('.calendar-month')).toBeVisible()
    await expect(page.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
    const days = page.locator('button.day-available')
    const cutoff = Temporal.Now.plainDateISO('UTC').add({ days: 2 }).toString()
    for (let index = 0; index < (await days.count()); index++) {
      const day = days.nth(index)
      if (((await day.getAttribute('data-day')) ?? '') >= cutoff) {
        await day.click()
        await expect(page.locator('.slots button').first()).toBeVisible()
        await fits(page)
        await page.locator('.slots button').first().click()
        return
      }
    }
    await page.getByRole('button', { name: 'Nächster Monat', exact: true }).click()
  }
  throw new Error('No German fixture availability within four months')
}

test('German public booking, rescheduling, cancellation and embeds fit at narrow and desktop widths', async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'de'))
  await page.goto(app.url + app.personalPath)
  await expect(page.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await fits(page)
  await chooseSlot(page)
  await expect(page.getByRole('heading', { name: 'Ihre Angaben' })).toBeVisible()
  await page.getByLabel('Ihr Name', { exact: true }).fill('Fixture Invitee')
  await page.getByLabel('E-Mail', { exact: true }).fill('fixture-invitee@hourmere.invalid')
  await fits(page)
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/bookings') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Buchung bestätigen', exact: true }).click()
  const result = (await (await response).json()) as { manageToken?: unknown }
  expect(typeof result.manageToken === 'string').toBe(true)
  await expect(page.getByRole('heading', { name: 'Ihr Termin ist gebucht' })).toBeVisible()
  expect((await app.bookingState()).bookerLocales).toEqual(['de'])
  await fits(page)
  // Open a fragment only in memory; never log or capture a management capability.
  await page.goto(`${app.url}/booking`)
  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString()
  }, result.manageToken as string)
  await page.getByRole('button', { name: 'Verschieben', exact: true }).click()
  await chooseSlot(page)
  await fits(page)
  await page.getByRole('button', { name: 'Neue Zeit bestätigen', exact: true }).click()
  await expect(
    page.getByText('Ihre Buchung wurde auf die neue Zeit verschoben.', { exact: true }),
  ).toBeVisible()
  await fits(page)
  await page.getByRole('button', { name: 'Buchung stornieren', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Diese Buchung stornieren?' })).toBeVisible()
  await page.getByLabel(/^Grund/).fill('Fixture reason')
  await fits(page)
  await page.getByRole('button', { name: 'Buchung stornieren', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Stornierte Buchung' })).toBeVisible()
  await fits(page)
  await page.goto(`${app.parentUrl}/?language=de`)
  const iframe = page.locator('[data-hourmere-inline] > iframe')
  await expect(iframe).toHaveAttribute('title', 'Termin mit Hourmere buchen')
  await expect(iframe.contentFrame().getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(iframe.contentFrame().locator('html')).toHaveAttribute('lang', 'de')
  const embedded = page.frames().find((frame) => frame.url().startsWith(`${app.url}/embed/`))
  expect(Boolean(embedded)).toBe(true)
  if (embedded) await fits(embedded, 'inline embed')
  await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Termin buchen' })).toBeVisible()
  await fits(page, 'popup widget')
  await page.getByRole('button', { name: 'Buchung schließen' }).click()
})

test('German booking and team invitation email labels, buttons and headers fit at 320px and desktop', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  const meeting = {
    eventName: 'Termin zur gemeinsamen Projektbesprechung',
    hostName: 'Fixture Host',
    inviteeName: 'Fixture Invitee',
    inviteeEmail: 'invitee@example.invalid',
    inviteeTimeZone: 'Europe/Berlin',
    start: Temporal.Instant.from('2026-11-02T14:00:00Z'),
    end: Temporal.Instant.from('2026-11-02T14:30:00Z'),
    location: null,
  }
  const links = {
    reschedule: 'https://example.invalid/booking',
    cancel: 'https://example.invalid/booking',
  }
  const messages = [
    bookingEmail('confirmed', meeting, {
      role: 'attendee',
      email: 'invitee@example.invalid',
      timeZone: 'Europe/Berlin',
      locale: 'de',
      manageLinks: links,
    }),
    bookingEmail('confirmed', meeting, {
      role: 'host',
      email: 'host@example.invalid',
      timeZone: 'America/New_York',
      locale: 'de',
      answers: [],
    }),
    teamInvitationEmail({
      to: 'invitee@example.invalid',
      publicUrl: 'https://example.invalid',
      invitationId: '019a1234-5678-7000-8000-000000000001',
      teamName: 'Gemeinsame Projektplanung',
      inviterName: 'Fixture Host',
      expiresAt: '2026-11-03T12:00:00Z',
      language: 'de',
    }),
  ]
  for (const [index, message] of messages.entries()) {
    await page.setContent(message.html ?? '')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await fits(page, `email ${['attendee', 'host', 'invitation'][index]}`)
  }
})
