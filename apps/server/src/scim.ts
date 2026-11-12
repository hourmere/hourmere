import type { OpenAPIHono } from '@hono/zod-openapi'
import { authenticateScimToken } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { Context } from 'hono'
import { clientIp } from './client-ip.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'

export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

/** A SCIM Error message (RFC 7644 section 3.12): the status is a string. */
export function scimError(status: number, detail: string) {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail }
}

/** One request a provisioning token authenticated, below its organization base URL. */
export interface ScimResourceRequest {
  method: string
  /**
   * The path below the organization base, such as `/Schemas/{id}`. Reserved characters
   * such as `:` can still be percent-encoded.
   */
  path: string
  query: URLSearchParams
  /** The token and the organization it belongs to, as stored. */
  principal: { tokenId: string; organizationId: string }
  /** `<PUBLIC_URL>/scim/v2/{organizationId}` for the token's organization. */
  base: string
}

export interface ScimReply {
  status: 200 | 403 | 404 | 501
  body: unknown
}

/**
 * Resource handlers answer authenticated requests; undefined leaves the request to the
 * unavailable answer. This is the resource test flag in docs/scim.md: only test harnesses
 * pass handlers, in code. productionAppOptions never does, and no environment or operator
 * setting, request parameter or build option reaches it.
 */
export type ScimResources = (request: ScimResourceRequest) => ScimReply | undefined

export interface ScimOptions {
  db: Db
  enabled: boolean
  resources?: ScimResources | undefined
}

/** Separate protocol boundary. Production registers no SCIM resource handlers yet. */
export function mountScim(
  app: OpenAPIHono,
  options?: ScimOptions,
  trustedProxies: readonly string[] = [],
  publicUrl?: string,
) {
  if (options?.resources && !publicUrl) throw new Error('SCIM resources need the public URL')
  const origin = publicUrl ? new URL(publicUrl).origin : ''
  const limit = createRateLimiter({ limit: 120, windowSeconds: 60 })
  const send = (c: Context, status: 200 | 401 | 403 | 404 | 429 | 500 | 501, body: unknown) => {
    c.header('Content-Type', 'application/scim+json')
    return c.body(JSON.stringify(body), status)
  }
  const respond = (c: Context, status: 401 | 404 | 429 | 500, detail: string) =>
    send(c, status, scimError(status, detail))
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
      // Locations name the stored organization, never the URL's spelling of it.
      const reply = options.resources?.({
        method: c.req.method,
        path: c.req.path.slice(`/scim/v2/${organizationId}`.length),
        query: new URL(c.req.url).searchParams,
        principal,
        base: `${origin}/scim/v2/${principal.organizationId}`,
      })
      if (reply) return send(c, reply.status, reply.body)
      return respond(c, 404, 'SCIM resources are not available yet.')
    } catch {
      // Never pass credentials, paths or driver diagnostics to a logger.
      return respond(c, 500, 'SCIM request could not be processed.')
    }
  })
}
