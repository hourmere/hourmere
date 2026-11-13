import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schedules from './schedules.ts'
import { createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const path = new URL('./schedules.ts', import.meta.url)
async function sourceCopy(change?: [string, string]): Promise<typeof schedules> {
  let source = readFileSync(path, 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replaceAll(...change)
  }
  source = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, path).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!serverUrl)('single-date override limit', () => {
  let testDb: TestDatabase
  let db: Db
  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })
  async function setup(count: number) {
    const ctx = testContext(db, (await createTestUser(db)).principal)
    const { id } = await schedules.createSchedule(ctx, {
      name: 'Hours',
      timeZone: 'UTC',
      weeklyHours: {},
    })
    // Past dates count too. All fixture writes use this test's throwaway database.
    await testDb.pool.query(
      `INSERT INTO schedule_overrides (schedule_id, date, intervals)
       SELECT $1, DATE '1980-01-01' + day, '[]'::jsonb
       FROM generate_series(0, $2::int - 1) AS day`,
      [id, count],
    )
    return { ctx, id }
  }
  async function verifyBoundary(service: typeof schedules) {
    const { ctx, id } = await setup(schedules.MAX_SCHEDULE_OVERRIDES - 1)
    expect(await service.putScheduleOverride(ctx, id, '2099-01-01', [])).toMatchObject({
      created: true,
    })
    const before = await schedules.getScheduleAvailability(ctx, id)
    await expect(service.putScheduleOverride(ctx, id, '2099-01-02', [])).rejects.toMatchObject({
      kind: 'invalid',
      code: 'too_many_overrides',
    })
    expect(await schedules.getScheduleAvailability(ctx, id)).toEqual(before)
    const intervals = [{ start: '10:00', end: '11:00' }]
    await expect(service.putScheduleOverride(ctx, id, '1980-01-01', intervals)).resolves.toEqual({
      created: false,
      override: { date: '1980-01-01', intervals },
    })
    await schedules.deleteScheduleOverride(ctx, id, '1980-01-01')
    expect(await service.putScheduleOverride(ctx, id, '2099-01-02', [])).toMatchObject({
      created: true,
    })
    const latest = await schedules.getScheduleAvailability(ctx, id)
    expect(
      (
        await schedules.saveScheduleAvailability(ctx, id, {
          ...latest.schedule,
          overrides: latest.overrides,
          expectedVersion: latest.version,
        })
      ).overrides,
    ).toHaveLength(schedules.MAX_SCHEDULE_OVERRIDES)
  }
  async function verifyRace(service: typeof schedules) {
    const { ctx, id } = await setup(schedules.MAX_SCHEDULE_OVERRIDES - 1)
    const gate = await testDb.pool.connect()
    const pending: Promise<unknown>[] = []
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
    async function waitForWaiters(count: number) {
      await expect
        .poll(
          async () => {
            const { rows } = await testDb.pool.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            )
            return rows[0]?.count ?? 0
          },
          { timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(count)
    }
    try {
      await gate.query('BEGIN')
      // First insert waits on the FK after counting; second must wait on the writer lock.
      await gate.query('SELECT id FROM schedules WHERE id = $1 FOR UPDATE', [id])
      pending.push(settle(service.putScheduleOverride(ctx, id, '2099-01-01', [])))
      await waitForWaiters(1)
      pending.push(settle(service.putScheduleOverride(ctx, id, '2099-01-02', [])))
      await waitForWaiters(2)
      await gate.query('COMMIT')
      expect(await Promise.all(pending)).toMatchObject([
        { value: { created: true } },
        { error: { kind: 'invalid', code: 'too_many_overrides' } },
      ])
      expect((await schedules.getScheduleAvailability(ctx, id)).overrides).toHaveLength(
        schedules.MAX_SCHEDULE_OVERRIDES,
      )
    } finally {
      await gate.query('ROLLBACK')
      gate.release()
      await Promise.all(pending)
    }
  }
  it('allows the last date, preserves failed writes, permits replacement and deletion, and stays editable', async () => {
    await verifyBoundary(schedules)
  })
  it('permits replacing and removing dates on previously oversized schedules', async () => {
    const { ctx, id } = await setup(schedules.MAX_SCHEDULE_OVERRIDES + 1)
    expect(await schedules.putScheduleOverride(ctx, id, '1980-01-01', [])).toMatchObject({
      created: false,
    })
    await schedules.deleteScheduleOverride(ctx, id, '1980-01-01')
    await expect(schedules.putScheduleOverride(ctx, id, '2099-01-01', [])).rejects.toMatchObject({
      code: 'too_many_overrides',
    })
  })
  it('serializes additions competing for the last date', async () => {
    await verifyRace(schedules)
  }, 15000)
  it('passes boundary assertions with an unchanged source copy', async () => {
    await verifyBoundary(await sourceCopy())
  })
  it.each([
    ['removed limit', 'if (Number(count) >= MAX_SCHEDULE_OVERRIDES)', 'if (false)'],
    [
      'off-by-one limit',
      'Number(count) >= MAX_SCHEDULE_OVERRIDES',
      'Number(count) > MAX_SCHEDULE_OVERRIDES',
    ],
    ['blocked replacement', 'if (!existing)', 'if (true)'],
  ])('detects %s in a source copy', async (_, before, after) => {
    await expect(verifyBoundary(await sourceCopy([before, after]))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it('detects a missing writer lock in a source copy', async () => {
    const mutant = await sourceCopy([
      'await lockSchedulesOf(trx, ctx.principal.user.id)',
      '/* writer lock removed */',
    ])
    await expect(verifyRace(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
  }, 15000)
})
