import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { getSelfReadiness, getTeamReadiness } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { readinessRoutes } from './readiness.ts'

type TeamPage = Awaited<ReturnType<typeof getTeamReadiness>>
type SelfPage = Awaited<ReturnType<typeof getSelfReadiness>>
const selfPath = '/api/v1/readiness/self'
const teamPath = (id: string) => `/api/v1/teams/${id}/readiness`
const denied = { error: 'team_management_access_denied' }
const sizes = [1, 10, 50] as const
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')

function exactKeys(value: object, keys: string[]) {
  expect(Object.keys(value).sort()).toEqual([...keys].sort())
}

function assertNoCanaries(value: unknown, canaries: string[]) {
  const serialized = JSON.stringify(value)
  for (const canary of canaries)
    expect(serialized.includes(canary), `private canary leaked: ${canary}`).toBe(false)
}

// These wire allowlists are deliberately independent of the additive published schema.
function assertTeamProjection(page: TeamPage) {
  exactKeys(page, ['organizationId', 'members', 'eventTypes'])
  for (const part of [page.members, page.eventTypes]) exactKeys(part, ['data', 'nextCursor'])
  expect(page.members.data.length).toBeGreaterThan(0)
  expect(page.eventTypes.data.length).toBeGreaterThan(0)
  const common = ['summary', 'completeness', 'evaluatedAt', 'reasonCodes', 'fixKinds']
  for (const member of page.members.data) exactKeys(member, ['memberId', 'displayName', ...common])
  for (const event of page.eventTypes.data)
    exactKeys(event, ['eventTypeId', 'enablement', 'activation', ...common])
}

