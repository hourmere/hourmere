import {
  cleanupTestDatabases,
  MIGRATED_PREFIX_ENV,
  MIGRATED_TEMPLATE_ENV,
  MIGRATED_TEMPLATE_SERVER_ENV,
} from '@hourmere/db/test-database-registry'
import { afterAll, inject } from 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's latest schema and predecessor template databases. */
    migratedTestTemplate?: { name: string; prefix: string; server: string }
  }
}

// Fixtures read the template from the environment: importing the database helpers here would
// load them before each file's vi.mock calls.
const template = inject('migratedTestTemplate')
if (template) {
  process.env[MIGRATED_TEMPLATE_ENV] = template.name
  process.env[MIGRATED_PREFIX_ENV] = template.prefix
  process.env[MIGRATED_TEMPLATE_SERVER_ENV] = template.server
} else {
  delete process.env[MIGRATED_TEMPLATE_ENV]
  delete process.env[MIGRATED_PREFIX_ENV]
  delete process.env[MIGRATED_TEMPLATE_SERVER_ENV]
}

// Registered before suite hooks; Vitest runs this after nested suite teardown, including
// failed beforeAll/test hooks. Explicit finally/drop remains the normal cleanup path.
// Some script tests opt into jsdom, whose module URLs cannot load the Node migration runner.
if (!('document' in globalThis)) {
  afterAll(() => cleanupTestDatabases(), 30_000)
}
