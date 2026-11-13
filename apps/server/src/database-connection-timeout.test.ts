import { createHmac, randomBytes } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, createPool, type Db, DEFAULT_CONNECTION_TIMEOUT_MS } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { mcpOAuthRoutes } from './mcp/oauth.ts'

/** An exhausted pool answers 503 after the connection timeout instead of queueing forever. */
const serverUrl = process.env.DATABASE_URL
const BASE = 'http://localhost:4211'
const TIMEOUT_MS = 400
const BOUND_MS = 8_000
const POOL_SIZE = 2
const secret = randomBytes(32).toString('base64')

const timeoutOf = (pool: pg.Pool) =>
  (pool as unknown as { options: pg.PoolConfig }).options.connectionTimeoutMillis

describe('database pool connection timeout', () => {
  it('applies the documented default to the application, auth and lock pools', async () => {
    const url = 'postgres://synthetic@127.0.0.1:9/synthetic'
    const signup = { mode: 'closed', allowedDomains: [] } as const
    const app = createPool(url)
    const auth = createAuthPool(url, signup)
    const configured = createAuthPool(url, signup, { connectionTimeoutMillis: 2_500 })
    try {
      expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBe(10_000)
      expect(timeoutOf(app)).toBe(DEFAULT_CONNECTION_TIMEOUT_MS)
      expect(timeoutOf(auth)).toBe(DEFAULT_CONNECTION_TIMEOUT_MS)
      const locks = (pool: pg.Pool) =>
        (pool as unknown as { organizationLocks: pg.Pool }).organizationLocks
      expect(timeoutOf(locks(auth))).toBe(DEFAULT_CONNECTION_TIMEOUT_MS)
      expect(timeoutOf(configured)).toBe(2_500)
      expect(timeoutOf(locks(configured))).toBe(2_500)
    } finally {
      await Promise.all([app.end(), auth.end(), configured.end()])
    }
  })
})

describe.skipIf(!serverUrl)('exhausted database pools over HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let appPool: pg.Pool
  let app: ReturnType<typeof createApp>
  let held: pg.PoolClient[] = []
  let errors: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'pool_timeout' })
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup, { connectionTimeoutMillis: TIMEOUT_MS })
    appPool = createPool(owned.url, { connectionTimeoutMillis: TIMEOUT_MS })
    for (const pool of [authPool, appPool])
      (pool as unknown as { options: { max: number } }).options.max = POOL_SIZE
    const appDb = createDb(appPool)
    const auth = createAuth({
      db: appDb,
      pool: authPool,
      baseURL: BASE,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
    })
    await auth.$context
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db: appDb }),
      publicUrl: BASE,
      trustedProxies: [],
      routes: [mcpOAuthRoutes({ auth, db: appDb, publicUrl: BASE })],
    })
  })
  afterEach(() => {
    for (const client of held) client.release()
    held = []
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await Promise.all([authPool?.end(), appPool?.end()])
    await owned?.drop()
  })

  async function signedIn() {
    const user = await createTestUser(db)
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: user.principal.organization.id,
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

  /** Takes every connection of `pool`, as stuck transactions would. */
  async function exhaust(pool: pg.Pool) {
    for (let i = 0; i < POOL_SIZE; i++) held.push(await pool.connect())
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  }

  async function bounded(work: Response | Promise<Response>) {
    let timer: NodeJS.Timeout | undefined
    const started = Date.now()
    const outcome = await Promise.race([
      work,
      new Promise<'TIMEOUT'>((resolve) => {
        timer = setTimeout(() => resolve('TIMEOUT'), BOUND_MS)
      }),
    ])
    clearTimeout(timer)
    return { outcome, elapsed: Date.now() - started }
  }

  async function expectUnavailable(work: Response | Promise<Response>) {
    const { outcome, elapsed } = await bounded(work)
    expect(outcome, 'answered before the bound').not.toBe('TIMEOUT')
    const response = outcome as Response
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    const text = await response.text()
    // The stable code only: no driver message, pool detail or stack for the client.
    expect(JSON.parse(text)).toEqual({ error: 'service_unavailable' })
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50)
    expect(errors.join('\n')).toContain('database connection unavailable')
    expect(errors.join('\n')).not.toMatch(/\n\s+at /)
  }

  it('answers a REST request 503 when the application pool stays exhausted', async () => {
    const cookie = await signedIn()
    await exhaust(appPool)
    await expectUnavailable(
      app.request(`${BASE}/api/v1/mcp-oauth/connections`, { headers: { cookie, origin: BASE } }),
    )
  }, 30_000)

  it('answers an auth request 503 when the auth pool stays exhausted', async () => {
    const cookie = await signedIn()
    await exhaust(authPool)
    await expectUnavailable(
      app.request(`${BASE}/api/auth/organization/create`, {
        method: 'POST',
        headers: { cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Synthetic team',
          slug: `team-${randomBytes(4).toString('hex')}`,
        }),
      }),
    )
  }, 30_000)

  it('serves requests again once connections are free', async () => {
    const cookie = await signedIn()
    const response = await app.request(`${BASE}/api/v1/mcp-oauth/connections`, {
      headers: { cookie, origin: BASE },
    })
    expect(response.status).toBe(200)
  }, 30_000)
})
