import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/app.test.ts', 'test/packaging.test.ts'] },
})
