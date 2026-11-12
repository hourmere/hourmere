import { createHash, createHmac, randomBytes } from 'node:crypto'
import { CLIENT_IP_HEADER, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpOAuthRoutes } from './mcp/oauth.ts'

/** Signed-in OAuth batches must leave the shared app pool available to other requests. */
const serverUrl = process.env.DATABASE_URL
const BASE = 'http://localhost:4198'
const CLIENT = 'https://pool-client.test/metadata.json'
const CALLBACK = 'https://pool-client.test/callback'
const POOL_SIZE = 3
const BOUND_MS = 15_000
let timedOut = false
const secret = randomBytes(32).toString('base64')
let nextAddress = 0
const testIp = () => `198.19.${Math.floor(++nextAddress / 250)}.${(nextAddress % 250) + 1}`

/** Resolves to the statuses, or to 'TIMEOUT' when the batch is still waiting at the bound. */
async function bounded(work: Promise<Response[]>) {
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    work.then((responses) => responses.map((response) => response.status)),
    new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), BOUND_MS)
    }),
  ])
  clearTimeout(timer)
  timedOut ||= outcome === 'TIMEOUT'
  return outcome
}

describe.skipIf(!serverUrl)('MCP OAuth app pool starvation', () => {
  let owned: TestDatabase, db: Db
  const pools: ReturnType<typeof createAuthPool>[] = []
  let needsSetup = true
  let cached: Awaited<ReturnType<typeof buildInstance>> | undefined
  beforeEach(async () => {
    if (!needsSetup) return
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    needsSetup = false
  })
  async function cleanup() {
    // A starved pool never drains; dropping the database ends its connections.
    await Promise.all(
      pools.map((pool) =>
        Promise.race([
          pool.end().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]),
      ),
    )
    await owned?.drop()
    pools.length = 0
    cached = undefined
    needsSetup = true
  }
  afterEach(async () => {
    // Reuse both pools across successful cases; an intentionally starved negative
    // control needs its own forced cleanup before the next case can run.
    if (timedOut) {
      await cleanup()
      timedOut = false
    }
  })
  afterAll(async () => {
    if (!needsSetup) await cleanup()
  })
  /** A real provider with a separate auth pool and exactly POOL_SIZE app connections. */
  async function instance() {
    cached ??= await buildInstance()
    return cached
  }
  async function buildInstance() {
    const signup = { mode: 'closed', allowedDomains: [] } as const
    const pool = createAuthPool(owned.url, signup)
    const appPool = createPool(owned.url)
    ;(appPool as unknown as { options: { max: number } }).options.max = POOL_SIZE
    pools.push(pool, appPool)
    // Hold successful BEGIN responses until every request owns its transaction client.
    // SQL still executes against PostgreSQL; only scheduling is controlled so a fast
    // machine cannot serialize the requests and hide the second-acquisition deadlock.
    let barrier: (() => Promise<void>) | undefined
    appPool.on('connect', (client) => {
      const query = client.query.bind(client)
      client.query = ((text: string, parameters: unknown[]) => {
        const result = query(text, parameters)
        const wait = text === 'begin' ? barrier : undefined
        return wait
          ? result.then(async (result) => {
              await wait()
              return result
            })
          : result
      }) as typeof client.query
    })
    function synchronizeTransactions() {
      let arrived = 0
      let release!: () => void
      const ready = new Promise<void>((resolve) => {
        release = resolve
      })
      barrier = async () => {
        if (++arrived === POOL_SIZE) {
          barrier = undefined
          release()
        }
        await ready
      }
    }
    const appDb = createDb(appPool)
    const auth = createAuth({
      db: appDb,
      pool,
      baseURL: BASE,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
      mcpMetadataFetcher: async (input) =>
        String(input) === CLIENT
          ? Response.json(
              {
                client_id: CLIENT,
                client_name: 'Synthetic pool connector',
                redirect_uris: [CALLBACK],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
              },
              { headers: { 'cache-control': 'max-age=600' } },
            )
          : new Response(null, { status: 404 }),
    })
    await auth.$context
    const request = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set(CLIENT_IP_HEADER, testIp())
      return auth.handler(new Request(new URL(path, BASE), { ...init, headers }))
    }
    const app = createApp({
      checkDb: async () => {
        await appDb.selectFrom('auth.user').select('id').limit(1).execute()
      },
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db: appDb }),
      publicUrl: BASE,
      trustedProxies: [],
      routes: [mcpOAuthRoutes({ auth, db: appDb, publicUrl: BASE })],
    })
    const api = (path: string, headers: Headers, body: object) =>
      app.request(
        `${BASE}/api/v1/mcp-oauth/${path}`,
        {
          method: 'POST',
          headers: {
            cookie: headers.get('cookie') ?? '',
            origin: BASE,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        { incoming: { socket: { remoteAddress: testIp() } } },
      )
    return {
      request,
      api,
      synchronizeTransactions,
      health: async () => app.request(`${BASE}/api/health`),
    }
  }
  type Instance = Awaited<ReturnType<typeof instance>>
  async function signedIn() {
    const user = await createTestUser(db)
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
        activeOrganizationId: user.principal.organization.id,
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      user,
      headers: new Headers({
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        origin: BASE,
      }),
    }
  }
  type Signed = Awaited<ReturnType<typeof signedIn>>
  /** Obtain the provider-signed query without making any external metadata requests. */
  async function untilSelection({ request }: Instance, s: Signed) {
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({
      client_id: CLIENT,
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'mcp:tools offline_access',
      resource: `${BASE}/mcp`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(16).toString('base64url'),
      prompt: 'consent',
    })
    const initial = await request(`/api/auth/oauth2/authorize?${query}`, { headers: s.headers })
    expect(initial.status).toBe(302)
    const selection = new URL(initial.headers.get('location') as string, BASE)
    return {
      body: {
        oauthQuery: selection.searchParams.toString(),
        organizationId: s.user.principal.organization.id,
      },
    }
  }
  async function untilConsent(target: Instance, s: Signed) {
    const { body } = await untilSelection(target, s)
    const selected = await target.api('select', s.headers, body)
    expect(selected.status).toBe(200)
    const continued = new URL(((await selected.json()) as { redirectUrl: string }).redirectUrl)
    expect(continued.pathname).toBe('/oauth/consent')
    return {
      body: {
        oauthQuery: continued.searchParams.toString(),
        intentId: new URLSearchParams(continued.hash.slice(1)).get('intent') as string,
        accept: true,
      },
    }
  }
  /** Authentication still works for someone else after the batch. */
  async function sessionStillResolves(target: Instance) {
    expect(await bounded(target.health().then((r) => [r])), 'database health after batch').toEqual([
      200,
    ])
    const other = await signedIn()
    expect(
      await bounded(
        target.request('/api/auth/get-session', { headers: other.headers }).then((r) => [r]),
      ),
      'session lookup after the batch',
    ).toEqual([200])
  }

  it('finishes as many signed-in select submissions as the app pool has connections', async () => {
    const target = await instance()
    const pending = []
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = await signedIn()
      pending.push({ s, body: (await untilSelection(target, s)).body })
    }
    target.synchronizeTransactions()
    expect(
      await bounded(
        Promise.all(pending.map(({ s, body }) => target.api('select', s.headers, body))),
      ),
      'select batch',
    ).toEqual(Array(POOL_SIZE).fill(200))
    await sessionStillResolves(target)
  }, 60_000)

  it('finishes as many signed-in consent submissions as the app pool has connections', async () => {
    const target = await instance()
    const pending = []
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = await signedIn()
      pending.push({ s, body: (await untilConsent(target, s)).body })
    }
    target.synchronizeTransactions()
    expect(
      await bounded(
        Promise.all(pending.map(({ s, body }) => target.api('consent', s.headers, body))),
      ),
      'consent batch',
    ).toEqual(Array(POOL_SIZE).fill(200))
    await sessionStillResolves(target)
  }, 60_000)

  it('finishes as many signed-in intent reads as the app pool has connections', async () => {
    const target = await instance()
    const pending = []
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = await signedIn()
      const { oauthQuery, intentId } = (await untilConsent(target, s)).body
      pending.push({ s, body: { oauthQuery, intentId } })
    }
    target.synchronizeTransactions()
    expect(
      await bounded(
        Promise.all(pending.map(({ s, body }) => target.api('request', s.headers, body))),
      ),
      'intent read batch',
    ).toEqual(Array(POOL_SIZE).fill(200))
    await sessionStillResolves(target)
  }, 60_000)
})
