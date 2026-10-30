import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import {
  type Auth,
  checkTeamManagementAccess,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { requireCaller } from './caller.ts'
import type { RouteModule } from './openapi.ts'
import { teamManagementAccess } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4388'
const secret = 'synthetic-team-management-session-secret-0000000000'
const denied = { error: 'team_management_access_denied' }
type Access = typeof teamManagementAccess

// Evaluate isolated source copies so mutations cannot affect parallel test workers.
function accessCopy(sharedMutation?: [string, string], serverMutation?: [string, string]): Access {
  function copy(
    path: string,
    bindings: Record<string, unknown>,
    name: string,
    mutation?: [string, string],
  ) {
    let source = readFileSync(path, 'utf8')
    if (mutation) {
      expect(source.includes(mutation[0]), 'mutation matches real access source').toBe(true)
      source = source.replace(...mutation)
    }
    const script = stripTypeScriptTypes(
      source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
    ).replace(/\bexport /g, '')
    return new Function(...Object.keys(bindings), `${script}; return ${name}`)(
      ...Object.values(bindings),
    )
  }
  const shared = copy(
    'packages/auth/src/team-management.ts',
    { sql },
    '({ checkTeamManagementAccess, TeamManagementError })',
    sharedMutation,
  )
  return copy(
    'apps/server/src/team-management.ts',
    { DomainError, createMiddleware, ...shared },
    'teamManagementAccess',
    serverMutation,
  ) as Access
}

describe.skipIf(!serverUrl)('shared team-management access', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>

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
      mailer: { send: async () => {} },
    })
    await owned.pool.query(`CREATE TABLE team_management_test_writes (
      organization_id uuid NOT NULL, actor_user_id uuid NOT NULL, actor_role text NOT NULL
    )`)
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture(
    role = 'admin',
    personal = false,
    accessFactory: Access = teamManagementAccess,
  ) {
    const user = await createTestUser(db, 'Team manager')
    const team = personal
      ? { id: user.principal.organization.id }
      : await createTestTeam(db, [{ user, role }])
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: team.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    const resolve = createCallerResolver({ auth, db })
    const resolved = await resolve(new Headers({ cookie }))
    if (!resolved.ok) throw new Error('Synthetic session did not resolve')
    let beforeWrite: (() => Promise<void>) | undefined
    let afterResolve: (() => Promise<void>) | undefined
    const routes: RouteModule = ({ app, caller }) => {
      const access = accessFactory(db, caller)
      app.post('/api/v1/team-management-test/:teamId', ...access.middleware, async (c) => {
        await beforeWrite?.()
        const actor = await access.write(
          c.var.principal,
          c.req.param('teamId'),
          async (trx, actor) => {
            await sql`INSERT INTO team_management_test_writes VALUES
            (${actor.organizationId}::uuid, ${actor.userId}::uuid, ${actor.role})`.execute(trx)
            return actor
          },
        )
        return c.json(actor)
      })
      // Entry-only probes: no service recheck behind them, so they pin each middleware's own role gate.
      app.get('/api/v1/team-management-test/:teamId/entry', ...access.middleware, (c) =>
        c.json({ entered: true }),
      )
      app.get(
        '/api/v1/team-management-test/:teamId/member-entry',
        ...access.memberReadMiddleware,
        (c) => c.json({ entered: true }),
      )
    }
    const app = createApp({
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const caller = await resolve(headers)
        if (caller.ok) await afterResolve?.()
        return caller
      },
      checkDb: async () => {},
      publicUrl: origin,
      routes: [routes],
    })
    return {
      user,
      team,
      cookie,
      sessionId: session.id,
      principal: resolved.principal,
      app,
      access: accessFactory(db, requireCaller(resolve, { allowedOrigin: origin })),
      afterResolve: (hook: () => Promise<void>) => {
        afterResolve = hook
      },
      beforeWrite: (hook: () => Promise<void>) => {
        beforeWrite = hook
      },
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function post(f: Fixture, options: { teamId?: string; headers?: Record<string, string> } = {}) {
    const headers = new Headers(options.headers ?? { origin })
    headers.set('cookie', f.cookie)
    return f.app.request(`/api/v1/team-management-test/${options.teamId ?? f.team.id}`, {
      method: 'POST',
      headers,
    })
  }

  async function countWrites(f: Fixture) {
    const result = await owned.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM team_management_test_writes WHERE organization_id=$1',
      [f.team.id],
    )
    return result.rows[0]?.count
  }

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body).toMatchObject(denied)
    return body
  }

  it.each([
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['member, admin', 'admin'],
    ['admin, owner', 'owner'],
  ])('accepts the current exact %s role', async (stored, expected) => {
    const f = await fixture(stored)
    const response = await post(f)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      userId: f.user.id,
      organizationId: f.team.id,
      role: expected,
    })
    expect(await countWrites(f)).toBe(1)
  })

  it.each(['member', 'superadmin', 'team-owner', 'administrator', 'OWNER', ''])(
    'refuses the non-management role %j without substring matching',
    async (role) => {
      const f = await fixture(role)
      await expectDenied(await post(f))
      expect(await countWrites(f)).toBe(0)
    },
  )

  it.each([
    ['owner', 200, 200],
    ['admin', 200, 200],
    ['member', 403, 200],
    ['member, admin', 200, 200],
    ['member, owner', 200, 200],
    ['team-member', 403, 403],
    ['MEMBER', 403, 403],
    ['superadmin', 403, 403],
    ['', 403, 403],
  ])('gates the %j role at each middleware entry', async (role, management, memberRead) => {
    const f = await fixture(role)
    const entry = (path: string) =>
      f.app.request(`/api/v1/team-management-test/${f.team.id}/${path}`, {
        headers: { origin, cookie: f.cookie },
      })
    const managementEntry = await entry('entry')
    expect(managementEntry.status).toBe(management)
    if (management === 403) await expectDenied(managementEntry)
    const memberEntry = await entry('member-entry')
    expect(memberEntry.status).toBe(memberRead)
    if (memberRead === 403) await expectDenied(memberEntry)
  })

  it('refuses members at the shared check and direct management read and write callbacks', async () => {
    const f = await fixture('member')
    await expect(checkTeamManagementAccess(db, f.principal, f.team.id)).rejects.toMatchObject({
      code: denied.error,
    })
    expect(
      await checkTeamManagementAccess(db, f.principal, f.team.id, false, undefined, true),
    ).toEqual({
      userId: f.user.id,
      organizationId: f.team.id,
      role: 'member',
    })
    const operation = vi.fn(async () => 'unexpected')
    await expect(f.access.read(f.principal, f.team.id, operation)).rejects.toMatchObject({
      code: denied.error,
    })
    await expect(f.access.write(f.principal, f.team.id, operation)).rejects.toMatchObject({
      code: denied.error,
    })
    expect(operation).not.toHaveBeenCalled()
  })

  async function verifyMemberEntries(accessFactory: Access, role = 'member') {
    const f = await fixture(role, false, accessFactory)
    const entry = (path: string) =>
      f.app.request(`/api/v1/team-management-test/${f.team.id}/${path}`, {
        headers: { origin, cookie: f.cookie },
      })
    expect((await entry('entry')).status).toBe(403)
    expect((await entry('member-entry')).status).toBe(role === 'member' ? 200 : 403)
  }

  it('runs unchanged shared and server access source copies against entry assertions', async () => {
    await verifyMemberEntries(accessCopy())
  })

  it.each([
    ['default member admission', 'allowMemberRead = false', 'allowMemberRead = true', 'member'],
    ['lost member admission', "allowMemberRead && roles.includes('member')", 'false', 'member'],
    [
      'member role substring matching',
      "allowMemberRead && roles.includes('member')",
      "allowMemberRead && roles.some((role) => role.includes('member'))",
      'team-member',
    ],
  ])('detects %s in a shared guard source copy', async (_name, before, after, role) => {
    await expect(verifyMemberEntries(accessCopy([before, after]), role)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it.each([
    [
      'management member admission',
      'await check(db, c.var.principal, c.var.principal.organization.id)',
      'await check(db, c.var.principal, c.var.principal.organization.id, false, undefined, true)',
    ],
    [
      'lost member-read opt-in',
      'await check(db, c.var.principal, c.var.principal.organization.id, false, undefined, true)',
      'await check(db, c.var.principal, c.var.principal.organization.id)',
    ],
  ])('detects %s in a middleware source copy', async (_name, before, after) => {
    await expect(verifyMemberEntries(accessCopy(undefined, [before, after]))).rejects.toMatchObject(
      {
        name: 'AssertionError',
      },
    )
  })

  async function verifyExpectedTeamContext(accessFactory: Access = teamManagementAccess) {
    for (const current of ['personal', 'member'] as const) {
      const f = await fixture('admin', false, accessFactory)
      const currentId =
        current === 'personal'
          ? f.user.principal.organization.id
          : (await createTestTeam(db, [{ user: f.user, role: 'member' }])).id
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: currentId })
        .where('id', '=', f.sessionId)
        .execute()
      const response = await f.app.request(`/api/v1/team-management-test/${f.team.id}/entry`, {
        headers: { cookie: f.cookie, 'X-Expected-Organization-Id': f.team.id },
      })
      expect(response.status, `expected team retained; current ${current}`).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
    }
  }

  it('checks expected team authority before current personal or member eligibility', () =>
    verifyExpectedTeamContext())

  it('keeps expected-team context behavior in unchanged source copies', () =>
    verifyExpectedTeamContext(accessCopy()))

  it('detects rejecting the current team before checking expected management', async () => {
    await expect(
      verifyExpectedTeamContext(
        accessCopy(undefined, [
          'await expectedContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))',
          `await check(db, c.var.principal, c.var.principal.organization.id)
    await expectedContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))`,
        ]),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError', actual: 403, expected: 409 }),
    )
  })

  async function verifyPostResolutionContext(
    accessFactory: Access = teamManagementAccess,
    role = 'admin',
  ) {
    for (const current of ['personal', 'member'] as const) {
      const f = await fixture(role, false, accessFactory)
      const currentId =
        current === 'personal'
          ? f.user.principal.organization.id
          : (await createTestTeam(db, [{ user: f.user, role: 'member' }])).id
      f.afterResolve(async () => {
        await db
          .updateTable('auth.session')
          .set({ activeOrganizationId: currentId })
          .where('id', '=', f.sessionId)
          .execute()
      })
      const response = await f.app.request(
        `/api/v1/team-management-test/${f.team.id}/${role === 'member' ? 'member-entry' : 'entry'}`,
        {
          headers: { cookie: f.cookie, 'X-Expected-Organization-Id': f.team.id },
        },
      )
      expect(response.status, `post-resolution current ${current}`).toBe(
        role === 'member' ? 403 : 409,
      )
    }
  }

  it('checks live context even when the expected ID matches the resolved principal', () =>
    verifyPostResolutionContext())

  it('detects skipping the live check for an expected ID matching a stale principal', async () => {
    await verifyPostResolutionContext(accessCopy())
    await expect(
      verifyPostResolutionContext(
        accessCopy(undefined, [
          'if (!uuid(expectedOrganizationId)) throw denied()',
          `if (!uuid(expectedOrganizationId)) throw denied()
    if (expectedOrganizationId.toLowerCase() === principal.organization.id.toLowerCase()) return`,
        ]),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError', actual: 200, expected: 409 }),
    )
  })

  it('keeps ordinary expected members denied when a switch follows caller resolution', async () => {
    await verifyPostResolutionContext(teamManagementAccess, 'member')
    await expect(
      verifyPostResolutionContext(
        accessCopy(["if (role === 'member' && !context.allowPersonal) throw denied()", '']),
        'member',
      ),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError', actual: 409, expected: 403 }),
    )
  })

  it('does not retain an admin role from an earlier request in the same session', async () => {
    const f = await fixture()
    expect((await post(f)).status).toBe(200)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.user.id)
      .execute()
    await expectDenied(await post(f))
    expect(await countWrites(f)).toBe(1)
  })

  it("does not borrow another user's owner role in the acting team", async () => {
    const owner = await createTestUser(db, 'Another owner')
    const f = await fixture('member')
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.user.id)
      .execute()
    // Put the other user's owner membership first so a missing actor filter grants access.
    await db
      .insertInto('auth.member')
      .values([
        { organizationId: f.team.id, userId: owner.id, role: 'owner', createdAt: new Date() },
        { organizationId: f.team.id, userId: f.user.id, role: 'member', createdAt: new Date() },
      ])
      .execute()
    await expectDenied(await post(f))
    expect(await countWrites(f)).toBe(0)
  })

  it("does not borrow the actor's owner role from another team", async () => {
    const f = await fixture('member')
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.user.id)
      .execute()
    // The elevated role exists before this team's ordinary membership and remains unrelated.
    await createTestTeam(db, [{ user: f.user, role: 'owner' }], 'Other owned team')
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: f.user.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    await expectDenied(await post(f))
    expect(await countWrites(f)).toBe(0)
  })

  it('refuses a removed member whose session falls back to the personal organization', async () => {
    const f = await fixture()
    expect((await post(f)).status).toBe(200)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.user.id)
      .execute()
    await expectDenied(await post(f))
    expect(await countWrites(f)).toBe(1)
  })

  it('refuses a session whose current user email is unverified', async () => {
    const f = await fixture()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.user.id)
      .execute()
    await expectDenied(await post(f))
    expect(await countWrites(f)).toBe(0)
  })

  it('refuses a personal organization even when the supplied principal claims it is a team', async () => {
    const f = await fixture('owner', true)
    await expectDenied(await post(f))
    await expect(
      f.access.write(
        { ...f.principal, organization: { ...f.principal.organization, personal: false } },
        f.team.id,
        async () => 'unexpected',
      ),
    ).rejects.toMatchObject({ code: denied.error })
    expect(await countWrites(f)).toBe(0)
  })

  const requestSources: Record<string, string>[] = [
    {},
    { origin: 'https://wrong.example' },
    { referer: 'https://wrong.example/app/teams' },
    { origin: 'null', referer: `${origin}/app/teams` },
    { origin: 'https://wrong.example', referer: `${origin}/app/teams` },
  ]
  it.each(requestSources)('reuses requireCaller source checks for %j', async (headers) => {
    const f = await fixture()
    const response = await post(f, { headers })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'forbidden' })
    expect(await countWrites(f)).toBe(0)
  })

  it('accepts a same-origin Referer when Origin is absent', async () => {
    const f = await fixture()
    expect((await post(f, { headers: { referer: `${origin}/app/teams` } })).status).toBe(200)
  })

  it('refuses a valid team-bound API key even alongside a valid session cookie', async () => {
    const f = await fixture()
    const key = await auth.api.createApiKey({
      body: { userId: f.user.id, metadata: { organizationId: f.team.id } },
    })
    await expectDenied(await post(f, { headers: { authorization: `Bearer ${key.key}` } }))
    expect(await countWrites(f)).toBe(0)
  })

  it('refuses OAuth callers at the shared write entry', async () => {
    const f = await fixture()
    const principal: Principal = {
      user: f.principal.user,
      organization: f.principal.organization,
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: 'synthetic-client',
      scopes: ['bookings:write'],
    }
    await expect(
      f.access.write(principal, f.team.id, async () => 'unexpected'),
    ).rejects.toMatchObject({
      code: denied.error,
    })
  })

  it('returns identical denials for another team and a nonexistent team', async () => {
    const f = await fixture()
    const other = await createTestTeam(db, [{ user: f.user, role: 'owner' }])
    const wrongTeam = await expectDenied(await post(f, { teamId: other.id }))
    const missingTeam = await expectDenied(await post(f, { teamId: randomUUID() }))
    expect(wrongTeam).toEqual(missingTeam)
    expect(await countWrites(f)).toBe(0)
  })

  it('binds read callbacks to fresh access facts before loading any team data', async () => {
    const f = await fixture()
    const read = () => f.access.read(f.principal, f.team.id, async (_db, actor) => actor)
    expect(await read()).toEqual({
      userId: f.user.id,
      organizationId: f.team.id,
      role: 'admin',
    })
    const other = await createTestTeam(db, [{ user: f.user, role: 'owner' }])
    let called = false
    await expect(
      f.access.read(f.principal, other.id, async () => {
        called = true
        return 'unexpected'
      }),
    ).rejects.toMatchObject({ code: denied.error })
    expect(called).toBe(false)
    await change(f, 'demotion')
    await expect(read()).rejects.toMatchObject({ code: denied.error })
  })

  it('normalizes UUID case without changing the authorized organization', async () => {
    const f = await fixture()
    const result = await f.access.write(
      f.principal,
      f.team.id.toUpperCase(),
      async (_trx, actor) => actor,
    )
    expect(result).toEqual({ userId: f.user.id, organizationId: f.team.id, role: 'admin' })
  })

  it('does not borrow another live session when the resolved session no longer exists', async () => {
    const f = await fixture()
    if (f.principal.kind !== 'session') throw new Error('Expected synthetic session')
    await expect(
      f.access.write(
        { ...f.principal, sessionId: randomUUID() },
        f.team.id,
        async () => 'unexpected',
      ),
    ).rejects.toMatchObject({ code: denied.error })
    expect(await countWrites(f)).toBe(0)
  })

  it.each(['team', 'user', 'session'] as const)(
    'refuses a malformed %s UUID uniformly',
    async (field) => {
      const f = await fixture()
      if (f.principal.kind !== 'session') throw new Error('Expected synthetic session')
      const principal = {
        ...f.principal,
        user: { ...f.principal.user, id: field === 'user' ? 'invalid' : f.user.id },
        sessionId: field === 'session' ? 'invalid' : f.sessionId,
      }
      await expect(
        f.access.write(
          principal,
          field === 'team' ? 'invalid' : f.team.id,
          async () => 'unexpected',
        ),
      ).rejects.toMatchObject({ code: denied.error })
    },
  )

  const changes = [
    'demotion',
    'removal',
    'unverified',
    'deleted session',
    'expired session',
    'rebound session',
  ] as const
  type Change = (typeof changes)[number]

  async function change(f: Fixture, kind: Change, client: Pick<PoolClient, 'query'> = owned.pool) {
    if (kind === 'demotion')
      await client.query(
        'UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3',
        ['member', f.team.id, f.user.id],
      )
    else if (kind === 'removal')
      await client.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
        f.team.id,
        f.user.id,
      ])
    else if (kind === 'unverified')
      await client.query('UPDATE auth."user" SET "emailVerified"=false WHERE id=$1', [f.user.id])
    else if (kind === 'deleted session')
      await client.query('DELETE FROM auth.session WHERE id=$1', [f.sessionId])
    else if (kind === 'expired session')
      await client.query(
        'UPDATE auth.session SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1',
        [f.sessionId],
      )
    else {
      const other = await createTestUser(db)
      await client.query('UPDATE auth.session SET "userId"=$1 WHERE id=$2', [other.id, f.sessionId])
    }
  }

  it.each(changes)('rechecks %s after middleware and before the write', async (kind) => {
    const f = await fixture()
    f.beforeWrite(() => change(f, kind))
    await expectDenied(await post(f))
    expect(await countWrites(f)).toBe(0)
  })

  async function pid(client: PoolClient) {
    return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid as number
  }

  async function blockedBy(blocker: number, waiting?: number) {
    let blocked = 0
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND $1::int=ANY(pg_blocking_pids(pid)) AND ($2::int IS NULL OR pid=$2)`,
          [blocker, waiting ?? null],
        )
        blocked = result.rows[0]?.pid ?? 0
        expect(blocked).not.toBe(0)
      },
      { timeout: 3000, interval: 10 },
    )
    return blocked
  }

  it.each(['demotion', 'removal', 'unverified', 'deleted session', 'expired session'] as const)(
    'refuses concurrent %s committed while waiting for the authorization parent',
    async (kind) => {
      const f = await fixture()
      const holder = await owned.pool.connect()
      let pending: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        if (kind === 'unverified')
          await holder.query('SELECT id FROM auth."user" WHERE id=$1 FOR UPDATE', [f.user.id])
        else
          await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.team.id])
        pending = Promise.resolve(post(f))
        await blockedBy(await pid(holder))
        if (kind === 'expired session')
          // Expire after the writer's BEGIN, so transaction-time now() would be stale.
          await holder.query('UPDATE auth.session SET "expiresAt"=clock_timestamp() WHERE id=$1', [
            f.sessionId,
          ])
        else await change(f, kind, holder)
        await holder.query('COMMIT')
        await expectDenied(await pending)
        expect(await countWrites(f)).toBe(0)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await pending
      }
    },
  )

  it('serializes concurrent management callbacks that update their organization', async () => {
    const f = await fixture()
    const firstEntered = Promise.withResolvers<number>()
    const finish = Promise.withResolvers<void>()
    const first = f.access.write(f.principal, f.team.id, async (trx) => {
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      firstEntered.resolve(backend.rows[0]?.pid as number)
      await finish.promise
      await trx
        .updateTable('auth.organization')
        .set({ name: 'First change' })
        .where('id', '=', f.team.id)
        .execute()
      return 'first'
    })
    let second: Promise<string> | undefined
    let results: Promise<PromiseSettledResult<string>[]> | undefined
    try {
      const firstPid = await firstEntered.promise
      second = f.access.write(f.principal, f.team.id, async (trx) => {
        await trx
          .updateTable('auth.organization')
          .set({ name: 'Second change' })
          .where('id', '=', f.team.id)
          .execute()
        return 'second'
      })
      results = Promise.allSettled([first, second])
      await blockedBy(firstPid)
      finish.resolve()
      expect(await results).toEqual([
        { status: 'fulfilled', value: 'first' },
        { status: 'fulfilled', value: 'second' },
      ])
      expect(
        await db
          .selectFrom('auth.organization')
          .select('name')
          .where('id', '=', f.team.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Second change' })
    } finally {
      finish.resolve()
      await (results ?? Promise.allSettled([first]))
    }
  })

  it('refuses a session that expires while waiting for its unchanged session row lock', async () => {
    const f = await fixture()
    const holder = await owned.pool.connect()
    let called = false
    let pending: Promise<{ value: string } | { error: unknown }> | undefined
    try {
      await owned.pool.query(
        'UPDATE auth.session SET "expiresAt"=clock_timestamp()+interval \'500 milliseconds\' WHERE id=$1',
        [f.sessionId],
      )
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.session WHERE id=$1 FOR NO KEY UPDATE', [f.sessionId])
      pending = f.access
        .write(f.principal, f.team.id, async () => {
          called = true
          return 'unexpected'
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      await blockedBy(await pid(holder))
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ expired: boolean }>(
            'SELECT "expiresAt" < clock_timestamp() AS expired FROM auth.session WHERE id=$1',
            [f.sessionId],
          )
          expect(result.rows[0]?.expired).toBe(true)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('COMMIT')
      expect(await pending).toMatchObject({ error: { code: denied.error } })
      expect(called).toBe(false)
      expect(await countWrites(f)).toBe(0)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  })

  it('rolls back callback writes when the callback fails', async () => {
    const f = await fixture()
    await expect(
      f.access.write(f.principal, f.team.id, async (trx, actor) => {
        await sql`INSERT INTO team_management_test_writes VALUES
        (${actor.organizationId}::uuid, ${actor.userId}::uuid, ${actor.role})`.execute(trx)
        throw new Error('Synthetic callback failure')
      }),
    ).rejects.toThrow('Synthetic callback failure')
    expect(await countWrites(f)).toBe(0)
  })

  it.each(['demotion', 'removal', 'unverified', 'deleted session'] as const)(
    'holds %s eligibility until the authorized callback commits',
    async (kind) => {
      const f = await fixture()
      const entered = Promise.withResolvers<number>()
      const finish = Promise.withResolvers<void>()
      const revoker = await owned.pool.connect()
      let revocation: Promise<void> | undefined
      const write = f.access.write(f.principal, f.team.id, async (trx, actor) => {
        const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        entered.resolve(backend.rows[0]?.pid as number)
        await finish.promise
        await sql`INSERT INTO team_management_test_writes VALUES
          (${actor.organizationId}::uuid, ${actor.userId}::uuid, ${actor.role})`.execute(trx)
        return actor.role
      })
      try {
        const writerPid = await entered.promise
        const revokerPid = await pid(revoker)
        revocation = change(f, kind, revoker)
        await blockedBy(writerPid, revokerPid)
        finish.resolve()
        expect(await write).toBe('admin')
        await revocation
        expect(await countWrites(f)).toBe(1)
      } finally {
        finish.resolve()
        await write
        await revocation
        revoker.release()
      }
    },
  )
})
