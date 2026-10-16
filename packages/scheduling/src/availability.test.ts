// The database → engine mapping and the public page, against a throwaway database: slots
// must be exactly what the engine computes from the same rules written out by hand.
import { type AvailabilityInput, getAvailableSlots } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildAvailabilityInput,
  findSlots,
  getPublicEventType,
  listPublicSlots,
  MAX_SLOT_RANGE_DAYS,
} from './availability.ts'
import type { PublicContext } from './context.ts'
import { createFixtures, type Fixtures, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = (iso: string) => Temporal.Instant.from(iso)
// Calendar: Mon 2026-11-02 … Fri 2026-11-06. Berlin is on CET (+01:00) since 2026-10-25.
const NOW = instant('2026-11-01T12:00:00Z')
const RANGE = { start: instant('2026-11-02T00:00:00Z'), end: instant('2026-11-07T00:00:00Z') }
const iso = (s: { start: Temporal.Instant; end: Temporal.Instant }) => ({
  start: s.start.toString({ fractionalSecondDigits: 3 }),
  end: s.end.toString({ fractionalSecondDigits: 3 }),
})

describe.skipIf(!serverUrl)('availability', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  describe('slots from the database match the engine', () => {
    let host: Awaited<ReturnType<Fixtures['host']>>
    let eventTypeId: string
    let expected: AvailabilityInput

    beforeAll(async () => {
      host = await f.host({ handle: 'ada' })
      await f.schedule(host.userId, {
        overrides: [
          { date: '2026-11-03', intervals: [] },
          { date: '2026-11-04', intervals: [{ start: '13:00', end: '15:00' }] },
          { date: '2026-12-01', intervals: [] },
        ],
      })
      eventTypeId = await f.eventType(host.organizationId, host.userId, {
        slug: 'intro',
        durationMinutes: 30,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 5,
        maxBookingsPerDay: 1,
      })
      const other = await f.eventType(host.organizationId, host.userId, {
        slug: 'workshop',
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 20,
      })
      const team = await f.organization()
      await f.member(host.userId, team)
      const teamType = await f.eventType(team, null, {
        bufferAfterMinutes: 30,
        hosts: [{ userId: host.userId }],
      })
      const someoneElse = await f.host()

      // Monday: one booking of this event type uses up the daily limit of 1.
      await f.booking(
        host.organizationId,
        [host.userId],
        '2026-11-02T09:00Z',
        '2026-11-02T09:30Z',
        {
          eventTypeId,
        },
      )
      // Wednesday: a cancelled booking does not block.
      await f.booking(
        host.organizationId,
        [host.userId],
        '2026-11-04T12:00Z',
        '2026-11-04T13:00Z',
        {
          eventTypeId,
          status: 'cancelled',
        },
      )
      // Thursday: another event type's booking blocks with its own buffers (15/20) but does
      // not count toward this event type's daily limit; calendar busy time blocks only from
      // calendars that check conflicts, and only the host's own.
      await f.booking(
        host.organizationId,
        [host.userId],
        '2026-11-05T11:00Z',
        '2026-11-05T12:00Z',
        {
          eventTypeId: other,
        },
      )
      await f.calendarBusy(host.userId, [['2026-11-05T14:00Z', '2026-11-05T15:00Z']])
      await f.calendarBusy(host.userId, [['2026-11-05T08:00Z', '2026-11-05T09:00Z']], {
        checkConflicts: false,
      })
      await f.calendarBusy(someoneElse.userId, [['2026-11-05T09:00Z', '2026-11-05T10:00Z']])
      // Friday: a booking without an event type (no buffers), one in another organization of
      // the host (with its event type's 30-minute buffer after), and another host's booking.
      await f.booking(host.organizationId, [host.userId], '2026-11-06T08:00Z', '2026-11-06T09:00Z')
      await f.booking(team, [host.userId], '2026-11-06T10:00Z', '2026-11-06T11:00Z', {
        eventTypeId: teamType,
      })
      await f.booking(
        someoneElse.organizationId,
        [someoneElse.userId],
        '2026-11-06T13:00Z',
        '2026-11-06T14:00Z',
      )

      expected = {
        schedule: {
          timeZone: 'Europe/Berlin',
          weeklyHours: weekdays({ start: '09:00', end: '17:00' }),
          dateOverrides: [
            { date: '2026-11-03', intervals: [] },
            { date: '2026-11-04', intervals: [{ start: '13:00', end: '15:00' }] },
          ],
        },
        eventType: {
          durationMinutes: 30,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 5,
          minimumNoticeMinutes: 0,
          maxBookingsPerDay: 1,
        },
        busy: [
          { start: instant('2026-11-05T10:45Z'), end: instant('2026-11-05T12:20Z') },
          { start: instant('2026-11-05T14:00Z'), end: instant('2026-11-05T15:00Z') },
          { start: instant('2026-11-06T08:00Z'), end: instant('2026-11-06T09:00Z') },
          { start: instant('2026-11-06T10:00Z'), end: instant('2026-11-06T11:30Z') },
        ],
        bookings: [
          {
            start: instant('2026-11-02T09:00Z'),
            end: instant('2026-11-02T09:30Z'),
            bufferBeforeMinutes: 10,
            bufferAfterMinutes: 5,
          },
        ],
        rangeStart: RANGE.start,
        rangeEnd: RANGE.end,
        now: NOW,
      }
    })

    it('builds the engine input from schedule, overrides, busy time and bookings', async () => {
      const input = await buildAvailabilityInput(db, {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: RANGE.start,
        rangeEnd: RANGE.end,
        now: NOW,
      })
      const byStart = (a: { start: Temporal.Instant }, b: { start: Temporal.Instant }) =>
        Temporal.Instant.compare(a.start, b.start)
      expect({ ...input, busy: [...(input?.busy ?? [])].sort(byStart) }).toEqual(expected)
    })

    it('offers exactly the slots the engine computes', async () => {
      const slots = await listPublicSlots(ctx, {
        handle: 'ada',
        slug: 'intro',
        start: RANGE.start,
        end: RANGE.end,
      })
      expect(slots).toEqual(getAvailableSlots(expected).map(iso))

      const on = (date: string) => slots.filter((s) => s.start.startsWith(date))
      expect(on('2026-11-02')).toEqual([]) // daily limit
      expect(on('2026-11-03')).toEqual([]) // override: unavailable
      expect(on('2026-11-04').map((s) => s.start)).toEqual([
        '2026-11-04T12:00:00.000Z',
        '2026-11-04T12:30:00.000Z',
        '2026-11-04T13:00:00.000Z',
        '2026-11-04T13:30:00.000Z',
      ])
      // 11:00Z would end 11:35 with buffer, inside the workshop's 10:45–12:20 window.
      expect(on('2026-11-05').map((s) => s.start)).not.toContain('2026-11-05T10:30:00.000Z')
      expect(on('2026-11-05').map((s) => s.start)).toContain('2026-11-05T08:00:00.000Z')
      expect(on('2026-11-06').map((s) => s.start)).toContain('2026-11-06T13:00:00.000Z')
    })

    it('can leave out one booking, as rescheduling does', async () => {
      const monday = {
        rangeStart: instant('2026-11-02T00:00Z'),
        rangeEnd: instant('2026-11-03T00:00Z'),
      }
      const query = { eventTypeId, hostUserId: host.userId, now: NOW, ...monday }
      expect(await findSlots(db, query)).toEqual([])
      const booking = await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', eventTypeId)
        .where('status', '=', 'confirmed')
        .executeTakeFirstOrThrow()
      const freed = await findSlots(db, { ...query, excludeBookingId: booking.id })
      expect(freed.map(iso)).toEqual(
        getAvailableSlots({ ...expected, ...monday, bookings: [] }).map(iso),
      )
      expect(freed).toHaveLength(16)
    })

    it('never offers anything before now', async () => {
      const later = instant('2026-11-04T12:40:00Z')
      const slots = await findSlots(db, {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: RANGE.start,
        rangeEnd: RANGE.end,
        now: later,
      })
      expect(slots.map(iso)).toEqual(getAvailableSlots({ ...expected, now: later }).map(iso))
      expect(iso(slots[0] as never).start).toBe('2026-11-04T13:00:00.000Z')
      expect(
        await findSlots(db, {
          eventTypeId,
          hostUserId: host.userId,
          rangeStart: instant('0000-01-01T00:00:00Z'),
          rangeEnd: instant('0000-02-01T00:00:00Z'),
          now: NOW,
        }),
      ).toEqual([])
    })
  })

  it('maps every event type rule', async () => {
    const host = await f.host()
    await f.schedule(host.userId)
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      durationMinutes: 45,
      slotStepMinutes: 15,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      minimumNoticeMinutes: 120,
      bookingWindowDays: 14,
      maxBookingsPerDay: 4,
    })
    const input = await buildAvailabilityInput(db, {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: RANGE.start,
      rangeEnd: RANGE.end,
      now: NOW,
    })
    expect(input?.eventType).toEqual({
      durationMinutes: 45,
      slotStepMinutes: 15,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      minimumNoticeMinutes: 120,
      bookingWindowDays: 14,
      maxBookingsPerDay: 4,
    })
  })

  it("uses the event type's own schedule for the host over the default one", async () => {
    const host = await f.host({ handle: 'grace' })
    await f.schedule(host.userId)
    const evenings = await f.schedule(host.userId, {
      timeZone: 'America/New_York',
      weeklyHours: weekdays({ start: '18:00', end: '19:00' }),
      isDefault: false,
    })
    await f.eventType(host.organizationId, host.userId, {
      slug: 'evening',
      hosts: [{ userId: host.userId, scheduleId: evenings }],
    })
    const slots = await listPublicSlots(ctx, {
      handle: 'grace',
      slug: 'evening',
      start: instant('2026-11-02T00:00Z'),
      end: instant('2026-11-03T12:00Z'),
    })
    // 18:00 EST is 23:00Z.
    expect(slots).toEqual([
      { start: '2026-11-02T23:00:00.000Z', end: '2026-11-02T23:30:00.000Z' },
      { start: '2026-11-02T23:30:00.000Z', end: '2026-11-03T00:00:00.000Z' },
    ])
  })

  it('offers nothing when the host has no schedule', async () => {
    const host = await f.host({ handle: 'no-schedule' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, { slug: 'call' })
    // A schedule that is not the default does not count.
    await f.schedule(host.userId, { isDefault: false })
    const query = {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart: RANGE.start,
      rangeEnd: RANGE.end,
      now: NOW,
    }
    expect(await buildAvailabilityInput(db, query)).toBeUndefined()
    expect(await findSlots(db, query)).toEqual([])
    expect(await listPublicSlots(ctx, { handle: 'no-schedule', slug: 'call', ...RANGE })).toEqual(
      [],
    )
  })

  describe('public event pages', () => {
    let host: Awaited<ReturnType<Fixtures['host']>>

    beforeAll(async () => {
      host = await f.host({ name: '  ', handle: 'linus', timeZone: 'America/Los_Angeles' })
      await f.schedule(host.userId)
      await f.eventType(host.organizationId, host.userId, {
        slug: 'chat',
        title: 'Chat',
        description: 'A quick chat',
        durationMinutes: 20,
        location: { kind: 'phone', number: '+1 555 0100' },
        questions: [
          { id: 'topic', label: 'Topic', type: 'short_text', required: true },
          { id: 'size', label: 'Team size', type: 'select', options: ['1', '2-10'] },
        ],
      })
      await f.eventType(host.organizationId, host.userId, { slug: 'paused', isActive: false })
      await f.eventType(host.organizationId, host.userId, {
        slug: 'gone',
        deletedAt: '2026-10-01T00:00:00Z',
      })
      // An event type in an organization the owner is not (or no longer) a member of.
      await f.eventType(await f.organization(), host.userId, { slug: 'elsewhere' })
    })

    it('shows the event type without location details', async () => {
      expect(await getPublicEventType(ctx, { handle: 'Linus', slug: 'CHAT' })).toEqual({
        handle: 'linus',
        slug: 'chat',
        title: 'Chat',
        description: 'A quick chat',
        durationMinutes: 20,
        location: { kind: 'phone' },
        questions: [
          { id: 'topic', label: 'Topic', type: 'short_text', required: true },
          {
            id: 'size',
            label: 'Team size',
            type: 'select',
            required: false,
            options: ['1', '2-10'],
          },
        ],
        // The user has no name, so the handle stands in.
        host: { name: 'linus', timeZone: 'America/Los_Angeles' },
      })
    })

    it.each([
      ['linus', 'paused'],
      ['linus', 'gone'],
      ['linus', 'elsewhere'],
      ['linus', 'nope'],
      ['nobody', 'chat'],
      ['bad handle!', 'chat'],
      ['linus', '../chat'],
    ])('answers event_type_not_found for /%s/%s', async (handle, slug) => {
      await expect(getPublicEventType(ctx, { handle, slug })).rejects.toMatchObject({
        kind: 'not_found',
        code: 'event_type_not_found',
      })
      await expect(listPublicSlots(ctx, { handle, slug, ...RANGE })).rejects.toMatchObject({
        code: 'event_type_not_found',
      })
    })

    it('needs a profile', async () => {
      const noProfile = await f.host({ handle: null })
      await f.schedule(noProfile.userId)
      await f.eventType(noProfile.organizationId, noProfile.userId, { slug: 'chat' })
      // The only way to reach it would be a handle, and it has none; the other host's page
      // with the same slug is unaffected.
      expect((await getPublicEventType(ctx, { handle: 'linus', slug: 'chat' })).title).toBe('Chat')
    })

    it('limits the range', async () => {
      const start = instant('2026-11-02T00:00Z')
      const longest = start.add({ hours: MAX_SLOT_RANGE_DAYS * 24 })
      await expect(
        listPublicSlots(ctx, { handle: 'linus', slug: 'chat', start, end: longest }),
      ).resolves.toBeInstanceOf(Array)
      await expect(
        listPublicSlots(ctx, {
          handle: 'linus',
          slug: 'chat',
          start,
          end: longest.add({ minutes: 1 }),
        }),
      ).rejects.toMatchObject({ kind: 'invalid', code: 'range_too_long' })
      for (const end of [start, start.subtract({ minutes: 1 })]) {
        await expect(
          listPublicSlots(ctx, { handle: 'linus', slug: 'chat', start, end }),
        ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_range' })
      }
    })
  })
})
