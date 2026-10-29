import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  type checkTeamManagementAccess,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
  ensurePersonalOrganization,
  type Principal,
  type TeamManagementError,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  getSelfReadiness,
  getTeamReadiness,
  SelfReadinessPageSchema,
  TeamReadinessPageSchema,
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
import { ErrorBody, errorResponses, json, serviceContext } from '../openapi.ts'
import type { teamManagementAccess } from '../team-management.ts'
import { readinessRoutes } from './readiness.ts'
import { createTestApp, openApiDocument, productApp, type TestApp } from './test-app.ts'

const selfPath = '/api/v1/readiness/self'
const teamPath = (id: string) => `/api/v1/teams/${id}/readiness`
const denial = { error: 'team_management_access_denied' }

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)])
}

function sourceCopy<T>(
  path: string,
  bindings: Record<string, unknown>,
  name: string,
  mutation?: [string, string],
): T {
  let source = readFileSync(path, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0]), 'mutation must match source').toBe(true)
    source = source.replace(...mutation)
  }
  const script = stripTypeScriptTypes(
    source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${script}; return ${name}`)(
    ...Object.values(bindings),
  ) as T
}

function readRouteCopy(mutation?: [string, string], routeMutation?: [string, string]) {
  const sharedAccess = sourceCopy<{
    checkTeamManagementAccess: typeof checkTeamManagementAccess
    TeamManagementError: typeof TeamManagementError
  }>(
    'packages/auth/src/team-management.ts',
    { sql },
    '({ checkTeamManagementAccess, TeamManagementError })',
    mutation,
  )
  const access = sourceCopy<typeof teamManagementAccess>(
    'apps/server/src/team-management.ts',
    { DomainError, createMiddleware, ...sharedAccess },
    'teamManagementAccess',
  )
  return sourceCopy<typeof readinessRoutes>(
    'apps/server/src/routes/readiness.ts',
    {
      createRoute,
      z,
      getSelfReadiness,
      getTeamReadiness,
      SelfReadinessPageSchema,
      TeamReadinessPageSchema,
      DomainError,
      createMiddleware,
      ErrorBody,
      errorResponses,
      json,
      serviceContext,
      teamManagementAccess: access,
    },
    'readinessRoutes',
    routeMutation,
  )
}

describe('booking readiness OpenAPI', () => {
  it('documents both reads as web-session-only', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    for (const path of [selfPath, '/api/v1/teams/{teamId}/readiness'])
      expect(paths[path]?.get?.security).toEqual([{ session: [] }])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('booking readiness real authentication', () => {
  const origin = 'http://localhost:4392'
  const secret = 'synthetic-readiness-session-secret-0000000000000000'
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // Reuse one auth pool for this file, including OAuth signing and organization changes.
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
    app = application()
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function application(resolveCaller = createCallerResolver({ auth, db })) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller,
      routes: [readinessRoutes({ db })],
    })
  }

  async function session(user: TestUser, organizationId = user.principal.organization.id) {
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
      id: row.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  function get(path: string, cookie?: string, extra: Record<string, string> = {}, target = app) {
    return target.request(path, { headers: { ...(cookie && { cookie }), ...extra } })
  }

  async function answer(response: Response) {
    expect(response.headers.get('cache-control')).toBe('no-store')
    return { status: response.status, body: await response.json() }
  }

  async function switchTo(cookie: string, organizationId: string) {
    const response = await app.request('/api/auth/organization/set-active', {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    })
    expect(response.status).toBe(200)
  }

  it('requires a real session on both routes and never falls back from invalid Authorization', async () => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const owner = await session(user, team.id)
    for (const path of [selfPath, teamPath(team.id)]) {
      for (const response of [
        await get(path),
        await get(path, 'better-auth.session_token=invalid'),
        await get(path, owner.cookie, { authorization: 'Bearer invalid' }),
      ]) {
        expect(await answer(response)).toEqual({ status: 401, body: { error: 'unauthorized' } })
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
      }
    }
  })

  it('lets an ordinary member read only their own detail and uniformly refuses other teams', async () => {
    const user = await createTestUser(db)
    const other = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user, role: 'member' },
      { user: other, role: 'owner' },
    ])
    const outsiderUser = await createTestUser(db)
    const unrelated = await createTestTeam(db, [{ user: outsiderUser, role: 'member' }])
    const member = await session(user, team.id)
    const self = await answer(await get(selfPath, member.cookie))
    expect(self.status).toBe(200)
    expect(self.body).toMatchObject({
      member: { subject: { kind: 'member', organizationId: team.id } },
      eventTypes: { data: [], nextCursor: null },
    })
    expect(JSON.stringify(self.body).includes(other.id)).toBe(false)
    for (const path of [teamPath(team.id), teamPath(unrelated.id), teamPath(randomUUID())])
      expect(await answer(await get(path, member.cookie))).toEqual({ status: 403, body: denial })
    const outsider = await session(outsiderUser, unrelated.id)
    expect(await answer(await get(teamPath(team.id), outsider.cookie))).toEqual({
      status: 403,
      body: denial,
    })
    expect((await get(`${selfPath}?userId=${other.id}`, member.cookie)).status).toBe(400)
    const owner = await session(other, team.id)
    expect((await get(`${teamPath(team.id)}?userId=${user.id}`, owner.cookie)).status).toBe(400)
  })

  it.each(['owner', 'admin'])('accepts a real current-team %s cookie', async (role) => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role }])
    const current = await session(user, team.id)
    for (const path of [selfPath, teamPath(team.id)])
      expect((await get(path, current.cookie)).status).toBe(200)
  })

  it('refuses a real API key on both routes even with a valid owner cookie', async () => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const owner = await session(user, team.id)
    const key = await auth.api.createApiKey({
      body: { userId: user.id, metadata: { organizationId: team.id } },
    })
    for (const path of [selfPath, teamPath(team.id)])
      for (const cookie of [undefined, owner.cookie])
        expect(
          await answer(await get(path, cookie, { authorization: `Bearer ${key.key}` })),
        ).toEqual({
          status: 403,
          body: { error: path === selfPath ? 'readiness_access_denied' : denial.error },
        })
  })

  it('detects cookie fallback from Authorization in a source-copy resolver', async () => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const owner = await session(user, team.id)
    const key = await auth.api.createApiKey({
      body: { userId: user.id, metadata: { organizationId: team.id } },
    })
    const resolver = (mutation?: [string, string]) =>
      sourceCopy<typeof createCallerResolver>(
        'packages/auth/src/caller.ts',
        {
          ensurePersonalOrganization,
          isUuid: (id: string) => z.uuid().safeParse(id).success,
          sql,
        },
        'createCallerResolver',
        mutation,
      )({ auth, db })
    const verify = async (resolveCaller: ReturnType<typeof createCallerResolver>) => {
      const target = application(resolveCaller)
      for (const path of [selfPath, teamPath(team.id)])
        expect(
          (await get(path, owner.cookie, { authorization: `Bearer ${key.key}` }, target)).status,
        ).toBe(403)
    }
    await verify(resolver())
    await expect(
      verify(
        resolver([
          'authorization === null ? fromSession(headers) : fromApiKey(authorization)',
          "authorization === null || headers.has('cookie') ? fromSession(headers) : fromApiKey(authorization)",
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError', actual: 200, expected: 403 })
    await verify(resolver())
  })

  it('refuses a valid MCP OAuth bearer as a REST session, including with an owner cookie', async () => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const owner = await session(user, team.id)
    const clientId = `https://readiness.example/${randomUUID()}.json`
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: user.id, organization_id: team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthClient')
      .values({ clientId, redirectUris: JSON.stringify(['https://readiness.example/callback']) })
      .execute()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: user.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const bearer = await signTestMcpAccessToken(auth, {
      sub: user.id,
      client_id: clientId,
      scope: 'mcp:tools',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `${origin}/api/auth`,
      aud: `${origin}/mcp`,
      'https://hourmere.com/organization': team.id,
      'https://hourmere.com/grant': grant.id,
    })
    const headers = { authorization: `Bearer ${bearer}` }
    const oauth = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
      new Request(`${origin}/mcp`, { method: 'POST', headers }),
    )
    expect(oauth.ok).toBe(true)
    if (oauth.ok) expect(oauth.principal.kind).toBe('oauth')
    for (const path of [selfPath, teamPath(team.id)])
      for (const cookie of [undefined, owner.cookie])
        expect(await answer(await get(path, cookie, headers))).toEqual({
          status: 401,
          body: { error: 'unauthorized' },
        })
  })

  it('reauthorizes both projections immediately after a real organization switch', async () => {
    const user = await createTestUser(db)
    const first = await createTestTeam(db, [{ user, role: 'owner' }])
    const second = await createTestTeam(db, [{ user, role: 'owner' }])
    const current = await session(user, first.id)
    const fx = createFixtures(db)
    const firstEvent = await fx.eventType(first.id, null, { hosts: [{ userId: user.id }] })
    const secondEvent = await fx.eventType(second.id, null, { hosts: [{ userId: user.id }] })
    const personalEvent = await fx.eventType(user.principal.organization.id, user.id)
    expect((await get(teamPath(first.id), current.cookie)).status).toBe(200)
    expect(await answer(await get(teamPath(second.id), current.cookie))).toEqual({
      status: 403,
      body: denial,
    })
    await switchTo(current.cookie, second.id)
    const self = await answer(await get(selfPath, current.cookie))
    expect(self.status).toBe(200)
    expect(self.body).toMatchObject({ member: { subject: { organizationId: second.id } } })
    expect(await answer(await get(teamPath(first.id), current.cookie))).toEqual({
      status: 403,
      body: denial,
    })
    const secondPage = await answer(await get(teamPath(second.id), current.cookie))
    expect(secondPage.status).toBe(200)
    expect(JSON.stringify(secondPage.body).includes(secondEvent)).toBe(true)
    expect(JSON.stringify(secondPage.body).includes(firstEvent)).toBe(false)
    await switchTo(current.cookie, user.principal.organization.id)
    const personal = await answer(await get(selfPath, current.cookie))
    expect(personal.status).toBe(200)
    expect(JSON.stringify(personal.body).includes(personalEvent)).toBe(true)
    expect(JSON.stringify(personal.body).includes(secondEvent)).toBe(false)
    expect(await answer(await get(teamPath(second.id), current.cookie))).toEqual({
      status: 403,
      body: denial,
    })
  })

  it('rechecks role revocation and removal on the next request using the same real cookie', async () => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'admin' }])
    const current = await session(user, team.id)
    expect((await get(teamPath(team.id), current.cookie)).status).toBe(200)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .execute()
    expect(await answer(await get(teamPath(team.id), current.cookie))).toEqual({
      status: 403,
      body: denial,
    })
    expect((await get(selfPath, current.cookie)).status).toBe(200)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .execute()
    expect(await answer(await get(teamPath(team.id), current.cookie))).toEqual({
      status: 403,
      body: denial,
    })
    const personal = await answer(await get(selfPath, current.cookie))
    expect(personal.status).toBe(200)
    expect(personal.body).toMatchObject({
      member: { subject: { organizationId: user.principal.organization.id } },
    })
    expect(JSON.stringify(personal.body).includes(team.id)).toBe(false)
    expect(owned.pool.totalCount + authPool.totalCount).toBeLessThanOrEqual(20)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('booking readiness REST', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await t?.drop()
  })

  async function session(user: TestUser, principal: Principal = user.principal) {
    const row = await t.db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: principal.organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { user: actor, organization } = principal
    return { kind: 'session', sessionId: row.id, user: actor, organization } as const
  }

  it('requires authentication and refuses API keys and OAuth before private reads', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    for (const path of [selfPath, teamPath(team.id)]) {
      expect((await t.anonymous.get(path)).status).toBe(401)
      const key = await t.as(team.as(user)).get(path)
      expect(key.status).toBe(403)
      expect(key.body).toEqual({
        error: path === selfPath ? 'readiness_access_denied' : denial.error,
      })
      const oauth: Principal = {
        ...team.as(user),
        kind: 'oauth',
        oauthConsentId: randomUUID(),
        clientId: 'synthetic-readiness-client',
        scopes: ['bookings:read'],
      }
      expect((await t.as(oauth).get(path)).status).toBe(403)
    }
  })

  it.each(['owner', 'admin'])('accepts the current team %s session', async (role) => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role }])
    const response = await t.as(await session(user, team.as(user))).get(teamPath(team.id))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ organizationId: team.id })
  })

  it('refuses cross-team reads with the same response as missing teams and ordinary members', async () => {
    const owner = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const other = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const client = t.as(await session(owner, team.as(owner)))
    const crossTeam = await client.get(teamPath(other.id))
    const missing = await client.get(teamPath(randomUUID()))
    const member = await createTestUser(t.db)
    const memberTeam = await createTestTeam(t.db, [{ user: member, role: 'member' }])
    const ordinary = await t
      .as(await session(member, memberTeam.as(member)))
      .get(teamPath(memberTeam.id))
    expect(crossTeam).toEqual({ status: 403, body: denial })
    expect(missing).toEqual(crossTeam)
    expect(ordinary).toEqual(crossTeam)
  })

  it('detects cross-team guard removal in a source-copy route with a real assertion failure', async () => {
    const owner = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const other = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const principal = await session(owner, team.as(owner))
    const verify = async (routes: typeof readinessRoutes) => {
      const app = productApp(t.db, new Map([['hm_source_copy_readiness', principal]]), [
        routes({ db: t.db }),
      ])
      const response = await app.request(teamPath(other.id), {
        headers: { authorization: 'Bearer hm_source_copy_readiness' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denial)
    }
    await verify(readRouteCopy())
    const mutated = readRouteCopy([
      '    !uuid(teamId) ||\n    teamId.toLowerCase() !== principal.organization.id.toLowerCase()',
      '    !uuid(teamId)',
    ])
    await expect(verify(mutated)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: 200,
      expected: 403,
    })
    // The repository source was only read; rerun the original to prove it remains intact.
    await verify(readRouteCopy())
  })

  it('rechecks demotion and removal despite a previously resolved owner session', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const client = t.as(await session(user, team.as(user)))
    expect((await client.get(teamPath(team.id))).status).toBe(200)
    await t.db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .execute()
    expect(await client.get(teamPath(team.id))).toEqual({ status: 403, body: denial })
    await t.db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .execute()
    expect(await client.get(teamPath(team.id))).toEqual({ status: 403, body: denial })
    expect(await client.get(selfPath)).toEqual({
      status: 403,
      body: { error: 'readiness_access_denied' },
    })
  })

  it('refuses a previously resolved team session after its active organization changes', async () => {
    const user = await createTestUser(t.db)
    const first = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const second = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const principal = await session(user, first.as(user))
    const client = t.as(principal)
    expect((await client.get(teamPath(first.id))).status).toBe(200)
    await t.db
      .updateTable('auth.session')
      .set({ activeOrganizationId: second.id })
      .where('id', '=', principal.sessionId)
      .execute()
    expect(await client.get(teamPath(first.id))).toEqual({ status: 403, body: denial })
    expect(await client.get(teamPath(second.id))).toEqual({ status: 403, body: denial })
    expect(await client.get(selfPath)).toEqual({
      status: 403,
      body: { error: 'readiness_access_denied' },
    })
  })

  it('detects stale active-organization guard removal in a source-copy route', async () => {
    const user = await createTestUser(t.db)
    const first = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const second = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const principal = await session(user, first.as(user))
    await t.db
      .updateTable('auth.session')
      .set({ activeOrganizationId: second.id })
      .where('id', '=', principal.sessionId)
      .execute()
    const verify = async (routes: typeof readinessRoutes) => {
      const app = productApp(t.db, new Map([['hm_source_copy_readiness', principal]]), [
        routes({ db: t.db }),
      ])
      const response = await app.request(teamPath(first.id), {
        headers: { authorization: 'Bearer hm_source_copy_readiness' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denial)
    }
    await verify(readRouteCopy())
    await expect(
      verify(
        readRouteCopy(undefined, [
          "        .where('activeOrganizationId', '=', principal.organization.id)",
          '',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError', actual: 200, expected: 403 })
    await verify(readRouteCopy())
  })

  it.each(['deleted', 'expired', 'unverified'] as const)(
    'rechecks a %s cached session for both projections',
    async (change) => {
      const user = await createTestUser(t.db)
      const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
      const principal = await session(user, team.as(user))
      const client = t.as(principal)
      if (change === 'deleted')
        await t.db.deleteFrom('auth.session').where('id', '=', principal.sessionId).execute()
      else if (change === 'expired')
        await t.db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(Date.now() - 60_000) })
          .where('id', '=', principal.sessionId)
          .execute()
      else
        await t.db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', user.id)
          .execute()
      for (const path of [selfPath, teamPath(team.id)])
        expect((await client.get(path)).status).toBe(403)
    },
  )

  it('returns only self detail and personal events, then only self member detail in a team', async () => {
    const user = await createTestUser(t.db)
    const other = await createTestUser(t.db)
    const fx = createFixtures(t.db)
    await fx.schedule(user.id)
    const ownEvent = await fx.eventType(user.principal.organization.id, user.id)
    const privateEvent = await fx.eventType(other.principal.organization.id, other.id)
    const team = await createTestTeam(t.db, [
      { user, role: 'member' },
      { user: other, role: 'owner' },
    ])
    const teamEvent = await fx.eventType(team.id, null, { hosts: [{ userId: other.id }] })
    const personal = await t.as(await session(user)).get(selfPath)
    expect(personal.status).toBe(200)
    const serialized = JSON.stringify(personal.body)
    expect(serialized).toContain(ownEvent)
    expect(serialized).not.toContain(privateEvent)
    expect(serialized).not.toContain(teamEvent)
    const member = await t.as(await session(user, team.as(user))).get(selfPath)
    expect(member.status).toBe(200)
    expect(member.body).toMatchObject({ eventTypes: { data: [], nextCursor: null } })
    expect(JSON.stringify(member.body)).not.toContain(other.id)
  })

  it('does not expose a departed host through current team member summaries', async () => {
    const owner = await createTestUser(t.db)
    const removed = await createTestUser(t.db, 'departed-member-name-canary')
    const team = await createTestTeam(t.db, [
      { user: owner, role: 'owner' },
      { user: removed, role: 'member' },
    ])
    const eventId = await createFixtures(t.db).eventType(team.id, null, {
      hosts: [{ userId: removed.id }],
    })
    await t.db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', removed.id)
      .execute()
    const response = await t.as(await session(owner, team.as(owner))).get(teamPath(team.id))
    expect(response.status).toBe(200)
    const body = JSON.stringify(response.body)
    expect(body).toContain(eventId)
    expect(body).toContain('host_configuration_required')
    expect(body.includes(removed.id)).toBe(false)
    expect(body.includes(removed.name)).toBe(false)
  })

  it('keeps private field and content canaries out of the team projection', async () => {
    const user = await createTestUser(t.db)
    const other = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [
      { user, role: 'owner' },
      { user: other, role: 'member' },
    ])
    const fx = createFixtures(t.db)
    const scheduleId = await fx.schedule(other.id)
    await t.db
      .updateTable('schedules')
      .set({ name: 'private-schedule-canary' })
      .where('id', '=', scheduleId)
      .execute()
    const eventId = await fx.eventType(team.id, null, {
      hosts: [{ userId: other.id }],
      title: 'private-title-canary',
      description: 'private-description-canary',
    })
    const connection = await t.db
      .insertInto('calendar_connections')
      .values({
        user_id: other.id,
        provider: 'google',
        external_account_id: 'private-external-account-canary',
        account_email: 'private-calendar-account-canary@example.com',
        credentials: Buffer.from('private-credential-canary'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await t.db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'private-external-calendar-canary',
        name: 'private-calendar-name-canary',
        check_conflicts: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await t.db
      .insertInto('calendar_busy')
      .values({
        calendar_id: calendar.id,
        external_event_id: 'private-busy-event-canary',
        period: '[2026-11-03T12:34:56Z,2026-11-03T13:34:56Z)',
      })
      .execute()
    const response = await t.as(await session(user, team.as(user))).get(teamPath(team.id))
    expect(response.status).toBe(200)
    const body = JSON.stringify(response.body)
    expect(body).toContain(eventId)
    expect(body).toContain('calendar_attention_required')
    for (const value of [
      scheduleId,
      connection.id,
      calendar.id,
      other.email,
      'private-',
      '2026-11-03T12:34:56',
    ])
      expect(body.includes(value)).toBe(false)
    const forbiddenKeys = new Set([
      'signals',
      'details',
      'provider',
      'accountEmail',
      'calendarId',
      'calendarName',
      'lastSyncedAt',
      'syncError',
      'weeklyHours',
      'timeZone',
      'scheduleId',
      'title',
      'description',
      'busy',
    ])
    expect(allKeys(response.body).filter((key) => forbiddenKeys.has(key))).toEqual([])
  })

  it('validates bounded pagination and refuses audience, user and organization overrides', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const client = t.as(await session(user, team.as(user)))
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=1.5',
      '?limit=invalid',
      '?eventTypeCursor=invalid',
      '?memberCursor=invalid',
      '?audience=self_detail',
      `?userId=${user.id}`,
      `?organizationId=${team.id}`,
    ]) {
      expect((await client.get(`${teamPath(team.id)}${query}`)).status).toBe(400)
      expect((await client.get(`${selfPath}${query}`)).status).toBe(400)
    }
    expect((await client.get(`${selfPath}?memberCursor=${randomUUID()}`)).status).toBe(400)
  })
})
