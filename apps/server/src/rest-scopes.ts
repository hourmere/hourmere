import type { OpenAPIHono } from '@hono/zod-openapi'
import {
  API_KEY_NATIVE_REST_BOUNDARIES,
  API_KEY_REST_OPERATIONS,
  type CallerResolver,
  type Principal,
  requireApiKeyOperation,
} from '@hourmere/auth'
import type { Context, Handler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import { withClientIpHeader } from './client-ip.ts'
import { ErrorBody, json } from './openapi.ts'

// Bound from the declared route at registration, never from a caller-controlled URL.
const operations = new WeakMap<Context, string>()

// These native protocols authenticate through their own state/signature, or are public
// operational metadata. A new unclassified product route never inherits an exemption.
const nativeProtocols = new Set(API_KEY_NATIVE_REST_BOUNDARIES)
const restPolicies = new Map(API_KEY_REST_OPERATIONS.map((operation) => [operation.id, operation]))

async function checkBearer(c: Context, resolveCaller: CallerResolver, operationId: string) {
  const headers = withClientIpHeader(c.req.raw.headers, c.var.clientIp)
  headers.delete('cookie')
  const result = await resolveCaller(headers)
  if (!result.ok) {
    if (result.error === 'rate_limited') {
      if (result.retryAfterSeconds !== null)
        c.header('Retry-After', String(result.retryAfterSeconds))
      return c.json({ error: 'rate_limited' }, 429)
    }
    c.header('WWW-Authenticate', 'Bearer')
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (result.principal.kind !== 'api_key') {
    c.header('WWW-Authenticate', 'Bearer')
    return c.json({ error: 'unauthorized' }, 401)
  }
  requireApiKeyOperation(result.principal, operationId)
}

/** Called after authentication, before validation or any resource lookup. */
export function requireRestApiKeyOperation(c: Context, principal: Principal) {
  const operationId = operations.get(c) ?? ''
  // Native session-only services retain their existing credential-boundary errors.
  if (restPolicies.get(operationId)?.authentication === 'session_only') return
  requireApiKeyOperation(principal, operationId)
}

/**
 * Bind every OpenAPI registration to its stable method/template ID. Public booking and
 * manage-link operations additionally validate a supplied bearer before their validators.
 * Anonymous calls keep their original capability, source and idempotency semantics.
 */
export function installRestApiKeyScopes(
  app: OpenAPIHono,
  resolveCaller: CallerResolver,
  notFoundHandler: Handler,
) {
  const boundHandlers = new WeakSet()
  const register = app.openapi
  app.openapi = (route, handler, hook) => {
    const operationId = `${route.method.toUpperCase()} ${route.path}`
    const policy = restPolicies.get(operationId)
    const scope = createMiddleware(async (c, next) => {
      operations.set(c, operationId)
      if (
        (policy?.authentication === 'optional_key' ||
          (!policy && !nativeProtocols.has(operationId))) &&
        c.req.raw.headers.has('authorization')
      ) {
        const refused = await checkBearer(c, resolveCaller, operationId)
        if (refused) return refused
      }
      await next()
    })
    boundHandlers.add(scope)
    const middleware = route.middleware
    const forbiddenResponse = route.responses[403]
    const forbiddenDescription =
      forbiddenResponse && 'description' in forbiddenResponse
        ? forbiddenResponse.description
        : 'Forbidden'
    const protectedByScope =
      policy?.authentication === 'key' || policy?.authentication === 'optional_key'
    return register(
      {
        ...route,
        middleware: [
          scope,
          ...(Array.isArray(middleware) ? middleware : middleware ? [middleware] : []),
        ],
        responses: {
          ...route.responses,
          ...(protectedByScope && {
            403: {
              description: `${forbiddenDescription}. insufficient_scope: This API key does not allow this operation.`,
              content: json(ErrorBody),
            },
          }),
          ...(policy?.authentication === 'optional_key' && {
            401: { description: 'The supplied API key is invalid', content: json(ErrorBody) },
          }),
        },
      },
      handler,
      hook,
    )
  }

  // CI requires OpenAPI registration, but a forgotten bare Hono handler must also fail
  // closed at runtime. Inspect registered handlers, never infer permission from a URL.
  // Mount this after transport/rate guards and before product handlers in createApp.
  return createMiddleware(async (c, next) => {
    // Earlier matches are transport middleware. The next registered handler is either
    // a real operation (including bare ALL handlers) or the explicit API 404 fallback.
    const first = matchedRoutes(c)[c.req.routeIndex + 1]
    if (first?.handler === notFoundHandler) return next()
    if (first && boundHandlers.has(first.handler)) return next()
    const id = first ? `${first.method} ${first.path}` : ''
    if (restPolicies.get(id)?.authentication === 'public_metadata') return next()
    if (c.req.raw.headers.has('authorization')) {
      const refused = await checkBearer(c, resolveCaller, '')
      if (refused) return refused
    }
    await next()
  })
}
