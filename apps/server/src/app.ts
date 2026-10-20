import { relative } from 'node:path'
import { inspect } from 'node:util'
import { serveStatic } from '@hono/node-server/serve-static'
import { createRoute, type Hook, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  type CallerResolver,
  escapeControlCharacters,
  InvalidApiKeyError,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_SCOPES,
} from '@hourmere/auth'
import { embedParent } from '@hourmere/core/embed'
import { DomainError, type DomainErrorKind } from '@hourmere/scheduling'
import type { Context, Env } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { apiBodyLimit, checkBodyAsRead } from './body-limit.ts'
import { requireCaller } from './caller.ts'
import { clientIp, withClientIp } from './client-ip.ts'
import { errorAliasFor } from './error-aliases.ts'
import type { McpModule } from './mcp/endpoint.ts'
import { describeCaller, Me } from './me.ts'
import { authenticated, ErrorBody, json, type RouteModule } from './openapi.ts'
import { createRateLimiter, rateLimit, routeRateLimits } from './rate-limit.ts'
import {
  DEFAULT_HSTS_MAX_AGE,
  securityHeaders,
  strictTransportSecurity,
} from './security-headers.ts'
import { MAGIC_LINK_CONFIRM_PATH, signInConfirmPage } from './sign-in-confirm.ts'
import { VERSION } from './version.ts'

export interface AppDeps {
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>
  /** Better Auth's request handler (sign-in, sessions, API keys), served at /api/auth/*. */
  authHandler: (request: Request) => Promise<Response>
  /** Identifies the caller of authenticated routes (session cookie or API key). */
  resolveCaller: CallerResolver
  /** PUBLIC_URL: cookie-authenticated writes must come from its origin. */
  publicUrl: string
  /** Exact parent origins allowed to embed dedicated public booking pages. */
  embedOrigins?: readonly string[] | undefined
  /**
   * HSTS_MAX_AGE in seconds (default DEFAULT_HSTS_MAX_AGE); Strict-Transport-Security is only
   * sent when publicUrl is https on a real host name.
   */
  hstsMaxAge?: number | undefined
  /** Reverse proxies (IPs or CIDR ranges) whose X-Forwarded-For names the client. */
  trustedProxies?: readonly string[] | undefined
  /** Absolute path of the built web app, if this process should serve it. */
  webDist?: string | undefined
  /** Groups of /api/v1 routes, created by the composition root with their services. */
  routes?: readonly RouteModule[]
  /**
   * The remote MCP server, served at /mcp (see apps/server/src/mcp). When it accepts OAuth
   * grants, the provider's authorize endpoint is guarded here as well.
   */
  mcp?: McpModule | undefined
}

const Health = z
  .object({
    status: z.enum(['ok', 'degraded']),
    database: z.enum(['ok', 'unreachable']),
  })
  .openapi('Health')

const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  summary: 'Service health',
  responses: {
    200: {
      description: 'Service and database are up',
      content: { 'application/json': { schema: Health } },
    },
    503: {
      description: 'Database is unreachable',
      content: { 'application/json': { schema: Health } },
    },
  },
})

// HTTP status for each kind of DomainError (see docs/api-conventions.md).
const domainStatus = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
} as const satisfies Record<DomainErrorKind, number>

// Codes for errors raised by the framework itself (e.g. malformed JSON), so every error
// response has the documented `{ "error": code }` shape.
// Other 4xx statuses fall back to invalid_request; 5xx are always internal_error.
const httpErrorCodes: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
}

// Request validation failures (zod schemas on routes) answer like every other client error.
const validationHook: Hook<unknown, Env, string, unknown> = (result, c) => {
  if (result.success) return
  const message = result.error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
  return c.json({ error: 'invalid_request', message }, 400)
}

/**
 * Whether a parsed JSON value has a string or object key containing NUL or a lone surrogate.
 * Postgres refuses NUL in text and jsonb, and malformed Unicode breaks email, calendars and
 * logs downstream; no route has a use for either. Iterative, so deep nesting cannot
 * overflow the stack.
 */
export function hasUnsafeJsonText(value: unknown): boolean {
  const unsafe = (text: string) => text.includes('\u0000') || !text.isWellFormed()
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') {
      if (unsafe(item)) return true
    } else if (Array.isArray(item)) {
      // One by one: spreading a large array into push() exceeds V8's argument limit.
      for (const child of item) pending.push(child)
    } else if (typeof item === 'object' && item !== null) {
      for (const [key, child] of Object.entries(item)) {
        if (unsafe(key)) return true
        pending.push(child)
      }
    }
  }
  return false
}

