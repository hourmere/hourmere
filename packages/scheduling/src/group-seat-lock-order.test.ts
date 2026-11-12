import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelManagedBooking, createPublicBooking, rescheduleManagedBooking } from './bookings.ts'
import type { PublicContext } from './context.ts'
import { createFixtures } from './testing.ts'

const NOW = Temporal.Instant.from('2027-10-31T12:00:00Z')
const START = Temporal.Instant.from('2027-11-01T09:00:00Z')
const GATE = 1752658798

describe.skipIf(!process.env.DATABASE_URL)('group seat cross-occurrence lock ordering', () => {
  let owned: TestDatabase
  let db: Db
  let ctx: PublicContext
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    ctx = { db, now: () => NOW }
    // Pause the actual seat-count trigger after it takes its source occurrence's row
    // lock. This adds no locks to the application before its normal lock helper runs.
    await owned.pool.query(`
      CREATE FUNCTION test_group_source_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.active_seats < OLD.active_seats THEN
          PERFORM pg_advisory_xact_lock(${GATE}, 1);
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER zz_test_group_source_gate AFTER UPDATE ON group_slots
        FOR EACH ROW EXECUTE FUNCTION test_group_source_gate();
    `)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function waitForBlocked(expected: number, round: number) {
    const deadline = Date.now() + 10_000
    let blocked = 0
    while (blocked !== expected && Date.now() < deadline) {
      const probe = await owned.pool.query<{ blocked: number }>(`
        SELECT count(DISTINCT l.pid)::integer AS blocked
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.datname = current_database() AND NOT l.granted
      `)
      blocked = probe.rows[0]?.blocked ?? 0
    }
    expect(blocked, `round ${round}: operations reached their lock barriers`).toBe(expected)
  }

  it('swaps opposite directions with a concurrent cancellation for twenty synchronized rounds', async () => {
    const f = createFixtures(db)
    for (let round = 0; round < 20; round++) {
      const host = await f.host()
      await f.schedule(host.userId)
      const eventId = await f.eventType(host.organizationId, host.userId, {
        slug: 'group',
        title: 'Class',
        durationMinutes: 30,
      })
      await db
        .updateTable('event_types')
        .set({ booking_mode: 'group', group_capacity: 2 })
        .where('id', '=', eventId)
        .execute()
      const target = START.add({ hours: 1 })
      const book = (email: string, start: Temporal.Instant) =>
        createPublicBooking(ctx, {
          handle: host.handle,
          slug: 'group',
          start,
          invitee: { name: email, email, timeZone: 'UTC' },
          idempotencyKey: randomUUID(),
        })
      const a = await book('a@example.test', START)
      const x = await book('x@example.test', START)
      const b = await book('b@example.test', target)
      await book('y@example.test', target)
      const blocker = await owned.pool.connect()
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock($1, 1)', [GATE])
        const moves = Promise.allSettled([
          rescheduleManagedBooking(ctx, a.manageToken ?? undefined, {
            start: target,
            idempotencyKey: randomUUID(),
          }),
          rescheduleManagedBooking(ctx, b.manageToken ?? undefined, {
            start: START,
            idempotencyKey: randomUUID(),
          }),
        ])
        // Real code: one transaction reaches the gate, the others wait for its host
        // lock. Without lockGroupBooking: both movers hold opposite source rows;
        // releasing the gate forces a real PostgreSQL deadlock, not a timing race.
        // Poll PostgreSQL's lock table, never a sleep or a guessed scheduling delay.
        pending = moves
        await waitForBlocked(2, round)
        const cancellation = Promise.allSettled([
          cancelManagedBooking(ctx, x.manageToken ?? undefined),
        ])
        pending = Promise.all([moves, cancellation]).then(([moved, cancelled]) => [
          ...moved,
          ...cancelled,
        ])
        await waitForBlocked(3, round)
        await blocker.query('COMMIT')
        const results = await pending
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(
              ['slot_taken', 'slot_unavailable'],
              `round ${round}: ${String(result.reason)}`,
            ).toContain(result.reason.code)
          }
        }
        expect(results[2]?.status).toBe('fulfilled')
        const slots = await db
          .selectFrom('group_slots')
          .selectAll()
          .where('original_event_type_id', '=', eventId)
          .execute()
        const seats = await db
          .selectFrom('bookings')
          .select(['id', 'group_slot_id', 'rescheduled_from_id'])
          .where('event_type_id', '=', eventId)
          .where('status', '=', 'confirmed')
          .execute()
        expect(seats).toHaveLength(3)
        for (const slot of slots) {
          expect(slot.active_seats).toBe(
            seats.filter((seat) => seat.group_slot_id === slot.id).length,
          )
          expect(slot.active_seats).toBeLessThanOrEqual(slot.capacity)
        }
        for (const mover of [a, b]) {
          expect(
            seats.filter(
              (seat) =>
                seat.id === mover.booking.id || seat.rescheduled_from_id === mover.booking.id,
            ),
          ).toHaveLength(1)
        }
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
        await pending
      }
    }
  }, 120_000)
})
