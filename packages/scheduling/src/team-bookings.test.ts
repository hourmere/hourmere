import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bookingPageQuery, encodeBookingCursor, type ListBookingsInput } from './booking-page.ts'
import {
  cancelHostBooking,
  createPublicTeamBooking,
  listHostBookings,
  rescheduleHostBooking,
} from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { createEventType } from './event-types.ts'
import { isUuid } from './internal.ts'
import { TeamAdminBookingPageSchema, toTeamAdminBooking } from './team-admin-booking.ts'
import { listTeamAdminBookings } from './team-bookings.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const instant = Temporal.Instant.from
const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
type List = typeof listTeamAdminBookings
type Replacement = readonly [string, string]

/** Compile a separate in-memory source copy; mutations never edit the service under test. */
function sourceCopy(replacement?: Replacement, pageReplacement?: Replacement): List {
  const compile = (path: string, replacement?: Replacement) => {
    let source = readFileSync(path, 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
      source = source.replace(...replacement)
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
  return new Function(
    'sql',
    'bookingPageQuery',
    'encodeBookingCursor',
    'DomainError',
    'isUuid',
    'toTeamAdminBooking',
    `${compile('packages/scheduling/src/team-bookings.ts', replacement)}; return listTeamAdminBookings`,
  )(
    sql,
    page.bookingPageQuery,
    page.encodeBookingCursor,
    DomainError,
    isUuid,
    toTeamAdminBooking,
  ) as List
}

describe.skipIf(!serverUrl)('team admin booking list', () => {
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
    const [ownerCtx, adminCtx, memberCtx] = await Promise.all([
      session(owner, team.as(owner).organization),
      session(admin, team.as(admin).organization),
      session(member, team.as(member).organization),
    ])
    const eventId = await createFixtures(db).eventType(team.id, member.id, {
      title: 'Team consultation',
    })
    return { owner, admin, member, host, team, ownerCtx, adminCtx, memberCtx, eventId }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>

  async function booking(
    f: Fixture,
    start = '2026-11-02T09:00Z',
    options: {
      organizationId?: string
      eventId?: string | null
      hosts?: string[]
      id?: string
      status?: 'confirmed' | 'cancelled'
      rescheduledFromId?: string
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
        start_at: instant(start).toString(),
        end_at: instant(start).add({ minutes: 30 }).toString(),
        title: 'private-only-custom-booking-title',
        responses: JSON.stringify({ private: 'private-only-custom-answer' }),
        location: JSON.stringify({ kind: 'custom', text: 'private-only-conference-link' }),
        manage_token_hash: randomBytes(32),
        source: 'web',
        status,
        cancelled_at: status === 'cancelled' ? new Date('2026-11-01T01:00Z') : null,
        cancel_reason: status === 'cancelled' ? 'private-only-cancellation-reason' : null,
        rescheduled_from_id: options.rescheduledFromId ?? null,
      })
      .execute()
    for (const userId of options.hosts ?? [f.member.id]) {
      await db.insertInto('booking_hosts').values({ booking_id: id, user_id: userId }).execute()
    }
    await db
      .insertInto('booking_attendees')
      .values([
        {
          booking_id: id,
          name: 'Booker',
          email: 'booker@example.com',
          time_zone: 'UTC',
          locale: 'en-US',
          is_booker: true,
        },
        {
          booking_id: id,
          name: 'Guest',
          email: 'guest@example.com',
          time_zone: 'UTC',
          locale: null,
          is_booker: false,
        },
      ])
      .execute()
    return id
  }

  async function expectDenied(list: List, ctx: ServiceContext) {
    const result = await list(ctx).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toMatchObject(denied)
  }

  async function verifyIsolation(list: List) {
    const f = await setup()
    const own = await booking(f)
    const other = await createTestTeam(db, [{ user: f.owner, role: 'owner' }])
    const otherEvent = await createFixtures(db).eventType(other.id, f.member.id, {
      title: 'private-only-other-team-event',
    })
    await booking(f, '2026-11-02T10:00Z', { organizationId: other.id, eventId: otherEvent })
    await booking(f, '2026-11-02T11:00Z', {
      organizationId: f.owner.principal.organization.id,
      eventId: null,
      hosts: [f.owner.id],
    })
    expect((await list(f.ownerCtx)).data.map((item) => item.id)).toEqual([own])
  }

  async function verifyCollective(list: List) {
    const f = await setup()
    const expected = []
    for (const hour of ['09', '10', '11'])
      expected.push(await booking(f, `2026-11-02T${hour}:00Z`, { hosts: [f.member.id, f.host.id] }))
    for (const limit of [1, 2]) {
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 5; page++) {
        const result = await list(f.adminCtx, { limit, cursor })
        expect(result.data.map((item) => item.id)).toEqual(
          expected.slice(seen.length, seen.length + limit),
        )
        for (const item of result.data) {
          seen.push(item.id)
          expect(item.hosts.map((host) => host.userId).sort()).toEqual(
            [f.member.id, f.host.id].sort(),
          )
        }
        expect(result.nextCursor === null).toBe(seen.length === expected.length)
        if (result.nextCursor === null) break
        cursor = result.nextCursor
      }
      expect(seen).toEqual(expected)
    }
  }

  async function verifyWhitelist(list: List) {
    const f = await setup()
    const id = await booking(f)
    const result = await list(f.adminCtx)
    expect(TeamAdminBookingPageSchema.safeParse(result).success).toBe(true)
    expect(JSON.stringify(result).includes('private-only-')).toBe(false)
    expect(result.data).toEqual([
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
          { name: 'Guest', email: 'guest@example.com', timeZone: 'UTC', isBooker: false },
        ],
      },
    ])
  }

  async function verifyCursor(list: List, order: 'asc' | 'desc') {
    const f = await setup()
    // Stored microseconds must survive the cursor even though DTO timestamps use milliseconds.
    const ids = [
      '01930000-0000-7000-8000-000000000003',
      '01930000-0000-7000-8000-000000000002',
      '01930000-0000-7000-8000-000000000001',
    ].map((id) => `${randomBytes(4).toString('hex')}${id.slice(8)}`)
    for (let index = 0; index < ids.length; index++)
      await booking(f, `2026-11-02T09:00:00.00000${index + 1}Z`, { id: ids[index], hosts: [] })
    const expected = order === 'asc' ? ids : ids.toReversed()
    const first = await list(f.ownerCtx, { order, limit: 1 })
    expect(first.data.map((row) => row.id)).toEqual(expected.slice(0, 1))
    expect(first.nextCursor).toEqual(expect.any(String))
    await booking(f, order === 'asc' ? '2026-11-02T08:00Z' : '2026-11-02T10:00Z', { hosts: [] })
    const next = await list(f.ownerCtx, { order, limit: 1, cursor: first.nextCursor ?? undefined })
    expect(next.data.map((row) => row.id)).toEqual(expected.slice(1, 2))
    const last = await list(f.ownerCtx, { order, limit: 1, cursor: next.nextCursor ?? undefined })
    expect(last.data.map((row) => row.id)).toEqual(expected.slice(2))
    expect(last.nextCursor).toBeNull()
  }

  it('lets a non-host owner/admin list only current-team bookings', () =>
    verifyIsolation(listTeamAdminBookings))
  it('loads only the whitelist, actual hosts and ordered attendees', () =>
    verifyWhitelist(listTeamAdminBookings))
  it('returns collective bookings once across page boundaries', () =>
    verifyCollective(listTeamAdminBookings))
  it.each(['asc', 'desc'] as const)('keeps %s microsecond cursors stable under inserts', (order) =>
    verifyCursor(listTeamAdminBookings, order),
  )

  it('uses UUID tie-breakers in both directions', async () => {
    const f = await setup()
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort()
    for (const id of ids) await booking(f, undefined, { id, hosts: [] })
    for (const order of ['asc', 'desc'] as const) {
      const expected = order === 'asc' ? ids : ids.toReversed()
      const first = await listTeamAdminBookings(f.ownerCtx, { order, limit: 2 })
      const next = await listTeamAdminBookings(f.ownerCtx, {
        order,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      })
      expect([...first.data, ...next.data].map((row) => row.id)).toEqual(expected)
      expect(next.nextCursor).toBeNull()
    }
  })

  it('denies members, stale roles, unverified users and invalid sessions uniformly', async () => {
    const f = await setup()
    await booking(f)
    await expectDenied(listTeamAdminBookings, f.memberCtx)
    await db
      .updateTable('auth.member')
      .set({ role: 'administrator' })
      .where('userId', '=', f.admin.id)
      .where('organizationId', '=', f.team.id)
      .execute()
    await expectDenied(listTeamAdminBookings, f.adminCtx)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.owner.id)
      .execute()
    await expectDenied(listTeamAdminBookings, f.ownerCtx)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', f.owner.id)
      .execute()
    if (f.ownerCtx.principal.kind !== 'session') throw new Error('Missing session')
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.ownerCtx.principal.sessionId)
      .execute()
    await expectDenied(listTeamAdminBookings, f.ownerCtx)
    await db.deleteFrom('auth.session').where('id', '=', f.ownerCtx.principal.sessionId).execute()
    await expectDenied(listTeamAdminBookings, f.ownerCtx)
  })

  it('denies API keys, OAuth, forged personal metadata, nonexistent teams and another user session', async () => {
    const f = await setup()
    const api = { ...f.owner.principal, organization: f.ownerCtx.principal.organization }
    await expectDenied(listTeamAdminBookings, testContext(db, api))
    await expectDenied(
      listTeamAdminBookings,
      testContext(db, {
        ...api,
        kind: 'oauth',
        oauthConsentId: randomUUID(),
        clientId: 'synthetic',
        scopes: [],
      }),
    )
    const personal = await session(f.owner)
    personal.principal.organization.personal = false
    await expectDenied(listTeamAdminBookings, personal)
    await expectDenied(listTeamAdminBookings, {
      ...f.ownerCtx,
      principal: {
        ...f.ownerCtx.principal,
        organization: { ...f.ownerCtx.principal.organization, id: randomUUID() },
      },
    })
    if (f.ownerCtx.principal.kind !== 'session' || f.adminCtx.principal.kind !== 'session')
      throw new Error('Missing session')
    await expectDenied(listTeamAdminBookings, {
      ...f.ownerCtx,
      principal: { ...f.ownerCtx.principal, sessionId: f.adminCtx.principal.sessionId },
    })
    for (const field of ['user', 'organization', 'session'] as const) {
      const principal = {
        ...f.ownerCtx.principal,
        ...(field === 'session'
          ? { sessionId: 'invalid' }
          : { [field]: { ...f.ownerCtx.principal[field], id: 'invalid' } }),
      }
      await expectDenied(listTeamAdminBookings, { ...f.ownerCtx, principal })
    }
  })

  it('accepts exact comma-separated current roles and ignores stale principal personal metadata', async () => {
    const f = await setup()
    await booking(f)
    await db
      .updateTable('auth.member')
      .set({ role: 'member, admin' })
      .where('userId', '=', f.admin.id)
      .where('organizationId', '=', f.team.id)
      .execute()
    f.adminCtx.principal.organization.personal = true
    expect((await listTeamAdminBookings(f.adminCtx)).data).toHaveLength(1)
    expect((await listHostBookings(f.adminCtx)).data).toEqual([])
  })

  async function verifyEventMetadata(list: List) {
    const f = await setup()
    const deleted = await booking(f)
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', f.eventId)
      .execute()
    const missing = await booking(f, '2026-11-02T10:00Z', { eventId: null })
    const other = await createTestTeam(db, [{ user: f.owner, role: 'owner' }])
    const otherEvent = await createFixtures(db).eventType(other.id, f.member.id, {
      title: 'private-only-foreign-event',
    })
    await expect(booking(f, '2026-11-02T11:00Z', { eventId: otherEvent })).rejects.toMatchObject({
      code: '23503',
    })
    const result = await list(f.ownerCtx)
    expect(result.data.map(({ id, eventType }) => ({ id, eventType }))).toEqual([
      { id: deleted, eventType: { id: f.eventId, title: null } },
      { id: missing, eventType: null },
    ])
  }

  it('keeps deleted event IDs with null titles, absent associations null and foreign metadata hidden', () =>
    verifyEventMetadata(listTeamAdminBookings))

  it('supports existing exact time/status filters and cancellation/reschedule state', async () => {
    const f = await setup()
    const first = await booking(f, '2026-11-02T09:00:00.000001Z', { status: 'cancelled' })
    const moved = await booking(f, '2026-11-02T10:00:00.000002Z', { rescheduledFromId: first })
    const cancelled = await booking(f, '2026-11-02T11:00:00.000003Z', { status: 'cancelled' })
    const ids = async (input: ListBookingsInput) =>
      (await listTeamAdminBookings(f.ownerCtx, input)).data.map((row) => row.id)
    expect(
      await ids({
        from: instant('2026-11-02T10:00:00.000002Z'),
        to: instant('2026-11-02T11:00:00.000003Z'),
      }),
    ).toEqual([moved])
    expect(
      await ids({
        endAfter: instant('2026-11-02T09:30:00.000001Z'),
        endTo: instant('2026-11-02T10:30:00.000002Z'),
      }),
    ).toEqual([moved])
    expect(await ids({ status: 'cancelled' })).toEqual([first, cancelled])
    expect(await ids({ status: 'confirmed' })).toEqual([moved])
    expect(
      (await listTeamAdminBookings(f.ownerCtx, { status: 'cancelled' })).data.every(
        (row) => row.cancelledAt === '2026-11-01T01:00:00.000Z',
      ),
    ).toBe(true)
    expect(
      (await listTeamAdminBookings(f.ownerCtx, { status: 'confirmed' })).data[0]?.cancelledAt,
    ).toBeNull()
    expect(await listTeamAdminBookings(f.ownerCtx, { from: instant('2027-01-01T00:00Z') })).toEqual(
      { data: [], nextCursor: null },
    )
  })

  it('reads real collective reschedule/cancel transitions with their saved inactive hosts', async () => {
    const f = await setup()
    const fixtures = createFixtures(db)
    for (const user of [f.member, f.host]) await fixtures.schedule(user.id, { timeZone: 'UTC' })
    const event = await createEventType(f.ownerCtx, {
      slug: 'collective',
      title: 'Collective consultation',
      durationMinutes: 30,
      schedulingType: 'collective',
      hosts: [{ userId: f.member.id }, { userId: f.host.id }],
    })
    const original = await createPublicTeamBooking(
      { db, now },
      {
        handle: f.ownerCtx.principal.organization.slug,
        slug: event.slug,
        start: instant('2026-11-02T09:00Z'),
        invitee: { name: 'Booker', email: 'booker@example.com', timeZone: 'UTC' },
      },
    )
    const hostCtx = await session(f.member, f.memberCtx.principal.organization)
    const successor = await rescheduleHostBooking(hostCtx, original.booking.id, {
      start: instant('2026-11-02T10:00Z'),
    })
    await cancelHostBooking(hostCtx, successor.booking.id, {
      reason: 'private-only-cancellation-reason',
    })
    const result = await listTeamAdminBookings(f.adminCtx)
    expect(result.data.map(({ id, status, start }) => ({ id, status, start }))).toEqual([
      { id: original.booking.id, status: 'cancelled', start: '2026-11-02T09:00:00.000Z' },
      { id: successor.booking.id, status: 'cancelled', start: '2026-11-02T10:00:00.000Z' },
    ])
    for (const row of result.data) {
      expect(row.cancelledAt).toBe('2026-11-01T00:00:00.000Z')
      expect(row.hosts.map((host) => host.userId).sort()).toEqual([f.member.id, f.host.id].sort())
    }
    expect(JSON.stringify(result).includes('private-only-')).toBe(false)
  })

  it.each<[ListBookingsInput, string]>([
    [{ limit: 0 }, 'invalid_limit'],
    [{ limit: 101 }, 'invalid_limit'],
    [{ limit: 1.5 }, 'invalid_limit'],
    [{ order: 'sideways' as 'asc' }, 'invalid_order'],
    [{ from: instant('2026-11-02T09:00Z'), to: instant('2026-11-02T09:00Z') }, 'invalid_range'],
    [
      { endAfter: instant('2026-11-02T09:00Z'), endTo: instant('2026-11-02T08:00Z') },
      'invalid_range',
    ],
    [{ cursor: 'invalid' }, 'invalid_cursor'],
    [
      {
        cursor: Buffer.from(JSON.stringify(['2026-11-02T09:00Z', 'invalid'])).toString('base64url'),
      },
      'invalid_cursor',
    ],
    [
      {
        cursor: Buffer.from(JSON.stringify(['+010000-01-01T00:00Z', randomUUID()])).toString(
          'base64url',
        ),
      },
      'invalid_cursor',
    ],
  ])('retains existing pagination validation (%s)', async (input, code) => {
    const f = await setup()
    await expect(listTeamAdminBookings(f.ownerCtx, input)).rejects.toMatchObject({
      kind: 'invalid',
      code,
    })
  })

  it('passes unmodified source-copy assertions', async () => {
    const copy = sourceCopy()
    await verifyIsolation(copy)
    await verifyCollective(copy)
    await verifyWhitelist(copy)
    await verifyEventMetadata(copy)
    await verifyCursor(copy, 'asc')
    await verifyCursor(copy, 'desc')
  })

  const authorizationMutations: [string, Replacement, (f: Fixture) => Promise<ServiceContext>][] = [
    ...(['user', 'organization', 'session'] as const).map(
      (field): [string, Replacement, (f: Fixture) => Promise<ServiceContext>] => [
        `valid ${field} UUID`,
        [`!isUuid(principal.${field === 'session' ? 'sessionId' : `${field}.id`})`, 'false'],
        async (f) => ({
          ...f.ownerCtx,
          principal: {
            ...f.ownerCtx.principal,
            ...(field === 'session'
              ? { sessionId: 'invalid' }
              : { [field]: { ...f.ownerCtx.principal[field], id: 'invalid' } }),
          },
        }),
      ],
    ),
    [
      'current session identity',
      [".where('session.id', '=', principal.sessionId)", ''],
      async (f) => ({
        ...f.ownerCtx,
        principal: { ...f.ownerCtx.principal, sessionId: randomUUID() } as Principal,
      }),
    ],
    [
      'session-only entry',
      ["principal.kind !== 'session' ||", 'false ||'],
      async (f) => ({
        ...f.ownerCtx,
        principal: {
          ...f.ownerCtx.principal,
          kind: 'api_key',
          apiKeyId: randomUUID(),
        } as Principal,
      }),
    ],
    [
      'current verified user',
      [".where('user.emailVerified', '=', true)", ''],
      async (f) => {
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', f.owner.id)
          .execute()
        return f.ownerCtx
      },
    ],
    [
      'current session expiry',
      [".where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)", ''],
      async (f) => {
        if (f.ownerCtx.principal.kind !== 'session') throw new Error('Missing session')
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', f.ownerCtx.principal.sessionId)
          .execute()
        return f.ownerCtx
      },
    ],
    [
      'session user binding',
      [".where('session.userId', '=', principal.user.id)", ''],
      async (f) => {
        if (f.ownerCtx.principal.kind !== 'session' || f.adminCtx.principal.kind !== 'session')
          throw new Error('Missing session')
        return {
          ...f.ownerCtx,
          principal: { ...f.ownerCtx.principal, sessionId: f.adminCtx.principal.sessionId },
        }
      },
    ],
    [
      'current team binding',
      [".where('organization.id', '=', principal.organization.id)", ''],
      async (f) => ({
        ...f.ownerCtx,
        principal: {
          ...f.ownerCtx.principal,
          organization: { ...f.ownerCtx.principal.organization, id: randomUUID() },
        },
      }),
    ],
    [
      'personal organization exclusion',
      [
        ".whereRef('organization_id', '=', 'organization.id')",
        ".where('organization_id', '=', randomPersonalId)",
      ],
      async (f) => {
        const ctx = await session(f.owner)
        ctx.principal.organization.personal = false
        return ctx
      },
    ],
    [
      'current owner/admin role',
      ["(!roles.includes('owner') && !roles.includes('admin'))", 'false'],
      async (f) => f.memberCtx,
    ],
  ]

  it.each(authorizationMutations)(
    'detects removal of %s with a real assertion failure',
    async (_, replacement, context) => {
      // A false UUID keeps the personal-scope probe executable while disabling only that guard.
      const adjusted: Replacement = [
        replacement[0],
        replacement[1].replace('randomPersonalId', "'00000000-0000-0000-0000-000000000000'"),
      ]
      const copy = sourceCopy(adjusted)
      const f = await setup()
      const ctx = await context(f)
      await expect(expectDenied(copy, ctx)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each<[string, Replacement, (copy: List) => Promise<void>]>([
    ['team booking isolation', [".where('b.organization_id', '=', teamId)", ''], verifyIsolation],
    [
      'deleted event title suppression',
      ['CASE WHEN event.deleted_at IS NULL THEN event.title ELSE NULL END', 'event.title'],
      verifyEventMetadata,
    ],
    [
      'collective row cardinality',
      [
        'const { query, limit } = bookingPageQuery(ctx.db, input)',
        "const { query: baseQuery, limit } = bookingPageQuery(ctx.db, input)\n const query = baseQuery.innerJoin('booking_hosts as duplicate', 'duplicate.booking_id', 'b.id')",
      ],
      verifyCollective,
    ],
    [
      'explicit mapper boundary',
      ['toTeamAdminBooking({\n        id: row.id,', '({\n        ...row,\n        id: row.id,'],
      verifyWhitelist,
    ],
  ])('detects broken %s with a real assertion failure', async (_, replacement, verify) => {
    const copy = sourceCopy(replacement)
    await expect(verify(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each(['asc', 'desc'] as const)(
    'detects %s cursor precision loss with a real assertion failure',
    async (order) => {
      const copy = sourceCopy(undefined, [
        '[row.cursor_start, row.id]',
        '[new Date(row.cursor_start).toISOString(), row.id]',
      ])
      await expect(verifyCursor(copy, order)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
