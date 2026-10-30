import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { memberDepartureImpactRoutes } from './routes/member-departure-impact.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { readinessRoutes } from './routes/readiness.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4397'
const secret = 'synthetic-expected-team-context-secret-00000000000000'
const families = [
  'bookings',
  'departure impact',
  'removal handling',
  'latest removal handling',
  'team readiness',
  'booking cancellation',
  'member removal',
  'member leave',
  'native invitation cancellation',
  'native member removal',
  'native member leave',
  'native member role',
  'native team update',
] as const
type Family = (typeof families)[number]
const selfServiceFamilies: readonly Family[] = [
  'departure impact',
  'member leave',
  'native member leave',
]

describe.skipIf(!serverUrl)('expected team authority before current team eligibility', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'expected_team' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // Reuse one auth pool and one fixture pool across every route family.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    app = application()
  })

  function application(afterResolve?: () => Promise<void>) {
    const resolve = createCallerResolver({ auth, db })
    return createApp({
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const caller = await resolve(headers)
        if (caller.ok) await afterResolve?.()
        return caller
      },
      checkDb: async () => {},
      publicUrl: origin,
      routes: [
        teamBookingRoutes({ db, notify: async () => {} }),
        memberRemovalRoutes({ db }),
        memberLeaveRoutes({ db }),
        memberDepartureImpactRoutes({ db }),
        readinessRoutes({ db }),
      ],
    })
  }

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function fixture(current: 'personal' | 'member' | 'expected', role = 'admin') {
    const user = await createTestUser(db, 'Expected team manager')
    const owner = await createTestUser(db, 'Continuing owner')
    const expected = await createTestTeam(db, [
      { user, role },
      { user: owner, role: 'owner' },
    ])
    const memberTeam = await createTestTeam(db, [{ user, role: 'member' }])
    const activeOrganizationId =
      current === 'personal'
        ? user.principal.organization.id
        : current === 'member'
          ? memberTeam.id
          : expected.id
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      user,
      expected,
      memberTeam,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function request(
    f: Fixture,
    family: Family,
    expectedId: string | null = f.expected.id,
    target = app,
  ) {
    const id = randomUUID()
    const read = [
      'bookings',
      'departure impact',
      'removal handling',
      'latest removal handling',
      'team readiness',
    ].includes(family)
    let path: string
    let body: unknown = {}
    switch (family) {
      case 'bookings':
        path = '/api/v1/team/bookings'
        break
      case 'departure impact':
        path = `/api/v1/team/members/${f.user.id}/departure-impact?teamId=${f.expected.id}`
        break
      case 'removal handling':
        path = `/api/v1/team/member-removals/${id}?teamId=${f.expected.id}`
        break
      case 'latest removal handling':
        path = `/api/v1/team/members/${id}/removal-handling?teamId=${f.expected.id}`
        break
      case 'team readiness':
        path = `/api/v1/teams/${f.expected.id}/readiness`
        break
      case 'booking cancellation':
        path = `/api/v1/team/bookings/${id}/cancel`
        break
      case 'member removal':
        path = `/api/v1/team/members/${id}/removal`
        body = { teamId: f.expected.id }
        break
      case 'member leave':
        path = `/api/v1/teams/${f.expected.id}/leave`
        break
      case 'native invitation cancellation':
        path = '/api/auth/organization/cancel-invitation'
        body = { invitationId: id }
        break
      case 'native member removal':
        path = '/api/auth/organization/remove-member'
        body = { organizationId: f.expected.id, memberIdOrEmail: id }
        break
      case 'native member leave':
        path = '/api/auth/organization/leave'
        body = { organizationId: f.expected.id }
        break
      case 'native member role':
        path = '/api/auth/organization/update-member-role'
        body = { organizationId: f.expected.id, memberId: id, role: 'member' }
        break
      case 'native team update':
        path = '/api/auth/organization/update'
        body = { organizationId: f.expected.id, data: { name: 'Updated team name' } }
    }
    return target.request(path, {
      method: read ? 'GET' : 'POST',
      headers: {
        cookie: f.cookie,
        origin,
        'content-type': 'application/json',
        ...(expectedId === null ? {} : { [EXPECTED_ORGANIZATION_HEADER]: expectedId }),
      },
      ...(read ? {} : { body: JSON.stringify(body) }),
    })
  }

  it.each(families)(
    '%s reports stale expected management from personal and member spaces',
    async (family) => {
      for (const current of ['personal', 'member'] as const) {
        const f = await fixture(current)
        const response = await request(f, family)
        expect(response.status, `${family}: current ${current}`).toBe(409)
        expect(await response.json()).toMatchObject(
          family.startsWith('native')
            ? { code: 'ORGANIZATION_CONTEXT_CHANGED' }
            : { error: 'organization_context_changed' },
        )
      }
    },
  )

  it.each(families.filter((family) => !selfServiceFamilies.includes(family)))(
    '%s does not reveal expected teams after management is revoked',
    async (family) => {
      for (const current of ['personal', 'member'] as const) {
        const f = await fixture(current, 'member')
        for (const expectedId of [f.expected.id, randomUUID()]) {
          const response = await request(f, family, expectedId)
          expect(response.status, `${family}: current ${current}`).toBe(403)
          expect(await response.json()).toMatchObject(
            family.startsWith('native')
              ? { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }
              : { error: 'team_management_access_denied' },
          )
        }
      }
    },
  )

  it.each(selfServiceFamilies)('%s retains stale member context as a conflict', async (family) => {
    for (const current of ['personal', 'member'] as const) {
      const f = await fixture(current, 'member')
      const response = await request(f, family)
      expect(response.status, `${family}: current ${current}`).toBe(409)
      expect(await response.json()).toMatchObject(
        family.startsWith('native')
          ? { code: 'ORGANIZATION_CONTEXT_CHANGED' }
          : { error: 'organization_context_changed' },
      )
      expect(
        await db
          .selectFrom('auth.member')
          .select('role')
          .where('organizationId', '=', f.expected.id)
          .where('userId', '=', f.user.id)
          .executeTakeFirst(),
      ).toEqual({ role: 'member' })
    }
  })

  it.each(selfServiceFamilies)('%s uniformly denies former members', async (family) => {
    for (const current of ['personal', 'member'] as const) {
      const f = await fixture(current, 'member')
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', f.expected.id)
        .where('userId', '=', f.user.id)
        .execute()
      for (const expectedId of [f.expected.id, randomUUID()]) {
        const response = await request(f, family, expectedId)
        expect(response.status, `${family}: current ${current}`).toBe(403)
        expect(await response.json()).toMatchObject(
          family.startsWith('native')
            ? { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }
            : { error: 'team_management_access_denied' },
        )
      }
    }
  })

  it('does not apply the member self-preview recovery rule to another member', async () => {
    for (const current of ['personal', 'member'] as const) {
      const f = await fixture(current, 'member')
      const peer = await db
        .selectFrom('auth.member')
        .select('userId')
        .where('organizationId', '=', f.expected.id)
        .where('userId', '!=', f.user.id)
        .executeTakeFirstOrThrow()
      const response = await app.request(
        `/api/v1/team/members/${peer.userId}/departure-impact?teamId=${f.expected.id}`,
        { headers: { cookie: f.cookie, [EXPECTED_ORGANIZATION_HEADER]: f.expected.id } },
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
    }
  })

  it.each([
    'bookings',
    'departure impact',
    'removal handling',
    'latest removal handling',
    'team readiness',
  ] as const)('%s detects switches committed after caller resolution', async (family) => {
    for (const current of ['personal', 'member'] as const) {
      const f = await fixture('expected')
      const guarded = application(async () => {
        await db
          .updateTable('auth.session')
          .set({
            activeOrganizationId:
              current === 'personal' ? f.user.principal.organization.id : f.memberTeam.id,
          })
          .where('id', '=', f.sessionId)
          .execute()
      })
      const response = await request(f, family, f.expected.id, guarded)
      expect(response.status, `post-resolution current ${current}`).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
    }
  })

  it.each(['departure impact', 'member leave'] as const)(
    '%s retains member recovery when a switch follows caller resolution',
    async (family) => {
      for (const current of ['personal', 'member'] as const) {
        const f = await fixture('expected', 'member')
        expect((await request(f, 'departure impact')).status).toBe(200)
        const guarded = application(async () => {
          await db
            .updateTable('auth.session')
            .set({
              activeOrganizationId:
                current === 'personal' ? f.user.principal.organization.id : f.memberTeam.id,
            })
            .where('id', '=', f.sessionId)
            .execute()
        })
        const response = await request(f, family, f.expected.id, guarded)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
      }
    },
  )

  it.each(families)('%s uniformly denies malformed expected teams', async (family) => {
    const f = await fixture('expected')
    for (const expectedId of ['', 'invalid']) {
      const response = await request(f, family, expectedId)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject(
        family.startsWith('native')
          ? { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }
          : { error: 'team_management_access_denied' },
      )
    }
  })

  it.each(families)('%s retains its missing-header contract', async (family) => {
    const f = await fixture('expected')
    const response = await request(f, family, null)
    const native = family.startsWith('native')
    const expectedStatus = ['bookings', 'departure impact', 'team readiness'].includes(family)
      ? 200
      : ['removal handling', 'latest removal handling'].includes(family)
        ? 403
        : 409
    expect(response.status).toBe(expectedStatus)
    if (expectedStatus === 409)
      expect(await response.json()).toMatchObject(
        native
          ? { code: 'ORGANIZATION_CONTEXT_CHANGED' }
          : { error: 'organization_context_changed' },
      )
  })
})
