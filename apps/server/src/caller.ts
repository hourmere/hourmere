import type { CallerResolver, Principal } from '@hourmere/auth'
import { createMiddleware } from 'hono/factory'
import { withClientIpHeader } from './client-ip.ts'

export type CallerEnv = { Variables: { principal: Principal } }

/**
 * Requires a signed-in caller (session cookie or `Authorization: Bearer hm_…` API key) and
 * exposes it as `c.var.principal`; answers 401 `{ "error": "unauthorized" }` otherwise.
 * Every authenticated /api/v1 route (and later MCP) goes through this.
 */
export function requireCaller(resolveCaller: CallerResolver) {
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
    c.set('principal', result.principal)
    await next()
  })
}
