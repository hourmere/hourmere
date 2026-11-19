import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newManageToken, rescheduleHostBooking } from './bookings.ts'
import type { BookingNotifier, ServiceContext } from './context.ts'
import { cancelManagedBookingSeries } from './recurring-cancellation.ts'
import { createPublicBookingSeries } from './recurring-creation.ts'
import { expandRecurringRule } from './recurring-rules.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const first = '2026-11-02T09:00+00:00'
const later = Temporal.Instant.from('2026-11-02T11:00Z')
const timeZone = 'UTC'
const durationMinutes = 30
const rule = { pattern: 'weekly', count: 2 } as const

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Missing series race fixture value')
  return value
}

function pauseBeforeCommit() {
  const entered = Promise.withResolvers<number>()
  const resume = Promise.withResolvers<void>()
  const notify: BookingNotifier = async (trx) => {
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
    entered.resolve(required(rows[0]).pid)
    await resume.promise
  }
  return {
    notify,
    resume: () => resume.resolve(),
    pid: (completion: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        completion.then(() => {
          throw new Error('The service finished before reaching the transaction fence')
        }),
      ]),
  }
}

describe.skipIf(!serverUrl)('series cancellation races on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_can_races' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ timeZone })
    await fixtures.schedule(host.userId, { timeZone })
    const slug = 'series-race'
    const eventId = await fixtures.eventType(host.organizationId, host.userId, { slug })
    await db
      .updateTable('event_types')
      .set({
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 2 }),
      })
      .where('id', '=', eventId)
      .execute()
    const publicCtx = { db, now }
    const hostCtx: ServiceContext = {
      ...publicCtx,
      principal: {
        kind: 'session',
        sessionId: randomUUID(),
        user: { id: host.userId, name: 'Host', email: 'host@example.test' },
        organization: {
          id: host.organizationId,
          name: 'Personal',
          slug: 'personal',
          personal: true,
        },
      },
    }
    const create = (firstLocalStart = first, notifyWebhook?: BookingNotifier) =>
      createPublicBookingSeries(
        publicCtx,
        {
          handle: host.handle,
          slug,
          invitee: { name: 'Booker', email: 'booker@example.test', timeZone },
          firstLocalStart,
          rule,
          idempotencyKey: randomUUID(),
          expectedPreview: {
            eventRevision: '0',
            durationMinutes,
            rule,
            timeZone,
            occurrences: expandRecurringRule({
              firstLocalStart,
              rule,
              timeZone,
              durationMinutes,
              now: now(),
            }).map(({ ordinal, localStart, start, end, offset }) => ({
              ordinal,
              localStart,
              start: start?.toString() ?? null,
              end: end?.toString() ?? null,
              offset,
            })),
          },
        },
        { recurringBookingsEnabled: true, actorDigest: newManageToken().hash, notifyWebhook },
      )
    const series = await create()
    const [head, tail] = series.occurrences
    const token = required(series.manageToken)
    const input = { scope: 'all', expectedRevision: '1', idempotencyKey: randomUUID() } as const
    return {
      host,
      series,
      head: required(head),
      tail: required(tail),
      create,
      cancel: (notify?: BookingNotifier) =>
        cancelManagedBookingSeries({ ...publicCtx, notify }, token, input),
      move: (notify?: BookingNotifier) =>
        rescheduleHostBooking({ ...hostCtx, notify }, required(head).bookingId, { start: later }),
    }
  }

  async function holdRow(query: string, id: string) {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(query, [id])
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      return {
        pid: required(rows[0]).pid,
        async release() {
          try {
            await client.query('ROLLBACK')
          } finally {
            client.release()
          }
        },
      }
    } catch (error) {
      client.release(true)
      throw error
    }
  }

  async function waiterPids(blockers: readonly number[], waitEvent?: 'advisory') {
    const { rows } = await sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND pg_blocking_pids(pid) && ${blockers}::int[]
        AND (${waitEvent ?? null}::text IS NULL OR wait_event = ${waitEvent ?? null})
    `.execute(db)
    return rows.map(({ pid }) => pid)
  }

  async function waitForWaiter(pid: number, waitEvent?: 'advisory') {
    await expect.poll(() => waiterPids([pid], waitEvent), { timeout: 3000 }).toHaveLength(1)
  }

  it('locks the organization, series and member bookings in ordinal order', async () => {
    const f = await fixture()
    const locks: Awaited<ReturnType<typeof holdRow>>[] = []
    let settled: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      for (const [query, id] of [
        ['SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', f.host.organizationId],
        ['SELECT id FROM booking_series WHERE id = $1 FOR UPDATE', f.series.seriesId],
        ['SELECT id FROM bookings WHERE id = $1 FOR UPDATE', f.head.bookingId],
        ['SELECT id FROM bookings WHERE id = $1 FOR UPDATE', f.tail.bookingId],
      ] as const) {
        locks.push(await holdRow(query, id))
      }
      settled = Promise.allSettled([f.cancel()])
      while (locks.length) {
        const lock = required(locks[0])
        await waitForWaiter(lock.pid)
        locks.shift()
        await lock.release()
      }
      expect(await settled).toEqual([
        { status: 'fulfilled', value: expect.objectContaining({ revision: '2' }) },
      ])
    } finally {
      await Promise.all(locks.map((lock) => lock.release()))
      await settled
    }
  })

  it('rejects a stale cancellation after a concurrent member move commits', async () => {
    const f = await fixture()
    const fence = pauseBeforeCommit()
    const move = f.move(fence.notify)
    const moved = Promise.allSettled([move])
    let cancelled: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      const pid = await fence.pid(moved)
      cancelled = Promise.allSettled([f.cancel()])
      await waitForWaiter(pid)
    } finally {
      fence.resume()
      await moved
      await cancelled
    }
    const successor = (await move).booking
    expect(successor).toMatchObject({
      start: later.toString({ fractionalSecondDigits: 3 }),
      status: 'confirmed',
    })
    expect(await cancelled).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'series_changed' }) },
    ])
    const booking = await db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', f.tail.bookingId)
      .executeTakeFirstOrThrow()
    expect(booking.status).toBe('confirmed')
  })

  it('rejects a concurrent move after cancellation and replays the same action once', async () => {
    const f = await fixture()
    const fence = pauseBeforeCommit()
    const cancel = f.cancel(fence.notify)
    const cancelled = Promise.allSettled([cancel])
    let move: Promise<PromiseSettledResult<unknown>[]> | undefined
    let replay: ReturnType<typeof f.cancel> | undefined
    let replayed: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      const pid = await fence.pid(cancelled)
      move = Promise.allSettled([f.move()])
      await waitForWaiter(pid)
      const mover = required((await waiterPids([pid]))[0])
      replay = f.cancel()
      replayed = Promise.allSettled([replay])
      await expect.poll(() => waiterPids([pid, mover]), { timeout: 3000 }).toHaveLength(2)
    } finally {
      fence.resume()
      await cancelled
      await move
      await replayed
    }
    const result = await cancel
    expect(result).toMatchObject({ revision: '2', replayed: false })
    expect(result.affected.map(({ bookingId }) => bookingId)).toEqual([
      f.head.bookingId,
      f.tail.bookingId,
    ])
    expect(await move).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'booking_cancelled' }) },
    ])
    expect(await replay).toEqual({ ...result, replayed: true })
    const receipts = await db
      .selectFrom('booking_series_receipts')
      .select('id')
      .where('series_id', '=', f.series.seriesId)
      .where('operation_kind', '=', 'bulk_cancel')
      .execute()
    expect(receipts).toHaveLength(1)
  })

  it('cancels while creation holds the same host lock and frees the affected slots', async () => {
    const f = await fixture()
    await expect(f.create()).rejects.toMatchObject({ code: 'series_unavailable' })
    const fence = pauseBeforeCommit()
    const create = f.create('2026-11-02T11:00+00:00', fence.notify)
    const created = Promise.allSettled([create])
    let cancellation: Promise<PromiseSettledResult<unknown>[]> | undefined
    let replacement: ReturnType<typeof f.create> | undefined
    let replaced: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      const pid = await fence.pid(created)
      let completed = false
      cancellation = Promise.allSettled([f.cancel()]).then((result) => {
        completed = true
        return result
      })
      await expect.poll(() => completed, { timeout: 3000 }).toBe(true)
      expect(await cancellation).toEqual([
        { status: 'fulfilled', value: expect.objectContaining({ revision: '2' }) },
      ])
      replacement = f.create()
      replaced = Promise.allSettled([replacement])
      await waitForWaiter(pid, 'advisory')
    } finally {
      fence.resume()
      await created
      await cancellation
      await replaced
    }
    const concurrent = await create
    expect(concurrent.occurrences.map(({ status }) => status)).toEqual(['confirmed', 'confirmed'])
    const rebooked = await replacement
    expect(rebooked?.occurrences.map(({ start, status }) => ({ start, status }))).toEqual([
      { start: f.head.start, status: 'confirmed' },
      { start: f.tail.start, status: 'confirmed' },
    ])
  })
})
