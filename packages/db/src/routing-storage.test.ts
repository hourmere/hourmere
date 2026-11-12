import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { routingFixture } from './routing-storage-fixtures.ts'
import { routingBehaviours, routingProtections } from './routing-storage-protections.ts'
import { checkQuotaRace } from './routing-storage-quota-races.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('routing storage', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await createTestDatabase(serverUrl as string)
  })
  afterAll(async () => {
    await db?.drop()
  })
  it.each(Object.keys(routingProtections))('%s', async (name) => {
    await routingProtections[name]?.check(await routingFixture(db.pool))
    expect(db.pool.totalCount).toBeLessThanOrEqual(2)
  })

  it.each(Object.keys(routingBehaviours))('%s', async (name) => {
    await routingBehaviours[name]?.(await routingFixture(db.pool))
    expect(db.pool.totalCount).toBeLessThanOrEqual(2)
  })

  it.each(['forms', 'versions'] as const)(
    'rejects a stale repeatable-read %s quota writer',
    async (kind) => {
      await checkQuotaRace(await routingFixture(db.pool), kind, true)
    },
  )
})
