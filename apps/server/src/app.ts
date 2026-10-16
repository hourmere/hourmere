import { relative } from 'node:path'
import { inspect } from 'node:util'
import { serveStatic } from '@hono/node-server/serve-static'
import { createRoute, type Hook, OpenAPIHono, z } from '@hono/zod-openapi'
import { type CallerResolver, escapeControlCharacters } from '@hourmere/auth'
import { DomainError, type DomainErrorKind } from '@hourmere/scheduling'
import type { Context, Env } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { requireCaller } from './caller.ts'
import { clientIp, withClientIp } from './client-ip.ts'
import { authenticated, ErrorBody, json, type RouteModule } from './openapi.ts'

export interface AppDeps {
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>
  /** Better Auth's request handler (sign-in, sessions, API keys), served at /api/auth/*. */
  authHandler: (request: Request) => Promise<Response>
  /** Identifies the caller of authenticated routes (session cookie or API key). */
  resolveCaller: CallerResolver
  /** PUBLIC_URL: cookie-authenticated writes must come from its origin. */
  publicUrl: string
  /** Reverse proxies (IPs or CIDR ranges) whose X-Forwarded-For names the client. */
  trustedProxies?: readonly string[] | undefined
  /** Absolute path of the built web app, if this process should serve it. */
  webDist?: string | undefined
  /** Groups of /api/v1 routes, created by the composition root with their services. */
  routes?: readonly RouteModule[]
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

const Me = z
  .object({
    user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
    organization: z
      .object({
        id: z.uuid(),
        name: z.string(),
        slug: z.string(),
        personal: z.boolean().openapi({
          description: 'A personal organization (every user has one) rather than a team',
        }),
      })
      .openapi({ description: 'The organization the caller acts in' }),
    principal: z.object({
      kind: z.enum(['session', 'api_key']),
      apiKeyId: z.uuid().nullable().openapi({ description: 'The key used, for kind api_key' }),
    }),
  })
  .openapi('Me')

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
  trustedProxies = [],
  webDist,
  routes = [],
}: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook })
  // Unexpected errors (including Better Auth's, which it rethrows) are logged on one line with
  // control characters escaped: error messages can carry request input, e.g. Postgres echoing
  // a malformed value, and must not be able to forge log lines.
  // Logs one line with control characters escaped: error text can carry request input
  // (e.g. Postgres echoing a malformed value) and must not be able to forge log lines.
  // c.req.path is percent-decoded, so it is escaped too.
  const logError = (c: Context, label: string, detail: unknown) =>
    console.error(
      `${new Date().toISOString()} ERROR ${escapeControlCharacters(
        `${c.req.method} ${c.req.path}: ${label}${inspect(detail, { breakLength: Number.POSITIVE_INFINITY })}`,
      )}`,
    )

  // Unexpected errors (including Better Auth's, which it rethrows) are logged and answered
  // with an opaque 500; only failures the caller can act on get a specific code.
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status < 500) {
      // A prepared response (e.g. from middleware) is sent as is; otherwise use our shape.
      if (err.res) return err.getResponse()
      const error = httpErrorCodes[err.status] ?? 'invalid_request'
      return c.json(err.message ? { error, message: err.message } : { error }, err.status)
    }
    // Failures the caller can act on, thrown by the service layer. An unknown kind (only
    // possible by bypassing the type) is a bug and falls through to the 500 below.
    if (err instanceof DomainError && Object.hasOwn(domainStatus, err.kind)) {
      // The lower-level error a service wrapped is for us, not the client.
      if (err.cause !== undefined) logError(c, `${err.code} caused by `, err.cause)
      const body = err.detail ? { error: err.code, message: err.detail } : { error: err.code }
      return c.json(body, domainStatus[err.kind])
    }
    logError(c, '', err)
    return c.json({ error: 'internal_error' }, 500)
  })
  app.use('/api/*', requestLogger)
  app.use('/api/*', clientIp(trustedProxies))

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
  app.openapi(meRoute, (c) => {
    const p = c.var.principal
    return c.json(
      {
        user: p.user,
        organization: p.organization,
        principal: { kind: p.kind, apiKeyId: p.kind === 'api_key' ? p.apiKeyId : null },
      },
      200,
    )
  })

  for (const register of routes) register({ app, caller })

  // The product API is versioned under /api/v1 (agents depend on it for years);
  // /api/health is operational and stays unversioned.
  app.doc('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Hourmere API', version: '0.0.0' },
  })

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

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
        c.res.headers.set('Cache-Control', 'no-cache')
      }
    })
    app.use('*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  return app
}
