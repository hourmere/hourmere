import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  expireRescheduleRequest,
  getHostBooking,
  getManagedBooking,
  newManageToken,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { BookingNotifier, ServiceContext } from './context.ts'
import { listManagedSlots } from './manage.ts'
import { createPublicBookingSeries } from './recurring-creation.ts'
import { expandRecurringRule } from './recurring-rules.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const { from } = Temporal.Instant
const now = () => from('2026-11-01T00:00Z')
const original = from('2026-11-02T09:00Z')
const later = original.add({ hours: 1 })
const invitee = { name: 'Booker', email: 'booker@example.test', timeZone: 'UTC' }

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing series fixture value')
  return value
}

describe.skipIf(!serverUrl)('series member lifecycle on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_lifecycle' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const slug = 'series-member'
    const event = await f.eventType(host.organizationId, host.userId, { slug })
    const timeZone = 'UTC'
    const rule = { pattern: 'weekly', count: 2 } as const
    const durationMinutes = 30
    const firstLocalStart = '2026-11-02T09:00+00:00'
    await db
      .updateTable('event_types')
      .set({
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 2 }),
      })
      .where('id', '=', event)
      .execute()
    const series = await createPublicBookingSeries(
      { db, now },
      {
        handle: host.handle,
        slug,
        invitee,
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
      { recurringBookingsEnabled: true, actorDigest: newManageToken().hash },
    )
    const root = required(series.occurrences[0]).bookingId
    const sibling = required(series.occurrences[1]).bookingId
    const notify = vi.fn<BookingNotifier>(async () => {})
    const publicCtx = { db, now, notify }
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
    const selector = (expectedRevision: string, ordinal = 1) => ({
      seriesManageToken: required(series.manageToken),
      ordinal,
      expectedRevision,
    })
    const revision = async () =>
      (
        await db
          .selectFrom('booking_series')
          .select('revision')
          .where('id', '=', series.seriesId)
          .executeTakeFirstOrThrow()
      ).revision
    const request = (id = root, idempotencyKey = randomUUID()) =>
      requestReschedule(hostCtx, id, { idempotencyKey, note: 'Please choose another time' })
    const emailToken = async () => {
      const { token, hash } = newManageToken()
      const booker = await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', root)
        .where('is_booker', '=', true)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('booking_notifications')
        .values({
          booking_id: root,
          kind: 'confirmed',
          recipient: `attendee:${booker.id}`,
          manage_token_hash: hash,
          outcome: 'sent',
        })
        .execute()
      return token
    }
    const events = () => notify.mock.calls.map(([, event]) => event)
    return {
      host,
      hostCtx,
      publicCtx,
      series,
      root,
      sibling,
      request,
      selector,
      revision,
      emailToken,
      events,
    }
  }

  it('retains ordinal, invitee move limits and ordinary notification events across member moves', async () => {
    const f = await fixture()
    const occurrenceToken = await f.emailToken()
    const hostMove = await rescheduleHostBooking(f.hostCtx, f.root, { start: later })
    expect(hostMove.manageToken).toBeNull()
    expect(await f.revision()).toBe('2')
    expect((await getHostBooking(f.hostCtx, f.root)).rescheduledToId).toBe(hostMove.booking.id)
    expect((await getManagedBooking(f.publicCtx, occurrenceToken)).id).toBe(hostMove.booking.id)
    expect((await getManagedBooking(f.publicCtx, f.selector('2', 2))).id).toBe(f.sibling)
    const next = later.add({ hours: 1 })
    expect(
      await listManagedSlots(f.publicCtx, f.selector('2'), { start: later, end: next }),
    ).not.toHaveLength(0)
    await expect(
      rescheduleManagedBooking(f.publicCtx, f.selector('1'), { start: next }),
    ).rejects.toMatchObject({ code: 'series_changed' })
    // The first invitee move counts even though neither the root nor the host successor
    // was issued an occurrence response token. The host move does not count.
    const oneMove = { ...f.publicCtx, bookingMaxInviteeReschedules: 1 }
    const inviteeMove = await rescheduleManagedBooking(oneMove, f.selector('2'), { start: next })
    expect(inviteeMove.manageToken).toBeNull()
    expect(await f.revision()).toBe('3')
    expect((await getManagedBooking(f.publicCtx, occurrenceToken)).id).toBe(inviteeMove.booking.id)
    expect((await getManagedBooking(f.publicCtx, f.selector('3'))).id).toBe(inviteeMove.booking.id)
    await expect(
      rescheduleManagedBooking(oneMove, occurrenceToken, { start: next.add({ hours: 1 }) }),
    ).rejects.toMatchObject({ code: 'booking_reschedule_limit' })
    expect((await cancelManagedBooking(f.publicCtx, occurrenceToken)).id).toBe(
      inviteeMove.booking.id,
    )
    expect(await f.revision()).toBe('4')
    expect((await getManagedBooking(f.publicCtx, f.selector('4'))).status).toBe('cancelled')
    expect((await getManagedBooking(f.publicCtx, f.selector('4', 2))).status).toBe('confirmed')
    expect(f.events()).toEqual([
      { type: 'rescheduled', bookingId: hostMove.booking.id, start: later },
      { type: 'rescheduled', bookingId: inviteeMove.booking.id, start: next },
      { type: 'cancelled', bookingId: inviteeMove.booking.id },
    ])
  })

  it('fences request replacement, stale retries and requests from a sibling ordinal', async () => {
    const f = await fixture()
    const key = randomUUID()
    const first = required((await f.request(f.root, key)).pendingReschedule).id
    await f.request(f.root, key)
    expect(await f.revision()).toBe('2')
    const replacement = required((await f.request()).pendingReschedule).id
    expect(await f.revision()).toBe('3')
    await expect(
      rescheduleManagedBooking(f.publicCtx, f.selector('2'), {
        start: later,
        rescheduleRequestId: first,
      }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    await expect(
      rescheduleManagedBooking(f.publicCtx, f.selector('2'), {
        start: later,
        rescheduleRequestId: replacement,
      }),
    ).rejects.toMatchObject({ code: 'series_changed' })
    const pick = (start = later) =>
      rescheduleManagedBooking(f.publicCtx, f.selector('3'), {
        start,
        rescheduleRequestId: replacement,
      })
    const moved = await pick()
    expect(moved.manageToken).toBeNull()
    await expect(pick()).resolves.toEqual(moved)
    await expect(pick(later.add({ hours: 1 }))).rejects.toMatchObject({
      code: 'reschedule_request_changed',
    })
    expect(await f.revision()).toBe('4')
    const siblingRequest = required((await f.request(f.sibling)).pendingReschedule).id
    const cancel = (ordinal: number) =>
      cancelManagedBooking(f.publicCtx, f.selector('5', ordinal), {
        rescheduleRequestId: siblingRequest,
      })
    await expect(cancel(1)).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    const cancelled = await cancel(2)
    expect(cancelled.id).toBe(f.sibling)
    await expect(cancel(2)).resolves.toEqual(cancelled)
    expect(await f.revision()).toBe('6')
    expect(f.events().map(({ type }) => type)).toEqual([
      'reschedule_requested',
      'reschedule_requested',
      'rescheduled',
      'reschedule_requested',
      'cancelled',
    ])
  })

  async function holdLock(query: string, value: string) {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(query, [value])
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

  async function isWaitingOn(pid: number) {
    const { rows } = await owned.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`,
      [pid],
    )
    return rows[0]?.waiting
  }

  it.each([
    'host move',
    'host cancel',
    'invitee move',
    'invitee cancel',
    'request create',
    'request replace',
    'request pick',
    'request cancel',
  ] as const)('takes organization, series and booking locks in order for %s', async (operation) => {
    const f = await fixture()
    const prior = ['request replace', 'request pick', 'request cancel'].includes(operation)
      ? required((await f.request()).pendingReschedule).id
      : undefined
    const selector = f.selector(await f.revision())
    const emailToken = await f.emailToken()
    const action = {
      'host move': () => rescheduleHostBooking(f.hostCtx, f.root, { start: later }),
      'host cancel': () => cancelHostBooking(f.hostCtx, f.root),
      'invitee move': () => rescheduleManagedBooking(f.publicCtx, emailToken, { start: later }),
      'invitee cancel': () => cancelManagedBooking(f.publicCtx, emailToken),
      'request create': () => f.request(),
      'request replace': () => f.request(),
      'request pick': () =>
        rescheduleManagedBooking(f.publicCtx, selector, {
          start: later,
          rescheduleRequestId: prior,
        }),
      'request cancel': () =>
        cancelManagedBooking(f.publicCtx, selector, { rescheduleRequestId: prior }),
    }[operation]
    const locks: Awaited<ReturnType<typeof holdLock>>[] = []
    let run: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      locks.push(
        await holdLock(
          'SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE',
          f.host.organizationId,
        ),
      )
      locks.push(
        await holdLock('SELECT id FROM booking_series WHERE id = $1 FOR UPDATE', f.series.seriesId),
      )
      locks.push(await holdLock('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', f.root))
      if (['host move', 'invitee move', 'request pick'].includes(operation))
        locks.push(
          await holdLock(
            "SELECT pg_advisory_xact_lock(hashtextextended('booking-host:' || $1, 0))",
            f.host.userId,
          ),
        )
      if (['host cancel', 'invitee cancel', 'request cancel'].includes(operation))
        locks.push(
          await holdLock(
            'SELECT booking_id FROM booking_hosts WHERE booking_id = $1 FOR UPDATE',
            f.root,
          ),
        )
      run = Promise.allSettled([action()])
      while (locks.length) {
        const lock = required(locks[0])
        await expect.poll(() => isWaitingOn(lock.pid), { timeout: 1500 }).toBe(true)
        locks.shift()
        await lock.release()
      }
      expect(await run).toEqual([{ status: 'fulfilled', value: expect.anything() }])
      expect(await f.revision()).toBe(prior ? '3' : '2')
    } finally {
      await Promise.all(locks.map((lock) => lock.release()))
      await run
    }
  })

  it('expiry waits for the member and completes while organization and series rows stay locked', async () => {
    const f = await fixture()
    const pending = required((await f.request()).pendingReschedule)
    const locks: Awaited<ReturnType<typeof holdLock>>[] = []
    let run: Promise<PromiseSettledResult<void>[]> | undefined
    let finished = false
    try {
      locks.push(
        await holdLock(
          'SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE',
          f.host.organizationId,
        ),
      )
      locks.push(
        await holdLock('SELECT id FROM booking_series WHERE id = $1 FOR UPDATE', f.series.seriesId),
      )
      const member = await holdLock('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', f.root)
      locks.push(member)
      run = Promise.allSettled([
        expireRescheduleRequest({ ...f.publicCtx, now: () => from(pending.expiresAt) }, pending.id),
      ]).finally(() => {
        finished = true
      })
      await expect.poll(() => isWaitingOn(member.pid), { timeout: 1500 }).toBe(true)
      locks.pop()
      await member.release()
      await expect.poll(() => finished, { timeout: 1500 }).toBe(true)
      expect(await run).toEqual([{ status: 'fulfilled', value: undefined }])
      expect(await f.revision()).toBe('2')
      expect(f.events().at(-1)).toEqual({
        type: 'reschedule_request_expired',
        bookingId: f.root,
        requestId: pending.id,
      })
    } finally {
      await Promise.all(locks.map((lock) => lock.release()))
      await run
    }
  })

  it.each(['series', 'occurrence'] as const)(
    'serializes a host move against a cancellation using the %s token',
    async (mode) => {
      const f = await fixture()
      const token = mode === 'series' ? f.selector('1') : await f.emailToken()
      const entered = Promise.withResolvers<number>()
      const release = Promise.withResolvers<void>()
      const move = rescheduleHostBooking(
        {
          ...f.hostCtx,
          async notify(trx, event, at) {
            const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
            entered.resolve(required(rows[0]).pid)
            await release.promise
            await f.publicCtx.notify(trx, event, at)
          },
        },
        f.root,
        { start: later },
      )
      const moveResult = Promise.allSettled([move])
      let cancelled: Promise<unknown> | undefined
      try {
        const pid = await Promise.race([
          entered.promise,
          move.then(() => {
            throw new Error('Missed write fence')
          }),
        ])
        cancelled = cancelManagedBooking(f.publicCtx, token).catch((error: unknown) => error)
        await expect.poll(() => isWaitingOn(pid), { timeout: 1500 }).toBe(true)
      } finally {
        release.resolve()
        await moveResult
        await cancelled
      }
      const moved = await move
      if (mode === 'series') {
        expect(await cancelled).toMatchObject({ code: 'series_changed' })
        expect(await f.revision()).toBe('2')
        expect(f.events().map(({ type }) => type)).toEqual(['rescheduled'])
      } else {
        expect(await cancelled).toMatchObject({ id: moved.booking.id, status: 'cancelled' })
        expect(await f.revision()).toBe('3')
        expect(f.events().map(({ type }) => type)).toEqual(['rescheduled', 'cancelled'])
      }
      expect((await getManagedBooking(f.publicCtx, f.selector('3'))).id).toBe(moved.booking.id)
      expect((await getManagedBooking(f.publicCtx, f.selector('3', 2))).status).toBe('confirmed')
    },
  )
})