/**
 * Whether `err` (or an error in its cause chain) is what a client's disconnect looks like to
 * the code reading its request: Node's exact "aborted" message, an AbortError
 * (e.g. a fetch given the request's signal), or a 4xx HTTPException, which is how a route's
 * validator reports a body it could not read (and never a server error anyway).
 */
function isDisconnect(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; depth < 5 && typeof e === 'object' && e !== null; depth++) {
    if (e instanceof HTTPException && e.status < 500) return true
    const { name, message } = e as { name?: unknown; message?: unknown }
    // Transport codes alone also describe database and upstream failures.
    if (name === 'AbortError') return true
    if (message === 'aborted') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** An error's name, message and code, cut to 200 characters: enough to recognize it. */
function summary(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 200)
  const code = (err as { code?: unknown }).code
  return `${err.name}: ${err.message}${typeof code === 'string' ? ` (${code})` : ''}`.slice(0, 200)
}

const JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]+\+)?json/i

/** Refuse malformed authorization attempts locally, before a provider can redirect them. */
async function validMcpAuthorization(request: Request, publicUrl: string) {
  let query: URLSearchParams
  if (request.method === 'POST') {
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
      return false
    query = new URLSearchParams(await request.clone().text())
  } else query = new URL(request.url).searchParams
  for (const key of new Set(query.keys())) if (query.getAll(key).length !== 1) return false
  const scopes = query.get('scope')?.split(' ') ?? []
  return (
    Boolean(query.get('client_id')) &&
    Boolean(query.get('redirect_uri')) &&
    query.get('response_type') === 'code' &&
    query.get('resource') === new URL('/mcp', publicUrl).href &&
    query.get('code_challenge_method') === 'S256' &&
    /^[\w-]{43}$/.test(query.get('code_challenge') ?? '') &&
    scopes.includes(MCP_OAUTH_SCOPE) &&
    scopes.every((scope) => MCP_OAUTH_SCOPES.includes(scope)) &&
    !query.get('prompt')?.split(' ').includes('none')
  )
}

function mcpAuthorizationError(c: Context) {
  return c.html(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unable to connect to Hourmere</title><h1>Unable to connect to Hourmere</h1><p>This authorization request is invalid. Return to the connector and start again.</p></html>',
    400,
    { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  )
}

/**
 * Defense in depth for every /api/v1 route, present and future: a JSON body with NUL or
 * malformed Unicode anywhere is refused when it is read, so no route gets to use it. The
 * check rides along as the route reads the body (checkBodyAsRead) instead of reading it up
 * front, which would happen before the route authenticates the caller. Services still check
 * each field's text with specific codes. Malformed JSON is left to the route's validator.
 */
const jsonTextGuard = createMiddleware(async (c, next) => {
  if (!JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '')) return next()
  const decoder = new TextDecoder()
  let text = ''
  return checkBodyAsRead(c, next, {
    chunk(bytes) {
      text += decoder.decode(bytes, { stream: true })
    },
    end() {
      let parsed: unknown
      try {
        parsed = JSON.parse(text + decoder.decode())
      } catch {
        return
      } finally {
        text = ''
      }
      if (hasUnsafeJsonText(parsed)) {
        throw new HTTPException(400, {
          message: 'Text in the request must not contain NUL characters or malformed Unicode',
        })
      }
    },
  })
})

/**
 * Product API responses carry private data (attendees, answers, manage links) and depend on
 * who asks, so no shared or browser cache may keep them, errors included: a cached 404 for a
 * mistyped token must not hide the real booking later. A route that wants caching sets its
 * own Cache-Control, which is left alone.
 */
const noStoreByDefault = createMiddleware(async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store')
})

