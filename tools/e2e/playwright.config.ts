import { defineConfig } from '@playwright/test'

// Together with fixture teardown, suppress fallback and matcher failure DOM snapshots.
// Booking confirmations can contain a one-time private management link.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'

// Measurement lanes are opt-in and must never change the required functional suite. A
// project-level testIgnore replaces this list, so every project repeats it.
const measurementSpecs = '**/{layout,a11y,visual,cross-engine}.spec.ts'

export default defineConfig({
  testDir: './specs',
  testIgnore: [measurementSpecs],
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
    {
      name: 'desktop',
      testIgnore: [measurementSpecs, '**/site-layout.spec.ts'],
      use: { viewport: { width: 1280, height: 1000 } },
    },
    {
      name: 'mobile',
      testIgnore: [measurementSpecs, '**/site-layout.spec.ts'],
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'site-desktop',
      testMatch: 'site-layout.spec.ts',
      use: { viewport: { width: 1280, height: 1000 } },
    },
    {
      name: 'site-mobile',
      testMatch: 'site-layout.spec.ts',
      use: { viewport: { width: 360, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
})
