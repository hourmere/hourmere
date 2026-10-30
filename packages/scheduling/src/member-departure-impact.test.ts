import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bookingPageQuery, encodeBookingCursor } from './booking-page.ts'
import { checkedCatalogPage } from './catalog-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { getTeamMemberDepartureImpact } from './member-departure-impact.ts'
import { TeamAdminBookingSchema, toTeamAdminBooking } from './team-admin-booking.ts'
import type { readTeamBookingPage } from './team-bookings.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T12:00:00Z')
const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
type Read = typeof getTeamMemberDepartureImpact
type Input = Parameters<Read>[1]
type Replacement = readonly [string, string]

const ResultSchema = z.strictObject({
  evaluatedAt: z.iso.datetime(),
  eventTypes: z.strictObject({
    data: z.array(
      z.strictObject({
        id: z.uuid(),
        title: z.string(),
        slug: z.string(),
        schedulingType: z.enum(['individual', 'round_robin', 'collective']),
        isActive: z.boolean(),
        reason: z.enum(['sole_host', 'round_robin_pool_member', 'collective_required_host']),
        remainingHostCount: z.number().int().nonnegative(),
      }),
    ),
    nextCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative(),
  }),
  bookings: z.strictObject({
    data: z.array(
      TeamAdminBookingSchema.extend({
        inProgress: z.boolean(),
        handling: z.enum(['coordinate_cancellation', 'wait_until_end_or_coordinate_offline']),
      }),
    ),
    nextCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative(),
  }),
})

/** Mutate an isolated in-memory source copy; the checked-in service is never edited. */
function sourceCopy(
  replacement?: Replacement,
  pageReplacement?: Replacement,
  teamReplacement?: Replacement,
): Read {
  function compile(path: string, change?: Replacement) {
    let source = readFileSync(path, 'utf8')
    if (change) {
      expect(source.includes(change[0]), 'mutation must match source').toBe(true)
      source = source.replace(...change)
    }
    return stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
  }
  let page = { bookingPageQuery, encodeBookingCursor }
  if (pageReplacement) {
    page = new Function(
      'DomainError',
      'isUuid',
      `${compile('packages/scheduling/src/booking-page.ts', pageReplacement)}; return { bookingPageQuery, encodeBookingCursor }`,
    )(DomainError, isUuid) as typeof page
  }
  const teamRead = new Function(
    'sql',
    'bookingPageQuery',
    'encodeBookingCursor',
    'DomainError',
    'isUuid',
    'toTeamAdminBooking',
    `${compile('packages/scheduling/src/team-bookings.ts', teamReplacement)}; return readTeamBookingPage`,
  )(
    sql,
    page.bookingPageQuery,
    page.encodeBookingCursor,
    DomainError,
    isUuid,
    toTeamAdminBooking,
  ) as typeof readTeamBookingPage
  return new Function(
    'sql',
    'z',
    'bookingPageQuery',
    'encodeBookingCursor',
    'DomainError',
    'isUuid',
    'TeamAdminBookingSchema',
    'toTeamAdminBooking',
    'checkedCatalogPage',
    'readTeamBookingPage',
    `${compile('packages/scheduling/src/member-departure-impact.ts', replacement)}; return getTeamMemberDepartureImpact`,
  )(
    sql,
    z,
    page.bookingPageQuery,
    page.encodeBookingCursor,
    DomainError,
    isUuid,
    TeamAdminBookingSchema,
    toTeamAdminBooking,
    checkedCatalogPage,
    teamRead,
  ) as Read
}

