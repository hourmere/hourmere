import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { leaveTeamMember, MemberDepartureImpactSchema } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signTestMcpAccessToken } from '../../../../packages/auth/src/testing.ts'
import { createApp } from '../app.ts'
import { ErrorBody, json, serviceContext } from '../openapi.ts'
import { productRoutes } from '../server.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextWriteLock,
  teamManagementSessionCaller,
} from '../team-management.ts'
import { DepartureImpact } from './member-departure-impact.ts'
import { memberLeaveRoutes } from './member-leave.ts'
import { openApiDocument, resolve, responseAndRequestStrictness } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4391'
const secret = 'synthetic-leave-access-secret-0000000000000000000'
const path = '/api/v1/teams/{teamId}/leave'
const denied = { error: 'team_management_access_denied' }
type Replacement = readonly [string, string]

/** Compile disposable source copies so mutations never change the checked-in route. */
function routeCopy(
  replacement?: Replacement,
  sessionCaller = teamManagementSessionCaller,
): typeof memberLeaveRoutes {
  let source = readFileSync('apps/server/src/routes/member-leave.ts', 'utf8')
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
    MemberDepartureBlockedError,
    MemberDepartureOwnerRequiredError,
    leaveTeamMember,
    MemberDepartureImpactSchema,
    ErrorBody,
    json,
    serviceContext,
    EXPECTED_ORGANIZATION_HEADER,
    organizationContextWriteLock,
    teamManagementSessionCaller: sessionCaller,
    DepartureImpact,
  }
  return new Function(...Object.keys(bindings), `${source}; return memberLeaveRoutes`)(
    ...Object.values(bindings),
  ) as typeof memberLeaveRoutes
}

function sessionCallerCopy(replacement?: Replacement): typeof teamManagementSessionCaller {
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
    `${source}; return teamManagementSessionCaller`,
  )(DomainError, createMiddleware) as typeof teamManagementSessionCaller
}

