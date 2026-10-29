import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  checkTeamManagementAccess,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
  TeamManagementError,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  cancelTeamAdminBooking,
  listTeamAdminBookings,
  type TeamAdminBookingPage,
  TeamAdminBookingPageSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { ErrorBody, errorResponses, json, type RouteModule, serviceContext } from '../openapi.ts'
import { productRoutes } from '../server.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  teamManagementAccess,
} from '../team-management.ts'
import { CancelBody, ListBookingsQuery } from './bookings.ts'
import { teamBookingRoutes } from './team-bookings.ts'
import { openApiDocument, resolve, responseAndRequestStrictness } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const secret = 'synthetic-team-booking-session-secret-000000000000'
const path = '/api/v1/team/bookings'
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const denied = { error: 'team_management_access_denied' }
// Resolve the signer from the auth workspace, which owns the MCP token dependency.
const { signJWT } = createRequire(import.meta.resolve('@hourmere/auth'))('better-auth/plugins/jwt')

describe.skipIf(!serverUrl)('team administrator booking routes', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>
  let resolveCaller: ReturnType<typeof createCallerResolver>
  let seeded: Awaited<ReturnType<typeof bookingsFixture>>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // A single shared auth pool keeps this file far below CI's 100-connection limit.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
    })
    resolveCaller = createCallerResolver({ auth, db })
    app = application()
    seeded = await bookingsFixture()
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function application(
    routes: RouteModule[] = [teamBookingRoutes({ db, now: () => NOW })],
    afterResolve?: () => Promise<void>,
  ) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const result = await resolveCaller(headers)
        if (result.ok) await afterResolve?.()
        return result
      },
      routes,
    })
  }

  async function session(user: TestUser, organizationId: string) {
    const token = randomBytes(24).toString('base64url')
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      sessionId: row.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function managerFixture(role = 'admin', personal = false) {
    const user = await createTestUser(db, 'Team manager')
    const team = personal
      ? { id: user.principal.organization.id }
      : await createTestTeam(db, [{ user, role }])
    return { user, team, ...(await session(user, team.id)) }
  }

  async function bookingsFixture() {
    const owner = await createTestUser(db, 'Team owner')
    const admin = await createTestUser(db, 'Team admin')
    const member = await createTestUser(db, 'Team member')
    const hosts = await Promise.all([
      createTestUser(db, 'Saved host A'),
      createTestUser(db, 'Saved host B'),
    ])
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
      ...hosts.map((user) => ({ user, role: 'member' })),
    ])
    const other = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: hosts[0] as TestUser, role: 'member' },
    ])
    const f = createFixtures(db)
    const eventId = await f.eventType(team.id, null, {
      title: 'Team consultation',
      hosts: hosts.map((user) => ({ userId: user.id })),
    })
    const predecessor = await f.booking(
      team.id,
      [hosts[0]?.id as string],
      '2026-11-04T09:00:00Z',
      '2026-11-04T09:30:00Z',
      { eventTypeId: eventId, status: 'cancelled' },
    )
    const successor = await f.booking(
      team.id,
      [hosts[0]?.id as string],
      '2026-11-04T10:00:00Z',
      '2026-11-04T10:30:00Z',
      { eventTypeId: eventId },
    )
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: predecessor })
      .where('id', '=', successor)
      .execute()
    const collective = await f.booking(
      team.id,
      hosts.map((user) => user.id),
      '2026-11-04T11:00:00Z',
      '2026-11-04T11:30:00Z',
      { eventTypeId: eventId },
    )
    await db
      .updateTable('bookings')
      .set({
        title: 'private-only-booking-title',
        location: JSON.stringify({ kind: 'link', url: 'https://private-only.example/meeting' }),
        responses: JSON.stringify({ notes: 'private-only-answer' }),
        cancel_reason: 'private-only-cancellation-reason',
        cancelled_at: '2026-11-01T12:00:00Z',
      })
      .where('id', '=', predecessor)
      .execute()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: collective,
        name: 'Guest',
        email: 'guest@example.com',
        time_zone: 'Asia/Shanghai',
        locale: 'zh-CN',
        is_booker: false,
      })
      .execute()
    const otherBooking = await f.booking(
      other.id,
      [hosts[0]?.id as string],
      '2026-11-05T09:00:00Z',
      '2026-11-05T09:30:00Z',
    )
    const personalBooking = await f.booking(
      owner.principal.organization.id,
      [owner.id],
      '2026-11-05T10:00:00Z',
      '2026-11-05T10:30:00Z',
    )
    return {
      owner,
      admin,
      member,
      hosts,
      team,
      other,
      eventId,
      ids: [predecessor, successor, collective],
      otherBooking,
      personalBooking,
      ownerSession: await session(owner, team.id),
      adminSession: await session(admin, team.id),
      memberSession: await session(member, team.id),
    }
  }

  function get(
    cookie?: string,
    query = '',
    extraHeaders: Record<string, string> = {},
    target = app,
  ) {
    return target.request(`${path}${query}`, {
      headers: { ...(cookie && { cookie }), ...extraHeaders },
    })
  }

  async function page(response: Response): Promise<TeamAdminBookingPage> {
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return TeamAdminBookingPageSchema.parse(await response.json())
  }

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
  }

  it('uniformly denies missing sessions and invalid bearer credentials despite a valid cookie', async () => {
    for (const response of [
      await get(),
      await get('better-auth.session_token=invalid'),
      await get(seeded.ownerSession.cookie, '', { authorization: 'Bearer invalid' }),
    ]) {
      await expectDenied(response)
      expect(response.headers.has('www-authenticate')).toBe(false)
    }
  })

  it('lets both owners and admins read bookings they do not host in only their current team', async () => {
    for (const cookie of [seeded.ownerSession.cookie, seeded.adminSession.cookie]) {
      const result = await page(await get(cookie))
      expect(result.data.map((booking) => booking.id)).toEqual(seeded.ids)
      expect(result.nextCursor).toBeNull()
      expect(
        result.data.every((booking) => booking.hosts.every((h) => h.userId !== seeded.owner.id)),
      ).toBe(true)
    }
    const otherSession = await session(seeded.owner, seeded.other.id)
    const otherPage = await page(await get(otherSession.cookie))
    expect(otherPage.data.map((booking) => booking.id)).toEqual([seeded.otherBooking])
    // A client-supplied organization cannot replace the active session's team.
    expect(
      (
        await page(await get(seeded.ownerSession.cookie, `?organizationId=${seeded.other.id}`))
      ).data.map((booking) => booking.id),
    ).toEqual(seeded.ids)
    const personalSession = await session(seeded.owner, seeded.owner.principal.organization.id)
    await expectDenied(await get(personalSession.cookie))
  })

  it('returns only the strict team DTO with saved hosts and permitted attendee fields', async () => {
    const result = await page(await get(seeded.ownerSession.cookie))
    const first = result.data[0]
    expect(first).toEqual({
      id: seeded.ids[0],
      status: 'cancelled',
      start: '2026-11-04T09:00:00.000Z',
      end: '2026-11-04T09:30:00.000Z',
      cancelledAt: '2026-11-01T12:00:00.000Z',
      eventType: { id: seeded.eventId, title: 'Team consultation' },
      hosts: [{ userId: seeded.hosts[0]?.id, name: 'Saved host A' }],
      attendees: [
        { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC', isBooker: true },
      ],
    })
    expect(JSON.stringify(result).includes('private-only')).toBe(false)
    const collective = result.data[2]
    expect(collective?.hosts.map((host) => host.userId).sort()).toEqual(
      seeded.hosts.map((host) => host.id).sort(),
    )
    expect(collective?.attendees).toEqual([
      { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC', isBooker: true },
      { name: 'Guest', email: 'guest@example.com', timeZone: 'Asia/Shanghai', isBooker: false },
    ])
  })

  it('returns the shared denial for ordinary members and personal-organization owners', async () => {
    await expectDenied(await get(seeded.memberSession.cookie))
    const f = await managerFixture('owner', true)
    await expectDenied(await get(f.cookie))
  })

  it('refuses a valid team API key, including when accompanied by a valid owner session', async () => {
    const key = await auth.api.createApiKey({
      body: { userId: seeded.owner.id, metadata: { organizationId: seeded.team.id } },
    })
    for (const cookie of [undefined, seeded.ownerSession.cookie]) {
      await expectDenied(await get(cookie, '', { authorization: `Bearer ${key.key}` }))
    }
  })

  it.each(['', 'Basic invalid', 'Bearer', 'Bearer invalid', 'Bearer hm_invalid'])(
    'does not grant session privileges when Authorization is %j',
    async (authorization) => {
      await expectDenied(await get(seeded.ownerSession.cookie, '', { authorization }))
    },
  )

  it('denies a real MCP OAuth token with and without an owner cookie', async () => {
    const clientId = 'https://team-boundary.example/client.json'
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://team-boundary.example/callback']),
      })
      .execute()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: seeded.owner.id, organization_id: seeded.team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: seeded.owner.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const value = await signJWT(
      { context: await auth.$context },
      {
        header: { typ: 'at+jwt' },
        payload: {
          sub: seeded.owner.id,
          client_id: clientId,
          scope: 'mcp:tools',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: `${origin}/api/auth`,
          aud: `${origin}/mcp`,
          'https://hourmere.com/organization': seeded.team.id,
          'https://hourmere.com/grant': grant.id,
        },
      },
    )
    const headers = { authorization: `Bearer ${value}` }
    // Prove this is a usable grant, rather than testing another invalid bearer string.
    const resolved = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
      new Request(`${origin}/mcp`, { headers }),
    )
    expect(resolved.ok).toBe(true)
    for (const cookie of [undefined, seeded.ownerSession.cookie]) {
      await expectDenied(await get(cookie, '', headers))
    }
  })

  it('does not distinguish another organization from a nonexistent active team', async () => {
    const outsider = await createTestUser(db, 'Other organization member')
    await createTestTeam(db, [{ user: outsider, role: 'owner' }])
    for (const teamId of [seeded.team.id, randomUUID()]) {
      const outsiderSession = await session(outsider, teamId)
      for (const query of ['', '?limit=0']) {
        await expectDenied(await get(outsiderSession.cookie, query))
      }
    }
  })

  it.each(['demotion', 'removal', 'unverified'] as const)(
    'checks current database eligibility after %s in the same browser session',
    async (change) => {
      const f = await managerFixture()
      expect((await get(f.cookie)).status).toBe(200)
      if (change === 'unverified') {
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', f.user.id)
          .execute()
      } else if (change === 'demotion') {
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('userId', '=', f.user.id)
          .where('organizationId', '=', f.team.id)
          .execute()
      } else {
        await db
          .deleteFrom('auth.member')
          .where('userId', '=', f.user.id)
          .where('organizationId', '=', f.team.id)
          .execute()
      }
      await expectDenied(await get(f.cookie))
    },
  )

  it.each(['deleted', 'expired'] as const)(
    'refuses a %s session even if invalidation happens after the real caller resolver',
    async (change) => {
      const f = await managerFixture()
      const guarded = application(undefined, async () => {
        if (change === 'deleted') {
          await db.deleteFrom('auth.session').where('id', '=', f.sessionId).execute()
        } else {
          await db
            .updateTable('auth.session')
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where('id', '=', f.sessionId)
            .execute()
        }
      })
      await expectDenied(await get(f.cookie, '', {}, guarded))
    },
  )

  const requestSources: Record<string, string>[] = [
    {},
    { origin },
    { referer: `${origin}/app/bookings` },
    { origin: 'https://other.example' },
    { referer: 'https://other.example/bookings' },
    { origin: 'null' },
  ]
  it.each(requestSources)(
    'preserves requireCaller safe-method Origin/Referer behavior for GET: %j',
    async (headers) => {
      expect((await get(seeded.adminSession.cookie, '', headers)).status).toBe(200)
    },
  )

  it('keeps collective bookings unique across ascending and descending page boundaries', async () => {
    for (const order of ['asc', 'desc']) {
      const ids: string[] = []
      let cursor: string | null = null
      for (let index = 0; index < seeded.ids.length; index++) {
        const query = new URLSearchParams({ order, limit: '1', ...(cursor && { cursor }) })
        const result = await page(await get(seeded.ownerSession.cookie, `?${query}`))
        ids.push(...result.data.map((booking) => booking.id))
        cursor = result.nextCursor
      }
      expect(ids).toEqual(order === 'asc' ? seeded.ids : seeded.ids.toReversed())
      expect(cursor).toBeNull()
      expect(new Set(ids).size).toBe(seeded.ids.length)
    }
  })

  it('uses keyset cursors so inserting an earlier booking does not shift the next page', async () => {
    const f = await bookingsFixture()
    const first = await page(await get(f.adminSession.cookie, '?limit=1'))
    expect(first.data.map((booking) => booking.id)).toEqual(f.ids.slice(0, 1))
    expect(first.nextCursor).not.toBeNull()
    await createFixtures(db).booking(
      f.team.id,
      [f.hosts[0]?.id as string],
      '2026-11-04T08:00:00Z',
      '2026-11-04T08:30:00Z',
    )
    const query = new URLSearchParams({ limit: '1', cursor: first.nextCursor as string })
    const second = await page(await get(f.adminSession.cookie, `?${query}`))
    expect(second.data.map((booking) => booking.id)).toEqual(f.ids.slice(1, 2))
    const last = await page(
      await get(
        f.adminSession.cookie,
        `?${new URLSearchParams({ limit: '1', cursor: second.nextCursor as string })}`,
      ),
    )
    expect(last.data.map((booking) => booking.id)).toEqual(f.ids.slice(2))
    expect(last.nextCursor).toBeNull()
  })

  it('reuses status/start/end boundaries and keeps reschedule predecessors cancelled', async () => {
    const ids = async (query: string) =>
      (await page(await get(seeded.adminSession.cookie, query))).data.map((booking) => booking.id)
    expect(await ids('?status=cancelled')).toEqual(seeded.ids.slice(0, 1))
    expect(await ids('?status=confirmed')).toEqual(seeded.ids.slice(1))
    expect(await ids('?from=2026-11-04T10:00:00Z&to=2026-11-04T11:00:00Z')).toEqual(
      seeded.ids.slice(1, 2),
    )
    expect(await ids('?from=2026-11-04T10:00:00.000001Z')).toEqual(seeded.ids.slice(2))
    expect(await ids('?endAfter=2026-11-04T09:30:00Z&endTo=2026-11-04T10:30:00Z')).toEqual(
      seeded.ids.slice(1, 2),
    )
    expect(await ids('?endTo=2026-11-04T10:29:59.999999Z')).toEqual(seeded.ids.slice(0, 1))
  })

  it.each([
    ['?limit=0', 'invalid_request'],
    ['?limit=101', 'invalid_request'],
    ['?status=pending', 'invalid_request'],
    ['?order=newest', 'invalid_request'],
    ['?from=invalid', 'invalid_request'],
    ['?endTo=2026-11-04T10:00:00.1234567890Z', 'invalid_request'],
    ['?cursor=invalid', 'invalid_cursor'],
    ['?from=2026-11-05T00:00:00Z&to=2026-11-04T00:00:00Z', 'invalid_range'],
    ['?endAfter=2026-11-04T10:30:00Z&endTo=2026-11-04T10:30:00Z', 'invalid_range'],
  ])('rejects invalid list parameters %s with %s', async (query, error) => {
    const response = await get(seeded.ownerSession.cookie, query)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error })
  })

  it('registers the production route as session-only with an extensible whitelist in OpenAPI', async () => {
    const production = application(productRoutes({ db, socialProviders: {} }))
    expect(
      (await page(await get(seeded.ownerSession.cookie, '', {}, production))).data.map(
        (booking) => booking.id,
      ),
    ).toEqual(seeded.ids)
    const document = await openApiDocument(production)
    const operation = document.paths[path]?.get
    expect(operation?.security).toEqual([{ session: [] }])
    const description = (operation as { description?: string } | undefined)?.description
    expect(description).toContain('Any Authorization header')
    expect(description).toContain('even with a valid session cookie')
    expect(operation?.responses['401']).toBeUndefined()
    const schema = operation?.responses['200']?.content?.['application/json']?.schema
    expect(schema).toBeDefined()
    const envelope = resolve(document, schema as Record<string, unknown>)
    expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
    expect(Object.keys(envelope.properties as object).sort()).toEqual(['data', 'nextCursor'])
    const data = (envelope.properties as Record<string, { items: Record<string, unknown> }>).data
    const item = resolve(document, data?.items as Record<string, unknown>)
    expect(Object.keys(item.properties as object).sort()).toEqual([
      'attendees',
      'cancelledAt',
      'end',
      'eventType',
      'hosts',
      'id',
      'start',
      'status',
    ])
  })

  function sourceCopy(
    removeAccess: boolean,
    accessObserved: () => void,
    replacement?: [string, string],
    managementFactory = teamManagementAccess,
  ): typeof teamBookingRoutes {
    let source = readFileSync('apps/server/src/routes/team-bookings.ts', 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
      source = source.replace(...replacement)
    }
    if (removeAccess) {
      const original = 'middleware: access.middleware,'
      expect(source.includes(original), 'mutation must match source').toBe(true)
      source = source.replace(original, 'middleware: caller,')
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const bindings = {
      createRoute,
      z,
      cancelTeamAdminBooking,
      listTeamAdminBookings,
      TeamAdminBookingPageSchema,
      TeamAdminBookingSchema,
      ErrorBody,
      errorResponses,
      json,
      serviceContext,
      CancelBody,
      ListBookingsQuery,
      EXPECTED_ORGANIZATION_HEADER,
      ORGANIZATION_CONTEXT_CHANGED,
      teamManagementAccess: (...args: Parameters<typeof teamManagementAccess>) => {
        const access = managementFactory(...args)
        const check = access.middleware[1]
        access.middleware[1] = async (c, next) => {
          accessObserved()
          return check(c, next)
        }
        return access
      },
    }
    return new Function(...Object.keys(bindings), `${source}; return teamBookingRoutes`)(
      ...Object.values(bindings),
    ) as typeof teamBookingRoutes
  }

  async function verifyAccess(factory: typeof teamBookingRoutes, observed: () => number) {
    const copy = application([factory({ db, now: () => NOW })])
    const result = await page(await get(seeded.ownerSession.cookie, '', {}, copy))
    expect(result.data.map((booking) => booking.id)).toEqual(seeded.ids)
    // The service can independently authorize the same user; the route must still execute
    // the shared access middleware, rather than merely declare session-only documentation.
    expect(observed()).toBe(1)
  }

  async function verifyOpenResponses(factory: typeof teamBookingRoutes) {
    const copy = application([factory({ db, now: () => NOW })])
    const document = await openApiDocument(copy)
    expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
  }

  function managementSourceCopy(replacement?: [string, string]): typeof teamManagementAccess {
    let source = readFileSync('apps/server/src/team-management.ts', 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
      source = source.replace(...replacement)
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    return new Function(
      'DomainError',
      'createMiddleware',
      'checkTeamManagementAccess',
      'TeamManagementError',
      'sql',
      `${source}; return teamManagementAccess`,
    )(
      DomainError,
      createMiddleware,
      checkTeamManagementAccess,
      TeamManagementError,
      sql,
    ) as typeof teamManagementAccess
  }

  async function verifySessionBoundary(managementFactory: typeof teamManagementAccess) {
    const factory = sourceCopy(false, () => {}, undefined, managementFactory)
    const copy = application([factory({ db, now: () => NOW })])
    expect((await get(seeded.ownerSession.cookie, '', {}, copy)).status).toBe(200)
    // A spent key must get the same denial as every other agent credential, without
    // exposing its validity or rate-limit state and without borrowing the owner cookie.
    const key = await auth.api.createApiKey({
      body: { userId: seeded.owner.id, metadata: { organizationId: seeded.team.id } },
    })
    await db
      .updateTable('auth.apikey')
      .set({ rateLimitEnabled: true, rateLimitMax: 1, requestCount: 1, lastRequest: new Date() })
      .where('id', '=', key.id)
      .execute()
    const headers = { authorization: `Bearer ${key.key}` }
    const resolved = await resolveCaller(new Headers(headers))
    expect(!resolved.ok && resolved.error === 'rate_limited').toBe(true)
    await expectDenied(await get(seeded.ownerSession.cookie, '', headers, copy))
    await expectDenied(await get(undefined, '', {}, copy))
  }

  it('passes session-boundary assertions for the unmodified shared access source copy', () =>
    verifySessionBoundary(managementSourceCopy()))

  it.each<[string, [string, string]]>([
    [
      'Authorization precedence',
      ["if (c.req.raw.headers.has('authorization')) throw denied()", ''],
    ],
    [
      'uniform unauthenticated denial',
      ['response instanceof Response && response.status === 401', 'false'],
    ],
  ])('detects removal of %s with a real HTTP assertion failure', async (_, replacement) => {
    const copy = managementSourceCopy(replacement)
    await expect(verifySessionBoundary(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('passes the extensible response assertion with an unmodified route source copy', async () => {
    await verifyOpenResponses(sourceCopy(false, () => {}))
  })

  it.each<[string, [string, string]]>([
    [
      'strict shared page schema',
      ['content: json(TeamAdminBookingPage)', 'content: json(TeamAdminBookingPageSchema)'],
    ],
    [
      'closed page',
      ['TeamAdminBookingPage = z\n  .object({', 'TeamAdminBookingPage = z\n  .strictObject({'],
    ],
    [
      'closed booking',
      ['TeamAdminBooking = z\n  .object({', 'TeamAdminBooking = z\n  .strictObject({'],
    ],
    ['closed event type', ['eventType: z.object(', 'eventType: z.strictObject(']],
    ['closed host', ['hosts: z.array(z.object(', 'hosts: z.array(z.strictObject(']],
    ['closed attendee', ['attendees: z.array(z.object(', 'attendees: z.array(z.strictObject(']],
  ])('detects publication of %s with a real assertion failure', async (_, replacement) => {
    // Compile before checking assertion errors so load errors cannot count as detection.
    const copy = sourceCopy(false, () => {}, replacement)
    await expect(verifyOpenResponses(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('passes the access assertion with an unmodified route source copy', async () => {
    let observed = 0
    const copy = sourceCopy(false, () => {
      observed++
    })
    await verifyAccess(copy, () => observed)
  })

  it('detects removal of route access middleware with a real assertion failure', async () => {
    let observed = 0
    // Compile before testing for assertion errors: load failures cannot count as detection.
    const copy = sourceCopy(true, () => {
      observed++
    })
    await expect(verifyAccess(copy, () => observed)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
