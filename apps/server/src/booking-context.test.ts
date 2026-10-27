import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const bootstrap = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const secret = 'synthetic-booking-context-session-secret-0000000'
const NOW = Temporal.Instant.from('2030-11-01T12:00:00Z')
const actions = ['cancel', 'reschedule', 'conference/retry', 'calendar-copy/retry'] as const
type Action = (typeof actions)[number]
const refused = {
  error: 'organization_context_changed',
  message: 'Your team context changed. Reload the page before trying again.',
}
const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe.skipIf(!bootstrap)('organization-bound host booking writes', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let limitedPool: pg.Pool
  let app: ReturnType<typeof createApp>
  let afterResolution: (() => Promise<void>) | undefined
  let onNotification: (() => Promise<void>) | undefined
  const keys = new Map<string, Principal>()

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    limitedPool = new pg.Pool({
      connectionString: owned.url,
      max: 1,
      statement_timeout: 1000,
      connectionTimeoutMillis: 1000,
    })
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: {
        send: async () => {
          throw new Error('Real mail forbidden')
        },
      },
    })
    const resolve = createCallerResolver({ auth, db })
    app = createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const key = keys.get(headers.get('authorization') ?? '')
        const result = key
          ? { ok: true as const, principal: key, setCookie: [] }
          : await resolve(headers)
        const hook = afterResolution
        afterResolution = undefined
        await hook?.()
        return result
      },
      routes: [
        bookingRoutes({
          db,
          now: () => NOW,
          notify: async () => {
            const hook = onNotification
            onNotification = undefined
            await hook?.()
          },
        }),
      ],
    })
  })

  afterAll(async () => {
    await limitedPool?.end()
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db, 'Team owner')
    const host = await createTestUser(db, 'Member host')
    const members = [
      { user: owner, role: 'owner' },
      { user: host, role: 'member' },
    ]
    const first = await createTestTeam(db, members, 'Original booking team')
    const second = await createTestTeam(db, members, 'Other booking team')
    const f = createFixtures(db)
    await f.schedule(host.id, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(first.id, host.id)
    const bookingId = await f.booking(
      first.id,
      [host.id],
      '2030-11-04T09:00Z',
      '2030-11-04T09:30Z',
      { eventTypeId },
    )
    // Retry only reconciles durable intent state; no provider worker or provider client runs.
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: bookingId,
        booking_id: bookingId,
        organization_id: first.id,
        organizer_user_id: host.id,
        calendar_id: randomUUID(),
        connection_id: randomUUID(),
        state: 'failed',
        error_code: 'provider_unavailable',
      })
      .execute()
    await db
      .insertInto('booking_conference_mirrors')
      .values({
        root_booking_id: bookingId,
        user_id: host.id,
        calendar_id: randomUUID(),
        connection_id: randomUUID(),
        state: 'failed',
        error_code: 'provider_unavailable',
      })
      .execute()
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: host.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: first.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    const key = `Bearer synthetic-booking-key-${randomUUID()}`
    keys.set(key, first.as(host))
    return { host, first, second, sessionId: session.id, cookie, bookingId, key }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function request(
    f: Fixture,
    action: Action,
    expected: string | undefined = f.first.id,
    headers: Record<string, string> = {},
  ) {
    return app.request(`/api/v1/bookings/${f.bookingId}/${action}`, {
      method: 'POST',
      headers: {
        origin,
        cookie: f.cookie,
        'content-type': 'application/json',
        ...(expected === undefined ? {} : { [EXPECTED_ORGANIZATION_HEADER]: expected }),
        ...headers,
      },
      body: JSON.stringify(action === 'reschedule' ? { start: '2030-11-05T09:00:00Z' } : {}),
    })
  }
  async function snapshot(f: Fixture) {
    const booking = await db
      .selectFrom('bookings')
      .select(['status', 'start_at'])
      .where('id', '=', f.bookingId)
      .executeTakeFirstOrThrow()
    const conference = await db
      .selectFrom('booking_conferences')
      .select(['state', 'attempts'])
      .where('root_booking_id', '=', f.bookingId)
      .executeTakeFirstOrThrow()
    const copy = await db
      .selectFrom('booking_conference_mirrors')
      .select(['state', 'attempts'])
      .where('root_booking_id', '=', f.bookingId)
      .executeTakeFirstOrThrow()
    return { booking, conference, copy }
  }
  const switchTeam = (f: Fixture) =>
    auth.handler(
      new Request(`${origin}/api/auth/organization/set-active`, {
        method: 'POST',
        headers: { origin, cookie: f.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: f.second.id }),
      }),
    )

  it.each(actions)(
    'refuses an old %s action after another tab switches, without changing durable state',
    async (action) => {
      const f = await fixture()
      const before = await snapshot(f)
      expect((await switchTeam(f)).status).toBe(200)
      const result = await request(f, action)
      expect(result.status).toBe(409)
      expect(await result.json()).toEqual(refused)
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it.each(actions)('rechecks a switch committed after caller resolution for %s', async (action) => {
    const f = await fixture()
    const before = await snapshot(f)
    afterResolution = async () => {
      expect((await switchTeam(f)).status).toBe(200)
    }
    const result = await request(f, action)
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual(refused)
    expect(await snapshot(f)).toEqual(before)
  })

  it.each(actions)(
    'allows a current ordinary member host to %s with the original organization',
    async (action) => {
      const f = await fixture()
      const result = await request(f, action)
      expect(result.status).toBe(action.endsWith('/retry') ? 204 : 200)
      const after = await snapshot(f)
      if (action === 'conference/retry') expect(after.conference.state).toBe('pending')
      else if (action === 'calendar-copy/retry') expect(after.copy.state).toBe('pending')
      else expect(after.booking.status).toBe('cancelled')
    },
  )

  it.each(['missing', 'api-key'] as const)('preserves %s context compatibility', async (kind) => {
    const f = await fixture()
    const result =
      kind === 'missing'
        ? await app.request(`/api/v1/bookings/${f.bookingId}/cancel`, {
            method: 'POST',
            headers: { origin, cookie: f.cookie, 'content-type': 'application/json' },
            body: '{}',
          })
        : await request(f, 'cancel', f.second.id, { authorization: f.key })
    expect(result.status).toBe(200)
    expect((await snapshot(f)).booking.status).toBe('cancelled')
  })

  it.each(['removed', 'expired', 'unverified'] as const)(
    'refuses a bound action when the caller becomes %s after resolution',
    async (reason) => {
      const f = await fixture()
      const before = await snapshot(f)
      afterResolution = async () => {
        if (reason === 'removed')
          await db
            .deleteFrom('auth.member')
            .where('organizationId', '=', f.first.id)
            .where('userId', '=', f.host.id)
            .execute()
        else if (reason === 'expired')
          await db
            .updateTable('auth.session')
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where('id', '=', f.sessionId)
            .execute()
        else
          await db
            .updateTable('auth.user')
            .set({ emailVerified: false })
            .where('id', '=', f.host.id)
            .execute()
      }
      const result = await request(f, 'cancel')
      expect(result.status).toBe(409)
      expect(await result.json()).toEqual(refused)
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it.each(actions)(
    'keeps unknown, inaccessible and other-organization %s targets indistinguishable',
    async (action) => {
      const f = await fixture()
      const before = await snapshot(f)
      const other = await createTestUser(db, 'Other member host')
      await db
        .insertInto('auth.member')
        .values({
          userId: other.id,
          organizationId: f.first.id,
          role: 'member',
          createdAt: new Date(),
        })
        .execute()
      const inaccessible = await createFixtures(db).booking(
        f.first.id,
        [other.id],
        '2030-11-05T10:00Z',
        '2030-11-05T10:30Z',
      )
      const otherOrganization = await createFixtures(db).booking(
        f.second.id,
        [f.host.id],
        '2030-11-05T11:00Z',
        '2030-11-05T11:30Z',
      )
      for (const [bookingId, organizationId, hostId] of [
        [inaccessible, f.first.id, other.id],
        [otherOrganization, f.second.id, f.host.id],
      ] as const) {
        await db
          .insertInto('booking_conferences')
          .values({
            root_booking_id: bookingId,
            booking_id: bookingId,
            organization_id: organizationId,
            organizer_user_id: hostId,
            calendar_id: randomUUID(),
            connection_id: randomUUID(),
            state: 'failed',
            error_code: 'provider_unavailable',
          })
          .execute()
        await db
          .insertInto('booking_conference_mirrors')
          .values({
            root_booking_id: bookingId,
            user_id: hostId,
            calendar_id: randomUUID(),
            connection_id: randomUUID(),
            state: 'failed',
            error_code: 'provider_unavailable',
          })
          .execute()
      }
      const statuses: number[] = []
      const bodies: { error: string }[] = []
      for (const bookingId of [randomUUID(), inaccessible, otherOrganization]) {
        const response = await request({ ...f, bookingId }, action)
        statuses.push(response.status)
        bodies.push((await response.json()) as { error: string })
      }
      expect(statuses).toEqual([404, 404, 404])
      const code =
        action === 'conference/retry'
          ? 'conference_not_found'
          : action === 'calendar-copy/retry'
            ? 'calendar_copy_not_found'
            : 'booking_not_found'
      expect(bodies[0]?.error).toBe(code)
      expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]])
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it.each(['', 'not-an-organization', randomUUID()])(
    'refuses a mismatched or malformed expected organization without changing the current booking (%#)',
    async (expected) => {
      const f = await fixture()
      const before = await snapshot(f)
      const result = await request(f, 'cancel', expected)
      expect(result.status).toBe(409)
      expect(await result.json()).toEqual(refused)
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it('accepts a personal booking when the live session has no active organization', async () => {
    const f = await fixture()
    const personalId = f.host.principal.organization.id
    const bookingId = await createFixtures(db).booking(
      personalId,
      [f.host.id],
      '2030-11-05T09:00Z',
      '2030-11-05T09:30Z',
    )
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: null })
      .where('id', '=', f.sessionId)
      .execute()
    const result = await request({ ...f, bookingId }, 'cancel', personalId)
    expect(result.status).toBe(200)
  })

  it('keeps an already checked booking write ahead of an overlapping real organization switch', async () => {
    const f = await fixture()
    const entered = barrier()
    const release = barrier()
    onNotification = async () => {
      entered.release()
      await release.promise
    }
    const write = request(f, 'cancel')
    await entered.promise
    let switched = false
    const switching = switchTeam(f).then((response) => {
      switched = true
      return response
    })
    try {
      await vi.waitFor(
        async () => {
          const waiting = await owned.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
          )
          expect(waiting.rows[0]?.n).toBeGreaterThan(0)
        },
        { timeout: 1500 },
      )
      expect(switched).toBe(false)
    } finally {
      release.release()
      await Promise.allSettled([write, switching])
    }
    expect((await write).status).toBe(200)
    expect((await switching).status).toBe(200)
    expect((await snapshot(f)).booking.status).toBe('cancelled')
    const session = await db
      .selectFrom('auth.session')
      .select('activeOrganizationId')
      .where('id', '=', f.sessionId)
      .executeTakeFirstOrThrow()
    expect(session.activeOrganizationId).toBe(f.second.id)
  })

  it('refuses busy booking writes without starving a bound organization switch in a one-connection app pool', async () => {
    const f = await fixture()
    const limitedDb = createDb(limitedPool)
    const limitedAuth = createAuth({
      pool: authPool,
      db: limitedDb,
      baseURL: origin,
      secret,
      signup: { mode: 'closed', allowedDomains: [] },
      mailer: {
        send: async () => {
          throw new Error('Real mail forbidden')
        },
      },
    })
    const limitedApp = createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: limitedAuth.handler,
      resolveCaller: createCallerResolver({ auth: limitedAuth, db: limitedDb }),
      routes: [bookingRoutes({ db: limitedDb, now: () => NOW })],
    })
    const blocker = await owned.pool.connect()
    let switching: Promise<Response> | undefined
    let bookingWrite: Promise<Response> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `hourmere.organization-context:${f.sessionId}`,
      ])
      switching = limitedAuth.handler(
        new Request(`${origin}/api/auth/organization/set-active`, {
          method: 'POST',
          headers: {
            origin,
            cookie: f.cookie,
            'content-type': 'application/json',
            [EXPECTED_ORGANIZATION_HEADER]: f.first.id,
          },
          body: JSON.stringify({ organizationId: f.second.id }),
        }),
      )
      await vi.waitFor(
        async () => {
          const waiting = await owned.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
          )
          expect(waiting.rows[0]?.n).toBeGreaterThan(0)
        },
        { timeout: 1500 },
      )
      bookingWrite = Promise.resolve(
        limitedApp.request(`/api/v1/bookings/${f.bookingId}/cancel`, {
          method: 'POST',
          headers: {
            origin,
            cookie: f.cookie,
            'content-type': 'application/json',
            [EXPECTED_ORGANIZATION_HEADER]: f.first.id,
          },
          body: '{}',
        }),
      )
      const result = await bookingWrite
      expect(result.status).toBe(409)
      expect(await result.json()).toEqual(refused)
      expect((await snapshot(f)).booking.status).toBe('confirmed')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled([switching, bookingWrite])
    }
    expect((await switching)?.status).toBe(200)
    expect(limitedPool.totalCount).toBeLessThanOrEqual(1)
  })
})
