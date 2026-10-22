import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { AUDIT_NOW } from '../tools/e2e/audit-data.ts'
import { prepareAuditLocale, settleAuditLayout, verifyAuditPath } from '../tools/e2e/audit-pages.ts'
import { SCREENSHOT_BOOKING_DAY, SCREENSHOT_INVITEE } from '../tools/e2e/screenshot-data.ts'
import { openScreenshotPage, productScreenshotOptions } from '../tools/e2e/screenshot-pages.ts'
import { screenshotCases } from '../tools/e2e/screenshot-plan.ts'

function sourceCopy(before: string, after: string) {
  const source = readFileSync('tools/e2e/screenshot-pages.ts', 'utf8')
  expect(source).toContain(before)
  const copy = stripTypeScriptTypes(source.replace(before, after))
    .replace(/^import .*\n/gm, '')
    .replace(/\bexport /g, '')
  return new Function(
    'AUDIT_NOW',
    'prepareAuditLocale',
    'settleAuditLayout',
    'verifyAuditPath',
    'SCREENSHOT_BOOKING_DAY',
    'SCREENSHOT_INVITEE',
    `${copy}; return {openScreenshotPage,productScreenshotOptions}`,
  )(
    AUDIT_NOW,
    prepareAuditLocale,
    settleAuditLayout,
    verifyAuditPath,
    SCREENSHOT_BOOKING_DAY,
    SCREENSHOT_INVITEE,
  ) as {
    openScreenshotPage: typeof openScreenshotPage
    productScreenshotOptions: typeof productScreenshotOptions
  }
}

async function verifyPreparation(open = openScreenshotPage) {
  for (const id of [...new Set(screenshotCases.map((shot) => shot.page))]) {
    const calls: unknown[][] = []
    const manageLink = { value: 'http://127.0.0.1:43123/booking#token=synthetic-private-marker' }
    let actualPath = ''
    const locator = (selector: string) => ({
      waitFor: async () => calls.push(['wait', selector]),
      first: () => locator(selector),
      nth: (index: number) => locator(`${selector}[${index}]`),
      click: async () => calls.push(['click', selector]),
      fill: async (value: string) => calls.push(['fill', selector, value]),
      evaluate: async (fn: (input: typeof manageLink) => void) => {
        fn(manageLink)
        calls.push(['sanitize', selector])
      },
    })
    const page = {
      clock: { setFixedTime: async (date: Date) => calls.push(['clock', date.toISOString()]) },
      addInitScript: async (fn: unknown, locale: string) => calls.push(['locale', fn, locale]),
      goto: async (url: string) => {
        actualPath = new URL(url).pathname
        calls.push(['goto', actualPath])
      },
      url: () => `http://127.0.0.1:43123${actualPath}`,
      locator,
      getByLabel: (label: string) => locator(label),
      getByRole: (_: string, options: { name: string }) => locator(options.name),
      waitForFunction: async () => calls.push(['ready']),
      evaluate: async (fn: { name: string }) => calls.push(['evaluate', fn.name]),
    }
    const app = {
      url: 'http://127.0.0.1:43123',
      screenshotState: async () => {
        calls.push(['seed'])
        return { bookingPath: '/avery/product-discovery', scheduleId: 'demo-schedule' }
      },
      auditSignIn: async (signedIn: boolean, locale: string) =>
        calls.push(['sign-in', signedIn, locale]),
    }
    await open(
      page as unknown as Parameters<typeof open>[0],
      app as unknown as Parameters<typeof open>[1],
      id,
    )
    const publicPage = ['booking', 'booking-form', 'confirmation'].includes(id)
    expect(calls.slice(0, 4), 'clock and English session before navigation').toEqual([
      ['clock', AUDIT_NOW],
      ['seed'],
      ['sign-in', !publicPage, 'en-US'],
      ['locale', prepareAuditLocale, 'en-US'],
    ])
    expect(actualPath, 'real requested route').toBe(
      publicPage
        ? '/avery/product-discovery'
        : id === 'availability'
          ? '/app/availability/demo-schedule'
          : `/app/${id}`,
    )
    if (publicPage) {
      expect(calls, 'fixed selected day').toContainEqual([
        'click',
        `button.day-available[data-day="${SCREENSHOT_BOOKING_DAY}"]`,
      ])
      expect(calls, 'visible time slots').toContainEqual(['wait', '.slots button'])
      if (id !== 'booking') {
        expect(calls, 'form step selected time').toContainEqual(['click', '.slots button'])
        expect(calls, 'synthetic form name').toContainEqual([
          'fill',
          'Your name',
          SCREENSHOT_INVITEE.name,
        ])
        expect(calls, 'synthetic form email').toContainEqual([
          'fill',
          'Email',
          SCREENSHOT_INVITEE.email,
        ])
      }
      if (id === 'confirmation') {
        expect(calls, 'real confirmation submission').toContainEqual(['click', 'Confirm booking'])
        expect(calls, 'confirmation capability readiness').toContainEqual([
          'wait',
          '.confirmation .manage-link input[readonly]',
        ])
        const linkWait = calls.findIndex(
          ([call, selector]) =>
            call === 'wait' && selector === '.confirmation .manage-link input[readonly]',
        )
        const linkSanitization = calls.findIndex(([call]) => call === 'sanitize')
        expect(
          linkSanitization,
          'sanitize only after the confirmation field is ready',
        ).toBeGreaterThan(linkWait)
        expect(manageLink.value, 'documentation hostname before capture').toMatch(
          /^https:\/\/hourmere\.example\.com\//,
        )
        expect(manageLink.value, 'stable fake manage link').toBe(
          'https://hourmere.example.com/booking#token=example-manage-link',
        )
      }
    } else if (id === 'availability') {
      expect(calls, 'availability details readiness').toContainEqual(['wait', 'Weekly hours'])
      expect(calls, 'availability overrides readiness').toContainEqual(['wait', 'Date overrides'])
    } else {
      expect(calls, 'all seeded rows ready').toContainEqual([
        'wait',
        `.table-${id === 'event-types' ? 'event-types' : 'bookings'} tbody tr[2]`,
      ])
    }
    expect(calls, 'loading statuses settled').toContainEqual(['ready'])
    expect(calls.at(-1), 'fonts and geometry settled last').toEqual([
      'evaluate',
      'settleAuditLayout',
    ])
  }
}

