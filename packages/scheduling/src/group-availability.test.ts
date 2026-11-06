import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type GroupFixture,
  groupFixture,
  insertSlot,
  occupiedSlot,
  transaction,
} from '../../db/src/group-seats-fixtures.ts'
import {
  assertCachedCalendarSync,
  buildAvailabilityInput,
  findSlots,
  selectDurationMinutes,
  toInstant,
} from './availability.ts'
import { DomainError } from './errors.ts'
import { createFixtures } from './testing.ts'

const instant = (value: string) => Temporal.Instant.from(value)
const serverUrl = process.env.DATABASE_URL

function sourceCopy(change?: readonly [string, string]): typeof buildAvailabilityInput {
  const original = readFileSync(new URL('./availability.ts', import.meta.url), 'utf8')
  const start = original.indexOf('export async function buildAvailabilityInput(')
  const end = original.indexOf('/**\n * The slots one host', start)
  let source = original.slice(start, end)
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  const bindings = {
    sql,
    selectDurationMinutes,
    toInstant,
    assertCachedCalendarSync,
    eventTypeNotFound: () => new DomainError('not_found', 'event_type_not_found'),
    earlier: (a: Temporal.Instant, b: Temporal.Instant) =>
      Temporal.Instant.compare(a, b) <= 0 ? a : b,
    later: (a: Temporal.Instant, b: Temporal.Instant) =>
      Temporal.Instant.compare(a, b) >= 0 ? a : b,
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return buildAvailabilityInput`,
  )(...Object.values(bindings))
}

describe.skipIf(!serverUrl)('group slot availability', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_avail' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const f = await groupFixture(owned.pool)
    await createFixtures(db).schedule(f.host, {
      timeZone: 'UTC',
      weeklyHours: Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
          (day) => [day, [{ start: '09:00', end: '17:00' }]],
        ),
      ),
    })
    return f
  }
  const query = (f: GroupFixture, start = f.start, excludeGroupSlotIds?: string[]) => ({
    eventTypeId: f.event,
    hostUserId: f.host,
    rangeStart: instant(start),
    rangeEnd: instant(start).add({ minutes: 30 }),
    now: instant('2031-12-01T00:00Z'),
    excludeGroupSlotIds,
  })

  it.each([
    ['max_bookings_per_day', '2032-01-02T12:00Z'],
    ['max_bookings_per_week', '2032-01-04T12:00Z'],
    ['max_bookings_per_month', '2032-01-29T12:00Z'],
  ] as const)(
    'counts one occupied slot for %s, including distant period starts',
    async (limit, target) => {
      const f = await fixture()
      const { slot } = await occupiedSlot(f, 3)
      await owned.pool.query(`UPDATE event_types SET ${limit}=2 WHERE id=$1`, [f.event])
      const input = await buildAvailabilityInput(db, query(f, target))
      expect(input?.bookings).toHaveLength(1)
      expect(await findSlots(db, query(f, target))).toHaveLength(1)
      await owned.pool.query(`UPDATE event_types SET ${limit}=1 WHERE id=$1`, [f.event])
      expect(await findSlots(db, query(f, target))).toEqual([])
      // Filling an existing slot does not consume a second allowance.
      expect(await findSlots(db, query(f, f.start, [slot]))).toHaveLength(1)
      expect(await findSlots(db, query(f))).toEqual([])
    },
  )

  it.each([
    ['2027-03-14T06:30Z', '2027-03-14T07:30Z'],
    ['2027-11-07T05:30Z', '2027-11-07T06:30Z'],
  ])('keeps the exact elapsed group interval across DST at %s', async (start, end) => {
    const f = await fixture()
    f.start = start
    f.end = end
    await db
      .updateTable('schedules')
      .set({
        time_zone: 'America/New_York',
        weekly_hours: JSON.stringify({ sunday: [{ start: '00:00', end: '05:00' }] }),
      })
      .where('user_id', '=', f.host)
      .execute()
    await owned.pool.query(
      'UPDATE event_types SET duration_minutes=60,allowed_durations_minutes=ARRAY[60],slot_step_minutes=30 WHERE id=$1',
      [f.event],
    )
    const { slot } = await occupiedSlot(f, 2)
    const q = {
      ...query(f, start, [slot]),
      durationMinutes: 60,
      rangeEnd: instant(end),
      now: instant('2027-01-01T00:00Z'),
    }
    const result = await findSlots(db, q)
    expect(result.some((s) => s.start.equals(instant(start)) && s.end.equals(instant(end)))).toBe(
      true,
    )
    expect(await findSlots(db, { ...q, excludeGroupSlotIds: [] })).toEqual([])
  })

  it('retains source occupancy for survivors and releases it only after final cancellation', async () => {
    const f = await fixture()
    const { bookings } = await occupiedSlot(f, 2)
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[0]],
    )
    expect(await findSlots(db, query(f))).toEqual([])
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[1]],
    )
    expect(await findSlots(db, query(f))).toHaveLength(1)
  })

  it('uses slot snapshot buffers across organizations without charging another event limits', async () => {
    const f = await fixture()
    await occupiedSlot(f, 2, { buffer_after_minutes: 60 })
    await owned.pool.query('UPDATE event_types SET buffer_after_minutes=0 WHERE id=$1', [f.event])
    const other = await groupFixture(owned.pool)
    const q = { ...query(f, f.end), eventTypeId: other.event }
    const input = await buildAvailabilityInput(db, q)
    expect(input?.bookings).toEqual([])
    expect(input?.busy?.some((b) => b.end.equals(instant(f.end).add({ minutes: 60 })))).toBe(true)
    expect(await findSlots(db, q)).toEqual([])
    expect(
      await findSlots(db, {
        ...q,
        rangeStart: instant(f.end).add({ minutes: 60 }),
        rangeEnd: instant(f.end).add({ minutes: 90 }),
      }),
    ).toHaveLength(1)
  })

  it('never excludes another slot when checking an exact join', async () => {
    const f = await fixture()
    const first = await occupiedSlot(f)
    const second = await occupiedSlot({
      ...f,
      start: '2032-01-02T11:00Z',
      end: '2032-01-02T11:30Z',
    })
    const input = await buildAvailabilityInput(db, query(f, f.start, [first.slot]))
    expect(input?.bookings).toHaveLength(1)
    expect(input?.bookings?.[0]?.start.equals(instant('2032-01-02T11:00Z'))).toBe(true)
    expect(await findSlots(db, query(f, '2032-01-02T11:00Z', [first.slot]))).toEqual([])
    expect(await findSlots(db, query(f, '2032-01-02T11:00Z', [second.slot]))).toHaveLength(1)
  })

  it('omits only the mapped provider copy, retaining simultaneous unrelated busy events', async () => {
    const f = await fixture()
    const { slot } = await occupiedSlot(f)
    const calendar = await createFixtures(db).calendarBusy(f.host, [
      [f.start, f.end],
      [f.start, f.end],
    ])
    await owned.pool.query(
      `INSERT INTO group_slot_calendar_events(group_slot_id,calendar_id,external_event_id,count_revision)
       VALUES ($1,$2,$3,1)`,
      [slot, calendar.calendarId, calendar.externalEventIds[0]],
    )
    const input = await buildAvailabilityInput(db, query(f, f.start, [slot]))
    expect(input?.busy).toHaveLength(1)
    expect(await findSlots(db, query(f, f.start, [slot]))).toEqual([])
    await db
      .deleteFrom('calendar_busy')
      .where('calendar_id', '=', calendar.calendarId)
      .where('external_event_id', '=', calendar.externalEventIds[1] as string)
      .execute()
    expect(await findSlots(db, query(f, f.start, [slot]))).toHaveLength(1)
  })

  it.each([
    { name: 'slot occupancy', change: ['.unionAll(groupBookings)', ''] },
    {
      name: 'one count per occupied slot',
      change: ['.unionAll(groupBookings)', '.unionAll(groupBookings).unionAll(groupBookings)'],
    },
    { name: 'complete group period query', change: ['...(periodWindows.length > 0', '...(false'] },
    {
      name: 'active slot occupancy',
      change: [".where('gh.active', '=', true)", ".where('gh.active', '=', false)"],
    },
    {
      name: 'snapshot buffers',
      change: ["'gs.buffer_after_minutes',", "sql<number>`0`.as('buffer_after_minutes'),"],
    },
  ])('detects a broken $name using the real query source copy', async ({ change }) => {
    const f = await fixture()
    await occupiedSlot(f, 3, { buffer_after_minutes: 60 })
    await owned.pool.query('UPDATE event_types SET max_bookings_per_month=1 WHERE id=$1', [f.event])
    const check = async (copy: typeof buildAvailabilityInput) => {
      const input = await copy(db, query(f, '2032-01-29T12:00Z'))
      expect(input?.bookings).toHaveLength(1)
      expect(input?.bookings?.[0]?.bufferAfterMinutes).toBe(60)
    }
    await check(sourceCopy())
    await expect(check(sourceCopy(change as [string, string]))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(sourceCopy())
  })

  it('detects removing exact-slot exclusion and restores the original source', async () => {
    const f = await fixture()
    const { slot } = await occupiedSlot(f)
    const check = async (copy: typeof buildAvailabilityInput) => {
      expect((await copy(db, query(f, f.start, [slot])))?.bookings).toEqual([])
    }
    await check(sourceCopy())
    await expect(
      check(
        sourceCopy([
          "q.where('gs.id', 'not in', query.excludeGroupSlotIds as readonly string[])",
          'q',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await check(sourceCopy())
  })

  it('detects excluding unrelated provider copies and restores the original source', async () => {
    const f = await fixture()
    const { slot } = await occupiedSlot(f)
    const calendar = await createFixtures(db).calendarBusy(f.host, [
      [f.start, f.end],
      [f.start, f.end],
    ])
    await owned.pool.query(
      `INSERT INTO group_slot_calendar_events(group_slot_id,calendar_id,external_event_id,count_revision)
       VALUES ($1,$2,$3,1)`,
      [slot, calendar.calendarId, calendar.externalEventIds[0]],
    )
    const check = async (copy: typeof buildAvailabilityInput) => {
      expect((await copy(db, query(f, f.start, [slot])))?.busy).toHaveLength(1)
    }
    await check(sourceCopy())
    await expect(
      check(sourceCopy(['AND gsce.external_event_id=cb.external_event_id', ''])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await check(sourceCopy())
  })

  it('rejects a second open tuple and permits a new generation after retirement', async () => {
    const f = await fixture()
    const first = await occupiedSlot(f)
    await expect(transaction(owned.pool, (c) => insertSlot(c, f))).rejects.toMatchObject({
      code: '23505',
      constraint: 'group_slots_open_tuple',
    })
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [first.bookings[0]],
    )
    const second = await occupiedSlot(f)
    expect(second.slot).not.toBe(first.slot)
  })
})
