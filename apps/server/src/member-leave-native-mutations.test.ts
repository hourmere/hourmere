import '@hono/zod-openapi'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { type Auth, type AuthConfig, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { leaveTeamMember } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43871'
const secret = 'synthetic-native-departure-mutation-secret-at-least-32-characters'
const signup = { mode: 'open', allowedDomains: [] } as const
type Mutation = readonly [string, string]
type AuthFactory = (config: AuthConfig) => Auth
interface NativeCopy {
  createAuth: AuthFactory
  leaveTeamMember: typeof leaveTeamMember
}

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const resolvePackage = (specifier: string) => {
    try {
      return import.meta.resolve(specifier)
    } catch {
      return pathToFileURL(createRequire(location).resolve(specifier)).href
    }
  }
  const code = stripTypeScriptTypes(source).replace(/from '([^']+)'/g, (_, specifier: string) => {
    const resolved =
      replacements[specifier] ??
      (specifier.startsWith('node:') ? specifier : undefined) ??
      (specifier.startsWith('.') ? new URL(specifier, location).href : resolvePackage(specifier))
    return `from '${resolved}'`
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

/** Native requests run a copied auth factory and policy without modifying any working file. */
async function sourceCopy(mutation?: Mutation): Promise<NativeCopy> {
  const policyLocation = new URL('../../../packages/auth/src/team-role-policy.ts', import.meta.url)
  let source = readFileSync(policyLocation, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0]), 'mutation must match the native departure policy').toBe(
      true,
    )
    source = source.replaceAll(...mutation)
  }
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const copied = await import(
    moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
      './team-role-policy.ts': moduleUrl(source, policyLocation),
    })
  )
  const serviceLocation = new URL(
    '../../../packages/scheduling/src/member-leave.ts',
    import.meta.url,
  )
  const service = (await import(
    moduleUrl(readFileSync(serviceLocation, 'utf8'), serviceLocation)
  )) as {
    leaveTeamMember: typeof leaveTeamMember
  }
  // Keep the factory and its real injected service in the same module runtime, just as
  // production does, so transport-neutral error classes keep their instanceof identity.
  return { createAuth: copied.createAuth, leaveTeamMember: service.leaveTeamMember }
}

