// A small SQL harness proves storage transaction boundaries. It deliberately does not
// implement the later service, notification or provider integrations. The two owned
// test tables represent a per-seat transactional outbox and first-slot resource intents.
import { createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type GroupFixture,
  groupFixture,
  insertSeat,
  insertSlot,
  occupiedSlot,
  slotState,
  transaction,
} from './group-seats-fixtures.ts'
import { guardPoolErrors } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const rounds = 20
const fingerprint = createHash('sha256').update('synthetic exact request').digest()

async function seatOutbox(sql: pg.PoolClient, booking: string) {
  await sql.query('INSERT INTO test_group_seat_outbox(booking_id) VALUES ($1)', [booking])
}

async function counts(f: GroupFixture) {
  return (
    await f.pool.query(
      `SELECT
       (SELECT count(*)::int FROM group_slots WHERE organization_id=$1) AS slots,
       (SELECT count(*)::int FROM bookings WHERE organization_id=$1) AS seats,
       (SELECT count(*)::int FROM booking_hosts h JOIN group_slots s ON s.id=h.group_slot_id WHERE s.organization_id=$1) AS hosts,
       (SELECT count(*)::int FROM test_group_seat_outbox o JOIN bookings b ON b.id=o.booking_id WHERE b.organization_id=$1) AS outboxes,
       (SELECT count(*)::int FROM test_group_resource_outbox o JOIN group_slots s ON s.id=o.group_slot_id WHERE s.organization_id=$1 AND o.kind='conference') AS conferences,
       (SELECT count(*)::int FROM test_group_resource_outbox o JOIN group_slots s ON s.id=o.group_slot_id WHERE s.organization_id=$1 AND o.kind='calendar') AS calendars`,
      [f.organization],
    )
  ).rows[0]
}

async function admit(
  pool: pg.Pool,
  f: GroupFixture,
  key: string,
  fail = false,
  afterWrites?: () => Promise<void>,
) {
  return transaction(pool, async (sql) => {
    const pid = (await sql.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [f.host])
    // Replay precedes fullness/terminal checks, and never creates new side effects.
    const replay = await sql.query<{ id: string; group_slot_id: string }>(
      'SELECT id,group_slot_id FROM bookings WHERE organization_id=$1 AND api_key_id IS NULL AND idempotency_key=$2',
      [f.organization, key],
    )
    if (replay.rows[0])
      return { booking: replay.rows[0].id, slot: replay.rows[0].group_slot_id, replay: true, pid }
    let slot = (
      await sql.query<{ id: string }>(
        `SELECT id FROM group_slots WHERE organization_id=$1 AND event_type_id=$2
       AND host_user_id=$3 AND start_at=$4 AND end_at=$5 AND state='open' FOR UPDATE`,
        [f.organization, f.event, f.host, f.start, f.end],
      )
    ).rows[0]?.id
    if (!slot) {
      slot = await insertSlot(sql, f)
      await sql.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
        slot,
        f.host,
      ])
      await sql.query(
        `INSERT INTO test_group_resource_outbox(group_slot_id,kind) VALUES ($1,'conference'),($1,'calendar')`,
        [slot],
      )
    }
    const booking = await insertSeat(sql, f, slot, `${key}@example.test`, {
      idempotency_key: key,
      idempotency_fingerprint: fingerprint,
    })
    await seatOutbox(sql, booking)
    await afterWrites?.()
    if (fail) throw new Error('synthetic transaction failure after all outbox writes')
    return { booking, slot, replay: false, pid }
  })
}

