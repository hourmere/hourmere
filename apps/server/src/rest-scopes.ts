import type { OpenAPIHono } from '@hono/zod-openapi'
import {
  API_KEY_NATIVE_REST_BOUNDARIES,
  API_KEY_REST_OPERATIONS,
  type CallerResolver,
  type Principal,
  requireApiKeyOperation,
} from '@hourmere/auth'
import type { Context, Handler, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import { withClientIpHeader } from './client-ip.ts'
import { ErrorBody, json } from './openapi.ts'

// Bound from the declared route at registration, never from a caller-controlled URL.
const operations = new WeakMap<Context, string>()
// The check of each featureGate middleware, and the gate of the route a request matched.
const gateChecks = new WeakMap<object, () => void>()
const routeGates = new WeakMap<Context, () => void>()

/**
 * Route middleware for an operation of a feature that can be switched off: `check` throws
 * the feature's error (a DomainError) while it is off. List it last in the route's
 * `middleware`; registration refuses any other position. The route's scope binding then
 * also runs `check` right after credential validation and before the API-key scope check:
 * in requireCaller, and where the binding validates a supplied bearer itself (public and
 * unclassified operations). The middleware runs it where it is listed, which is what meets
 * an anonymous request. So the transport checks createApp runs first (body limit, rate
 * limits) and credential validation are unchanged, and every caller with valid credentials,
 * or none, gets the same refusal before any scope or role check, lookup, body read or input
 * validation. OpenAPI routes only (`app.openapi`).
 */
export function featureGate(check: () => void): MiddlewareHandler {
  const gate = createMiddleware(async (_c, next) => {
    check()
    await next()
  })
  gateChecks.set(gate, check)
  return gate
}

// These native protocols authenticate through their own state/signature, or are public
// operational metadata. A new unclassified product route never inherits an exemption.
const nativeProtocols = new Set(API_KEY_NATIVE_REST_BOUNDARIES)
const restPolicies = new Map(API_KEY_REST_OPERATIONS.map((operation) => [operation.id, operation]))

async function checkBearer(
  c: Context,
  resolveCaller: CallerResolver,
  operationId: string,
  gate?: () => void,
) {
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
  gate?.()
  requireApiKeyOperation(result.principal, operationId)
}

/** Called after authentication, before validation or any resource lookup. */
export function requireRestApiKeyOperation(c: Context, principal: Principal) {
  // A switched-off feature answers before the scope decision (see featureGate).
  routeGates.get(c)?.()
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
    const middleware = route.middleware
    const routeMiddleware = Array.isArray(middleware) ? middleware : middleware ? [middleware] : []
    const firstGate = routeMiddleware.findIndex((entry) => gateChecks.has(entry))
    if (firstGate !== -1 && !routeMiddleware.slice(firstGate).every((e) => gateChecks.has(e)))
      throw new Error(`${operationId}: featureGate must be the last route middleware`)
    const checks = routeMiddleware.flatMap((entry) => gateChecks.get(entry) ?? [])
    const gate = checks.length
      ? () => {
          for (const check of checks) check()
        }
      : undefined
    const scope = createMiddleware(async (c, next) => {
      operations.set(c, operationId)
      if (gate) routeGates.set(c, gate)
      if (
        (policy?.authentication === 'optional_key' ||
          (!policy && !nativeProtocols.has(operationId))) &&
        c.req.raw.headers.has('authorization')
      ) {
        const refused = await checkBearer(c, resolveCaller, operationId, gate)
        if (refused) return refused
      }
      await next()
    })
    boundHandlers.add(scope)
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
        middleware: [scope, ...routeMiddleware],
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
