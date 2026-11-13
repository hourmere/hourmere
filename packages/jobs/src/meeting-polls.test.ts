import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJobs, defineJob, JobPayloadError } from './index.ts'
import { meetingPollCleanupJob } from './meeting-polls.ts'

const serverUrl = process.env.DATABASE_URL

function sourceCopy(before?: string, after?: string): typeof meetingPollCleanupJob {
  let source = readFileSync(new URL('./meeting-polls.ts', import.meta.url), 'utf8')
  if (before) {
    expect(source.split(before).length - 1, `mutation matches once: ${before}`).toBe(1)
    source = source.replace(before, after ?? '')
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function('z', 'defineJob', `${source}; return meetingPollCleanupJob`)(z, defineJob)
}

const run = (signal = new AbortController().signal) => ({ id: 'test', attempt: 1, signal })

async function verifyCleanupJob(factory: typeof meetingPollCleanupJob) {
  let pages = 0
  const cleanup = vi.fn(async () => {
    pages++
    expect(pages, 'one run stops after 50 pages').toBeLessThanOrEqual(50)
    return { more: true }
  })
  const continuation = vi.fn(async () => {})
  const definition = factory({ cleanup, continueCleanup: continuation })
  expect(definition.payload.safeParse({ pollId: 'any' }).success, 'payload carries nothing').toBe(
    false,
  )
  expect(definition.schedule, 'hourly sweep').toEqual({ cron: '0 * * * *', payload: {} })
  // A backlog drains in bounded pages, then queues exactly one successor.
  await definition.handler({}, run())
  expect(cleanup).toHaveBeenCalledTimes(50)
  expect(continuation).toHaveBeenCalledTimes(1)
  // A drained page ends the run without a successor.
  cleanup.mockClear()
  cleanup.mockImplementation(async () => ({ more: false }))
  continuation.mockClear()
  await definition.handler({}, run())
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(continuation).not.toHaveBeenCalled()
  // A shutting-down worker starts no page.
  cleanup.mockClear()
  const aborted = new AbortController()
  aborted.abort()
  await definition.handler({}, run(aborted.signal))
  expect(cleanup).not.toHaveBeenCalled()
}

it('drains bounded cleanup pages and queues one successor for a backlog', async () => {
  await verifyCleanupJob(meetingPollCleanupJob)
  await verifyCleanupJob(sourceCopy())
})

it.each([
  ['refuses payloads', '.strict()', ''],
  ['caps the pages of one run', 'page < 50 && ', ''],
  ['continues a backlog', 'await handlers.continueCleanup?.()', ''],
  [
    'stops once drained',
    'if (!(await handlers.cleanup()).more) return',
    'await handlers.cleanup()',
  ],
  ['stops on shutdown', '        if (signal.aborted) return\n', ''],
])('detects a source copy that no longer %s', async (_name, before, after) => {
  await expect(verifyCleanupJob(sourceCopy(before, after))).rejects.toMatchObject({
    name: 'AssertionError',
  })
})

describe.skipIf(!serverUrl)('meeting poll cleanup registration', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_jobs' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('installs the hourly schedule and runs queued cleanups', async () => {
    const cleanup = vi.fn(async () => ({ more: false }))
    const jobs = createJobs({
      connectionString: owned.url,
      definitions: [meetingPollCleanupJob({ cleanup })],
      work: true,
      migrate: true,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log: () => {},
    })
    try {
      await jobs.start()
      await expect(
        jobs.enqueue('meeting-poll-cleanup-v1', { pollId: 'any' } as never),
      ).rejects.toBeInstanceOf(JobPayloadError)
      await jobs.enqueue('meeting-poll-cleanup-v1', {})
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalled(), { timeout: 10_000 })
      const schedules = await owned.pool.query<{ name: string; cron: string; data: unknown }>(
        "SELECT name,cron,data FROM pgboss.schedule WHERE name = 'meeting-poll-cleanup-v1'",
      )
      expect(schedules.rows).toEqual([
        { name: 'meeting-poll-cleanup-v1', cron: '0 * * * *', data: {} },
      ])
    } finally {
      await jobs.stop()
    }
  }, 20_000)
})
