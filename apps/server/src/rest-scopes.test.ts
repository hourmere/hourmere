import { randomUUID } from 'node:crypto'
import { createRoute, z } from '@hono/zod-openapi'
import {
  API_KEY_REST_OPERATIONS,
  type ApiKeyOperationClass,
  type ApiKeyScope,
  type Principal,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { authenticated, json, type RouteModule } from './openapi.ts'
import { productRoutes } from './server.ts'

const scopes = ['full', 'read', 'bookings'] as const
const principal = (scope: ApiKeyScope): Principal => ({
  kind: 'api_key',
  apiKeyScope: scope,
  apiKeyId: randomUUID(),
  user: { id: randomUUID(), name: 'Scope test', email: 'scope@example.com' },
  organization: { id: randomUUID(), name: 'Scope team', slug: 'scope-team', personal: false },
})
const denied = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
const expectedScopes: Record<ApiKeyOperationClass, readonly ApiKeyScope[]> = {
  booking_read: scopes,
  booking_write: ['full', 'bookings'],
  other_read: ['full', 'read'],
  other_write: ['full'],
  session_only: [],
  public_metadata: scopes,
}
const secret = 'synthetic-scope-test-secret-0000000000000000'

// Actual route composition, with a resource-access trap. A denied request must never
// touch storage, a provider dependency or the notification callback.
function fixture(scope: ApiKeyScope) {
  const resource = vi.fn(() => {
    throw new Error('Resource lookup reached')
  })
  const db = new Proxy({} as Db, { get: resource })
  const notify = vi.fn()
  const app = createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: true, principal: principal(scope), setCookie: [] }),
    publicUrl: 'http://localhost',
    routes: productRoutes({
      db,
      notify,
      mcpAuth: { handler: async () => new Response(null) },
      socialProviders: {},
      invitationMailLimits: { secret },
    }),
  })
  return { app, resource, notify }
}

const cases = API_KEY_REST_OPERATIONS.flatMap((operation) =>
  scopes.flatMap((scope) =>
    operation.authentication !== 'session_only' &&
    operation.authentication !== 'public_metadata' &&
    !expectedScopes[operation.operationClass].includes(scope)
      ? [{ scope, operation }]
      : [],
  ),
)

