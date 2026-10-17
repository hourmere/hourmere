// The remote MCP server: Streamable HTTP at /mcp on the same server as the REST API,
// stateless, authenticated with API keys or optional OAuth grants. See docs/mcp.md.
import { inspect } from 'node:util'
import type { OpenAPIHono } from '@hono/zod-openapi'
import {
  type CallerResolver,
  type createMcpOAuthResolver,
  escapeControlCharacters,
} from '@hourmere/auth'
import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { routeBodyLimit } from '../body-limit.ts'
import { withClientIpHeader } from '../client-ip.ts'
import { createRateLimiter } from '../rate-limit.ts'
import { BOOKING_BODY_LIMIT } from '../routes/public.ts'
import { clip, type McpCaller, prepareTools, registerTools, type Tool } from './tools.ts'

export const MCP_PATH = '/mcp'

/**
 * The largest legal tool call is create_booking with the largest legal booking: the REST
 * body (about 1.23 MB with every character escaped, see BOOKING_BODY_LIMIT) plus handle,
 * slug, idempotency key and the JSON-RPC envelope, a few KB more. So the same 2 MB.
 */
export const MCP_BODY_LIMIT = BOOKING_BODY_LIMIT

const SERVER_INFO = { name: 'hourmere', title: 'Hourmere', version: '0.0.0' }

const INSTRUCTIONS = `Hourmere schedules meetings. You act as the user in the organization bound to your API key or OAuth grant (whoami tells you who that is).
To book time with someone, call find_available_slots for their event type (handle and slug come from their booking link https://<host>/<handle>/<slug>), then create_booking with the exact start of one of the returned slots.
Times are RFC 3339: results give each time in UTC (Z) and, where you pass a timeZone, in that IANA time zone too.
create_booking and reschedule_booking return a manageToken once: keep it, it is the only way to reschedule or cancel that booking as the invitee.`

/** What createApp passes to the MCP module. */
export type McpModule = (shared: {
  app: OpenAPIHono
  /** The REST resolver handles API keys; optional OAuth is verified separately. */
  resolveCaller: CallerResolver
  /** PUBLIC_URL: the only origin browsers may send requests from. */
  publicUrl: string
}) => void

type McpEnv = { Variables: { mcpCaller: McpCaller } }

/** Longest text of one log line, before escaping. */
const MAX_LOG_TEXT = 2000

/**
 * Logs one line with control characters escaped, as createApp does for REST errors, and cut
 * to MAX_LOG_TEXT: what the SDK reports repeats client input (methods, tool names, header
 * values), and an authenticated client must not be able to fill the disk.
 */
function logLine(level: 'ERROR' | 'WARN', what: string, detail: unknown): void {
  const shown =
    typeof detail === 'string'
      ? detail
      : inspect(detail, {
          breakLength: Number.POSITIVE_INFINITY,
          maxStringLength: MAX_LOG_TEXT,
          maxArrayLength: 20,
        })
  const text = clip(`${what}${shown}`, MAX_LOG_TEXT)
  const log = level === 'ERROR' ? console.error : console.warn
  log(`${new Date().toISOString()} ${level} ${escapeControlCharacters(text)}`)
}

/**
 * The caller as the SDK carries it to the tools. Verification happened in front of the
 * handler (it never reads credentials itself), so the key's secret is not passed on: the
 * SDK only needs `token` for OAuth helpers that are not used here.
 */
function toAuthInfo(caller: McpCaller): AuthInfo {
  return {
    token: '',
    clientId: caller.kind === 'api_key' ? caller.apiKeyId : caller.clientId,
    scopes: caller.kind === 'oauth' ? [...caller.scopes] : [],
    extra: { caller },
  }
}

function callerOf(authInfo: AuthInfo | undefined): McpCaller {
  const caller = authInfo?.extra?.caller as McpCaller | undefined
  // Only reachable if a request got past the endpoint without authentication.
  if (caller?.kind !== 'api_key' && caller?.kind !== 'oauth')
    throw new Error('MCP request without an authenticated caller')
  return caller
}

/**
 * 401 with the RFC 6750 challenge: `error="invalid_token"` when a bearer token was sent but
 * is not valid, a bare `Bearer` when there was none. Will also name the protected-resource
 * metadata (resource_metadata="…") once OAuth arrives.
 */
const unauthorized = (c: Context, message: string, invalidToken = false) => {
  c.header('WWW-Authenticate', invalidToken ? 'Bearer error="invalid_token"' : 'Bearer')
  return c.json({ error: 'unauthorized', message }, 401)
}

const BEARER = /^Bearer[ \t]+\S/i

/**
 * Authenticates with `Authorization: Bearer hm_…` only. Cookies are dropped before caller
 * resolution, so a browser's session can never act through this JSON-RPC endpoint, which
 * pages on any site could post to (CSRF). Per-key rate limits apply as for REST: resolving
 * the key counts the request.
 */
const oauthLimits = createRateLimiter({ limit: 120, windowSeconds: 60 })

