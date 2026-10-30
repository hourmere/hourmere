import type { Frame, Page } from '@playwright/test'
import { type BookingEmailKind, bookingEmail } from '../../../packages/mail/src/booking.ts'
import { magicLinkEmail } from '../../../packages/mail/src/index.ts'
import { teamInvitationEmail } from '../../../packages/mail/src/team-invitation.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

async function fits(page: Page | Frame, context = 'Spanish public booking') {
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
        await fits(page, 'Spanish slot chips')
        await page.locator('.slots button').first().click()
        return
      }
    }
    await page.getByRole('button', { name: 'Mes siguiente', exact: true }).click()
  }
  throw new Error('No Spanish fixture availability within four months')
}

test('Spanish public booking, rescheduling, cancellation and embeds fit at 320px and desktop', async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'es'))
  await page.goto(app.url + app.personalPath)
  await expect(page.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await fits(page)
  await page.getByRole('button', { name: /Zona horaria/ }).click()
  await expect(page.getByPlaceholder('Buscar por ciudad o diferencia con UTC')).toBeVisible()
  await fits(page, 'Spanish time-zone panel')
  await page.getByRole('button', { name: /Zona horaria/ }).click()
  await chooseSlot(page)
  await expect(page.getByRole('heading', { name: 'Sus datos' })).toBeVisible()
  await page.getByLabel('Su nombre', { exact: true }).fill('Fixture Invitee')
  await page
    .getByLabel('Correo electrónico', { exact: true })
    .fill('fixture-invitee@hourmere.invalid')
  await fits(page, 'Spanish booking form labels and buttons')
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/bookings') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Confirmar reserva', exact: true }).click()
  const result = (await (await response).json()) as { manageToken?: unknown }
  expect(typeof result.manageToken === 'string').toBe(true)
  await expect(page.getByRole('heading', { name: 'Su reserva está confirmada' })).toBeVisible()
  expect((await app.bookingState()).bookerLocales).toEqual(['es'])
  await fits(page, 'Spanish confirmation')
  // Keep the private management capability in memory and out of test artifacts.
  await page.goto(`${app.url}/booking`)
  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString()
  }, result.manageToken as string)
  await page.getByRole('button', { name: 'Reprogramar', exact: true }).click()
  await chooseSlot(page)
  await expect(page.locator('dt').filter({ hasText: /^Horario anterior$/ })).toBeVisible()
  await expect(page.locator('dt').filter({ hasText: /^Nuevo horario$/ })).toBeVisible()
  await fits(page, 'Spanish move confirmation')
  if (testInfo.project.name === 'mobile') {
    // Larger font metrics reproduce narrow action-label overflow across host operating systems.
    const actions = page.locator('.manage-actions .button')
    await actions.evaluateAll((buttons) => {
      for (const button of buttons) (button as HTMLElement).style.fontSize = '22px'
    })
    try {
      await fits(page, 'Spanish move confirmation with larger fonts')
    } finally {
      await actions.evaluateAll((buttons) => {
        for (const button of buttons) (button as HTMLElement).style.removeProperty('font-size')
      })
    }
  }
  await page.getByRole('button', { name: 'Confirmar nuevo horario', exact: true }).click()
  await expect(
    page.getByText('Su reserva se ha reprogramado al nuevo horario.', { exact: true }),
  ).toBeVisible()
  await fits(page, 'Spanish moved booking')
  await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).click()
  await expect(page.getByRole('heading', { name: '¿Cancelar esta reserva?' })).toBeVisible()
  await page.getByLabel(/^Motivo/).fill('Motivo de prueba')
  await fits(page, 'Spanish cancellation form')
  await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reserva cancelada' })).toBeVisible()
  await fits(page, 'Spanish cancelled booking')
  await page.goto(`${app.parentUrl}/?language=es`)
  const iframe = page.locator('[data-hourmere-inline] > iframe')
  await expect(iframe).toHaveAttribute('title', 'Reservar una reunión con Hourmere')
  await expect(iframe.contentFrame().getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(iframe.contentFrame().locator('html')).toHaveAttribute('lang', 'es')
  const embedded = page.frames().find((frame) => frame.url().startsWith(`${app.url}/embed/`))
  expect(Boolean(embedded)).toBe(true)
  if (embedded) await fits(embedded, 'Spanish inline embed')
  await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reservar una reunión' })).toBeVisible()
  await fits(page, 'Spanish popup widget')
  await page.getByRole('button', { name: 'Cerrar la ventana de reserva' }).click()
})

test('all Spanish booking email kinds, invitation and direct sign-in renderer fit at 320px and desktop', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  const meeting = {
    eventName: 'Reunión para preparar el proyecto conjunto',
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
    cancelReason: 'La reunión debe reprogramarse.',
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
    for (const audience of ['invitee', 'guest', 'host'] as const) {
      const role = audience === 'host' ? 'host' : 'attendee'
      const message = bookingEmail(kind, meeting, {
        role,
        email: `${audience}@example.invalid`,
        timeZone: role === 'host' ? 'America/New_York' : 'Europe/Paris',
        locale: 'es',
        manageLinks: audience === 'invitee' ? links : undefined,
        answers: [],
      })
      await page.setContent(message.html ?? '')
      await expect(page.locator('html')).toHaveAttribute('lang', 'es')
      await fits(page, `Spanish ${audience} ${kind} email labels, buttons and header`)
    }
  const invitation = teamInvitationEmail({
    to: 'invitee@example.invalid',
    publicUrl: 'https://example.invalid',
    invitationId: '019a1234-5678-7000-8000-000000000001',
    teamName: 'Preparación del proyecto conjunto',
    inviterName: 'Fixture Host',
    expiresAt: '2026-11-03T12:00:00Z',
    language: 'es',
  })
  await page.setContent(invitation.html ?? '')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await fits(page, 'Spanish team invitation email labels, button and header')
  const signIn = magicLinkEmail({
    to: 'invitee@example.invalid',
    url: 'https://example.invalid/sign-in/confirm#token=fixture',
    expiresInMinutes: 5,
    language: 'es',
  })
  await page.setContent(signIn.html ?? '')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await fits(page, 'Spanish direct sign-in email labels, button and header')
})