function verifyCapture(options = productScreenshotOptions) {
  const result = options()
  expect(result.animations, 'disabled animations').toBe('disabled')
  expect(result.caret, 'hidden caret').toBe('hide')
  expect(result.fullPage, 'whole page capture').toBe(true)
  expect(result.scale, 'retina capture').toBe('device')
}

describe('product screenshot preparation', () => {
  it('opens real fixture routes with fixed clock, English data and ready content', () =>
    verifyPreparation())
  it('freezes capture effects at 2x', () => verifyCapture())

  for (const [before, after] of [
    ['await page.clock.setFixedTime(new Date(AUDIT_NOW))', ''],
    ["await app.auditSignIn(!publicPage, 'en-US')", "await app.auditSignIn(false, 'en-US')"],
    ["await page.addInitScript(prepareAuditLocale, 'en-US' as const)", ''],
    ['button.day-available[data-day=', 'button.day-available[data-date='],
    ["await page.locator('.slots button').first().click()", ''],
    ["await page.getByLabel('Email', { exact: true }).fill(SCREENSHOT_INVITEE.email)", ''],
    ["await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()", ''],
    ['await manageLink.waitFor()', ''],
    ["input.value = 'https://hourmere.example.com/booking#token=example-manage-link'", ''],
    ["await page.locator('.table-bookings tbody tr').nth(2).waitFor()", ''],
    ['await page.evaluate(settleAuditLayout)', ''],
  ])
    it(`detects broken preparation: ${before}`, async () => {
      await expect(
        verifyPreparation(sourceCopy(before as string, after as string).openScreenshotPage),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    })

  for (const [before, after] of [
    ["animations: 'disabled'", "animations: 'allow'"],
    ["caret: 'hide'", "caret: 'initial'"],
    ["scale: 'device'", "scale: 'css'"],
    ['fullPage: true', 'fullPage: false'],
  ])
    it(`detects broken capture protection: ${before}`, () => {
      expect(() =>
        verifyCapture(sourceCopy(before as string, after as string).productScreenshotOptions),
      ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })
})
