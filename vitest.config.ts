import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Same .env as `npm run dev`, so database tests run locally instead of being skipped.
if (existsSync('.env')) process.loadEnvFile('.env')

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
  },
})
