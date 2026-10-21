import { defineConfig, devices } from '@playwright/test'
import type { FixtureOptions } from './fixtures.ts'
import functional from './playwright.config.ts'

const suite = process.env.HOURMERE_UI_SUITE ?? 'layout'
if (!['layout', 'a11y', 'visual', 'cross-engine'].includes(suite)) {
  throw new Error('Unknown UI measurement suite')
}
// Playwright ignores undefined project overrides when merging use options.
// Remove Chrome at the parent level before selecting WebKit or Firefox.
const portableUse = { ...functional.use }
delete portableUse.channel

export default defineConfig<FixtureOptions>({
  ...functional,
  use: {
    ...(suite === 'cross-engine' ? portableUse : functional.use),
    uiAudit: suite !== 'cross-engine',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  testIgnore: [],
  testMatch: `**/${suite}.spec.ts`,
  timeout: ['layout', 'a11y'].includes(suite) ? 240_000 : 120_000,
  // Preserve only masked visual comparisons, never traces, video or failure DOM.
  preserveOutput: suite === 'visual' ? 'failures-only' : 'never',
  outputDir: `../../temp/ui-${suite}-results`,
  snapshotPathTemplate: '{testDir}/../snapshots/{projectName}/{arg}{ext}',
  expect: {
    ...functional.expect,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide' },
  },
  projects:
    suite === 'cross-engine'
      ? [
          {
            name: 'webkit-desktop',
            use: {
              browserName: 'webkit',
              viewport: { width: 1280, height: 720 },
            },
          },
          {
            name: 'webkit-iphone',
            use: { ...devices['iPhone 13'], browserName: 'webkit' },
          },
          {
            name: 'firefox-desktop',
            use: {
              browserName: 'firefox',
              viewport: { width: 1280, height: 720 },
            },
          },
        ]
      : suite === 'layout'
        ? [{ name: 'layout', use: { viewport: { width: 1280, height: 720 } } }]
        : [
            { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
            {
              name: 'mobile',
              use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
            },
          ],
})
