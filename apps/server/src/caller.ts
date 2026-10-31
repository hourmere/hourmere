import type { CallerResolver, Principal } from '@hourmere/auth'
import { createMiddleware } from 'hono/factory'
import { withClientIpHeader } from './client-ip.ts'
import { requireRestApiKeyOperation } from './rest-scopes.ts'

export type CallerEnv = { Variables: { principal: Principal } }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The origin a browser reports for the request: Origin, else that of the Referer. An opaque
 * `Origin: null` (sandboxed frames, some redirects) is no origin at all, whatever the Referer
 * says.
 */
function requestOrigin(headers: Headers): string | undefined {
  const origin = headers.get('origin')
  if (origin !== null) return origin === 'null' ? undefined : origin
  const referer = headers.get('referer')
  return referer && URL.canParse(referer) ? new URL(referer).origin : undefined
}

/**
 * Requires a signed-in caller (session cookie or `Authorization: Bearer hm_…` API key) and
 * exposes it as `c.var.principal`; answers 401 `{ "error": "unauthorized" }` otherwise.
 * Every authenticated /api/v1 route (and later MCP) goes through this.
 *
 * A cookie-authenticated request that may change state must come from `allowedOrigin` (the
 * web app, PUBLIC_URL's origin, as Better Auth requires for its own endpoints): browsers
 * attach cookies to cross-site requests too. API keys are not sent by browsers on their own,
 * so bearer requests are exempt.
 */
export function requireCaller(
  resolveCaller: CallerResolver,
  { allowedOrigin }: { allowedOrigin: string },
) {
  return createMiddleware<CallerEnv>(async (c, next) => {
    const result = await resolveCaller(withClientIpHeader(c.req.raw.headers, c.var.clientIp))
    // Better Auth may extend the session (sliding expiry) or clear a dead cookie.
    for (const cookie of result.setCookie) c.header('Set-Cookie', cookie, { append: true })
    if (!result.ok) {
      if (result.error === 'rate_limited') {
        if (result.retryAfterSeconds !== null)
          c.header('Retry-After', String(result.retryAfterSeconds))
        return c.json({ error: 'rate_limited' }, 429)
      }
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (
      result.principal.kind === 'session' &&
      !SAFE_METHODS.has(c.req.method) &&
      requestOrigin(c.req.raw.headers) !== allowedOrigin
    ) {
      return c.json(
        {
          error: 'forbidden',
          message: 'Cookie-authenticated writes must come from the app itself',
        },
        403,
      )
    }
    requireRestApiKeyOperation(c, result.principal)
    c.set('principal', result.principal)
    await next()
  })
}