describe.skipIf(!serverUrl)('native safe departure source-copy protections', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'leave_native' })
    db = createDb(owned.pool)
    // All source copies share one auth pool and its bounded organization-lock pool.
    pool = createAuthPool(owned.url, signup)
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  async function fixture(impact = true) {
    const member = await createTestUser(db, 'Departing administrator')
    const owner = await createTestUser(db, 'Remaining owner')
    const team = await createTestTeam(db, [
      { user: member, role: 'admin' },
      { user: owner, role: 'owner' },
    ])
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        token,
        userId: member.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: team.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    const eventId = impact
      ? await createFixtures(db).eventType(team.id, null, {
          title: 'Dependent team event',
          hosts: [{ userId: member.id }],
        })
      : undefined
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', member.id)
      .executeTakeFirstOrThrow()
    return {
      member,
      owner,
      teamId: team.id,
      sessionId: session.id,
      memberId: membership.id,
      cookie,
      eventId,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function nativeAuth(copy: NativeCopy, configured = true) {
    return copy.createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
      ...(configured && {
        leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
          copy.leaveTeamMember(
            { db, principal, now: () => Temporal.Now.instant() },
            { teamId, expectedOrganizationId },
          ),
      }),
    })
  }

  function app(copy: NativeCopy, configured = true) {
    const auth = nativeAuth(copy, configured)
    return createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  }

  function post(
    server: ReturnType<typeof app>,
    f: Fixture,
    path = 'leave',
    memberIdOrEmail = f.memberId,
  ) {
    return server.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers: {
        cookie: f.cookie,
        origin,
        'content-type': 'application/json',
        'x-expected-organization-id': f.teamId,
      },
      body: JSON.stringify(
        path === 'leave'
          ? { organizationId: f.teamId }
          : { organizationId: f.teamId, memberIdOrEmail },
      ),
    })
  }

  async function currentMembership(f: Fixture) {
    return db.selectFrom('auth.member').select('id').where('id', '=', f.memberId).executeTakeFirst()
  }

  async function assertBlocked(factory: NativeCopy, path = 'leave') {
    const f = await fixture()
    const response = await post(app(factory), f, path)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'member_departure_blocked',
      impact: {
        eventTypes: { totalCount: 1, data: [{ id: f.eventId, reason: 'sole_host' }] },
        bookings: { totalCount: 0, data: [] },
      },
      handling: {
        eventTypes: 'ask_admin_to_replace_or_remove_host',
        futureBookings: 'coordinate_cancellation',
        inProgressBookings: 'wait_until_end_or_coordinate_offline',
      },
    })
    expect(await currentMembership(f)).toEqual({ id: f.memberId })
  }

  async function assertTrustedBlocked(copy: NativeCopy, path = 'leave') {
    const f = await fixture()
    const auth = nativeAuth(copy)
    const headers = new Headers({ cookie: f.cookie })
    const response =
      path === 'leave'
        ? await auth.api.leaveOrganization({
            headers,
            body: { organizationId: f.teamId },
            asResponse: true,
          })
        : await auth.api.removeMember({
            headers,
            body: { organizationId: f.teamId, memberIdOrEmail: f.memberId },
            asResponse: true,
          })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'member_departure_blocked',
      impact: { eventTypes: { totalCount: 1, data: [{ id: f.eventId }] } },
    })
    expect(await currentMembership(f)).toEqual({ id: f.memberId })
  }

  async function assertProtectedRemoval(copy: NativeCopy) {
    const f = await fixture(false)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', f.memberId)
      .execute()
    const server = app(copy)
    for (const target of [f.owner.email, randomUUID(), 'missing-member@example.test']) {
      const response = await post(server, f, 'remove-member', target)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
        message: 'team_management_access_denied',
      })
    }
    expect(await currentMembership(f)).toEqual({ id: f.memberId })
    expect(
      await db
        .selectFrom('organization_operations')
        .select('id')
        .where('organization_id', '=', f.teamId)
        .execute(),
    ).toEqual([])
  }

  async function assertUnavailable(factory: NativeCopy) {
    const f = await fixture(false)
    const response = await post(app(factory, false), f)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'TEAM_LEAVE_UNAVAILABLE' })
    expect(await currentMembership(f)).toEqual({ id: f.memberId })
  }

  async function assertOwnerRequired(factory: NativeCopy) {
    const f = await fixture(false)
    // Better Auth's early owner check does not trim this legacy actor role; the
    // persistence interception must still apply the shared locked owner check.
    await db
      .updateTable('auth.member')
      .set({ role: 'member, owner' })
      .where('id', '=', f.memberId)
      .execute()
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.teamId)
      .where('userId', '=', f.owner.id)
      .execute()
    const response = await post(app(factory), f)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: 'member_departure_owner_required',
      message: 'The team must retain at least one owner.',
      handling: {
        owner: 'another_owner_is_needed_before_you_can_leave',
        nextStep: 'add_another_owner_first',
      },
    })
    expect(await currentMembership(f)).toEqual({ id: f.memberId })
  }

  async function personalId(user: TestUser) {
    const personal = await db
      .selectFrom('personal_organizations')
      .select('organization_id')
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow()
    return personal.organization_id
  }

  async function assertFallback(factory: NativeCopy) {
    const f = await fixture(false)
    const response = await post(app(factory), f)
    expect(response.status).toBe(200)
    expect(await currentMembership(f)).toBeUndefined()
    const session = await db
      .selectFrom('auth.session')
      .select('activeOrganizationId')
      .where('id', '=', f.sessionId)
      .executeTakeFirstOrThrow()
    expect(session.activeOrganizationId).toBe(await personalId(f.member))
  }

  it('passes both native self-departure assertions with an unchanged source copy', async () => {
    const factory = await sourceCopy()
    await assertBlocked(factory)
    await assertBlocked(factory, 'remove-member')
    await assertUnavailable(factory)
    await assertFallback(factory)
  })

  it('applies the same protection to both trusted native self-departure APIs', async () => {
    const copy = await sourceCopy()
    await assertTrustedBlocked(copy)
    await assertTrustedBlocked(copy, 'remove-member')
  })

  it('passes native owner refusal assertions with an unchanged source copy', async () => {
    await assertOwnerRequired(await sourceCopy())
  })

  it('passes native removal protection assertions with an unchanged source copy', async () => {
    await assertProtectedRemoval(await sourceCopy())
  })

  it('detects routing self-removal to administrative removal with a real assertion failure', async () => {
    const copy = await sourceCopy([
      'if (!actor || !target || target.userId !== actor.user.id)',
      'if (ctx.path === remove || !actor || !target || target.userId !== actor.user.id)',
    ])
    await expect(assertBlocked(copy, 'remove-member')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects dropping native removal protection with a real assertion failure', async () => {
    const copy = await sourceCopy([
      'new Set([changeRole, accept, remove])',
      'new Set([changeRole, accept])',
    ])
    await expect(assertProtectedRemoval(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects an omitted native owner refusal mapping with a real assertion failure', async () => {
    await expect(
      assertOwnerRequired(
        await sourceCopy(['error instanceof MemberDepartureOwnerRequiredError', 'false']),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each([
    ['leave', "new Set(['/organization/leave', remove])", 'new Set([remove])'],
    [
      'remove-member',
      "new Set(['/organization/leave', remove])",
      "new Set(['/organization/leave'])",
    ],
  ])(
    'detects omitted native %s interception with a real assertion failure',
    async (path, before, after) => {
      await expect(assertBlocked(await sourceCopy([before, after]), path)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  it('detects an omitted unavailable-service refusal with a real assertion failure', async () => {
    const before = `if (!leaveTeamMember) {
          throw new APIError('SERVICE_UNAVAILABLE', {
            code: 'TEAM_LEAVE_UNAVAILABLE',
            message: 'Safe team departure is unavailable. Try again later.',
          })
        }`
    await expect(
      assertUnavailable(
        await sourceCopy([before, 'if (!leaveTeamMember) return deleteOne(request)']),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each([
    ['stable refusal code', 'code: error.code,', "code: 'UNSTABLE_DEPARTURE_ERROR',"],
    ['affected items', 'impact: error.impact,', ''],
    ['handling steps', 'handling: error.handling,', ''],
  ])('detects omitted %s in the native error mapping', async (_label, before, after) => {
    await expect(assertBlocked(await sourceCopy([before, after]))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects native cleanup overwriting the personal fallback with a real assertion failure', async () => {
    await expect(
      assertFallback(
        await sourceCopy(['session.session.activeOrganizationId = fallback.organizationId', '']),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each(['leave', 'remove-member'])(
    'detects the trusted %s context fallback being omitted with a real assertion failure',
    async (path) => {
      const copy = await sourceCopy([
        'return endpoint as AuthMiddlewareContext',
        'return undefined',
      ])
      await expect(assertTrustedBlocked(copy, path)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
