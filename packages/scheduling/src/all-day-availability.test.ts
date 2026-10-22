import { randomUUID } from 'node:crypto'
import type { WeeklyHours } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAvailabilityInput, findSlots, listPublicTeamSlots } from './availability.ts'
import { createFixtures, type Fixtures, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = (value: string) => Temporal.Instant.from(value)
const NOW = instant('2026-01-01T12:00:00Z')
const everyDay: WeeklyHours = {
  ...weekdays({ start: '00:00', end: '24:00' }),
  saturday: [{ start: '00:00', end: '24:00' }],
  sunday: [{ start: '00:00', end: '24:00' }],
}
const busyTimes = (input: Awaited<ReturnType<typeof buildAvailabilityInput>>) =>
  input?.busy
    ?.map(({ start, end }) => [start.toString(), end.toString()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))

describe.skipIf(!serverUrl)('all-day busy dates in schedule zones (real Postgres)', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  async function calendar(
    userId: string,
    timeZone: string,
    dates: [string, string][],
    timed: [string, string][] = [],
  ) {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: 'google',
        external_account_id: randomUUID(),
        credentials: Buffer.from('synthetic-unused-credentials'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const result = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: randomUUID(),
        name: 'Synthetic Google calendar',
        time_zone: timeZone,
        check_conflicts: true,
        last_synced_at: new Date(NOW.epochMilliseconds),
        sync_state: {
          version: 2,
          timeZone,
          start: '2025-01-01T00:00:00Z',
          end: '2028-01-01T00:00:00Z',
        },
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const [start, end] of dates) {
      await db
        .insertInto('calendar_busy')
        .values({
          calendar_id: result.id,
          external_event_id: randomUUID(),
          all_day_start: start,
          all_day_end: end,
        })
        .execute()
    }
    for (const [start, end] of timed) {
      await db
        .insertInto('calendar_busy')
        .values({
          calendar_id: result.id,
          external_event_id: randomUUID(),
          period: `[${start},${end})`,
        })
        .execute()
    }
    return result.id
  }

  it('rejects fresh v1 snapshots and accepts v2 snapshots for the same all-day query', async () => {
    const host = await f.host()
    await f.schedule(host.userId, { timeZone: 'America/Los_Angeles' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    const calendarId = await calendar(host.userId, 'Asia/Shanghai', [['2026-11-10', '2026-11-11']])
    const query = {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: instant('2026-11-09T08:00:00Z'),
      rangeEnd: instant('2026-11-12T08:00:00Z'),
      now: NOW,
    }
    const syncState = {
      version: 1,
      timeZone: 'Asia/Shanghai',
      token: 'synthetic-legacy-worker-cursor',
      start: '2025-01-01T00:00:00Z',
      end: '2028-01-01T00:00:00Z',
    }
    await db
      .updateTable('calendars')
      .set({ sync_state: syncState })
      .where('id', '=', calendarId)
      .execute()
    await expect(findSlots(db, query)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'calendar_sync_unavailable',
    })

    await db
      .updateTable('calendars')
      .set({ sync_state: { ...syncState, version: 2 } })
      .where('id', '=', calendarId)
      .execute()
    expect(busyTimes(await buildAvailabilityInput(db, query))).toEqual([
      ['2026-11-10T08:00:00Z', '2026-11-11T08:00:00Z'],
    ])
    const localDates = (await findSlots(db, query)).map((slot) =>
      slot.start.toZonedDateTimeISO('America/Los_Angeles').toPlainDate().toString(),
    )
    expect(localDates).toEqual([
      ...Array<string>(16).fill('2026-11-09'),
      ...Array<string>(16).fill('2026-11-11'),
    ])
  })

  it.each(['Asia/Shanghai', 'America/New_York'])(
    'blocks November 10 in the LA schedule with a %s calendar',
    async (calendarZone) => {
      // The profile and default schedule also differ: the event-selected schedule decides.
      const host = await f.host({ timeZone: 'Pacific/Auckland' })
      await f.schedule(host.userId, { timeZone: 'Europe/Berlin' })
      const scheduleId = await f.schedule(host.userId, {
        timeZone: 'America/Los_Angeles',
        isDefault: false,
      })
      const eventTypeId = await f.eventType(host.organizationId, host.userId, {
        hosts: [{ userId: host.userId, scheduleId }],
      })
      await calendar(host.userId, calendarZone, [['2026-11-10', '2026-11-11']])
      const query = {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: instant('2026-11-09T08:00:00Z'),
        rangeEnd: instant('2026-11-12T08:00:00Z'),
        now: NOW,
      }
      expect(busyTimes(await buildAvailabilityInput(db, query))).toEqual([
        ['2026-11-10T08:00:00Z', '2026-11-11T08:00:00Z'],
      ])
      const slots = await findSlots(db, query)
      const local = slots.map((slot) =>
        slot.start.toZonedDateTimeISO('America/Los_Angeles').toPlainDateTime().toString(),
      )
      expect(local.filter((start) => start.startsWith('2026-11-09'))).toHaveLength(16)
      expect(local).toContain('2026-11-09T09:00:00')
      expect(local).toContain('2026-11-09T16:30:00')
      expect(local.filter((start) => start.startsWith('2026-11-10'))).toEqual([])
      expect(local.filter((start) => start.startsWith('2026-11-11'))).toHaveLength(16)
    },
  )

  it('blocks multiple local days and leaves the exclusive end date available', async () => {
    const host = await f.host()
    await f.schedule(host.userId, { timeZone: 'America/Los_Angeles' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    await calendar(host.userId, 'Asia/Shanghai', [['2026-11-10', '2026-11-13']])
    const query = {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: instant('2026-11-09T08:00:00Z'),
      rangeEnd: instant('2026-11-14T08:00:00Z'),
      now: NOW,
    }
    expect(busyTimes(await buildAvailabilityInput(db, query))).toEqual([
      ['2026-11-10T08:00:00Z', '2026-11-13T08:00:00Z'],
    ])
    const dates = (await findSlots(db, query)).map((slot) =>
      slot.start.toZonedDateTimeISO('America/Los_Angeles').toPlainDate().toString(),
    )
    expect(dates).toEqual([
      ...Array<string>(16).fill('2026-11-09'),
      ...Array<string>(16).fill('2026-11-13'),
    ])
  })

  it.each([
    {
      zone: 'America/Los_Angeles',
      date: '2026-03-08',
      end: '2026-03-09',
      startAt: '2026-03-08T08:00:00Z',
      endAt: '2026-03-09T07:00:00Z',
      hours: 23,
    },
    {
      zone: 'America/Los_Angeles',
      date: '2026-11-01',
      end: '2026-11-02',
      startAt: '2026-11-01T07:00:00Z',
      endAt: '2026-11-02T08:00:00Z',
      hours: 25,
    },
    {
      zone: 'Europe/Berlin',
      date: '2026-03-29',
      end: '2026-03-30',
      startAt: '2026-03-28T23:00:00Z',
      endAt: '2026-03-29T22:00:00Z',
      hours: 23,
    },
    {
      zone: 'Europe/Berlin',
      date: '2026-10-25',
      end: '2026-10-26',
      startAt: '2026-10-24T22:00:00Z',
      endAt: '2026-10-25T23:00:00Z',
      hours: 25,
    },
  ])('blocks all $hours hours of $date in $zone', async (day) => {
    const host = await f.host()
    await f.schedule(host.userId, { timeZone: day.zone, weeklyHours: everyDay })
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    await calendar(host.userId, 'Asia/Shanghai', [[day.date, day.end]])
    const query = {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: instant(day.startAt).subtract({ hours: 24 }),
      rangeEnd: instant(day.endAt).add({ hours: 24 }),
      now: NOW,
    }
    const input = await buildAvailabilityInput(db, query)
    expect(busyTimes(input)).toEqual([[day.startAt, day.endAt]])
    expect(input?.busy?.[0]?.end.since(input.busy[0].start).total('hours')).toBe(day.hours)
    const localDates = (await findSlots(db, query)).map((slot) =>
      slot.start.toZonedDateTimeISO(day.zone).toPlainDate().toString(),
    )
    expect(localDates.filter((date) => date === day.date)).toEqual([])
    expect(localDates.filter((date) => date === day.end)).toHaveLength(48)
    expect(localDates).toHaveLength(96)
  })

  it.each(['collective', 'round_robin'] as const)(
    'expands each %s host’s busy day in their own default schedule zone',
    async (schedulingType) => {
      const la = await f.host({ timeZone: 'UTC' })
      const berlin = await f.host({ timeZone: 'UTC' })
      await f.schedule(la.userId, { timeZone: 'America/Los_Angeles', weeklyHours: everyDay })
      await f.schedule(berlin.userId, { timeZone: 'Europe/Berlin', weeklyHours: everyDay })
      const teamSlug = `all-day-${randomUUID()}`
      const team = await f.organization(teamSlug)
      await f.member(la.userId, team)
      await f.member(berlin.userId, team)
      const eventTypeId = await f.eventType(team, null, {
        slug: 'call',
        hosts: [{ userId: la.userId }, { userId: berlin.userId }],
      })
      await db
        .updateTable('event_types')
        .set({ scheduling_type: schedulingType })
        .where('id', '=', eventTypeId)
        .execute()
      if (schedulingType === 'round_robin') {
        await db
          .insertInto('round_robin_state')
          .values({ event_type_id: eventTypeId, enabled: true })
          .execute()
      }
      await calendar(la.userId, 'Asia/Shanghai', [['2026-11-10', '2026-11-11']])
      await calendar(berlin.userId, 'America/New_York', [['2026-11-10', '2026-11-11']])
      const rangeStart = instant('2026-11-09T12:00:00Z')
      const rangeEnd = instant('2026-11-11T12:00:00Z')
      for (const [hostUserId, start, end] of [
        [la.userId, '2026-11-10T08:00:00Z', '2026-11-11T08:00:00Z'],
        [berlin.userId, '2026-11-09T23:00:00Z', '2026-11-10T23:00:00Z'],
      ] as const) {
        expect(
          busyTimes(
            await buildAvailabilityInput(db, {
              eventTypeId,
              hostUserId,
              rangeStart,
              rangeEnd,
              now: NOW,
              useDefaultSchedule: true,
            }),
          ),
        ).toEqual([[start, end]])
      }
      const slots = await listPublicTeamSlots(
        { db, now: () => NOW },
        { handle: teamSlug, slug: 'call', start: rangeStart, end: rangeEnd },
      )
      const starts = slots.map((slot) => slot.start)
      expect(starts).toContain('2026-11-09T22:30:00.000Z')
      expect(starts).not.toContain('2026-11-10T08:00:00.000Z')
      expect(starts).toContain('2026-11-11T08:00:00.000Z')
      if (schedulingType === 'collective') {
        expect(starts).not.toContain('2026-11-09T23:00:00.000Z')
        expect(starts).not.toContain('2026-11-10T23:00:00.000Z')
        expect(slots).toHaveLength(30)
      } else {
        expect(starts).toContain('2026-11-09T23:00:00.000Z')
        expect(starts).toContain('2026-11-10T23:00:00.000Z')
        expect(slots).toHaveLength(66)
      }
    },
  )

  it('clips long all-day ranges and leaves timed event instants unchanged', async () => {
    const host = await f.host()
    await f.schedule(host.userId, { timeZone: 'America/Los_Angeles' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    await calendar(
      host.userId,
      'Asia/Shanghai',
      [['1900-01-01', '2100-01-01']],
      [['2026-11-10T17:00:00.0003Z', '2026-11-10T17:00:00.0007Z']],
    )
    const query = {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: instant('2026-11-10T08:00:00Z'),
      rangeEnd: instant('2026-11-11T08:00:00Z'),
      now: NOW,
    }
    expect(busyTimes(await buildAvailabilityInput(db, query))).toEqual([
      ['2026-11-07T08:00:00Z', '2026-11-14T08:00:00Z'],
      ['2026-11-10T17:00:00Z', '2026-11-10T17:00:00.001Z'],
    ])
    expect(await findSlots(db, query)).toEqual([])
  })
})
