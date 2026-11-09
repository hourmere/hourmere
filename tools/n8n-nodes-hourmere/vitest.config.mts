import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The root suite checks the server OpenAPI contract without installing n8n.
    exclude: [...configDefaults.exclude, 'contract.test.ts'],
  },
})
