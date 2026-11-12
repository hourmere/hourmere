import type { OpenAPIHono } from '@hono/zod-openapi'
import { authenticateScimToken } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { Context } from 'hono'
import { clientIp } from './client-ip.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'

export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

/**
 * A SCIM Error message (RFC 7644 section 3.12): the status is a string, and a 400 may name
 * its scimType keyword.
 */
export function scimError(status: number, detail: string, scimType?: string) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail,
  }
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
  /**
   * Reads the JSON request body, at most SCIM_BODY_LIMIT bytes of UTF-8. Only a handler that
   * needs the body calls it, after authentication; nothing is read before.
   */
  body?: (() => Promise<ScimBody>) | undefined
}

/** A parsed JSON body, or the SCIM Error that refuses it. */
export type ScimBody = { ok: true; value: unknown } | { ok: false; reply: ScimReply }

export interface ScimReply {
  status: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 501
  body: unknown
  /** Response headers such as Location or Retry-After; the content type is always SCIM's. */
  headers?: Record<string, string> | undefined
}

/** The largest request body a resource handler reads, as on /api/v1. */
export const SCIM_BODY_LIMIT = 64 * 1024

/**
 * Reads a body of at most SCIM_BODY_LIMIT bytes: a larger Content-Length is refused before
 * reading, and any other body is counted as it is read, so a body longer than its
 * Content-Length is refused too. Invalid UTF-8 or JSON is invalidSyntax; nothing is echoed.
 */
export async function readScimBody(request: Request): Promise<ScimBody> {
  const tooLarge: ScimBody = {
    ok: false,
    reply: { status: 413, body: scimError(413, 'The request body is too large.') },
  }
  const invalid: ScimBody = {
    ok: false,
    reply: {
      status: 400,
      body: scimError(400, 'The request body is not valid JSON.', 'invalidSyntax'),
    },
  }
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10)
  if (!request.headers.has('transfer-encoding') && declared > SCIM_BODY_LIMIT) return tooLarge
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > SCIM_BODY_LIMIT) {
        await reader.cancel().catch(() => {})
        return tooLarge
      }
      chunks.push(value)
    }
  }
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    }
  } catch {
    return invalid
  }
}

/**
 * Resource handlers answer authenticated requests; undefined leaves the request to the
 * unavailable answer. This is the resource test flag in docs/scim.md: only test harnesses
 * pass handlers, in code. productionAppOptions never does, and no environment or operator
 * setting, request parameter or build option reaches it.
 */
export type ScimResources = (request: ScimResourceRequest) => ScimReply | undefined
/** A resource handler that may read storage before it answers; injected the same way. */
export type ScimResourceHandler = (
  request: ScimResourceRequest,
) => ScimReply | undefined | Promise<ScimReply | undefined>

export interface ScimOptions {
  db: Db
  enabled: boolean
  resources?: ScimResourceHandler | undefined
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
  const send = (c: Context, status: ScimReply['status'] | 401 | 429 | 500, body: unknown) => {
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
      const reply = await options.resources?.({
        method: c.req.method,
        path: c.req.path.slice(`/scim/v2/${organizationId}`.length),
        query: new URL(c.req.url).searchParams,
        principal,
        base: `${origin}/scim/v2/${principal.organizationId}`,
        body: () => readScimBody(c.req.raw),
      })
      if (reply) {
        for (const [name, value] of Object.entries(reply.headers ?? {})) c.header(name, value)
        return send(c, reply.status, reply.body)
      }
      return respond(c, 404, 'SCIM resources are not available yet.')
    } catch {
      // Never pass credentials, paths or driver diagnostics to a logger.
      return respond(c, 500, 'SCIM request could not be processed.')
    }
  })
}
