import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
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
  getTeamMemberDepartureImpact,
  MemberDepartureBookingSchema,
  MemberDepartureEventTypeSchema,
  MemberDepartureImpactSchema,
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
import { signTestMcpAccessToken } from '../../../../packages/auth/src/testing.ts'
import { createApp } from '../app.ts'
import { ErrorBody, json, type RouteModule, serviceContext } from '../openapi.ts'
import { productRoutes } from '../server.ts'
import { teamManagementAccess } from '../team-management.ts'
import { memberDepartureImpactRoutes } from './member-departure-impact.ts'
import { openApiDocument, responseAndRequestStrictness } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4391'
const secret = 'synthetic-departure-session-secret-000000000000000'
const path = '/api/v1/team/members/{memberUserId}/departure-impact'
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const denied = { error: 'team_management_access_denied' }

describe.skipIf(!serverUrl)('member departure impact route', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let resolveCaller: ReturnType<typeof createCallerResolver>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mcpOAuth: true,
      mailer: { send: async () => {} },
    })
    resolveCaller = createCallerResolver({ auth, db })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function application(
    routes: RouteModule[] = [memberDepartureImpactRoutes({ db, now })],
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

  async function session(user: TestUser, teamId: string) {
    const token = randomBytes(24).toString('base64url')
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: teamId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id: row.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(role = 'member') {
    const actor = await createTestUser(db, 'Departure actor')
    const target = await createTestUser(db, 'Departure target')
    const team = await createTestTeam(db, [
      { user: actor, role },
      { user: target, role: 'member' },
    ])
    const eventId = await createFixtures(db).eventType(team.id, null, {
      title: 'Team departure consultation',
      hosts: [{ userId: target.id }],
    })
    const login = await session(actor, team.id)
    return { actor, target, team, eventId, login }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function credentials(f: Fixture) {
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const apiKey = `Bearer ${key.key}`
    const resolvedKey = await resolveCaller(new Headers({ authorization: apiKey }))
    expect(resolvedKey.ok && resolvedKey.principal.kind === 'api_key').toBe(true)
    const clientId = `https://departure.example/${randomUUID()}.json`
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: f.actor.id, organization_id: f.team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthClient')
      .values({ clientId, redirectUris: JSON.stringify(['https://departure.example/callback']) })
      .execute()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: f.actor.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const token = await signTestMcpAccessToken(auth, {
      sub: f.actor.id,
      client_id: clientId,
      scope: 'mcp:tools',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `${origin}/api/auth`,
      aud: `${origin}/mcp`,
      'https://hourmere.com/organization': f.team.id,
      'https://hourmere.com/grant': grant.id,
    })
    const oauth = `Bearer ${token}`
    const resolvedOAuth = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
      new Request(`${origin}/mcp`, { headers: { authorization: oauth } }),
    )
    expect(resolvedOAuth.ok && resolvedOAuth.principal.kind === 'oauth').toBe(true)
    return [apiKey, oauth]
  }

  function get(
    f: Fixture,
    targetId = f.target.id,
    query: Record<string, string> = {},
    app = application(),
    headers: Record<string, string> = { cookie: f.login.cookie },
  ) {
    return app.request(
      `/api/v1/team/members/${targetId}/departure-impact?${new URLSearchParams({ teamId: f.team.id, ...query })}`,
      { headers },
    )
  }

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
    expect(response.headers.has('www-authenticate')).toBe(false)
  }

  it.each(['owner', 'admin', 'member, admin', 'member,owner'])(
    'allows current %s sessions to inspect another current member',
    async (role) => {
      const f = await fixture(role)
      const response = await get(f)
      expect(response.status).toBe(200)
      const body = MemberDepartureImpactSchema.parse(await response.json())
      expect(body.eventTypes.totalCount).toBe(1)
      expect(body.eventTypes.data.map((event) => event.id)).toEqual([f.eventId])
      expect(body.bookings.totalCount).toBe(0)
      expect(response.headers.get('cache-control')).toBe('no-store')
    },
  )

  it('lets an ordinary member read only their own impact', async () => {
    const f = await fixture()
    const self = await get(f, f.actor.id)
    expect(self.status).toBe(200)
    expect(MemberDepartureImpactSchema.parse(await self.json()).eventTypes.totalCount).toBe(0)
    const other = await get(f)
    expect(other.status).toBe(403)
    expect(await other.json()).toEqual(denied)
  })

  it('reports a single-host round-robin pool as having no remaining host', async () => {
    const f = await fixture('admin')
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'round_robin' })
      .where('id', '=', f.eventId)
      .execute()
    const first = await get(f)
    expect(first.status).toBe(200)
    expect(MemberDepartureImpactSchema.parse(await first.json()).eventTypes.data).toMatchObject([
      { id: f.eventId, reason: 'round_robin_pool_member', remainingHostCount: 0 },
    ])
    await db
      .insertInto('event_type_hosts')
      .values({ event_type_id: f.eventId, user_id: f.actor.id })
      .execute()
    const pooled = await get(f)
    expect(pooled.status).toBe(200)
    expect(MemberDepartureImpactSchema.parse(await pooled.json()).eventTypes.data).toMatchObject([
      { id: f.eventId, reason: 'round_robin_pool_member', remainingHostCount: 1 },
    ])
  })

  it.each(['superadmin', 'ownerish', 'admin-helper', 'unknown'])(
    'uniformly denies unknown or substring role %s',
    async (role) => {
      const f = await fixture(role)
      const response = await get(f, f.actor.id)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    },
  )

  it('uses one refusal for absent, foreign and removed targets', async () => {
    const f = await fixture('admin')
    const foreign = await createTestUser(db, 'Foreign member')
    await db
      .deleteFrom('auth.member')
      .where('userId', '=', f.target.id)
      .where('organizationId', '=', f.team.id)
      .execute()
    for (const target of [randomUUID(), foreign.id, f.target.id]) {
      const response = await get(f, target)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    }
  })

  it('requires authentication and refuses personal-space sessions', async () => {
    const f = await fixture('owner')
    const anonymous = await get(f, f.target.id, {}, application(), {})
    expect(anonymous.status).toBe(403)
    expect(await anonymous.json()).toEqual(denied)
    expect(anonymous.headers.has('www-authenticate')).toBe(false)
    const personal = await session(f.actor, f.actor.principal.organization.id)
    const response = await get(
      f,
      f.actor.id,
      { teamId: f.actor.principal.organization.id },
      application(),
      { cookie: personal.cookie },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
  })

  it('refuses valid team API keys even alongside an owner session', async () => {
    const f = await fixture('owner')
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    for (const cookie of [undefined, f.login.cookie]) {
      const headers: Record<string, string> = { authorization: `Bearer ${key.key}` }
      if (cookie) headers.cookie = cookie
      const response = await get(f, f.target.id, {}, application(), headers)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    }
  })

  it.each(['owner', 'admin', 'member'])(
    'keeps the %s own-impact read session-only with uniform team denials',
    async (role) => {
      const f = await fixture(role)
      const app = application()
      const self = await get(f, f.actor.id, {}, app)
      expect(self.status).toBe(200)
      expect(MemberDepartureImpactSchema.parse(await self.json()).eventTypes.totalCount).toBe(0)
      const authorizations = [
        ...(await credentials(f)),
        '',
        'Bearer invalid',
        'Bearer',
        'Basic synthetic',
        'DPoP synthetic',
      ]
      for (const teamId of [f.team.id, randomUUID()]) {
        for (const cookie of [undefined, 'better-auth.session_token=invalid'])
          await expectDenied(
            await get(f, f.actor.id, { teamId }, app, cookie === undefined ? {} : { cookie }),
          )
        for (const authorization of authorizations)
          for (const cookie of [undefined, f.login.cookie])
            await expectDenied(
              await get(f, f.actor.id, { teamId }, app, {
                authorization,
                ...(cookie === undefined ? {} : { cookie }),
              }),
            )
      }
    },
  )

  it.each(['role', 'membership', 'switch', 'verification', 'session'])(
    'rechecks current %s after caller resolution',
    async (change) => {
      const f = await fixture('admin')
      const app = application(undefined, async () => {
        if (change === 'role') {
          await db
            .updateTable('auth.member')
            .set({ role: 'member' })
            .where('userId', '=', f.actor.id)
            .where('organizationId', '=', f.team.id)
            .execute()
        } else if (change === 'membership') {
          await db
            .deleteFrom('auth.member')
            .where('userId', '=', f.actor.id)
            .where('organizationId', '=', f.team.id)
            .execute()
        } else if (change === 'switch') {
          await db
            .updateTable('auth.session')
            .set({ activeOrganizationId: f.actor.principal.organization.id })
            .where('id', '=', f.login.id)
            .execute()
        } else if (change === 'verification') {
          await db
            .updateTable('auth.user')
            .set({ emailVerified: false })
            .where('id', '=', f.actor.id)
            .execute()
        } else {
          await db.deleteFrom('auth.session').where('id', '=', f.login.id).execute()
        }
      })
      const response = await get(f, f.target.id, {}, app)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    },
  )

  it.each<Record<string, string>>([
    { eventTypesLimit: '0' },
    { bookingsLimit: '101' },
    { eventTypesLimit: '1.5' },
    { bookingsLimit: 'no' },
    { teamId: 'invalid' },
    { unexpected: 'field' },
  ])('validates query parameters %j', async (query) => {
    const f = await fixture('admin')
    const response = await get(f, f.target.id, query)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('registers the production route and both page parameters in OpenAPI', async () => {
    const f = await fixture('owner')
    const app = application(
      productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
    )
    const response = await get(f, f.target.id, {}, app)
    expect(response.status).toBe(200)
    const document = await openApiDocument(app)
    expect(document.paths[path]?.get?.security).toEqual([{ session: [] }])
    expect(Object.keys(document.paths[path]?.get?.responses ?? {})).toEqual([
      '200',
      '400',
      '403',
      '409',
    ])
    expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
    expect(document.components?.schemas?.MemberDepartureImpact).toMatchObject({
      properties: {
        eventTypes: {
          properties: {
            data: {
              items: {
                properties: { remainingHostCount: { type: 'integer', minimum: 0 } },
                required: expect.arrayContaining(['remainingHostCount']),
              },
            },
          },
        },
      },
    })
  })

  function sourceCopy(
    replacement?: [string, string],
    observe = () => {},
    managementFactory = teamManagementAccess,
  ) {
    let source = readFileSync('apps/server/src/routes/member-departure-impact.ts', 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
      source = source.replace(...replacement)
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const bindings = {
      createRoute,
      z,
      getTeamMemberDepartureImpact,
      MemberDepartureBookingSchema,
      MemberDepartureEventTypeSchema,
      MemberDepartureImpactSchema,
      TeamAdminBookingSchema,
      ErrorBody,
      json,
      serviceContext,
      teamManagementAccess: (...args: Parameters<typeof teamManagementAccess>) => {
        const access = managementFactory(...args)
        const check = access.memberReadMiddleware[1]
        access.memberReadMiddleware[1] = async (c, next) => {
          observe()
          return check(c, next)
        }
        return access
      },
    }
    return new Function(...Object.keys(bindings), `${source}; return memberDepartureImpactRoutes`)(
      ...Object.values(bindings),
    ) as typeof memberDepartureImpactRoutes
  }

  async function verifyOpen(factory: typeof memberDepartureImpactRoutes) {
    const document = await openApiDocument(application([factory({ db, now })]))
    expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
  }

  async function verifyRemainingHostSchema(factory: typeof memberDepartureImpactRoutes) {
    const document = await openApiDocument(application([factory({ db, now })]))
    expect(document.components?.schemas?.MemberDepartureImpact).toMatchObject({
      properties: {
        eventTypes: {
          properties: {
            data: {
              items: {
                properties: { remainingHostCount: { type: 'integer', minimum: 0 } },
                required: expect.arrayContaining(['remainingHostCount']),
              },
            },
          },
        },
      },
    })
  }

  it('passes the OpenAPI assertion with an unmodified source copy', async () => {
    await verifyOpen(sourceCopy())
    await verifyRemainingHostSchema(sourceCopy())
  })

  it('detects losing the additive remaining-host field from the published schema', async () => {
    const copy = sourceCopy([
      'const DepartureEventType = z.object(MemberDepartureEventTypeSchema.shape)',
      'const DepartureEventType = z.object(MemberDepartureEventTypeSchema.shape).omit({ remainingHostCount: true })',
    ])
    await expect(verifyRemainingHostSchema(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each<[string, [string, string]]>([
    [
      'strict internal schema',
      ['content: json(DepartureImpact)', 'content: json(MemberDepartureImpactSchema)'],
    ],
    ['envelope', ['DepartureImpact = z\n  .object({', 'DepartureImpact = z\n  .strictObject({']],
    ['event page', ['eventTypes: z.object({', 'eventTypes: z.strictObject({']],
    ['booking page', ['bookings: z.object({', 'bookings: z.strictObject({']],
    ['event item', ['DepartureEventType = z.object(', 'DepartureEventType = z.strictObject(']],
    ['booking item', ['DepartureBooking = z.object({', 'DepartureBooking = z.strictObject({']],
    ['booking event', ['eventType: z.object(', 'eventType: z.strictObject(']],
    ['booking host', ['hosts: z.array(z.object(', 'hosts: z.array(z.strictObject(']],
    ['booking attendee', ['attendees: z.array(z.object(', 'attendees: z.array(z.strictObject(']],
  ])('detects a closed published %s with a real assertion', async (_, replacement) => {
    const copy = sourceCopy(replacement)
    await expect(verifyOpen(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  async function verifyAccess(replacement?: [string, string]) {
    let observed = 0
    const factory = sourceCopy(replacement, () => {
      observed++
    })
    const f = await fixture('member')
    const response = await get(f, f.actor.id, {}, application([factory({ db, now })]))
    expect(response.status).toBe(200)
    expect(observed).toBe(1)
  }

  it('uses the shared member-read access middleware in an unmodified source copy', async () => {
    await verifyAccess()
  })

  it('detects bypassing the shared middleware with a real assertion', async () => {
    await expect(
      verifyAccess(['middleware: access.memberReadMiddleware,', 'middleware: caller,']),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

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

  async function verifyStalePreview(managementFactory: typeof teamManagementAccess) {
    const f = await fixture('member')
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.actor.principal.organization.id })
      .where('id', '=', f.login.id)
      .execute()
    const factory = sourceCopy(undefined, () => {}, managementFactory)
    const app = application([factory({ db, now })])
    const headers = { cookie: f.login.cookie, 'X-Expected-Organization-Id': f.team.id }
    const own = await get(f, f.actor.id, {}, app, headers)
    expect(own.status).toBe(409)
    expect(await own.json()).toMatchObject({ error: 'organization_context_changed' })
    await expectDenied(await get(f, f.target.id, {}, app, headers))
  }

  it('retains stale member recovery only for their own preview in an unchanged source copy', () =>
    verifyStalePreview(managementSourceCopy()))

  it.each([
    ['requiring management for self preview', 'false', 403, 409],
    ['allowing member recovery for another member preview', 'true', 409, 403],
  ] as const)('detects %s with a real HTTP assertion', async (_, replacement, actual, expected) => {
    const copy = managementSourceCopy([
      "c.req.param('memberUserId')?.toLowerCase() === c.var.principal.user.id.toLowerCase()",
      replacement,
    ])
    await expect(verifyStalePreview(copy)).rejects.toMatchObject({
      name: 'AssertionError',
      actual,
      expected,
    })
  })

  it.each(['missing session', 'invalid Authorization'])(
    'detects removal of the member-read session boundary for %s with a real HTTP assertion',
    async (credential) => {
      const f = await fixture('member')
      const baseline = managementSourceCopy()
      const mutated = managementSourceCopy([
        'memberReadMiddleware: [sessionCaller, memberRead]',
        'memberReadMiddleware: [caller, memberRead]',
      ])
      const verify = async (managementFactory: typeof teamManagementAccess) => {
        const factory = sourceCopy(undefined, () => {}, managementFactory)
        const app = application([factory({ db, now })])
        expect((await get(f, f.actor.id, {}, app)).status).toBe(200)
        const headers: Record<string, string> =
          credential === 'missing session'
            ? {}
            : { cookie: f.login.cookie, authorization: 'Bearer invalid' }
        await expectDenied(await get(f, f.actor.id, {}, app, headers))
      }
      await verify(baseline)
      await expect(verify(mutated)).rejects.toMatchObject({
        name: 'AssertionError',
        actual: 401,
        expected: 403,
      })
      await verify(baseline)
    },
  )
})
