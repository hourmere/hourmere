// Drive the real bookings -> sync_booking_hosts -> waitlist signal cascade.
// Test-only gates pause each writer after its first host, so success is based on
// observed PostgreSQL locks rather than how quickly concurrent queries happen to run.
import { readFileSync } from 'node:fs'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const GATE = 1752658797
const ROUNDS = 30

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture value')
  return value
}

describe.skipIf(!serverUrl)('non-blocking waitlist booking signals', { timeout: 120_000 }, () => {
  let testDb: TestDatabase
  let hostIds: string[]
  let eventIds: string[]
  let bookingIds: string[]

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_signal' })
    const f = createFixtures(createDb(testDb.pool))
    const hosts = await Promise.all([f.host(), f.host()])
    const owner = required(hosts[0])
    hostIds = hosts.map((host) => host.userId).sort()
    eventIds = []
    for (const host of hosts) {
      const eventId = await f.eventType(host.organizationId, host.userId)
      await testDb.pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [eventId])
      eventIds.push(eventId)
    }
    bookingIds = [
      await f.booking(owner.organizationId, hostIds, '2026-11-02T08:00Z', '2026-11-02T08:30Z'),
      await f.booking(owner.organizationId, hostIds, '2026-11-02T09:00Z', '2026-11-02T09:30Z'),
    ]
    // PostgreSQL runs same-kind row triggers by name. This runs after the real
    // booking_hosts_waitlist_signal, once per writer, without replacing its code.
    await testDb.pool.query(`
      CREATE FUNCTION waitlist_test_first_host_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE gate text := current_setting('hourmere_test.waitlist_gate',true);
      BEGIN
        IF nullif(gate,'') IS NOT NULL
          AND current_setting('hourmere_test.waitlist_seen',true) IS DISTINCT FROM 'true' THEN
          PERFORM set_config('hourmere_test.waitlist_seen','true',true);
          PERFORM pg_advisory_xact_lock(${GATE},gate::integer);
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER zz_waitlist_test_first_host_gate AFTER UPDATE ON booking_hosts
        FOR EACH ROW EXECUTE FUNCTION waitlist_test_first_host_gate();
    `)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  async function writer(client: pg.PoolClient, bookingId: string) {
    try {
      await client.query('UPDATE bookings SET start_at=start_at WHERE id=$1', [bookingId])
      await client.query('COMMIT')
      return 'committed'
    } catch (error) {
      await client.query('ROLLBACK')
      return (error as { code?: string }).code ?? String(error)
    }
  }

  async function assertConcurrentUpdates(order: 'reversed' | 'sorted', rounds = ROUNDS) {
    // One fixture pool, with only these three held clients plus one observer.
    const controller = await testDb.pool.connect()
    const left = await testDb.pool.connect()
    const right = await testDb.pool.connect()
    const outcomes: { round: number; waitsForOtherBooking: boolean; results: string[] }[] = []
    try {
      const pids = await Promise.all(
        [controller, left, right].map(async (client) =>
          Number(
            (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
          ),
        ),
      )
      const controllerPid = required(pids[0])
      const leftPid = required(pids[1])
      const rightPid = required(pids[2])
      for (let round = 0; round < rounds; round++) {
        // Reset this owned fixture's four host rows to a known physical order.
        // Sequential scans below preserve it even after earlier UPDATEs move tuples.
        await testDb.pool.query('TRUNCATE booking_hosts')
        for (let booking = 0; booking < bookingIds.length; booking++) {
          const users = booking === 1 && order === 'reversed' ? [...hostIds].reverse() : hostIds
          for (const userId of users) {
            await testDb.pool.query(
              'INSERT INTO booking_hosts(booking_id,user_id) VALUES ($1,$2)',
              [bookingIds[booking], userId],
            )
          }
          const { rows } = await testDb.pool.query<{ user_id: string }>(
            'SELECT user_id FROM booking_hosts WHERE booking_id=$1 ORDER BY ctid',
            [bookingIds[booking]],
          )
          expect(rows.map((row) => row.user_id)).toEqual(users)
        }
        await controller.query('BEGIN')
        await controller.query('SELECT pg_advisory_xact_lock($1,1),pg_advisory_xact_lock($1,2)', [
          GATE,
        ])
        await Promise.all(
          [left, right].map(async (client, index) => {
            await client.query('BEGIN')
            await client.query('SET LOCAL statement_timeout=5000')
            await client.query('SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off')
            await client.query(
              "SELECT set_config('hourmere_test.waitlist_gate',$1,true),set_config('hourmere_test.waitlist_seen','false',true)",
              [String(index + 1)],
            )
          }),
        )
        const pending = [
          writer(left, required(bookingIds[0])),
          writer(right, required(bookingIds[1])),
        ]
        let waitsForOtherBooking = false
        try {
          await expect
            .poll(
              async () => {
                const { rows } = await testDb.pool.query<{ left: number[]; right: number[] }>(
                  'SELECT pg_blocking_pids($1) AS left,pg_blocking_pids($2) AS right',
                  [leftPid, rightPid],
                )
                const blocked = required(rows[0])
                waitsForOtherBooking =
                  blocked.left.includes(rightPid) || blocked.right.includes(leftPid)
                const bothAtGate =
                  blocked.left.includes(controllerPid) && blocked.right.includes(controllerPid)
                const serializedAtGate =
                  (blocked.left.includes(rightPid) && blocked.right.includes(controllerPid)) ||
                  (blocked.right.includes(leftPid) && blocked.left.includes(controllerPid))
                return bothAtGate || serializedAtGate
              },
              { timeout: 4000, interval: 1 },
            )
            .toBe(true)
        } finally {
          await controller.query('ROLLBACK')
          const results = await Promise.all(pending)
          outcomes.push({ round, waitsForOtherBooking, results })
        }
      }
      expect(
        outcomes.filter(
          (outcome) =>
            outcome.waitsForOtherBooking || outcome.results.some((r) => r !== 'committed'),
        ),
        'booking dirty signals must not block another booking or cause 40P01',
      ).toEqual([])
      expect(outcomes).toHaveLength(rounds)
    } finally {
      await Promise.all([controller, left, right].map((client) => client.query('ROLLBACK')))
      controller.release()
      left.release()
      right.release()
    }
  }

  it.each(['reversed', 'sorted'] as const)(
    'commits 30 concurrent booking updates with %s host row order',
    async (order) => {
      await assertConcurrentUpdates(order)
    },
  )

  async function assertScannerDoesNotBlock() {
    // Check an actual scanner row lock as well: booking progress must not depend
    // on scanner transaction length, even during the short publication phase.
    await testDb.pool.query(
      'INSERT INTO waitlist_scan_work(event_type_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING',
      [eventIds],
    )
    const scanner = await testDb.pool.connect()
    const left = await testDb.pool.connect()
    const right = await testDb.pool.connect()
    let pending: Promise<string>[] = []
    try {
      await scanner.query('BEGIN')
      await scanner.query(
        'SELECT event_type_id FROM waitlist_scan_work WHERE event_type_id=ANY($1) FOR UPDATE',
        [eventIds],
      )
      const clients = [scanner, left, right]
      const pids = await Promise.all(
        clients.map(async (client) =>
          Number(
            (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
          ),
        ),
      )
      await Promise.all(
        [left, right].map((client) => client.query('BEGIN; SET LOCAL statement_timeout=5000')),
      )
      const completed = [false, false]
      pending = [left, right].map((client, index) =>
        writer(client, required(bookingIds[index])).then((result) => {
          completed[index] = true
          return result
        }),
      )
      let blockedByScanner = false
      await expect
        .poll(
          async () => {
            const { rows } = await testDb.pool.query<{ left: number[]; right: number[] }>(
              'SELECT pg_blocking_pids($1) AS left,pg_blocking_pids($2) AS right',
              [pids[1], pids[2]],
            )
            const blocked = required(rows[0])
            blockedByScanner =
              blocked.left.includes(required(pids[0])) || blocked.right.includes(required(pids[0]))
            return completed.every(Boolean) || blockedByScanner
          },
          { timeout: 4000, interval: 1 },
        )
        .toBe(true)
      expect(blockedByScanner, 'booking must not wait for scanner work row').toBe(false)
      expect(completed, 'both bookings commit while scanner still owns its work row').toEqual([
        true,
        true,
      ])
      expect(await Promise.all(pending)).toEqual(['committed', 'committed'])
    } finally {
      await scanner.query('ROLLBACK')
      await Promise.all(pending)
      await Promise.all([left, right].map((client) => client.query('ROLLBACK')))
      for (const client of [scanner, left, right]) client.release()
    }
  }

  it('commits both booking updates while a scanner holds their work rows', async () => {
    await assertScannerDoesNotBlock()
  })

  async function withBlockingSignalMutation(assertion: () => Promise<void>) {
    const migration = readFileSync('packages/db/migrations/0051_waitlist.sql', 'utf8')
    const source = migration.match(
      /CREATE FUNCTION dirty_waitlist_event\(target uuid\) RETURNS void[\s\S]*?\$\$;/,
    )?.[0]
    expect(source, 'mutation must copy the migration function').toBeTruthy()
    expect(source).toContain('INSERT INTO waitlist_scan_signals')
    const original = required(source).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    const mutant = original.replace(
      /AS \$\$[\s\S]*?\$\$;/,
      () => `AS $$
      INSERT INTO waitlist_scan_work(event_type_id)
        SELECT id FROM event_types WHERE id=target AND waitlist_enabled
      ON CONFLICT (event_type_id) DO UPDATE SET
        dirty_generation=waitlist_scan_work.dirty_generation+1,
        next_due_at=least(waitlist_scan_work.next_due_at,now()),updated_at=now();
    $$;`,
    )
    expect(mutant).not.toBe(original)
    // Only replace the function inside this owned fixture. The source files and
    // real trigger wiring stay intact, and the original function is restored.
    await testDb.pool.query(mutant)
    try {
      await assertion()
    } finally {
      await testDb.pool.query(original)
    }
  }

  it.each(['reversed', 'sorted'] as const)(
    'kills the blocking signal source-copy mutation with %s host row order',
    async (order) => {
      await withBlockingSignalMutation(async () => {
        await expect(assertConcurrentUpdates(order, 1)).rejects.toThrow(
          'booking dirty signals must not block another booking or cause 40P01',
        )
      })
    },
  )

  it('kills the blocking signal source-copy mutation with a scanner-held work row', async () => {
    await withBlockingSignalMutation(async () => {
      await expect(assertScannerDoesNotBlock()).rejects.toThrow(
        'booking must not wait for scanner work row',
      )
    })
  })
})
