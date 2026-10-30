import type { Frame, Page } from '@playwright/test'
import { common as portuguese } from '../../../apps/web/src/i18n/catalogues/pt-BR/common.ts'
import { widget } from '../../../apps/web/src/i18n/catalogues/pt-BR/widget.ts'
import { type BookingEmailKind, bookingEmail } from '../../../packages/mail/src/booking.ts'
import { magicLinkEmail } from '../../../packages/mail/src/index.ts'
import { teamInvitationEmail } from '../../../packages/mail/src/team-invitation.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

async function fits(page: Page | Frame, context = 'Brazilian Portuguese public booking') {
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
        await fits(page, 'Brazilian Portuguese slot chips')
        await page.locator('.slots button').first().click()
        return
      }
    }
    await page.getByRole('button', { name: portuguese['Next month'], exact: true }).click()
  }
  throw new Error('No Brazilian Portuguese fixture availability within four months')
}

test('Brazilian Portuguese public booking, rescheduling, cancellation and embeds fit at 320px and desktop', async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  await page.addInitScript(() => localStorage.setItem('hourmere-language', 'pt-BR'))
  await page.goto(app.url + app.personalPath)
  await expect(page.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await fits(page)
  await page.getByRole('button', { name: new RegExp(portuguese['Time zone']) }).click()
  await expect(page.getByPlaceholder(portuguese['Search by city or offset'])).toBeVisible()
  await fits(page, 'Brazilian Portuguese time-zone panel')
  await page.getByRole('button', { name: new RegExp(portuguese['Time zone']) }).click()
  await chooseSlot(page)
  await expect(page.getByRole('heading', { name: portuguese['Your details'] })).toBeVisible()
  await page.getByLabel(portuguese['Your name'], { exact: true }).fill('Fixture Invitee')
  await page.getByLabel(portuguese.Email, { exact: true }).fill('fixture-invitee@hourmere.invalid')
  await fits(page, 'Brazilian Portuguese booking form labels and buttons')
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/bookings') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: portuguese['Confirm booking'], exact: true }).click()
  const result = (await (await response).json()) as { manageToken?: unknown }
  expect(typeof result.manageToken === 'string').toBe(true)
  await expect(page.getByRole('heading', { name: portuguese['You’re booked'] })).toBeVisible()
  expect((await app.bookingState()).bookerLocales).toEqual(['pt-BR'])
  await fits(page, 'Brazilian Portuguese confirmation')
  // Keep the private management capability in memory and out of test artifacts.
  await page.goto(`${app.url}/booking`)
  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString()
  }, result.manageToken as string)
  await page.getByRole('button', { name: portuguese.Reschedule, exact: true }).click()
  await chooseSlot(page)
  await expect(
    page.locator('dt').filter({ hasText: portuguese['reschedule.previousTime'] }),
  ).toBeVisible()
  await expect(
    page.locator('dt').filter({ hasText: portuguese['reschedule.newTime'] }),
  ).toBeVisible()
  await fits(page, 'Brazilian Portuguese move confirmation')
  if (testInfo.project.name === 'mobile') {
    // Larger font metrics reproduce narrow action-label overflow across host operating systems.
    const actions = page.locator('.manage-actions .button')
    await actions.evaluateAll((buttons) => {
      for (const button of buttons) (button as HTMLElement).style.fontSize = '22px'
    })
    try {
      await fits(page, 'Brazilian Portuguese move confirmation with larger fonts')
    } finally {
      await actions.evaluateAll((buttons) => {
        for (const button of buttons) (button as HTMLElement).style.removeProperty('font-size')
      })
    }
  }
  await page.getByRole('button', { name: portuguese['Confirm new time'], exact: true }).click()
  await expect(
    page.getByText(portuguese['Your booking is moved to the new time.'], { exact: true }),
  ).toBeVisible()
  await fits(page, 'Brazilian Portuguese moved booking')
  await page.getByRole('button', { name: portuguese['Cancel booking'], exact: true }).click()
  await expect(
    page.getByRole('heading', { name: portuguese['Cancel this booking?'] }),
  ).toBeVisible()
  await page.getByLabel(new RegExp(`^${portuguese.Reason}`)).fill('Motivo de teste')
  await fits(page, 'Brazilian Portuguese cancellation form')
  await page.getByRole('button', { name: portuguese['Cancel booking'], exact: true }).click()
  await expect(page.getByRole('heading', { name: portuguese['Cancelled booking'] })).toBeVisible()
  await fits(page, 'Brazilian Portuguese cancelled booking')
  await page.goto(`${app.parentUrl}/?language=pt-BR`)
  const iframe = page.locator('[data-hourmere-inline] > iframe')
  await expect(iframe).toHaveAttribute('title', widget.iframe)
  await expect(iframe.contentFrame().getByRole('heading', { name: 'Fixture call' })).toBeVisible()
  await expect(iframe.contentFrame().locator('html')).toHaveAttribute('lang', 'pt-BR')
  const embedded = page.frames().find((frame) => frame.url().startsWith(`${app.url}/embed/`))
  expect(Boolean(embedded)).toBe(true)
  if (embedded) await fits(embedded, 'Brazilian Portuguese inline embed')
  await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
  await expect(page.getByRole('dialog', { name: widget.title })).toBeVisible()
  await fits(page, 'Brazilian Portuguese popup widget')
  await page.getByRole('button', { name: widget.closeLabel }).click()
})

test('all Brazilian Portuguese booking email kinds, invitation and direct sign-in renderer fit at 320px and desktop', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'mobile' ? 320 : 1280,
    height: 900,
  })
  const meeting = {
    eventName: 'Reunião para preparar o projeto em conjunto',
    hostName: 'Fixture Host',
    inviteeName: 'Fixture Invitee',
    inviteeEmail: 'invitee@example.invalid',
    inviteeTimeZone: 'America/Sao_Paulo',
    start: Temporal.Instant.from('2026-11-02T14:00:00Z'),
    end: Temporal.Instant.from('2026-11-02T14:30:00Z'),
    previous: {
      start: Temporal.Instant.from('2026-11-01T14:00:00Z'),
      end: Temporal.Instant.from('2026-11-01T14:30:00Z'),
    },
    cancelReason: 'A reunião precisa ser reagendada.',
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
        timeZone: role === 'host' ? 'America/New_York' : 'America/Sao_Paulo',
        locale: 'pt-BR',
        manageLinks: audience === 'invitee' ? links : undefined,
        answers: [],
      })
      await page.setContent(message.html ?? '')
      await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
      await fits(page, `Brazilian Portuguese ${audience} ${kind} email labels, buttons and header`)
    }
  const invitation = teamInvitationEmail({
    to: 'invitee@example.invalid',
    publicUrl: 'https://example.invalid',
    invitationId: '019a1234-5678-7000-8000-000000000001',
    teamName: 'Preparação do projeto em conjunto',
    inviterName: 'Fixture Host',
    expiresAt: '2026-11-03T12:00:00Z',
    language: 'pt-BR',
  })
  await page.setContent(invitation.html ?? '')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await fits(page, 'Brazilian Portuguese team invitation email labels, button and header')
  const signIn = magicLinkEmail({
    to: 'invitee@example.invalid',
    url: 'https://example.invalid/sign-in/confirm#token=fixture',
    expiresInMinutes: 5,
    language: 'pt-BR',
  })
  await page.setContent(signIn.html ?? '')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await fits(page, 'Brazilian Portuguese direct sign-in email labels, button and header')
})