// Hono's terminal colors (ESC sequences around the status); the one-line console would
// print them as visible escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC character is the point
const COLORS = /\u001b\[[0-9;]*m/g

/**
 * Logs requests without query strings (sign-in links and OAuth callbacks carry secrets
 * there) and without colors.
 */
const requestLogger = logger((line, ...rest) =>
  console.log(line.replace(/\?\S*/, '').replace(COLORS, ''), ...rest),
)

export function createApp({
  checkDb,
  authHandler,
  resolveCaller,
  publicUrl,
  embedOrigins = [],
  hstsMaxAge = DEFAULT_HSTS_MAX_AGE,
  trustedProxies = [],
  webDist,
  routes = [],
  mcp,
}: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook })
  // Logs one line with control characters escaped: error text can carry request input
  // (e.g. Postgres echoing a malformed value) and must not be able to forge log lines.
  // c.req.path is percent-decoded, so it is escaped too.
  const logLine = (c: Context, level: 'ERROR' | 'WARN', text: string) =>
    (level === 'ERROR' ? console.error : console.warn)(
      `${new Date().toISOString()} ${level} ${escapeControlCharacters(`${c.req.method} ${c.req.path}: ${text}`)}`,
    )
  const logError = (c: Context, label: string, detail: unknown) =>
    logLine(c, 'ERROR', `${label}${inspect(detail, { breakLength: Number.POSITIVE_INFINITY })}`)

  // Unexpected errors (including Better Auth's, which it rethrows) are logged and answered
  // with an opaque 500; only failures the caller can act on get a specific code.
  app.onError((err, c) => {
    // The client went away before it got an answer (it closed the connection, or the
    // server's request timeout cut it off and Node answered it 408), and the error is that
    // disconnect: reading the rest of the body failed (Better Auth throws "aborted", a
    // /api/v1 validator refuses the JSON). That is no server error and nobody gets the
    // answer: one WARN line naming the error, without a stack, and 499 (nginx's "client
    // closed request") for the request log. Any other error is logged as usual, even when
    // the client has left meanwhile.
    if (c.req.raw.signal.aborted && isDisconnect(err)) {
      logLine(c, 'WARN', `client closed the connection before the answer (${summary(err)})`)
      return new Response(null, { status: 499 })
    }
    if (err instanceof HTTPException && err.status < 500) {
      // A prepared response (e.g. from middleware) is sent as is; otherwise use our shape.
      if (err.res) return err.getResponse()
      const error = httpErrorCodes[err.status] ?? 'invalid_request'
      return c.json(err.message ? { error, message: err.message } : { error }, err.status)
    }
    if (err instanceof InvalidApiKeyError) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'unauthorized' }, 401)
    }
    // Failures the caller can act on, thrown by the service layer. An unknown kind (only
    // possible by bypassing the type) is a bug and falls through to the 500 below.
    if (err instanceof DomainError && Object.hasOwn(domainStatus, err.kind)) {
      // The lower-level error a service wrapped is for us, not the client.
      if (err.cause !== undefined) logError(c, `${err.code} caused by `, err.cause)
      const errorAlias = errorAliasFor(err.code)
      const body = {
        error: err.code,
        ...(errorAlias !== undefined && { errorAlias }),
        ...(err.detail && { message: err.detail }),
      }
      return c.json(body, domainStatus[err.kind])
    }
    logError(c, '', err)
    return c.json({ error: 'internal_error' }, 500)
  })
  // First, so it also covers what every later middleware, route and onError answers.
  app.use(
    '*',
    securityHeaders({ hsts: strictTransportSecurity(publicUrl, hstsMaxAge), embedOrigins }),
  )
  app.use('/embed/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    if (!embedParent(new URL(c.req.url), embedOrigins))
      return c.json({ error: 'embedding_not_allowed' }, 403)
    await next()
  })
  app.use('/oauth/*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
    c.res.headers.set('Referrer-Policy', 'no-referrer')
  })
  app.use('/api/*', requestLogger)
  app.use('/api/*', clientIp(trustedProxies))
  // First on /api/v1, so it also covers what the middleware below and onError answer.
  app.use('/api/v1/*', noStoreByDefault)
  // 64 KB unless the route declares more (routeBodyLimit). A Content-Length over the limit
  // gets 413 here; any other body is counted while whoever needs it reads it, so the size
  // check precedes every read without reading anything itself.
  app.use('/api/*', apiBodyLimit())
  // Routes' rate limits. Neither they nor the route's authentication read the body: a client
  // over its limit gets 429, an unknown one 401, before the server reads what it sends.
  app.use('/api/v1/*', routeRateLimits())
  // Checks the body while the route reads it. Not /api/auth: Better Auth reads the raw
  // request body itself.
  app.use('/api/v1/*', jsonTextGuard)
  // The MCP endpoint (and anything under it) is logged, body-limited and never cached like
  // /api/v1, 413s included; it applies its own checks.
  app.use('/mcp/*', noStoreByDefault, requestLogger, clientIp(trustedProxies), apiBodyLimit())
  app.use('/.well-known/*', clientIp(trustedProxies))

  app.openapi(healthRoute, async (c) => {
    try {
      await checkDb()
      return c.json({ status: 'ok' as const, database: 'ok' as const }, 200)
    } catch {
      return c.json({ status: 'degraded' as const, database: 'unreachable' as const }, 503)
    }
  })

  // Better Auth's own protocol (sign-in, sign-out, sessions, organizations, API keys); it
  // follows Better Auth's versioning, not ours, so it lives outside /api/v1.
  // Count even malformed requests that are refused before reaching Better Auth. This is
  // the provider's 30/minute authorize limit, independent of NODE_ENV.
  // Mounted exactly when the MCP module accepts OAuth grants, which the composition root
  // enables together with the provider: there is no separate switch to forget. With OAuth
  // off the provider has no authorize endpoint and dispatch stays as it was.
  if (mcp?.oauth) {
    const authorizeLimit = rateLimit(createRateLimiter({ limit: 30, windowSeconds: 60 }))
    for (const path of ['/api/auth/oauth2/authorize', '/api/auth/oauth2/authorize/']) {
      app.use(path, authorizeLimit)
      app.on(['GET', 'POST'], path, async (c) => {
        if (!(await validMcpAuthorization(c.req.raw, publicUrl))) return mcpAuthorizationError(c)
        const response = await authHandler(withClientIp(c.req.raw, c.var.clientIp))
        let location = response.headers.get('location')
        if (!location && response.headers.get('content-type')?.includes('application/json')) {
          const value = (await response.clone().json()) as { url?: unknown; redirect_uri?: unknown }
          const target = value.url ?? value.redirect_uri
          if (typeof target === 'string') location = target
        }
        if (location) {
          const redirect = new URL(location, publicUrl)
          // A missing/invalid client or redirect URI is not an instruction to navigate.
          // Render all authorize errors here, including the provider's local error URL.
          if (
            redirect.searchParams.has('error') ||
            new URLSearchParams(redirect.hash.slice(1)).has('error')
          )
            return mcpAuthorizationError(c)
        }
        return response
      })
    }
  }
  app.on(['GET', 'POST'], '/api/auth/*', (c) =>
    authHandler(withClientIp(c.req.raw, c.var.clientIp)),
  )

  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key (hm_…), created through POST /api/auth/api-key/create',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
    description: 'The web app session (prefixed __Secure- on https)',
  })

  // Authenticated routes list this middleware; it provides c.var.principal.
  const caller = requireCaller(resolveCaller, { allowedOrigin: new URL(publicUrl).origin })

  const meRoute = createRoute({
    method: 'get',
    path: '/api/v1/me',
    summary: 'The caller and the organization they act in',
    security: authenticated,
    middleware: caller,
    responses: {
      200: { description: 'The signed-in caller', content: json(Me) },
      401: { description: 'No valid session or API key', content: json(ErrorBody) },
      429: { description: "The API key's rate limit is used up", content: json(ErrorBody) },
    },
  })
  app.openapi(meRoute, (c) => c.json(describeCaller(c.var.principal), 200))

  for (const register of routes) register({ app, caller })
  mcp?.mount({ app, resolveCaller, publicUrl })

  // The product API is versioned under /api/v1 (agents depend on it for years);
  // /api/health is operational and stays unversioned. doc31 renders schemas the 3.1 way:
  // nullable fields as `type: [..., "null"]` (3.1 has no `nullable` keyword).
  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Hourmere API', version: VERSION },
  })

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

  // Where emailed sign-in links lead; served here, ahead of the web app.
  app.get(MAGIC_LINK_CONFIRM_PATH, signInConfirmPage)

  // Explicit discovery routes are mounted above. Unknown well-known resources must never
  // resolve to a static file or the SPA, including on self-hosted instances.
  app.all('/.well-known/*', (c) => c.text('Not found', 404))

  if (webDist) {
    // serveStatic resolves paths against the working directory.
    const root = relative(process.cwd(), webDist) || '.'
    // Vite's hashed bundles never change, so cache them for a year. A missing bundle (an old
    // tab asking for a file from the previous deploy) is a real 404, not the app's HTML.
    app.use('/assets/*', async (c, next) => {
      await next()
      if (c.res.status === 200)
        c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    })
    app.get('/assets/*', serveStatic({ root }))
    app.get('/assets/*', (c) => c.text('Not found', 404))
    // The app shell must be revalidated on every load; a cached index.html would keep
    // pointing at bundles from the previous deploy, which now return 404.
    app.use('*', async (c, next) => {
      await next()
      if (c.res.headers.get('content-type')?.startsWith('text/html')) {
        if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-cache')
      }
    })
    app.use('*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  return app
}
