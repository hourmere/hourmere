import { defineConfig } from '@playwright/test'

// Together with fixture teardown, suppress fallback and matcher failure DOM snapshots.
// Booking confirmations can contain a one-time private management link.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'

export default defineConfig({
  testDir: './specs',
  // Measurement lanes are opt-in and must never change the required functional suite.
  testIgnore: ['**/{layout,a11y,visual,cross-engine}.spec.ts'],
  fullyParallel: true,
  workers: 2,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 45000,
  expect: { timeout: 8000 },
  reporter: 'line',
  preserveOutput: 'never',
  outputDir: '../../temp/playwright-results',
  use: {
    channel: 'chrome',
    headless: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 1000 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
})
