import { describe, expect, it } from 'vitest'
import { createTestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('createTestDatabase', () => {
  it('creates a migrated database whose connections do not wait for the disk, and drops it', async () => {
    const testDb = await createTestDatabase(serverUrl as string)
    try {
      const setting = await testDb.pool.query<{ synchronous_commit: string }>(
        'SHOW synchronous_commit',
      )
      expect(setting.rows).toEqual([{ synchronous_commit: 'off' }])
      const migrated = await testDb.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM schema_migrations',
      )
      expect(migrated.rows[0]?.n).toBeGreaterThan(0)
    } finally {
      await testDb.drop()
    }
  })
})
