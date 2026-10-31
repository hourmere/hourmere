import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildAvailabilityInput,
  findSlots,
  getPublicEventType,
  listPublicSlots,
  listPublicTeamSlots,
} from './availability.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  type Fixtures,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T00:00Z')
const range = { start: instant('2026-11-02T00:00Z'), end: instant('2026-11-03T00:00Z') }
const starts = (slots: { start: string }[]) => slots.map((slot) => slot.start.slice(11, 16))
const views = (slots: { start: Temporal.Instant; end: Temporal.Instant }[]) =>
  slots.map((slot) => ({
    start: slot.start.toString({ fractionalSecondDigits: 3 }),
    end: slot.end.toString({ fractionalSecondDigits: 3 }),
  }))

describe.skipIf(!serverUrl)('selected duration availability in Postgres', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(rules: EventTypeFixture = {}) {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, {
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] },
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'call',
      ...rules,
    })
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', eventTypeId)
      .execute()
    const query = {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: range.start,
      rangeEnd: range.end,
      now: now(),
    }
    return {
      host,
      eventTypeId,
      query,
      ctx: { db, now },
      page: { handle: host.handle, slug: 'call' },
    }
  }

  it('offers each configured length and exposes the public choices with its default', async () => {
    const s = await setup()
    for (const durationMinutes of [15, 30, 60]) {
      const slots = await listPublicSlots(s.ctx, { ...s.page, ...range, durationMinutes })
      expect(slots).toHaveLength(180 / durationMinutes)
      expect(
        slots.every(
          (slot) =>
            instant(slot.end).since(instant(slot.start)).total('minutes') === durationMinutes,
        ),
      ).toBe(true)
      expect(slots).toEqual(views(await findSlots(db, { ...s.query, durationMinutes })))
    }
    expect(await listPublicSlots(s.ctx, { ...s.page, ...range })).toEqual(
      await listPublicSlots(s.ctx, { ...s.page, ...range, durationMinutes: 30 }),
    )
    expect(await getPublicEventType(s.ctx, s.page)).toEqual({
      ...s.page,
      title: 'Intro call',
      description: null,
      durationMinutes: 30,
      allowedDurationsMinutes: [15, 30, 60],
      location: null,
      questions: [],
      allowGuests: false,
      host: { name: 'Ada Lovelace', timeZone: 'UTC' },
    })
  })

  it('applies selected lengths to buffers, notice, explicit step, and shared daily limits', async () => {
    const s = await setup({
      slotStepMinutes: 15,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      minimumNoticeMinutes: 60,
      maxBookingsPerDay: 1,
    })
    await f.calendarBusy(s.host.userId, [['2026-11-02T10:30Z', '2026-11-02T10:45Z']])
    const ctx = { db, now: () => instant('2026-11-02T08:20Z') }
    const expected = new Map([
      [15, ['09:30', '09:45', '10:00', '11:00', '11:15', '11:30', '11:45']],
      [30, ['09:30', '09:45', '11:00', '11:15', '11:30']],
      [60, ['11:00']],
    ])
    for (const durationMinutes of [15, 30, 60]) {
      expect(starts(await listPublicSlots(ctx, { ...s.page, ...range, durationMinutes }))).toEqual(
        expected.get(durationMinutes),
      )
    }
    await f.booking(
      s.host.organizationId,
      [s.host.userId],
      '2026-11-02T07:00Z',
      '2026-11-02T07:15Z',
      { eventTypeId: s.eventTypeId },
    )
    for (const durationMinutes of [15, 30, 60]) {
      expect(await listPublicSlots(ctx, { ...s.page, ...range, durationMinutes })).toEqual([])
    }
  })

  it.each([0, 45, 1441, 15.5])(
    'rejects duration %s before looking for a host schedule',
    async (durationMinutes) => {
      const s = await setup()
      await db.deleteFrom('schedules').where('user_id', '=', s.host.userId).execute()
      await expect(
        buildAvailabilityInput(db, { ...s.query, durationMinutes }),
      ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_duration' })
      await expect(
        listPublicSlots(s.ctx, { ...s.page, ...range, durationMinutes }),
      ).rejects.toMatchObject({ code: 'invalid_duration' })
    },
  )

  it('uses the selected duration in the candidate-budget check', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [1, 30] })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(
      listPublicSlots(s.ctx, {
        ...s.page,
        start: range.start,
        end: range.start.add({ minutes: 20_001 }),
        durationMinutes: 1,
      }),
    ).rejects.toMatchObject({ code: 'range_too_long' })
    await expect(
      listPublicSlots(s.ctx, {
        ...s.page,
        start: range.start,
        end: range.start.add({ minutes: 20_001 }),
        durationMinutes: 30,
      }),
    ).resolves.toBeInstanceOf(Array)
  })

  it('preserves an excluded booking’s original duration after the default and list change', async () => {
    const s = await setup()
    const bookingId = await f.booking(
      s.host.organizationId,
      [s.host.userId],
      '2026-11-02T09:00Z',
      '2026-11-02T10:00Z',
      { eventTypeId: s.eventTypeId },
    )
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 15, allowed_durations_minutes: [15, 30] })
      .where('id', '=', s.eventTypeId)
      .execute()
    const result = await findSlots(db, { ...s.query, excludeBookingId: bookingId })
    expect(views(result)).toEqual([
      { start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' },
      { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T11:00:00.000Z' },
      { start: '2026-11-02T11:00:00.000Z', end: '2026-11-02T12:00:00.000Z' },
    ])
    await expect(
      findSlots(db, { ...s.query, excludeBookingId: bookingId, durationMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'invalid_duration' })
    expect(
      await findSlots(db, { ...s.query, excludeBookingId: bookingId, durationMinutes: 30 }),
    ).toHaveLength(6)
  })

  it.each(['collective', 'round_robin'] as const)(
    'uses complete selected intervals for %s hosts',
    async (schedulingType) => {
      const owner = await createTestUser(db, 'First host')
      const other = await createTestUser(db, 'Second host')
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: other, role: 'member' },
      ])
      const ctx = testContext(db, team.as(owner), now)
      for (const user of [owner, other])
        await f.schedule(user.id, {
          timeZone: 'UTC',
          weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] },
        })
      let event = await createEventType(ctx, {
        title: 'Team call',
        slug: 'call',
        durationMinutes: 30,
        schedulingType,
        hosts: [{ userId: owner.id }, { userId: other.id }],
      })
      await db
        .updateTable('event_types')
        .set({ allowed_durations_minutes: [15, 30, 60], slot_step_minutes: 15 })
        .where('id', '=', event.id)
        .execute()
      if (schedulingType === 'round_robin') event = await activateRoundRobin(ctx, event.id)
      await f.calendarBusy(owner.id, [['2026-11-02T10:00Z', '2026-11-02T12:00Z']])
      await f.calendarBusy(other.id, [['2026-11-02T09:00Z', '2026-11-02T09:30Z']])
      const slots = (durationMinutes: number) =>
        listPublicTeamSlots(
          { db, now },
          { handle: ctx.principal.organization.slug, slug: event.slug, ...range, durationMinutes },
        )
      expect(starts(await slots(15))).toEqual(
        schedulingType === 'collective'
          ? ['09:30', '09:45']
          : [
              '09:00',
              '09:15',
              '09:30',
              '09:45',
              '10:00',
              '10:15',
              '10:30',
              '10:45',
              '11:00',
              '11:15',
              '11:30',
              '11:45',
            ],
      )
      expect(starts(await slots(60))).toEqual(
        schedulingType === 'collective'
          ? []
          : ['09:00', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00'],
      )
    },
  )

  it.each([
    ['America/Los_Angeles', '2026-03-08', true],
    ['America/Los_Angeles', '2026-11-01', false],
    ['Europe/Berlin', '2026-03-29', true],
    ['Europe/Berlin', '2026-10-25', false],
  ] as const)('keeps elapsed durations across DST in %s on %s', async (timeZone, date, spring) => {
    const host = await f.host({ timeZone })
    await f.schedule(host.userId, {
      timeZone,
      weeklyHours: { sunday: [{ start: '01:00', end: '04:00' }] },
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', eventTypeId)
      .execute()
    const start = Temporal.PlainDate.from(date).toZonedDateTime(timeZone).toInstant()
    const end = Temporal.PlainDate.from(date).add({ days: 1 }).toZonedDateTime(timeZone).toInstant()
    for (const durationMinutes of [15, 30, 60]) {
      const result = await findSlots(db, {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: start,
        rangeEnd: end,
        now: start.subtract({ hours: 24 }),
        durationMinutes,
      })
      expect(result).toHaveLength((spring ? 120 : 180) / durationMinutes)
      expect(
        result.every((slot) => slot.end.since(slot.start).total('minutes') === durationMinutes),
      ).toBe(true)
      const localStarts = result.map((slot) =>
        slot.start.toZonedDateTimeISO(timeZone).toPlainTime().toString({ smallestUnit: 'minute' }),
      )
      if (spring) expect(localStarts.some((time) => time.startsWith('02:'))).toBe(false)
      else expect(new Set(localStarts).size).toBe(localStarts.length)
      if (durationMinutes === 60) {
        expect(result[0]?.start.toZonedDateTimeISO(timeZone).hour).toBe(1)
        expect(result[0]?.end.toZonedDateTimeISO(timeZone).hour).toBe(
          spring ? 3 : timeZone === 'America/Los_Angeles' ? 1 : 2,
        )
      }
    }
  })
})
