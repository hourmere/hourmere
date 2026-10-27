// Test support for route modules: the real app with every product route over a throwaway
// database, and a resolver that hands out real principals of inserted users.
import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createApp } from '../app.ts'
import { analyticsRoutes } from './analytics.ts'
import { bookingRoutes } from './bookings.ts'
import { calendarRoutes } from './calendars.ts'
import { conferenceRoutes } from './conferences.ts'
import { eventTypeRoutes } from './event-types.ts'
import { memberDepartureImpactRoutes } from './member-departure-impact.ts'
import { profileRoutes } from './profile.ts'
import { publicRoutes } from './public.ts'
import { scheduleRoutes } from './schedules.ts'
import { teamBookingRoutes } from './team-bookings.ts'
import { webhookRoutes } from './webhooks.ts'

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
  /** Sends `json` as the body exactly as given, e.g. from escapedJson. */
  raw: (method: string, path: string, json: string) => Promise<Answer>
}

/**
 * `value` as JSON with every character of every string (keys too) escaped as \uXXXX: the
 * largest encoding of a request, which body limits must allow (see body-limit.ts).
 */
export function escapedJson(value: unknown): string {
  if (typeof value === 'string') {
    const units = Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
    return `"${units.map((u) => `\\u${u.toString(16).padStart(4, '0')}`).join('')}"`
  }
  if (Array.isArray(value)) return `[${value.map(escapedJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    return `{${entries.map(([k, v]) => `${escapedJson(k)}:${escapedJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The product route modules, in server.ts's order. */
export const productRoutes = (db: Db) => [
  calendarRoutes({ db }),
  conferenceRoutes({ db }),
  profileRoutes({ db }),
  scheduleRoutes({ db }),
  webhookRoutes({ db, enabled: false }),
  eventTypeRoutes({ db }),
  publicRoutes({ db }),
  bookingRoutes({ db }),
  teamBookingRoutes({ db }),
  memberDepartureImpactRoutes({ db }),
  analyticsRoutes({ db }),
]

/**
 * The app as server.ts composes it, with `db` behind the routes (not touched by the doc).
 * `routes` replaces the route modules, e.g. to register them in another order.
 */
export function productApp(
  db: Db,
  principals: ReadonlyMap<string, Principal> = new Map(),
  routes = productRoutes(db),
) {
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
    routes,
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
    const sendText = async (method: string, path: string, json?: string): Promise<Answer> => {
      const headers: Record<string, string> = { ...extra }
      if (authorization) headers.authorization = authorization
      if (json !== undefined) headers['content-type'] = 'application/json'
      const res = await app.request(path, {
        method,
        headers,
        ...(json !== undefined && { body: json }),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    }
    const send = (method: string, path: string, body?: unknown) =>
      sendText(method, path, body === undefined ? undefined : JSON.stringify(body))
    return {
      get: (path: string) => send('GET', path),
      delete: (path: string) => send('DELETE', path),
      post: (path: string, body: unknown) => send('POST', path, body),
      put: (path: string, body: unknown) => send('PUT', path, body),
      patch: (path: string, body: unknown) => send('PATCH', path, body),
      raw: sendText,
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

type Schema = Record<string, unknown>
type Content = { content?: Record<string, { schema: Schema }> }

export interface OpenApiDoc {
  paths: Record<
    string,
    Record<
      string,
      { security?: unknown; requestBody?: Content; responses: Record<string, Content> }
    >
  >
  components: { schemas: Record<string, Schema> }
}

/** The app's OpenAPI document, for checking that routes are documented. */
export async function openApiDocument(app: ReturnType<typeof createApp>): Promise<OpenApiDoc> {
  const res = await app.request('/api/v1/openapi.json')
  return (await res.json()) as OpenApiDoc
}

/** Follows a `#/components/schemas/…` reference. */
export function resolve(doc: OpenApiDoc, schema: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') return schema
  const target = doc.components.schemas[ref.replace('#/components/schemas/', '')]
  if (!target) throw new Error(`unresolved ${ref}`)
  return resolve(doc, target)
}

/**
 * Where `schema` (references followed) contains an object that forbids properties it does
 * not list (`additionalProperties: false`), as JSON-ish paths.
 */
export function closedObjects(
  doc: OpenApiDoc,
  schema: Schema,
  path = '$',
  /** The schemas being visited above this one, so a recursive schema ends. */
  ancestors = new Set<Schema>(),
): string[] {
  const resolved = resolve(doc, schema)
  if (ancestors.has(resolved)) return []
  const found = resolved.additionalProperties === false ? [path] : []
  const children: [string, unknown][] = [
    ...Object.entries((resolved.properties as Record<string, Schema> | undefined) ?? {}).map(
      ([name, child]): [string, unknown] => [`${path}.${name}`, child],
    ),
    [`${path}[]`, resolved.items],
    ...(['oneOf', 'anyOf', 'allOf'] as const).flatMap((key) =>
      ((resolved[key] as Schema[] | undefined) ?? []).map((child, i): [string, unknown] => [
        `${path}|${key}${i}`,
        child,
      ]),
    ),
  ]
  const below = new Set(ancestors).add(resolved)
  for (const [childPath, child] of children) {
    if (typeof child === 'object' && child !== null) {
      found.push(...closedObjects(doc, child as Schema, childPath, below))
    }
  }
  return found
}

/**
 * Checks the operations under `paths`: every JSON response is open (clients must accept
 * new fields, so the document must not promise there are none) and every JSON request body
 * is strict at the top level.
 */
export function responseAndRequestStrictness(doc: OpenApiDoc, paths: string[]) {
  const closedResponses: string[] = []
  const openRequests: string[] = []
  for (const path of paths) {
    for (const [method, operation] of Object.entries(doc.paths[path] ?? {})) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = response.content?.['application/json']?.schema
        if (!schema) continue
        for (const where of closedObjects(doc, schema)) {
          closedResponses.push(`${method} ${path} ${status} ${where}`)
        }
      }
      const body = operation.requestBody?.content?.['application/json']?.schema
      if (body && resolve(doc, body).additionalProperties !== false) {
        openRequests.push(`${method} ${path}`)
      }
    }
  }
  return { closedResponses, openRequests }
}
