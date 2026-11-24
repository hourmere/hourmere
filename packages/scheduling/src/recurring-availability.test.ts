import { randomUUID } from 'node:crypto'
import type { WeeklyHours } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type RawBuilder, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { suspendScimMember } from '../../db/src/scim-suspension-fixtures.ts'
import { findSlots } from './availability.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { checkRecurringAvailability } from './recurring-availability.ts'
import type { RecurringOccurrence } from './recurring-rules.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  type Fixtures,
  testContext,
  weekdays,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const NOW = instant('2026-11-01T00:00Z')
const everyDay: WeeklyHours = {
  ...weekdays({ start: '00:00', end: '24:00' }),
  saturday: [{ start: '00:00', end: '24:00' }],
  sunday: [{ start: '00:00', end: '24:00' }],
}

function occurrences(...starts: string[]): RecurringOccurrence[] {
  return starts.map((value, index) => {
    const start = instant(value)
    return {
      ordinal: index + 1,
      start,
      end: start.add({ minutes: 30 }),
      localStart: start.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
      offset: '+00:00',
    }
  })
}

describe.skipIf(!serverUrl)('recurring availability on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'recurring_avail',
    })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function individual(rules: EventTypeFixture = {}, timeZone = 'UTC') {
    const host = await f.host({ timeZone: 'Asia/Tokyo' })
    await f.schedule(host.userId, { timeZone: 'UTC', weeklyHours: everyDay })
    const scheduleId = await f.schedule(host.userId, {
      timeZone,
      weeklyHours: everyDay,
      isDefault: false,
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      ...rules,
      hosts: [{ userId: host.userId, scheduleId }],
    })
    return { ...host, scheduleId, eventTypeId }
  }

  it.each([
    {
      period: 'day',
      limits: { maxBookingsPerDay: 2 },
      first: '2026-11-03T23:00Z',
      second: '2026-11-04T00:00Z',
      counted: '2026-11-03T10:00Z',
      previous: '2026-11-03T06:00Z',
    },
    {
      period: 'Monday-based week',
      limits: { maxBookingsPerWeek: 2 },
      first: '2026-11-08T23:00Z',
      second: '2026-11-09T00:00Z',
      counted: '2026-11-02T08:00Z',
      previous: '2026-11-02T07:00Z',
    },
    {
      period: 'month',
      limits: { maxBookingsPerMonth: 2 },
      first: '2026-11-30T23:00Z',
      second: '2026-12-01T00:00Z',
      counted: '2026-11-01T07:00Z',
      previous: '2026-11-01T06:00Z',
    },
  ])(
    'accumulates both starts in the host schedule’s $period',
    async ({ limits, first, second, counted, previous }) => {
      const { organizationId, userId, eventTypeId } = await individual(
        limits,
        'America/Los_Angeles',
      )
      const book = (start: string, type = eventTypeId) =>
        f.booking(organizationId, [userId], start, instant(start).add({ minutes: 30 }).toString(), {
          eventTypeId: type,
        })
      await book(previous)
      const countedBooking = await book(counted)
      const otherEvent = await f.eventType(organizationId, userId)
      await book(instant(counted).add({ hours: 1 }).toString(), otherEvent)

      const request = {
        eventTypeId,
        organizationId,
        now: NOW,
        occurrences: occurrences(first, second),
      }
      for (const value of [first, second]) {
        const start = instant(value)
        const end = start.add({ minutes: 30 })
        await expect(
          findSlots(db, {
            eventTypeId,
            hostUserId: userId,
            rangeStart: start,
            rangeEnd: end,
            now: NOW,
          }),
        ).resolves.toEqual([{ start, end }])
      }

      const overCapacity = await checkRecurringAvailability(db, request)
      expect(overCapacity.canBook).toBe(false)
      expect(overCapacity.occurrences).toContainEqual(
        expect.objectContaining({ available: false, reason: 'unavailable' }),
      )
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', countedBooking)
        .execute()
      const roomForBoth = await checkRecurringAvailability(db, request)
      expect(roomForBoth.canBook).toBe(true)
      expect(roomForBoth.occurrences.map((row) => row.available)).toEqual([true, true])
    },
  )

  it('applies both events’ buffers, blocks imports and keeps busy details private', async () => {
    const { organizationId, userId, eventTypeId } = await individual({ bufferBeforeMinutes: 10 })
    const otherOrg = await f.organization()
    await f.member(userId, otherOrg)
    const otherEvent = await f.eventType(otherOrg, null, {
      hosts: [{ userId }],
      bufferAfterMinutes: 15,
    })
    await f.booking(otherOrg, [userId], '2026-11-03T08:30Z', '2026-11-03T09:10Z', {
      eventTypeId: otherEvent,
      attendee: { name: 'Private fixture invitee', email: 'private-fixture@example.test' },
    })
    await f.booking(otherOrg, [userId], '2026-11-04T09:30Z', '2026-11-04T10:00Z', {
      source: 'import',
    })
    const result = await checkRecurringAvailability(db, {
      eventTypeId,
      organizationId,
      now: NOW,
      occurrences: occurrences('2026-11-03T09:30Z', '2026-11-04T09:30Z', '2026-11-05T09:30Z'),
    })
    expect(result).toMatchObject({
      canBook: false,
      occurrences: [
        { ordinal: 1, available: false, reason: 'unavailable' },
        { ordinal: 2, available: false, reason: 'unavailable' },
        { ordinal: 3, available: true },
      ],
    })
    const projection = JSON.stringify(result.occurrences)
    expect(projection).not.toContain(otherEvent)
    expect(projection).not.toContain('Private fixture invitee')
    expect(projection).not.toContain('private-fixture@example.test')
    expect(projection).not.toContain('Fixture booking')
  })

  it('rejects conflicts within the proposal and permits touching buffer endpoints', async () => {
    const { organizationId, eventTypeId } = await individual({
      slotStepMinutes: 15,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 5,
    })
    const request = { eventTypeId, organizationId, now: NOW }
    await expect(
      checkRecurringAvailability(db, {
        ...request,
        occurrences: occurrences('2026-11-03T10:00Z', '2026-11-03T10:30Z'),
      }),
    ).resolves.toMatchObject({ canBook: false })
    await expect(
      checkRecurringAvailability(db, {
        ...request,
        occurrences: occurrences('2026-11-03T10:00Z', '2026-11-03T10:45Z'),
      }),
    ).resolves.toMatchObject({ canBook: true })
  })

  it('checks each explicit start against notice, the slot grid, overrides and the booking window', async () => {
    const { organizationId, eventTypeId, scheduleId } = await individual({
      minimumNoticeMinutes: 60,
      bookingWindowDays: 3,
    })
    await db
      .insertInto('schedule_overrides')
      .values({ schedule_id: scheduleId, date: '2026-11-03', intervals: '[]' })
      .execute()
    await expect(
      checkRecurringAvailability(db, {
        eventTypeId,
        organizationId,
        now: NOW,
        occurrences: occurrences(
          '2026-11-01T00:30Z',
          '2026-11-01T12:15Z',
          '2026-11-02T12:00Z',
          '2026-11-03T12:00Z',
          '2026-11-05T12:00Z',
        ),
      }),
    ).resolves.toMatchObject({
      canBook: false,
      occurrences: [
        { available: false },
        { available: false },
        { available: true },
        { available: false },
        { available: false, reason: 'outside_booking_window' },
      ],
    })
  })

  it('uses the database hold deadline for both occupancy and period counts without writing', async () => {
    const { organizationId, userId, eventTypeId } = await individual({ maxBookingsPerDay: 2 })
    const clock = await db
      .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
      .executeTakeFirstOrThrow()
    const now = Temporal.Instant.fromEpochMilliseconds(clock.now.getTime())
    const date = now.toZonedDateTimeISO('UTC').toPlainDate().add({ days: 2 })
    const time = (hour: string, day = date) => `${day}T${hour}:00Z`
    const hold = (start: string, expiresAt: RawBuilder<Date>) =>
      db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('bookings')
          .values({
            organization_id: organizationId,
            event_type_id: eventTypeId,
            start_at: start,
            end_at: instant(start).add({ minutes: 30 }).toString(),
            title: 'Synthetic payment hold',
            source: 'web',
            status: 'pending_payment',
            payment_hold_expires_at: expiresAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('booking_hosts')
          .values({ booking_id: row.id, user_id: userId })
          .execute()
        return row.id
      })
    const tomorrow = date.add({ days: 1 })
    const active = await hold(time('09'), sql<Date>`clock_timestamp() + interval '15 minutes'`)
    const overdue = await hold(
      time('11', tomorrow),
      sql<Date>`clock_timestamp() - interval '1 minute'`,
    )
    const check = (...starts: string[]) =>
      checkRecurringAvailability(db, {
        eventTypeId,
        organizationId,
        now,
        occurrences: occurrences(...starts),
      })

    const overlap = await check(time('09'), time('11', tomorrow), time('13', tomorrow))
    expect(overlap.occurrences).toMatchObject([
      { available: false, reason: 'unavailable' },
      { available: true },
      { available: true },
    ])
    const capacity = await check(time('12'), time('13'))
    expect(capacity.canBook).toBe(false)
    expect(capacity.occurrences).toContainEqual(expect.objectContaining({ available: false }))
    await expect(check(time('12'), time('12', tomorrow))).resolves.toMatchObject({
      canBook: true,
    })
    expect(
      await db
        .selectFrom('bookings')
        .select('status')
        .where('id', 'in', [active, overdue])
        .execute(),
    ).toEqual([{ status: 'pending_payment' }, { status: 'pending_payment' }])
  })

  async function roundRobin() {
    const first = await createTestUser(db, 'First candidate')
    const second = await createTestUser(db, 'Second candidate')
    const team = await createTestTeam(db, [
      { user: first, role: 'owner' },
      { user: second, role: 'member' },
    ])
    for (const host of [first, second]) {
      await f.schedule(host.id, { timeZone: 'UTC', weeklyHours: everyDay })
    }
    const ctx = testContext(db, team.as(first), () => NOW)
    const event = await createEventType(ctx, {
      slug: 'batch-rotation',
      title: 'Rotating hosts',
      schedulingType: 'round_robin',
      durationMinutes: 30,
      hosts: [{ userId: first.id }, { userId: second.id }],
    })
    await activateRoundRobin(ctx, event.id)
    const request = {
      eventTypeId: event.id,
      organizationId: team.id,
      now: NOW,
      occurrences: occurrences('2026-11-03T12:00Z', '2026-11-10T12:00Z'),
    }
    return { first, second, request }
  }

  it('intersects round-robin candidates over all dates and rechecks current eligibility', async () => {
    const { first, second, request } = await roundRobin()
    await f.calendarBusy(first.id, [['2026-11-10T12:00Z', '2026-11-10T12:30Z']], { now: NOW })
    const { calendarId } = await f.calendarBusy(
      second.id,
      [['2026-11-03T12:00Z', '2026-11-03T12:30Z']],
      { now: NOW },
    )
    const sequence = () =>
      db
        .selectFrom('round_robin_state')
        .select('next_sequence')
        .where('event_type_id', '=', request.eventTypeId)
        .executeTakeFirstOrThrow()
    const before = await sequence()

    await expect(checkRecurringAvailability(db, request)).resolves.toMatchObject({
      canBook: false,
      seriesReason: 'no_common_host',
      hostUserIds: [],
      occurrences: [{ available: true }, { available: true }],
    })
    await db
      .updateTable('calendars')
      .set({ check_conflicts: false })
      .where('id', '=', calendarId)
      .execute()
    await expect(checkRecurringAvailability(db, request)).resolves.toMatchObject({
      canBook: true,
      hostUserIds: [second.id],
    })
    expect(await sequence()).toEqual(before)

    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', second.id)
      .execute()
    await expect(checkRecurringAvailability(db, request)).resolves.toMatchObject({
      canBook: false,
      hostUserIds: [],
      occurrences: [{ available: true }, { available: false }],
    })

    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', second.id)
      .execute()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', request.organizationId)
      .where('userId', '=', second.id)
      .execute()
    await expect(checkRecurringAvailability(db, request)).resolves.toMatchObject({
      canBook: false,
      hostUserIds: [],
      occurrences: [{ available: true }, { available: false }],
    })
  })

  it('excludes a SCIM-suspended host from recurring candidates', async () => {
    const { first, second, request } = await roundRobin()
    await suspendScimMember(db, request.organizationId, second.id)
    await expect(checkRecurringAvailability(db, request)).resolves.toMatchObject({
      canBook: true,
      hostUserIds: [first.id],
    })
  })

  it('fails with unknown freshness when the stale candidate could be the only common host', async () => {
    const { first, second, request } = await roundRobin()
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: second.id,
        provider: 'google',
        external_account_id: randomUUID(),
        credentials: Buffer.from('synthetic-unused-credentials'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: randomUUID(),
        name: 'Synthetic stale calendar',
        time_zone: 'UTC',
        check_conflicts: true,
        last_synced_at: new Date(NOW.epochMilliseconds),
        sync_state: {
          version: 2,
          timeZone: 'UTC',
          start: '2026-10-01T00:00Z',
          end: '2026-11-07T00:00Z',
        },
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    // Old busy data in the uncovered window cannot decide the candidate is blocked.
    await db
      .insertInto('calendar_busy')
      .values({
        calendar_id: calendar.id,
        external_event_id: 'old-event',
        period: '[2026-11-10T12:00Z,2026-11-10T12:30Z)',
      })
      .execute()
    await expect(checkRecurringAvailability(db, request)).resolves.toMatchObject({
      canBook: true,
      hostUserIds: [first.id],
    })
    await f.calendarBusy(first.id, [['2026-11-10T12:00Z', '2026-11-10T12:30Z']], { now: NOW })
    await expect(checkRecurringAvailability(db, request)).rejects.toMatchObject({
      code: 'calendar_sync_unavailable',
    })
    await f.calendarBusy(second.id, [['2026-11-03T12:00Z', '2026-11-03T12:30Z']], { now: NOW })
    // The stale candidate independently fails the first date, but no known host can
    // cover the second date. That date still has unknown availability.
    await expect(checkRecurringAvailability(db, request)).rejects.toMatchObject({
      code: 'calendar_sync_unavailable',
    })
  })

  it('uses the personal owner’s default schedule when there is no schedule assignment', async () => {
    const { userId, organizationId } = await f.host()
    await f.schedule(userId, { timeZone: 'UTC', weeklyHours: everyDay })
    const eventTypeId = await f.eventType(organizationId, userId, { hosts: [] })
    await expect(
      checkRecurringAvailability(db, {
        eventTypeId,
        organizationId,
        now: NOW,
        occurrences: occurrences('2026-11-03T12:00Z', '2026-11-10T12:00Z'),
      }),
    ).resolves.toMatchObject({ canBook: true, hostUserIds: [userId] })
  })

  it('scopes the event and configured hosts to its organization', async () => {
    const { eventTypeId } = await individual()
    const other = await f.host()
    await expect(
      checkRecurringAvailability(db, {
        eventTypeId,
        organizationId: other.organizationId,
        now: NOW,
        occurrences: occurrences('2026-11-03T12:00Z', '2026-11-10T12:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
  })
})
