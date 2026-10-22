import { defineConfig } from '@playwright/test'
import functional from './playwright.config.ts'

// Separate from functional tests and UI audit baselines: these are public docs assets.
export default defineConfig({
  ...functional,
  testDir: './screenshots',
  testMatch: 'capture.spec.ts',
  testIgnore: [],
  projects: [{ name: 'product' }],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  outputDir: '../../temp/product-screenshot-results',
  use: {
    ...functional.use,
    // GPU rounded-border antialiasing can exceed the PNG tolerance; pin CPU rasterization.
    launchOptions: { args: ['--disable-gpu-rasterization'] },
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  },
})
