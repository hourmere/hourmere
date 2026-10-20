import type { Page } from '@playwright/test'
import { AUDIT_EMAIL, AUDIT_TITLE, visualMaskSelector, visualMaskText } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const auditPages = [
  { id: 'host', title: 'Public host' },
  { id: 'booking', title: 'Public booking' },
  { id: 'manage', title: 'Manage booking' },
  { id: 'manage-reschedule', title: 'Manage reschedule' },
  { id: 'sign-in', title: 'Sign in' },
  { id: 'event-types', title: 'Event types' },
  { id: 'event-type-editor', title: 'Event-type editor' },
  { id: 'availability-editor', title: 'Availability editor' },
  { id: 'bookings', title: 'Bookings list' },
  { id: 'booking-detail', title: 'Booking detail' },
  { id: 'analytics', title: 'Analytics' },
  { id: 'calendars', title: 'Calendars' },
  { id: 'conferences', title: 'Conferences' },
  { id: 'api-keys', title: 'API keys' },
  { id: 'connected-apps', title: 'Connected apps' },
  { id: 'settings', title: 'Settings' },
  { id: 'not-found', title: 'Not found' },
] as const

export type AuditPageId = (typeof auditPages)[number]['id']
export type AuditLocale = 'en-US' | 'zh-CN' | 'en-GB'
export function auditLocales(id: AuditPageId): readonly AuditLocale[] {
  return id === 'booking' ? ['en-US', 'zh-CN', 'en-GB'] : ['en-US', 'zh-CN']
}

const publicPages = new Set<AuditPageId>([
  'host',
  'booking',
  'manage',
  'manage-reschedule',
  'sign-in',
  'not-found',
])

export function prepareAuditLocale(selected: AuditLocale) {
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => selected })
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => [selected] })
  // An explicit "en" preference overrides the browser's regional date formatting.
  // Start from browser preferences so en-GB retains Monday-first and 24-hour time.
  localStorage.removeItem('hourmere-language')
  // biome-ignore lint/suspicious/noDocumentCookie: clear the product's synchronous preference cookie before application initialization
  document.cookie = 'hourmere-language=; Path=/; SameSite=Lax; Max-Age=0'
}

export function verifyAuditPath(actualUrl: string, expectedPath: string) {
  if (new URL(actualUrl).pathname !== expectedPath)
    throw new Error('Synthetic audit state opened an unexpected route')
}

async function verifyAuditContent(page: Page, id: AuditPageId) {
  switch (id) {
    case 'host':
      await page.locator('.event-card-title').filter({ hasText: AUDIT_TITLE }).waitFor()
      break
    case 'booking':
    case 'booking-detail':
      await page.getByRole('heading', { name: AUDIT_TITLE, exact: true }).waitFor()
      break
    case 'manage':
      await page.locator('.booking-details').getByText(AUDIT_TITLE, { exact: true }).waitFor()
      break
    case 'manage-reschedule':
      await page.locator('.reschedule-header p').filter({ hasText: AUDIT_TITLE }).waitFor()
      break
    case 'event-types':
      await page.getByText(AUDIT_TITLE, { exact: true }).waitFor()
      break
    case 'event-type-editor':
    case 'availability-editor': {
      const selector = id === 'event-type-editor' ? 'input#title' : 'input#name'
      const value = id === 'event-type-editor' ? AUDIT_TITLE : 'Synthetic working hours'
      await page.waitForFunction(
        ({ selector, value }) =>
          document.querySelector<HTMLInputElement>(selector)?.value === value,
        { selector, value },
      )
      break
    }
    case 'bookings':
      await page.getByText(AUDIT_EMAIL, { exact: true }).waitFor()
      break
    case 'analytics':
      await page.locator('#activity-summary').waitFor()
      break
    case 'calendars':
      await page.getByText(/^(No calendar accounts connected yet\.|尚未连接日历账号。)$/).waitFor()
      break
    case 'conferences':
      await page.getByText(/^(No Zoom accounts connected\.|尚未连接 Zoom 账号。)$/).waitFor()
      break
    case 'api-keys':
      await page.getByText(/^(You have no API keys yet\.|你尚无 API 密钥。)$/).waitFor()
      break
    case 'connected-apps':
      await page.getByText(/^(No connected apps\.|没有已连接的应用。)$/).waitFor()
      break
    case 'settings':
      await page
        .locator('section[aria-labelledby="account-heading"]')
        .getByText('synthetic-host@hourmere.invalid', { exact: true })
        .waitFor()
      break
    case 'sign-in':
      await page.locator('form input[type="email"]').waitFor()
      break
    case 'not-found':
      await page
        .getByRole('heading', { name: /^(Page not found|找不到页面)$/, exact: true })
        .waitFor()
      break
  }
}

/** Open real, helper-owned pages. No token-bearing URL ever reaches goto or an assertion. */
export async function openAuditPage(
  page: Page,
  app: FixtureApp,
  id: AuditPageId,
  { locale = 'en-US' }: { locale?: AuditLocale } = {},
): Promise<void> {
  try {
    const fixture = await app.auditState()
    await app.auditSignIn(!publicPages.has(id))
    await page.addInitScript(prepareAuditLocale, locale)
    const paths: Record<AuditPageId, string> = {
      host: '/fixture-host',
      booking: fixture.bookingPath,
      manage: '/booking',
      'manage-reschedule': '/booking',
      'sign-in': '/sign-in',
      'event-types': '/app/event-types',
      'event-type-editor': `/app/event-types/${fixture.eventTypeId}`,
      'availability-editor': `/app/availability/${fixture.scheduleId}`,
      bookings: '/app/bookings',
      'booking-detail': `/app/bookings/${fixture.bookingId}`,
      analytics: '/app/analytics',
      calendars: '/app/calendars',
      conferences: '/app/conferences',
      'api-keys': '/app/api-keys',
      'connected-apps': '/app/connected-apps',
      settings: '/app/settings',
      'not-found': '/audit/not/a/real/page',
    }
    await page.goto(app.url + paths[id])
    if (id === 'manage' || id === 'manage-reschedule') {
      await page.locator('h1').waitFor()
      await page.evaluate(
        ({ token, reschedule }) => {
          window.location.hash = new URLSearchParams({
            token,
            ...(reschedule ? { action: 'reschedule' } : {}),
          }).toString()
        },
        { token: fixture.manageToken, reschedule: id === 'manage-reschedule' },
      )
      await page
        .locator(id === 'manage-reschedule' ? '.reschedule-header' : '.booking-details')
        .waitFor()
      await page.waitForFunction(() => window.location.hash === '')
    } else await page.locator('h1').waitFor()
    if (id === 'booking' || id === 'manage-reschedule') {
      await page.locator('.calendar-month').waitFor()
      await page.locator('.calendar-grid[aria-busy="true"]').waitFor({ state: 'detached' })
    }
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('[role="status"]')].some((node) =>
          /^(Loading|加载|正在加载)/i.test(node.textContent?.trim() ?? ''),
        ),
    )
    verifyAuditPath(page.url(), paths[id])
    await verifyAuditContent(page, id)
    await page.evaluate(() => window.scrollTo(0, 0))
  } catch {
    // Browser errors can quote current URLs, DOM text, headers, or a manage capability.
    // This intentionally drops their message/cause while retaining a useful state id.
    throw new Error(`Could not prepare synthetic audit state: ${id}`)
  }
}

export function visualScreenshotOptions(page: Page) {
  return {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    fullPage: true,
    mask: [page.locator(visualMaskSelector), page.getByText(visualMaskText)],
    maskColor: '#808080',
  }
}
