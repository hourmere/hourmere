import { createDb, createPool } from '@hourmere/db'
import { createApp } from './app.ts'
import type { Tool } from './mcp/tools.ts'
import { productRoutes } from './server.ts'
import { isTeamReadMiddleware } from './sso-read-routes.ts'
import { isTeamWriteMiddleware } from './sso-write-middleware.ts'

/**
 * The OpenAPI document as the server publishes it, made without a database: the app with
 * the same route groups as the server (productRoutes), asked for /api/v1/openapi.json, which
 * touches nothing else. Type generation also includes the in-process resource test routes.
 */
export async function openApiDocument({ scimResourcesEnabled = false } = {}): Promise<unknown> {
  return (await openApiRouteInventory({ scimResourcesEnabled })).document
}

/** Inspect the published document and Hono's registered routes from the same app. */
export async function openApiRouteInventory({ scimResourcesEnabled = false } = {}) {
  // Never connected: creating the route groups and answering the document use no database.
  const db = createDb(createPool('postgres://openapi@127.0.0.1:9/openapi'))
  try {
    let scimMappingTools: readonly Tool[] = []
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost',
      ...(scimResourcesEnabled && {
        scim: { db, enabled: true, resources: () => undefined },
        mcp: {
          oauth: false,
          mount({ additionalTools }) {
            scimMappingTools = additionalTools ?? []
          },
        },
      }),
      ssoTeamReads: { db, capabilities: { ssoOidcEnabled: false, ssoSamlEnabled: false } },
      routes: productRoutes({
        db,
        socialProviders: {},
        invitationMailLimits: { secret: 'openapi-document-only' },
      }),
    })
    const res = await app.request('/api/v1/openapi.json')
    if (!res.ok) throw new Error(`GET /api/v1/openapi.json answered ${res.status}`)
    return {
      document: (await res.json()) as unknown,
      routes: app.routes.map(({ method, path }) => ({ method, path })),
      scimMappingTools,
      teamReadRoutes: app.routes
        .filter(({ handler }) => isTeamReadMiddleware(handler))
        .map(({ method, path }) => `${method} ${path}`),
      teamWriteRoutes: app.routes
        .filter(({ handler }) => isTeamWriteMiddleware(handler))
        .map(({ method, path }) => `${method} ${path}`),
    }
  } finally {
    await db.destroy()
  }
}
