// The remote MCP server: Streamable HTTP at /mcp on the same server as the REST API,
// stateless, authenticated with API keys. See docs/mcp.md.
import { inspect } from 'node:util'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { type CallerResolver, escapeControlCharacters } from '@hourmere/auth'
import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { routeBodyLimit } from '../body-limit.ts'
import { withClientIpHeader } from '../client-ip.ts'
import { BOOKING_BODY_LIMIT } from '../routes/public.ts'
import { type McpCaller, prepareTools, registerTools, type Tool } from './tools.ts'

export const MCP_PATH = '/mcp'

/**
 * The largest legal tool call is create_booking with the largest legal booking: the REST
 * body (about 1.23 MB with every character escaped, see BOOKING_BODY_LIMIT) plus handle,
 * slug, idempotency key and the JSON-RPC envelope, a few KB more. So the same 2 MB.
 */
export const MCP_BODY_LIMIT = BOOKING_BODY_LIMIT

const SERVER_INFO = { name: 'hourmere', title: 'Hourmere', version: '0.0.0' }

const INSTRUCTIONS = `Hourmere schedules meetings. You act as the user who owns the API key, in the organization the key belongs to (whoami tells you who that is).
To book time with someone, call find_available_slots for their event type (handle and slug come from their booking link https://<host>/<handle>/<slug>), then create_booking with the exact start of one of the returned slots.
Times are RFC 3339: results give each time in UTC (Z) and, where you pass a timeZone, in that IANA time zone too.
create_booking and reschedule_booking return a manageToken once: keep it, it is the only way to reschedule or cancel that booking as the invitee.`

/** What createApp passes to the MCP module. */
export type McpModule = (shared: {
  app: OpenAPIHono
  /** The REST API's caller resolution; /mcp lets only API keys through it. */
  resolveCaller: CallerResolver
  /** PUBLIC_URL: the only origin browsers may send requests from. */
  publicUrl: string
}) => void

type McpEnv = { Variables: { mcpCaller: McpCaller } }

/** Logs one line with control characters escaped, as createApp does for REST errors. */
function logLine(level: 'ERROR' | 'WARN', what: string, detail: unknown): void {
  const shown =
    typeof detail === 'string' ? detail : inspect(detail, { breakLength: Number.POSITIVE_INFINITY })
  const text = `${what}${shown}`
  const log = level === 'ERROR' ? console.error : console.warn
  log(`${new Date().toISOString()} ${level} ${escapeControlCharacters(text)}`)
}

/**
 * The caller as the SDK carries it to the tools. Verification happened in front of the
 * handler (it never reads credentials itself), so the key's secret is not passed on: the
 * SDK only needs `token` for OAuth helpers that are not used here.
 */
function toAuthInfo(caller: McpCaller): AuthInfo {
  return { token: '', clientId: caller.apiKeyId, scopes: [], extra: { caller } }
}

function callerOf(authInfo: AuthInfo | undefined): McpCaller {
  const caller = authInfo?.extra?.caller as McpCaller | undefined
  // Only reachable if a request got past the endpoint without authentication.
  if (caller?.kind !== 'api_key') throw new Error('MCP request without an authenticated caller')
  return caller
}

const unauthorized = (c: Context, message: string) => {
  // Will name the protected-resource metadata (resource_metadata="…") once OAuth arrives.
  c.header('WWW-Authenticate', 'Bearer')
  return c.json({ error: 'unauthorized', message }, 401)
}

/**
 * Authenticates with `Authorization: Bearer hm_…` only. Cookies are dropped before caller
 * resolution, so a browser's session can never act through this JSON-RPC endpoint, which
 * pages on any site could post to (CSRF). Per-key rate limits apply as for REST: resolving
 * the key counts the request.
 */
function requireApiKey(resolveCaller: CallerResolver) {
  return createMiddleware<McpEnv>(async (c, next) => {
    if (c.req.header('authorization') === undefined) {
      return unauthorized(
        c,
        c.req.header('cookie') === undefined
          ? 'Send an API key as Authorization: Bearer hm_…'
          : 'The MCP endpoint does not accept session cookies; send an API key as Authorization: Bearer hm_…',
      )
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
      return unauthorized(c, 'The API key is malformed, unknown, expired or revoked')
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
}

/**
 * The MCP endpoint at /mcp. The composition root (server.ts) creates it with the tools,
 * which hold their services; createApp mounts it.
 *
 * OAuth 2.1 (for claude.ai and ChatGPT connectors) is meant to slot in here without
 * breaking API key clients: serve the protected-resource metadata where the 404 below is,
 * name it in the 401's WWW-Authenticate, and let requireApiKey also accept access tokens
 * that resolve to the same McpCaller.
 */
export function mcpEndpoint({ tools }: McpEndpointOptions): McpModule {
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
    app.all(
      MCP_PATH,
      // Enforced by createApp's apiBodyLimit, before anything reads the body.
      routeBodyLimit(MCP_BODY_LIMIT),
      noStore,
      checkOrigin(new URL(publicUrl).origin),
      postOnly(),
      requireApiKey(resolveCaller),
      (c) => handler.fetch(c.req.raw, { authInfo: toAuthInfo(c.var.mcpCaller) }),
    )

    // No OAuth yet. Answer the discovery documents (RFC 9728, RFC 8414, OpenID) with 404,
    // not the web app's HTML, so clients that look for them after a 401 learn that early.
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/*',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/*',
      '/.well-known/openid-configuration',
    ]) {
      app.all(path, (c) => c.json({ error: 'not_found' }, 404))
    }
  }
}
