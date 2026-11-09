import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cancelHostBooking, createPublicBooking, rescheduleHostBooking } from './bookings.ts'
import { cancelTeamAdminBooking } from './team-bookings.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

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

  it.each(
    (['cancel', 'reschedule', 'team cancel'] as const).flatMap((operation) =>
      (['row', 'advisory'] as const).map((lock) => ({ operation, lock })),
    ),
  )(
    '$operation rejects a foreign occurrence before its $lock lock',
    async ({ operation, lock }) => {
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
      const team = await createTestTeam(db, [{ user: caller, role: 'admin' }])
      const notify = vi.fn()
      const request = (id: string) => {
        if (operation === 'cancel') return cancelHostBooking(ctx, id)
        if (operation === 'reschedule')
          return rescheduleHostBooking(ctx, id, {
            start: START.add({ hours: 1 }),
            idempotencyKey: randomUUID(),
          })
        return db
          .transaction()
          .execute((trx) =>
            cancelTeamAdminBooking(
              trx,
              { userId: caller.id, organizationId: team.id },
              id,
              () => NOW,
              { expectedOrganizationId: team.id, notify },
            ),
          )
      }
      // Include all error contract fields, including non-enumerable name/message,
      // but omit stack traces, which differ only by call site.
      const errorContract = (error: unknown) => {
        if (!(error instanceof Error)) throw new Error('Expected a rejected request')
        return { ...error, name: error.name, message: error.message, stack: undefined }
      }
      const unknownError = await request(randomUUID()).then(() => {
        throw new Error('Unknown booking unexpectedly succeeded')
      }, errorContract)
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
        if (lock === 'row')
          await blocker.query('select id from group_slots where id = $1 for update', [
            slot.group_slot_id,
          ])
        else
          await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `booking-host:${host.userId}`,
          ])
        const identity = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
        const pid = identity.rows[0]?.pid
        if (pid === undefined) throw new Error('Missing blocker backend')
        pending = request(seat.booking.id)
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
        expect(settled, 'foreign request must finish while its lock remains held').toBe(true)
        expect(result).toMatchObject({
          code: operation === 'team cancel' ? 'team_management_access_denied' : 'booking_not_found',
        })
        expect(errorContract(result)).toEqual(unknownError)
        expect(notify).not.toHaveBeenCalled()
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
