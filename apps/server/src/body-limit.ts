import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import type { MiddlewareHandler } from 'hono/types'

/** Body limit for /api requests whose route declares none. Sign-in requests are a few KB. */
export const DEFAULT_BODY_LIMIT = 64 * 1024

const DECLARED = Symbol('body limit')

/**
 * Declares a route's body limit, for a route whose largest legal request exceeds the
 * default; list it in the route's `middleware`. The limit must be at least that request with
 * every string at its maximum length and every character escaped as \uXXXX (6 bytes, what
 * e.g. Python's json.dumps sends by default). The middleware itself does nothing: the
 * app-wide limit enforces the figure, because it runs before anything reads the body.
 */
export function routeBodyLimit(maxBytes: number): MiddlewareHandler {
  const declaration: MiddlewareHandler = async (_c, next) => {
    await next()
  }
  return Object.assign(declaration, { [DECLARED]: maxBytes })
}

/**
 * The /api body limit: the matched route's declared limit (routeBodyLimit), else
 * DEFAULT_BODY_LIMIT. Larger bodies get 413 `payload_too_large`, judged by Content-Length or
 * counted while streaming.
 */
export function apiBodyLimit(): MiddlewareHandler {
  const limiters = new Map<number, MiddlewareHandler>()
  const limiter = (maxSize: number) => {
    let found = limiters.get(maxSize)
    if (!found) {
      found = bodyLimit({ maxSize, onError: (c) => c.json({ error: 'payload_too_large' }, 413) })
      limiters.set(maxSize, found)
    }
    return found
  }
  return createMiddleware(async (c, next) => {
    let maxSize = DEFAULT_BODY_LIMIT
    for (const { handler } of matchedRoutes(c)) {
      const declared = (handler as { [DECLARED]?: number })[DECLARED]
      if (declared !== undefined) maxSize = declared
    }
    return limiter(maxSize)(c, next)
  })
}