describe.skipIf(!process.env.DATABASE_URL)('readiness privacy and HTTP query audit', () => {
  const origin = 'http://localhost:4394'
  const secret = 'synthetic-readiness-audit-session-secret-000000000000'
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let queryCount = 0
  let authQueryCount = 0
  const observedClients = new WeakSet<pg.PoolClient>()

  // Count actual driver calls from both pools, including the real cookie/session
  // resolver and access checks. Do not retain or print query text or parameters.
  function countPool(pool: pg.Pool, authentication = false) {
    pool.on('acquire', (client) => {
      if (observedClients.has(client)) return
      observedClients.add(client)
      const original = client.query
      client.query = ((...args: unknown[]) => {
        queryCount++
        if (authentication) authQueryCount++
        return Reflect.apply(original, client, args)
      }) as typeof client.query
    })
  }
  const queries = () => queryCount

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'readiness_audit',
    })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    countPool(owned.pool)
    countPool(authPool, true)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function application() {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [readinessRoutes({ db, now })],
    })
  }

  async function cookie(user: TestUser, organizationId: string) {
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organizationId,
        // A fresh normal-lived session avoids an unrelated one-time renewal UPDATE.
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

  async function read<T>(path: string, sessionCookie: string) {
    const before = queries()
    const authBefore = authQueryCount
    const response = await application().request(path, {
      headers: { cookie: sessionCookie },
    })
    const count = queries() - before
    const authCount = authQueryCount - authBefore
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return { body: (await response.json()) as T, count, authCount }
  }

  async function privateFixture() {
    const owner = await createTestUser(db, 'Audit owner')
    const admin = await createTestUser(db, 'Audit admin')
    const host = await createTestUser(db, 'Audit member')
    const unnamed = await createTestUser(db, '   ')
    const outsider = await createTestUser(db, 'Unrelated member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: host, role: 'member' },
      { user: unnamed, role: 'member' },
    ])
    const other = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: outsider, role: 'member' },
    ])
    const fx = createFixtures(db)
    const scheduleId = await fx.schedule(host.id, {
      timeZone: 'Pacific/Chatham',
      weeklyHours: { monday: [{ start: '02:13', end: '03:27' }] },
      overrides: [{ date: '2032-04-17', intervals: [{ start: '04:19', end: '05:31' }] }],
    })
    await db
      .updateTable('schedules')
      .set({ name: 'private-schedule-canary' })
      .where('id', '=', scheduleId)
      .execute()
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: host.id,
        provider: 'google',
        external_account_id: 'private-account-identifier-canary',
        account_email: 'private-calendar-account-canary@example.com',
        credentials: Buffer.from('synthetic-unused-audit-credential'),
        status: 'needs_reauth',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'private-calendar-identifier-canary',
        name: 'private-calendar-title-canary',
        check_conflicts: true,
        sync_error: 'needs_reauth',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('calendar_busy')
      .values({
        calendar_id: calendar.id,
        external_event_id: 'private-external-event-canary',
        period: '[2033-08-19T11:23:00Z,2033-08-19T12:41:00Z)',
      })
      .execute()
    const eventId = await fx.eventType(team.id, null, { hosts: [{ userId: host.id }] })
    const otherEventId = await fx.eventType(other.id, null, { hosts: [{ userId: outsider.id }] })
    const bookingId = await fx.booking(
      team.id,
      [host.id],
      '2032-04-18T14:07:00Z',
      '2032-04-18T14:37:00Z',
      { eventTypeId: eventId },
    )
    await db
      .updateTable('bookings')
      .set({
        title: 'private-booking-title-canary',
        responses: JSON.stringify({ private_answer: 'private-event-detail-canary' }),
      })
      .where('id', '=', bookingId)
      .execute()
    const members = await db
      .selectFrom('auth.member')
      .select(['id', 'userId'])
      .where('organizationId', '=', team.id)
      .orderBy('id')
      .execute()
    return {
      owner,
      admin,
      host,
      outsider,
      team,
      other,
      eventId,
      otherEventId,
      expected: {
        organizationId: team.id,
        members: {
          data: members.map((member) => ({
            memberId: member.id,
            displayName:
              member.userId === owner.id
                ? 'Audit owner'
                : member.userId === admin.id
                  ? 'Audit admin'
                  : member.userId === host.id
                    ? 'Audit member'
                    : 'Team member',
            summary: member.userId === host.id ? 'dependency_unavailable' : 'configuration_blocked',
            completeness: 'complete',
            evaluatedAt: now().toString(),
            reasonCodes: [
              member.userId === host.id
                ? 'calendar_attention_required'
                : 'default_schedule_required',
            ],
            fixKinds: ['ask_member'],
          })),
          nextCursor: null,
        },
        eventTypes: {
          data: [
            {
              eventTypeId: eventId,
              enablement: 'enabled',
              activation: 'not_applicable',
              summary: 'dependency_unavailable',
              completeness: 'complete',
              evaluatedAt: now().toString(),
              reasonCodes: ['calendar_attention_required'],
              fixKinds: ['ask_member'],
            },
          ],
          nextCursor: null,
        },
      },
      canaries: [
        host.email,
        host.id,
        outsider.email,
        outsider.id,
        outsider.name,
        scheduleId,
        connection.id,
        calendar.id,
        bookingId,
        other.id,
        otherEventId,
        'private-schedule-canary',
        'Pacific/Chatham',
        '02:13',
        '03:27',
        '2032-04-17',
        '04/17/2032',
        '17/04/2032',
        '2032/04/17',
        '17.04.2032',
        'April 17, 2032',
        '17 April 2032',
        '04:19',
        '05:31',
        'private-account-identifier-canary',
        'private-calendar-account-canary@example.com',
        'private-calendar-identifier-canary',
        'private-calendar-title-canary',
        'private-external-event-canary',
        '2033-08-19',
        '2033-08-19T11:23',
        '2033-08-19T12:41',
        '2033-08-19 11:23',
        '2033-08-19 12:41',
        '08/19/2033',
        '19/08/2033',
        '2033/08/19',
        '19.08.2033',
        'August 19, 2033',
        '19 August 2033',
        '11:23',
        '12:41',
        'private-booking-title-canary',
        'private-event-detail-canary',
      ],
    }
  }

  it('returns only exact coarse keys to real owner/admin cookies while retaining private self detail', async () => {
    const f = await privateFixture()
    for (const manager of [f.owner, f.admin]) {
      const sessionCookie = await cookie(manager, f.team.id)
      const { body } = await read<TeamPage>(teamPath(f.team.id), sessionCookie)
      assertTeamProjection(body)
      assertNoCanaries(body, f.canaries)
      // Exact values close every string channel, including names, labels and reasons.
      expect(body).toEqual(f.expected)
      const { body: self } = await read<SelfPage>(selfPath, sessionCookie)
      expect(self.member.details).toEqual({ schedules: [], calendars: [] })
      expect(self.eventTypes.data).toEqual([])
    }
    const { body: own } = await read<SelfPage>(selfPath, await cookie(f.host, f.team.id))
    expect(own.member.details.schedules[0]?.name).toBe('private-schedule-canary')
    expect(own.member.details.calendars[0]?.name).toBe('private-calendar-title-canary')
    expect(own.member.details.calendars[0]?.accountEmail).toBe(
      'private-calendar-account-canary@example.com',
    )
    expect(own.eventTypes.data).toEqual([])
  })

  it('uniformly denies members, cross-team targets and non-session credentials without data', async () => {
    const f = await privateFixture()
    const app = application()
    const ownerCookie = await cookie(f.owner, f.team.id)
    const memberCookie = await cookie(f.host, f.team.id)
    const outsiderCookie = await cookie(f.outsider, f.other.id)
    const key = await auth.api.createApiKey({
      body: { userId: f.owner.id, metadata: { organizationId: f.team.id } },
    })
    const requests = [
      { path: teamPath(f.team.id), headers: {} },
      { path: teamPath(f.team.id), headers: { cookie: 'better-auth.session_token=invalid' } },
      { path: teamPath(f.team.id), headers: { cookie: memberCookie } },
      { path: teamPath(f.team.id), headers: { cookie: outsiderCookie } },
      { path: teamPath(f.other.id), headers: { cookie: ownerCookie } },
      { path: teamPath(randomUUID()), headers: { cookie: ownerCookie } },
      { path: teamPath(f.team.id), headers: { authorization: `Bearer ${key.key}` } },
      {
        path: teamPath(f.team.id),
        headers: { cookie: ownerCookie, authorization: `Bearer ${key.key}` },
      },
      {
        path: teamPath(f.team.id),
        headers: { cookie: ownerCookie, authorization: 'Bearer invalid' },
      },
      { path: teamPath(f.team.id), headers: { cookie: ownerCookie, authorization: '' } },
    ]
    for (const request of requests) {
      const response = await app.request(request.path, { headers: request.headers })
      expect(response.status).toBe(403)
      expect(response.headers.get('www-authenticate')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual(denied)
    }
    for (const sessionCookie of [undefined, ownerCookie]) {
      const response = await app.request(selfPath, {
        headers: {
          ...(sessionCookie && { cookie: sessionCookie }),
          authorization: `Bearer ${key.key}`,
        },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'readiness_access_denied' })
    }
  })

  async function connectedAccounts(userId: string, calendarCount = 1) {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: 'google',
        external_account_id: randomUUID(),
        account_email: `audit-calendar-${randomUUID()}@example.com`,
        credentials: Buffer.from('synthetic-unused-calendar-credential'),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('calendars')
      .values(
        Array.from({ length: calendarCount }, () => ({
          connection_id: connection.id,
          external_id: randomUUID(),
          name: `Audit calendar ${randomUUID()}`,
          time_zone: 'UTC',
          check_conflicts: true,
          last_synced_at: new Date(now().epochMilliseconds),
          sync_state: {
            version: 2,
            timeZone: 'UTC',
            start: '2026-10-01T00:00:00Z',
            end: '2026-12-01T00:00:00Z',
            token: 'synthetic-unused-sync-cursor',
          },
        })),
      )
      .execute()
    await db
      .insertInto('conference_connections')
      .values({
        user_id: userId,
        provider: 'zoom',
        external_user_id: randomUUID(),
        mode: 'identity',
        scopes: ['user:read:user'],
        status: 'active',
        credentials: Buffer.from('synthetic-unused-conference-credential'),
      })
      .execute()
  }

  it.each(['personal events', 'team events', 'team members'] as const)(
    'keeps complete HTTP query cost constant for 1, 10 and 50 %s with connected accounts',
    async (pathKind) => {
      const owner = await createTestUser(db)
      const fx = createFixtures(db)
      await fx.schedule(owner.id)
      const personal = pathKind === 'personal events'
      const team = personal ? undefined : await createTestTeam(db, [{ user: owner, role: 'owner' }])
      const organizationId = team?.id ?? owner.principal.organization.id
      // A personal page shares one owner's facts across its events. Fifty selected
      // calendars also make a per-calendar loader exceed the fixed query budget.
      if (personal) await connectedAccounts(owner.id, 50)
      for (let index = 0; index < 50; index++) {
        const host =
          personal || (pathKind === 'team members' && index === 0)
            ? owner
            : await createTestUser(db)
        if (!personal) {
          if (host !== owner) {
            await fx.member(host.id, organizationId)
            await fx.schedule(host.id)
          }
          await connectedAccounts(host.id)
        }
        if (pathKind !== 'team members' || index === 0)
          await fx.eventType(organizationId, personal ? owner.id : null, {
            hosts: [{ userId: host.id }],
          })
      }
      const sessionCookie = await cookie(owner, organizationId)
      const requestPath = personal ? selfPath : teamPath(organizationId)
      const measured = async () => {
        const counts: number[] = []
        for (const size of sizes) {
          const { body, count, authCount } = await read<SelfPage | TeamPage>(
            `${requestPath}?limit=${size}`,
            sessionCookie,
          )
          const page = pathKind === 'team members' ? (body as TeamPage).members : body.eventTypes
          expect(page.data).toHaveLength(size)
          expect(count).toBeGreaterThan(0)
          expect(authCount).toBeGreaterThan(0)
          if (personal) {
            expect((body as SelfPage).member.details.calendars).toHaveLength(50)
            expect((body as SelfPage).member.details.calendars.every((c) => c.checkConflicts)).toBe(
              true,
            )
          }
          counts.push(count)
        }
        return counts
      }
      const assertConstant = (counts: number[]) => {
        expect(counts).toEqual([counts[0], counts[0], counts[0]])
        expect(counts[0]).toBeLessThan(40)
      }
      const counts = await measured()
      // Numeric evidence only; never emit cookies, credential strings or SQL arguments.
      console.info(`readiness HTTP queries (${pathKind}; N=1,10,50): ${counts.join(',')}`)
      assertConstant(counts)
      expect(owned.pool.totalCount + authPool.totalCount).toBeLessThanOrEqual(20)
    },
  )
})
