import type { OpenAPIHono } from '@hono/zod-openapi'
import { authenticateScimToken } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { Context } from 'hono'
import { clientIp } from './client-ip.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'

export interface ScimOptions {
  db: Db
  enabled: boolean
}

/** Separate protocol boundary. This foundation deliberately exposes no SCIM resources. */
export function mountScim(
  app: OpenAPIHono,
  options?: ScimOptions,
  trustedProxies: readonly string[] = [],
) {
  const limit = createRateLimiter({ limit: 120, windowSeconds: 60 })
  const respond = (c: Context, status: 401 | 404 | 429 | 500, detail: string) => {
    c.header('Content-Type', 'application/scim+json')
    return c.body(
      JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: String(status),
        detail,
      }),
      status,
    )
  }
  app.use('/scim/*', clientIp(trustedProxies))
  app.all('/scim/*', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    if (!options?.enabled) return respond(c, 404, 'SCIM provisioning is disabled.')
    const retry = limit.hit(rateLimitKey(c.var.clientIp))
    if (retry !== undefined) {
      c.header('Retry-After', String(retry))
      return respond(c, 429, 'Too many requests.')
    }
    const organizationId = /^\/scim\/v2\/([a-f0-9-]{36})(?:\/|$)/i.exec(c.req.path)?.[1]
    if (!organizationId) return respond(c, 404, 'SCIM resources are not available yet.')
    try {
      const principal = await authenticateScimToken(options.db, {
        path: c.req.path,
        organizationId,
        authorization: c.req.header('authorization') ?? null,
        enabled: options.enabled,
      })
      if (!principal) {
        c.header('WWW-Authenticate', 'Bearer')
        return respond(c, 401, 'A valid provisioning token is required.')
      }
      return respond(c, 404, 'SCIM resources are not available yet.')
    } catch {
      // Never pass credentials, paths or driver diagnostics to a logger.
      return respond(c, 500, 'SCIM request could not be processed.')
    }
  })
}
