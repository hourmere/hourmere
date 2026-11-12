import { randomUUID } from 'node:crypto'
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi'
import type { CallerResolver, Principal } from '@hourmere/auth'
import { DomainError } from '@hourmere/scheduling'
import { Context, type MiddlewareHandler } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { featureGate, installRestApiKeyScopes, publicBookingAuditOrigin } from './rest-scopes.ts'

/**
 * The scope binding attributes a public request to its API key only after the key passed
 * every check: a refused bearer, a switched-off feature (404) or a refused scope (403) must
 * leave no actor behind. Drives the registered binding directly with a real Hono Context and
 * reads the attribution through publicBookingAuditOrigin.
 */
const user = { id: randomUUID(), name: 'Order', email: 'order@example.test' }
const organization = { id: randomUUID(), name: 'Order', slug: 'order', personal: true }
const fullKey: Principal = {
  kind: 'api_key',
  apiKeyId: randomUUID(),
  apiKeyScope: 'full',
  user,
  organization,
}
const readKey: Principal = { ...fullKey, apiKeyId: randomUUID(), apiKeyScope: 'read' }
const oauth: Principal = {
  kind: 'oauth',
  oauthConsentId: randomUUID(),
  clientId: 'https://client.example/metadata.json',
  scopes: ['mcp:tools'],
  user,
  organization,
}
const bearers: Record<string, Principal> = { full: fullKey, read: readKey, oauth }
const resolveCaller: CallerResolver = async (headers) => {
  const principal = bearers[headers.get('authorization')?.replace('Bearer ', '') ?? '']
  return principal
    ? { ok: true, principal, setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }
}

const enabled = { on: true }
const gateChecked = vi.fn()
/** The binding that installRestApiKeyScopes puts first on a gated public route. */
function binding(): MiddlewareHandler {
  let registered: RouteConfig | undefined
  const app = {
    openapi: (route: RouteConfig) => {
      registered = route
    },
  } as unknown as OpenAPIHono
  installRestApiKeyScopes(app, resolveCaller, () => new Response(null, { status: 404 }))
  app.openapi(
    {
      method: 'post',
      path: '/api/v1/public/-/audit-order/{slug}',
      middleware: [
        featureGate(() => {
          gateChecked()
          if (!enabled.on) throw new DomainError('not_found', 'order_probe_disabled')
        }),
      ],
      responses: { 200: { description: 'Reached' } },
    },
    () => new Response(null),
  )
  const middleware = registered?.middleware
  if (!Array.isArray(middleware) || typeof middleware[0] !== 'function')
    throw new Error('the scope binding was not registered')
  return middleware[0] as MiddlewareHandler
}

async function attempt(authorization: string | undefined, gate = true) {
  enabled.on = gate
  gateChecked.mockClear()
  const headers = authorization ? { authorization } : undefined
  const c = new Context(
    new Request('https://order.example/api/v1/public/-/audit-order/a', {
      method: 'POST',
      ...(headers && { headers }),
    }),
  )
  const next = vi.fn(async () => {})
  const outcome = await Promise.resolve(binding()(c, next)).then(
    (response) => (response instanceof Response ? response.status : 'next'),
    (error: unknown) => error,
  )
  return {
    outcome,
    reached: next.mock.calls.length,
    gateChecked: gateChecked.mock.calls.length,
    audit: publicBookingAuditOrigin(c).audit,
  }
}

describe('public API-key attribution order in the scope binding', () => {
  it('attributes an accepted key on an open route', async () => {
    expect(await attempt('Bearer full')).toEqual({
      outcome: 'next',
      reached: 1,
      gateChecked: 1,
      audit: {
        actor: { type: 'api_key', id: fullKey.kind === 'api_key' ? fullKey.apiKeyId : '' },
        credential: {
          type: 'api_key',
          id: fullKey.kind === 'api_key' ? fullKey.apiKeyId : '',
          scope: 'full',
        },
      },
    })
  })

  it('attributes nothing when the feature gate refuses an otherwise accepted key', async () => {
    const refused = await attempt('Bearer full', false)
    expect(refused.outcome).toMatchObject({ code: 'order_probe_disabled' })
    expect(refused).toMatchObject({ reached: 0, gateChecked: 1, audit: undefined })
  })

  it('attributes nothing when the key scope is refused after the gate passed', async () => {
    const refused = await attempt('Bearer read')
    expect(refused.outcome).toMatchObject({ error: 'insufficient_scope' })
    expect(refused).toMatchObject({ reached: 0, gateChecked: 1, audit: undefined })
  })

  it('attributes nothing to a refused bearer, with the gate on or off', async () => {
    for (const gate of [true, false])
      for (const authorization of ['Bearer oauth', 'Bearer unknown'])
        expect(await attempt(authorization, gate), `${authorization} gate=${gate}`).toEqual({
          outcome: 401,
          reached: 0,
          gateChecked: 0,
          audit: undefined,
        })
  })

  it('attributes nothing to an anonymous request', async () => {
    expect(await attempt(undefined)).toEqual({
      outcome: 'next',
      reached: 1,
      gateChecked: 0,
      audit: undefined,
    })
  })
})
