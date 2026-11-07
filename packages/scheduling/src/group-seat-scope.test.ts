import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelHostBooking, createPublicBooking, rescheduleHostBooking } from './bookings.ts'
import { createFixtures, createTestUser, testContext } from './testing.ts'

const NOW = Temporal.Instant.from('2027-10-31T12:00:00Z')
const START = Temporal.Instant.from('2027-11-01T09:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('foreign group seat scope before locking', () => {
  let t: TestDatabase
  let db: Db
  beforeAll(async () => {
    t = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(t.pool)
  })
  afterAll(async () => {
    await t?.drop()
  })

  it.each(['cancel', 'reschedule'] as const)(
    '%s returns not-found without waiting for or locking a foreign occurrence',
    async (operation) => {
      const f = createFixtures(db)
      const host = await f.host()
      await f.schedule(host.userId)
      const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'class' })
      await db
        .updateTable('event_types')
        .set({ booking_mode: 'group', group_capacity: 2 })
        .where('id', '=', eventId)
        .execute()
      const seat = await createPublicBooking(
        { db, now: () => NOW },
        {
          handle: host.handle,
          slug: 'class',
          start: START,
          invitee: { name: 'Invitee', email: 'seat@example.test', timeZone: 'UTC' },
          idempotencyKey: randomUUID(),
        },
      )
      const caller = await createTestUser(db)
      const ctx = testContext(db, caller.principal, () => NOW)
      const slot = await db
        .selectFrom('bookings')
        .select('group_slot_id')
        .where('id', '=', seat.booking.id)
        .executeTakeFirstOrThrow()
      if (!slot.group_slot_id) throw new Error('Expected group occurrence')
      const blocker = await t.pool.connect()
      let result: unknown
      let settled = false
      let requestedForeignLock = false
      let pending: Promise<void> | undefined
      try {
        await blocker.query('begin')
        await blocker.query('select id from group_slots where id = $1 for update', [
          slot.group_slot_id,
        ])
        const identity = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
        const pid = identity.rows[0]?.pid
        if (pid === undefined) throw new Error('Missing blocker backend')
        pending = (
          operation === 'cancel'
            ? cancelHostBooking(ctx, seat.booking.id)
            : rescheduleHostBooking(ctx, seat.booking.id, {
                start: START.add({ hours: 1 }),
                idempotencyKey: randomUUID(),
              })
        )
          .then(
            (value) => {
              result = value
            },
            (error) => {
              result = error
            },
          )
          .finally(() => {
            settled = true
          })
        // Observe either completion or an actual PostgreSQL lock wait, never a timing sleep.
        const deadline = performance.now() + 10_000
        while (!settled && !requestedForeignLock && performance.now() < deadline) {
          const probe = await t.pool.query<{ waiting: boolean }>(
            `
            select exists (
              select 1 from pg_locks l
              where not l.granted and $1 = any(pg_blocking_pids(l.pid))
            ) as waiting`,
            [pid],
          )
          requestedForeignLock = probe.rows[0]?.waiting === true
        }
        expect(
          requestedForeignLock,
          'foreign occurrence must not be locked before scope rejection',
        ).toBe(false)
        expect(settled, 'foreign request must finish while occurrence row remains locked').toBe(
          true,
        )
        expect(result).toMatchObject({ code: 'booking_not_found' })
      } finally {
        await blocker.query('rollback')
        blocker.release()
        await pending
      }
      expect(
        (
          await db
            .selectFrom('group_slots')
            .select('active_seats')
            .where('id', '=', slot.group_slot_id)
            .executeTakeFirstOrThrow()
        ).active_seats,
      ).toBe(1)
    },
    20_000,
  )
})
