import { getAvailableSlots, type WeeklyHours } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createSchedule,
  deleteSchedule,
  deleteScheduleOverride,
  getSchedule,
  listScheduleOverrides,
  listSchedules,
  putScheduleOverride,
  type ScheduleInput,
  updateSchedule,
} from './schedules.ts'
import { createTestUser, domainError, type TestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

const NINE_TO_FIVE: WeeklyHours = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [
    { start: '09:00', end: '12:00' },
    { start: '13:00', end: '17:00' },
  ],
  saturday: [],
}

describe.skipIf(!serverUrl)('schedule service', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  const ctx = (user: TestUser) => testContext(db, user.principal)
  const input = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
    name: 'Working hours',
    timeZone: 'Europe/Berlin',
    weeklyHours: NINE_TO_FIVE,
    ...overrides,
  })
  const defaults = async (user: TestUser) =>
    (await listSchedules(ctx(user))).filter((s) => s.isDefault).map((s) => s.name)

  describe('defaults', () => {
    it('makes the first schedule the default, even when asked not to', async () => {
      const user = await createTestUser(db)
      expect(await listSchedules(ctx(user))).toEqual([])
      const first = await createSchedule(ctx(user), input({ isDefault: false }))
      expect(first).toEqual({
        id: expect.any(String),
        name: 'Working hours',
        timeZone: 'Europe/Berlin',
        weeklyHours: NINE_TO_FIVE,
        isDefault: true,
        createdAt: expect.stringMatching(/Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      })
      const second = await createSchedule(ctx(user), input({ name: 'Evenings' }))
      expect(second.isDefault).toBe(false)
      expect(await listSchedules(ctx(user))).toEqual([first, second])
    })

    it('moves the default to a new schedule created as the default', async () => {
      const user = await createTestUser(db)
      await createSchedule(ctx(user), input({ name: 'A' }))
      await createSchedule(ctx(user), input({ name: 'B', isDefault: true }))
      expect(await defaults(user)).toEqual(['B'])
    })

    it('moves the default on update, and refuses to unset it', async () => {
      const user = await createTestUser(db)
      const a = await createSchedule(ctx(user), input({ name: 'A' }))
      const b = await createSchedule(ctx(user), input({ name: 'B' }))
      const updated = await updateSchedule(ctx(user), b.id, { isDefault: true })
      expect(updated.isDefault).toBe(true)
      expect(await defaults(user)).toEqual(['B'])

      const error = await domainError(() => updateSchedule(ctx(user), b.id, { isDefault: false }))
      expect(error.kind).toBe('conflict')
      expect(error.code).toBe('schedule_is_default')
      // Unsetting a schedule that is not the default changes nothing.
      expect((await updateSchedule(ctx(user), a.id, { isDefault: false })).isDefault).toBe(false)
      expect(await defaults(user)).toEqual(['B'])
    })
  })

  // Each test runs two service calls for one user with a fixed interleaving: a gate
  // transaction holds a row lock the first call needs before it can commit, so the first
  // call stops mid-transaction; the second runs until it blocks or finishes; then the gate
  // opens. Without the per-user lock in the service, each of these ends with a unique
  // violation or with a user who has schedules but no default.
  describe('concurrent changes to the default', () => {
    type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
    const settle = (promise: Promise<unknown>): Promise<Outcome> =>
      promise.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      )

    /** Connections of this test database that are waiting for a lock. */
    const lockWaiters = async () => {
      const { rows } = await testDb.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
      return rows[0]?.n ?? 0
    }

    async function until(condition: () => Promise<boolean>, what: string) {
      const deadline = Date.now() + 5000
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }

    /** Runs `first` held at the gate (`gateSql` locks a row it needs), then `second`. */
    async function interleave(
      gateSql: string,
      gateParams: unknown[],
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ): Promise<[Outcome, Outcome]> {
      const gate = await testDb.pool.connect()
      try {
        await gate.query('BEGIN')
        await gate.query(gateSql, gateParams)
        const firstOutcome = settle(first())
        await until(async () => (await lockWaiters()) >= 1, 'the first call to reach the gate')
        let secondDone = false
        const secondOutcome = settle(second()).then((outcome) => {
          secondDone = true
          return outcome
        })
        await until(
          async () => secondDone || (await lockWaiters()) >= 2,
          'the second call to block or finish',
        )
        await gate.query('COMMIT')
        return [await firstOutcome, await secondOutcome]
      } finally {
        gate.release()
      }
    }

    const userRow = 'SELECT 1 FROM auth."user" WHERE id = $1 FOR UPDATE'
    const ok = { ok: true, value: expect.anything() }

    it('two first schedules: the first to commit is the default, both succeed', async () => {
      const user = await createTestUser(db)
      const outcomes = await interleave(
        userRow, // the insert's foreign key check waits for it
        [user.id],
        () => createSchedule(ctx(user), input({ name: 'A' })),
        () => createSchedule(ctx(user), input({ name: 'B' })),
      )
      expect(outcomes).toEqual([ok, ok])
      expect(await defaults(user)).toEqual(['A'])
    })

    it('two schedules made the default: the later one wins, both succeed', async () => {
      const user = await createTestUser(db)
      await createSchedule(ctx(user), input({ name: 'Old' }))
      const a = await createSchedule(ctx(user), input({ name: 'A' }))
      const b = await createSchedule(ctx(user), input({ name: 'B' }))
      const outcomes = await interleave(
        'SELECT 1 FROM schedules WHERE id = $1 FOR UPDATE', // A's own update waits for it
        [a.id],
        () => updateSchedule(ctx(user), a.id, { isDefault: true }),
        () => updateSchedule(ctx(user), b.id, { isDefault: true }),
      )
      expect(outcomes).toEqual([ok, ok])
      expect(await defaults(user)).toEqual(['B'])
    })

    it('deleting the last schedule while another is created: the new one is the default', async () => {
      const user = await createTestUser(db)
      const last = await createSchedule(ctx(user), input({ name: 'Last' }))
      await putScheduleOverride(ctx(user), last.id, '2026-12-24', [])
      const outcomes = await interleave(
        // The cascade to the overrides waits for it, after the schedule row is deleted.
        'SELECT 1 FROM schedule_overrides WHERE schedule_id = $1 FOR UPDATE',
        [last.id],
        () => deleteSchedule(ctx(user), last.id),
        () => createSchedule(ctx(user), input({ name: 'New' })),
      )
      expect(outcomes).toEqual([{ ok: true, value: undefined }, ok])
      expect(await defaults(user)).toEqual(['New'])
    })

    it('creating a schedule while the last one is deleted: the delete is refused', async () => {
      const user = await createTestUser(db)
      const last = await createSchedule(ctx(user), input({ name: 'Last' }))
      const [created, deleted] = await interleave(
        userRow,
        [user.id],
        () => createSchedule(ctx(user), input({ name: 'New' })),
        () => deleteSchedule(ctx(user), last.id),
      )
      expect(created).toEqual(ok)
      expect(deleted).toMatchObject({ ok: false, error: { code: 'schedule_is_default' } })
      expect(await defaults(user)).toEqual(['Last'])
      expect((await listSchedules(ctx(user))).map((s) => s.name)).toEqual(['Last', 'New'])
    })
  })

  describe('reading and changing', () => {
    it('updates only the given fields', async () => {
      const user = await createTestUser(db)
      const created = await createSchedule(ctx(user), input())
      const updated = await updateSchedule(ctx(user), created.id, {
        name: '  Summer  ',
        weeklyHours: { friday: [{ start: '08:00', end: '24:00' }] },
      })
      expect(updated).toMatchObject({
        id: created.id,
        name: 'Summer',
        timeZone: 'Europe/Berlin',
        weeklyHours: { friday: [{ start: '08:00', end: '24:00' }] },
        isDefault: true,
        createdAt: created.createdAt,
      })
      expect(await getSchedule(ctx(user), created.id)).toEqual(updated)
      expect(await updateSchedule(ctx(user), created.id, {})).toEqual(updated)
      const zone = await updateSchedule(ctx(user), created.id, { timeZone: 'asia/tokyo' })
      expect(zone.timeZone).toBe('Asia/Tokyo')
    })

    it("treats another user's schedule as missing", async () => {
      const [owner, other] = [await createTestUser(db), await createTestUser(db)]
      const schedule = await createSchedule(ctx(owner), input())
      expect(await listSchedules(ctx(other))).toEqual([])
      for (const attempt of [
        () => getSchedule(ctx(other), schedule.id),
        () => updateSchedule(ctx(other), schedule.id, { name: 'Mine now' }),
        () => deleteSchedule(ctx(other), schedule.id),
        () => listScheduleOverrides(ctx(other), schedule.id),
        () => putScheduleOverride(ctx(other), schedule.id, '2026-12-24', []),
        () => deleteScheduleOverride(ctx(other), schedule.id, '2026-12-24'),
      ]) {
        const error = await domainError(attempt)
        expect(error.kind).toBe('not_found')
        expect(error.code).toBe('schedule_not_found')
      }
      expect(await getSchedule(ctx(owner), schedule.id)).toEqual(schedule)
    })

    it('treats a malformed id as missing', async () => {
      const user = await createTestUser(db)
      expect((await domainError(() => getSchedule(ctx(user), 'nope'))).code).toBe(
        'schedule_not_found',
      )
    })

    it('stores weekly hours with only start and end, in a shape the engine accepts', async () => {
      const user = await createTestUser(db)
      const extra = {
        monday: [{ start: '09:00', end: '12:00', note: 'x' }],
      } as unknown as WeeklyHours
      const schedule = await createSchedule(ctx(user), input({ weeklyHours: extra }))
      expect(schedule.weeklyHours).toEqual({ monday: [{ start: '09:00', end: '12:00' }] })
      const stored = await getSchedule(ctx(user), schedule.id)
      const now = Temporal.Instant.from('2026-10-18T00:00:00Z')
      const slots = getAvailableSlots({
        schedule: { timeZone: stored.timeZone, weeklyHours: stored.weeklyHours },
        eventType: { durationMinutes: 60 },
        rangeStart: now,
        rangeEnd: now.add({ hours: 48 }),
        now,
      })
      expect(slots.map((s) => s.start.toString())).toEqual([
        '2026-10-19T07:00:00Z',
        '2026-10-19T08:00:00Z',
        '2026-10-19T09:00:00Z',
      ])
    })
  })

  describe('validation', () => {
    it.each<[string, Partial<ScheduleInput>, string, RegExp?]>([
      ['a blank name', { name: '  ' }, 'invalid_schedule'],
      ['a long name', { name: 'x'.repeat(101) }, 'invalid_schedule'],
      ['a non-boolean isDefault', { isDefault: 'yes' as unknown as boolean }, 'invalid_schedule'],
      ['an unknown time zone', { timeZone: 'Mars/Olympus' }, 'invalid_time_zone'],
      ['a UTC offset', { timeZone: '+02:00' }, 'invalid_time_zone'],
      [
        'an unknown weekday',
        { weeklyHours: { mon: [] } as WeeklyHours },
        'invalid_weekly_hours',
        /^weeklyHours has unknown weekday "mon"/,
      ],
      [
        'an end before the start',
        { weeklyHours: { monday: [{ start: '17:00', end: '09:00' }] } },
        'invalid_weekly_hours',
        /^weeklyHours\.monday\[0\]\.end \(09:00\) must be after start \(17:00\)$/,
      ],
      [
        'overlapping intervals',
        {
          weeklyHours: {
            monday: [
              { start: '09:00', end: '12:00' },
              { start: '11:00', end: '13:00' },
            ],
          },
        },
        'invalid_weekly_hours',
        /overlapping/,
      ],
      [
        'a malformed time',
        { weeklyHours: { monday: [{ start: '9:00', end: '17:00' }] } },
        'invalid_weekly_hours',
      ],
      [
        '"24:00" as a start',
        { weeklyHours: { monday: [{ start: '24:00', end: '24:00' }] } },
        'invalid_weekly_hours',
      ],
      ['an array', { weeklyHours: [] as unknown as WeeklyHours }, 'invalid_weekly_hours'],
    ])('refuses %s on create and update', async (_, change, code, message) => {
      const user = await createTestUser(db)
      const created = await domainError(() => createSchedule(ctx(user), input(change)))
      expect(created.kind).toBe('invalid')
      expect(created.code).toBe(code)
      if (message) expect(created.detail).toMatch(message)
      expect(await listSchedules(ctx(user))).toEqual([])

      const schedule = await createSchedule(ctx(user), input())
      const updated = await domainError(() => updateSchedule(ctx(user), schedule.id, change))
      expect(updated.code).toBe(code)
      expect(await getSchedule(ctx(user), schedule.id)).toEqual(schedule)
    })
  })

  describe('deleting', () => {
    it('deletes ordinary schedules, refuses the default while others exist, then allows it', async () => {
      const user = await createTestUser(db)
      const a = await createSchedule(ctx(user), input({ name: 'A' }))
      const b = await createSchedule(ctx(user), input({ name: 'B' }))
      const c = await createSchedule(ctx(user), input({ name: 'C' }))
      await deleteSchedule(ctx(user), c.id)
      expect((await domainError(() => getSchedule(ctx(user), c.id))).code).toBe(
        'schedule_not_found',
      )

      const error = await domainError(() => deleteSchedule(ctx(user), a.id))
      expect(error.kind).toBe('conflict')
      expect(error.code).toBe('schedule_is_default')

      await deleteSchedule(ctx(user), b.id)
      await deleteSchedule(ctx(user), a.id)
      expect(await listSchedules(ctx(user))).toEqual([])
      // With none left, the next schedule is the default again.
      expect((await createSchedule(ctx(user), input())).isDefault).toBe(true)
    })

    it('deletes the overrides with the schedule', async () => {
      const user = await createTestUser(db)
      const schedule = await createSchedule(ctx(user), input())
      await putScheduleOverride(ctx(user), schedule.id, '2026-12-24', [])
      await deleteSchedule(ctx(user), schedule.id)
      const left = await db
        .selectFrom('schedule_overrides')
        .select('date')
        .where('schedule_id', '=', schedule.id)
        .execute()
      expect(left).toEqual([])
    })
  })

  describe('date overrides', () => {
    it('creates, replaces, lists and deletes overrides', async () => {
      const user = await createTestUser(db)
      const { id } = await createSchedule(ctx(user), input())
      const dayOff = await putScheduleOverride(ctx(user), id, '2026-12-24', [])
      expect(dayOff).toEqual({ override: { date: '2026-12-24', intervals: [] }, created: true })
      const hours = [{ start: '10:00', end: '12:00' }]
      expect(await putScheduleOverride(ctx(user), id, '2026-12-24', hours)).toEqual({
        override: { date: '2026-12-24', intervals: hours },
        created: false,
      })
      await putScheduleOverride(ctx(user), id, '2026-12-31', [])
      await putScheduleOverride(ctx(user), id, '2026-12-01', [{ start: '00:00', end: '24:00' }])

      expect((await listScheduleOverrides(ctx(user), id)).map((o) => o.date)).toEqual([
        '2026-12-01',
        '2026-12-24',
        '2026-12-31',
      ])
      const dates = async (from?: string, to?: string) =>
        (await listScheduleOverrides(ctx(user), id, { from, to })).map((o) => o.date)
      expect(await dates('2026-12-24', '2026-12-31')).toEqual(['2026-12-24', '2026-12-31'])
      expect(await dates('2026-12-02')).toEqual(['2026-12-24', '2026-12-31'])
      expect(await dates(undefined, '2026-12-24')).toEqual(['2026-12-01', '2026-12-24'])
      expect(await dates('2026-12-25', '2026-12-25')).toEqual([])
      expect(
        await listScheduleOverrides(ctx(user), id, { from: '2026-12-24', to: '2026-12-24' }),
      ).toEqual([{ date: '2026-12-24', intervals: hours }])

      await deleteScheduleOverride(ctx(user), id, '2026-12-24')
      expect(await dates()).toEqual(['2026-12-01', '2026-12-31'])
      const error = await domainError(() => deleteScheduleOverride(ctx(user), id, '2026-12-24'))
      expect(error.kind).toBe('not_found')
      expect(error.code).toBe('schedule_override_not_found')
    })

    it('stores intervals with only start and end', async () => {
      const user = await createTestUser(db)
      const { id } = await createSchedule(ctx(user), input())
      const extra = [{ start: '10:00', end: '11:00', why: 'dentist' }]
      const { override } = await putScheduleOverride(ctx(user), id, '2027-01-04', extra)
      expect(override.intervals).toEqual([{ start: '10:00', end: '11:00' }])
    })

    it.each<[string, string, unknown, string]>([
      ['an impossible date', '2026-02-30', [], 'invalid_date'],
      ['a malformed date', '2026-2-3', [], 'invalid_date'],
      ['year 0, which Postgres cannot store', '0000-06-01', [], 'invalid_date'],
      [
        'an end before the start',
        '2026-12-24',
        [{ start: '12:00', end: '10:00' }],
        'invalid_intervals',
      ],
      [
        'overlapping intervals',
        '2026-12-24',
        [
          { start: '09:00', end: '12:00' },
          { start: '10:00', end: '11:00' },
        ],
        'invalid_intervals',
      ],
      ['an object instead of a list', '2026-12-24', {}, 'invalid_intervals'],
    ])('refuses %s', async (_, date, intervals, code) => {
      const user = await createTestUser(db)
      const { id } = await createSchedule(ctx(user), input())
      const error = await domainError(() =>
        putScheduleOverride(ctx(user), id, date, intervals as never),
      )
      expect(error.kind).toBe('invalid')
      expect(error.code).toBe(code)
      expect(await listScheduleOverrides(ctx(user), id)).toEqual([])
    })

    it('refuses bad ranges and dates when listing and deleting', async () => {
      const user = await createTestUser(db)
      const { id } = await createSchedule(ctx(user), input())
      const range = await domainError(() =>
        listScheduleOverrides(ctx(user), id, { from: '2026-12-31', to: '2026-12-01' }),
      )
      expect(range.code).toBe('invalid_date_range')
      const from = await domainError(() =>
        listScheduleOverrides(ctx(user), id, { from: '2026-13-01' }),
      )
      expect(from.code).toBe('invalid_date')
      expect(from.detail).toMatch(/^from /)
      expect((await domainError(() => deleteScheduleOverride(ctx(user), id, 'x'))).code).toBe(
        'invalid_date',
      )
    })

    it('answers schedule_not_found for an unknown schedule', async () => {
      const user = await createTestUser(db)
      const unknown = '01900000-0000-7000-8000-000000000000'
      for (const attempt of [
        () => putScheduleOverride(ctx(user), unknown, '2026-12-24', []),
        () => putScheduleOverride(ctx(user), 'nope', '2026-12-24', []),
        () => listScheduleOverrides(ctx(user), unknown),
      ]) {
        expect((await domainError(attempt)).code).toBe('schedule_not_found')
      }
    })
  })
})