describe('REST scoped-key operation matrix', () => {
  it.each(scopes)('%s preserves the API 404 for unregistered paths and methods', async (scope) => {
    const f = fixture(scope)
    for (const [method, path] of [
      ['GET', '/api/v1/does-not-exist'],
      ['POST', '/api/v1/does-not-exist'],
      ['OPTIONS', '/api/v1/does-not-exist'],
      ['HEAD', '/api/v1/does-not-exist'],
      ['OPTIONS', '/api/v1/webhooks'],
      ['PUT', '/api/v1/webhooks'],
      ['POST', '/api/v1/me'],
      ['OPTIONS', '/api/v1/me'],
    ] as const) {
      for (const authenticated of [false, true]) {
        const response = await f.app.request(path, {
          method,
          headers: authenticated ? { authorization: 'Bearer hm_synthetic' } : {},
        })
        expect(response.status, `${method} ${path}`).toBe(404)
        expect(response.headers.get('cache-control')).toBe('no-store')
        if (method === 'HEAD') expect(await response.text()).toBe('')
        else expect(await response.json()).toEqual({ error: 'not_found' })
      }
    }
    expect(f.resource).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
  })

  it.each(cases)(
    '$scope denies $operation.id before validation and resource access',
    async ({ scope, operation }) => {
      const f = fixture(scope)
      for (const marker of [randomUUID(), randomUUID(), 'invalid-identifier']) {
        const path = operation.path.replace(/\{[^}]+\}/g, marker)
        const response = await f.app.request(path, {
          method: operation.method,
          headers: {
            authorization: 'Bearer hm_synthetic',
            'content-type': 'application/json',
            'x-manage-token': marker,
          },
          ...(operation.method === 'GET' ? {} : { body: '{}' }),
        })
        expect(response.status, operation.id).toBe(403)
        expect(await response.json()).toEqual(denied)
        expect(response.headers.get('cache-control')).toBe('no-store')
      }
      expect(f.resource).not.toHaveBeenCalled()
      expect(f.notify).not.toHaveBeenCalled()
    },
  )

  it.each(scopes)('%s preserves native session-only errors', async (scope) => {
    const f = fixture(scope)
    const response = await f.app.request('/api/v1/mcp-oauth/connections', {
      headers: { authorization: 'Bearer hm_synthetic' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'session_required' })
    expect(f.resource).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'] as const)(
    'default denies a new %s operation, including a public route carrying a key',
    async (method) => {
      for (const withCaller of [true, false]) {
        for (const scope of scopes) {
          const run = vi.fn()
          const routes: RouteModule = ({ app, caller }) => {
            app.openapi(
              createRoute({
                method: method === 'GET' ? 'get' : 'post',
                path: '/api/v1/unclassified/{id}',
                security: authenticated,
                middleware: withCaller ? caller : [],
                request: { params: z.object({ id: z.uuid() }) },
                responses: {
                  200: { description: 'Probe', content: json(z.object({ ok: z.boolean() })) },
                },
              }),
              (c) => {
                run()
                return c.json({ ok: true }, 200)
              },
            )
          }
          const app = createApp({
            checkDb: async () => {},
            authHandler: async () => new Response(null, { status: 404 }),
            resolveCaller: async () => ({ ok: true, principal: principal(scope), setCookie: [] }),
            publicUrl: 'http://localhost',
            routes: [routes],
          })
          const id = scope === 'full' ? randomUUID() : 'invalid-identifier'
          const response = await app.request(`/api/v1/unclassified/${id}`, {
            method,
            headers: { authorization: 'Bearer hm_synthetic' },
          })
          expect(response.status).toBe(scope === 'full' ? 200 : 403)
          expect(run).toHaveBeenCalledTimes(scope === 'full' ? 1 : 0)
          if (scope !== 'full') expect(await response.json()).toEqual(denied)
        }
      }
    },
  )

  it.each([
    { method: 'GET', path: '/api/v1/unclassified-bare' },
    { method: 'POST', path: '/api/v1/unclassified-bare' },
    { method: 'ALL', path: '/api/v1/unclassified-bare' },
    { method: 'ALL', path: '/api/*' },
  ])(
    'default denies an unclassified bare Hono $method $path handler at runtime',
    async ({ method, path }) => {
      for (const scope of scopes) {
        const run = vi.fn()
        const app = createApp({
          checkDb: async () => {},
          authHandler: async () => new Response(null),
          resolveCaller: async () => ({ ok: true, principal: principal(scope), setCookie: [] }),
          publicUrl: 'http://localhost',
          routes: [
            ({ app }) => {
              const handler = () => {
                run()
                return Response.json({ ok: true })
              }
              if (method === 'ALL') app.all(path, handler)
              else app.on(method, path, handler)
            },
          ],
        })
        const response = await app.request('/api/v1/unclassified-bare', {
          method: method === 'ALL' ? 'POST' : method,
          headers: { authorization: 'Bearer hm_synthetic' },
        })
        expect(response.status).toBe(scope === 'full' ? 200 : 403)
        expect(run).toHaveBeenCalledTimes(scope === 'full' ? 1 : 0)
        if (scope !== 'full') expect(await response.json()).toEqual(denied)
      }
    },
  )

  it('binds the registered template instead of trusting raw paths or request headers', async () => {
    const f = fixture('bookings')
    for (const path of ['/api/v1/schedules', '/api/v1/schedules?operationId=GET%20/api/v1/me']) {
      const response = await f.app.request(path, {
        headers: { authorization: 'Bearer hm_synthetic', 'x-operation-id': 'GET /api/v1/me' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
    }
    expect(f.resource).not.toHaveBeenCalled()
  })

  it('ignores bearer credentials only on explicit public metadata/protocol exemptions', async () => {
    const resolveCaller = vi.fn()
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null),
      resolveCaller,
      publicUrl: 'http://localhost',
      routes: productRoutes({
        db: {} as Db,
        socialProviders: {},
        invitationMailLimits: { secret },
      }),
    })
    for (const path of ['/api/health', '/api/v1/openapi.json', '/api/v1/instance']) {
      const response = await app.request(path, { headers: { authorization: 'Bearer hm_invalid' } })
      expect(response.status).toBe(200)
    }
    expect(resolveCaller).not.toHaveBeenCalled()
  })

  it('removes cookies before optional bearer resolution and preserves credential/rate errors', async () => {
    for (const limited of [false, true]) {
      const resolveCaller = vi.fn(async (headers: Headers) => {
        expect(headers.has('cookie')).toBe(false)
        return limited
          ? {
              ok: false as const,
              error: 'rate_limited' as const,
              retryAfterSeconds: 17,
              setCookie: [],
            }
          : { ok: false as const, error: 'unauthorized' as const, setCookie: [] }
      })
      const resource = vi.fn(() => {
        throw new Error('Resource lookup reached')
      })
      const app = createApp({
        checkDb: async () => {},
        authHandler: async () => new Response(null),
        resolveCaller,
        publicUrl: 'http://localhost',
        routes: productRoutes({
          db: new Proxy({} as Db, { get: resource }),
          socialProviders: {},
          invitationMailLimits: { secret },
        }),
      })
      for (const path of [
        '/api/v1/public/ada/intro',
        '/api/v1/public/teams/team/intro/bookings',
        '/api/v1/bookings/manage/cancel',
      ]) {
        const response = await app.request(path, {
          method: path.endsWith('intro') ? 'GET' : 'POST',
          headers: {
            authorization: 'Bearer hm_invalid',
            cookie: 'synthetic-session',
            'content-type': 'application/json',
          },
          ...(path.endsWith('intro') ? {} : { body: '{}' }),
        })
        expect(response.status).toBe(limited ? 429 : 401)
        expect(await response.json()).toEqual({ error: limited ? 'rate_limited' : 'unauthorized' })
        if (limited) expect(response.headers.get('retry-after')).toBe('17')
      }
      expect(resource).not.toHaveBeenCalled()
    }
  })
})
