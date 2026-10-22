import { join } from 'node:path'
import { expect, test } from '../fixtures.ts'
import { SCREENSHOT_BOOKING_DAY } from '../screenshot-data.ts'
import { openScreenshotPage, productScreenshotOptions } from '../screenshot-pages.ts'
import { screenshotCases } from '../screenshot-plan.ts'

const directory = process.env.HOURMERE_SCREENSHOT_DIR
if (!directory) throw new Error('Run npm run screenshots from the repository root')

for (const shot of screenshotCases)
  test.describe(shot.name, () => {
    test.use({
      colorScheme: shot.theme,
      viewport: shot.viewport,
      isMobile: shot.isMobile,
      hasTouch: shot.isMobile,
    })
    test('capture', async ({ page, app }) => {
      await openScreenshotPage(page, app, shot.page)
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      if (shot.page === 'booking') {
        await expect(page.locator(`button[data-day="${SCREENSHOT_BOOKING_DAY}"]`)).toHaveClass(
          /day-selected/,
        )
        await expect(page.locator('.slots button').first()).toBeVisible()
      }
      if (shot.page === 'confirmation')
        await expect(page.locator('.confirmation .manage-link input[readonly]')).toHaveValue(
          /^https:\/\/hourmere\.example\.com\//,
        )
      await page.screenshot({
        ...productScreenshotOptions(),
        path: join(directory, shot.name),
      })
    })
  })
