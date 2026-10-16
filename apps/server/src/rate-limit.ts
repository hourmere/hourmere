import { isIP } from 'node:net'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import type { MiddlewareHandler } from 'hono/types'

/** At most `limit` requests per client IP in each `windowSeconds`. */
export interface RateLimit {
  limit: number
  windowSeconds: number
}

/** Limits for the unauthenticated /api/v1 endpoints (public pages and invitee links). */
export const PUBLIC_RATE_LIMITS = {
  /** Public event page. */
  page: { limit: 120, windowSeconds: 60 },
  /** Available slots. */
  slots: { limit: 120, windowSeconds: 60 },
  /** Creating a booking. */
  book: { limit: 10, windowSeconds: 60 },
  /** Invitee manage links: show, cancel, reschedule. */
  manage: { limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimit>

export interface RateLimiter {
  /** Counts a request from `key`. Returns the seconds to wait when it is over the limit. */
  hit(key: string): number | undefined
}

/**
 * A fixed-window counter per key, kept in this process's memory. Each server instance
 * counts on its own, so with several instances a client gets the limit once per instance;
 * a shared store (e.g. Postgres or Redis) comes with multi-instance deployments.
 */
export function createRateLimiter(
  { limit, windowSeconds }: RateLimit,
  {
    now = Date.now,
    maxKeys = 100_000,
  }: {
    /** The clock in milliseconds, injectable for tests. */
    now?: () => number
    /**
     * Bounds memory when many addresses show up within one window: the oldest entries are
     * then dropped (down to 90%, so this is rare) and those clients start a new window.
     */
    maxKeys?: number
  } = {},
): RateLimiter {
  const windowMs = windowSeconds * 1000
  const keysAfterEviction = Math.floor(maxKeys * 0.9)
  const windows = new Map<string, { count: number; resetAt: number }>()
  let nextSweep = now() + windowMs

  function sweep(t: number) {
    for (const [key, w] of windows) if (w.resetAt <= t) windows.delete(key)
    if (windows.size < maxKeys) return
    for (const key of windows.keys()) {
      if (windows.size <= keysAfterEviction) break
      windows.delete(key)
    }
  }

  return {
    hit(key) {
      const t = now()
      if (t >= nextSweep || windows.size >= maxKeys) {
        sweep(t)
        nextSweep = t + windowMs
      }
      let w = windows.get(key)
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowMs }
        // Re-inserted, so the map stays ordered by window start for eviction.
        windows.delete(key)
        windows.set(key, w)
      }
      w.count++
      return w.count > limit ? Math.max(1, Math.ceil((w.resetAt - t) / 1000)) : undefined
    },
  }
}

/**
 * The key a client is counted under: its IPv4 address, or the /64 network of its IPv6
 * address. One subscriber usually gets a whole /64 (or more), so counting single IPv6
 * addresses would let a client rotate through billions of them.
 */
export function rateLimitKey(ip: string | undefined): string {
  if (ip === undefined || isIP(ip) !== 6) return ip ?? 'unknown'
  const [address = ''] = ip.split('%') // zone index, e.g. fe80::1%eth0
  const [head = '', tail] = address.split('::')
  const groups = (part: string) =>
    // An embedded IPv4 address (::ffff:1.2.3.4) takes the last two groups.
    part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []
  const left = groups(head)
  const right = tail === undefined ? [] : groups(tail)
  const full = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return `${full
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

const LIMITER = Symbol('rate limiter')
/** The limiters routeRateLimits already counted each request against. */
const counted = new WeakMap<Context, Set<RateLimiter>>()

/** Counts the request against `limiter`; a 429 response when the client is over it. */
function check(c: Context, limiter: RateLimiter): Response | undefined {
  const retryAfter = limiter.hit(rateLimitKey(c.var.clientIp))
  if (retryAfter === undefined) return undefined
  c.header('Retry-After', String(retryAfter))
  return c.json({ error: 'rate_limited' }, 429)
}

/**
 * Answers 429 `rate_limited` with Retry-After once the client (c.var.clientIp, which honors
 * TRUSTED_PROXIES; IPv6 by /64, see rateLimitKey) is over the limiter's limit. For routes'
 * `middleware`. createApp counts it earlier, in routeRateLimits, before the body is read;
 * the route middleware then lets the request through, and counts it itself whenever
 * routeRateLimits did not (no routeRateLimits in the app, or it could not see this limiter).
 */
export function rateLimit(limiter: RateLimiter): MiddlewareHandler {
  const middleware = createMiddleware(async (c, next) => {
    if (!counted.get(c)?.has(limiter)) {
      const refused = check(c, limiter)
      if (refused) return refused
    }
    await next()
  })
  return Object.assign(middleware, { [LIMITER]: limiter })
}

/**
 * Applies the rate limits of the matched route (its rateLimit middleware) up front, before
 * any app-wide middleware reads, parses or checks the body.
 */
export function routeRateLimits(): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const limiters = new Set<RateLimiter>()
    for (const { handler } of matchedRoutes(c)) {
      const limiter = (handler as { [LIMITER]?: RateLimiter })[LIMITER]
      if (limiter) limiters.add(limiter)
    }
    for (const limiter of limiters) {
      const refused = check(c, limiter)
      if (refused) return refused
    }
    counted.set(c, limiters)
    await next()
  })
}
