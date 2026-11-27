import { AUDIT_NOW } from '../audit-data.ts'
import { type AuditPageId, openAuditPage, visualScreenshotOptions } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

// Linux generates these baselines for review. Project names distinguish desktop and phone.
const bookingStates = [
  'booking', // Icon alignment, shared type scale and the full-width phone layout.
  'booking-time-zone', // Globe alignment and the type scale inside the expanded zone picker.
  'booking-form', // The phone confirmation bar and the form's shared type scale.
  'booking-confirmation', // The same type scale on the completed booking.
  'team-booking', // Shared metadata beside the long team name.
  'embedded-booking', // Shared metadata and typography within the embedded frame.
] as const satisfies readonly AuditPageId[]

const states = [
  'host',
  ...bookingStates,
  'manage',
  'manage-reschedule',
  'sign-in',
  'event-types',
  'admin-account-menu',
  'admin-integrations',
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
  for (const id of [
    ...bookingStates,
    'event-type-editor',
    'bookings',
    'admin-account-menu',
    'admin-integrations',
  ] as const)
    test(`${id} zh-CN ${theme}`, async ({ page, app }) => {
      await page.clock.setFixedTime(new Date(AUDIT_NOW))
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await openAuditPage(page, app, id, { locale: 'zh-CN' })
      await expect(page).toHaveScreenshot(`${id}-zh-CN-${theme}.png`, visualScreenshotOptions(page))
    })
