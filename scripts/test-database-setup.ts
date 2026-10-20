import { afterAll } from 'vitest'

// Registered before suite hooks; Vitest runs this after nested suite teardown, including
// failed beforeAll/test hooks. Explicit finally/drop remains the normal cleanup path.
// Some script tests opt into jsdom, whose module URLs cannot load the Node migration runner.
if (!('document' in globalThis)) {
  const { cleanupTestDatabases } = await import('@hourmere/db/testing')
  afterAll(() => cleanupTestDatabases(), 30_000)
}
