import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db, type Json } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  listPublicSlots,
  listPublicTeamSlots,
  type SelfReadiness,
  type SelfReadinessPage,
  type TeamReadinessPage,
} from '@hourmere/scheduling'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '../../../packages/scheduling/src/testing.ts'
import { publicRoutes } from './routes/public.ts'
import { readinessRoutes } from './routes/readiness.ts'
import { productApp, syntheticSessionCookie } from './routes/test-app.ts'

const bootstrap = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const start = Temporal.Instant.from('2026-11-02T09:00:00Z')
const end = Temporal.Instant.from('2026-11-02T17:00:00Z')
type Mode = 'personal' | 'individual' | 'collective' | 'round_robin'
type Summary = SelfReadiness['summary']
describe.skipIf(!bootstrap)('readiness compared with real availability and HTTP booking', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof productApp>
  const principals = new Map<string, Principal>()

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'readiness_audit' })
    db = createDb(owned.pool)
    app = productApp(db, principals, [
      readinessRoutes({ db, now }),
      publicRoutes({ db, now, rateLimits: { book: { limit: 100, windowSeconds: 60 } } }),
    ])
  })
  afterAll(async () => {
    // A single reused pool (default maximum 10); no auth pool, worker or provider client.
    await owned?.drop()
  })

  async function session(user: TestUser, organization = user.principal.organization) {
    const token = randomUUID()
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organization.id,
        updatedAt: new Date(),
        expiresAt: new Date('2030-11-01T12:00:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const principal: Principal = {
      kind: 'session',
      sessionId: row.id,
      user: user.principal.user,
      organization,
    }
    principals.set(token, principal)
    return { principal, cookie: syntheticSessionCookie(token) }
  }

  async function fixture(mode: Mode = 'personal', scheduled = true) {
    const f = createFixtures(db)
    const owner = await createTestUser(db, 'Readiness audit owner')
    const users =
      mode === 'personal'
        ? [owner]
        : await Promise.all(
            Array.from({ length: mode === 'individual' ? 1 : 2 }, () =>
              createTestUser(db, 'Readiness audit host'),
            ),
          )
    for (const user of users) {
      await db
        .insertInto('profiles')
        .values({
          user_id: user.id,
          handle: `audit-${randomUUID().slice(0, 20)}`,
          time_zone: 'UTC',
        })
        .execute()
      if (scheduled) await f.schedule(user.id, { timeZone: 'UTC' })
    }
    const team =
      mode === 'personal'
        ? null
        : await createTestTeam(db, [
            { user: owner, role: 'owner' },
            ...users.map((user) => ({ user, role: 'member' })),
          ])
    const organization = team?.as(owner).organization ?? owner.principal.organization
    const eventTypeId = await f.eventType(organization.id, mode === 'personal' ? owner.id : null, {
      slug: 'intro',
      hosts: users.map((user) => ({ userId: user.id })),
    })
    if (mode !== 'personal')
      await db
        .updateTable('event_types')
        .set({ scheduling_type: mode })
        .where('id', '=', eventTypeId)
        .execute()
    if (mode === 'round_robin')
      await db
        .insertInto('round_robin_state')
        .values({ event_type_id: eventTypeId, enabled: true })
        .execute()
    const host = users[0] as TestUser
    const profile = await db
      .selectFrom('profiles')
      .select('handle')
      .where('user_id', '=', host.id)
      .executeTakeFirstOrThrow()
    return {
      f,
      host,
      users,
      eventTypeId,
      organization,
      team,
      mode,
      handle: team ? organization.slug : profile.handle,
      session: await session(owner, organization),
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function calendar(
    user: TestUser,
    options: { status?: string; syncedAt?: Date; syncState?: Json; provider?: string } = {},
  ) {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: user.id,
        provider: options.provider ?? 'google',
        external_account_id: randomUUID(),
        credentials: Buffer.from('synthetic-unused-calendar-credential'),
        status: options.status ?? 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: randomUUID(),
        name: 'Synthetic audit calendar',
        time_zone: 'UTC',
        check_conflicts: true,
        last_synced_at: options.syncedAt ?? new Date(now().epochMilliseconds),
        sync_state: options.syncState ?? {
          version: 2,
          timeZone: 'UTC',
          start: '2026-10-01T00:00:00Z',
          end: '2026-12-01T00:00:00Z',
        },
      })
      .execute()
  }

  async function summary(setup: Fixture) {
    const response = await app.request(
      setup.team ? `/api/v1/teams/${setup.organization.id}/readiness` : '/api/v1/readiness/self',
      { headers: { cookie: setup.session.cookie } },
    )
    expect(response.status).toBe(200)
    if (setup.team) {
      const page = (await response.json()) as TeamReadinessPage
      return page.eventTypes.data.find((row) => row.eventTypeId === setup.eventTypeId)?.summary
    }
    const page = (await response.json()) as SelfReadinessPage
    const event = page.eventTypes.data.find((row) => row.subject.id === setup.eventTypeId)
    expect(event?.scope).toBe('configuration_and_cached_sync')
    expect(event?.availability).toBe('not_checked')
    return event?.summary
  }

  async function compare(
    setup: Fixture,
    expected: { summary: Summary; slots: number | string; status: number; error?: string },
  ) {
    expect(await summary(setup)).toBe(expected.summary)
    const slots = (setup.team ? listPublicTeamSlots : listPublicSlots)(
      { db, now },
      { handle: setup.handle, slug: 'intro', start, end },
    )
    if (typeof expected.slots === 'string')
      await expect(slots).rejects.toMatchObject({ code: expected.slots })
    else expect(await slots).toHaveLength(expected.slots)

    // This is the real public route and booking transaction, using the same persisted rows.
    const response = await app.request(
      `/api/v1/public/${setup.team ? 'teams/' : ''}${setup.handle}/intro/bookings`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: start.toString(),
          invitee: { name: 'Audit invitee', email: 'audit-invitee@example.com', timeZone: 'UTC' },
        }),
      },
    )
    expect(response.status).toBe(expected.status)
    // Do not print or compare the returned manage token.
    const body = (await response.json()) as { error?: string; booking?: { id: string } }
    if (expected.error) expect(body.error).toBe(expected.error)
    const bookings = await db
      .selectFrom('bookings')
      .select('id')
      .where('event_type_id', '=', setup.eventTypeId)
      .where('source', '=', 'web')
      .execute()
    expect(bookings).toHaveLength(expected.status === 201 ? 1 : 0)
    if (expected.status === 201) {
      const hosts = await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', (bookings[0] as { id: string }).id)
        .execute()
      expect(hosts).toHaveLength(setup.mode === 'collective' ? 2 : 1)
      return hosts.map((host) => host.user_id)
    }
    return []
  }

  it('missing schedule is blocked, offers no slots and refuses booking', async () => {
    await compare(await fixture('personal', false), {
      summary: 'configuration_blocked',
      slots: 0,
      status: 409,
      error: 'slot_unavailable',
    })
  })

  it.each([
    ['deactivated', { status: 'revoked' }],
    ['expired authorization', { status: 'needs_reauth' }],
    ['expired sync', { syncedAt: new Date(now().subtract({ minutes: 11 }).epochMilliseconds) }],
    ['unknown snapshot version', { syncState: { version: 99 } }],
  ] as const)(
    '%s selected Google calendar is unavailable and refuses booking',
    async (_label, options) => {
      const setup = await fixture()
      await calendar(setup.host, options)
      await compare(setup, {
        summary: 'dependency_unavailable',
        slots: 'calendar_sync_unavailable',
        status: 409,
        error: 'calendar_sync_unavailable',
      })
    },
  )

  it('a provider without cached sync checks stays unchecked while the existing engine can book', async () => {
    const setup = await fixture()
    await calendar(setup.host, { provider: 'caldav' })
    await compare(setup, { summary: 'not_checked', slots: 16, status: 201 })
  })

  it('healthy configuration with a fully booked range is no promise of a free slot', async () => {
    const setup = await fixture()
    await setup.f.booking(
      setup.organization.id,
      [setup.host.id],
      start.toString(),
      end.toString(),
      { eventTypeId: setup.eventTypeId },
    )
    await compare(setup, {
      summary: 'checks_passed',
      slots: 0,
      status: 409,
      error: 'slot_unavailable',
    })
  })

  it.each(['personal', 'individual', 'collective', 'round_robin'] as const)(
    'a disabled %s event type remains disabled and is not publicly bookable',
    async (mode) => {
      const setup = await fixture(mode)
      await db
        .updateTable('event_types')
        .set({ is_active: false })
        .where('id', '=', setup.eventTypeId)
        .execute()
      await compare(setup, {
        summary: 'disabled',
        slots: 'event_type_not_found',
        status: 404,
        error: 'event_type_not_found',
      })
    },
  )

  it.each(['individual', 'collective', 'round_robin'] as const)(
    'a departed %s team host agrees with public availability and booking',
    async (mode) => {
      const setup = await fixture(mode)
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', setup.organization.id)
        .where('userId', '=', setup.host.id)
        .execute()
      const hosts = await compare(
        setup,
        mode === 'round_robin'
          ? { summary: 'partial_pool', slots: 16, status: 201 }
          : {
              summary: 'configuration_blocked',
              slots: 'event_type_not_found',
              status: 404,
              error: 'event_type_not_found',
            },
      )
      if (mode === 'round_robin') expect(hosts).toEqual([setup.users[1]?.id])
    },
  )

  it('healthy collective configuration books both required hosts without external calendars', async () => {
    const setup = await fixture('collective')
    const hosts = await compare(setup, { summary: 'checks_passed', slots: 16, status: 201 })
    expect(hosts.sort()).toEqual(setup.users.map((user) => user.id).sort())
  })

  it('one unavailable collective host blocks the intersection and booking', async () => {
    const setup = await fixture('collective')
    await calendar(setup.host, { status: 'revoked' })
    await compare(setup, {
      summary: 'dependency_unavailable',
      slots: 'calendar_sync_unavailable',
      status: 409,
      error: 'calendar_sync_unavailable',
    })
  })

  it('a round-robin pool with an unavailable calendar can book its healthy host', async () => {
    const setup = await fixture('round_robin')
    await calendar(setup.host, { status: 'revoked' })
    const hosts = await compare(setup, { summary: 'partial_pool', slots: 16, status: 201 })
    expect(hosts).toEqual([setup.users[1]?.id])
  })

  it('a partial round-robin pool does not promise slots when its healthy host is booked', async () => {
    const setup = await fixture('round_robin')
    await calendar(setup.host, { status: 'revoked' })
    await setup.f.booking(
      setup.organization.id,
      [setup.users[1]?.id as string],
      start.toString(),
      end.toString(),
      { eventTypeId: setup.eventTypeId },
    )
    await compare(setup, {
      summary: 'partial_pool',
      slots: 'calendar_sync_unavailable',
      status: 409,
      error: 'calendar_sync_unavailable',
    })
  })

  it('inactive round-robin configuration needs activation and refuses public booking', async () => {
    const setup = await fixture('round_robin')
    await db
      .updateTable('round_robin_state')
      .set({ enabled: false })
      .where('event_type_id', '=', setup.eventTypeId)
      .execute()
    await compare(setup, {
      summary: 'needs_activation',
      slots: 'event_type_not_found',
      status: 404,
      error: 'event_type_not_found',
    })
  })
})
