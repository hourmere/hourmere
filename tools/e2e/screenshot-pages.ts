import type { Page } from '@playwright/test'
import { AUDIT_NOW } from './audit-data.ts'
import { prepareAuditLocale, settleAuditLayout, verifyAuditPath } from './audit-pages.ts'
import type { FixtureApp } from './fixtures.ts'
import type { screenshotCases } from './screenshot-plan.ts'

type ScreenshotPage = (typeof screenshotCases)[number]['page']

/** Only helper-owned data reaches these real pages; never navigate a manage capability. */
export async function openScreenshotPage(page: Page, app: FixtureApp, id: ScreenshotPage) {
  try {
    await page.clock.setFixedTime(new Date(AUDIT_NOW))
    const demo = await app.screenshotState()
    const publicPage = ['booking', 'booking-form', 'confirmation'].includes(id)
    await app.auditSignIn(!publicPage, 'en-US')
    await page.addInitScript(prepareAuditLocale, 'en-US' as const)
    const path = publicPage
      ? demo.bookingPath
      : id === 'availability'
        ? `/app/availability/${demo.scheduleId}`
        : `/app/${id}`
    await page.goto(app.url + path)
    await page.locator('h1').waitFor()
    verifyAuditPath(page.url(), path)
    if (publicPage) {
      await page.locator('.calendar-grid[aria-busy="true"]').waitFor({ state: 'detached' })
      await page.locator('button.day-available[data-day="2030-01-08"]').click()
      await page.locator('.slots button').first().waitFor()
      if (id !== 'booking') {
        await page.locator('.slots button').first().click()
        await page.getByLabel('Your name', { exact: true }).fill('Taylor Kim')
        await page.getByLabel('Email', { exact: true }).fill('taylor@hourmere.invalid')
        if (id === 'confirmation') {
          await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
          await page.locator('.confirmation .manage-link input[readonly]').waitFor()
        }
      }
    } else if (id === 'event-types') {
      await page.locator('.table-event-types tbody tr').nth(2).waitFor()
    } else if (id === 'availability') {
      await page.getByRole('heading', { name: 'Weekly hours', exact: true }).waitFor()
      await page.getByRole('heading', { name: 'Date overrides', exact: true }).waitFor()
      await page.waitForFunction(
        () => document.querySelector<HTMLInputElement>('#name')?.value === 'Working hours',
      )
    } else {
      await page.locator('.table-bookings tbody tr').nth(2).waitFor()
    }
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('[role="status"]')].some((node) =>
          /^Loading/i.test(node.textContent?.trim() ?? ''),
        ),
    )
    // Native focus outlines and auto-scroll depend on the last interaction.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      window.scrollTo(0, 0)
    })
    await page.evaluate(settleAuditLayout)
  } catch {
    // A Playwright error can quote the synthetic session or one-time manage URL.
    throw new Error(`Could not prepare product screenshot: ${id}`)
  }
}

export function productScreenshotOptions(page: Page) {
  return {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    fullPage: true,
    scale: 'device' as const,
    // Keep the actual confirmation UI, but never publish its random capability or port.
    mask: [page.locator('.manage-link input[readonly]')],
    maskColor: '#808080',
  }
}
