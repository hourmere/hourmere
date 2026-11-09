import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createSchedule,
  deleteScheduleOverride,
  getScheduleAvailability,
  MAX_SCHEDULE_OVERRIDES,
  putScheduleOverride,
  type ScheduleAvailability,
  type ScheduleAvailabilityInput,
  saveScheduleAvailability,
  updateSchedule,
} from './schedules.ts'
import { createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('combined availability', () => {
  let testDb: TestDatabase
  let db: Db
  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })
  async function setup() {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const schedule = await createSchedule(ctx, {
      name: 'Working hours',
      timeZone: 'America/New_York',
      weeklyHours: { monday: [{ start: '09:00', end: '17:00' }] },
    })
    await putScheduleOverride(ctx, schedule.id, '2027-03-14', [])
    const snapshot = await getScheduleAvailability(ctx, schedule.id)
    return { ctx, id: schedule.id, snapshot }
  }
  function edit(
    snapshot: ScheduleAvailability,
    changes: Partial<ScheduleAvailabilityInput> = {},
  ): ScheduleAvailabilityInput {
    return {
      ...snapshot.schedule,
      overrides: snapshot.overrides,
      expectedVersion: snapshot.version,
      ...changes,
    }
  }

  it('replaces weekly hours and all overrides, including empty days and canonical 24:00 end-of-day', async () => {
    const { ctx, id, snapshot } = await setup()
    const weeklyHours = { tuesday: [{ start: '22:00', end: '24:00' }], friday: [] }
    const overrides = [{ date: '2027-11-07', intervals: [{ start: '00:00', end: '24:00' }] }]
    const saved = await saveScheduleAvailability(
      ctx,
      id,
      edit(snapshot, { weeklyHours, overrides }),
    )
    expect(saved.schedule.weeklyHours).toEqual(weeklyHours)
    expect(saved.overrides).toEqual(overrides)
    expect(saved.version).not.toBe(snapshot.version)
    expect(await getScheduleAvailability(ctx, id)).toEqual(saved)
    const empty = await saveScheduleAvailability(ctx, id, edit(saved, { overrides: [] }))
    expect(empty.overrides).toEqual([])
  })

  it('accepts the maximum override count and rejects one more before database work', async () => {
    const { ctx, id, snapshot } = await setup()
    const overrides = Array.from({ length: MAX_SCHEDULE_OVERRIDES }, (_, days) => ({
      date: Temporal.PlainDate.from('2030-01-01').add({ days }).toString(),
      intervals: [],
    }))
    const saved = await saveScheduleAvailability(ctx, id, edit(snapshot, { overrides }))
    expect(saved.overrides).toEqual(overrides)
    // A database that cannot be touched proves rejection happens before a transaction/read.
    const noDatabase = { ...ctx, db: {} as Db }
    await expect(
      saveScheduleAvailability(
        noDatabase,
        id,
        edit(saved, {
          overrides: [...overrides, { date: '2099-01-01', intervals: [] }],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid', code: 'too_many_overrides' })
    expect(await getScheduleAvailability(ctx, id)).toEqual(saved)
  })

  it('rolls back the first part and removed overrides when the second part fails in PostgreSQL', async () => {
    const { ctx, id, snapshot } = await setup()
    // This fails only after the schedule UPDATE and override DELETE have executed.
    await testDb.pool.query(
      `ALTER TABLE schedule_overrides ADD CONSTRAINT availability_failure_probe CHECK (date <> '2027-12-25')`,
    )
    try {
      await expect(
        saveScheduleAvailability(
          ctx,
          id,
          edit(snapshot, {
            name: 'Must roll back',
            weeklyHours: {},
            overrides: [{ date: '2027-12-25', intervals: [] }],
          }),
        ),
      ).rejects.toMatchObject({ code: '23514' })
      expect(await getScheduleAvailability(ctx, id)).toEqual(snapshot)
    } finally {
      await testDb.pool.query(
        'ALTER TABLE schedule_overrides DROP CONSTRAINT availability_failure_probe',
      )
    }
  })

  it('rejects stale tabs and exact replay, including a same-content save', async () => {
    const { ctx, id, snapshot } = await setup()
    const body = edit(snapshot)
    const saved = await saveScheduleAvailability(ctx, id, body)
    expect(saved.version).not.toBe(snapshot.version)
    for (const stale of [body, edit(snapshot, { name: 'Other tab' })]) {
      await expect(saveScheduleAvailability(ctx, id, stale)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'schedule_conflict',
      })
      expect(await getScheduleAvailability(ctx, id)).toEqual(saved)
    }
  })

  it.each([
    'weekly',
    'override-put',
    'override-delete',
    'override-change-revert',
    'default',
  ] as const)('detects legacy %s writes before combined saves', async (kind) => {
    const { ctx, id, snapshot } = await setup()
    if (kind === 'weekly') await updateSchedule(ctx, id, { weeklyHours: {} })
    if (kind === 'override-put') await putScheduleOverride(ctx, id, '2027-03-14', [])
    if (kind === 'override-delete') await deleteScheduleOverride(ctx, id, '2027-03-14')
    if (kind === 'override-change-revert') {
      await putScheduleOverride(ctx, id, '2027-03-14', [{ start: '09:00', end: '10:00' }])
      await putScheduleOverride(ctx, id, '2027-03-14', [])
    }
    if (kind === 'default')
      await createSchedule(ctx, {
        name: 'New default',
        timeZone: 'UTC',
        weeklyHours: {},
        isDefault: true,
      })
    const current = await getScheduleAvailability(ctx, id)
    expect(current.version).not.toBe(snapshot.version)
    await expect(saveScheduleAvailability(ctx, id, edit(snapshot))).rejects.toMatchObject({
      code: 'schedule_conflict',
    })
    expect(await getScheduleAvailability(ctx, id)).toEqual(current)
  })

  it.each([
    { weeklyHours: { monday: [{ start: '22:00', end: '00:00' }] } },
    {
      weeklyHours: {
        monday: [
          { start: '09:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      },
    },
    {
      overrides: [
        { date: '2027-03-14', intervals: [] },
        { date: '2027-03-14', intervals: [] },
      ],
    },
    { overrides: [{ date: '2027-02-30', intervals: [] }] },
    { overrides: [{ date: '2027-03-14', intervals: [{ start: '24:00', end: '24:00' }] }] },
    { expectedVersion: '' },
  ])('rejects invalid combined input without changing either part (%j)', async (changes) => {
    const { ctx, id, snapshot } = await setup()
    await expect(saveScheduleAvailability(ctx, id, edit(snapshot, changes))).rejects.toMatchObject({
      kind: 'invalid',
    })
    expect(await getScheduleAvailability(ctx, id)).toEqual(snapshot)
  })

  it('keeps ownership and default-schedule protections', async () => {
    const { ctx, id, snapshot } = await setup()
    const other = testContext(db, (await createTestUser(db)).principal)
    await expect(getScheduleAvailability(other, id)).rejects.toMatchObject({
      code: 'schedule_not_found',
    })
    await expect(saveScheduleAvailability(other, id, edit(snapshot))).rejects.toMatchObject({
      code: 'schedule_not_found',
    })
    await expect(
      saveScheduleAvailability(ctx, id, edit(snapshot, { isDefault: false })),
    ).rejects.toMatchObject({ code: 'schedule_is_default' })
    expect(await getScheduleAvailability(ctx, id)).toEqual(snapshot)
  })

  it.each(['combined', 'legacy-put', 'legacy-delete', 'snapshot'] as const)(
    'serializes a concurrent %s behind an in-flight save',
    async (kind) => {
      const { ctx, id, snapshot } = await setup()
      const gate = await testDb.pool.connect()
      const outcomes: Promise<unknown>[] = []
      const settle = (promise: Promise<unknown>) =>
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      async function waitForWaiters(count: number) {
        const deadline = Date.now() + 5000
        let observed = 0
        while (Date.now() < deadline) {
          const { rows } = await testDb.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
          observed = rows[0]?.count ?? 0
          if (observed >= count) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(
          observed,
          'Concurrent operation must wait for the shared schedule lock',
        ).toBeGreaterThanOrEqual(count)
      }
      try {
        await gate.query('BEGIN')
        await gate.query('SELECT id FROM schedules WHERE id = $1 FOR UPDATE', [id])
        outcomes.push(
          settle(
            saveScheduleAvailability(
              ctx,
              id,
              edit(snapshot, {
                name: 'First tab',
                overrides: [
                  { date: '2027-03-14', intervals: [] },
                  { date: '2027-05-01', intervals: [] },
                ],
              }),
            ),
          ),
        )
        await waitForWaiters(1)
        const second =
          kind === 'combined'
            ? saveScheduleAvailability(ctx, id, edit(snapshot, { name: 'Second tab' }))
            : kind === 'legacy-put'
              ? putScheduleOverride(ctx, id, '2027-03-14', [{ start: '10:00', end: '11:00' }])
              : kind === 'legacy-delete'
                ? deleteScheduleOverride(ctx, id, '2027-03-14')
                : getScheduleAvailability(ctx, id)
        outcomes.push(settle(second))
        await waitForWaiters(2)
        await gate.query('COMMIT')
        const [first, next] = await Promise.all(outcomes)
        expect(first).toMatchObject({ value: { schedule: { name: 'First tab' } } })
        if (kind === 'combined')
          expect(next).toMatchObject({ error: { code: 'schedule_conflict' } })
        if (kind === 'snapshot') expect(next).toEqual(first)
        const current = await getScheduleAvailability(ctx, id)
        expect(current.schedule.name).toBe('First tab')
        if (kind === 'legacy-put') {
          expect(next).toMatchObject({ value: { created: false } })
          expect(current.overrides).toEqual([
            { date: '2027-03-14', intervals: [{ start: '10:00', end: '11:00' }] },
            { date: '2027-05-01', intervals: [] },
          ])
        }
        if (kind === 'legacy-delete')
          expect(current.overrides.map((o) => o.date)).toEqual(['2027-05-01'])
      } finally {
        await gate.query('ROLLBACK')
        gate.release()
        await Promise.all(outcomes)
      }
    },
    15000,
  )
})
