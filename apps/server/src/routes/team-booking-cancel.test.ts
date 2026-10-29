import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
} from '@hourmere/notifications'
import * as scheduling from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { signTestMcpAccessToken } from '../../../../packages/auth/src/testing.ts'
import { createApp } from '../app.ts'
import { bookingTools } from '../mcp/bookings.ts'
import { mcpEndpoint } from '../mcp/endpoint.ts'
import * as openapi from '../openapi.ts'
import { productRoutes } from '../server.ts'
import * as management from '../team-management.ts'
import * as bookings from './bookings.ts'
import { teamBookingRoutes } from './team-bookings.ts'
import { openApiDocument, resolve, responseAndRequestStrictness } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4398'
const secret = 'synthetic-team-cancellation-session-secret-000000000000'
const routePath = '/api/v1/team/bookings/{id}/cancel'
const path = (id: string) => `/api/v1/team/bookings/${id}/cancel`
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const START = '2030-11-04T09:00:00Z'
const END = '2030-11-04T09:30:00Z'
const denied = { error: 'team_management_access_denied' }
type RouteFactory = typeof teamBookingRoutes

describe.skipIf(!serverUrl)('team booking cancellation HTTP boundary', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let resolveCaller: ReturnType<typeof createCallerResolver>
  let jobs: ReturnType<typeof createJobs>
  let notify: scheduling.BookingNotifier
  let app: ReturnType<typeof createApp>
  const sent: MailMessage[] = []

  const mail = () =>
    bookingNotificationJob({
      db,
      secret,
      publicUrl: origin,
      now: () => NOW,
      mailMaxPerHour: 0,
      mailRecipientMaxPerHour: 100,
      mailer: {
        senderEmail: 'calendar@example.test',
        async send(message) {
          sent.push(message)
        },
      },
      log: () => {},
    })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_cancel_http' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // One shared auth pool and a two-connection job pool keep this file well below 100.
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
    resolveCaller = createCallerResolver({ auth, db })
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [mail()],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
    notify = bookingNotifier(jobs)
    app = application()
  })

  afterAll(async () => {
    await jobs?.stop()
    await authPool?.end()
    await owned?.drop()
  })

  function application(
    options: {
      factory?: RouteFactory
      notify?: scheduling.BookingNotifier | null
      afterResolve?: () => Promise<void>
      production?: boolean
    } = {},
  ) {
    const notifier = options.notify === null ? undefined : (options.notify ?? notify)
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const result = await resolveCaller(headers)
        if (result.ok) await options.afterResolve?.()
        return result
      },
      routes: options.production
        ? productRoutes({ db, socialProviders: {}, notify: notifier })
        : [
            bookings.bookingRoutes({ db, now: () => NOW, notify: notifier }),
            (options.factory ?? teamBookingRoutes)({ db, now: () => NOW, notify: notifier }),
          ],
      mcp: mcpEndpoint({
        tools: bookingTools({ db, now: () => NOW, notify: notifier }),
        oauth: {
          resolve: createMcpOAuthResolver({ auth, db, publicUrl: origin }),
          handler: auth.handler,
        },
      }),
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
      sessionId: row.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(role = 'admin') {
    const manager = await createTestUser(db, 'Acting administrator')
    const host = await createTestUser(db, 'Original host')
    const team = await createTestTeam(db, [
      { user: manager, role },
      { user: host, role: 'owner' },
    ])
    const other = await createTestTeam(db, [
      { user: manager, role: 'owner' },
      { user: host, role: 'member' },
    ])
    const fx = createFixtures(db)
    const eventId = await fx.eventType(team.id, null, {
      title: 'Team coordination',
      hosts: [{ userId: host.id }],
    })
    const booking = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('bookings')
        .values({
          organization_id: team.id,
          event_type_id: eventId,
          title: 'Team coordination',
          start_at: START,
          end_at: END,
          source: 'api',
          required_host_user_ids: [host.id],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('booking_hosts')
        .values({ booking_id: row.id, user_id: host.id })
        .execute()
      await trx
        .insertInto('booking_attendees')
        .values({
          booking_id: row.id,
          name: 'Invitee',
          email: 'invitee@example.com',
          time_zone: 'UTC',
          is_booker: true,
        })
        .execute()
      return row.id
    })
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: booking,
        name: 'Guest',
        email: 'guest@example.test',
        time_zone: 'UTC',
        is_booker: false,
      })
      .execute()
    const otherBooking = await fx.booking(
      other.id,
      [host.id],
      '2030-11-05T09:00:00Z',
      '2030-11-05T09:30:00Z',
    )
    const personalBooking = await fx.booking(
      manager.principal.organization.id,
      [manager.id],
      START,
      END,
    )
    return {
      manager,
      host,
      team,
      other,
      booking,
      otherBooking,
      personalBooking,
      ...(await session(manager, team.id)),
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function cancel(
    f: Fixture,
    options: {
      id?: string
      cookie?: string | null
      headers?: Record<string, string>
      expectedOrganizationId?: string | null
      sources?: Record<string, string>
      body?: unknown
      rawBody?: string
      app?: ReturnType<typeof createApp>
    } = {},
  ) {
    const cookie = options.cookie === null ? undefined : (options.cookie ?? f.cookie)
    const expected =
      options.expectedOrganizationId === null
        ? undefined
        : (options.expectedOrganizationId ?? f.team.id)
    return (options.app ?? app).request(path(options.id ?? f.booking), {
      method: 'POST',
      headers: {
        ...(cookie && { cookie }),
        ...(options.sources ?? { origin }),
        ...(expected && { 'x-expected-organization-id': expected }),
        'content-type': 'application/json',
        ...options.headers,
      },
      body: options.rawBody ?? JSON.stringify(options.body ?? {}),
    })
  }

  const stored = (id: string) =>
    db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const operations = (id: string) =>
    db.selectFrom('organization_operations').selectAll().where('booking_id', '=', id).execute()
  async function queued(id: string) {
    return (
      await owned.pool.query<{ id: string; data: unknown }>(
        "SELECT id, data FROM pgboss.job WHERE name=$1 AND data->>'bookingId'=$2 ORDER BY id",
        [BOOKING_NOTIFICATION_JOB, id],
      )
    ).rows
  }
  async function answer(response: Response) {
    expect(response.headers.get('cache-control')).toBe('no-store')
    return { status: response.status, body: await response.json() }
  }
  async function expectDenied(response: Response) {
    expect(await answer(response)).toEqual({ status: 403, body: denied })
  }
  async function expectUnchanged(id: string, before: Awaited<ReturnType<typeof stored>>) {
    expect(await stored(id)).toEqual(before)
    expect(await operations(id)).toEqual([])
    expect(await queued(id)).toEqual([])
  }
  async function expectContextChanged(response: Response) {
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
  }

  it.each(['owner', 'admin', 'member, admin', 'admin, owner'])(
    'allows a current verified %s to cancel another host’s team booking',
    async (role) => {
      const f = await fixture(role)
      const before = await stored(f.booking)
      expect(await answer(await cancel(f, { body: { reason: 'Host unavailable' } }))).toEqual({
        status: 200,
        body: { cancelled: true },
      })
      expect(await stored(f.booking)).toMatchObject({
        status: 'cancelled',
        cancelled_at: new Date(NOW.toString()),
        cancel_reason: 'Host unavailable',
        required_host_user_ids: [f.host.id],
        source: before.source,
        api_key_id: before.api_key_id,
      })
      expect(await operations(f.booking)).toMatchObject([
        { actor_user_id: f.manager.id, organization_id: f.team.id, source: 'web' },
      ])
      expect((await queued(f.booking)).map((row) => row.data)).toEqual([
        { bookingId: f.booking, kind: 'cancelled' },
      ])
    },
  )

  const unsafeSources: Record<string, string>[] = [
    {},
    { origin: 'null' },
    { origin: 'null', referer: `${origin}/app/bookings` },
    { origin: 'https://other.example' },
    { referer: 'https://other.example/app/bookings' },
    { origin: 'https://other.example', referer: `${origin}/app/bookings` },
    { referer: 'invalid-url' },
  ]
  it.each(unsafeSources)(
    'refuses a session write with unsafe Origin/Referer %j before cancelling',
    async (sources) => {
      const f = await fixture()
      const before = await stored(f.booking)
      const response = await cancel(f, { sources })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'forbidden' })
      await expectUnchanged(f.booking, before)
    },
  )

  it('accepts the existing same-origin Referer fallback when Origin is absent', async () => {
    const f = await fixture()
    expect(
      (await cancel(f, { sources: { referer: `${origin}/app/bookings?tab=team` } })).status,
    ).toBe(200)
  })

  it.each(['member', 'superadmin', 'administrator', 'team-owner', 'OWNER'])(
    'uniformly refuses the %s role for an existing and unknown booking',
    async (role) => {
      const f = await fixture(role)
      const before = await stored(f.booking)
      for (const id of [f.booking, f.otherBooking, f.personalBooking, randomUUID()])
        await expectDenied(await cancel(f, { id }))
      await expectUnchanged(f.booking, before)
    },
  )

  it('uniformly refuses other-team, personal, unknown and already-started targets', async () => {
    const f = await fixture()
    const started = await createFixtures(db).booking(
      f.team.id,
      [f.host.id],
      '2030-11-03T11:30:00Z',
      NOW.toString(),
    )
    for (const id of [f.otherBooking, f.personalBooking, started]) {
      const before = await stored(id)
      await expectDenied(await cancel(f, { id }))
      await expectUnchanged(id, before)
    }
    await expectDenied(await cancel(f, { id: randomUUID() }))
    const personal = await session(f.manager, f.manager.principal.organization.id)
    await expectDenied(
      await cancel(f, {
        cookie: personal.cookie,
        expectedOrganizationId: f.manager.principal.organization.id,
        id: f.personalBooking,
      }),
    )
  })

  it.each(['removed', 'demoted', 'unverified'])(
    'refuses a %s administrator in their existing browser session',
    async (change) => {
      const f = await fixture()
      const before = await stored(f.booking)
      if (change === 'removed')
        await db
          .deleteFrom('auth.member')
          .where('userId', '=', f.manager.id)
          .where('organizationId', '=', f.team.id)
          .execute()
      else if (change === 'demoted')
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('userId', '=', f.manager.id)
          .where('organizationId', '=', f.team.id)
          .execute()
      else
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', f.manager.id)
          .execute()
      for (const id of [f.booking, randomUUID()]) await expectDenied(await cancel(f, { id }))
      await expectUnchanged(f.booking, before)
    },
  )

  it.each(['removed', 'demoted', 'unverified', 'deleted_session', 'expired_session'])(
    'rechecks %s committed after the real caller resolver',
    async (change) => {
      const f = await fixture()
      const before = await stored(f.booking)
      const guarded = application({
        afterResolve: async () => {
          if (change === 'removed')
            await db
              .deleteFrom('auth.member')
              .where('userId', '=', f.manager.id)
              .where('organizationId', '=', f.team.id)
              .execute()
          else if (change === 'demoted')
            await db
              .updateTable('auth.member')
              .set({ role: 'member' })
              .where('userId', '=', f.manager.id)
              .where('organizationId', '=', f.team.id)
              .execute()
          else if (change === 'unverified')
            await db
              .updateTable('auth.user')
              .set({ emailVerified: false })
              .where('id', '=', f.manager.id)
              .execute()
          else if (change === 'deleted_session')
            await db.deleteFrom('auth.session').where('id', '=', f.sessionId).execute()
          else
            await db
              .updateTable('auth.session')
              .set({ expiresAt: new Date(Date.now() - 60_000) })
              .where('id', '=', f.sessionId)
              .execute()
        },
      })
      await expectDenied(await cancel(f, { app: guarded }))
      await expectUnchanged(f.booking, before)
    },
  )

  it.each([null, '', 'invalid', randomUUID()])(
    'requires the expected organization and refuses context %j',
    async (expectedOrganizationId) => {
      const f = await fixture()
      const before = await stored(f.booking)
      await expectContextChanged(await cancel(f, { expectedOrganizationId }))
      await expectUnchanged(f.booking, before)
    },
  )

  it('refuses a stale tab after the current session switches teams', async () => {
    const f = await fixture()
    const before = await stored(f.booking)
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.other.id })
      .where('id', '=', f.sessionId)
      .execute()
    await expectContextChanged(await cancel(f))
    await expectUnchanged(f.booking, before)
    // Replacing the expected header with the new team cannot authorize the old target.
    await expectDenied(await cancel(f, { expectedOrganizationId: f.other.id }))
  })

  it('rechecks session context when a switch commits after the caller resolver', async () => {
    const f = await fixture()
    const before = await stored(f.booking)
    const guarded = application({
      afterResolve: async () => {
        await db
          .updateTable('auth.session')
          .set({ activeOrganizationId: f.other.id })
          .where('id', '=', f.sessionId)
          .execute()
      },
    })
    await expectContextChanged(await cancel(f, { app: guarded }))
    await expectUnchanged(f.booking, before)
  })

  it('never falls back to a session for any present Authorization header', async () => {
    const f = await fixture()
    const before = await stored(f.booking)
    for (const authorization of ['', 'Basic invalid', 'Bearer invalid', 'Bearer hm_invalid'])
      for (const id of [f.booking, randomUUID()]) {
        const response = await cancel(f, { id, headers: { authorization } })
        expect(await answer(response)).toEqual({
          status: 403,
          body: { error: 'team_management_access_denied' },
        })
        expect(response.headers.has('www-authenticate')).toBe(false)
      }
    await expectUnchanged(f.booking, before)
  })

  it('requires a valid browser session for both existing and unknown targets', async () => {
    const f = await fixture()
    const before = await stored(f.booking)
    for (const cookie of [null, 'better-auth.session_token=invalid'])
      for (const id of [f.booking, randomUUID()])
        expect(await answer(await cancel(f, { cookie, id }))).toEqual({
          status: 403,
          body: { error: 'team_management_access_denied' },
        })
    await expectUnchanged(f.booking, before)
  })

  it('uniformly refuses a valid team API key with or without a session cookie', async () => {
    const f = await fixture('owner')
    const before = await stored(f.booking)
    const key = await auth.api.createApiKey({
      body: { userId: f.manager.id, metadata: { organizationId: f.team.id } },
    })
    for (const cookie of [null, f.cookie])
      for (const id of [f.booking, f.otherBooking, f.personalBooking, randomUUID()])
        await expectDenied(
          await cancel(f, { id, cookie, headers: { authorization: `Bearer ${key.key}` } }),
        )
    await expectUnchanged(f.booking, before)
  })

  async function oauthToken(f: Fixture) {
    const clientId = `https://team-cancellation.example/${randomUUID()}.json`
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: f.manager.id, organization_id: f.team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://team-cancellation.example/callback']),
      })
      .execute()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: f.manager.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const token = await signTestMcpAccessToken(auth, {
      sub: f.manager.id,
      client_id: clientId,
      scope: 'mcp:tools',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `${origin}/api/auth`,
      aud: `${origin}/mcp`,
      'https://hourmere.com/organization': f.team.id,
      'https://hourmere.com/grant': grant.id,
    })
    const result = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
      new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.principal.kind).toBe('oauth')
    return token
  }

  it('uniformly refuses a real valid MCP OAuth token as REST credentials, including with a cookie', async () => {
    const f = await fixture('owner')
    const before = await stored(f.booking)
    const token = await oauthToken(f)
    for (const cookie of [null, f.cookie])
      for (const id of [f.booking, f.otherBooking, f.personalBooking, randomUUID()])
        expect(
          await answer(
            await cancel(f, {
              id,
              cookie,
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
        ).toEqual({ status: 403, body: { error: 'team_management_access_denied' } })
    await expectUnchanged(f.booking, before)
  })

  async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
    const client = new Client({ name: 'team-cancellation-boundary', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          fetch: async (input, init) => app.request(input, init),
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      )
      return await client.callTool({ name, arguments: args })
    } finally {
      await client.close()
    }
  }

  it('does not give existing REST/MCP cancel and reschedule tools team-management authority', async () => {
    const f = await fixture('owner')
    const before = await stored(f.booking)
    const key = await auth.api.createApiKey({
      body: { userId: f.manager.id, metadata: { organizationId: f.team.id } },
    })
    for (const cookie of [f.cookie, null]) {
      const headers = {
        origin,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : { authorization: `Bearer ${key.key}` }),
      }
      for (const action of ['cancel', 'reschedule']) {
        const response = await app.request(`/api/v1/bookings/${f.booking}/${action}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(action === 'reschedule' ? { start: '2030-11-05T09:00:00Z' } : {}),
        })
        expect(await answer(response)).toMatchObject({
          status: 404,
          body: { error: 'booking_not_found' },
        })
      }
    }
    for (const token of [key.key, await oauthToken(f)])
      for (const name of ['cancel_booking', 'reschedule_booking']) {
        const result = await mcpCall(token, name, {
          bookingId: f.booking,
          ...(name === 'reschedule_booking' && { start: '2030-11-05T09:00:00Z' }),
        })
        expect(result.isError).toBe(true)
        const content = result.content as { text: string }[]
        expect(JSON.parse(content[0]?.text ?? 'null')).toMatchObject({ error: 'booking_not_found' })
      }
    await expectUnchanged(f.booking, before)
  })

  it('does not grant the conference organizer’s retry capabilities through team booking reads or cancellation', async () => {
    const f = await fixture()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: f.booking,
        booking_id: f.booking,
        organization_id: f.team.id,
        organizer_user_id: f.host.id,
        provider: 'google_meet',
        state: 'failed',
        error_code: 'conference_failed',
        external_event_id: 'synthetic-owned-conference',
        create_started: true,
      })
      .execute()
    const before = await db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', f.booking)
      .executeTakeFirstOrThrow()
    const response = await app.request('/api/v1/team/bookings', { headers: { cookie: f.cookie } })
    expect(response.status).toBe(200)
    const page = (await response.json()) as { data: Record<string, unknown>[] }
    const row = page.data.find((booking) => booking.id === f.booking)
    expect(row).toBeDefined()
    expect(Object.keys(row as object).sort()).toEqual([
      'attendees',
      'cancelledAt',
      'end',
      'eventType',
      'hosts',
      'id',
      'start',
      'status',
    ])
    for (const action of ['conference/retry', 'calendar-copy/retry']) {
      const retry = () =>
        app.request(`/api/v1/bookings/${f.booking}/${action}`, {
          method: 'POST',
          headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
          body: '{}',
        })
      const first = await retry()
      expect(first.status).toBe(404)
      expect(await first.json()).toMatchObject({
        error: action === 'conference/retry' ? 'conference_not_found' : 'calendar_copy_not_found',
      })
      expect(
        await db
          .selectFrom('booking_conferences')
          .selectAll()
          .where('root_booking_id', '=', f.booking)
          .executeTakeFirstOrThrow(),
      ).toEqual(before)
    }
    expect((await cancel(f)).status).toBe(200)
    expect(
      await db
        .selectFrom('booking_conferences')
        .selectAll()
        .where('root_booking_id', '=', f.booking)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      organizer_user_id: f.host.id,
      revision: before.revision + 1,
    })
    const retry = await app.request(`/api/v1/bookings/${f.booking}/conference/retry`, {
      method: 'POST',
      headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(retry.status).toBe(404)
  })

  async function drain(id: string) {
    const before = sent.length
    for (const row of await queued(id))
      await mail().handler(BookingNotificationPayload.parse(row.data), {
        id: row.id,
        attempt: 1,
        signal: new AbortController().signal,
      })
    return sent.slice(before)
  }

  async function expectSingleCancellation(f: Fixture) {
    expect(await stored(f.booking)).toMatchObject({
      status: 'cancelled',
      required_host_user_ids: [f.host.id],
    })
    expect(await operations(f.booking)).toHaveLength(1)
    expect(await queued(f.booking)).toHaveLength(1)
  }

  it('distinguishes a retry after a lost response and never queues or sends a second notification set', async () => {
    const f = await fixture()
    expect((await cancel(f)).status).toBe(200)
    const before = await stored(f.booking)
    const retry = await cancel(f)
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ error: 'booking_already_cancelled' })
    expect(await stored(f.booking)).toEqual(before)
    await expectSingleCancellation(f)
    expect((await drain(f.booking)).map((message) => message.to)).toEqual([
      f.host.email,
      'invitee@example.com',
      'guest@example.test',
    ])
    expect(await drain(f.booking)).toEqual([])
    // An inaccessible cancelled booking still reveals no existence or cancelled status.
    const otherSession = await session(f.manager, f.other.id)
    await expectDenied(
      await cancel(f, { cookie: otherSession.cookie, expectedOrganizationId: f.other.id }),
    )
  })

  it('serializes two tabs into one cancellation and one durable notification set', async () => {
    const f = await fixture()
    const secondTab = await session(f.manager, f.team.id)
    let reached = () => {}
    let release = () => {}
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let notifications = 0
    const guarded = application({
      notify: async (trx, event, now) => {
        notifications++
        await notify(trx, event, now)
        reached()
        await held
      },
    })
    const first = cancel(f, { app: guarded })
    await entered
    const second = cancel(f, { cookie: secondTab.cookie, app: guarded })
    try {
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query<{ waiting: boolean }>(
                `SELECT EXISTS (SELECT FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND wait_event_type='Lock' AND query LIKE $1) AS waiting`,
                ['%organization%for update%'],
              )
            ).rows[0]?.waiting,
          { timeout: 3000, interval: 10 },
        )
        .toBe(true)
    } finally {
      release()
    }
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status)).toEqual([200, 409])
    expect(await responses[1]?.json()).toMatchObject({ error: 'booking_already_cancelled' })
    expect(notifications).toBe(1)
    await expectSingleCancellation(f)
    expect((await drain(f.booking)).map((message) => message.to)).toEqual([
      f.host.email,
      'invitee@example.com',
      'guest@example.test',
    ])
    expect(await drain(f.booking)).toEqual([])
  })

  it.each([
    ['unknown field', { reason: 'Changed', organizationId: randomUUID() }, 400, 'invalid_request'],
    ['invalid reason type', { reason: 42 }, 400, 'invalid_request'],
    ['long reason', { reason: 'x'.repeat(1001) }, 400, 'invalid_request'],
    ['control character', { reason: 'bad\u0001reason' }, 400, 'invalid_reason'],
    ['oversized body', { reason: 'x'.repeat(65_536) }, 413, 'payload_too_large'],
  ] as const)('validates %s before any side effects', async (_name, body, status, error) => {
    const f = await fixture()
    const before = await stored(f.booking)
    const response = await cancel(f, { body })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error })
    await expectUnchanged(f.booking, before)
  })

  it('refuses malformed JSON before any side effects', async () => {
    const f = await fixture()
    const before = await stored(f.booking)
    const response = await cancel(f, { rawBody: '{' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    await expectUnchanged(f.booking, before)
  })

  it('fails closed when its notification dependency was not configured', async () => {
    const f = await fixture()
    const before = await stored(f.booking)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await answer(await cancel(f, { app: application({ notify: null }) }))).toEqual({
        status: 500,
        body: { error: 'internal_error' },
      })
      await expectUnchanged(f.booking, before)
    } finally {
      log.mockRestore()
    }
  })

  it('preserves the existing host and attendee cancellation paths', async () => {
    const f = await fixture()
    const hostSession = await session(f.host, f.team.id)
    const host = await app.request(`/api/v1/bookings/${f.booking}/cancel`, {
      method: 'POST',
      headers: { cookie: hostSession.cookie, origin, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(host.status).toBe(200)
    const second = await fixture()
    const token = randomBytes(32).toString('base64url')
    await db
      .updateTable('bookings')
      .set({ manage_token_hash: createHash('sha256').update(token).digest() })
      .where('id', '=', second.booking)
      .execute()
    const attendee = await app.request('/api/v1/bookings/manage/cancel', {
      method: 'POST',
      headers: { 'x-manage-token': token, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(attendee.status).toBe(200)
    for (const entry of [f, second]) {
      expect(await stored(entry.booking)).toMatchObject({ status: 'cancelled' })
      expect(await queued(entry.booking)).toHaveLength(1)
    }
  })

  async function verifyOpenResponse(factory: RouteFactory) {
    const document = await openApiDocument(application({ factory }))
    const operation = document.paths[routePath]?.post
    expect(operation?.security).toEqual([{ session: [] }])
    expect((operation as unknown as { parameters: unknown[] }).parameters).toContainEqual(
      expect.objectContaining({ name: 'x-expected-organization-id', in: 'header', required: true }),
    )
    expect(responseAndRequestStrictness(document, [routePath])).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    const schema = operation?.responses['200']?.content?.['application/json']?.schema
    expect(schema).toBeDefined()
    expect(resolve(document, schema as Record<string, unknown>).properties).toEqual({
      cancelled: { type: 'boolean' },
    })
  }

  it('registers the production route and publishes an open session-only response', async () => {
    const f = await fixture()
    expect((await cancel(f, { app: application({ production: true }) })).status).toBe(200)
    await verifyOpenResponse(teamBookingRoutes)
  })

  function routeCopy(replacement?: [string, string], accessObserved = () => {}) {
    let source = readFileSync('apps/server/src/routes/team-bookings.ts', 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation must match real source').toBe(true)
      source = source.replace(...replacement)
    }
    const script = stripTypeScriptTypes(
      source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
    ).replace(/\bexport /g, '')
    const bindings = {
      createRoute,
      z,
      ...scheduling,
      ...openapi,
      ...management,
      ...bookings,
      originUncheckedCaller: async (...[c, next]: Parameters<openapi.CallerMiddleware>) => {
        const result = await resolveCaller(c.req.raw.headers)
        if (!result.ok) return c.json({ error: 'unauthorized' }, 401)
        c.set('principal', result.principal)
        await next()
      },
      teamManagementAccess: (...args: Parameters<typeof management.teamManagementAccess>) => {
        const access = management.teamManagementAccess(...args)
        const check = access.middleware[1]
        access.middleware[1] = async (c, next) => {
          accessObserved()
          return check(c, next)
        }
        return access
      },
    }
    return new Function(...Object.keys(bindings), `${script}; return teamBookingRoutes`)(
      ...Object.values(bindings),
    ) as RouteFactory
  }

  async function verifyExpectedContext(factory: RouteFactory) {
    const f = await fixture()
    await expectContextChanged(
      await cancel(f, { expectedOrganizationId: null, app: application({ factory }) }),
    )
  }

  async function verifyNotifications(factory: RouteFactory) {
    const f = await fixture()
    expect((await cancel(f, { app: application({ factory }) })).status).toBe(200)
    await expectSingleCancellation(f)
  }

  async function verifySameOrigin(factory: RouteFactory) {
    const f = await fixture()
    const response = await cancel(f, { sources: {}, app: application({ factory }) })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'forbidden' })
  }

  async function verifyLiveSessionContext(factory: RouteFactory) {
    const f = await fixture()
    const guarded = application({
      factory,
      afterResolve: async () => {
        await db
          .updateTable('auth.session')
          .set({ activeOrganizationId: f.other.id })
          .where('id', '=', f.sessionId)
          .execute()
      },
    })
    await expectContextChanged(await cancel(f, { app: guarded }))
  }

  it('passes context, notifier and open-response assertions with an unmodified route source copy', async () => {
    const copy = routeCopy()
    await verifyExpectedContext(copy)
    await verifyLiveSessionContext(copy)
    await verifySameOrigin(copy)
    await verifyNotifications(copy)
    await verifyOpenResponse(copy)
  })

  it('detects replacing missing context with the current organization with a real assertion failure', async () => {
    const copy = routeCopy([
      "c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? ''",
      'c.var.principal.organization.id',
    ])
    await expect(verifyExpectedContext(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects dropping the live expected-organization write binding with a real assertion failure', async () => {
    const copy = routeCopy(['          { expectedOrganizationId },', '          undefined,'])
    await expect(verifyLiveSessionContext(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects bypassing the shared caller origin check with a real assertion failure', async () => {
    const copy = routeCopy([
      'const access = teamManagementAccess(deps.db, caller)',
      'const access = teamManagementAccess(deps.db, originUncheckedCaller)',
    ])
    await expect(verifySameOrigin(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects dropping notification delivery with a real assertion failure', async () => {
    const copy = routeCopy(['                notify,', '                notify: async () => {},'])
    await expect(verifyNotifications(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects closing the cancellation response schema with a real assertion failure', async () => {
    const copy = routeCopy([
      '.object({ cancelled: z.boolean() })',
      '.strictObject({ cancelled: z.boolean() })',
    ])
    await expect(verifyOpenResponse(copy)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects removing the shared access middleware with a real assertion failure', async () => {
    async function verify(factory: RouteFactory, observed: () => number) {
      const f = await fixture()
      expect((await cancel(f, { app: application({ factory }) })).status).toBe(200)
      expect(observed()).toBe(1)
    }
    let observed = 0
    await verify(
      routeCopy(undefined, () => {
        observed++
      }),
      () => observed,
    )
    observed = 0
    // Replace both declarations so the mutation cannot accidentally alter only the GET.
    const source = readFileSync('apps/server/src/routes/team-bookings.ts', 'utf8')
    const before = source.slice(source.indexOf("method: 'post'"))
    const after = before.replace('middleware: access.middleware,', 'middleware: caller,')
    const copy = routeCopy([before, after], () => {
      observed++
    })
    await expect(verify(copy, () => observed)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
