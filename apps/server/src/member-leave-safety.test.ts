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
  ensurePersonalOrganization,
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
  TeamManagementError,
  teamRoles,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  DomainError,
  getTeamMemberDepartureImpact,
  leaveTeamMember,
  MemberDepartureImpactSchema,
  MemberRemovalHandlingSchema,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { ErrorBody, errorResponses, json, serviceContext } from './openapi.ts'
import { DepartureImpact, memberDepartureImpactRoutes } from './routes/member-departure-impact.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { openApiDocument, responseAndRequestStrictness } from './routes/test-app.ts'
import { productRoutes } from './server.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextWriteLock,
  teamManagementSessionCaller,
} from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4391'
const secret = 'synthetic-safe-leave-session-secret-000000000000000'
const signup = { mode: 'open', allowedDomains: [] } as const
const path = '/api/v1/teams/{teamId}/leave'
const handling = {
  eventTypes: 'ask_admin_to_replace_or_remove_host',
  futureBookings: 'coordinate_cancellation',
  inProgressBookings: 'wait_until_end_or_coordinate_offline',
}
type Departure = typeof leaveTeamMember
type Replacement = readonly [string, string]

/** Compile a disposable in-memory copy, never changing the checked-in protection. */
function serviceCopy(replacements: Replacement[] = []): Departure {
  let source = readFileSync('packages/scheduling/src/member-leave.ts', 'utf8')
  for (const replacement of replacements) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    checkTeamManagementAccess,
    ensurePersonalOrganization,
    MemberDepartureBlockedError,
    MemberDepartureOwnerRequiredError,
    TeamManagementError,
    teamRoles,
    DomainError,
    getTeamMemberDepartureImpact,
  }
  return new Function(...Object.keys(bindings), `${source}; return leaveTeamMember`)(
    ...Object.values(bindings),
  ) as Departure
}

function routeCopy(depart: Departure = leaveTeamMember, replacement?: Replacement) {
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
    leaveTeamMember: depart,
    MemberDepartureImpactSchema,
    ErrorBody,
    errorResponses,
    json,
    serviceContext,
    EXPECTED_ORGANIZATION_HEADER,
    organizationContextWriteLock,
    teamManagementSessionCaller,
    DepartureImpact,
  }
  return new Function(...Object.keys(bindings), `${source}; return memberLeaveRoutes`)(
    ...Object.values(bindings),
  ) as typeof memberLeaveRoutes
}