function requireApiKey(
  resolveCaller: CallerResolver,
  oauth?: McpEndpointOptions['oauth'],
  publicUrl?: string,
) {
  return createMiddleware<McpEnv>(async (c, next) => {
    if (c.req.header('authorization') === undefined) {
      return unauthorized(
        c,
        c.req.header('cookie') === undefined
          ? 'Send an API key as Authorization: Bearer hm_…'
          : 'The MCP endpoint does not accept session cookies; send an API key as Authorization: Bearer hm_…',
      )
    }
    if (oauth && !/^Bearer[ \t]+hm_/i.test(c.req.header('authorization') ?? '')) {
      const result = await oauth.resolve(c.req.raw)
      if (!result.ok) {
        c.header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', publicUrl).href}", error="${result.error}"${result.error === 'insufficient_scope' ? ', scope="mcp:tools"' : ''}`,
        )
        return c.json({ error: result.error }, result.error === 'insufficient_scope' ? 403 : 401)
      }
      const retry = oauthLimits.hit(result.principal.oauthConsentId)
      if (retry !== undefined) {
        c.header('Retry-After', String(retry))
        return c.json({ error: 'rate_limited' }, 429)
      }
      c.set('mcpCaller', result.principal)
      return next()
    }
    const headers = withClientIpHeader(c.req.raw.headers, c.var.clientIp)
    headers.delete('cookie')
    const result = await resolveCaller(headers)
    if (!result.ok) {
      if (result.error === 'rate_limited') {
        if (result.retryAfterSeconds !== null)
          c.header('Retry-After', String(result.retryAfterSeconds))
        return c.json({ error: 'rate_limited' }, 429)
      }
      return unauthorized(
        c,
        'The API key is malformed, unknown, expired or revoked',
        BEARER.test(c.req.header('authorization') ?? ''),
      )
    }
    // With an Authorization header the resolver only accepts API keys; checked regardless.
    if (result.principal.kind !== 'api_key') {
      return unauthorized(c, 'Send an API key as Authorization: Bearer hm_…')
    }
    c.set('mcpCaller', result.principal)
    await next()
  })
}

/**
 * DNS rebinding and cross-site protection (MCP Streamable HTTP, "Security"): a request with
 * an Origin header comes from a web page, and only Hourmere's own pages may send one.
 * Clients that are not browsers send no Origin and pass.
 */
function checkOrigin(allowedOrigin: string) {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header('origin')
    if (origin !== undefined && origin !== allowedOrigin) {
      return c.json(
        { error: 'forbidden', message: 'MCP requests from web pages on other sites are refused' },
        403,
      )
    }
    await next()
  })
}

/** Responses carry private data and depend on the caller: never cached, errors included. */
const noStore = createMiddleware(async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'no-store')
})

/**
 * Stateless Streamable HTTP: one POST per JSON-RPC message, no sessions, no GET stream,
 * so any instance can answer any request. 2026-07-28 clients and 2025-era clients (which
 * still send `initialize`) are both served; GET and DELETE, the 2025 session operations,
 * are answered 405 as the specification asks of servers without sessions.
 */
function postOnly() {
  return createMiddleware(async (c, next) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST')
      return c.json(
        {
          error: 'method_not_allowed',
          message: 'This MCP endpoint is stateless: send each JSON-RPC message as a POST',
        },
        405,
      )
    }
    await next()
  })
}

export interface McpEndpointOptions {
  /** Served to every caller, in this order (clients may cache the list). */
  tools: readonly Tool[]
  oauth?: {
    resolve: ReturnType<typeof createMcpOAuthResolver>
    handler: (request: Request) => Promise<Response>
  }
}

/**
 * The MCP endpoint at /mcp. The composition root (server.ts) creates it with the tools,
 * which hold their services; createApp mounts it.
 *
 * Optional OAuth and metadata are supplied by the composition root. API keys keep their
 * existing resolver and rate limits; cookies never authenticate a JSON-RPC request.
 */
export function mcpEndpoint({ tools, oauth }: McpEndpointOptions): McpModule {
  const prepared = prepareTools(tools)
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer(SERVER_INFO, {
        // The tools never change while the server runs, so there is nothing to subscribe to.
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
      })
      registerTools(server, prepared, callerOf(authInfo), (what, detail) =>
        logLine('ERROR', `POST ${MCP_PATH} tools/call ${what}`, detail),
      )
      return server
    },
    {
      maxRequestBodySize: MCP_BODY_LIMIT,
      // Requests the SDK refused (e.g. bad protocol headers) and its own failures.
      onerror: (err) => logLine('WARN', `POST ${MCP_PATH}: `, err.message),
    },
  )

  return ({ app, resolveCaller, publicUrl }) => {
    if (oauth) {
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-authorization-server/api/auth',
        '/.well-known/openid-configuration/api/auth',
      ]) {
        app.get(path, async () => {
          const response = await oauth.handler(new Request(new URL(path, publicUrl)))
          response.headers.set('Cache-Control', 'no-store')
          return response
        })
      }
    }
    // `/mcp/` is the same endpoint: clients and proxies add the slash.
    for (const path of [MCP_PATH, `${MCP_PATH}/`]) {
      app.all(
        path,
        // Enforced by createApp's apiBodyLimit, before anything reads the body.
        routeBodyLimit(MCP_BODY_LIMIT),
        noStore,
        checkOrigin(new URL(publicUrl).origin),
        postOnly(),
        createMiddleware(async (c, next) => {
          await next()
          if (
            oauth &&
            c.res.status === 401 &&
            !c.res.headers.get('WWW-Authenticate')?.includes('resource_metadata')
          )
            c.res.headers.set(
              'WWW-Authenticate',
              `${c.res.headers.get('WWW-Authenticate') ?? 'Bearer'}, resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', publicUrl).href}"`,
            )
        }),
        requireApiKey(resolveCaller, oauth, publicUrl),
        (c) => handler.fetch(c.req.raw, { authInfo: toAuthInfo(c.var.mcpCaller) }),
      )
    }

    // Unknown or disabled discovery paths get JSON 404 rather than the SPA's HTML.
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/*',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/*',
      '/.well-known/openid-configuration',
      '/.well-known/openid-configuration/*',
      `${MCP_PATH}/*`,
    ]) {
      app.all(path, (c) => c.json({ error: 'not_found' }, 404))
    }
  }
}
