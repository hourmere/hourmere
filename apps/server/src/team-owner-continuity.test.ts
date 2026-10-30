import '@hono/zod-openapi'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  type Auth,
  type AuthConfig,
  createAuth,
  createAuthPool,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { leaveTeamMember } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { openApiDocument, responseAndRequestStrictness } from './routes/test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43873'
const secret = 'synthetic-owner-continuity-secret-at-least-32-characters'
const signup = { mode: 'open', allowedDomains: [] } as const
type Action = 'leave' | 'demote' | 'remove' | 'REST leave' | 'REST remove'
type Replacement = readonly [string, string]
type Copies = Partial<
  Record<
    'policy' | 'removal' | 'owners' | 'auth' | 'leave' | 'context' | 'hooks' | 'removalRoute',
    Replacement[]
  >
>
type AuthFactory = (config: AuthConfig) => Auth
interface SourceCopy {
  createAuth: AuthFactory
  leaveTeamMember: typeof leaveTeamMember
  memberRemovalRoutes?: typeof memberRemovalRoutes
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

/** Rebuild every changed module so mutations reach the real native HTTP write. */
async function sourceCopy(mutations: Copies = {}): Promise<SourceCopy> {
  const copy = (name: keyof Copies, path: string, bindings: Record<string, string> = {}) => {
    const location = new URL(path, import.meta.url)
    let source = readFileSync(location, 'utf8')
    for (const [before, after] of mutations[name] ?? []) {
      expect(source.includes(before), `${name} mutation must match source`).toBe(true)
      source = source.replace(before, after)
    }
    return moduleUrl(source, location, bindings)
  }
  const owners = copy('owners', '../../../packages/auth/src/team-owner-continuity.ts')
  const removal = copy('removal', '../../../packages/auth/src/team-member-removal.ts', {
    './team-owner-continuity.ts': owners,
  })
  const policy = copy('policy', '../../../packages/auth/src/team-role-policy.ts', {
    './team-member-removal.ts': removal,
    './team-owner-continuity.ts': owners,
  })
  const context = copy('context', '../../../packages/auth/src/organization-context.ts')
  const hooks = copy('hooks', '../../../packages/auth/src/hooks.ts', {
    './organization-context.ts': context,
    './team-role-policy.ts': policy,
  })
  const auth = copy('auth', '../../../packages/auth/src/index.ts', {
    './team-role-policy.ts': policy,
    './organization-context.ts': context,
    './hooks.ts': hooks,
    './team-member-removal.ts': removal,
    './team-owner-continuity.ts': owners,
  })
  const service = copy('leave', '../../../packages/scheduling/src/member-leave.ts', {
    '@hourmere/auth': auth,
  })
  const removalRoute = copy('removalRoute', './routes/member-removal.ts', {
    '@hourmere/auth': auth,
  })
  const [copiedAuth, copiedService, copiedRemovalRoute] = await Promise.all([
    import(auth),
    import(service),
    import(removalRoute),
  ])
  return {
    createAuth: copiedAuth.createAuth,
    leaveTeamMember: copiedService.leaveTeamMember,
    memberRemovalRoutes: copiedRemovalRoute.memberRemovalRoutes,
  }
}

describe.skipIf(!serverUrl)('team owner continuity through HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool
  let auth: Auth
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_owners' })
    db = createDb(owned.pool)
    // Every fixture and in-memory source copy shares this bounded auth pool.
    pool = createAuthPool(owned.url, signup)
    const server = application()
    auth = server.auth
    app = server.app
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  function application(copy: SourceCopy = { createAuth, leaveTeamMember }) {
    const authentication = copy.createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        copy.leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
    })
    return {
      auth: authentication,
      app: createApp({
        authHandler: authentication.handler,
        resolveCaller: createCallerResolver({ auth: authentication, db }),
        checkDb: async () => {},
        publicUrl: origin,
        routes: [
          memberLeaveRoutes({ db }),
          (copy.memberRemovalRoutes ?? memberRemovalRoutes)({ db }),
        ],
      }),
    }
  }

  async function login(user: TestUser, organizationId: string) {
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

  async function fixture(secondRole = 'owner', firstRole = 'owner') {
    const first = await createTestUser(db, 'First team owner')
    const second = await createTestUser(db, 'Second team owner')
    const team = await createTestTeam(db, [
      { user: first, role: firstRole },
      { user: second, role: secondRole },
    ])
    const members = await db
      .selectFrom('auth.member')
      .select(['id', 'userId'])
      .where('organizationId', '=', team.id)
      .execute()
    const participant = async (user: TestUser) => ({
      user,
      memberId: members.find((member) => member.userId === user.id)?.id as string,
      login: await login(user, team.id),
    })
    return { teamId: team.id, first: await participant(first), second: await participant(second) }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  type Participant = Fixture['first']

  function request(f: Fixture, action: Action, actor: Participant, target = actor, server = app) {
    const headers = {
      cookie: actor.login.cookie,
      origin,
      'content-type': 'application/json',
      'x-expected-organization-id': f.teamId,
    }
    if (action === 'REST leave')
      return server.request(`/api/v1/teams/${f.teamId}/leave`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    if (action === 'REST remove')
      return server.request(`/api/v1/team/members/${target.user.id}/removal`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ teamId: f.teamId }),
      })
    const path =
      action === 'leave' ? 'leave' : action === 'demote' ? 'update-member-role' : 'remove-member'
    return server.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        organizationId: f.teamId,
        ...(action === 'demote' && { memberId: target.memberId, role: 'member' }),
        ...(action === 'remove' && { memberIdOrEmail: target.memberId }),
      }),
    })
  }

  async function memberships(f: Fixture) {
    return db
      .selectFrom('auth.member')
      .select(['userId', 'role'])
      .where('organizationId', '=', f.teamId)
      .orderBy('userId')
      .execute()
  }

  async function ownerRequired(response: Response, rest = false) {
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      [rest ? 'error' : 'code']: 'member_departure_owner_required',
      handling: { nextStep: 'add_another_owner_first' },
    })
  }

  it.each(['leave', 'remove', 'demote', 'REST leave', 'REST remove'] as const)(
    'keeps a sole team owner through %s with the stable refusal and a handling step',
    async (action) => {
      const f = await fixture('member')
      const before = await memberships(f)
      await ownerRequired(await request(f, action, f.first), action.startsWith('REST'))
      expect(await memberships(f)).toEqual(before)
    },
  )

  it.each(['leave', 'remove', 'demote', 'REST leave', 'REST remove'] as const)(
    'allows a single %s when another owner remains',
    async (action) => {
      const f = await fixture()
      const actor = action === 'remove' || action === 'REST remove' ? f.second : f.first
      expect((await request(f, action, actor, f.first)).status).toBe(200)
      const current = await memberships(f)
      expect(current.filter((member) => member.role === 'owner')).toEqual([
        { userId: f.second.user.id, role: 'owner' },
      ])
      expect(current.some((member) => member.userId === f.first.user.id)).toBe(action === 'demote')
    },
  )

  async function legacyOwnerChange(
    action: 'leave' | 'demote' | 'remove' | 'self remove',
    copy?: SourceCopy,
  ) {
    const role = ' member , owner '
    const f = await fixture(role)
    const server = copy ? application(copy).app : app
    const actualAction = action === 'self remove' ? 'remove' : action
    const target = action === 'remove' ? f.second : f.first
    const response = await request(f, actualAction, f.first, target, server)
    expect(response.status, 'native owner counts must recognize the second legacy owner').toBe(200)
    expect(
      await db
        .selectFrom('auth.member')
        .select('role')
        .where('organizationId', '=', f.teamId)
        .where('userId', '=', action === 'remove' ? f.first.user.id : f.second.user.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: action === 'remove' ? 'owner' : role })
  }

  it.each(['leave', 'demote', 'remove', 'self remove'] as const)(
    'recognizes a second legacy whitespace owner for native %s without rewriting stored roles',
    (action) => legacyOwnerChange(action),
  )

  it('detects omitted normalization of native early owner counts with a real HTTP assertion', async () => {
    const copy = await sourceCopy({
      policy: [
        [
          'const result = await findMany<T>(request)',
          'return findMany<T>(request); const result = await findMany<T>(request)',
        ],
      ],
    })
    await expect(legacyOwnerChange('leave', copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function selfRemovalProtection(copy?: SourceCopy) {
    const f = await fixture()
    const server = copy ? application(copy).app : app
    const eventId = await createFixtures(db).eventType(f.teamId, null, {
      title: 'Unresolved self-removal hosting',
      hosts: [{ userId: f.first.user.id }],
    })
    const booking = await db
      .insertInto('bookings')
      .values({
        organization_id: f.teamId,
        event_type_id: eventId,
        title: 'Retained self-removal booking',
        start_at: Temporal.Now.instant().add({ hours: 1 }).toString(),
        end_at: Temporal.Now.instant().add({ hours: 2 }).toString(),
        manage_token_hash: randomBytes(32),
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: booking.id, user_id: f.first.user.id })
      .execute()
    const before = await memberships(f)
    expect(
      (await request(f, 'REST remove', f.first, f.first, server)).status,
      'REST administrative removal cannot bypass safe self-departure',
    ).toBe(403)
    const native = await request(f, 'remove', f.first, f.first, server)
    expect(native.status).toBe(409)
    expect(await native.json()).toMatchObject({ code: 'member_departure_blocked' })
    expect(await memberships(f)).toEqual(before)
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', f.first.login.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: f.teamId })
    expect(
      await db
        .selectFrom('event_types')
        .select('is_active')
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ is_active: true })
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('id', '=', booking.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: booking.id, status: 'confirmed' })
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', booking.id)
        .execute(),
    ).toEqual([{ user_id: f.first.user.id }])
    expect(
      await db
        .selectFrom('organization_operations')
        .select('id')
        .where('organization_id', '=', f.teamId)
        .execute(),
    ).toEqual([])
  }

  it('retains membership, team context and hosting when an owner attempts REST self-removal', () =>
    selfRemovalProtection())

  it('detects omission of administrative self-removal protection in rebuilt HTTP routes', async () => {
    const copy = await sourceCopy({
      removal: [['if (member.userId === actor.userId) throw teamManagementDenied()', '']],
    })
    await expect(selfRemovalProtection(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each(['remove', 'REST remove', 'demote'] as const)(
    'prevents admins acting on an owner through %s',
    async (action) => {
      const f = await fixture('admin')
      const before = await memberships(f)
      expect((await request(f, action, f.second, f.first)).status).toBe(403)
      expect(await memberships(f)).toEqual(before)
    },
  )

  async function race(actions: readonly [Action, Action], copy?: SourceCopy) {
    const server = copy ? application(copy).app : app
    const f = await fixture()
    const firstElsewhere = { ...f.first, login: await login(f.first.user, f.teamId) }
    const holder = await owned.pool.connect()
    const pending: Promise<Response>[] = []
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.teamId])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      // Cross-target administrative mutations race with an independent loss of the other
      // owner: A removes B while A leaves; self-demotions let each owner act independently.
      const calls: readonly [Participant, Participant][] =
        actions[0] === 'remove' || actions[0] === 'REST remove'
          ? [
              [f.first, f.second],
              actions[1] === 'remove' ? [f.second, f.first] : [firstElsewhere, firstElsewhere],
            ]
          : actions[0] === 'demote' && actions[1] === 'demote'
            ? [
                [f.first, f.second],
                [f.second, f.first],
              ]
            : [
                [f.first, f.first],
                [f.second, f.second],
              ]
      for (const [index, action] of actions.entries()) {
        const [actor, target] = calls[index] as [Participant, Participant]
        pending.push(Promise.resolve(request(f, action, actor, target, server)))
      }
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ waiting: number }>(
            `WITH RECURSIVE blocked AS (
          SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname=current_database()
                ) SELECT count(*) FILTER (
          WHERE activity.query ILIKE '%"auth"."organization"%' AND activity.query ILIKE '%for update%'
        )::integer AS waiting FROM blocked JOIN pg_stat_activity activity USING (pid)`,
            [pid],
          )
          expect(
            result.rows[0]?.waiting,
            'both owner changes must wait for the organization lock',
          ).toBe(2)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('COMMIT')
      const responses = await Promise.all(pending)
      expect(
        responses.filter((response) => response.status === 200),
        'exactly one owner change succeeds',
      ).toHaveLength(1)
      expect(responses.every((response) => [200, 403, 409].includes(response.status))).toBe(true)
      const remaining = (await memberships(f)).filter((member) =>
        member.role
          .split(',')
          .map((role) => role.trim())
          .includes('owner'),
      )
      expect(remaining, 'the team retains exactly one owner').toHaveLength(1)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending)
    }
  }

  it.each([
    ['leave', 'leave'],
    ['leave', 'demote'],
    ['demote', 'demote'],
    ['remove', 'remove'],
    ['remove', 'leave'],
    ['REST leave', 'demote'],
    ['REST remove', 'leave'],
  ] as const)('serializes %s with %s under the same organization lock', (first, second) =>
    race([first, second]),
  )

  async function destructiveRefusal(copy?: SourceCopy, trusted = false) {
    const f = await fixture()
    const authentication = copy ? application(copy) : { auth, app }
    const id = await db
      .insertInto('bookings')
      .values({
        organization_id: f.teamId,
        event_type_id: null,
        title: 'Retained booking history',
        start_at: '2026-01-01T12:00:00Z',
        end_at: '2026-01-01T13:00:00Z',
        manage_token_hash: randomBytes(32),
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    if (trusted) {
      await expect(
        authentication.auth.api.deleteOrganization({
          headers: new Headers({ cookie: f.first.login.cookie }),
          body: { organizationId: f.teamId },
          asResponse: true,
        }),
      ).rejects.toMatchObject({
        status: 'FORBIDDEN',
        body: { code: 'TEAM_OPERATION_NOT_SUPPORTED' },
      })
    } else {
      const response = await authentication.app.request('/api/auth/organization/delete', {
        method: 'POST',
        headers: {
          cookie: f.first.login.cookie,
          origin,
          'content-type': 'application/json',
          'x-expected-organization-id': f.teamId,
        },
        body: JSON.stringify({ organizationId: f.teamId }),
      })
      expect(response.status, 'launch team deletion must be refused').toBe(403)
      expect(await response.json()).toMatchObject({ code: 'TEAM_OPERATION_NOT_SUPPORTED' })
    }
    expect(
      await db.selectFrom('bookings').select('id').where('id', '=', id.id).executeTakeFirst(),
    ).toEqual(id)
    expect((await memberships(f)).filter((member) => member.role === 'owner')).toHaveLength(2)
  }

  it('refuses native team deletion and retains booking history', () => destructiveRefusal())
  it('also refuses trusted native team deletion and retains booking history', () =>
    destructiveRefusal(undefined, true))

  it('refuses ownership transfer through the exposed native role endpoint', async () => {
    const f = await fixture('member')
    const before = await memberships(f)
    const response = await app.request('/api/auth/organization/update-member-role', {
      method: 'POST',
      headers: {
        cookie: f.first.login.cookie,
        origin,
        'content-type': 'application/json',
        'x-expected-organization-id': f.teamId,
      },
      body: JSON.stringify({
        organizationId: f.teamId,
        memberId: f.second.memberId,
        role: 'owner',
      }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
    expect(await memberships(f)).toEqual(before)
  })

  it.each(['leave', 'remove', 'demote', 'REST leave', 'REST remove'] as const)(
    'retains personal organization owner protection through %s',
    async (action) => {
      const f = await fixture()
      const teamId = f.first.user.principal.organization.id
      const member = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', teamId)
        .where('userId', '=', f.first.user.id)
        .executeTakeFirstOrThrow()
      const personal = {
        ...f,
        teamId,
        first: { ...f.first, memberId: member.id, login: await login(f.first.user, teamId) },
      }
      const before = await memberships(personal)
      const response = await request(personal, action, personal.first)
      expect(response.status).toBe(action === 'remove' ? 400 : 403)
      expect(await response.json()).toMatchObject(
        action === 'remove'
          ? { code: 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER' }
          : action === 'leave'
            ? { code: 'PERSONAL_ORGANIZATION' }
            : action === 'demote'
              ? { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }
              : { error: 'team_management_access_denied' },
      )
      expect(await memberships(personal)).toEqual(before)
    },
  )

  it('runs the same race and deletion assertions against unchanged rebuilt source modules', async () => {
    const copy = await sourceCopy()
    await race(['leave', 'demote'], copy)
    await race(['remove', 'leave'], copy)
    await destructiveRefusal(copy)
  })

  async function freshDemotionCount(copy: SourceCopy) {
    const f = await fixture()
    const holder = await owned.pool.connect()
    const server = application(copy).app
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.teamId])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      pending = Promise.resolve(request(f, 'demote', f.second, f.second, server))
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
        ) AS blocked`,
            [pid],
          )
          expect(result.rows[0]?.blocked).toBe(true)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('UPDATE auth.member SET role=$1 WHERE id=$2', ['member', f.first.memberId])
      await holder.query('COMMIT')
      await ownerRequired(await pending)
      expect((await memberships(f)).filter((member) => member.role === 'owner')).toEqual([
        { userId: f.second.user.id, role: 'owner' },
      ])
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  }

  it('recounts demotion owners after the shared organization lock in rebuilt sources', async () => {
    await freshDemotionCount(await sourceCopy())
  })

  it('detects moving the demotion owner count before its lock with a real HTTP assertion', async () => {
    const copy = await sourceCopy({
      policy: [
        [
          'const { facts } = await manager(ctx, targetDb, lock)',
          `const targetBeforeLock = lock ? await targetDb.selectFrom('auth.member').select('userId').where('id', '=', body(ctx).memberId).executeTakeFirst() : undefined
    const ownersBeforeLock = targetBeforeLock ? await targetDb.selectFrom('auth.member').select('role').where('organizationId', '=', body(ctx).organizationId).where('userId', '!=', targetBeforeLock.userId).execute() : []
    const { facts } = await manager(ctx, targetDb, lock)`,
        ],
        [
          'await assertTeamOwnerRemains(targetDb, facts.organizationId, target.userId)',
          "if (!ownersBeforeLock.some((member) => teamRoles(member.role).includes('owner'))) throw new MemberDepartureOwnerRequiredError()",
        ],
      ],
    })
    await expect(freshDemotionCount(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects an omitted demotion owner check with a real HTTP assertion', async () => {
    const copy = await sourceCopy({
      policy: [['await assertTeamOwnerRemains(targetDb, facts.organizationId, target.userId)', '']],
    })
    await expect(freshDemotionCount(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects reallowing team deletion with a real HTTP assertion', async () => {
    const copy = await sourceCopy({
      context: [["if (ctx.path === '/organization/delete')", 'if (false)']],
    })
    await expect(destructiveRefusal(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects omitted removal organization locks in rebuilt modules with a real HTTP assertion', async () => {
    const copy = await sourceCopy({
      policy: [
        [
          `const { actor, member, principal, expectedOrganizationId } = await removal(
              ctx,
              trx,
              true,
            )`,
          `const { actor, member, principal, expectedOrganizationId } = await removal(
              ctx,
              trx,
              false,
            )`,
        ],
      ],
      removal: [
        [
          'checkTeamManagementAccess(trx, principal, input.teamId, true, {',
          'checkTeamManagementAccess(trx, principal, input.teamId, false, {',
        ],
      ],
    })
    await expect(race(['remove', 'leave'], copy)).rejects.toThrow(
      'both owner changes must wait for the organization lock',
    )
  })

  it('publishes owner continuity refusals and open handling objects additively in OpenAPI', async () => {
    const document = await openApiDocument(app)
    const paths = ['/api/v1/teams/{teamId}/leave', '/api/v1/team/members/{memberUserId}/removal']
    expect(responseAndRequestStrictness(document, paths).closedResponses).toEqual([])
    for (const path of paths) {
      const response = document.paths[path]?.post?.responses?.['409']
      expect(response).toBeDefined()
      const schema =
        response && 'content' in response
          ? response.content?.['application/json']?.schema
          : undefined
      const fragments = Array.isArray(schema?.allOf) ? schema.allOf : [schema]
      const fragment = fragments.find(
        (item) => item && typeof item === 'object' && 'properties' in item,
      )
      expect(fragment).toMatchObject({
        type: 'object',
        properties: {
          handling: {
            type: 'object',
            properties: { nextStep: { type: 'string', enum: ['add_another_owner_first'] } },
          },
        },
      })
      expect(response && 'description' in response ? response.description : undefined).toContain(
        'member_departure_owner_required',
      )
    }
  })

  it('detects omission of native sole-owner leave error normalization with a real HTTP assertion', async () => {
    const copy = await sourceCopy({
      policy: [['if (response.status !== 400) return response', 'return response']],
    })
    const f = await fixture('member')
    await expect(
      ownerRequired(await request(f, 'leave', f.first, f.first, application(copy).app)),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