async function simultaneous<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient, i: number) => Promise<T>,
  n = 2,
) {
  // All clients are checked out and BEGIN before any contender executes its write.
  // This proves that these races use distinct bounded backend connections.
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()))
  try {
    await Promise.all(clients.map((client) => client.query('BEGIN')))
    const pids = await Promise.all(
      clients.map(
        async (client) =>
          (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
      ),
    )
    expect(new Set(pids).size).toBe(n)
    return await Promise.allSettled(
      clients.map(async (client, i) => {
        try {
          const result = await work(client, i)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }),
    )
  } finally {
    for (const client of clients) {
      await client.query('ROLLBACK')
      client.release()
    }
  }
}

describe.skipIf(!serverUrl)('group seat atomic concurrency', () => {
  let owned: TestDatabase
  let racePool: pg.Pool
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_races' })
    racePool = new pg.Pool({
      connectionString: owned.url,
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    })
    guardPoolErrors(racePool, 'group-seat race')
    await owned.pool.query(`
      CREATE TABLE test_group_seat_outbox (
        booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE);
      CREATE TABLE test_group_resource_outbox (
        group_slot_id uuid NOT NULL REFERENCES group_slots(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN ('conference','calendar')),
        PRIMARY KEY(group_slot_id,kind));`)
  })
  afterAll(async () => {
    await racePool?.end()
    await owned?.drop()
  })

  it('serializes simultaneous first seats into one generation and exactly capacity commits in 20 rounds', async () => {
    for (let round = 0; round < rounds; round++) {
      const f = await groupFixture(owned.pool)
      const keys = Array.from({ length: 10 }, (_, i) => `first-${round}-${i}`)
      const results = await Promise.allSettled(keys.map((key) => admit(racePool, f, key)))
      const winners = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
      const losers = results.filter((r) => r.status === 'rejected')
      expect(winners).toHaveLength(3)
      expect(losers).toHaveLength(7)
      for (const loser of losers)
        expect(loser.reason).toMatchObject({
          code: '23514',
          constraint: 'group_slots_capacity_guard',
        })
      expect(new Set(winners.map((winner) => winner.slot)).size).toBe(1)
      expect(new Set(winners.map((winner) => winner.pid)).size).toBeGreaterThan(1)
      expect(await counts(f)).toEqual({
        slots: 1,
        seats: 3,
        hosts: 1,
        outboxes: 3,
        conferences: 1,
        calendars: 1,
      })
      expect(await slotState(f, winners[0]?.slot as string)).toEqual({
        state: 'open',
        active_seats: 3,
        confirmed: 3,
        hosts: 1,
        active_hosts: 1,
      })
      // Same keys safely retry a first wave's committed outcomes; a full loser cannot sell a fourth seat.
      const retry = await Promise.allSettled(keys.map((key) => admit(racePool, f, key)))
      expect(retry.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
      expect(await counts(f)).toEqual({
        slots: 1,
        seats: 3,
        hosts: 1,
        outboxes: 3,
        conferences: 1,
        calendars: 1,
      })
    }
    expect(racePool.totalCount).toBeLessThanOrEqual(4)
  }, 60_000)

  it('admits exactly one last seat without advisory locks in 20 rounds', async () => {
    for (let round = 0; round < rounds; round++) {
      const f = await groupFixture(owned.pool)
      const { slot } = await occupiedSlot(f, 2)
      const results = await simultaneous(racePool, async (sql, i) => {
        const booking = await insertSeat(sql, f, slot, `last-${round}-${i}@example.test`)
        await seatOutbox(sql, booking)
        return booking
      })
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const failed = results.filter((r) => r.status === 'rejected')
      expect(failed).toHaveLength(1)
      expect(failed[0]?.reason).toMatchObject({ code: '23514' })
      expect(await slotState(f, slot)).toEqual({
        state: 'open',
        active_seats: 3,
        confirmed: 3,
        hosts: 1,
        active_hosts: 1,
      })
      expect(await counts(f)).toEqual({
        slots: 1,
        seats: 3,
        hosts: 1,
        outboxes: 1,
        conferences: 0,
        calendars: 0,
      })
    }
  }, 60_000)

  it('replays simultaneous keys at fullness and after retirement without another seat or outbox in 20 rounds', async () => {
    for (let round = 0; round < rounds; round++) {
      const f = await groupFixture(owned.pool)
      const results = await Promise.all(
        Array.from({ length: 4 }, () => admit(racePool, f, `replay-${round}`)),
      )
      expect(new Set(results.map((r) => r.booking)).size).toBe(1)
      expect(results.filter((r) => !r.replay)).toHaveLength(1)
      await admit(racePool, f, `fill-a-${round}`)
      await admit(racePool, f, `fill-b-${round}`)
      const before = await counts(f)
      const original = results[0] as (typeof results)[number]
      expect((await admit(racePool, f, `replay-${round}`)).booking).toBe(original.booking)
      await owned.pool.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE group_slot_id=$1`,
        [original.slot],
      )
      const afterCancel = (
        await owned.pool.query(
          'SELECT id,manage_token_hash,status FROM bookings WHERE group_slot_id=$1 ORDER BY id',
          [original.slot],
        )
      ).rows
      const replay = await Promise.all(
        Array.from({ length: 4 }, () => admit(racePool, f, `replay-${round}`)),
      )
      expect(replay.every((r) => r.replay && r.booking === original.booking)).toBe(true)
      expect(await counts(f)).toEqual(before)
      expect(
        (
          await owned.pool.query(
            'SELECT id,manage_token_hash,status FROM bookings WHERE group_slot_id=$1 ORDER BY id',
            [original.slot],
          )
        ).rows,
      ).toEqual(afterCancel)
      expect(await slotState(f, original.slot)).toEqual({
        state: 'retired',
        active_seats: 0,
        confirmed: 0,
        hosts: 1,
        active_hosts: 0,
      })
    }
  }, 60_000)

  it('rolls back a failing writer while a second connection waits, then commits only the waiter in 20 first-slot and 20 existing-slot rounds', async () => {
    for (const existing of [false, true]) {
      for (let round = 0; round < rounds; round++) {
        const f = await groupFixture(owned.pool)
        if (existing) await admit(racePool, f, `seed-${round}`)
        let ready: () => void = () => {}
        let release: () => void = () => {}
        const written = new Promise<void>((resolve) => {
          ready = resolve
        })
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        const failed = admit(racePool, f, `rollback-${round}`, true, async () => {
          ready()
          await released
        })
        const outcome = Promise.allSettled([failed])
        await written
        const waiting = admit(racePool, f, `waiter-${round}`)
        try {
          let blocked = false
          for (let probe = 0; probe < 100; probe++) {
            const waiting = (
              await owned.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'`)
            ).rows[0]?.n
            if (waiting === 1) {
              blocked = true
              break
            }
          }
          expect(blocked).toBe(true)
        } finally {
          release()
        }
        const winner = await waiting
        const failedResult = (await outcome)[0]
        expect(failedResult?.status).toBe('rejected')
        if (failedResult?.status === 'rejected')
          expect(failedResult.reason.message).toContain('synthetic transaction failure')
        const seats = existing ? 2 : 1
        expect(await counts(f)).toEqual({
          slots: 1,
          seats,
          hosts: 1,
          outboxes: seats,
          conferences: 1,
          calendars: 1,
        })
        expect((await slotState(f, winner.slot))?.active_seats).toBe(seats)
        // The failed request's key was rolled back as well as its capacity/outbox.
        const retry = await admit(racePool, f, `rollback-${round}`)
        expect(retry.replay).toBe(false)
        expect((await slotState(f, winner.slot))?.active_seats).toBe(seats + 1)
      }
    }
  }, 60_000)

  it('serializes a cancellation against a join without negative counts or terminal-generation admission in 20 rounds', async () => {
    for (let round = 0; round < rounds; round++) {
      const f = await groupFixture(owned.pool)
      const { slot, bookings } = await occupiedSlot(f)
      const results = await simultaneous(racePool, async (sql, i) => {
        if (i === 0) {
          await sql.query(
            `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
            [bookings[0]],
          )
          return 'cancelled'
        }
        const booking = await insertSeat(sql, f, slot)
        await seatOutbox(sql, booking)
        return booking
      })
      expect(results[0]?.status).toBe('fulfilled')
      const state = await slotState(f, slot)
      if (results[1]?.status === 'fulfilled') {
        expect(state).toEqual({
          state: 'open',
          active_seats: 1,
          confirmed: 1,
          hosts: 1,
          active_hosts: 1,
        })
      } else {
        expect(results[1]?.reason).toMatchObject({ code: '23514' })
        expect(state).toEqual({
          state: 'retired',
          active_seats: 0,
          confirmed: 0,
          hosts: 1,
          active_hosts: 0,
        })
      }
    }
    expect(racePool.totalCount).toBeLessThanOrEqual(4)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  }, 60_000)
})
