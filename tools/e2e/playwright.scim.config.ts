import { defineConfig } from '@playwright/test'
import functional from './playwright.config.ts'

// Keep the plugin download and separate container out of the required browser shards.
export default defineConfig({
  ...functional,
  testDir: './keycloak',
  testMatch: 'scim.spec.ts',
  testIgnore: [],
  projects: [{ name: 'scim' }],
  workers: 1,
})
