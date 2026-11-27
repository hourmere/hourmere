import type { OpenAPIHono } from '@hono/zod-openapi'
import { authenticateScimToken } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { Context } from 'hono'
import { clientIp } from './client-ip.ts'
import type { Tool } from './mcp/tools.ts'
import type { RouteModule } from './openapi.ts'
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
  /** Whether the client supplied a write precondition. This SCIM subset has no versions. */
  hasWritePrecondition?: boolean
  /**
   * Reads the JSON request body, at most SCIM_BODY_LIMIT bytes of UTF-8. Only a handler that
   * needs the body calls it, after authentication; nothing is read before.
   */
  body?: (() => Promise<ScimBody>) | undefined
}

/** A parsed JSON body, or the SCIM Error that refuses it. */
export type ScimBody = { ok: true; value: unknown } | { ok: false; reply: ScimReply }

export interface ScimReply {
  status: 200 | 201 | 204 | 400 | 401 | 403 | 404 | 409 | 412 | 413 | 429 | 501 | 503
  body: unknown
  /** Additional response headers such as Location or Retry-After. */
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
 * unavailable answer. Tests can inject individual handlers. Production registers the
 * complete set together when provisioning is enabled.
 */
export type ScimResources = (request: ScimResourceRequest) => ScimReply | undefined
/** A resource handler that may read storage before it answers; injected the same way. */
export type ScimResourceHandler = ((
  request: ScimResourceRequest,
) => ScimReply | undefined | Promise<ScimReply | undefined>) &
  ScimResourceRegistration

/** Discovery reads only the capabilities of the installed handlers. */
export interface ScimResourceRegistration {
  resourceType?: 'User' | 'Group'
  patch?: true
  filter?: { maxResults: number }
  bulk?: { maxOperations: number; maxPayloadSize: number }
  changePassword?: true
  sort?: true
  etag?: true
}

export interface ScimOptions {
  db: Db
  enabled: boolean
  resources?: ScimResourceHandler | undefined
  /** Mapping management is mounted only with the resource handlers. */
  mappingAdministration?: { route: RouteModule; tools: readonly Tool[] } | undefined
}

/** Separate protocol boundary for organization-scoped provisioning credentials. */
export function mountScim(
  app: OpenAPIHono,
  options?: ScimOptions,
  trustedProxies: readonly string[] = [],
  publicUrl?: string,
) {
  if (options?.resources && !publicUrl) throw new Error('SCIM resources need the public URL')
  const origin = publicUrl ? new URL(publicUrl).origin : ''
  const limit = createRateLimiter({ limit: 120, windowSeconds: 60 })
  const organizationLimit = options?.resources
    ? createRateLimiter({ limit: 120, windowSeconds: 60 })
    : undefined
  const credentialLimit = options?.resources
    ? createRateLimiter({ limit: 90, windowSeconds: 60 })
    : undefined
  const send = (c: Context, status: Exclude<ScimReply['status'], 204> | 500, body: unknown) => {
    c.header('Content-Type', 'application/scim+json')
    return c.body(JSON.stringify(body), status)
  }
  const respond = (c: Context, status: 401 | 404 | 429 | 500, detail: string) =>
    send(c, status, scimError(status, detail))
  const notFound = (c: Context) => respond(c, 404, 'Resource not found.')
  const rateLimited = (c: Context, retry: number) => {
    c.header('Retry-After', String(retry))
    return respond(c, 429, 'Too many requests.')
  }
  app.use('/scim/*', clientIp(trustedProxies))
  app.all('/scim/*', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    if (!options?.enabled) return notFound(c)
    const retry = limit.hit(rateLimitKey(c.var.clientIp))
    if (retry !== undefined) return rateLimited(c, retry)
    const organizationId = /^\/scim\/v2\/([a-f0-9-]{36})(?:\/|$)/i.exec(c.req.path)?.[1]
    if (!organizationId) return notFound(c)
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
      const credentialRetry = credentialLimit?.hit(principal.tokenId)
      if (credentialRetry !== undefined) return rateLimited(c, credentialRetry)
      const organizationRetry = organizationLimit?.hit(principal.organizationId)
      if (organizationRetry !== undefined) return rateLimited(c, organizationRetry)
      // Locations name the stored organization, never the URL's spelling of it.
      const reply = await options.resources?.({
        method: c.req.method,
        path: c.req.path.slice(`/scim/v2/${organizationId}`.length),
        query: new URL(c.req.url).searchParams,
        principal,
        base: `${origin}/scim/v2/${principal.organizationId}`,
        hasWritePrecondition: ['if-match', 'if-none-match', 'if-unmodified-since'].some((header) =>
          c.req.raw.headers.has(header),
        ),
        body: () => readScimBody(c.req.raw),
      })
      if (reply) {
        for (const [name, value] of Object.entries(reply.headers ?? {})) c.header(name, value)
        if (reply.status === 204) return c.body(null, 204)
        return send(c, reply.status, reply.body)
      }
      return notFound(c)
    } catch {
      // Never pass credentials, paths or driver diagnostics to a logger.
      return respond(c, 500, 'SCIM request could not be processed.')
    }
  })
}
