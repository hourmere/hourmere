import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  MemberDepartureOwnerRequiredError,
  removeTeamMember,
  TeamManagementError,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  getLatestTeamMemberRemovalHandling,
  getTeamMemberRemovalHandling,
  MemberDepartureBookingSchema,
  MemberRemovalHandlingSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { ErrorBody, errorResponses, json, type RouteModule, serviceContext } from '../openapi.ts'
import { productRoutes } from '../server.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  teamManagementAccess,
} from '../team-management.ts'
import { eventTypeRoutes } from './event-types.ts'
import { memberRemovalRoutes } from './member-removal.ts'
import { publicRoutes } from './public.ts'
import { openApiDocument, responseAndRequestStrictness } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4392'
const secret = 'synthetic-member-removal-secret-00000000000000000'
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const removalPath = '/api/v1/team/members/{memberUserId}/removal'
const handlingPath = '/api/v1/team/member-removals/{operationId}'
const latestHandlingPath = '/api/v1/team/members/{memberUserId}/removal-handling'
const denied = { error: 'team_management_access_denied' }
const nativeDenied = {
  code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
  message: 'team_management_access_denied',
}

describe.skipIf(!serverUrl)('member removal through HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let resolveCaller: ReturnType<typeof createCallerResolver>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'member_removal' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // Every case shares these bounded pools; native requests also use the auth lock pool.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    resolveCaller = createCallerResolver({ auth, db })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function application(
    routes: RouteModule[] = [memberRemovalRoutes({ db, now })],
    observeResolution = () => {},
  ) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: (headers) => {
        observeResolution()
        return resolveCaller(headers)
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

  async function fixture(actorRole = 'owner', targetRole = 'member') {
    const actor = await createTestUser(db, 'Removal actor')
    const target = await createTestUser(db, 'Removed original host')
    const survivor = await createTestUser(db, 'Remaining host')
    const team = await createTestTeam(db, [
      { user: actor, role: actorRole },
      { user: target, role: targetRole },
      { user: survivor, role: 'owner' },
    ])
    const eventId = await createFixtures(db).eventType(team.id, null, {
      title: 'Team removal consultation',
      description: 'private-only-event-description',
      hosts: [{ userId: target.id }],
    })
    const login = await session(actor, team.id)
    const targetLogin = await session(target, team.id)
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', target.id)
      .executeTakeFirstOrThrow()
    return { actor, target, survivor, team, eventId, login, targetLogin, memberId: member.id }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function remove(
    f: Fixture,
    options: {
      targetId?: string
      teamId?: string
      expected?: string | null
      cookie?: string
      origin?: string
      body?: unknown
      app?: ReturnType<typeof application>
    } = {},
  ) {
    const expected = options.expected === undefined ? f.team.id : options.expected
    return (options.app ?? application()).request(
      `/api/v1/team/members/${options.targetId ?? f.target.id}/removal`,
      {
        method: 'POST',
        headers: {
          cookie: options.cookie ?? f.login.cookie,
          origin: options.origin ?? origin,
          'content-type': 'application/json',
          ...(expected === null ? {} : { [EXPECTED_ORGANIZATION_HEADER]: expected }),
        },
        body: JSON.stringify(options.body ?? { teamId: options.teamId ?? f.team.id }),
      },
    )
  }

  function nativeRemove(f: Fixture, memberIdOrEmail = f.memberId) {
    return application().request('/api/auth/organization/remove-member', {
      method: 'POST',
      headers: {
        cookie: f.login.cookie,
        origin,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: f.team.id,
      },
      body: JSON.stringify({ organizationId: f.team.id, memberIdOrEmail }),
    })
  }

  function handling(
    f: Fixture,
    operationId: string,
    options: {
      cookie?: string
      teamId?: string
      query?: Record<string, string>
      app?: ReturnType<typeof application>
      headers?: Record<string, string>
    } = {},
  ) {
    return (options.app ?? application()).request(
      `/api/v1/team/member-removals/${operationId}?${new URLSearchParams({ teamId: options.teamId ?? f.team.id, ...options.query })}`,
      { headers: options.headers ?? { cookie: options.cookie ?? f.login.cookie } },
    )
  }

  function latestHandling(
    f: Fixture,
    options: {
      memberUserId?: string
      teamId?: string
      query?: Record<string, string>
      headers?: Record<string, string>
    } = {},
  ) {
    return application().request(
      `/api/v1/team/members/${options.memberUserId ?? f.target.id}/removal-handling?${new URLSearchParams({ teamId: options.teamId ?? f.team.id, ...options.query })}`,
      { headers: options.headers ?? { cookie: f.login.cookie } },
    )
  }

  function membership(f: Fixture) {
    return db
      .selectFrom('auth.member')
      .select(['id', 'role'])
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.target.id)
      .executeTakeFirst()
  }

  async function event(
    f: Fixture,
    mode: 'individual' | 'round_robin' | 'collective',
    hostIds: string[],
    options: {
      organizationId?: string
      ownerId?: string
      active?: boolean
      deleted?: boolean
    } = {},
  ) {
    const id = await createFixtures(db).eventType(
      options.organizationId ?? f.team.id,
      options.ownerId ?? null,
      {
        title: `${mode} removal consultation`,
        isActive: options.active ?? true,
        deletedAt: options.deleted ? '2026-10-31T00:00:00Z' : null,
        hosts: hostIds.map((userId) => ({ userId })),
      },
    )
    await db
      .updateTable('event_types')
      .set({ scheduling_type: mode })
      .where('id', '=', id)
      .execute()
    return id
  }

  async function booking(
    f: Fixture,
    start = '2026-11-02T09:00:00Z',
    options: {
      end?: string
      status?: 'confirmed' | 'cancelled'
      hosts?: string[]
      eventId?: string
      organizationId?: string
    } = {},
  ) {
    const id = randomUUID()
    const hostIds = options.hosts ?? [f.target.id]
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('bookings')
        .values({
          id,
          organization_id: options.organizationId ?? f.team.id,
          event_type_id: options.eventId ?? f.eventId,
          start_at: start,
          end_at: options.end ?? Temporal.Instant.from(start).add({ minutes: 30 }).toString(),
          status: options.status ?? 'confirmed',
          cancelled_at: options.status === 'cancelled' ? new Date() : null,
          manage_token_hash: randomBytes(32),
          source: 'web',
          title: 'private-only-booking-title',
          responses: JSON.stringify({ answer: 'private-only-sensitive-response' }),
          location: JSON.stringify({ kind: 'custom', text: 'private-only-conference-link' }),
          required_host_user_ids: hostIds,
        })
        .execute()
      await trx
        .insertInto('booking_hosts')
        .values(hostIds.map((user_id) => ({ booking_id: id, user_id })))
        .execute()
      await trx
        .insertInto('booking_attendees')
        .values({
          booking_id: id,
          name: 'Synthetic attendee',
          email: 'attendee@example.com',
          time_zone: 'UTC',
          is_booker: true,
        })
        .execute()
    })
    return id
  }

  async function snapshot(f: Fixture) {
    return {
      member: await membership(f),
      events: await db
        .selectFrom('event_types')
        .selectAll()
        .where('organization_id', '=', f.team.id)
        .orderBy('id')
        .execute(),
      bookings: await db
        .selectFrom('bookings')
        .selectAll()
        .where('organization_id', '=', f.team.id)
        .orderBy('id')
        .execute(),
      hosts: await db
        .selectFrom('booking_hosts')
        .innerJoin('bookings', 'bookings.id', 'booking_hosts.booking_id')
        .select(['booking_id', 'user_id'])
        .where('organization_id', '=', f.team.id)
        .orderBy('booking_id')
        .orderBy('user_id')
        .execute(),
      operations: await db
        .selectFrom('organization_operations')
        .selectAll()
        .where('organization_id', '=', f.team.id)
        .orderBy('id')
        .execute(),
    }
  }

  const roleCells = ['owner', 'admin', 'member'].flatMap((actorRole) =>
    ['owner', 'admin', 'member'].map((targetRole) => ({
      actorRole,
      targetRole,
      allowed:
        targetRole === 'member'
          ? actorRole !== 'member'
          : targetRole === 'admin' && actorRole === 'owner',
    })),
  )

  it.each(roleCells)(
    '$actorRole removing $targetRole follows the role policy',
    async ({ actorRole, targetRole, allowed }) => {
      const f = await fixture(actorRole, targetRole)
      const before = await snapshot(f)
      const response = await remove(f)
      if (allowed) {
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          operationId: expect.any(String),
          memberUserId: f.target.id,
          deactivatedEventTypeIds: [f.eventId],
        })
        expect(await membership(f)).toBeUndefined()
      } else {
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual(denied)
        expect(await snapshot(f)).toEqual(before)
      }
    },
  )

  it.each(roleCells)(
    'native remove-member: $actorRole removing $targetRole follows the same policy',
    async ({ actorRole, targetRole, allowed }) => {
      const f = await fixture(actorRole, targetRole)
      const before = await snapshot(f)
      const response = await nativeRemove(f)
      expect(response.status).toBe(allowed ? 200 : 403)
      if (allowed) {
        expect(await membership(f)).toBeUndefined()
        expect(
          await db
            .selectFrom('event_types')
            .select('is_active')
            .where('id', '=', f.eventId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ is_active: false })
        expect(
          await db
            .selectFrom('organization_operations')
            .select('operation')
            .where('organization_id', '=', f.team.id)
            .execute(),
        ).toEqual([{ operation: 'member_removed' }])
      } else {
        expect(await response.json()).toEqual(nativeDenied)
        expect(await snapshot(f)).toEqual(before)
      }
    },
  )

  it.each(['member, admin', 'member,owner'])('recognizes exact actor roles in %s', async (role) => {
    const f = await fixture(role)
    expect((await remove(f)).status).toBe(200)
    expect(await membership(f)).toBeUndefined()
  })

  it.each(['superadmin', 'ownerish', 'admin-helper', 'unknown'])(
    'does not grant removal to actor role %s',
    async (role) => {
      const f = await fixture(role)
      const response = await remove(f)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(await membership(f)).toBeDefined()
    },
  )

  it('uniformly refuses absent and foreign target identities', async () => {
    const f = await fixture()
    const outsider = await createTestUser(db, 'Foreign target')
    await createTestTeam(db, [{ user: outsider, role: 'member' }])
    for (const targetId of [randomUUID(), outsider.id]) {
      const response = await remove(f, { targetId })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    }
    expect(await membership(f)).toBeDefined()
  })

  it('refuses API keys and unverified identities without changing membership', async () => {
    const f = await fixture()
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const response = await application().request(`/api/v1/team/members/${f.target.id}/removal`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        cookie: f.login.cookie,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: f.team.id,
      },
      body: JSON.stringify({ teamId: f.team.id }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.actor.id)
      .execute()
    const unverified = await remove(f)
    expect(unverified.status).toBe(403)
    expect(await unverified.json()).toEqual(denied)
    expect(await membership(f)).toBeDefined()
  })

  async function verifyAtomicEffects(app?: ReturnType<typeof application>) {
    const f = await fixture()
    const fixtures = createFixtures(db)
    const gone = await createTestUser(db, 'Previously removed pool host')
    const unverified = await createTestUser(db, 'Unverified pool host')
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', unverified.id)
      .execute()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: unverified.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const onlyRr = await event(f, 'round_robin', [f.target.id])
    const staleRr = await event(f, 'round_robin', [f.target.id, gone.id])
    const unverifiedRr = await event(f, 'round_robin', [f.target.id, unverified.id])
    const collective = await event(f, 'collective', [f.target.id, f.survivor.id])
    const remainingRr = await event(f, 'round_robin', [f.target.id, f.survivor.id])
    const unaffected = await event(f, 'individual', [f.survivor.id])
    const personalInTeam = await event(f, 'individual', [f.target.id], { ownerId: f.target.id })
    const personal = await event(f, 'individual', [f.target.id], {
      organizationId: f.target.principal.organization.id,
      ownerId: f.target.id,
    })
    const other = await createTestTeam(db, [{ user: f.target, role: 'owner' }])
    const otherEvent = await event(f, 'individual', [f.target.id], { organizationId: other.id })
    const disabled = await event(f, 'individual', [f.target.id], { active: false })
    const deleted = await event(f, 'individual', [f.target.id], { deleted: true })
    await fixtures.schedule(f.target.id, { timeZone: 'UTC' })
    const future = await booking(f)
    const inProgress = await booking(f, '2026-11-01T11:45:00Z')
    const past = await booking(f, '2026-10-30T09:00:00Z')
    const cancelled = await booking(f, '2026-11-02T10:00:00Z', { status: 'cancelled' })
    const before = await snapshot(f)
    const configuredHosts = await db
      .selectFrom('event_type_hosts')
      .selectAll()
      .where('event_type_id', 'in', [f.eventId, onlyRr, staleRr, collective, remainingRr])
      .orderBy('event_type_id')
      .orderBy('user_id')
      .execute()
    const response = await remove(f, { app })
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      operationId: string
      deactivatedEventTypeIds: string[]
    }
    expect([...result.deactivatedEventTypeIds].sort()).toEqual(
      [f.eventId, onlyRr, staleRr, unverifiedRr, collective].sort(),
    )
    expect(await membership(f)).toBeUndefined()
    const after = await snapshot(f)
    expect(after.bookings).toEqual(before.bookings)
    expect(after.hosts).toEqual(before.hosts)
    expect(after.bookings.map((row) => row.id).sort()).toEqual(
      [future, inProgress, past, cancelled].sort(),
    )
    expect(
      await db
        .selectFrom('event_type_hosts')
        .selectAll()
        .where('event_type_id', 'in', [f.eventId, onlyRr, staleRr, collective, remainingRr])
        .orderBy('event_type_id')
        .orderBy('user_id')
        .execute(),
    ).toEqual(configuredHosts)
    expect(
      await db
        .selectFrom('event_types')
        .select(['id', 'is_active'])
        .where('id', 'in', [f.eventId, onlyRr, staleRr, unverifiedRr, collective])
        .orderBy('id')
        .execute(),
    ).toEqual(
      [f.eventId, onlyRr, staleRr, unverifiedRr, collective]
        .sort()
        .map((id) => ({ id, is_active: false })),
    )
    expect(
      await db
        .selectFrom('event_types')
        .select(['id', 'is_active'])
        .where('id', 'in', [remainingRr, unaffected, personalInTeam, personal, otherEvent, deleted])
        .orderBy('id')
        .execute(),
    ).toEqual(
      [remainingRr, unaffected, personalInTeam, personal, otherEvent, deleted]
        .sort()
        .map((id) => ({ id, is_active: true })),
    )
    expect(
      await db
        .selectFrom('event_types')
        .select('is_active')
        .where('id', '=', disabled)
        .executeTakeFirstOrThrow(),
    ).toEqual({ is_active: false })
    expect(after.operations).toMatchObject([
      {
        id: result.operationId,
        organization_id: f.team.id,
        operation: 'member_removed',
        actor_user_id: f.actor.id,
        target_user_id: f.target.id,
        source: 'web',
      },
    ])
  }

  it('atomically deactivates only affected team events while preserving every booking and original host', () =>
    verifyAtomicEffects())

  it('rolls back access revocation and event deactivation if the removal record fails', async () => {
    const f = await fixture()
    await booking(f)
    const before = await snapshot(f)
    await owned.pool.query(
      `CREATE FUNCTION public.reject_test_member_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='member_removed' THEN RAISE EXCEPTION 'Synthetic removal record failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_member_removal BEFORE INSERT ON public.organization_operations FOR EACH ROW EXECUTE FUNCTION public.reject_test_member_removal();`,
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await remove(f)).status).toBe(500)
      expect(await snapshot(f)).toEqual(before)
    } finally {
      errors.mockRestore()
      await owned.pool.query(
        'DROP TRIGGER reject_test_member_removal ON public.organization_operations; DROP FUNCTION public.reject_test_member_removal();',
      )
    }
  })

  it('leaves a bounded admin handling list with future and in-progress bookings and no private fields', async () => {
    const f = await fixture()
    const inProgress = await booking(f, '2026-11-01T11:45:00Z')
    const future = await booking(f)
    await booking(f, '2026-10-30T09:00:00Z')
    await booking(f, '2026-11-02T10:00:00Z', { status: 'cancelled' })
    await booking(f, '2026-11-02T11:00:00Z', { hosts: [f.survivor.id] })
    const personalEvent = await event(f, 'individual', [f.target.id], { ownerId: f.target.id })
    await booking(f, '2026-11-02T12:00:00Z', { eventId: personalEvent })
    const response = await remove(f)
    expect(response.status).toBe(200)
    const result = (await response.json()) as { operationId: string }
    const firstResponse = await handling(f, result.operationId, { query: { limit: '1' } })
    expect(firstResponse.status).toBe(200)
    expect(firstResponse.headers.get('cache-control')).toBe('no-store')
    const first = MemberRemovalHandlingSchema.parse(await firstResponse.json())
    expect(first).toMatchObject({
      id: result.operationId,
      memberUserId: f.target.id,
      removedAt: expect.any(String),
      reason: 'member_removed',
      bookings: { totalCount: 2 },
    })
    expect(
      first.bookings.data.map(({ id, handling, inProgress }) => ({ id, handling, inProgress })),
    ).toEqual([
      { id: inProgress, inProgress: true, handling: 'wait_until_end_or_coordinate_offline' },
    ])
    expect(first.bookings.nextCursor).toEqual(expect.any(String))
    const secondResponse = await handling(f, result.operationId, {
      query: { limit: '1', cursor: first.bookings.nextCursor as string },
    })
    expect(secondResponse.status).toBe(200)
    const second = MemberRemovalHandlingSchema.parse(await secondResponse.json())
    expect(
      second.bookings.data.map(({ id, handling, inProgress }) => ({ id, handling, inProgress })),
    ).toEqual([{ id: future, inProgress: false, handling: 'coordinate_cancellation' }])
    expect(second.bookings.nextCursor).toBeNull()
    expect(second.bookings.totalCount).toBe(2)
    expect(JSON.stringify([first, second])).not.toContain('private-only-')
  })

  it('lets only current team owner/admin browser sessions read a removal handling list', async () => {
    const f = await fixture()
    const removed = await remove(f)
    const { operationId } = (await removed.json()) as { operationId: string }
    const survivorLogin = await session(f.survivor, f.team.id)
    expect((await handling(f, operationId, { cookie: survivorLogin.cookie })).status).toBe(200)
    const ordinary = await createTestUser(db)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: ordinary.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const ordinaryLogin = await session(ordinary, f.team.id)
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const deniedHeaders: Record<string, string>[] = [
      {},
      { cookie: ordinaryLogin.cookie },
      { cookie: f.targetLogin.cookie },
      { authorization: `Bearer ${key.key}`, cookie: f.login.cookie },
    ]
    for (const headers of deniedHeaders) {
      const response = await handling(f, operationId, { headers })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(response.headers.has('www-authenticate')).toBe(false)
    }
    for (const id of [randomUUID(), operationId]) {
      const other = await createTestTeam(db, [{ user: f.actor, role: 'owner' }])
      const otherLogin = await session(f.actor, other.id)
      const response = await handling(f, id, { teamId: other.id, cookie: otherLogin.cookie })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    }
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.actor.id)
      .execute()
    expect((await handling(f, operationId)).status).toBe(403)
  })

  it.each<Record<string, string>>([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { cursor: 'invalid' },
    { unexpected: 'field' },
  ])('validates handling page parameters %j', async (query) => {
    const f = await fixture()
    const removed = await remove(f)
    const { operationId } = (await removed.json()) as { operationId: string }
    const response = await handling(f, operationId, { query })
    expect(response.status).toBe(400)
    expect((await latestHandling(f, { query })).status).toBe(400)
  })

  it('requires the original team context, strict body and same-origin write protection', async () => {
    const f = await fixture()
    const before = await snapshot(f)
    for (const expected of [null, randomUUID(), 'invalid']) {
      const response = await remove(f, { expected })
      expect(response.status).toBe(expected === null ? 409 : 403)
      expect(await response.json()).toMatchObject({
        error: expected === null ? 'organization_context_changed' : 'team_management_access_denied',
      })
    }
    expect((await remove(f, { body: { teamId: f.team.id, unexpected: 'field' } })).status).toBe(400)
    expect((await remove(f, { origin: 'https://other.example' })).status).toBe(403)
    expect(await snapshot(f)).toEqual(before)
  })

  async function verifySessionBoundary(factory: typeof memberRemovalRoutes) {
    const f = await fixture()
    const before = await snapshot(f)
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    for (const cookie of [undefined, f.login.cookie]) {
      for (const authorization of ['', 'Basic malformed', 'Bearer junk', `Bearer ${key.key}`]) {
        const resolved = vi.fn()
        const app = application([factory({ db, now })], resolved)
        const response = await app.request(`/api/v1/team/members/${f.target.id}/removal`, {
          method: 'POST',
          headers: {
            authorization,
            ...(cookie ? { cookie } : {}),
            origin,
            'content-type': 'application/json',
            [EXPECTED_ORGANIZATION_HEADER]: f.team.id,
          },
          body: JSON.stringify({ teamId: f.team.id }),
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual(denied)
        expect(response.headers.has('www-authenticate')).toBe(false)
        expect(resolved).not.toHaveBeenCalled()
      }
    }
    for (const cookie of [undefined, 'better-auth.session_token=invalid']) {
      const response = await application([factory({ db, now })]).request(
        `/api/v1/team/members/${f.target.id}/removal`,
        {
          method: 'POST',
          headers: {
            ...(cookie ? { cookie } : {}),
            origin,
            'content-type': 'application/json',
            [EXPECTED_ORGANIZATION_HEADER]: f.team.id,
          },
          body: JSON.stringify({ teamId: f.team.id }),
        },
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(response.headers.has('www-authenticate')).toBe(false)
    }
    expect(await snapshot(f)).toEqual(before)
  }

  it('uniformly refuses missing sessions and Authorization before credential resolution', () =>
    verifySessionBoundary(memberRemovalRoutes))

  async function verifySwitchedContext(factory: typeof memberRemovalRoutes) {
    const f = await fixture()
    const other = await createTestTeam(db, [
      { user: f.actor, role: 'owner' },
      { user: f.target, role: 'member' },
    ])
    const app = application([factory({ db, now })])
    const switched = await app.request('/api/auth/organization/set-active', {
      method: 'POST',
      headers: { cookie: f.login.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: other.id }),
    })
    expect(switched.status).toBe(200)
    const before = await snapshot(f)
    // Both a stale body/header pair and a forged current header on an old body must reload.
    for (const expected of [f.team.id, other.id]) {
      const stale = await remove(f, { app, expected })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ error: 'organization_context_changed' })
    }
    // The native endpoint retains the same recoverable refusal for the stale tab.
    const native = await nativeRemove(f)
    expect(native.status).toBe(409)
    expect(await native.json()).toMatchObject({ code: 'ORGANIZATION_CONTEXT_CHANGED' })
    for (const expected of [null, f.team.id]) {
      const wrongHeader = await remove(f, { app, teamId: other.id, expected })
      expect(wrongHeader.status).toBe(409)
      expect(await wrongHeader.json()).toMatchObject({ error: 'organization_context_changed' })
    }
    expect(await snapshot(f)).toEqual(before)
    const membershipInCurrentTeam = () =>
      db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', other.id)
        .where('userId', '=', f.target.id)
        .executeTakeFirst()
    expect(await membershipInCurrentTeam()).toBeDefined()
    const fresh = await remove(f, { app, teamId: other.id, expected: other.id })
    expect(fresh.status).toBe(200)
    expect(await membershipInCurrentTeam()).toBeUndefined()
    expect(await snapshot(f)).toEqual(before)
  }

  it('returns reload conflicts after a real session team switch and accepts fresh context', () =>
    verifySwitchedContext(memberRemovalRoutes))

  it('revokes the removed member old team context immediately and refuses their next write with 409', async () => {
    const f = await fixture('owner', 'admin')
    const app = application([memberRemovalRoutes({ db, now }), eventTypeRoutes({ db, now })])
    expect((await remove(f, { app })).status).toBe(200)
    const before = await snapshot(f)
    const response = await app.request(`/api/v1/event-types/${f.eventId}`, {
      method: 'PATCH',
      headers: {
        cookie: f.targetLogin.cookie,
        origin,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: f.team.id,
      },
      body: JSON.stringify({ title: 'Removed member write' }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
    expect(await snapshot(f)).toEqual(before)
  })

  it('covers the native email selector with the same deactivation and handling record', async () => {
    const f = await fixture()
    const future = await booking(f)
    const response = await nativeRemove(f, f.target.email)
    expect(response.status).toBe(200)
    expect(await membership(f)).toBeUndefined()
    // Native removal keeps Better Auth's response shape. An administrator can discover
    // its handling record through the known member identity without querying persistence.
    const read = await latestHandling(f)
    expect(read.status).toBe(200)
    const result = MemberRemovalHandlingSchema.parse(await read.json())
    expect(result).toMatchObject({
      id: expect.any(String),
      memberUserId: f.target.id,
      reason: 'member_removed',
    })
    expect(result.bookings.data.map((row) => row.id)).toEqual([future])
    expect((await handling(f, result.id)).status).toBe(200)
  })

  it.each(['owner', 'admin'])(
    'lets a current %s discover and page native removal handling by the removed member identity',
    async (role) => {
      const f = await fixture(role)
      const inProgress = await booking(f, '2026-11-01T11:45:00Z')
      const future = await booking(f)
      expect((await nativeRemove(f)).status).toBe(200)
      const response = await latestHandling(f, { query: { limit: '1' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const first = MemberRemovalHandlingSchema.parse(await response.json())
      expect(first.memberUserId).toBe(f.target.id)
      expect(first.reason).toBe('member_removed')
      expect(first.bookings.totalCount).toBe(2)
      expect(
        first.bookings.data.map(({ id, inProgress, handling }) => ({ id, inProgress, handling })),
      ).toEqual([
        { id: inProgress, inProgress: true, handling: 'wait_until_end_or_coordinate_offline' },
      ])
      expect(first.bookings.nextCursor).toEqual(expect.any(String))
      const secondResponse = await latestHandling(f, {
        query: { limit: '1', cursor: first.bookings.nextCursor as string },
      })
      expect(secondResponse.status).toBe(200)
      const second = MemberRemovalHandlingSchema.parse(await secondResponse.json())
      expect(second.id).toBe(first.id)
      expect(second.bookings.totalCount).toBe(2)
      expect(second.bookings.data.map((row) => row.id)).toEqual([future])
      expect(second.bookings.nextCursor).toBeNull()
      expect(JSON.stringify([first, second])).not.toContain('private-only-')
    },
  )

  it('uniformly refuses discovery to members, removed members, API keys and inaccessible or missing records', async () => {
    const f = await fixture()
    expect((await nativeRemove(f)).status).toBe(200)
    const ordinary = await createTestUser(db)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: ordinary.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const ordinaryLogin = await session(ordinary, f.team.id)
    const key = await auth.api.createApiKey({
      body: { userId: f.actor.id, metadata: { organizationId: f.team.id } },
    })
    const deniedHeaders: Record<string, string>[] = [
      {},
      { cookie: ordinaryLogin.cookie },
      { cookie: f.targetLogin.cookie },
      { authorization: `Bearer ${key.key}`, cookie: f.login.cookie },
    ]
    for (const headers of deniedHeaders) {
      const response = await latestHandling(f, { headers })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(response.headers.has('www-authenticate')).toBe(false)
    }
    const other = await createTestTeam(db, [{ user: f.actor, role: 'owner' }])
    const otherLogin = await session(f.actor, other.id)
    const inaccessible = await latestHandling(f, {
      teamId: other.id,
      headers: { cookie: otherLogin.cookie },
    })
    expect(inaccessible.status).toBe(403)
    expect(await inaccessible.json()).toEqual(denied)
    for (const memberUserId of [ordinary.id, randomUUID()]) {
      const response = await latestHandling(f, { memberUserId })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    }
  })

  it.each(
    (['REST', 'native'] as const).flatMap((entry) =>
      (['booking', 'host assignment'] as const).map((action) => ({ entry, action })),
    ),
  )(
    'orders a concurrent $action behind $entry removal and rechecks the removed host',
    async ({ entry, action }) => {
      const f = await fixture()
      await db
        .insertInto('profiles')
        .values({
          user_id: f.target.id,
          handle: `removal-${randomUUID().slice(0, 8)}`,
          time_zone: 'UTC',
        })
        .execute()
      await createFixtures(db).schedule(f.target.id, { timeZone: 'UTC' })
      await db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind: 'phone', number: '+14155550123' }) })
        .where('id', '=', f.eventId)
        .execute()
      const team = await db
        .selectFrom('auth.organization')
        .select('slug')
        .where('id', '=', f.team.id)
        .executeTakeFirstOrThrow()
      const eventRow = await db
        .selectFrom('event_types')
        .select('slug')
        .where('id', '=', f.eventId)
        .executeTakeFirstOrThrow()
      const otherEvent = await event(f, 'individual', [f.survivor.id])
      const app = application([
        memberRemovalRoutes({ db, now }),
        eventTypeRoutes({ db, now }),
        publicRoutes({ db, now }),
      ])
      const holder = await owned.pool.connect()
      let removal: Promise<Response> | undefined
      let concurrent: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM public.event_types WHERE id=$1 FOR UPDATE', [f.eventId])
        removal = Promise.resolve(entry === 'REST' ? remove(f, { app }) : nativeRemove(f))
        await vi.waitFor(
          async () => {
            const result = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%event_types%' AND pid <> pg_backend_pid()) AS blocked`,
            )
            expect(result.rows[0]?.blocked).toBe(true)
          },
          { interval: 10, timeout: 2_000 },
        )
        concurrent = Promise.resolve(
          action === 'booking'
            ? app.request(`/api/v1/public/teams/${team.slug}/${eventRow.slug}/bookings`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  start: '2026-11-02T09:00:00Z',
                  invitee: {
                    name: 'Synthetic attendee',
                    email: 'attendee@example.com',
                    timeZone: 'UTC',
                  },
                }),
              })
            : app.request(`/api/v1/event-types/${otherEvent}`, {
                method: 'PATCH',
                headers: {
                  cookie: f.login.cookie,
                  origin,
                  'content-type': 'application/json',
                  [EXPECTED_ORGANIZATION_HEADER]: f.team.id,
                },
                body: JSON.stringify({ hosts: [{ userId: f.target.id }] }),
              }),
        )
        await vi.waitFor(
          async () => {
            const result = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%auth%organization%' AND pid <> pg_backend_pid()) AS blocked`,
            )
            expect(result.rows[0]?.blocked).toBe(true)
          },
          { interval: 10, timeout: 2_000 },
        )
        await holder.query('COMMIT')
        expect((await removal).status).toBe(200)
        const response = await concurrent
        expect(response.status).toBe(action === 'booking' ? 404 : 400)
        expect(await response.json()).toMatchObject({
          error: action === 'booking' ? 'event_type_not_found' : 'invalid_hosts',
        })
        expect(await membership(f)).toBeUndefined()
        expect(
          await db
            .selectFrom('bookings')
            .select('id')
            .where('organization_id', '=', f.team.id)
            .execute(),
        ).toEqual([])
        expect(
          await db
            .selectFrom('event_type_hosts')
            .select('user_id')
            .where('event_type_id', '=', otherEvent)
            .execute(),
        ).toEqual([{ user_id: f.survivor.id }])
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await Promise.allSettled([removal, concurrent])
      }
    },
  )

  it.each(['REST', 'native'] as const)(
    'preserves a public booking that wins the organization lock before %s removal',
    async (entry) => {
      const f = await fixture()
      await db
        .insertInto('profiles')
        .values({
          user_id: f.target.id,
          handle: `removal-${randomUUID().slice(0, 8)}`,
          time_zone: 'UTC',
        })
        .execute()
      await createFixtures(db).schedule(f.target.id, { timeZone: 'UTC' })
      await db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind: 'phone', number: '+14155550123' }) })
        .where('id', '=', f.eventId)
        .execute()
      const team = await db
        .selectFrom('auth.organization')
        .select('slug')
        .where('id', '=', f.team.id)
        .executeTakeFirstOrThrow()
      const eventRow = await db
        .selectFrom('event_types')
        .select('slug')
        .where('id', '=', f.eventId)
        .executeTakeFirstOrThrow()
      const app = application([memberRemovalRoutes({ db, now }), publicRoutes({ db, now })])
      const holder = await owned.pool.connect()
      let booked: Promise<Response> | undefined
      let removal: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `booking-host:${f.target.id}`,
        ])
        booked = Promise.resolve(
          app.request(`/api/v1/public/teams/${team.slug}/${eventRow.slug}/bookings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              start: '2026-11-02T09:00:00Z',
              invitee: {
                name: 'Synthetic attendee',
                email: 'attendee@example.com',
                timeZone: 'UTC',
              },
            }),
          }),
        )
        await vi.waitFor(
          async () => {
            const result = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND pid <> pg_backend_pid()) AS blocked`,
            )
            expect(result.rows[0]?.blocked).toBe(true)
          },
          { interval: 10, timeout: 2_000 },
        )
        removal = Promise.resolve(entry === 'REST' ? remove(f, { app }) : nativeRemove(f))
        await vi.waitFor(
          async () => {
            const result = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%auth%organization%' AND pid <> pg_backend_pid()) AS blocked`,
            )
            expect(result.rows[0]?.blocked).toBe(true)
          },
          { interval: 10, timeout: 2_000 },
        )
        expect(await membership(f)).toBeDefined()
        await holder.query('COMMIT')
        const created = await booked
        expect(created.status).toBe(201)
        const result = (await created.json()) as { booking: { id: string } }
        expect((await removal).status).toBe(200)
        expect(await membership(f)).toBeUndefined()
        expect(
          await db
            .selectFrom('event_types')
            .select('is_active')
            .where('id', '=', f.eventId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ is_active: false })
        expect(
          await db
            .selectFrom('bookings')
            .select(['id', 'event_type_id', 'status', 'required_host_user_ids'])
            .where('organization_id', '=', f.team.id)
            .execute(),
        ).toEqual([
          {
            id: result.booking.id,
            event_type_id: f.eventId,
            status: 'confirmed',
            required_host_user_ids: [f.target.id],
          },
        ])
        expect(
          await db
            .selectFrom('booking_hosts')
            .select('user_id')
            .where('booking_id', '=', result.booking.id)
            .execute(),
        ).toEqual([{ user_id: f.target.id }])
        const operation = await db
          .selectFrom('organization_operations')
          .select('id')
          .where('organization_id', '=', f.team.id)
          .where('operation', '=', 'member_removed')
          .executeTakeFirstOrThrow()
        const read = await handling(f, operation.id)
        expect(read.status).toBe(200)
        expect(
          MemberRemovalHandlingSchema.parse(await read.json()).bookings.data.map((row) => row.id),
        ).toEqual([result.booking.id])
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await Promise.allSettled([booked, removal])
      }
    },
  )

  type Replacement = readonly [string, string]
  function sourceCopy(replacement?: Replacement, observeWrite = () => {}) {
    let source = readFileSync('apps/server/src/routes/member-removal.ts', 'utf8')
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
      removeTeamMember,
      TeamManagementError,
      MemberDepartureOwnerRequiredError,
      getLatestTeamMemberRemovalHandling,
      getTeamMemberRemovalHandling,
      MemberDepartureBookingSchema,
      MemberRemovalHandlingSchema,
      TeamAdminBookingSchema,
      DomainError,
      ErrorBody,
      errorResponses,
      json,
      serviceContext,
      EXPECTED_ORGANIZATION_HEADER,
      ORGANIZATION_CONTEXT_CHANGED,
      teamManagementAccess: (...args: Parameters<typeof teamManagementAccess>) => {
        const access = teamManagementAccess(...args)
        const write = access.write.bind(access)
        access.write = ((...parameters: Parameters<typeof write>) => {
          observeWrite()
          return write(...parameters)
        }) as typeof access.write
        return access
      },
    }
    return new Function(...Object.keys(bindings), `${source}; return memberRemovalRoutes`)(
      ...Object.values(bindings),
    ) as typeof memberRemovalRoutes
  }

  async function verifyOpen(factory: typeof memberRemovalRoutes) {
    const document = await openApiDocument(application([factory({ db, now })]))
    expect(
      responseAndRequestStrictness(document, [removalPath, handlingPath, latestHandlingPath]),
    ).toEqual({
      closedResponses: [],
      openRequests: [],
    })
  }

  it('passes the publication assertion with an unmodified route source copy', () =>
    verifyOpen(sourceCopy()))

  it('keeps the session-only boundary in an unmodified source copy', () =>
    verifySessionBoundary(sourceCopy()))

  it('detects reverting the session-only middleware with a real assertion', async () => {
    await expect(
      verifySessionBoundary(sourceCopy(['middleware: access.middleware,', 'middleware: caller,'])),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it('keeps switched team context bound in an unmodified source copy', () =>
    verifySwitchedContext(sourceCopy()))

  it('detects silently replacing the draft team with the current team', async () => {
    await expect(
      verifySwitchedContext(
        sourceCopy([
          "const { teamId } = c.req.valid('json')",
          'const teamId = c.var.principal.organization.id',
        ]),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it.each<[string, Replacement]>([
    ['removal envelope', ['Removal = z\n  .object({', 'Removal = z\n  .strictObject({']],
    [
      'handling envelope',
      ['RemovalHandling = z\n  .object({', 'RemovalHandling = z\n  .strictObject({'],
    ],
    ['handling page', ['bookings: z.object({', 'bookings: z.strictObject({']],
    ['handling booking', ['HandlingBooking = z.object({', 'HandlingBooking = z.strictObject({']],
    ['handling event', ['eventType: z.object(', 'eventType: z.strictObject(']],
    ['handling host', ['hosts: z.array(z.object(', 'hosts: z.array(z.strictObject(']],
    ['handling attendee', ['attendees: z.array(z.object(', 'attendees: z.array(z.strictObject(']],
    [
      'request strictness',
      ['json(z.strictObject({ teamId: z.uuid() }))', 'json(z.object({ teamId: z.uuid() }))'],
    ],
  ])('detects broken %s publication with a real assertion', async (_, replacement) => {
    await expect(verifyOpen(sourceCopy(replacement))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  async function verifySharedWrite(replacement?: Replacement) {
    let observed = 0
    const factory = sourceCopy(replacement, () => {
      observed++
    })
    const f = await fixture()
    const response = await remove(f, { app: application([factory({ db, now })]) })
    expect(response.status).toBe(200)
    expect(observed).toBe(1)
    expect(await membership(f)).toBeUndefined()
  }

  it('uses the shared write transaction in an unmodified source copy', () => verifySharedWrite())
  it('detects bypassing the shared write transaction with a real assertion', async () => {
    await expect(
      verifySharedWrite([
        'const result = await access.write(',
        'const result = await ((principal, teamId, operation) => deps.db.transaction().execute((trx) => operation(trx, { userId: principal.user.id, organizationId: teamId, role: "owner" })) )(',
      ]),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  async function verifyContext(factory: typeof memberRemovalRoutes) {
    const f = await fixture()
    const response = await remove(f, {
      app: application([factory({ db, now })]),
      expected: null,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
    expect(await membership(f)).toBeDefined()
  }

  it('keeps missing expected organization context rejected in an unmodified source copy', () =>
    verifyContext(sourceCopy()))

  it('detects replacing the draft context with the requested team using a real assertion', async () => {
    await expect(
      verifyContext(
        sourceCopy([
          "const expectedOrganizationId = c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? ''",
          'const expectedOrganizationId = teamId',
        ]),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it('registers all production routes with open responses and a strict removal request', async () => {
    const app = application(
      productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
    )
    const document = await openApiDocument(app)
    expect(document.paths[removalPath]?.post?.security).toEqual([{ session: [] }])
    expect(document.paths[handlingPath]?.get?.security).toEqual([{ session: [] }])
    expect(document.paths[latestHandlingPath]?.get?.security).toEqual([{ session: [] }])
    const removal = document.paths[removalPath]?.post
    expect(Object.keys(removal?.responses ?? {})).toEqual(['200', '400', '403', '409', '429'])
    expect(document.paths[handlingPath]?.get?.responses).not.toHaveProperty('401')
    expect(document.paths[latestHandlingPath]?.get?.responses).not.toHaveProperty('401')
    expect(removal?.parameters).toContainEqual(
      expect.objectContaining({
        in: 'header',
        name: 'x-expected-organization-id',
        required: true,
      }),
    )
    expect(
      responseAndRequestStrictness(document, [removalPath, handlingPath, latestHandlingPath]),
    ).toEqual({
      closedResponses: [],
      openRequests: [],
    })
  })
})
