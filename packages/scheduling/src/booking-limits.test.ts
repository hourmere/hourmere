// Real PostgreSQL coverage for period capacity: availability and the write transaction
// share the same per-host rules, including bookings outside the requested slot window.
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAvailabilityInput, listPublicSlots, listPublicTeamSlots } from './availability.ts'
import {
  cancelManagedBooking,
  createPublicBooking,
  createPublicTeamBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { PublicContext } from './context.ts'
import { activateRoundRobin, createEventType, updateEventType } from './event-types.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type Fixtures,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const NOW = instant('2026-01-01T00:00Z')
const invitee = { name: 'Synthetic invitee', email: 'invitee@example.com', timeZone: 'UTC' }
const allDays = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => [
    day,
    [{ start: '00:00', end: '23:59' }],
  ]),
)
const local = (date: string, timeZone: string) =>
  Temporal.PlainDateTime.from(date).toZonedDateTime(timeZone).toInstant()
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing test fixture')
  return value
}
type Limits = {
  maxBookingsPerDay?: number | null
  maxBookingsPerWeek?: number | null
  maxBookingsPerMonth?: number | null
}

// One shared fixture pool for the file; races use at most five concurrent transactions.
describe.skipIf(!serverUrl)('weekly and monthly booking limits', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'booking_limits' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(limits: Limits, timeZone = 'UTC', now = NOW) {
    // The profile zone deliberately differs: capacity follows the evaluated schedule.
    const host = await f.host({ timeZone: timeZone === 'UTC' ? 'Asia/Tokyo' : 'UTC' })
    await f.schedule(host.userId, { timeZone, weeklyHours: allDays })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'limited',
      ...limits,
    })
    const page = { handle: host.handle, slug: 'limited' }
    const publicContext = { db, now: () => now }
    const book = (start: Temporal.Instant, idempotencyKey?: string) =>
      createPublicBooking(publicContext, { ...page, start, invitee, idempotencyKey })
    const slots = (start: Temporal.Instant) =>
      listPublicSlots(publicContext, { ...page, start, end: start.add({ minutes: 30 }) })
    const seed = (start: Temporal.Instant, more: Parameters<Fixtures['booking']>[4] = {}) =>
      f.booking(
        host.organizationId,
        [host.userId],
        start.toString(),
        start.add({ minutes: 30 }).toString(),
        {
          eventTypeId,
          ...more,
        },
      )
    return { ...host, eventTypeId, page, book, slots, seed }
  }

  it.each([
    {
      period: 'weekly',
      limits: { maxBookingsPerWeek: 1 },
      dates: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
    },
    {
      period: 'monthly',
      limits: { maxBookingsPerMonth: 1 },
      dates: ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'],
    },
  ])(
    'keeps the $period limit atomic for different days over 20 rounds',
    { timeout: 60_000 },
    async ({ limits, dates }) => {
      for (let round = 0; round < 20; round++) {
        const s = await setup(limits)
        const results = await Promise.allSettled(
          dates.map((day) => s.book(instant(`${day}T12:00Z`))),
        )
        expect(
          results.filter((result) => result.status === 'fulfilled'),
          `round ${round}`,
        ).toHaveLength(1)
        for (const result of results) {
          if (result.status === 'rejected')
            expect(result.reason).toMatchObject({ code: 'slot_unavailable' })
        }
        const rows = await db
          .selectFrom('bookings')
          .select('id')
          .where('event_type_id', '=', s.eventTypeId)
          .where('status', '=', 'confirmed')
          .execute()
        expect(rows, `persisted capacity in round ${round}`).toHaveLength(1)
      }
    },
  )

  it('counts the repeated October date after a midnight rollback at the month boundary', async () => {
    const timeZone = 'America/St_Johns'
    const now = instant('2009-10-01T00:00Z')
    const s = await setup({ maxBookingsPerMonth: 1 }, timeZone, now)
    // Nov 1 reaches 00:01 before rolling back into Oct 31. The first midnight of
    // Nov 1 is 02:30Z, but this later instant still belongs to the October period.
    const repeatedOctober = instant('2009-11-01T03:00Z')
    expect(repeatedOctober.toZonedDateTimeISO(timeZone).toPlainDate().toString()).toBe('2009-10-31')
    await s.seed(repeatedOctober)
    const target = local('2009-10-15T12:00', timeZone)
    const input = await buildAvailabilityInput(db, {
      eventTypeId: s.eventTypeId,
      hostUserId: s.userId,
      rangeStart: target,
      rangeEnd: target.add({ minutes: 30 }),
      now,
    })
    expect(input?.bookings?.some((booking) => booking.start.equals(repeatedOctober))).toBe(true)
    expect(await s.slots(target)).toEqual([])
    await expect(s.book(target)).rejects.toMatchObject({ code: 'slot_unavailable' })
    const november = local('2009-11-15T12:00', timeZone)
    expect(await s.slots(november)).toHaveLength(1)
    await expect(s.book(november)).resolves.toMatchObject({ replayed: false })
  })

  it.each([
    {
      name: 'New York DST transition week (167 hours)',
      timeZone: 'America/New_York',
      limits: { maxBookingsPerWeek: 1 },
      first: '2027-03-08T00:00',
      last: '2027-03-14T23:00',
      next: '2027-03-15T00:00',
    },
    {
      name: 'Kiritimati ISO week across December and January',
      timeZone: 'Pacific/Kiritimati',
      limits: { maxBookingsPerWeek: 1 },
      first: '2026-12-28T00:00',
      last: '2027-01-03T23:00',
      next: '2027-01-04T00:00',
    },
    {
      name: 'New York leap-day calendar month',
      timeZone: 'America/New_York',
      limits: { maxBookingsPerMonth: 1 },
      first: '2028-02-01T00:00',
      last: '2028-02-29T23:00',
      next: '2028-03-01T00:00',
    },
    {
      name: 'Kiritimati calendar month across December and January',
      timeZone: 'Pacific/Kiritimati',
      limits: { maxBookingsPerMonth: 1 },
      first: '2026-12-01T00:00',
      last: '2026-12-31T23:00',
      next: '2027-01-01T00:00',
    },
  ])(
    'uses schedule-local boundaries for $name',
    async ({ timeZone, limits, first, last, next }) => {
      const s = await setup(limits, timeZone)
      const periodStart = local(first, timeZone)
      const periodLast = local(last, timeZone)
      const nextStart = local(next, timeZone)
      await s.seed(periodStart)

      // The booking is farther away than the normal 72-hour busy-time query window.
      const input = await buildAvailabilityInput(db, {
        eventTypeId: s.eventTypeId,
        hostUserId: s.userId,
        rangeStart: periodLast,
        rangeEnd: periodLast.add({ minutes: 30 }),
        now: NOW,
      })
      expect(input?.bookings?.some((booking) => booking.start.equals(periodStart))).toBe(true)
      expect(await s.slots(periodLast)).toEqual([])
      await expect(s.book(periodLast)).rejects.toMatchObject({ code: 'slot_unavailable' })

      // Start-inclusive, end-exclusive periods reset exactly at local midnight.
      expect(await s.slots(nextStart)).toHaveLength(1)
      await expect(s.book(nextStart)).resolves.toMatchObject({ replayed: false })
      const previousLast = periodStart.subtract({ minutes: 60 })
      expect(await s.slots(previousLast)).toHaveLength(1)
      await expect(s.book(previousLast)).resolves.toMatchObject({ replayed: false })

      // A booking exactly at the next boundary must never consume the preceding period.
      const future = await setup(limits, timeZone)
      await future.seed(nextStart)
      expect(await future.slots(periodLast)).toHaveLength(1)
      await expect(future.book(periodLast)).resolves.toMatchObject({ replayed: false })

      // A later booking in this period also hides earlier dates in a narrow query.
      const later = await setup(limits, timeZone)
      await later.seed(periodLast)
      expect(await later.slots(periodStart)).toEqual([])
      await expect(later.book(periodStart)).rejects.toMatchObject({ code: 'slot_unavailable' })

      // As with the daily limit, only the start assigns a booking to a period.
      const crossing = await setup(limits, timeZone)
      await crossing.seed(periodStart.subtract({ minutes: 15 }))
      const afterMidnight = periodStart.add({ hours: 12 })
      expect(await crossing.slots(afterMidnight)).toHaveLength(1)
      await expect(crossing.book(afterMidnight)).resolves.toMatchObject({ replayed: false })
    },
  )

  it.each([
    [
      'weekly',
      { maxBookingsPerWeek: 1 },
      '2026-11-02T12:00Z',
      '2026-11-03T12:00Z',
      '2026-11-09T12:00Z',
    ],
    [
      'monthly',
      { maxBookingsPerMonth: 1 },
      '2026-11-02T12:00Z',
      '2026-11-16T12:00Z',
      '2026-12-02T12:00Z',
    ],
  ] as const)(
    'replays success and releases %s capacity on cancellation',
    async (_, limits, first, blocked, next) => {
      const s = await setup(limits)
      const key = randomUUID()
      const booked = await s.book(instant(first), key)
      await expect(s.book(instant(first), key)).resolves.toMatchObject({
        replayed: true,
        booking: { id: booked.booking.id },
      })
      await expect(s.book(instant(blocked))).rejects.toMatchObject({ code: 'slot_unavailable' })
      expect(await s.slots(instant(blocked))).toEqual([])
      await expect(s.book(instant(next))).resolves.toMatchObject({ replayed: false })
      await cancelManagedBooking(ctx, required(booked.manageToken))
      expect(await s.slots(instant(blocked))).toHaveLength(1)
      await expect(s.book(instant(blocked))).resolves.toMatchObject({ replayed: false })
    },
  )

  it.each([
    [
      'weekly',
      { maxBookingsPerWeek: 1 },
      '2026-11-02T12:00Z',
      '2026-11-03T12:00Z',
      '2026-11-09T12:00Z',
      '2026-11-10T12:00Z',
      '2026-11-16T12:00Z',
    ],
    [
      'monthly',
      { maxBookingsPerMonth: 1 },
      '2026-11-02T12:00Z',
      '2026-11-16T12:00Z',
      '2026-12-02T12:00Z',
      '2026-12-16T12:00Z',
      '2027-01-02T12:00Z',
    ],
  ] as const)(
    'checks the target %s period on reschedule and excludes itself',
    async (_, limits, first, within, occupied, target, free) => {
      const s = await setup(limits)
      const booked = await s.book(instant(first))
      const movedWithin = await rescheduleManagedBooking(ctx, required(booked.manageToken), {
        start: instant(within),
      })
      expect(movedWithin.booking.rescheduledFromId).toBe(booked.booking.id)
      const other = await s.book(instant(occupied))
      await expect(
        rescheduleManagedBooking(ctx, required(movedWithin.manageToken), {
          start: instant(target),
        }),
      ).rejects.toMatchObject({ code: 'slot_unavailable' })
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('status')
            .where('id', '=', movedWithin.booking.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('confirmed')
      const movedAcross = await rescheduleManagedBooking(ctx, required(movedWithin.manageToken), {
        start: instant(free),
      })
      expect(movedAcross.booking.rescheduledFromId).toBe(movedWithin.booking.id)
      expect(await s.slots(instant(first))).toHaveLength(1)
      await expect(s.book(instant(first))).resolves.toMatchObject({ replayed: false })
      await cancelManagedBooking(ctx, required(other.manageToken))
      await expect(
        rescheduleManagedBooking(ctx, required(movedAcross.manageToken), {
          start: instant(target),
        }),
      ).resolves.toMatchObject({ booking: { status: 'confirmed' } })
    },
  )

  it('reschedules Monday to Saturday within its full week while excluding itself', async () => {
    const s = await setup({ maxBookingsPerWeek: 1 })
    const monday = instant('2026-11-02T12:00Z')
    const saturday = instant('2026-11-07T12:00Z')
    // The predecessor is outside the target's short busy-time window, so only the
    // complete-week query can see it and must apply reschedule self-exclusion.
    expect(
      Temporal.Instant.compare(monday.add({ minutes: 30 }), saturday.subtract({ hours: 72 })),
    ).toBeLessThan(0)
    const booked = await s.book(monday)
    await expect(
      rescheduleManagedBooking(ctx, required(booked.manageToken), { start: saturday }),
    ).resolves.toMatchObject({
      booking: { status: 'confirmed', rescheduledFromId: booked.booking.id },
    })
  })

  it.each([
    ['weekly', { maxBookingsPerWeek: 1 }],
    ['monthly', { maxBookingsPerMonth: 1 }],
  ] as const)(
    'counts only active host bookings of this event type toward the %s limit',
    async (_, limits) => {
      const s = await setup(limits)
      const other = await f.host()
      await s.seed(instant('2026-11-02T12:00Z'), { status: 'cancelled' })
      await f.booking(s.organizationId, [s.userId], '2026-11-03T12:00Z', '2026-11-03T12:30Z')
      await f.booking(s.organizationId, [other.userId], '2026-11-04T12:00Z', '2026-11-04T12:30Z', {
        eventTypeId: s.eventTypeId,
      })
      const start = instant('2026-11-06T12:00Z')
      expect(await s.slots(start)).toHaveLength(1)
      await expect(s.book(start)).resolves.toMatchObject({ replayed: false })
      expect(await s.slots(instant('2026-11-07T12:00Z'))).toEqual([])
    },
  )

  it.each([
    {
      period: 'weekly',
      limits: { maxBookingsPerWeek: 1 },
      first: '2026-12-28T00:00',
      target: '2027-01-03T12:00',
    },
    {
      period: 'monthly',
      limits: { maxBookingsPerMonth: 1 },
      first: '2026-12-01T00:00',
      target: '2026-12-20T12:00',
    },
  ])(
    'uses the event-selected schedule zone for $period capacity',
    async ({ limits, first, target }) => {
      const s = await setup(limits)
      const timeZone = 'Pacific/Kiritimati'
      const scheduleId = await f.schedule(s.userId, {
        timeZone,
        weeklyHours: allDays,
        isDefault: false,
      })
      await db
        .updateTable('event_type_hosts')
        .set({ schedule_id: scheduleId })
        .where('event_type_id', '=', s.eventTypeId)
        .where('user_id', '=', s.userId)
        .execute()
      await s.seed(local(first, timeZone))
      const start = local(target, timeZone)
      const input = await buildAvailabilityInput(db, {
        eventTypeId: s.eventTypeId,
        hostUserId: s.userId,
        rangeStart: start,
        rangeEnd: start.add({ minutes: 30 }),
        now: NOW,
      })
      expect(input?.schedule.timeZone).toBe(timeZone)
      expect(await s.slots(start)).toEqual([])
      await expect(s.book(start)).rejects.toMatchObject({ code: 'slot_unavailable' })
    },
  )

  it('enforces the daily, weekly and monthly limits together', async () => {
    const s = await setup({ maxBookingsPerDay: 1, maxBookingsPerWeek: 2, maxBookingsPerMonth: 3 })
    await s.book(instant('2026-11-02T12:00Z'))
    await expect(s.book(instant('2026-11-02T14:00Z'))).rejects.toMatchObject({
      code: 'slot_unavailable',
    })
    await s.book(instant('2026-11-03T12:00Z'))
    await expect(s.book(instant('2026-11-04T12:00Z'))).rejects.toMatchObject({
      code: 'slot_unavailable',
    })
    await s.book(instant('2026-11-09T12:00Z'))
    await expect(s.book(instant('2026-11-16T12:00Z'))).rejects.toMatchObject({
      code: 'slot_unavailable',
    })
    await expect(s.book(instant('2026-12-01T12:00Z'))).resolves.toMatchObject({ replayed: false })
  })

  it('keeps existing bookings when a limit is lowered and refuses only new bookings', async () => {
    const s = await setup({ maxBookingsPerWeek: 3, maxBookingsPerMonth: 4 })
    const first = await s.book(instant('2026-11-02T12:00Z'))
    const second = await s.book(instant('2026-11-03T12:00Z'))
    await db
      .updateTable('event_types')
      .set({ max_bookings_per_week: 1, max_bookings_per_month: 1 })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('id', 'in', [first.booking.id, second.booking.id])
        .orderBy('id')
        .execute(),
    ).toEqual(
      [
        { id: first.booking.id, status: 'confirmed' },
        { id: second.booking.id, status: 'confirmed' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    await expect(s.book(instant('2026-11-04T12:00Z'))).rejects.toMatchObject({
      code: 'slot_unavailable',
    })
  })

  it.each(
    (['individual', 'collective', 'round_robin'] as const).flatMap((schedulingType) =>
      [
        {
          period: 'weekly',
          limits: { maxBookingsPerWeek: 1 },
          second: '2026-11-03T12:00Z',
          full: '2026-11-04T12:00Z',
          other: '2026-11-05T12:00Z',
          unlimited: '2026-11-06T12:00Z',
        },
        {
          period: 'monthly',
          limits: { maxBookingsPerMonth: 1 },
          second: '2026-11-16T12:00Z',
          full: '2026-11-23T12:00Z',
          other: '2026-11-24T12:00Z',
          unlimited: '2026-11-25T12:00Z',
        },
      ].map((period) => ({ schedulingType, ...period })),
    ),
  )(
    'keeps $schedulingType team $period capacity scoped to each actual host',
    async ({ schedulingType, limits, second: secondDate, full, other: otherDate, unlimited }) => {
      const users = await Promise.all([
        createTestUser(db, 'Team owner'),
        createTestUser(db, 'Team host'),
      ])
      const owner = required(users[0])
      const team = await createTestTeam(
        db,
        users.map((user, index) => ({ user, role: index ? 'member' : 'owner' })),
      )
      await Promise.all(
        users.map((user) => f.schedule(user.id, { timeZone: 'UTC', weeklyHours: allDays })),
      )
      const admin = testContext(db, team.as(owner), () => NOW)
      const event = await createEventType(admin, {
        slug: 'limited-team',
        title: 'Team call',
        durationMinutes: 30,
        schedulingType,
        hosts: (schedulingType === 'individual' ? users.slice(0, 1) : users).map((user) => ({
          userId: user.id,
        })),
        ...limits,
      })
      if (schedulingType === 'round_robin') await activateRoundRobin(admin, event.id)
      const page = { handle: admin.principal.organization.slug, slug: event.slug }
      const book = (start: string) =>
        createPublicTeamBooking(ctx, { ...page, start: instant(start), invitee })
      const first = await book('2026-11-02T12:00Z')
      const firstHosts = await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', first.booking.id)
        .execute()
      expect(firstHosts).toHaveLength(schedulingType === 'collective' ? 2 : 1)
      if (schedulingType === 'round_robin') {
        // A pool member's consumed capacity leaves the other member available.
        const second = await book(secondDate)
        const secondHost = await db
          .selectFrom('booking_hosts')
          .select('user_id')
          .where('booking_id', '=', second.booking.id)
          .executeTakeFirstOrThrow()
        expect(secondHost.user_id).not.toBe(required(firstHosts[0]).user_id)
      }
      expect(
        await listPublicTeamSlots(ctx, {
          ...page,
          start: instant(full),
          end: instant(full).add({ minutes: 30 }),
        }),
      ).toEqual([])
      await expect(book(full)).rejects.toMatchObject({ code: 'slot_unavailable' })
      await cancelManagedBooking(ctx, required(first.manageToken))
      await expect(book(full)).resolves.toMatchObject({ replayed: false })
      // Capacity belongs to this event type, rather than being a global host quota.
      const other = await createEventType(admin, {
        slug: 'another-team-event',
        title: 'Other',
        durationMinutes: 30,
        hosts: [{ userId: owner.id }],
        ...limits,
      })
      await expect(
        createPublicTeamBooking(ctx, {
          ...page,
          slug: other.slug,
          start: instant(otherDate),
          invitee,
        }),
      ).resolves.toMatchObject({ replayed: false })
      await updateEventType(admin, event.id, {
        maxBookingsPerWeek: null,
        maxBookingsPerMonth: null,
      })
      await expect(book(unlimited)).resolves.toMatchObject({ replayed: false })
    },
  )
})
