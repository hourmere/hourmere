import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { defineJob } from './index.ts'
import {
  ROUTING_RETENTION_CRON,
  ROUTING_RETENTION_RUN,
  routingRetentionJob,
} from './routing-retention.ts'

type Factory = typeof routingRetentionJob

/** An isolated, guarded copy with one exactly-once replacement; the shipped file is untouched. */
function sourceCopy(before: string, after: string): Factory {
  let source = readFileSync(new URL('./routing-retention.ts', import.meta.url), 'utf8')
  expect(source.split(before), `mutation must match once: ${before}`).toHaveLength(2)
  source = source.replace(before, after)
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return guardCopy(
    new Function('z', 'defineJob', `${source}; return routingRetentionJob`)(
      z,
      defineJob,
    ) as Factory,
  )
}

const run = { id: 'test', attempt: 1, signal: new AbortController().signal }

/** Fake bounded batches: `receipts` full receipt batches, then version pages ending in null. */
function handlers(receipts: number, versions: (string | null)[]) {
  const calls: string[] = []
  let left = receipts
  const pages = [...versions]
  return {
    calls,
    purgeReceipts: vi.fn(async () => {
      calls.push('receipts')
      return { more: left-- > 0 }
    }),
    cleanupVersions: vi.fn(async (after: string | null) => {
      calls.push(`versions:${after ?? 'start'}`)
      return { next: pages.shift() ?? null }
    }),
    continueRetention: vi.fn(async (_payload: { versionsAfter?: string }) => {}),
  }
}

async function verifyRetention(factory: Factory) {
  // A drained run: receipts first, then the version sweep, and no successor.
  const a = randomUUID()
  const done = handlers(2, [a, null])
  const job = factory(done)
  expect(job.schedule).toEqual({ cron: '*/15 * * * *', payload: {} })
  expect(job.policy).toBe('stately')
  expect(job.retry).toEqual({ limit: 0 })
  await job.handler({}, run)
  expect(done.calls, 'receipts are purged before the version sweep').toEqual([
    'receipts',
    'receipts',
    'receipts',
    'versions:start',
    `versions:${a}`,
  ])
  expect(done.continueRetention).not.toHaveBeenCalled()

  // Nothing to do (no routing data): one call each, no successor.
  const idle = handlers(0, [null])
  await factory(idle).handler({}, run)
  expect(idle.calls).toEqual(['receipts', 'versions:start'])
  expect(idle.continueRetention).not.toHaveBeenCalled()

  // A receipt backlog: the run stops at its transaction bound and queues one successor.
  const backlog = handlers(10_000, [])
  await factory(backlog).handler({}, run)
  expect(backlog.purgeReceipts).toHaveBeenCalledTimes(ROUTING_RETENTION_RUN.transactions)
  expect(backlog.cleanupVersions).not.toHaveBeenCalled()
  expect(backlog.continueRetention.mock.calls).toEqual([[{}]])

  // A version backlog resumes after its cursor, and passes the new one on.
  const cursor = randomUUID()
  const pages = Array.from({ length: 1000 }, () => randomUUID())
  const sweep = handlers(0, pages)
  await factory(sweep).handler({ versionsAfter: cursor }, run)
  expect(sweep.calls[1]).toBe(`versions:${cursor}`)
  expect(sweep.purgeReceipts.mock.calls.length + sweep.cleanupVersions.mock.calls.length).toBe(
    ROUTING_RETENTION_RUN.transactions,
  )
  expect(sweep.continueRetention.mock.calls).toEqual([
    [{ versionsAfter: pages[ROUTING_RETENTION_RUN.transactions - 2] }],
  ])

  // Payloads carry a version cursor only.
  expect(job.payload.safeParse({}).success).toBe(true)
  expect(job.payload.safeParse({ versionsAfter: cursor }).success).toBe(true)
  expect(job.payload.safeParse({ answers: { name: 'Ada' } }).success).toBe(false)
  expect(job.payload.safeParse({ versionsAfter: 'not-a-version' }).success).toBe(false)
}

it('drains receipts before versions in bounded runs and queues a successor for backlog', async () => {
  expect(ROUTING_RETENTION_CRON).toBe('*/15 * * * *')
  expect(ROUTING_RETENTION_RUN).toEqual({ transactions: 100, budgetMs: 45_000 })
  await verifyRetention(routingRetentionJob)
})

it('stops at once when the worker shuts down', async () => {
  const controller = new AbortController()
  controller.abort()
  const stopped = handlers(5, [null])
  await routingRetentionJob(stopped).handler({}, { ...run, signal: controller.signal })
  expect(stopped.calls).toEqual([])
  expect(stopped.continueRetention).not.toHaveBeenCalled()
})

it.each([
  [
    'bound the transactions of one run',
    '        transactions < ROUTING_RETENTION_RUN.transactions &&\n',
    '',
  ],
  [
    'start the version sweep once receipts are drained',
    '        if (!(await handlers.purgeReceipts()).more) break',
    '        await handlers.purgeReceipts()',
  ],
  [
    'queue a successor for backlog',
    '      await handlers.continueRetention?.(after === null ? {} : { versionsAfter: after })',
    '',
  ],
  [
    'resume the version sweep where it stopped',
    '      let after = payload.versionsAfter ?? null',
    '      let after = null',
  ],
  ['refuse payload fields', 'payload: z.strictObject(', 'payload: z.looseObject('],
])('detects source-copy removal of retention protection: %s', async (_name, before, after) => {
  await expectKilled(sourceCopy(before, after), verifyRetention)
})
