import type { Frame, Page } from '@playwright/test'
import { type BookingEmailKind, bookingEmail } from '../../../packages/mail/src/booking.ts'
import { teamInvitationEmail } from '../../../packages/mail/src/team-invitation.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

async function fits(page: Page | Frame, context = 'French public booking') {
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
        await fits(page, 'French slot chips')
        await page.locator('.slots button').first().click()
        return
      }
    }
    await page.getByRole('button', { name: 'Mois suivant', exact: true }).click()
  }
  throw new Error('No French fixture availability within four months')
}

test('French public booking, rescheduling, cancellation and embeds fit at 320px and desktop', async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'fr'))
  await page.goto(app.url + app.personalPath)
  await expect(page.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
  await fits(page)
  await page.getByRole('button', { name: /Fuseau horaire/ }).click()
  await expect(page.getByPlaceholder('Rechercher par ville ou décalage UTC')).toBeVisible()
  await fits(page, 'French time-zone panel')
  await page.getByRole('button', { name: /Fuseau horaire/ }).click()
  await chooseSlot(page)
  await expect(page.getByRole('heading', { name: 'Vos coordonnées' })).toBeVisible()
  await page.getByLabel('Votre nom', { exact: true }).fill('Fixture Invitee')
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('fixture-invitee@hourmere.invalid')
  await fits(page, 'French booking form labels and buttons')
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/bookings') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Confirmer la réservation', exact: true }).click()
  const result = (await (await response).json()) as { manageToken?: unknown }
  expect(typeof result.manageToken === 'string').toBe(true)
  await expect(page.getByRole('heading', { name: 'Votre réservation est confirmée' })).toBeVisible()
  expect((await app.bookingState()).bookerLocales).toEqual(['fr'])
  await fits(page, 'French confirmation')
  // Keep the private management capability in memory and out of test artifacts.
  await page.goto(`${app.url}/booking`)
  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString()
  }, result.manageToken as string)
  await page.getByRole('button', { name: 'Replanifier', exact: true }).click()
  await chooseSlot(page)
  await expect(page.locator('dt').filter({ hasText: /^Horaire précédent$/ })).toBeVisible()
  await expect(page.locator('dt').filter({ hasText: /^Nouvel horaire$/ })).toBeVisible()
  await fits(page, 'French move confirmation')
  await page.getByRole('button', { name: 'Confirmer le nouvel horaire', exact: true }).click()
  await expect(
    page.getByText('Votre réservation a été replanifiée au nouvel horaire.', { exact: true }),
  ).toBeVisible()
  await fits(page, 'French moved booking')
  await page.getByRole('button', { name: 'Annuler la réservation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Annuler cette réservation ?' })).toBeVisible()
  await page.getByLabel(/^Motif/).fill('Motif de test')
  await fits(page, 'French cancellation form')
  await page.getByRole('button', { name: 'Annuler la réservation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Réservation annulée' })).toBeVisible()
  await fits(page, 'French cancelled booking')
  await page.goto(`${app.parentUrl}/?language=fr`)
  const iframe = page.locator('[data-hourmere-inline] > iframe')
  await expect(iframe).toHaveAttribute('title', 'Réserver une réunion avec Hourmere')
  await expect(iframe.contentFrame().getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(iframe.contentFrame().locator('html')).toHaveAttribute('lang', 'fr')
  const embedded = page.frames().find((frame) => frame.url().startsWith(`${app.url}/embed/`))
  expect(Boolean(embedded)).toBe(true)
  if (embedded) await fits(embedded, 'French inline embed')
  await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Réserver une réunion' })).toBeVisible()
  await fits(page, 'French popup widget')
  await page.getByRole('button', { name: 'Fermer la fenêtre de réservation' }).click()
})

test('all French booking email kinds and the team invitation fit at 320px and desktop', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  const meeting = {
    eventName: 'Rendez-vous de préparation du projet commun',
    hostName: 'Fixture Host',
    inviteeName: 'Fixture Invitee',
    inviteeEmail: 'invitee@example.invalid',
    inviteeTimeZone: 'Europe/Paris',
    start: Temporal.Instant.from('2026-11-02T14:00:00Z'),
    end: Temporal.Instant.from('2026-11-02T14:30:00Z'),
    previous: {
      start: Temporal.Instant.from('2026-11-01T14:00:00Z'),
      end: Temporal.Instant.from('2026-11-01T14:30:00Z'),
    },
    cancelReason: 'Le rendez-vous doit être reporté.',
    location: {
      kind: 'link' as const,
      label: 'Google Meet',
      url: 'https://meet.google.com/fixture',
    },
  }
  const links = {
    reschedule: 'https://example.invalid/booking',
    cancel: 'https://example.invalid/booking',
  }
  const kinds: BookingEmailKind[] = [
    'confirmed',
    'rescheduled',
    'cancelled',
    'reminder',
    'conference_failed',
  ]
  for (const kind of kinds)
    for (const role of ['attendee', 'host'] as const) {
      const message = bookingEmail(kind, meeting, {
        role,
        email: `${role}@example.invalid`,
        timeZone: role === 'host' ? 'America/New_York' : 'Europe/Paris',
        locale: 'fr',
        manageLinks: links,
        answers: [],
      })
      await page.setContent(message.html ?? '')
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
      await fits(page, `French ${role} ${kind} email labels, buttons and header`)
    }
  const invitation = teamInvitationEmail({
    to: 'invitee@example.invalid',
    publicUrl: 'https://example.invalid',
    invitationId: '019a1234-5678-7000-8000-000000000001',
    teamName: 'Préparation du projet commun',
    inviterName: 'Fixture Host',
    expiresAt: '2026-11-03T12:00:00Z',
    language: 'fr',
  })
  await page.setContent(invitation.html ?? '')
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
  await fits(page, 'French team invitation email labels, button and header')
})
