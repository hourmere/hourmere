import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { CLIENT_IP_HEADER, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpOAuthRoutes } from './mcp/oauth.ts'

/**
 * A request must never hold an auth-pool connection while Better Auth needs another one
 * from the same pool: N such requests on a pool of N wait for each other forever, and
 * every sign-in, session lookup and key check behind them hangs until restart.
 */
const serverUrl = process.env.DATABASE_URL
const BASE = 'http://localhost:4198'
const CLIENT = 'https://pool-client.test/metadata.json'
const CALLBACK = 'https://pool-client.test/callback'
const POOL_SIZE = 3
const BOUND_MS = 15_000
const secret = randomBytes(32).toString('base64')
let nextAddress = 0
const testIp = () => `198.19.${Math.floor(++nextAddress / 250)}.${(nextAddress % 250) + 1}`

/** Resolves to the value, or to 'TIMEOUT' when the work is still waiting at the bound. */
async function within<T>(work: Promise<T>) {
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    work,
    new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), BOUND_MS)
    }),
  ])
  clearTimeout(timer)
  return outcome
}

/** Resolves to the statuses, or to 'TIMEOUT' when the batch is still waiting at the bound. */
function bounded(work: Promise<Response[]>) {
  return within(work.then((responses) => responses.map((response) => response.status)))
}

describe.skipIf(!serverUrl)('auth pool starvation', () => {
  let owned: TestDatabase, db: Db
  const pools: ReturnType<typeof createAuthPool>[] = []
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
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
  })
  /** A fresh auth instance whose pool has exactly `size` connections. */
  async function instance(size = POOL_SIZE) {
    const signup = { mode: 'closed', allowedDomains: [] } as const
    const pool = createAuthPool(owned.url, signup)
    ;(pool as unknown as { options: { max: number } }).options.max = size
    pools.push(pool)
    const auth = createAuth({
      db,
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
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: BASE,
      trustedProxies: [],
      routes: [mcpOAuthRoutes({ auth, db, publicUrl: BASE })],
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
    return { auth, request, api }
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
      token,
      headers: new Headers({
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        origin: BASE,
      }),
    }
  }
  type Signed = Awaited<ReturnType<typeof signedIn>>
  /** Authorization up to the consent screen, through the session broker. */
  async function untilConsent({ request, api }: Instance, s: Signed) {
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
    const selected = await api('select', s.headers, {
      oauthQuery: selection.searchParams.toString(),
      organizationId: s.user.principal.organization.id,
    })
    expect(selected.status).toBe(200)
    const continued = new URL(((await selected.json()) as { redirectUrl: string }).redirectUrl)
    expect(continued.pathname).toBe('/oauth/consent')
    return {
      verifier,
      body: {
        oauthQuery: continued.searchParams.toString(),
        intentId: new URLSearchParams(continued.hash.slice(1)).get('intent') as string,
        accept: true,
      },
    }
  }
  async function connected(target: Instance, s: Signed) {
    const pending = await untilConsent(target, s)
    const approved = await target.api('consent', s.headers, pending.body)
    expect(approved.status).toBe(200)
    const code = new URL(
      ((await approved.json()) as { redirectUrl: string }).redirectUrl,
    ).searchParams.get('code') as string
    const exchanged = await target.request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT,
        code,
        code_verifier: pending.verifier,
        redirect_uri: CALLBACK,
        resource: `${BASE}/mcp`,
      }),
    })
    expect(exchanged.status).toBe(200)
    return ((await exchanged.json()) as { refresh_token: string }).refresh_token
  }
  function revoke({ request }: Instance, clientId: string, token: string) {
    return request('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token }),
    })
  }
  /** Authentication still works for someone else after the batch. */
  async function sessionStillResolves(target: Instance) {
    const other = await signedIn()
    expect(
      await bounded(
        target.request('/api/auth/get-session', { headers: other.headers }).then((r) => [r]),
      ),
      'session lookup after the batch',
    ).toEqual([200])
  }

  it('finishes as many anonymous revocations as the pool has connections', async () => {
    const target = await instance()
    expect(
      await bounded(
        Promise.all(
          Array.from({ length: POOL_SIZE }, () => revoke(target, randomUUID(), 'probe-token')),
        ),
      ),
      'anonymous revocation batch',
    ).toEqual(Array(POOL_SIZE).fill(400))
    await sessionStillResolves(target)
  }, 60_000)

  it('finishes as many valid refresh-token revocations as the pool has connections', async () => {
    const target = await instance()
    const tokens = []
    for (let i = 0; i < POOL_SIZE; i++) tokens.push(await connected(target, await signedIn()))
    expect(
      await bounded(Promise.all(tokens.map((token) => revoke(target, CLIENT, token)))),
      'valid revocation batch',
    ).toEqual(Array(POOL_SIZE).fill(200))
    await sessionStillResolves(target)
  }, 60_000)

  // With one connection, a request that holds it while Better Auth needs another waits
  // forever on every run; a larger pool catches that only when the batch happens to overlap.
  it('finishes a consent submission and both revocations on a pool of one connection', async () => {
    const target = await instance(1)
    expect(
      await bounded(revoke(target, randomUUID(), 'probe-token').then((r) => [r])),
      'anonymous revocation',
    ).toEqual([400])
    const s = await signedIn()
    const pending = await untilConsent(target, s)
    expect(
      await bounded(
        Promise.resolve(target.api('consent', s.headers, pending.body)).then((r) => [r]),
      ),
      'consent submission',
    ).toEqual([200])
    const token = await within(connected(target, await signedIn()))
    expect(token, 'consent and token exchange for a connection').not.toBe('TIMEOUT')
    expect(
      await bounded(revoke(target, CLIENT, token as string).then((r) => [r])),
      'valid revocation',
    ).toEqual([200])
    await sessionStillResolves(target)
  }, 90_000)

  it.each(['/sign-out', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions'])(
    'finishes as many concurrent %s requests as the pool has connections',
    async (path) => {
      const target = await instance()
      const callers = []
      for (let i = 0; i < POOL_SIZE; i++) callers.push(await signedIn())
      expect(
        await bounded(
          Promise.all(
            callers.map((s) =>
              target.request(`/api/auth${path}`, {
                method: 'POST',
                headers: {
                  cookie: s.headers.get('cookie') as string,
                  origin: BASE,
                  'content-type': 'application/json',
                },
                body: JSON.stringify(path === '/revoke-session' ? { token: s.token } : {}),
              }),
            ),
          ),
        ),
        `${path} batch`,
      ).toEqual(Array(POOL_SIZE).fill(200))
      await sessionStillResolves(target)
    },
    60_000,
  )
})
