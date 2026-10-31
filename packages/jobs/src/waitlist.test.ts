import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJobs, defineJob, JobPayloadError } from './index.ts'
import { waitlistMaintenanceJobs } from './waitlist.ts'

const serverUrl = process.env.DATABASE_URL

function sourceCopy(before?: string, after?: string): typeof waitlistMaintenanceJobs {
  let source = readFileSync(new URL('./waitlist.ts', import.meta.url), 'utf8')
  if (before) {
    expect(source.includes(before)).toBe(true)
    source = source.replace(before, after ?? '')
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function('z', 'defineJob', `${source}; return waitlistMaintenanceJobs`)(z, defineJob)
}

async function verifyMaintenance(factory: typeof waitlistMaintenanceJobs) {
  const cleanup = vi.fn(async () => ({ more: true }))
  const continuation = vi.fn(async () => {})
  const definitions = factory({ scan: async () => {}, cleanup, continueCleanup: continuation })
  expect(definitions[0].payload.safeParse({ email: 'private@example.test' }).success).toBe(false)
  await definitions[1].handler({}, { id: 'test', attempt: 1, signal: new AbortController().signal })
  expect(cleanup).toHaveBeenCalledTimes(50)
  expect(continuation).toHaveBeenCalledTimes(1)
  cleanup.mockClear()
  cleanup.mockResolvedValue({ more: false })
  continuation.mockClear()
  await definitions[1].handler({}, { id: 'test', attempt: 1, signal: new AbortController().signal })
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(continuation).not.toHaveBeenCalled()
}

it('drains bounded cleanup pages and queues a successor instead of delaying backlog', async () => {
  await verifyMaintenance(sourceCopy())
})

it.each([
  ['reject contact-bearing payloads', '.strict()', ''],
  ['continue cleanup backlog', 'await handlers.continueCleanup?.()', ''],
  [
    'stop drained cleanup',
    'if (!(await handlers.cleanup()).more) return',
    'await handlers.cleanup()',
  ],
])('detects source-copy removal of maintenance protection: %s', async (_name, before, after) => {
  await expect(verifyMaintenance(sourceCopy(before, after))).rejects.toMatchObject({
    name: 'AssertionError',
  })
})

describe.skipIf(!serverUrl)('waitlist maintenance registration', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_jobs' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('installs recurring cache-only discovery/cleanup and refuses contact-bearing payloads', async () => {
    const scan = vi.fn(async () => {})
    const cleanup = vi.fn(async () => ({ more: false }))
    const definitions = waitlistMaintenanceJobs({ scan, cleanup })
    const jobs = createJobs({
      connectionString: owned.url,
      definitions,
      work: true,
      migrate: true,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log: () => {},
    })
    try {
      await jobs.start()
      await expect(
        jobs.enqueue('waitlist-discovery-v1', { email: 'private@example.test' } as never),
      ).rejects.toBeInstanceOf(JobPayloadError)
      await jobs.enqueue('waitlist-discovery-v1', {})
      await jobs.enqueue('waitlist-cleanup-v1', {})
      await vi.waitFor(
        () => {
          expect(scan).toHaveBeenCalled()
          expect(cleanup).toHaveBeenCalled()
        },
        { timeout: 10_000 },
      )
      const schedules = await owned.pool.query<{ name: string; cron: string; data: unknown }>(
        "SELECT name,cron,data FROM pgboss.schedule WHERE name IN ('waitlist-discovery-v1','waitlist-cleanup-v1') ORDER BY name",
      )
      expect(schedules.rows).toEqual([
        { name: 'waitlist-cleanup-v1', cron: '0 * * * *', data: {} },
        { name: 'waitlist-discovery-v1', cron: '* * * * *', data: {} },
      ])
    } finally {
      await jobs.stop()
    }
  }, 20_000)
})

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
