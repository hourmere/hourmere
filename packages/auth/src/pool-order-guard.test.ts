import { createDb, createPool } from '@hourmere/db'
import {
  createTestDatabase,
  type TestDatabase,
  takePoolOrderViolations,
} from '@hourmere/db/testing'
import type { BetterAuthOptions } from 'better-auth'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reportPoolOrderViolations } from '../../../scripts/test-pool-order-setup.ts'
import config from '../../../vitest.config.ts'
import { createAuthPool } from './index.ts'
import { teamTransactionAdapter } from './team-native-atomicity.ts'

/** Self-test of the connection-order guard every node test runs under. */
describe('connection-order guard', () => {
  it('is registered for the node test project', () => {
    const node = config.test?.projects?.find(
      (project) =>
        typeof project === 'object' && 'test' in project && project.test?.name === 'node',
    ) as { test: { setupFiles: string[] } } | undefined
    expect(node?.test.setupFiles).toContain('scripts/test-pool-order-setup.ts')
  })
})

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('connection-order guard on real pools', () => {
  let owned: TestDatabase
  let authPool: pg.Pool
  let appPool: pg.Pool
  let transaction: (work: () => Promise<void>) => Promise<void>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'pool_guard' })
    authPool = createAuthPool(owned.url, { mode: 'closed', allowedDomains: [] })
    appPool = createPool(owned.url)
    // The production native transaction, as Better Auth opens it.
    const adapter = teamTransactionAdapter(createDb(authPool), (_trx, operation) => operation())(
      {} as BetterAuthOptions,
    )
    transaction = (work) =>
      (adapter.transaction as (callback: () => Promise<void>) => Promise<void>)(work)
  })
  afterAll(async () => {
    await Promise.all([authPool?.end(), appPool?.end()])
    await owned?.drop()
  })

  it('fails a test that asks another pool for a connection inside an auth transaction', async () => {
    await transaction(async () => {
      const client = await appPool.connect()
      client.release()
    })
    expect(() => reportPoolOrderViolations()).toThrow(
      /1 connection\(s\) requested from another pool while holding an auth transaction/,
    )
    // Reporting clears them, so the next test starts clean.
    expect(takePoolOrderViolations()).toEqual([])
  })

  it('records nothing for the auth pool inside, or for any pool outside, the transaction', async () => {
    await transaction(async () => {
      const client = await authPool.connect()
      client.release()
    })
    const client = await appPool.connect()
    client.release()
    expect(takePoolOrderViolations()).toEqual([])
    expect(() => reportPoolOrderViolations()).not.toThrow()
  })
})
