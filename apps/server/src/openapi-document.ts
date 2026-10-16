import { createDb, createPool } from '@hourmere/db'
import { createApp } from './app.ts'
import { productRoutes } from './server.ts'

/**
 * The OpenAPI document as the server publishes it, made without a database: the app with
 * the same route groups as the server (productRoutes), asked for /api/v1/openapi.json, which
 * touches nothing else. `npm run api:types` generates the web app's API types from it.
 */
export async function openApiDocument(): Promise<unknown> {
  // Never connected: creating the route groups and answering the document use no database.
  const db = createDb(createPool('postgres://openapi@127.0.0.1:9/openapi'))
  try {
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost',
      routes: productRoutes({ db, socialProviders: {} }),
    })
    const res = await app.request('/api/v1/openapi.json')
    if (!res.ok) throw new Error(`GET /api/v1/openapi.json answered ${res.status}`)
    return await res.json()
  } finally {
    await db.destroy()
  }
}
