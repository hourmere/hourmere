import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  createPublicTeamBooking,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import { conferenceRoot } from './conferences.ts'
import { createEventType, updateEventType } from './event-types.ts'
import {
  type TeamAdminBookingRecord,
  TeamAdminBookingSchema,
  toTeamAdminBooking,
} from './team-admin-booking.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const instant = Temporal.Instant.from
const PRIVATE_ANSWER = 'Private medical history supplied to the host'
const PRIVATE_CALENDAR = 'Private therapy calendar'
const PRIVATE_EVENT = 'private-therapy-appointment'
const PRIVATE_TITLE = 'Private custom booking title'
const CANCEL_REASON = 'Private cancellation explanation'
type Provider = 'zoom' | 'google_meet'

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing test fixture')
  return value
}

describe.skipIf(!serverUrl)('team admin booking lifecycle whitelist', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(provider: Provider) {
    const hosts = await Promise.all(
      Array.from({ length: provider === 'zoom' ? 1 : 2 }, (_, index) =>
        createTestUser(db, `Original host ${index + 1}`),
      ),
    )
    const owner = required(hosts[0])
    const team = await createTestTeam(
      db,
      hosts.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
    )
    const ctx = testContext(db, team.as(owner), now)
    const f = createFixtures(db)
    for (const host of hosts) await f.schedule(host.id, { timeZone: 'UTC' })
    const event = await createEventType(ctx, {
      slug: 'coordination',
      title: 'Team coordination',
      durationMinutes: 30,
      schedulingType: provider === 'zoom' ? 'individual' : 'collective',
      hosts: hosts.map((host) => ({ userId: host.id })),
      allowGuests: true,
      questions: [{ id: 'medical', label: 'Private history', type: 'long_text' }],
    })
    const publicContext = { db, now }
    const created = await createPublicTeamBooking(publicContext, {
      handle: ctx.principal.organization.slug,
      slug: event.slug,
      start: instant('2026-11-02T09:00Z'),
      idempotencyKey: randomUUID(),
      invitee: { name: 'Booker', email: 'booker@example.com', timeZone: 'America/Los_Angeles' },
      guests: [{ name: 'Guest', email: 'guest@example.com' }],
      responses: { medical: PRIVATE_ANSWER },
    })
    const privateCalendar = await f.calendarBusy(owner.id, [
      ['2026-11-03T09:00Z', '2026-11-03T09:30Z'],
    ])
    await db
      .updateTable('calendars')
      .set({ name: PRIVATE_CALENDAR })
      .where('id', '=', privateCalendar.calendarId)
      .execute()
    await db
      .updateTable('calendar_busy')
      .set({ external_event_id: PRIVATE_EVENT })
      .where('calendar_id', '=', privateCalendar.calendarId)
      .execute()
    const calendar = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', privateCalendar.calendarId)
      .executeTakeFirstOrThrow()
    const url =
      provider === 'zoom'
        ? 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1'
        : 'https://meet.google.com/aaa-bbbb-ccc'
    // Seed a committed worker result, as booking-snapshot.test.ts does. No provider I/O.
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: created.booking.id,
        booking_id: created.booking.id,
        organization_id: team.id,
        organizer_user_id: owner.id,
        invitation_organizer_name: owner.name,
        invitation_organizer_email: owner.email,
        provider,
        state: 'ready',
        applied_revision: 0,
        ...(provider === 'zoom'
          ? { zoom_connection_id: randomUUID(), zoom_user_id: 'synthetic-zoom-identity' }
          : {}),
      })
      .execute()
    await db
      .insertInto('booking_conference_mirrors')
      .values({
        root_booking_id: created.booking.id,
        user_id: owner.id,
        calendar_id: privateCalendar.calendarId,
        connection_id: calendar.connection_id,
        external_event_id: 'private-personal-copy',
        state: 'ready',
        applied_revision: 0,
      })
      .execute()
    await db
      .updateTable('bookings')
      .set({
        location: JSON.stringify({ kind: provider, autoCreate: true, url }),
        title: PRIVATE_TITLE,
      })
      .where('id', '=', created.booking.id)
      .execute()
    return { hosts, owner, team, ctx, event, publicContext, created, url }
  }

  async function richRecord(id: string, manageToken: string) {
    const booking = await db
      .selectFrom('bookings as b')
      .leftJoin('event_types as e', 'e.id', 'b.event_type_id')
      .selectAll('b')
      .select('e.title as event_type_title')
      .where('b.id', '=', id)
      .executeTakeFirstOrThrow()
    const status = booking.status
    if (status !== 'confirmed' && status !== 'cancelled') throw new Error('Unexpected status')
    const hosts = await db
      .selectFrom('booking_hosts as h')
      .innerJoin('auth.user as u', 'u.id', 'h.user_id')
      .select(['h.user_id', 'u.name', 'u.email'])
      .where('h.booking_id', '=', id)
      .orderBy('h.user_id')
      .execute()
    const attendees = await db
      .selectFrom('booking_attendees')
      .selectAll()
      .where('booking_id', '=', id)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute()
    const root = required(await conferenceRoot(db, id))
    const conference = await db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', root)
      .executeTakeFirstOrThrow()
    const calendarCopies = await db
      .selectFrom('booking_conference_mirrors')
      .selectAll()
      .where('root_booking_id', '=', root)
      .execute()
    const privateCalendars = await db
      .selectFrom('calendars as c')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .leftJoin('calendar_busy as busy', 'busy.calendar_id', 'c.id')
      .select(['c.name', 'cc.credentials', 'busy.external_event_id', 'busy.period'])
      .where(
        'cc.user_id',
        'in',
        hosts.map((host) => host.user_id),
      )
      .execute()
    return {
      ...booking,
      status,
      hosts,
      attendees,
      manageToken,
      conference,
      calendarCopies,
      privateCalendars,
      conferenceCanRetry: true,
    } satisfies TeamAdminBookingRecord & Record<string, unknown>
  }

  async function assertProjection(
    id: string,
    token: string,
    expected: { status: 'confirmed' | 'cancelled'; start: string; cancelledAt: string | null },
  ) {
    const record = await richRecord(id, token)
    const dto = toTeamAdminBooking(record)
    // Check keys before values, so a broken whitelist cannot print capabilities in a diff.
    expect(Object.keys(dto).sort()).toEqual(
      ['id', 'status', 'start', 'end', 'cancelledAt', 'eventType', 'hosts', 'attendees'].sort(),
    )
    for (const host of dto.hosts) expect(Object.keys(host).sort()).toEqual(['name', 'userId'])
    for (const attendee of dto.attendees)
      expect(Object.keys(attendee).sort()).toEqual(['email', 'isBooker', 'name', 'timeZone'])
    expect(Object.keys(required(dto.eventType)).sort()).toEqual(['id', 'title'])
    const serialized = JSON.stringify(dto)
    for (const marker of [
      token,
      PRIVATE_ANSWER,
      PRIVATE_CALENDAR,
      PRIVATE_EVENT,
      PRIVATE_TITLE,
      CANCEL_REASON,
      'private-personal-copy',
      'https://',
      'credentials',
      'manage_token_hash',
      'conferenceCanRetry',
    ])
      expect(serialized.includes(marker)).toBe(false)
    if (record.manage_token_hash)
      expect(serialized.includes(record.manage_token_hash.toString('hex'))).toBe(false)
    expect(TeamAdminBookingSchema.safeParse(dto).success).toBe(true)
    expect(dto).toEqual({
      id,
      ...expected,
      end: instant(expected.start).add({ minutes: 30 }).toString({ fractionalSecondDigits: 3 }),
      eventType: { id: record.event_type_id, title: 'Team coordination' },
      hosts: record.hosts.map((host) => ({ userId: host.user_id, name: host.name })),
      attendees: [
        {
          name: 'Booker',
          email: 'booker@example.com',
          timeZone: 'America/Los_Angeles',
          isBooker: true,
        },
        {
          name: 'Guest',
          email: 'guest@example.com',
          timeZone: 'America/Los_Angeles',
          isBooker: false,
        },
      ],
    })
    expect(record.responses).toEqual({ medical: PRIVATE_ANSWER })
    expect(record.calendarCopies).toHaveLength(1)
    expect(record.privateCalendars.some((calendar) => calendar.name === PRIVATE_CALENDAR)).toBe(
      true,
    )
    return record
  }

  for (const provider of ['zoom', 'google_meet'] as const) {
    for (const canceller of ['host', 'invitee'] as const) {
      it(`keeps ${provider} fields minimal through host/invitee reschedules and ${canceller} cancellation`, async () => {
        const s = await setup(provider)
        const token = required(s.created.manageToken)
        const initial = await assertProjection(s.created.booking.id, token, {
          status: 'confirmed',
          start: '2026-11-02T09:00:00.000Z',
          cancelledAt: null,
        })
        expect(initial.manage_token_hash !== null).toBe(true)
        expect(initial.conference.state).toBe('ready')
        expect(JSON.stringify(initial.location).includes(s.url)).toBe(true)
        // Current configuration changes must not replace the original collective hosts.
        if (provider === 'google_meet')
          await updateEventType(s.ctx, s.event.id, {
            schedulingType: 'individual',
            hosts: [{ userId: s.owner.id }],
          })
        const movedByHost = await rescheduleHostBooking(s.ctx, s.created.booking.id, {
          start: instant('2026-11-02T10:00Z'),
        })
        expect(movedByHost.manageToken === null).toBe(true)
        const predecessor = await assertProjection(s.created.booking.id, token, {
          status: 'cancelled',
          start: '2026-11-02T09:00:00.000Z',
          cancelledAt: now().toString({ fractionalSecondDigits: 3 }),
        })
        expect(predecessor.manage_token_hash === null).toBe(true)
        expect(predecessor.conference.booking_id).toBe(movedByHost.booking.id)
        expect(JSON.stringify(predecessor.location).includes(s.url)).toBe(true)
        const pending = await assertProjection(movedByHost.booking.id, token, {
          status: 'confirmed',
          start: '2026-11-02T10:00:00.000Z',
          cancelledAt: null,
        })
        expect(pending.conference.state).toBe('pending')
        expect(pending.conference.revision).toBe(1)
        expect(pending.conference.applied_revision).toBe(0)
        expect(pending.hosts.map((host) => host.user_id)).toEqual(
          s.hosts.map((host) => host.id).sort(),
        )
        const movedByInvitee = await rescheduleManagedBooking(s.publicContext, token, {
          start: instant('2026-11-02T11:00Z'),
        })
        const newToken = required(movedByInvitee.manageToken)
        await db
          .updateTable('booking_conferences')
          .set({ state: 'ready', applied_revision: sql`revision` })
          .where('root_booking_id', '=', s.created.booking.id)
          .execute()
        await db
          .updateTable('bookings')
          .set({ location: JSON.stringify({ kind: provider, autoCreate: true, url: s.url }) })
          .where('id', '=', movedByInvitee.booking.id)
          .execute()
        // The pinned organizer no longer matches their current identity; a ready URL is
        // still private, regardless of whether a host view would permit it.
        await db
          .updateTable('auth.user')
          .set({ email: `changed-${randomUUID()}@example.com` })
          .where('id', '=', s.owner.id)
          .execute()
        const current = await assertProjection(movedByInvitee.booking.id, newToken, {
          status: 'confirmed',
          start: '2026-11-02T11:00:00.000Z',
          cancelledAt: null,
        })
        expect(current.conference.invitation_organizer_email === s.owner.email).toBe(true)
        expect(current.hosts.map((host) => host.user_id)).toEqual(
          s.hosts.map((host) => host.id).sort(),
        )
        if (canceller === 'host')
          await cancelHostBooking(s.ctx, movedByInvitee.booking.id, { reason: CANCEL_REASON })
        else await cancelManagedBooking(s.publicContext, newToken, { reason: CANCEL_REASON })
        const cancelled = await assertProjection(movedByInvitee.booking.id, newToken, {
          status: 'cancelled',
          start: '2026-11-02T11:00:00.000Z',
          cancelledAt: now().toString({ fractionalSecondDigits: 3 }),
        })
        expect(cancelled.conference.state).toBe('pending')
        expect(cancelled.cancel_reason === CANCEL_REASON).toBe(true)
        expect(JSON.stringify(cancelled.location).includes(s.url)).toBe(true)
        // Even a delayed ready row with a cancelled booking and retained URL is omitted.
        await db
          .updateTable('booking_conferences')
          .set({ state: 'ready', applied_revision: sql`revision` })
          .where('root_booking_id', '=', s.created.booking.id)
          .execute()
        await assertProjection(movedByInvitee.booking.id, newToken, {
          status: 'cancelled',
          start: '2026-11-02T11:00:00.000Z',
          cancelledAt: now().toString({ fractionalSecondDigits: 3 }),
        })
      })
    }
  }
})
