import { existsSync } from 'node:fs'
import { configDefaults, defineConfig } from 'vitest/config'

// Same .env as `npm run dev`, so database tests run locally instead of being skipped.
if (existsSync('.env')) process.loadEnvFile('.env')

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'apps/*/src/**/*.test.{ts,tsx}',
            'packages/*/src/**/*.test.ts',
            'scripts/**/*.test.ts',
            'tools/cli/src/**/*.test.ts',
          ],
          exclude: [...configDefaults.exclude, 'apps/web/**'],
        },
      },
      {
        // The web app's components, rendered in a simulated browser (jsdom).
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/src/test/setup.ts'],
        },
      },
    ],
  },
})
