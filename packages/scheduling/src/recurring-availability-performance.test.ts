import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { PostgresQueryCompiler, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { checkRecurringAvailability } from './recurring-availability.ts'
import {
  MAX_RECURRING_AVAILABILITY_EVALUATIONS,
  MAX_RECURRING_AVAILABILITY_READS,
  MAX_RECURRING_AVAILABILITY_ROWS,
  RECURRING_AVAILABILITY_DEADLINE_MS,
  withRecurringAvailabilityBudget,
} from './recurring-availability-budget.ts'
import { expandRecurringRule } from './recurring-rules.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2027-01-01T00:00Z')
const occurrences = expandRecurringRule({
  rule: { pattern: 'weekly', count: 12 },
  firstLocalStart: '2027-01-05T10:00+00:00',
  timeZone: 'UTC',
  durationMinutes: 30,
  now,
})

describe.skipIf(!serverUrl)('bounded recurring availability on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let organizationId: string
  let eventTypeId: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'recurring_budget',
    })
    db = createDb(owned.pool)
    const fixtures = createFixtures(db)
    const owner = await createTestUser(db)
    const hosts = [owner]
    for (let i = 1; i < 8; i++) hosts.push(await createTestUser(db))
    const team = await createTestTeam(
      db,
      hosts.map((user) => ({ user, role: user.id === owner.id ? 'owner' : 'member' })),
    )
    organizationId = team.id
    for (const host of hosts) {
      await fixtures.schedule(host.id, { timeZone: 'UTC' })
      const { calendarId } = await fixtures.calendarBusy(host.id, [], { now })
      await sql`
        INSERT INTO calendar_busy (calendar_id, external_event_id, period)
        SELECT ${calendarId}::uuid, 'dense-' || week || '-' || n,
          tstzrange(
            '2027-01-05T12:00Z'::timestamptz + week * interval '7 days' + n * interval '1 second',
            '2027-01-05T14:00Z'::timestamptz + week * interval '7 days' + n * interval '1 second'
          )
        FROM generate_series(0, 11) AS week CROSS JOIN generate_series(1, 100) AS n
      `.execute(db)
      await sql`
        INSERT INTO calendar_busy (calendar_id, external_event_id, period)
        SELECT ${calendarId}::uuid, 'outside-' || n,
          tstzrange(
            '2027-01-08T22:00Z'::timestamptz + n * interval '1 minute',
            '2027-01-08T23:00Z'::timestamptz + n * interval '1 minute'
          )
        FROM generate_series(1, 20) AS n
      `.execute(db)
    }
    const ctx = testContext(db, team.as(owner), () => now)
    const event = await createEventType(ctx, {
      slug: 'dense-calendar-pool',
      title: 'Dense calendar pool',
      schedulingType: 'round_robin',
      durationMinutes: 30,
      maxBookingsPerDay: 5,
      maxBookingsPerWeek: 10,
      maxBookingsPerMonth: 20,
      hosts: hosts.map(({ id }) => ({ userId: id })),
    })
    eventTypeId = event.id
    await activateRoundRobin(ctx, eventTypeId)
  }, 60_000)

  afterAll(async () => {
    await owned?.drop()
  })

  function check(connection = db) {
    return checkRecurringAvailability(connection, { eventTypeId, organizationId, occurrences, now })
  }

  it('measures all host and date pairs against dense overlapping calendars and bounded reads', async () => {
    let reads = 0
    let rows = 0
    const selects = new WeakSet<object>()
    const observed = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          /^(select|with)\b/i.test(
            new PostgresQueryCompiler().compileQuery(node, queryId).sql.trim(),
          )
        )
          selects.add(queryId)
        return node
      },
      async transformResult({ result, queryId }) {
        if (selects.has(queryId)) {
          reads++
          rows += result.rows.length
        }
        return result
      },
    })
    const elapsed: number[] = []
    for (let i = 0; i < 3; i++) {
      const from = performance.now()
      const result = await check(observed)
      elapsed.push(Math.round((performance.now() - from) * 10) / 10)
      expect(result.canBook).toBe(true)
      expect(result.hostUserIds).toHaveLength(8)
      expect(result.metrics.evaluations).toBe(96)
      expect(result.metrics.evaluations).toBeLessThanOrEqual(MAX_RECURRING_AVAILABILITY_EVALUATIONS)
      expect(result.metrics.reads).toBe(reads)
      expect(result.metrics.reads).toBeLessThanOrEqual(MAX_RECURRING_AVAILABILITY_READS)
      expect(result.metrics.rows).toBe(rows)
      // The fact set includes the eight Microsoft calendars' freshness rows.
      expect(result.metrics.rows).toBe(9_834)
      expect(result.metrics.rows).toBeLessThanOrEqual(MAX_RECURRING_AVAILABILITY_ROWS)
      reads = 0
      rows = 0
      if (i === 2)
        console.info('Dense recurring availability', { ...result.metrics, elapsedMs: elapsed })
    }
  }, 20_000)

  it('rejects dense fact overflow without truncating it into a free slot', async () => {
    await db.transaction().execute(async (trx) => {
      await sql`SAVEPOINT dense_fixture`.execute(trx)
      await sql`
        INSERT INTO calendar_busy (calendar_id, external_event_id, period)
        SELECT calendar_id, 'overflow-' || external_event_id, period
        FROM calendar_busy
        WHERE external_event_id LIKE 'dense-0-%'
      `.execute(trx)
      await expect(check(trx)).rejects.toMatchObject({ code: 'series_check_unavailable' })
      // The overflow read and its timeout controls leave the caller's transaction usable.
      await sql`ROLLBACK TO SAVEPOINT dense_fixture`.execute(trx)
    })
  })

  it('refuses a thirty-third database read', async () => {
    await expect(
      withRecurringAvailabilityBudget(db, async (_connection, budget) => {
        // The initial statement-timeout lookup is also a read.
        const statement = sql<{ value: number }>`(SELECT 1 AS value)`
        for (let index = 1; index < 32; index++) await budget.read(statement)
        expect(budget.metrics.reads).toBe(32)
        await budget.read(statement)
      }),
    ).rejects.toMatchObject({ kind: 'unavailable', code: 'series_check_unavailable' })
  })

  it('cancels a blocked PostgreSQL read at the deadline and releases the connection', async () => {
    const blocker = await owned.pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE calendar_busy IN ACCESS EXCLUSIVE MODE')
      const from = performance.now()
      await expect(check()).rejects.toMatchObject({ code: 'series_check_unavailable' })
      const elapsed = performance.now() - from
      expect(elapsed).toBeGreaterThanOrEqual(RECURRING_AVAILABILITY_DEADLINE_MS - 150)
      expect(elapsed).toBeLessThan(RECURRING_AVAILABILITY_DEADLINE_MS + 500)
      expect(owned.pool.idleCount).toBe(owned.pool.totalCount - 1)
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = 100`.execute(trx)
        await expect(check(trx)).rejects.toMatchObject({ code: 'series_check_unavailable' })
        expect((await sql`SHOW statement_timeout`.execute(trx)).rows).toEqual([
          { statement_timeout: '100ms' },
        ])
      })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await expect(check()).resolves.toMatchObject({ canBook: true })
  }, 15_000)
})
