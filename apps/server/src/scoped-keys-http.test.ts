import { randomUUID } from 'node:crypto'
import {
  type ApiKeyScope,
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { profileRoutes } from './routes/profile.ts'
import { publicRoutes } from './routes/public.ts'
import { scheduleRoutes } from './routes/schedules.ts'

const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const scopes = ['full', 'read', 'bookings'] as const
const denied = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
const plentiful = { limit: 100_000, windowSeconds: 60 }
const secret = 'synthetic-scoped-http-secret-000000000000000000'

describe.skipIf(!process.env.DATABASE_URL)(
  'scoped keys through real REST authentication and booking services',
  () => {
    let owned: TestDatabase, db: Db, authPool: ReturnType<typeof createAuthPool>, auth: Auth
    let app: ReturnType<typeof createApp>, f: Fixtures
    let host: Awaited<ReturnType<Fixtures['host']>>, outsider: Awaited<ReturnType<Fixtures['host']>>
    let eventId: string, foreignEventId: string, teamId: string
    const keys: Record<string, { id: string; key: string }> = {}
    const body = (start: string) => ({
      start,
      invitee: { name: 'Scope invitee', email: 'scope-invitee@example.com', timeZone: 'UTC' },
    })
    function keyFor(space: string, scope: ApiKeyScope) {
      const key = keys[`${space}:${scope}`]
      if (!key) throw new Error('Scope fixture not initialized')
      return key
    }
    const headers = (space: string, scope: ApiKeyScope) => ({
      authorization: `Bearer ${keyFor(space, scope).key}`,
    })
    const request = (
      path: string,
      method = 'GET',
      value?: unknown,
      extra: Record<string, string> = {},
    ) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', ...extra },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      })
    async function counts() {
      return Promise.all(
        ['bookings', 'organization_operations', 'event_types', 'schedules'].map((table) =>
          db
            .selectFrom(table as 'bookings')
            .select((eb) => eb.fn.countAll().as('count'))
            .executeTakeFirstOrThrow(),
        ),
      )
    }

    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'scope_http',
      })
      db = createDb(owned.pool)
      f = createFixtures(db)
      host = await f.host({ handle: 'scope-host', timeZone: 'UTC' })
      outsider = await f.host({ handle: 'scope-other', timeZone: 'UTC' })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      await f.schedule(outsider.userId, { timeZone: 'UTC' })
      teamId = await f.organization('scope-team')
      await f.member(host.userId, teamId, 'owner')
      eventId = await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
      await f.eventType(teamId, null, { slug: 'intro', hosts: [{ userId: host.userId }] })
      foreignEventId = await f.eventType(outsider.organizationId, outsider.userId, {
        slug: 'intro',
      })
      const signup = { mode: 'open', allowedDomains: [] } as const
      authPool = createAuthPool(owned.url, signup)
      auth = createAuth({
        pool: authPool,
        db,
        baseURL: 'http://localhost',
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      for (const [space, organizationId] of [
        ['personal', host.organizationId],
        ['team', teamId],
      ]) {
        for (const scope of scopes)
          keys[`${space}:${scope}`] = await auth.api.createApiKey({
            body: { userId: host.userId, metadata: { organizationId, scope } },
          })
      }
      app = createApp({
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        publicUrl: 'http://localhost',
        routes: [
          profileRoutes({ db }),
          scheduleRoutes({ db }),
          eventTypeRoutes({ db }),
          publicRoutes({
            db,
            now: () => NOW,
            rateLimits: { page: plentiful, slots: plentiful, book: plentiful },
          }),
          bookingRoutes({
            db,
            now: () => NOW,
            rateLimits: { manage: plentiful, slots: plentiful },
          }),
        ],
      })
    })
    afterAll(async () => {
      await authPool?.end()
      await owned?.drop()
    })

    it.each(scopes)('%s preserves 404 for unknown routes and methods', async (scope) => {
      for (const space of ['personal', 'team']) {
        for (const [method, path] of [
          ['GET', '/api/v1/does-not-exist'],
          ['POST', '/api/v1/does-not-exist'],
          ['OPTIONS', '/api/v1/does-not-exist'],
          ['OPTIONS', '/api/v1/schedules'],
          ['PUT', '/api/v1/bookings'],
        ] as const) {
          const response = await request(path, method, undefined, headers(space, scope))
          expect(response.status, `${method} ${path}`).toBe(404)
          expect(await response.json()).toEqual({ error: 'not_found' })
          expect(response.headers.get('cache-control')).toBe('no-store')
        }
      }
    })

    it.each(scopes)(
      '%s retains identity, event and booking reads in both spaces and private organization pinning',
      async (scope) => {
        for (const space of ['personal', 'team']) {
          const authHeaders = {
            ...headers(space, scope),
            'x-expected-organization-id': outsider.organizationId,
          }
          const me = await request('/api/v1/me', 'GET', undefined, authHeaders)
          expect(me.status).toBe(200)
          expect(await me.json()).toMatchObject({
            organization: { id: space === 'team' ? teamId : host.organizationId },
            principal: { apiKeyScope: scope },
          })
          for (const path of ['/api/v1/profile', '/api/v1/event-types', '/api/v1/bookings']) {
            const response = await request(path, 'GET', undefined, authHeaders)
            expect(response.status).toBe(200)
          }
          for (const id of [foreignEventId, randomUUID(), ...(space === 'team' ? [eventId] : [])]) {
            const response = await request(
              `/api/v1/event-types/${id}`,
              'GET',
              undefined,
              authHeaders,
            )
            expect(response.status).toBe(404)
          }
          const schedules = await request('/api/v1/schedules', 'GET', undefined, authHeaders)
          expect(schedules.status).toBe(scope === 'bookings' ? 403 : 200)
          if (scope === 'bookings') expect(await schedules.json()).toEqual(denied)
        }
      },
    )

    it.each(scopes)('%s allows only the contracted settings writes', async (scope) => {
      const before = await counts()
      const response = await request(
        '/api/v1/profile/name',
        'PATCH',
        { name: 'Scoped host' },
        headers('personal', scope),
      )
      expect(response.status).toBe(scope === 'full' ? 200 : 403)
      if (scope !== 'full') {
        expect(await response.json()).toEqual(denied)
        expect(await counts()).toEqual(before)
      }
    })

    it.each(['personal', 'team'])(
      'valid read keys cannot create on %s pages or mutate a valid manage capability',
      async (target) => {
        const path =
          target === 'team'
            ? '/api/v1/public/teams/scope-team/intro/bookings'
            : '/api/v1/public/scope-host/intro/bookings'
        const start = target === 'team' ? '2026-11-02T10:00:00Z' : '2026-11-02T09:00:00Z'
        const before = await counts()
        const forbidden = await request(path, 'POST', body(start), headers('personal', 'read'))
        expect(forbidden.status).toBe(403)
        expect(await forbidden.json()).toEqual(denied)
        expect(await counts()).toEqual(before)
        // No Authorization preserves the real public booking capability.
        const anonymous = await request(path, 'POST', body(start))
        expect(anonymous.status).toBe(201)
        const created = (await anonymous.json()) as { booking: { id: string }; manageToken: string }
        expect(typeof created.manageToken === 'string').toBe(true)
        for (const suffix of ['cancel', 'reschedule', 'conference/retry', 'calendar-copy/retry']) {
          for (const id of [created.booking.id, randomUUID()]) {
            const response = await request(
              `/api/v1/bookings/${id}/${suffix}`,
              'POST',
              { start: '2026-11-03T09:00:00Z' },
              headers('personal', 'read'),
            )
            expect(response.status).toBe(403)
            expect(await response.json()).toEqual(denied)
          }
        }
        const managedHeaders = {
          ...headers('personal', 'read'),
          'x-manage-token': created.manageToken,
        }
        const saved = await counts()
        for (const operation of ['cancel', 'reschedule']) {
          const deniedResponse = await request(
            `/api/v1/bookings/manage/${operation}`,
            'POST',
            { start: '2026-11-03T09:00:00Z' },
            managedHeaders,
          )
          expect(deniedResponse.status).toBe(403)
          expect(await deniedResponse.json()).toEqual(denied)
        }
        expect(await counts()).toEqual(saved)
        const allowedRead = await request(
          '/api/v1/bookings/manage',
          'GET',
          undefined,
          managedHeaders,
        )
        expect(allowedRead.status).toBe(200)
        const invalid = await request(
          '/api/v1/bookings/manage/cancel',
          'POST',
          {},
          { ...managedHeaders, authorization: 'Bearer hm_invalid', cookie: 'synthetic-cookie' },
        )
        expect(invalid.status).toBe(401)
        const cancelled = await request(
          '/api/v1/bookings/manage/cancel',
          'POST',
          {},
          { 'x-manage-token': created.manageToken },
        )
        expect(cancelled.status).toBe(200)
      },
    )

    it.each(['full', 'bookings'] as const)(
      '%s optional-bearer booking works across organizations and preserves web/embed attribution and idempotency',
      async (scope) => {
        const start = scope === 'full' ? '2026-11-04T09:00:00Z' : '2026-11-04T10:00:00Z'
        const idempotencyKey = randomUUID()
        const path = '/api/v1/public/scope-other/intro/bookings'
        const value = { ...body(start), source: 'embed' }
        const created = await request(path, 'POST', value, {
          ...headers('team', scope),
          'idempotency-key': idempotencyKey,
        })
        expect(created.status).toBe(201)
        const result = (await created.json()) as { booking: { id: string }; manageToken: string }
        const stored = await db
          .selectFrom('bookings')
          .select(['source', 'api_key_id', 'organization_id'])
          .where('id', '=', result.booking.id)
          .executeTakeFirstOrThrow()
        expect(stored).toEqual({
          source: 'embed',
          api_key_id: null,
          organization_id: outsider.organizationId,
        })
        const replay = await request(path, 'POST', value, { 'idempotency-key': idempotencyKey })
        expect(replay.status).toBe(200)
        expect(((await replay.json()) as { booking: { id: string } }).booking.id).toBe(
          result.booking.id,
        )
        // A team-pinned key can use an independently held link for another organization.
        const moved = await request(
          '/api/v1/bookings/manage/reschedule',
          'POST',
          { start: scope === 'full' ? '2026-11-05T09:00:00Z' : '2026-11-05T10:00:00Z' },
          { ...headers('team', scope), 'x-manage-token': result.manageToken },
        )
        expect(moved.status).toBe(200)
        const next = (await moved.json()) as { manageToken: string }
        const cancelled = await request(
          '/api/v1/bookings/manage/cancel',
          'POST',
          {},
          { ...headers('team', scope), 'x-manage-token': next.manageToken },
        )
        expect(cancelled.status).toBe(200)
      },
    )

    it.each(scopes)(
      '%s rejects disabled, expired and deleted keys on public reads/writes before target lookup',
      async (scope) => {
        for (const lifecycle of ['disabled', 'expired', 'deleted']) {
          const key = await auth.api.createApiKey({
            body: { userId: host.userId, metadata: { scope } },
          })
          if (lifecycle === 'deleted')
            await db.deleteFrom('auth.apikey').where('id', '=', key.id).execute()
          else
            await db
              .updateTable('auth.apikey')
              .set(lifecycle === 'disabled' ? { enabled: false } : { expiresAt: new Date(0) })
              .where('id', '=', key.id)
              .execute()
          for (const [path, method] of [
            ['/api/v1/public/scope-host/intro', 'GET'],
            ['/api/v1/public/scope-host/intro/bookings', 'POST'],
            ['/api/v1/bookings/manage', 'GET'],
            ['/api/v1/bookings/manage/cancel', 'POST'],
          ] as const) {
            const response = await request(path, method, method === 'POST' ? {} : undefined, {
              authorization: `Bearer ${key.key}`,
              cookie: 'synthetic-cookie',
            })
            expect(response.status).toBe(401)
            expect(await response.json()).toEqual({ error: 'unauthorized' })
          }
        }
      },
    )
  },
)