describe.skipIf(!serverUrl)('member departure impact', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function session(user: TestUser, organization = user.principal.organization) {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return testContext(db, { kind: 'session', sessionId: id, user, organization }, now)
  }

  async function setup() {
    const [owner, admin, member, host] = await Promise.all(
      ['Owner', 'Admin', 'Member', 'Second host'].map((name) => createTestUser(db, name)),
    )
    if (!owner || !admin || !member || !host) throw new Error('Missing test users')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
      { user: host, role: 'member' },
    ])
    const [ownerCtx, adminCtx, memberCtx, hostCtx] = await Promise.all(
      [owner, admin, member, host].map((user) => session(user, team.as(user).organization)),
    )
    if (!ownerCtx || !adminCtx || !memberCtx || !hostCtx) throw new Error('Missing contexts')
    const eventId = await createFixtures(db).eventType(team.id, null, {
      title: 'Team consultation',
      description: 'private-only-event-description',
      questions: [{ id: 'private-only-question' }],
      hosts: [{ userId: member.id }],
    })
    return { owner, admin, member, host, team, ownerCtx, adminCtx, memberCtx, hostCtx, eventId }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  const input = (f: Fixture, extra: Partial<Input> = {}): Input => ({
    teamId: f.team.id,
    memberUserId: f.member.id,
    ...extra,
  })

  async function event(
    f: Fixture,
    kind: 'individual' | 'round_robin' | 'collective',
    options: { isActive?: boolean; deletedAt?: string; hosts?: string[]; teamId?: string } = {},
  ) {
    const id = await createFixtures(db).eventType(options.teamId ?? f.team.id, null, {
      title: `${kind} consultation`,
      isActive: options.isActive ?? true,
      deletedAt: options.deletedAt ?? null,
      hosts: (options.hosts ?? [f.member.id, f.host.id]).map((userId) => ({ userId })),
    })
    await db
      .updateTable('event_types')
      .set({ scheduling_type: kind })
      .where('id', '=', id)
      .execute()
    return id
  }

  async function booking(
    f: Fixture,
    start = '2026-11-02T09:00:00Z',
    options: {
      end?: string
      organizationId?: string
      eventId?: string | null
      hosts?: string[]
      id?: string
      status?: 'confirmed' | 'cancelled'
    } = {},
  ) {
    const id = options.id ?? randomUUID()
    const status = options.status ?? 'confirmed'
    await db
      .insertInto('bookings')
      .values({
        id,
        organization_id: options.organizationId ?? f.team.id,
        event_type_id: options.eventId === undefined ? f.eventId : options.eventId,
        start_at: start,
        end_at: options.end ?? instant(start).add({ minutes: 30 }).toString(),
        title: 'private-only-booking-title',
        responses: JSON.stringify({ private: 'private-only-answer' }),
        location: JSON.stringify({ kind: 'custom', text: 'private-only-conference-link' }),
        manage_token_hash: randomBytes(32),
        source: 'web',
        status,
        cancelled_at: status === 'cancelled' ? new Date('2026-11-01T01:00:00Z') : null,
        cancel_reason: status === 'cancelled' ? 'private-only-cancellation-reason' : null,
      })
      .execute()
    for (const userId of options.hosts ?? [f.member.id])
      await db.insertInto('booking_hosts').values({ booking_id: id, user_id: userId }).execute()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Booker',
        email: 'booker@example.com',
        time_zone: 'UTC',
        locale: 'en-US',
        is_booker: true,
      })
      .execute()
    return id
  }

  async function expectDenied(read: Read, ctx: ServiceContext, query: Input) {
    const result = await read(ctx, query).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toMatchObject(denied)
  }

  async function verifyIsolation(read: Read) {
    const f = await setup()
    const expected = await booking(f)
    const other = await createTestTeam(db, [{ user: f.member, role: 'owner' }])
    const otherEvent = await event(f, 'individual', { teamId: other.id, hosts: [f.member.id] })
    await booking(f, '2026-11-02T10:00:00Z', {
      organizationId: other.id,
      eventId: otherEvent,
    })
    const personal = await event(f, 'individual', {
      teamId: f.member.principal.organization.id,
      hosts: [f.member.id],
    })
    await booking(f, '2026-11-02T11:00:00Z', {
      organizationId: f.member.principal.organization.id,
      eventId: personal,
    })
    const sameTeamPersonal = await createFixtures(db).eventType(f.team.id, f.member.id, {
      title: 'private-only-personal-event-in-team',
    })
    await booking(f, '2026-11-02T13:00:00Z', { eventId: sameTeamPersonal })
    await event(f, 'round_robin', { hosts: [f.host.id] })
    await booking(f, '2026-11-02T12:00:00Z', { hosts: [f.host.id] })
    const result = await read(f.ownerCtx, input(f))
    expect(result.eventTypes.data.map((row) => row.id)).toEqual([f.eventId])
    expect(result.eventTypes.totalCount).toBe(1)
    expect(result.bookings.data.map((row) => row.id)).toEqual([expected])
    expect(result.bookings.totalCount).toBe(1)
  }

  async function verifyReasons(read: Read) {
    const f = await setup()
    const rr = await event(f, 'round_robin')
    const collective = await event(f, 'collective')
    const disabled = await event(f, 'round_robin', { isActive: false })
    await event(f, 'collective', { deletedAt: '2026-10-31T00:00:00Z' })
    const result = await read(f.adminCtx, input(f))
    expect(
      result.eventTypes.data.map(({ id, reason, isActive }) => ({ id, reason, isActive })),
    ).toEqual(
      [
        { id: f.eventId, reason: 'sole_host', isActive: true },
        { id: rr, reason: 'round_robin_pool_member', isActive: true },
        { id: collective, reason: 'collective_required_host', isActive: true },
        { id: disabled, reason: 'round_robin_pool_member', isActive: false },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    expect(result.eventTypes.totalCount).toBe(4)
  }

  async function verifySavedHosts(read: Read) {
    const f = await setup()
    const original = await booking(f)
    await booking(f, '2026-11-02T10:00:00Z', { hosts: [f.host.id] })
    await db.deleteFrom('event_type_hosts').where('event_type_id', '=', f.eventId).execute()
    await db
      .insertInto('event_type_hosts')
      .values({ event_type_id: f.eventId, user_id: f.host.id })
      .execute()
    const result = await read(f.adminCtx, input(f))
    expect(result.eventTypes.data).toEqual([])
    expect(result.eventTypes.totalCount).toBe(0)
    expect(result.bookings.data.map((row) => row.id)).toEqual([original])
    expect(result.bookings.totalCount).toBe(1)
    expect(result.bookings.data[0]?.hosts).toEqual([{ userId: f.member.id, name: f.member.name }])
    await db
      .insertInto('event_type_hosts')
      .values({ event_type_id: f.eventId, user_id: f.member.id })
      .execute()
    const restored = await read(f.memberCtx, input(f))
    expect(restored.eventTypes.totalCount).toBe(1)
    expect(restored.bookings.data.map((row) => row.id)).toEqual([original])
  }

  async function verifyRemainingHosts(read: Read) {
    const f = await setup()
    const former = await createTestUser(db, 'Former team host')
    const unverified = await createTestUser(db, 'Unverified team host')
    await db
      .insertInto('auth.member')
      .values({
        id: randomUUID(),
        userId: unverified.id,
        organizationId: f.team.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', unverified.id)
      .execute()
    const sole = await event(f, 'round_robin', { hosts: [f.member.id] })
    const pool = await event(f, 'round_robin')
    const formerPool = await event(f, 'round_robin', { hosts: [f.member.id, former.id] })
    const unverifiedPool = await event(f, 'round_robin', {
      hosts: [f.member.id, unverified.id],
    })
    const unrelated = await event(f, 'round_robin', { hosts: [f.host.id] })
    const result = await read(f.adminCtx, input(f))
    const byId = new Map(result.eventTypes.data.map((row) => [row.id, row]))
    expect(byId.get(f.eventId)?.remainingHostCount).toBe(0)
    expect(byId.get(sole)).toMatchObject({
      reason: 'round_robin_pool_member',
      remainingHostCount: 0,
    })
    expect(byId.get(pool)?.remainingHostCount).toBe(1)
    expect(byId.get(formerPool)?.remainingHostCount).toBe(0)
    expect(byId.get(unverifiedPool)?.remainingHostCount).toBe(0)
    expect(byId.has(unrelated)).toBe(false)
  }

  async function verifyWhitelist(read: Read) {
    const f = await setup()
    const id = await booking(f)
    await createFixtures(db).calendarBusy(f.member.id, [['2026-11-03T09:00Z', '2026-11-03T10:00Z']])
    const result = await read(f.adminCtx, input(f))
    expect(ResultSchema.safeParse(result).success).toBe(true)
    expect(JSON.stringify(result).includes('private-only-')).toBe(false)
    expect(result.bookings.data).toEqual([
      {
        id,
        status: 'confirmed',
        start: '2026-11-02T09:00:00.000Z',
        end: '2026-11-02T09:30:00.000Z',
        cancelledAt: null,
        eventType: { id: f.eventId, title: 'Team consultation' },
        hosts: [{ userId: f.member.id, name: f.member.name }],
        attendees: [
          { name: 'Booker', email: 'booker@example.com', timeZone: 'UTC', isBooker: true },
        ],
        inProgress: false,
        handling: 'coordinate_cancellation',
      },
    ])
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', f.eventId)
      .execute()
    const missing = await booking(f, '2026-11-02T10:00:00Z', { eventId: null })
    const deleted = await read(f.adminCtx, input(f))
    expect(deleted.eventTypes.data).toEqual([])
    expect(deleted.bookings.data.map(({ id, eventType }) => ({ id, eventType }))).toEqual([
      { id, eventType: { id: f.eventId, title: null } },
      { id: missing, eventType: null },
    ])
  }

  async function verifyPagination(read: Read) {
    const f = await setup()
    const eventIds = [f.eventId]
    const bookingIds: string[] = []
    for (let index = 0; index < 4; index++) {
      eventIds.push(await event(f, index % 2 === 0 ? 'round_robin' : 'collective'))
      bookingIds.push(
        await booking(f, `2026-11-02T${String(index + 9).padStart(2, '0')}:00:00Z`, {
          hosts: [f.member.id, f.host.id],
        }),
      )
    }
    eventIds.sort()
    for (const limit of [1, 2]) {
      const seenEvents: string[] = []
      const seenBookings: string[] = []
      let eventTypesCursor: string | undefined
      let bookingsCursor: string | undefined
      let eventsDone = false
      let bookingsDone = false
      for (let page = 0; page < 6; page++) {
        const result = await read(
          f.adminCtx,
          input(f, {
            eventTypesLimit: limit,
            bookingsLimit: limit,
            eventTypesCursor,
            bookingsCursor,
          }),
        )
        expect(result.eventTypes.totalCount).toBe(5)
        expect(result.bookings.totalCount).toBe(4)
        if (!eventsDone) {
          expect(result.eventTypes.data.map((row) => row.id)).toEqual(
            eventIds.slice(seenEvents.length, seenEvents.length + limit),
          )
          seenEvents.push(...result.eventTypes.data.map((row) => row.id))
          eventsDone = result.eventTypes.nextCursor === null
          eventTypesCursor = result.eventTypes.nextCursor ?? undefined
        }
        if (!bookingsDone) {
          expect(result.bookings.data.map((row) => row.id)).toEqual(
            bookingIds.slice(seenBookings.length, seenBookings.length + limit),
          )
          seenBookings.push(...result.bookings.data.map((row) => row.id))
          bookingsDone = result.bookings.nextCursor === null
          bookingsCursor = result.bookings.nextCursor ?? undefined
        }
        if (eventsDone && bookingsDone) break
      }
      expect(seenEvents).toEqual(eventIds)
      expect(seenBookings).toEqual(bookingIds)
    }
  }

  async function verifyPreciseCursor(read: Read) {
    const f = await setup()
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().toReversed()
    for (let index = 0; index < ids.length; index++)
      await booking(f, `2026-11-02T09:00:00.00000${index + 1}Z`, {
        id: ids[index],
        end: `2026-11-02T09:00:00.00000${index + 2}Z`,
      })
    const first = await read(f.memberCtx, input(f, { bookingsLimit: 1 }))
    expect(first.bookings.data.map((row) => row.id)).toEqual(ids.slice(0, 1))
    expect(first.bookings.nextCursor).toEqual(expect.any(String))
    await booking(f, '2026-11-02T08:00:00Z')
    const second = await read(
      f.memberCtx,
      input(f, { bookingsLimit: 1, bookingsCursor: first.bookings.nextCursor ?? undefined }),
    )
    const third = await read(
      f.memberCtx,
      input(f, { bookingsLimit: 1, bookingsCursor: second.bookings.nextCursor ?? undefined }),
    )
    expect(second.bookings.data.map((row) => row.id)).toEqual(ids.slice(1, 2))
    expect(third.bookings.data.map((row) => row.id)).toEqual(ids.slice(2))
    expect(third.bookings.nextCursor).toBeNull()
    expect(second.bookings.totalCount).toBe(4)
  }

  async function verifyPreciseStart(read: Read) {
    const f = await setup()
    const id = await booking(f, '2026-11-01T12:00:00.000001Z')
    const before = await read(f.memberCtx, input(f))
    expect(
      before.bookings.data.map(({ id, inProgress, handling }) => ({ id, inProgress, handling })),
    ).toEqual([{ id, inProgress: false, handling: 'coordinate_cancellation' }])
    const atStart = await read(
      { ...f.memberCtx, now: () => instant('2026-11-01T12:00:00.000001Z') },
      input(f),
    )
    expect(
      atStart.bookings.data.map(({ id, inProgress, handling }) => ({ id, inProgress, handling })),
    ).toEqual([{ id, inProgress: true, handling: 'wait_until_end_or_coordinate_offline' }])
  }

  async function verifyQueryBounds(read: Read) {
    const f = await setup()
    for (let index = 0; index < 4; index++) {
      await event(f, 'collective')
      await booking(f, `2026-11-02T${String(index + 9).padStart(2, '0')}:00:00Z`)
    }
    const queries: unknown[] = []
    const observed = db.withPlugin({
      transformQuery: ({ node }) => {
        queries.push(node)
        return node
      },
      transformResult: async ({ result }) => result,
    })
    const result = await read(
      { ...f.ownerCtx, db: observed },
      input(f, { eventTypesLimit: 1, bookingsLimit: 2 }),
    )
    expect(result.eventTypes.totalCount).toBe(5)
    expect(result.bookings.totalCount).toBe(4)
    expect(result.eventTypes.data).toHaveLength(1)
    expect(result.bookings.data).toHaveLength(2)
    const serialized = queries.map((node) => JSON.stringify(node))
    expect(
      serialized.some((query) =>
        /calendar_busy|calendar_connections|"name":"calendars"/.test(query),
      ),
    ).toBe(false)
    const events = queries.filter((_, index) =>
      serialized[index]?.includes('"alias":{"kind":"IdentifierNode","name":"event"}'),
    )
    const eventPage = events.find(
      (node) =>
        JSON.stringify(node).includes('"limit"') &&
        !JSON.stringify(node).includes('"alias":{"kind":"IdentifierNode","name":"b"}'),
    )
    expect(eventPage).toMatchObject({ limit: { limit: { value: 2 } } })
    const bookingPage = queries.find((_, index) =>
      serialized[index]?.includes('"alias":{"kind":"IdentifierNode","name":"b"}'),
    )
    expect(bookingPage).toMatchObject({ limit: { limit: { value: 3 } } })
    const participantQueries = queries.filter(
      (_, index) =>
        serialized[index]?.includes('"alias":{"kind":"IdentifierNode","name":"attendee"}') ||
        (serialized[index]?.includes('"alias":{"kind":"IdentifierNode","name":"host"}') &&
          serialized[index]?.includes('"alias":{"kind":"IdentifierNode","name":"user"}')),
    )
    expect(participantQueries).toHaveLength(2)
    for (const node of participantQueries) {
      const query = JSON.stringify(node)
      expect(query).toContain('"operator":"in"')
      for (const booking of result.bookings.data) expect(query).toContain(booking.id)
    }
    expect(queries.length).toBeLessThanOrEqual(9)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
  }

  async function verifySnapshot(read: Read) {
    const f = await setup()
    const id = await booking(f)
    let changed = false
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        if (!changed && result.rows.some((row) => row.role === 'owner')) {
          changed = true
          // Commit after the read's identity snapshot but before its impact queries.
          await db.deleteFrom('event_type_hosts').where('event_type_id', '=', f.eventId).execute()
          await db
            .updateTable('bookings')
            .set({ status: 'cancelled', cancelled_at: new Date() })
            .where('id', '=', id)
            .execute()
        }
        return result
      },
    })
    const result = await read({ ...f.ownerCtx, db: observed }, input(f))
    expect(changed).toBe(true)
    expect(result.eventTypes.data.map((row) => row.id)).toEqual([f.eventId])
    expect(result.eventTypes.totalCount).toBe(1)
    expect(result.bookings.data.map((row) => row.id)).toEqual([id])
    expect(result.bookings.totalCount).toBe(1)
    const current = await read(f.ownerCtx, input(f))
    expect(current.eventTypes.totalCount).toBe(0)
    expect(current.bookings.totalCount).toBe(0)
  }

  async function verifyBoundary(read: Read) {
    const f = await setup()
    await booking(f, '2026-10-31T09:00:00Z')
    await booking(f, '2026-11-01T11:30:00Z', { end: now().toString() })
    await booking(f, '2026-11-02T08:00:00Z', { status: 'cancelled' })
    const future = await booking(f, '2026-11-02T09:00:00Z')
    const result = await read(f.memberCtx, input(f))
    expect(
      result.bookings.data.map(({ id, inProgress, handling }) => ({ id, inProgress, handling })),
    ).toEqual([{ id: future, inProgress: false, handling: 'coordinate_cancellation' }])
    expect(result.bookings.totalCount).toBe(1)
    expect(result.evaluatedAt).toBe('2026-11-01T12:00:00Z')
    for (const start of ['2026-11-01T11:45:00Z', now().toString()]) {
      const other = await setup()
      const id = await booking(other, start, { end: '2026-11-01T12:30:00Z' })
      const page = (await read(other.memberCtx, input(other))).bookings
      expect(
        page.data.map(({ id, inProgress, handling }) => ({ id, inProgress, handling })),
      ).toEqual([{ id, inProgress: true, handling: 'wait_until_end_or_coordinate_offline' }])
      expect(page.totalCount).toBe(1)
    }
  }

  it('allows self impact to members and all current team members to owners/admins', async () => {
    const f = await setup()
    const id = await booking(f)
    for (const ctx of [f.ownerCtx, f.adminCtx, f.memberCtx])
      expect(
        (await getTeamMemberDepartureImpact(ctx, input(f))).bookings.data.map((row) => row.id),
      ).toEqual([id])
    await expectDenied(
      getTeamMemberDepartureImpact,
      f.memberCtx,
      input(f, { memberUserId: f.host.id }),
    )
    await expectDenied(getTeamMemberDepartureImpact, f.hostCtx, input(f))
    expect(
      (await getTeamMemberDepartureImpact(f.hostCtx, input(f, { memberUserId: f.host.id })))
        .bookings.totalCount,
    ).toBe(0)
  })

  it('excludes personal data, other teams and other hosts from both lists and counts', () =>
    verifyIsolation(getTeamMemberDepartureImpact))
  it('identifies each current host relationship and includes disabled, undeleted events', () =>
    verifyReasons(getTeamMemberDepartureImpact))
  it('reports zero remaining hosts for single-host round-robin pools and ignores invalid hosts', () =>
    verifyRemainingHosts(getTeamMemberDepartureImpact))
  it('includes unended bookings with the existing cancellation boundary at start', () =>
    verifyBoundary(getTeamMemberDepartureImpact))
  it('uses saved booking hosts independently from the event type current pool', () =>
    verifySavedHosts(getTeamMemberDepartureImpact))
  it('uses only explicit team booking fields and suppresses deleted event metadata', () =>
    verifyWhitelist(getTeamMemberDepartureImpact))
  it('pages independent lists without collective duplication and keeps full scoped counts', () =>
    verifyPagination(getTeamMemberDepartureImpact))
  it('retains stored microseconds across booking pages under earlier inserts', () =>
    verifyPreciseCursor(getTeamMemberDepartureImpact))
  it('uses stored microseconds for the start boundary instead of DTO milliseconds', () =>
    verifyPreciseStart(getTeamMemberDepartureImpact))
  it('bounds both database pages and participant reads without reading private calendars', () =>
    verifyQueryBounds(getTeamMemberDepartureImpact))
  it('keeps counts and both lists in the same current authorization snapshot', () =>
    verifySnapshot(getTeamMemberDepartureImpact))

  async function role(f: Fixture, user: TestUser, value: string) {
    await db
      .updateTable('auth.member')
      .set({ role: value })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', user.id)
      .execute()
  }

  async function activeOrganization(ctx: ServiceContext, organizationId: string | null) {
    if (ctx.principal.kind !== 'session') throw new Error('Missing session')
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: organizationId })
      .where('id', '=', ctx.principal.sessionId)
      .execute()
  }

  type DenialCase = {
    name: string
    change: (f: Fixture) => Promise<{ ctx: ServiceContext; query?: Input }>
    mutation?: Replacement
  }
  const denialCases: DenialCase[] = [
    {
      name: 'another member requesting a colleague',
      change: async (f) => ({ ctx: f.hostCtx }),
      mutation: ["!roles.includes('admin')\n  )", 'false\n  )'],
    },
    {
      name: 'current revoked actor membership',
      change: async (f) => {
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.owner.id)
          .execute()
        return { ctx: f.ownerCtx }
      },
      mutation: [
        ".innerJoin('auth.member as member', 'member.userId', 'user.id')",
        ".innerJoin('auth.member as member', 'member.organizationId', 'session.activeOrganizationId')",
      ],
    },
    {
      name: 'current downgraded actor role',
      change: async (f) => {
        await role(f, f.admin, 'member')
        return { ctx: f.adminCtx }
      },
    },
    {
      name: 'unknown actor role substring',
      change: async (f) => {
        await role(f, f.member, 'administrator')
        return { ctx: f.memberCtx }
      },
      mutation: [
        "roles.includes('admin') || roles.includes('member')",
        "roles.some((role) => role.includes('admin')) || roles.includes('member')",
      ],
    },
    {
      name: 'unverified current actor identity',
      change: async (f) => {
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', f.owner.id)
          .execute()
        return { ctx: f.ownerCtx }
      },
      mutation: [".where('user.emailVerified', '=', true)", ''],
    },
    {
      name: 'expired current session',
      change: async (f) => {
        if (f.ownerCtx.principal.kind !== 'session') throw new Error('Missing session')
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', f.ownerCtx.principal.sessionId)
          .execute()
        return { ctx: f.ownerCtx }
      },
      mutation: [".where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)", ''],
    },
    {
      name: 'revoked session',
      change: async (f) => {
        if (f.ownerCtx.principal.kind !== 'session') throw new Error('Missing session')
        await session(f.owner, f.team.as(f.owner).organization)
        await db
          .deleteFrom('auth.session')
          .where('id', '=', f.ownerCtx.principal.sessionId)
          .execute()
        return { ctx: f.ownerCtx }
      },
      mutation: [".where('session.id', '=', principal.sessionId)", ''],
    },
    {
      name: 'another user session identity',
      change: async (f) => {
        if (f.ownerCtx.principal.kind !== 'session' || f.adminCtx.principal.kind !== 'session')
          throw new Error('Missing session')
        return {
          ctx: {
            ...f.ownerCtx,
            principal: { ...f.ownerCtx.principal, sessionId: f.adminCtx.principal.sessionId },
          },
        }
      },
      mutation: [".where('session.userId', '=', principal.user.id)", ''],
    },
    {
      name: 'active session switched to another team',
      change: async (f) => {
        const other = await createTestTeam(db, [{ user: f.owner, role: 'owner' }])
        await activeOrganization(f.ownerCtx, other.id)
        return { ctx: f.ownerCtx }
      },
      mutation: [".where('session.activeOrganizationId', '=', input.teamId)", ''],
    },
    {
      name: 'session in personal space',
      change: async (f) => {
        await activeOrganization(f.ownerCtx, null)
        return { ctx: f.ownerCtx }
      },
    },
    {
      name: 'principal switched to another organization',
      change: async (f) => ({
        ctx: {
          ...f.ownerCtx,
          principal: { ...f.ownerCtx.principal, organization: f.owner.principal.organization },
        },
      }),
      mutation: ['principal.organization.id.toLowerCase() !== input.teamId.toLowerCase()', 'false'],
    },
    {
      name: 'explicit inaccessible team',
      change: async (f) => {
        const other = await createTestTeam(db, [{ user: f.member, role: 'owner' }])
        await activeOrganization(f.ownerCtx, other.id)
        return {
          ctx: {
            ...f.ownerCtx,
            principal: { ...f.ownerCtx.principal, organization: other.as(f.member).organization },
          },
          query: input(f, { teamId: other.id }),
        }
      },
      mutation: [".where('organization.id', '=', input.teamId)", ''],
    },
    {
      name: 'forged personal organization metadata',
      change: async (f) => {
        const ctx = await session(f.owner)
        ctx.principal.organization.personal = false
        return {
          ctx,
          query: input(f, { teamId: f.owner.principal.organization.id, memberUserId: f.owner.id }),
        }
      },
      mutation: [
        ".whereRef('organization_id', '=', 'organization.id')",
        ".where('organization_id', '=', '00000000-0000-0000-0000-000000000000')",
      ],
    },
    {
      name: 'removed target member',
      change: async (f) => {
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.member.id)
          .execute()
        return { ctx: f.adminCtx }
      },
      mutation: ['if (!target || !knownMember(currentRoles(target.role))) throw denied()', ''],
    },
    {
      name: 'target only belongs to another team',
      change: async (f) => {
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.member.id)
          .execute()
        await createTestTeam(db, [{ user: f.member, role: 'owner' }])
        return { ctx: f.adminCtx }
      },
      mutation: [".where('organizationId', '=', input.teamId)", ''],
    },
    {
      name: 'nonexistent target identity',
      change: async (f) => ({ ctx: f.adminCtx, query: input(f, { memberUserId: randomUUID() }) }),
      mutation: [".where('userId', '=', input.memberUserId)", ''],
    },
    {
      name: 'unknown target membership role',
      change: async (f) => {
        await role(f, f.member, 'team_member')
        return { ctx: f.adminCtx }
      },
      mutation: ['!target || !knownMember(currentRoles(target.role))', '!target'],
    },
    {
      name: 'API key credential',
      change: async (f) => ({
        ctx: {
          ...f.ownerCtx,
          principal: {
            ...f.ownerCtx.principal,
            kind: 'api_key',
            apiKeyId: randomUUID(),
          } as Principal,
        },
      }),
      mutation: ["principal.kind !== 'session' ||", 'false ||'],
    },
    {
      name: 'OAuth credential',
      change: async (f) => ({
        ctx: testContext(
          db,
          {
            ...f.team.as(f.owner),
            kind: 'oauth',
            oauthConsentId: randomUUID(),
            clientId: 'synthetic',
            scopes: [],
          } as Principal,
          now,
        ),
      }),
    },
  ]

  it.each(denialCases)('uniformly denies $name', async ({ change }) => {
    const f = await setup()
    await booking(f)
    const { ctx, query } = await change(f)
    await expectDenied(getTeamMemberDepartureImpact, ctx, query ?? input(f))
  })

  it('parses exact comma-separated current roles and ignores stale personal metadata', async () => {
    const f = await setup()
    const id = await booking(f)
    await role(f, f.admin, 'member, admin')
    await role(f, f.member, 'member,owner')
    f.adminCtx.principal.organization.personal = true
    expect(
      (await getTeamMemberDepartureImpact(f.adminCtx, input(f))).bookings.data.map((row) => row.id),
    ).toEqual([id])
    expect(
      (await getTeamMemberDepartureImpact(f.memberCtx, input(f, { memberUserId: f.host.id })))
        .bookings.totalCount,
    ).toBe(0)
  })

  it.each<Partial<Input>>([
    { eventTypesLimit: 0 },
    { eventTypesLimit: 101 },
    { eventTypesLimit: 1.5 },
    { bookingsLimit: 0 },
    { bookingsLimit: 101 },
    { bookingsLimit: 1.5 },
  ])('rejects invalid independent limits %s', async (extra) => {
    const f = await setup()
    await expect(getTeamMemberDepartureImpact(f.memberCtx, input(f, extra))).rejects.toMatchObject({
      kind: 'invalid',
      code: 'invalid_limit',
    })
  })

  it.each<Partial<Input>>([
    { eventTypesCursor: 'invalid' },
    { bookingsCursor: 'invalid' },
    {
      bookingsCursor: Buffer.from(JSON.stringify(['2026-11-02T09:00Z', 'invalid'])).toString(
        'base64url',
      ),
    },
  ])('rejects invalid independent cursors %s', async (extra) => {
    const f = await setup()
    await expect(getTeamMemberDepartureImpact(f.memberCtx, input(f, extra))).rejects.toMatchObject({
      kind: 'invalid',
      code: 'invalid_cursor',
    })
  })

  it.each(['user', 'organization', 'session', 'team', 'target'] as const)(
    'uniformly denies malformed %s UUIDs before SQL',
    async (field) => {
      const f = await setup()
      let ctx = f.ownerCtx
      let query = input(f)
      if (field === 'team') query = input(f, { teamId: 'invalid' })
      else if (field === 'target') query = input(f, { memberUserId: 'invalid' })
      else
        ctx = {
          ...ctx,
          principal: {
            ...ctx.principal,
            ...(field === 'session'
              ? { sessionId: 'invalid' }
              : { [field]: { ...ctx.principal[field], id: 'invalid' } }),
          },
        }
      await expectDenied(getTeamMemberDepartureImpact, ctx, query)
    },
  )

  it('passes all assertions against an unmodified source copy', async () => {
    const read = sourceCopy()
    await verifyIsolation(read)
    await verifyReasons(read)
    await verifyRemainingHosts(read)
    await verifySavedHosts(read)
    await verifyBoundary(read)
    await verifyWhitelist(read)
    await verifyPagination(read)
    await verifyPreciseCursor(read)
    await verifyPreciseStart(read)
    await verifyQueryBounds(read)
    await verifySnapshot(read)
  })

  it.each(denialCases.filter((test) => test.mutation !== undefined))(
    'detects a missing $name protection with a real assertion failure',
    async ({ change, mutation }) => {
      const read = sourceCopy(mutation)
      const f = await setup()
      const { ctx, query } = await change(f)
      await expect(expectDenied(read, ctx, query ?? input(f))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  it.each(['user', 'session', 'target', 'organization'] as const)(
    'detects missing %s UUID validation with a real assertion failure',
    async (field) => {
      const f = await setup()
      let ctx = f.ownerCtx
      let query = input(f)
      const replacement: Replacement =
        field === 'organization'
          ? ['!isUuid(principal.organization.id) ||\n    !isUuid(input.teamId) ||', 'false ||']
          : [
              `!isUuid(${field === 'user' ? 'principal.user.id' : field === 'session' ? 'principal.sessionId' : 'input.memberUserId'})`,
              'false',
            ]
      if (field === 'target') query = input(f, { memberUserId: 'invalid' })
      else if (field === 'organization') {
        ctx = {
          ...ctx,
          principal: {
            ...ctx.principal,
            organization: { ...ctx.principal.organization, id: 'invalid' },
          },
        }
        query = input(f, { teamId: 'invalid' })
      } else
        ctx = {
          ...ctx,
          principal: {
            ...ctx.principal,
            ...(field === 'session'
              ? { sessionId: 'invalid' }
              : { user: { ...ctx.principal.user, id: 'invalid' } }),
          },
        }
      await expect(expectDenied(sourceCopy(replacement), ctx, query)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  type Mutation = {
    name: string
    service?: Replacement
    page?: Replacement
    team?: Replacement
    verify: (read: Read) => Promise<void>
  }
  const mutations: Mutation[] = [
    {
      name: 'exclude the departing host from remaining hosts',
      service: [".where('remaining_host.user_id', '!=', input.memberUserId)", ''],
      verify: verifyRemainingHosts,
    },
    {
      name: 'remaining host current team membership',
      service: [
        ".innerJoin('auth.member as remaining_member', (join) =>",
        ".leftJoin('auth.member as remaining_member', (join) =>",
      ],
      verify: verifyRemainingHosts,
    },
    {
      name: 'remaining host membership in the same team',
      service: [".onRef('remaining_member.organizationId', '=', 'event.organization_id')", ''],
      verify: verifyRemainingHosts,
    },
    {
      name: 'remaining host verification',
      service: [".where('remaining_user.emailVerified', '=', true)", ''],
      verify: verifyRemainingHosts,
    },
    {
      name: 'remaining host event association',
      service: [".whereRef('remaining_host.event_type_id', '=', 'event.id')", ''],
      verify: verifyRemainingHosts,
    },
    {
      name: 'remaining host count projection',
      service: ['remainingHostCount: Number(row.remaining_host_count)', 'remainingHostCount: 1'],
      verify: verifyRemainingHosts,
    },
    {
      name: 'one snapshot for authorization, lists and counts',
      service: [".setIsolationLevel('repeatable read')", ''],
      verify: verifySnapshot,
    },
    {
      name: 'event team isolation',
      service: [".where('event.organization_id', '=', input.teamId)", ''],
      verify: verifyIsolation,
    },
    {
      name: 'event target-host isolation',
      service: [".where('host.user_id', '=', input.memberUserId)", ''],
      verify: verifyIsolation,
    },
    {
      name: 'personal event exclusion inside a team',
      service: [".where('event.owner_user_id', 'is', null)", ''],
      verify: verifyIsolation,
    },
    {
      name: 'deleted event exclusion',
      service: [".where('event.deleted_at', 'is', null)", ''],
      verify: verifyReasons,
    },
    {
      name: 'disabled events still requiring departure handling',
      service: [
        ".where('event.deleted_at', 'is', null)",
        ".where('event.deleted_at', 'is', null).where('event.is_active', '=', true)",
      ],
      verify: verifyReasons,
    },
    {
      name: 'round-robin reason',
      service: ["? 'round_robin_pool_member'", "? 'sole_host'"],
      verify: verifyReasons,
    },
    {
      name: 'collective required-host reason',
      service: ["? 'collective_required_host'", "? 'sole_host'"],
      verify: verifyReasons,
    },
    {
      name: 'booking count team isolation',
      service: [".where('booking.organization_id', '=', input.teamId)", ''],
      verify: verifyIsolation,
    },
    {
      name: 'booking count target host',
      service: [
        ".where('host.user_id', '=', input.memberUserId)\n    .where('booking.status'",
        ".where('booking.status'",
      ],
      verify: verifySavedHosts,
    },
    {
      name: 'booking count personal event exclusion',
      service: [
        ".where('event.owner_user_id', 'is', null)\n    .where('host.user_id', '=', input.memberUserId)\n    .where('booking.status'",
        ".where('host.user_id', '=', input.memberUserId)\n    .where('booking.status'",
      ],
      verify: verifyIsolation,
    },
    {
      name: 'booking page personal event exclusion',
      team: [".$if(teamEventTypesOnly, (q) => q.where('event.owner_user_id', 'is', null))", ''],
      verify: verifyIsolation,
    },
    {
      name: 'booking count confirmed status',
      service: [".where('booking.status', '=', 'confirmed')", ''],
      verify: verifyBoundary,
    },
    {
      name: 'booking count strict end boundary',
      service: [".where('booking.end_at', '>',", ".where('booking.end_at', '>=',"],
      verify: verifyBoundary,
    },
    {
      name: 'booking page team isolation',
      team: [".where('b.organization_id', '=', teamId)", ''],
      verify: verifyIsolation,
    },
    {
      name: 'booking page saved host isolation',
      team: [".where('assigned_host.user_id', '=', hostUserId as string)", ''],
      verify: verifySavedHosts,
    },
    {
      name: 'booking page confirmed status',
      service: ["status: 'confirmed',", ''],
      verify: verifyBoundary,
    },
    {
      name: 'booking page includes meetings that have started',
      service: ['endAfter: now,', 'from: now,'],
      verify: verifyBoundary,
    },
    {
      name: 'booking page strict end boundary',
      page: ["eb('b.end_at', '>', timestamptz", "eb('b.end_at', '>=', timestamptz"],
      verify: verifyBoundary,
    },
    {
      name: 'start-at-now in-progress boundary',
      service: [
        'Temporal.Instant.compare(start, now) <= 0',
        'Temporal.Instant.compare(start, now) < 0',
      ],
      verify: verifyBoundary,
    },
    {
      name: 'in-progress handling limitation',
      service: [
        "handling: inProgress ? 'wait_until_end_or_coordinate_offline' : 'coordinate_cancellation'",
        "handling: 'coordinate_cancellation'",
      ],
      verify: verifyBoundary,
    },
    {
      name: 'event type explicit mapper whitelist',
      service: ['data: eventPage.map((row) => ({', 'data: eventPage.map((row) => ({ ...row,'],
      verify: verifyWhitelist,
    },
    {
      name: 'booking explicit mapper whitelist',
      team: [
        'toTeamAdminBooking({\n        id: row.id,',
        '({\n        ...row,\n        id: row.id,',
      ],
      verify: verifyWhitelist,
    },
    {
      name: 'deleted booking event title suppression',
      team: ['CASE WHEN event.deleted_at IS NULL THEN event.title ELSE NULL END', 'event.title'],
      verify: verifyWhitelist,
    },
    {
      name: 'event keyset cursor',
      service: [".$if(after !== undefined, (q) => q.where('event.id', '>', after as string))", ''],
      verify: verifyPagination,
    },
    {
      name: 'event database query limit',
      service: ['.limit(limit + 1)', ''],
      verify: verifyQueryBounds,
    },
    {
      name: 'booking database query limit',
      page: ['.limit(limit + 1)', ''],
      verify: verifyQueryBounds,
    },
    {
      name: 'booking cursor microsecond precision',
      page: ['[row.cursor_start, row.id]', '[new Date(row.cursor_start).toISOString(), row.id]'],
      verify: verifyPreciseCursor,
    },
    {
      name: 'in-progress start microsecond precision',
      team: [
        'Temporal.Instant.from(row.cursor_start)',
        'Temporal.Instant.from(row.start_at.toISOString())',
      ],
      verify: verifyPreciseStart,
    },
    {
      name: 'private calendar read boundary',
      service: [
        'const now = ctx.now()',
        "await ctx.db.selectFrom('calendars').select('id').execute()\n  const now = ctx.now()",
      ],
      verify: verifyQueryBounds,
    },
    {
      name: 'saved host read bounded to page identifiers',
      team: [".where('host.booking_id', 'in', bookingIds)", ''],
      verify: verifyQueryBounds,
    },
    {
      name: 'attendee read bounded to page identifiers',
      team: [".where('attendee.booking_id', 'in', bookingIds)", ''],
      verify: verifyQueryBounds,
    },
  ]

  it.each(mutations)(
    'detects a broken $name with a real assertion failure',
    async ({ service, page, team, verify }) => {
      const read = sourceCopy(service, page, team)
      await expect(verify(read)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
