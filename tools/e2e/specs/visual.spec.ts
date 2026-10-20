import { AUDIT_NOW } from '../audit-data.ts'
import { type AuditPageId, openAuditPage, visualScreenshotOptions } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

// Linux owns these baselines. workflow_dispatch generates them for review; this task
// deliberately adds no PNGs. Project names distinguish 1280px and 390px captures.
const states = [
  'host',
  'booking',
  'manage',
  'manage-reschedule',
  'sign-in',
  'event-types',
  'event-type-editor',
  'availability-editor',
  'bookings',
  'booking-detail',
  'analytics',
  'settings',
] as const satisfies readonly AuditPageId[]

for (const theme of ['light', 'dark'] as const)
  for (const id of states)
    test(`${id} ${theme}`, async ({ page, app }) => {
      await page.clock.setFixedTime(new Date(AUDIT_NOW))
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await openAuditPage(page, app, id)
      await expect(page).toHaveScreenshot(`${id}-${theme}.png`, visualScreenshotOptions(page))
    })

// Chinese text wrapping is represented alongside the full English state set.
for (const theme of ['light', 'dark'] as const)
  for (const id of ['booking', 'event-type-editor', 'bookings'] as const)
    test(`${id} zh-CN ${theme}`, async ({ page, app }) => {
      await page.clock.setFixedTime(new Date(AUDIT_NOW))
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await openAuditPage(page, app, id, { locale: 'zh-CN' })
      await expect(page).toHaveScreenshot(`${id}-zh-CN-${theme}.png`, visualScreenshotOptions(page))
    })
