// Test support for route modules: the real app with this branch's product routes over a
// throwaway database, and a resolver that hands out real principals of inserted users.
import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createApp } from '../app.ts'
import { eventTypeRoutes } from './event-types.ts'
import { profileRoutes } from './profile.ts'
import { scheduleRoutes } from './schedules.ts'

export const PUBLIC_URL = 'http://localhost:3000'

export interface Answer {
  status: number
  /** The parsed JSON body; null when there is none (204). */
  body: unknown
}

export interface Client {
  get: (path: string) => Promise<Answer>
  delete: (path: string) => Promise<Answer>
  post: (path: string, body: unknown) => Promise<Answer>
  put: (path: string, body: unknown) => Promise<Answer>
  patch: (path: string, body: unknown) => Promise<Answer>
}

/** The app as index.ts composes it, with `db` behind the routes (not touched by the doc). */
export function productApp(db: Db, principals: ReadonlyMap<string, Principal> = new Map()) {
  return createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async (headers) => {
      const token = /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1]
      const principal = token === undefined ? undefined : principals.get(token)
      return principal
        ? { ok: true, principal, setCookie: [] }
        : { ok: false, error: 'unauthorized', setCookie: [] }
    },
    publicUrl: PUBLIC_URL,
    routes: [profileRoutes({ db }), scheduleRoutes({ db }), eventTypeRoutes({ db })],
  })
}

export interface TestApp {
  db: Db
  app: ReturnType<typeof createApp>
  /** Requests as `principal`; extra headers (e.g. Origin) go on every request. */
  as: (principal: Principal, headers?: Record<string, string>) => Client
  /** Requests without credentials. */
  anonymous: Client
  drop: () => Promise<void>
}

export async function createTestApp(serverUrl: string): Promise<TestApp> {
  const testDb: TestDatabase = await createTestDatabase(serverUrl)
  const db = createDb(testDb.pool)
  const principals = new Map<string, Principal>()
  const app = productApp(db, principals)

  const client = (authorization: string | undefined, extra: Record<string, string> = {}) => {
    const send = async (method: string, path: string, body?: unknown): Promise<Answer> => {
      const headers: Record<string, string> = { ...extra }
      if (authorization) headers.authorization = authorization
      if (body !== undefined) headers['content-type'] = 'application/json'
      const res = await app.request(path, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    }
    return {
      get: (path: string) => send('GET', path),
      delete: (path: string) => send('DELETE', path),
      post: (path: string, body: unknown) => send('POST', path, body),
      put: (path: string, body: unknown) => send('PUT', path, body),
      patch: (path: string, body: unknown) => send('PATCH', path, body),
    }
  }

  return {
    db,
    app,
    as: (principal, headers) => {
      const token = `hm_${randomUUID()}`
      principals.set(token, principal)
      return client(`Bearer ${token}`, headers)
    },
    anonymous: client(undefined),
    drop: () => testDb.drop(),
  }
}

/** The operations of `doc` and their security, for checking that routes are documented. */
export async function documentedOperations(app: ReturnType<typeof createApp>) {
  const res = await app.request('/api/v1/openapi.json')
  const doc = (await res.json()) as {
    paths: Record<
      string,
      Record<string, { security?: unknown; responses: Record<string, unknown> }>
    >
  }
  return doc.paths
}