describe.skipIf(!serverUrl)('team leave session boundary', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let resolveCaller: ReturnType<typeof createCallerResolver>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'leave_access' })
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

  function application(factory = memberLeaveRoutes, resolved = () => {}, production = false) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: (headers) => {
        resolved()
        return resolveCaller(headers)
      },
      routes: production ? productRoutes({ db, socialProviders: {} }) : [factory({ db })],
    })
  }

  async function session(user: TestUser, organizationId: string, expired = false) {
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + (expired ? -3_600_000 : 3_600_000)),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

  async function fixture(role = 'member') {
    const actor = await createTestUser(db, 'Departing team member')
    const survivor = await createTestUser(db, 'Continuing team owner')
    const team = await createTestTeam(db, [
      { user: actor, role },
      { user: survivor, role: 'owner' },
    ])
    const cookie = await session(actor, team.id)
    return { actor, team, cookie }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function leave(
    f: Fixture,
    app = application(),
    headers: Record<string, string> = { cookie: f.cookie },
    teamId = f.team.id,
  ) {
    return app.request(`/api/v1/teams/${teamId}/leave`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-expected-organization-id': teamId,
        ...headers,
      },
      body: '{}',
    })
  }

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
    expect(response.headers.has('www-authenticate')).toBe(false)
  }

  async function credentials(f: Fixture) {
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const keyCaller = await resolveCaller(new Headers({ authorization: `Bearer ${key.key}` }))
    expect(keyCaller.ok && keyCaller.principal.kind === 'api_key').toBe(true)
    const clientId = `https://leave.example/${randomUUID()}.json`
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: f.actor.id, organization_id: f.team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthClient')
      .values({ clientId, redirectUris: JSON.stringify(['https://leave.example/callback']) })
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
    const oauth = await signTestMcpAccessToken(auth, {
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
    const oauthCaller = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
      new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${oauth}` } }),
    )
    expect(oauthCaller.ok && oauthCaller.principal.kind === 'oauth').toBe(true)
    return [`Bearer ${key.key}`, `Bearer ${oauth}`]
  }

  it.each(['member', 'admin', 'owner'])(
    'lets a current %s session reach the locked departure service',
    async (role) => {
      const f = await fixture(role)
      const response = await leave(f)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ organizationId: f.actor.principal.organization.id })
    },
  )

  it('uniformly refuses missing, invalid and expired sessions without a challenge', async () => {
    const f = await fixture()
    const expired = await session(f.actor, f.team.id, true)
    for (const teamId of [f.team.id, randomUUID()]) {
      for (const cookie of [undefined, 'better-auth.session_token=invalid', expired]) {
        await expectDenied(
          await leave(f, application(), cookie === undefined ? {} : { cookie }, teamId),
        )
      }
    }
  })

  it('rejects every present Authorization header before resolving credentials', async () => {
    const f = await fixture('owner')
    let resolutions = 0
    const app = application(memberLeaveRoutes, () => {
      resolutions++
    })
    const authorizations = [
      ...(await credentials(f)),
      '',
      'Bearer invalid',
      'Bearer',
      'Basic synthetic',
      'DPoP synthetic',
    ]
    for (const teamId of [f.team.id, randomUUID()]) {
      for (const authorization of authorizations) {
        for (const cookie of [undefined, f.cookie]) {
          await expectDenied(
            await leave(
              f,
              app,
              { authorization, ...(cookie === undefined ? {} : { cookie }) },
              teamId,
            ),
          )
        }
      }
    }
    expect(resolutions).toBe(0)
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('userId', '=', f.actor.id)
        .where('organizationId', '=', f.team.id)
        .executeTakeFirst(),
    ).toBeDefined()
  })

  it('publishes the session boundary and owner handling as open additive responses', async () => {
    const document = await openApiDocument(application(memberLeaveRoutes, undefined, true))
    const route = document.paths[path]?.post
    expect(route?.security).toEqual([{ session: [] }])
    expect(Object.keys(route?.responses ?? {})).toEqual(['200', '400', '403', '409'])
    expect(responseAndRequestStrictness(document, [path])).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    const conflict = resolve(
      document,
      route?.responses['409']?.content?.['application/json']?.schema ?? {},
    )
    const parts = (conflict.allOf as Record<string, unknown>[] | undefined) ?? [conflict]
    const properties = Object.assign(
      {},
      ...parts.map((part) => resolve(document, part).properties),
    ) as Record<string, Record<string, unknown>>
    const handling = resolve(document, properties.handling ?? {})
    expect((handling.properties as Record<string, unknown>).owner).toMatchObject({
      type: 'string',
      enum: ['another_owner_is_needed_before_you_can_leave'],
    })
  })

  async function verifySessionBoundary(factory: typeof memberLeaveRoutes) {
    const f = await fixture()
    let resolutions = 0
    const app = application(factory, () => {
      resolutions++
    })
    await expectDenied(await leave(f, app, {}))
    expect(resolutions).toBe(1)
    resolutions = 0
    await expectDenied(await leave(f, app, { cookie: f.cookie, authorization: '' }))
    expect(resolutions).toBe(0)
  }

  it('passes the HTTP session assertions with unmodified source copies', async () => {
    await verifySessionBoundary(routeCopy(undefined, sessionCallerCopy()))
  })

  it('detects bypassing the session-only route middleware with a real assertion', async () => {
    await expect(
      verifySessionBoundary(
        routeCopy(['middleware: teamManagementSessionCaller(caller),', 'middleware: caller,']),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError', actual: 401, expected: 403 })
  })

  it.each<Replacement>([
    ["if (c.req.raw.headers.has('authorization')) throw denied()", ''],
    ['if (response instanceof Response && response.status === 401) {', 'if (false) {'],
    ["c.header('WWW-Authenticate', undefined)", ''],
  ])('detects weakening the shared session boundary: %s', async (before, after) => {
    await expect(
      verifySessionBoundary(routeCopy(undefined, sessionCallerCopy([before, after]))),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