describe.skipIf(!serverUrl)('safe team departure through HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'safe_leave' })
    db = createDb(owned.pool)
    // One reusable auth pool (including its two lock connections) for the entire file.
    authPool = createAuthPool(owned.url, signup)
    auth = authentication()
    app = application(auth)
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function authentication(withLeave = true, depart: Departure = leaveTeamMember) {
    return createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
      ...(withLeave && {
        leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
          depart(
            { db, principal, now: () => Temporal.Now.instant() },
            { teamId, expectedOrganizationId },
          ),
      }),
    })
  }

  function application(
    authentication: Auth,
    production = false,
    departureRoutes = memberLeaveRoutes,
    routeDb = db,
  ) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: authentication.handler,
      resolveCaller: createCallerResolver({ auth: authentication, db }),
      routes: production
        ? productRoutes({ db, socialProviders: {} })
        : [memberDepartureImpactRoutes({ db }), departureRoutes({ db: routeDb })],
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
      id: row.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(role = 'member') {
    const actor = await createTestUser(db, 'Departing member')
    const survivor = await createTestUser(db, 'Continuing owner')
    const team = await createTestTeam(db, [
      { user: actor, role },
      { user: survivor, role: 'owner' },
    ])
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', actor.id)
      .executeTakeFirstOrThrow()
    const login = await session(actor, team.id)
    return { actor, survivor, team, memberId: member.id, login }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function headers(f: Fixture, expected: string | null = f.team.id) {
    return {
      cookie: f.login.cookie,
      origin,
      'content-type': 'application/json',
      ...(expected === null ? {} : { 'x-expected-organization-id': expected }),
    }
  }

  function leave(f: Fixture, target = app, expected: string | null = f.team.id) {
    return target.request(`/api/v1/teams/${f.team.id}/leave`, {
      method: 'POST',
      headers: headers(f, expected),
      body: '{}',
    })
  }

  function native(
    f: Fixture,
    action: 'leave' | 'remove-member' = 'leave',
    memberIdOrEmail = f.memberId,
    target = app,
  ) {
    return target.request(`/api/auth/organization/${action}`, {
      method: 'POST',
      headers: headers(f),
      body: JSON.stringify({
        organizationId: f.team.id,
        ...(action === 'remove-member' && { memberIdOrEmail }),
      }),
    })
  }

  async function impact(f: Fixture) {
    const response = await app.request(
      `/api/v1/team/members/${f.actor.id}/departure-impact?teamId=${f.team.id}`,
      { headers: { cookie: f.login.cookie } },
    )
    expect(response.status).toBe(200)
    return MemberDepartureImpactSchema.parse(await response.json())
  }

  async function event(
    f: Fixture,
    kind: 'individual' | 'collective' | 'round_robin' = 'individual',
    actorIsHost = true,
    isActive = true,
  ) {
    const id = await createFixtures(db).eventType(f.team.id, null, {
      title: `${kind} departure consultation`,
      isActive,
      hosts: (actorIsHost ? [f.actor.id] : [f.survivor.id]).map((userId) => ({ userId })),
    })
    if (kind !== 'individual') {
      await db
        .insertInto('event_type_hosts')
        .values({ event_type_id: id, user_id: f.survivor.id })
        .execute()
      await db
        .updateTable('event_types')
        .set({ scheduling_type: kind })
        .where('id', '=', id)
        .execute()
    }
    return id
  }

  async function booking(
    f: Fixture,
    state: 'future' | 'in_progress' | 'ended' | 'cancelled' = 'future',
    eventId?: string,
  ) {
    const now = Temporal.Now.instant()
    const start = now.add({ minutes: state === 'future' || state === 'cancelled' ? 60 : -30 })
    const end = now.add({ minutes: state === 'ended' ? -1 : 90 })
    const id = randomUUID()
    await db
      .insertInto('bookings')
      .values({
        id,
        organization_id: f.team.id,
        event_type_id: eventId ?? null,
        start_at: start.toString(),
        end_at: end.toString(),
        title: 'Departure booking',
        manage_token_hash: randomBytes(32),
        source: 'web',
        status: state === 'cancelled' ? 'cancelled' : 'confirmed',
        cancelled_at: state === 'cancelled' ? new Date() : null,
      })
      .execute()
    await db.insertInto('booking_hosts').values({ booking_id: id, user_id: f.actor.id }).execute()
    return id
  }

  async function unchanged(f: Fixture) {
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('id', '=', f.memberId)
        .executeTakeFirst(),
    ).toEqual({ id: f.memberId })
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', f.login.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: f.team.id })
    expect(
      await db
        .selectFrom('organization_operations')
        .select('id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([])
  }

  async function blocked(response: Response, f: Fixture, nativeResponse = false) {
    expect(response.status).toBe(409)
    const body = z.looseObject({ impact: z.unknown() }).parse(await response.json())
    expect(body).toMatchObject({
      [nativeResponse ? 'code' : 'error']: 'member_departure_blocked',
      message: expect.any(String),
      handling,
    })
    const result = MemberDepartureImpactSchema.parse(body.impact)
    expect(result.eventTypes.totalCount + result.bookings.totalCount).toBeGreaterThan(0)
    await unchanged(f)
    return result
  }

  async function departed(f: Fixture) {
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('id', '=', f.memberId)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', f.login.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: f.actor.principal.organization.id })
    const me = await app.request('/api/v1/me', { headers: { cookie: f.login.cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      organization: { id: f.actor.principal.organization.id, personal: true },
    })
    expect(
      await db
        .selectFrom('organization_operations')
        .select(['operation', 'actor_user_id', 'target_user_id'])
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([
      { operation: 'member_removed', actor_user_id: f.actor.id, target_user_id: f.actor.id },
    ])
  }

  it.each([
    ['individual', 'sole_host'],
    ['round_robin', 'round_robin_pool_member'],
    ['collective', 'collective_required_host'],
  ] as const)('refuses departure for an affected %s event type', async (kind, reason) => {
    const f = await fixture()
    const id = await event(f, kind)
    const result = await blocked(await leave(f), f)
    expect(result.eventTypes.data).toEqual([expect.objectContaining({ id, reason })])
    expect(result.bookings.totalCount).toBe(0)
  })

  it('requires an inactive affected event type to be repaired too', async () => {
    const f = await fixture()
    const id = await event(f, 'individual', true, false)
    const result = await blocked(await leave(f), f)
    expect(result.eventTypes.data).toEqual([
      expect.objectContaining({ id, reason: 'sole_host', isActive: false }),
    ])
  })

  it.each(['future', 'in_progress'] as const)(
    'refuses departure for a %s saved booking host',
    async (state) => {
      const f = await fixture()
      const eventId = await event(f, 'individual', false)
      const id = await booking(f, state, eventId)
      const result = await blocked(await leave(f), f)
      expect(result.eventTypes.totalCount).toBe(0)
      expect(result.bookings.data).toEqual([
        expect.objectContaining({
          id,
          inProgress: state === 'in_progress',
          handling:
            state === 'in_progress'
              ? 'wait_until_end_or_coordinate_offline'
              : 'coordinate_cancellation',
        }),
      ])
    },
  )

  it.each(['member', 'admin', 'member,owner'])(
    'leaves with no impact as %s and falls back to personal space',
    async (role) => {
      const f = await fixture(role)
      const response = await leave(f)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ organizationId: f.actor.principal.organization.id })
      await departed(f)
      expect(
        await db
          .selectFrom('auth.member')
          .select('role')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.survivor.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ role: 'owner' })
    },
  )

  it('ignores ended and cancelled bookings while preserving their history', async () => {
    const f = await fixture()
    const ended = await booking(f, 'ended')
    const cancelled = await booking(f, 'cancelled')
    expect((await leave(f)).status).toBe(200)
    await departed(f)
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('booking_id')
        .where('booking_id', 'in', [ended, cancelled])
        .where('user_id', '=', f.actor.id)
        .execute(),
    ).toHaveLength(2)
  })

  it('rejects an old team tab after departure without writing in personal or team space', async () => {
    const f = await fixture('admin')
    const production = application(auth, true)
    expect((await leave(f, production)).status).toBe(200)
    const repeated = await leave(f, production)
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toMatchObject({ error: 'organization_context_changed' })
    const response = await production.request('/api/v1/event-types', {
      method: 'POST',
      headers: headers(f),
      body: JSON.stringify({ slug: 'stale-team-draft', title: 'Stale draft', durationMinutes: 30 }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
    expect(
      await db
        .selectFrom('event_types')
        .select('id')
        .where('slug', '=', 'stale-team-draft')
        .execute(),
    ).toEqual([])
  })

  it.each([null, 'another-team'])(
    'refuses a missing or mismatched expected organization (%s)',
    async (expected) => {
      const f = await fixture()
      const response = await leave(f, app, expected === null ? null : randomUUID())
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
      await unchanged(f)
    },
  )

  it('requires a same-origin browser session and rejects API keys', async () => {
    const f = await fixture()
    const anonymous = await app.request(`/api/v1/teams/${f.team.id}/leave`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(anonymous.status).toBe(403)
    expect(await anonymous.json()).toEqual({ error: 'team_management_access_denied' })
    expect(anonymous.headers.has('www-authenticate')).toBe(false)
    const foreign = await app.request(`/api/v1/teams/${f.team.id}/leave`, {
      method: 'POST',
      headers: { ...headers(f), origin: 'https://foreign.example' },
      body: '{}',
    })
    expect(foreign.status).toBe(403)
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const bearer = await app.request(`/api/v1/teams/${f.team.id}/leave`, {
      method: 'POST',
      headers: { ...headers(f), authorization: `Bearer ${key.key}` },
      body: '{}',
    })
    expect(bearer.status).toBe(403)
    expect(await bearer.json()).toEqual({ error: 'team_management_access_denied' })
    await unchanged(f)
  })

  it.each(['leave', 'remove-member'] as const)(
    'prevents the native %s path from bypassing affected events',
    async (action) => {
      const f = await fixture('admin')
      const id = await event(f)
      const result = await blocked(await native(f, action), f, true)
      expect(result.eventTypes.data.map((item) => item.id)).toEqual([id])
    },
  )

  it('also protects native self-removal addressed by email', async () => {
    const f = await fixture('admin')
    const id = await booking(f)
    const result = await blocked(await native(f, 'remove-member', f.actor.email), f, true)
    expect(result.bookings.data.map((item) => item.id)).toEqual([id])
  })

  it.each(['leave', 'remove-member'] as const)(
    'uses safe departure for an impact-free native %s request',
    async (action) => {
      const f = await fixture('admin')
      const response = await native(f, action)
      expect(response.status).toBe(200)
      await departed(f)
    },
  )

  it('routes native self-removal by an owner to safe leave and preserves its personal fallback', async () => {
    const f = await fixture('owner')
    expect((await native(f, 'remove-member')).status).toBe(200)
    await departed(f)
    expect(
      await db
        .selectFrom('auth.member')
        .select('role')
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.survivor.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: 'owner' })
  })

  it('routes native removal of another member to checked removal with immediate revocation', async () => {
    const f = await fixture('admin')
    const eventId = await event(f)
    const bookingId = await booking(f, 'future', eventId)
    const managerLogin = await session(f.survivor, f.team.id)
    const production = application(auth, true)
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const bearer = { authorization: `Bearer ${key.key}` }
    expect((await production.request('/api/v1/me', { headers: bearer })).status).toBe(200)

    const response = await native(
      { ...f, login: managerLogin },
      'remove-member',
      f.memberId,
      production,
    )
    expect(response.status).toBe(200)
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('id', '=', f.memberId)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('event_types')
        .select('is_active')
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ is_active: false })
    expect(
      await db
        .selectFrom('organization_operations')
        .select(['operation', 'actor_user_id', 'target_user_id'])
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([
      { operation: 'member_removed', actor_user_id: f.survivor.id, target_user_id: f.actor.id },
    ])
    const revoked = await production.request('/api/v1/me', { headers: bearer })
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: 'unauthorized' })
    const staleWrite = await production.request(`/api/v1/event-types/${eventId}`, {
      method: 'PATCH',
      headers: headers(f),
      body: JSON.stringify({ title: 'Removed administrator write' }),
    })
    expect(staleWrite.status).toBe(409)
    expect(await staleWrite.json()).toMatchObject({ error: 'organization_context_changed' })
    const handlingResponse = await production.request(
      `/api/v1/team/members/${f.actor.id}/removal-handling?teamId=${f.team.id}`,
      { headers: { cookie: managerLogin.cookie } },
    )
    expect(handlingResponse.status).toBe(200)
    const removal = MemberRemovalHandlingSchema.parse(await handlingResponse.json())
    expect(removal).toMatchObject({ memberUserId: f.actor.id, reason: 'member_removed' })
    expect(removal.bookings.data.map(({ id }) => id)).toEqual([bookingId])
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', bookingId)
        .execute(),
    ).toEqual([{ user_id: f.actor.id }])
  })

  it('protects native removal before target lookups with uniform real and missing target denials', async () => {
    const f = await fixture()
    const other = await createTestUser(db, 'Other member')
    const member = await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: other.id,
        role: 'member',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const targets = [member.id, other.email, randomUUID(), 'missing-member@example.com']
    const lookup = vi.spyOn((await auth.$context).adapter, 'findOne')
    try {
      for (const target of targets) {
        const response = await native(f, 'remove-member', target)
        expect(response.status, 'native removal must deny before looking up its target').toBe(403)
        expect(await response.json()).toEqual({
          code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
          message: 'team_management_access_denied',
        })
      }
      expect(
        lookup.mock.calls.filter(([request]) =>
          request.where?.some(
            (condition) => typeof condition.value === 'string' && targets.includes(condition.value),
          ),
        ),
        'denied native targets must not reach the native adapter lookup',
      ).toEqual([])
      await unchanged(f)
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('id', '=', member.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(member)
    } finally {
      lookup.mockRestore()
    }
  })

  it('accepts uppercase organization UUIDs for native departure and falls back to personal space', async () => {
    const f = await fixture()
    const organizationId = f.team.id.toUpperCase()
    const response = await app.request('/api/auth/organization/leave', {
      method: 'POST',
      headers: headers(f, organizationId),
      body: JSON.stringify({ organizationId }),
    })
    expect(response.status).toBe(200)
    await departed(f)
  })

  it('fails closed when native departure has no injected impact service', async () => {
    const f = await fixture()
    const unconfigured = application(authentication(false))
    const response = await native(f, 'leave', f.memberId, unconfigured)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'TEAM_LEAVE_UNAVAILABLE' })
    await unchanged(f)
  })

  it('keeps a personal organization owner even when a legacy second owner exists', async () => {
    const f = await fixture()
    const personalId = f.actor.principal.organization.id
    await db
      .insertInto('auth.member')
      .values({
        organizationId: personalId,
        userId: f.survivor.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const login = await session(f.actor, personalId)
    const response = await app.request('/api/auth/organization/leave', {
      method: 'POST',
      headers: { ...headers(f, personalId), cookie: login.cookie },
      body: JSON.stringify({ organizationId: personalId }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'PERSONAL_ORGANIZATION' })
    expect(
      await db
        .selectFrom('auth.member')
        .select('role')
        .where('organizationId', '=', personalId)
        .where('userId', '=', f.actor.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: 'owner' })
  })

  async function waitForBlocker(holder: pg.PoolClient) {
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT FROM pg_stat_activity
           WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,
          [pid],
        )
        expect(result.rows[0]?.blocked).toBe(true)
      },
      { timeout: 3000, interval: 10 },
    )
  }

  it('rechecks the sole-owner refusal under the organization lock for native self-removal', async () => {
    const f = await fixture('owner')
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.team.id])
      pending = Promise.resolve(native(f, 'remove-member'))
      // The native two-owner precheck has passed before the leave service waits here.
      await waitForBlocker(holder)
      await holder.query(
        'UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3',
        ['member', f.team.id, f.survivor.id],
      )
      await holder.query('COMMIT')
      const response = await pending
      expect(response.status, 'self-removal must retain the final owner after waiting').toBe(409)
      expect(await response.json()).toEqual({
        code: 'member_departure_owner_required',
        message: 'Another owner is needed before you can leave.',
        handling: {
          owner: 'another_owner_is_needed_before_you_can_leave',
          nextStep: 'add_another_owner_first',
        },
      })
      await unchanged(f)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  })

  async function verifySoleOwner(depart: Departure = leaveTeamMember, otherRole = 'member') {
    const f = await fixture('member, owner')
    await db
      .updateTable('auth.member')
      .set({ role: otherRole })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.survivor.id)
      .execute()
    const response = await leave(f, application(auth, false, routeCopy(depart)))
    expect(response.status, 'the final owner must retain membership').toBe(409)
    expect(await response.json()).toEqual({
      error: 'member_departure_owner_required',
      message: 'Another owner is needed before you can leave.',
      handling: {
        owner: 'another_owner_is_needed_before_you_can_leave',
        nextStep: 'add_another_owner_first',
      },
    })
    await unchanged(f)
  }

  it.each(['member', 'coowner', 'member,ownerish'])(
    'refuses the sole REST owner when another member has role %s',
    (role) => verifySoleOwner(leaveTeamMember, role),
  )

  it.each(['owner', 'member, owner'])(
    'refuses the sole native owner with stored role %s',
    async (role) => {
      const f = await fixture(role)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.survivor.id)
        .execute()
      const response = await native(f)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: 'member_departure_owner_required',
        handling: { nextStep: 'add_another_owner_first' },
      })
      await unchanged(f)
    },
  )

  it.each(['REST', 'native'] as const)(
    'allows an impact-free %s owner to leave while retaining another owner',
    async (entry) => {
      const f = await fixture('owner')
      const response = await (entry === 'REST' ? leave(f) : native(f))
      expect(response.status).toBe(200)
      await departed(f)
    },
  )

  it('recognizes a surviving owner among trimmed exact role tokens', async () => {
    const f = await fixture('owner')
    await db
      .updateTable('auth.member')
      .set({ role: 'member, owner ' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.survivor.id)
      .execute()
    expect((await leave(f)).status).toBe(200)
    await departed(f)
  })

  it.each(['REST', 'native'] as const)(
    'still refuses a %s owner with another owner when departure impact remains',
    async (entry) => {
      const f = await fixture('owner')
      await event(f)
      await blocked(await (entry === 'REST' ? leave(f) : native(f)), f, entry === 'native')
    },
  )

  async function verifyOwnerRace(
    entries: readonly ['REST' | 'native', 'REST' | 'native'],
    depart: Departure = leaveTeamMember,
  ) {
    const target = application(authentication(true, depart), false, routeCopy(depart))
    const first = await fixture('owner')
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', first.team.id)
      .where('userId', '=', first.survivor.id)
      .executeTakeFirstOrThrow()
    const second: Fixture = {
      actor: first.survivor,
      survivor: first.actor,
      team: first.team,
      memberId: member.id,
      login: await session(first.survivor, first.team.id),
    }
    const holder = await owned.pool.connect()
    const pending: Promise<Response>[] = []
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [first.team.id])
      for (const [index, f] of [first, second].entries()) {
        pending.push(
          Promise.resolve(
            entries[index] === 'REST' ? leave(f, target) : native(f, 'leave', f.memberId, target),
          ),
        )
      }
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ waiting: number }>(
            `WITH RECURSIVE blocked AS (
               SELECT pid FROM pg_stat_activity
               WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
               UNION
               SELECT activity.pid FROM pg_stat_activity activity
               JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))
               WHERE activity.datname=current_database()
             ) SELECT count(*)::integer AS waiting FROM blocked`,
            [pid],
          )
          expect(
            result.rows[0]?.waiting,
            'both departures must wait for the organization lock',
          ).toBe(2)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('COMMIT')
      const responses = await Promise.all(pending)
      expect(
        responses.map((response) => response.status).sort(),
        'exactly one owner may leave',
      ).toEqual([200, 409])
      const loserIndex = responses.findIndex((response) => response.status === 409)
      const loser = [first, second][loserIndex] as Fixture
      expect(await responses[loserIndex]?.json()).toMatchObject({
        [entries[loserIndex] === 'REST' ? 'error' : 'code']: 'member_departure_owner_required',
        message: 'Another owner is needed before you can leave.',
        handling: {
          owner: 'another_owner_is_needed_before_you_can_leave',
          nextStep: 'add_another_owner_first',
        },
      })
      expect(
        await db
          .selectFrom('auth.member')
          .select(['userId', 'role'])
          .where('organizationId', '=', first.team.id)
          .execute(),
      ).toEqual([{ userId: loser.actor.id, role: 'owner' }])
      expect(
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', loser.login.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ activeOrganizationId: first.team.id })
      await departed([first, second][1 - loserIndex] as Fixture)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending)
    }
  }

  it.each([
    ['REST', 'REST'],
    ['native', 'native'],
    ['REST', 'native'],
  ] as const)('serializes two owners leaving through %s and %s', (first, second) =>
    verifyOwnerRace([first, second]),
  )

  it.each<Replacement>([
    ["if (actor.role === 'owner')", 'if (false)'],
    [".where('userId', '!=', actor.userId)", ''],
    [".where('organizationId', '=', actor.organizationId)", ''],
    ["teamRoles(member.role).includes('owner')", "member.role.includes('owner')"],
  ])('detects a broken owner count (%s) with real HTTP assertions', async (from, to) => {
    await expect(verifySoleOwner(serviceCopy([[from, to]]), 'coowner')).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('passes sole-owner assertions with an unmodified service source copy', async () => {
    await verifySoleOwner(serviceCopy())
  })

  it.each(['REST', 'native'] as const)(
    'detects counting owners before the organization lock through %s',
    async (entry) => {
      const copy = serviceCopy([
        [
          'const actor = await checkTeamManagementAccess(',
          "const ownerSnapshot = await trx.selectFrom('auth.member').select('role').where('organizationId', '=', input.teamId).where('userId', '!=', principal.user.id).execute()\n      const actor = await checkTeamManagementAccess(",
        ],
        [
          "const otherMembers = await trx\n          .selectFrom('auth.member')\n          .select('role')\n          .where('organizationId', '=', actor.organizationId)\n          .where('userId', '!=', actor.userId)\n          .execute()",
          'const otherMembers = ownerSnapshot',
        ],
      ])
      await expect(verifyOwnerRace([entry, entry], copy)).rejects.toThrow(
        'exactly one owner may leave',
      )
    },
  )

  async function verifyBoundSwitchOrdering(factory = memberLeaveRoutes) {
    const f = await fixture()
    const other = await createTestTeam(db, [
      { user: f.actor, role: 'member' },
      { user: f.survivor, role: 'owner' },
    ])
    const inserted = new WeakSet<object>()
    const resume = Promise.withResolvers<void>()
    let paused = false
    const observed = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          node.kind === 'InsertQueryNode' &&
          node.into?.table.identifier.name === 'organization_operations'
        )
          inserted.add(queryId)
        return node
      },
      async transformResult({ result, queryId }) {
        if (inserted.has(queryId)) {
          // Membership removal and its real operation INSERT have run, but this
          // transaction still holds the session lock and has not committed its fallback.
          paused = true
          await resume.promise
        }
        return result
      },
    })
    const target = application(auth, false, factory, observed)
    let leaving: Promise<Response> | undefined
    let switching: Promise<Response> | undefined
    try {
      leaving = Promise.resolve(leave(f, target))
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000, interval: 10 })
      switching = Promise.resolve(
        target.request('/api/auth/organization/set-active', {
          method: 'POST',
          headers: headers(f),
          body: JSON.stringify({ organizationId: other.id }),
        }),
      )
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ blocked: boolean }>(`SELECT EXISTS (
            SELECT FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND (query LIKE '%pg_advisory_xact_lock%'
              OR query ILIKE '%update%session%')
          ) AS blocked`)
          expect(result.rows[0]?.blocked).toBe(true)
        },
        { timeout: 3000, interval: 10 },
      )
      resume.resolve()
      const [left, switched] = await Promise.all([leaving, switching])
      expect(left.status).toBe(200)
      expect(switched.status, 'a bound switch must reject the departed source organization').toBe(
        409,
      )
      expect(await switched.json()).toMatchObject({ code: 'ORGANIZATION_CONTEXT_CHANGED' })
      await departed(f)
    } finally {
      resume.resolve()
      await Promise.allSettled([leaving, switching].filter(Boolean))
    }
  }

  it('orders a bound native switch after REST departure and preserves the personal fallback', async () => {
    await verifyBoundSwitchOrdering()
  })

  it('detects omitting the departure transaction context lock with a real HTTP race assertion', async () => {
    const copy = serviceCopy([['await ctx.authorizeOrganizationWrite?.(trx, input.teamId)', '']])
    await expect(verifyBoundSwitchOrdering(routeCopy(copy))).rejects.toThrow(
      'a bound switch must reject the departed source organization',
    )
  })

  it('detects omitting the route context lock wiring with a real HTTP race assertion', async () => {
    const copy = routeCopy(leaveTeamMember, [
      'authorizeOrganizationWrite: organizationContextWriteLock(c.var.principal),',
      '',
    ])
    await expect(verifyBoundSwitchOrdering(copy)).rejects.toThrow(
      'a bound switch must reject the departed source organization',
    )
  })

  it('promptly refuses REST departure while a native switch holds the context lock', async () => {
    const f = await fixture()
    const other = await createTestTeam(db, [
      { user: f.actor, role: 'member' },
      { user: f.survivor, role: 'owner' },
    ])
    const adapter = (await auth.$context).adapter
    const original = adapter.update.bind(adapter)
    const resume = Promise.withResolvers<void>()
    let paused = false
    const spy = vi.spyOn(adapter, 'update')
    spy.mockImplementation((async (request: Parameters<typeof original>[0]) => {
      if (request.model === 'session' && request.update.activeOrganizationId === other.id) {
        paused = true
        await resume.promise
      }
      return original(request)
    }) as typeof original)
    let switching: Promise<Response> | undefined
    let leaving: Promise<Response> | undefined
    try {
      switching = Promise.resolve(
        app.request('/api/auth/organization/set-active', {
          method: 'POST',
          headers: headers(f),
          body: JSON.stringify({ organizationId: other.id }),
        }),
      )
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000, interval: 10 })
      let finished = false
      leaving = Promise.resolve(leave(f)).then((response) => {
        finished = true
        return response
      })
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1500, interval: 10 })
      const response = await leaving
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
      await unchanged(f)
      resume.resolve()
      expect((await switching).status).toBe(200)
    } finally {
      resume.resolve()
      await Promise.allSettled([leaving, switching].filter(Boolean))
      spy.mockRestore()
    }
  })

  async function verifyRace(
    entry: 'session route' | 'native leave',
    change: 'booking' | 'host assignment',
    depart: Departure = leaveTeamMember,
  ) {
    const target = application(authentication(true, depart), false, routeCopy(depart))
    const f = await fixture()
    const eventId = await event(f, 'individual', false)
    const preview = await impact(f)
    expect(preview.eventTypes.totalCount).toBe(0)
    expect(preview.bookings.totalCount).toBe(0)
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.team.id])
      pending = Promise.resolve(
        entry === 'session route' ? leave(f, target) : native(f, 'leave', f.memberId, target),
      )
      await waitForBlocker(holder)
      let bookingId: string | undefined
      if (change === 'booking') {
        bookingId = randomUUID()
        await holder.query(
          `INSERT INTO bookings (id, organization_id, event_type_id, start_at, end_at, title,
             manage_token_hash, source) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour',
             clock_timestamp()+interval '2 hours','Concurrent booking',$4,'web')`,
          [bookingId, f.team.id, eventId, randomBytes(32)],
        )
        await holder.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [
          bookingId,
          f.actor.id,
        ])
      } else {
        await holder.query('DELETE FROM event_type_hosts WHERE event_type_id=$1', [eventId])
        await holder.query('INSERT INTO event_type_hosts (event_type_id,user_id) VALUES ($1,$2)', [
          eventId,
          f.actor.id,
        ])
      }
      await holder.query('COMMIT')
      const result = await blocked(await pending, f, entry === 'native leave')
      if (change === 'booking') {
        expect(result.bookings.data.map((item) => item.id)).toEqual([bookingId])
      } else {
        expect(result.eventTypes.data.map((item) => item.id)).toEqual([eventId])
      }
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  }

  it.each([
    ['session route', 'booking'],
    ['session route', 'host assignment'],
    ['native leave', 'booking'],
    ['native leave', 'host assignment'],
  ] as const)(
    'the %s catches a %s committed after preview while its transaction waits',
    (entry, change) => verifyRace(entry, change),
  )

  async function verifyService(
    depart: Departure,
    scenario: 'event' | 'booking' | 'context' | 'departure' | 'stale',
  ) {
    const f = await fixture()
    const target = application(auth, false, routeCopy(depart))
    if (scenario === 'event' || scenario === 'booking') {
      if (scenario === 'event') await event(f)
      else await booking(f)
      await blocked(await leave(f, target), f)
    } else if (scenario === 'context') {
      const response = await target.request(`/api/v1/teams/${randomUUID()}/leave`, {
        method: 'POST',
        headers: headers(f),
        body: '{}',
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
      await unchanged(f)
    } else if (scenario === 'stale') {
      expect((await leave(f)).status).toBe(200)
      const response = await leave(f, target)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
      await departed(f)
    } else {
      const response = await leave(f, target)
      expect(response.status).toBe(200)
      await departed(f)
    }
  }

  it('passes real HTTP protection assertions with an unmodified service source copy', async () => {
    for (const scenario of ['event', 'booking', 'context', 'departure', 'stale'] as const) {
      await verifyService(serviceCopy(), scenario)
    }
  })

  it.each<[string, 'event' | 'booking' | 'context' | 'departure' | 'stale', Replacement]>([
    ['event impact', 'event', ['impact.eventTypes.totalCount > 0', 'false']],
    ['booking impact', 'booking', ['impact.bookings.totalCount > 0', 'false']],
    [
      'expected organization',
      'context',
      [
        'expectedOrganizationId: input.expectedOrganizationId',
        'expectedOrganizationId: input.teamId',
      ],
    ],
    [
      'departed organization context',
      'stale',
      [
        'input.expectedOrganizationId.toLowerCase() !== principal.organization.id.toLowerCase()',
        'false',
      ],
    ],
    [
      'personal fallback',
      'departure',
      [
        'activeOrganizationId: personalId, updatedAt',
        'activeOrganizationId: actor.organizationId, updatedAt',
      ],
    ],
    [
      'membership revocation',
      'departure',
      [
        ".deleteFrom('auth.member')\n        .where('organizationId', '=', actor.organizationId)\n        .where('userId', '=', actor.userId)\n        .returning('role')",
        ".selectFrom('auth.member')\n        .select('role')\n        .where('organizationId', '=', actor.organizationId)\n        .where('userId', '=', actor.userId)",
      ],
    ],
  ])('detects disabling %s with a real HTTP assertion', async (_, scenario, replacement) => {
    await expect(verifyService(serviceCopy([replacement]), scenario)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each(['booking', 'host assignment'] as const)(
    'detects reading %s impact before acquiring transaction locks',
    async (change) => {
      const copy = serviceCopy([
        [
          'const actor = await checkTeamManagementAccess(',
          'const preview = await getTeamMemberDepartureImpact(ctx, { teamId: input.teamId, memberUserId: principal.user.id })\n      const actor = await checkTeamManagementAccess(',
        ],
        [
          'const impact = await getTeamMemberDepartureImpact(\n        { ...ctx, db: trx },\n        { teamId: actor.organizationId, memberUserId: actor.userId },\n      )',
          'const impact = preview',
        ],
      ])
      await expect(verifyRace('session route', change, copy)).rejects.toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )

  async function verifyOpen(factory: typeof memberLeaveRoutes) {
    const document = await openApiDocument(application(auth, false, factory))
    expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
  }

  it('passes the OpenAPI assertion with an unmodified route source copy', async () => {
    await verifyOpen(routeCopy())
  })

  it.each<[string, Replacement]>([
    [
      'success response',
      ['json(z.object({ organizationId:', 'json(z.strictObject({ organizationId:'],
    ],
    ['handling response', ['Handling = z.object({', 'Handling = z.strictObject({']],
    ['error response', ['ErrorBody.extend({', 'ErrorBody.strict().extend({']],
  ])('detects a closed published %s with a real assertion', async (_, replacement) => {
    await expect(verifyOpen(routeCopy(leaveTeamMember, replacement))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('publishes the production session-only route with open response objects', async () => {
    const production = application(auth, true)
    const document = await openApiDocument(production)
    expect(document.paths[path]?.post?.security).toEqual([{ session: [] }])
    expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
    const f = await fixture()
    expect((await leave(f, production)).status).toBe(200)
  })
})
