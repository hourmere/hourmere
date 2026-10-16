import { relative } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { CallerResolver } from '@hourmere/auth'
import { logger } from 'hono/logger'
import { requireCaller } from './caller.ts'

export interface AppDeps {
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>
  /** Better Auth's request handler (sign-in, sessions, API keys), served at /api/auth/*. */
  authHandler: (request: Request) => Promise<Response>
  /** Identifies the caller of authenticated routes (session cookie or API key). */
  resolveCaller: CallerResolver
  /** Absolute path of the built web app, if this process should serve it. */
  webDist?: string | undefined
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

const ErrorBody = z.object({ error: z.string() }).openapi('Error')

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

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

// Typed explicitly: an inferred literal type here makes createRoute lose the middleware's
// types (c.var.principal).
const authenticated: Record<string, string[]>[] = [{ apiKey: [] }, { session: [] }]

/** Logs requests without query strings: sign-in links and OAuth callbacks carry secrets there. */
const requestLogger = logger((line, ...rest) => console.log(line.replace(/\?\S*/, ''), ...rest))

export function createApp({ checkDb, authHandler, resolveCaller, webDist }: AppDeps) {
  const app = new OpenAPIHono()
  app.use('/api/*', requestLogger)

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
  app.on(['GET', 'POST'], '/api/auth/*', (c) => authHandler(c.req.raw))

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
  const caller = requireCaller(resolveCaller)

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
