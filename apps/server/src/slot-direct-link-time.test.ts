import '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { activateRoundRobin, createEventType } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  type Fixtures,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { publicRoutes } from './routes/public.ts'

const bootstrap = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2027-06-14T12:00:00Z')
const START = '2027-06-15T09:00:00.000Z'
const END = '2027-06-15T09:30:00.000Z'
const plenty = { limit: 100_000, windowSeconds: 60 }

describe.skipIf(!bootstrap)('direct-slot exact reads use current engine time rules', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'slot_link_time' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  function application(now = NOW) {
    return createApp({
      publicUrl: 'https://booking.example.test',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        publicRoutes({
          db,
          now: () => now,
          rateLimits: { page: plenty, slots: plenty, book: plenty },
        }),
      ],
    })
  }

  async function exact(api: string, start = START, durationMinutes = 30, now = NOW) {
    return application(now).request(
      `${api}/slots?${new URLSearchParams({
        start,
        end: Temporal.Instant.from(start).add({ minutes: durationMinutes }).toString(),
        durationMinutes: String(durationMinutes),
      })}`,
    )
  }

  async function personal(options: EventTypeFixture = {}) {
    const host = await f.host({ timeZone: 'UTC' })
    const scheduleId = await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      ...options,
    })
    return { host, scheduleId, eventId, api: `/api/v1/public/${host.handle}/intro` }
  }

  const vectors = [
    {
      name: 'New York spring transition',
      zone: 'America/New_York',
      start: '2027-03-14T06:30:00.000Z',
      end: '2027-03-14T07:30:00.000Z',
    },
    {
      name: 'New York repeated hour',
      zone: 'America/New_York',
      start: '2027-11-07T05:30:00.000Z',
      end: '2027-11-07T06:30:00.000Z',
      repeatedStart: '2027-11-07T06:30:00.000Z',
    },
    {
      name: 'Berlin spring transition',
      zone: 'Europe/Berlin',
      start: '2027-03-28T00:30:00.000Z',
      end: '2027-03-28T01:30:00.000Z',
    },
    {
      name: 'Berlin repeated hour',
      zone: 'Europe/Berlin',
      start: '2027-10-31T00:30:00.000Z',
      end: '2027-10-31T01:30:00.000Z',
      repeatedStart: '2027-10-31T01:30:00.000Z',
    },
    {
      name: 'Tokyo midnight while Los Angeles host remains on the same day',
      zone: 'America/Los_Angeles',
      start: '2027-06-15T14:30:00.000Z',
      end: '2027-06-15T15:30:00.000Z',
    },
    {
      name: 'Tokyo invitee date differs from Los Angeles host date',
      zone: 'America/Los_Angeles',
      scheduleZone: 'UTC',
      start: '2027-06-15T06:30:00.000Z',
      end: '2027-06-15T07:30:00.000Z',
    },
  ]

  it.each(vectors)('offers the exact elapsed interval for $name', async (vector) => {
    const start = Temporal.Instant.from(vector.start)
    const now = start.subtract({ hours: 24 })
    const scheduleZone = vector.scheduleZone ?? vector.zone
    const date = start.toZonedDateTimeISO(scheduleZone).toPlainDate().toString()
    const host = await f.host({ timeZone: vector.zone })
    const scheduleId = await f.schedule(host.userId, {
      timeZone: scheduleZone,
      weeklyHours: {},
      overrides: [{ date, intervals: [{ start: '00:00', end: '24:00' }] }],
    })
    await f.eventType(host.organizationId, host.userId, {
      slug: 'transition',
      durationMinutes: 60,
      slotStepMinutes: 30,
    })
    const api = `/api/v1/public/${host.handle}/transition`
    const response = await exact(api, vector.start, 60, now)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ start: vector.start, end: vector.end }] })
    if (vector.repeatedStart) {
      // The ordinary wall-clock grid offers an ambiguous start only at its earlier occurrence.
      // A syntactically valid later instant must not be fabricated by direct-slot reads.
      const repeated = await exact(api, vector.repeatedStart, 60, now)
      expect(repeated.status).toBe(200)
      expect(await repeated.json()).toEqual({ data: [] })
    }
    if (vector.zone === 'America/Los_Angeles') {
      const inviteeStart = start.toZonedDateTimeISO('Asia/Tokyo')
      const inviteeEnd = Temporal.Instant.from(vector.end).toZonedDateTimeISO('Asia/Tokyo')
      if (vector.start === '2027-06-15T14:30:00.000Z') {
        expect(inviteeStart.toPlainDate().toString()).toBe('2027-06-15')
        expect(inviteeEnd.toPlainDate().toString()).toBe('2027-06-16')
      } else {
        const hostDate = start.toZonedDateTimeISO(vector.zone).toPlainDate().toString()
        expect(hostDate).toBe('2027-06-14')
        expect(inviteeStart.toPlainDate().toString()).toBe('2027-06-15')
        // Profile and schedule zones are independent. In the LA schedule this interval
        // crosses midnight; ordinary hours never join across two host-local dates.
        await db
          .updateTable('schedules')
          .set({ time_zone: vector.zone })
          .where('id', '=', scheduleId)
          .execute()
        await db
          .insertInto('schedule_overrides')
          .values({
            schedule_id: scheduleId,
            date: hostDate,
            intervals: JSON.stringify([{ start: '00:00', end: '24:00' }]),
          })
          .execute()
        expect(await (await exact(api, vector.start, 60, now)).json()).toEqual({ data: [] })
      }
    }
  })

  it('returns only the ordinary generic empty result for current rule rejections', async () => {
    const cases: {
      name: string
      options?: EventTypeFixture
      now?: Temporal.Instant
      start?: string
      busy?: [string, string]
      booking?: [string, string]
      override?: boolean
    }[] = [
      { name: 'past', now: Temporal.Instant.from(START).add({ minutes: 1 }) },
      {
        name: 'minimum notice',
        now: Temporal.Instant.from(START).subtract({ minutes: 30 }),
        options: { minimumNoticeMinutes: 60 },
      },
      {
        name: 'shortened booking window',
        options: { bookingWindowDays: 1 },
        now: NOW.subtract({ hours: 48 }),
      },
      { name: 'slot grid', start: '2027-06-15T09:15:00.000Z' },
      {
        name: 'buffer before',
        options: { bufferBeforeMinutes: 15 },
        busy: ['2027-06-15T08:50:00Z', '2027-06-15T09:00:00Z'],
      },
      {
        name: 'buffer after',
        options: { bufferAfterMinutes: 15 },
        busy: ['2027-06-15T09:30:00Z', '2027-06-15T09:40:00Z'],
      },
      {
        name: 'daily booking limit',
        options: { maxBookingsPerDay: 1 },
        booking: ['2027-06-15T15:00:00Z', '2027-06-15T15:30:00Z'],
      },
      { name: 'unavailable working override', override: true },
    ]
    for (const scenario of cases) {
      const s = await personal(scenario.options)
      if (scenario.busy) await f.calendarBusy(s.host.userId, [scenario.busy])
      if (scenario.booking)
        await f.booking(s.host.organizationId, [s.host.userId], ...scenario.booking, {
          eventTypeId: s.eventId,
        })
      if (scenario.override)
        await db
          .insertInto('schedule_overrides')
          .values({ schedule_id: s.scheduleId, date: '2027-06-15', intervals: '[]' })
          .execute()
      const response = await exact(s.api, scenario.start ?? START, 30, scenario.now ?? NOW)
      expect(response.status, scenario.name).toBe(200)
      expect(await response.json(), scenario.name).toEqual({ data: [] })
    }
  })

  it('retains the explicit duration after a default edit and rejects a removed length', async () => {
    const s = await personal()
    expect(await (await exact(s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [30, 60] })
      .where('id', '=', s.eventId)
      .execute()
    expect(await (await exact(s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
    expect(await (await exact(s.api, START, 60)).json()).toEqual({
      data: [{ start: START, end: '2027-06-15T10:00:00.000Z' }],
    })
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [60] })
      .where('id', '=', s.eventId)
      .execute()
    const removed = await exact(s.api)
    expect(removed.status).toBe(400)
    expect(await removed.json()).toMatchObject({ error: 'invalid_duration' })
    expect(await (await exact(s.api, START, 60)).json()).toEqual({
      data: [{ start: START, end: '2027-06-15T10:00:00.000Z' }],
    })
  })

  async function team(mode: 'collective' | 'round_robin') {
    const owner = await createTestUser(db, 'First required host')
    const alternate = await createTestUser(db, 'Second required host')
    const organization = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: alternate, role: 'member' },
    ])
    for (const host of [owner, alternate]) await f.schedule(host.id, { timeZone: 'UTC' })
    const context = testContext(db, organization.as(owner), () => NOW)
    const event = await createEventType(context, {
      slug: 'intro',
      title: 'Current team meeting',
      durationMinutes: 30,
      schedulingType: mode,
      hosts: [{ userId: owner.id }, { userId: alternate.id }],
    })
    if (mode === 'round_robin') await activateRoundRobin(context, event.id)
    return {
      owner,
      alternate,
      api: `/api/v1/public/teams/${context.principal.organization.slug}/intro`,
    }
  }

  async function staleCalendar(userId: string) {
    const calendar = await f.calendarBusy(userId, [])
    const connection = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', calendar.calendarId)
      .executeTakeFirstOrThrow()
    // Synthetic cached Google state with no successful cursor; no provider network request exists.
    await db
      .updateTable('calendar_connections')
      .set({ provider: 'google' })
      .where('id', '=', connection.connection_id)
      .execute()
  }

  it('keeps unknown collective calendar readiness as an error instead of unavailable time', async () => {
    const s = await team('collective')
    expect(await (await exact(s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
    await staleCalendar(s.alternate.id)
    const response = await exact(s.api)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'calendar_sync_unavailable' })
  })

  it('uses a fresh alternate round-robin host, while all stale calendars remain unknown', async () => {
    const s = await team('round_robin')
    await staleCalendar(s.owner.id)
    expect(await (await exact(s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
    await staleCalendar(s.alternate.id)
    const response = await exact(s.api)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'calendar_sync_unavailable' })
  })
})
