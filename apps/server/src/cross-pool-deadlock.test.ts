import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { CLIENT_IP_HEADER, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { mcpOAuthRoutes } from './mcp/oauth.ts'

/**
 * The application pool and the auth pool must never wait on each other. The MCP OAuth
 * broker holds an application transaction while the native provider reads through the
 * auth pool, so a transaction on the auth pool must never acquire an application
 * connection: invitation acceptance holds one while its organization hooks run.
 */
const serverUrl = process.env.DATABASE_URL
const BASE = 'http://localhost:4199'
const CLIENT = 'https://cross-pool-client.test/metadata.json'
const CALLBACK = 'https://cross-pool-client.test/callback'
/** Two acceptances: the organization-context lock pool admits no more at once. */
const HOLDERS = 2
const BOUND_MS = 15_000
const secret = randomBytes(32).toString('base64')
let nextAddress = 0
const testIp = () => `198.18.${Math.floor(++nextAddress / 250)}.${(nextAddress % 250) + 1}`

type Side = 'app' | 'auth'

describe.skipIf(!serverUrl)('application and auth pools under cross-pool load', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let appPool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'cross_pool' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    // A deadlocked pool never drains; dropping the database ends its connections.
    await Promise.all(
      [authPool, appPool].map((pool) =>
        pool
          ? Promise.race([
              pool.end().catch(() => {}),
              new Promise((resolve) => setTimeout(resolve, 1000)),
            ])
          : undefined,
      ),
    )
    await owned?.drop()
  })

  /**
   * Both pools have one connection more than the transactions under test. Every request
   * finishes its short reads through that spare connection, then waits after BEGIN until
   * both kinds of transaction are open. The test then takes the spare connections itself,
   * as other traffic would, so each pool is exhausted exactly by the opposing holders.
   */
  async function instance() {
    const signup = { mode: 'closed', allowedDomains: [] } as const
    // No connection timeout: this case proves the acquisition order, not the backstop.
    authPool = createAuthPool(owned.url, signup, { connectionTimeoutMillis: 0 })
    appPool = createPool(owned.url, { connectionTimeoutMillis: 0 })
    const arrived: Record<Side, number> = { app: 0, auth: 0 }
    let gate: Promise<void> | undefined
    let allArrived: (() => void) | undefined
    const instrument = (pool: pg.Pool, side: Side) => {
      ;(pool as unknown as { options: { max: number } }).options.max = HOLDERS + 1
      pool.on('connect', (client) => {
        const query = client.query.bind(client) as (...args: unknown[]) => unknown
        client.query = ((...args: unknown[]) => {
          const result = query(...args)
          const text = args[0]
          if (
            !gate ||
            typeof text !== 'string' ||
            !/^(begin|start transaction)\b/i.test(text) ||
            !(result instanceof Promise)
          )
            return result
          const wait = gate
          return result.then(async (value) => {
            arrived[side]++
            if (arrived.app >= HOLDERS && arrived.auth >= HOLDERS) allArrived?.()
            await wait
            return value
          })
        }) as typeof client.query
      })
    }
    instrument(appPool, 'app')
    instrument(authPool, 'auth')
    const appDb = createDb(appPool)
    const auth = createAuth({
      db: appDb,
      pool: authPool,
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
                client_name: 'Synthetic cross-pool connector',
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
    const request = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set(CLIENT_IP_HEADER, testIp())
      return auth.handler(new Request(new URL(path, BASE), { ...init, headers }))
    }
    const post = (path: string, cookie: string, body: object) =>
      app.request(
        `${BASE}${path}`,
        {
          method: 'POST',
          headers: { cookie, origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        { incoming: { socket: { remoteAddress: testIp() } } },
      )
    /** Holds every BEGIN until HOLDERS transactions are open on each pool. */
    function arm() {
      let release!: () => void
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        allArrived = resolve
      })
      return {
        ready,
        release: () => {
          gate = undefined
          allArrived = undefined
          release()
        },
      }
    }
    return { request, post, arm }
  }
  type Instance = Awaited<ReturnType<typeof instance>>

  function cookieFor(token: string) {
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

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
    return { user, cookie: cookieFor(token) }
  }

  /** A pending consent submission, reached through the real authorize and select steps. */
  async function pendingConsent(target: Instance) {
    const s = await signedIn()
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
    const initial = await target.request(`/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie: s.cookie, origin: BASE },
    })
    expect(initial.status).toBe(302)
    const selection = new URL(initial.headers.get('location') as string, BASE)
    const selected = await target.post('/api/v1/mcp-oauth/select', s.cookie, {
      oauthQuery: selection.searchParams.toString(),
      organizationId: s.user.principal.organization.id,
    })
    expect(selected.status).toBe(200)
    const continued = new URL(((await selected.json()) as { redirectUrl: string }).redirectUrl)
    expect(continued.pathname).toBe('/oauth/consent')
    return {
      cookie: s.cookie,
      body: {
        oauthQuery: continued.searchParams.toString(),
        intentId: new URLSearchParams(continued.hash.slice(1)).get('intent') as string,
        accept: true,
      },
    }
  }

  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic cross-pool account',
        email: `${randomUUID()}@outside.example`,
        emailVerified: true,
      })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow()
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    return { ...user, cookie: cookieFor(token) }
  }

  /** A pending team invitation for a separate signed-in recipient. */
  async function pendingAcceptance() {
    const owner = await account()
    const recipient = await account()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic cross-pool team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({ organizationId: team.id, userId: owner.id, role: 'owner', createdAt: new Date() })
      .execute()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email: recipient.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { recipient, team, body: { invitationId: invitation.id } }
  }

  it('accepts invitations and finishes MCP consents while each holds one pool', async () => {
    const target = await instance()
    const consents = []
    const acceptances = []
    for (let i = 0; i < HOLDERS; i++) {
      consents.push(await pendingConsent(target))
      acceptances.push(await pendingAcceptance())
    }

    const { ready, release } = target.arm()
    const work = Promise.all([
      ...acceptances.map((a) =>
        target.post('/api/auth/organization/accept-invitation', a.recipient.cookie, a.body),
      ),
      ...consents.map((c) => target.post('/api/v1/mcp-oauth/consent', c.cookie, c.body)),
    ])
    const spares: pg.PoolClient[] = []
    let timer: NodeJS.Timeout | undefined
    let outcome: number[] | 'TIMEOUT'
    let diagnosis = ''
    try {
      await ready
      // Every holder is open; take each pool's last connection like other traffic would.
      spares.push(await appPool.connect(), await authPool.connect())
      release()
      outcome = await Promise.race([
        work.then((responses) => responses.map((response) => response.status)),
        new Promise<'TIMEOUT'>((resolve) => {
          timer = setTimeout(() => resolve('TIMEOUT'), BOUND_MS)
        }),
      ])
      if (outcome === 'TIMEOUT') {
        // Name the holders, so a failure shows which transactions wait on which pool.
        const counts = (pool: pg.Pool) =>
          `${pool.totalCount} open, ${pool.idleCount} idle, ${pool.waitingCount} waiting`
        const held = await owned.pool.query<{ query: string }>(
          `SELECT left(query, 100) AS query FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'idle in transaction'`,
        )
        diagnosis = `app pool ${counts(appPool)}; auth pool ${counts(authPool)}; idle in transaction after: ${held.rows.map((row) => row.query).join(' | ')}`
      }
    } finally {
      clearTimeout(timer)
      release()
      for (const client of spares) client.release()
    }
    expect(outcome, `acceptances then consents, within the bound. ${diagnosis}`).toEqual(
      Array(HOLDERS * 2).fill(200),
    )
    const members = await db
      .selectFrom('auth.member')
      .select('organizationId')
      .where(
        'userId',
        'in',
        acceptances.map((a) => a.recipient.id),
      )
      .execute()
    expect(members.map((m) => m.organizationId).sort()).toEqual(
      acceptances.map((a) => a.team.id).sort(),
    )
  }, 60_000)

  /**
   * Records every application connection requested while an auth-pool transaction is open.
   * Each case sends one request at a time, so any such request is that request's own
   * hold-one-acquire-other wait, whether or not the pools are saturated.
   */
  async function witnessed(socialEmail?: string) {
    const signup = { mode: 'closed', allowedDomains: ['inviter.example'] } as const
    const witnessAuthPool = createAuthPool(owned.url, signup)
    const witnessAppPool = createPool(owned.url)
    const open = new Set<unknown>()
    const crossings: string[] = []
    witnessAuthPool.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown
      client.query = ((...args: unknown[]) => {
        const text = args[0]
        if (typeof text === 'string') {
          if (/^(begin|start transaction)\b/i.test(text)) open.add(client)
          else if (/^(commit|rollback)\b/i.test(text)) open.delete(client)
        }
        return query(...args)
      }) as typeof client.query
    })
    witnessAuthPool.on('release', (_error, client) => open.delete(client))
    const connect = witnessAppPool.connect.bind(witnessAppPool) as (...args: unknown[]) => unknown
    witnessAppPool.connect = ((...args: unknown[]) => {
      if (open.size > 0) crossings.push(new Error('application connection').stack ?? '')
      return connect(...args)
    }) as typeof witnessAppPool.connect
    const appDb = createDb(witnessAppPool)
    const auth = createAuth({
      db: appDb,
      pool: witnessAuthPool,
      baseURL: BASE,
      secret,
      signup,
      mailer: { send: async () => {} },
      socialProviders: { google: { clientId: 'synthetic', clientSecret: 'synthetic' } },
      socialProviderOptions: {
        google: {
          verifyIdToken: async () => true,
          getUserInfo: async () => ({
            user: { email: socialEmail ?? '', emailVerified: true, name: 'From provider' },
            data: { sub: `sub-${socialEmail}` } as never,
          }),
        },
      },
    })
    await auth.$context
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db: appDb }),
      publicUrl: BASE,
      trustedProxies: [],
    })
    return {
      app,
      crossings,
      close: () => Promise.all([witnessAuthPool.end(), witnessAppPool.end()]),
    }
  }

  it('reads through the held auth connection while accepting an invitation', async () => {
    const { app, crossings, close } = await witnessed()
    try {
      const a = await pendingAcceptance()
      const response = await app.request(`${BASE}/api/auth/organization/accept-invitation`, {
        method: 'POST',
        headers: { cookie: a.recipient.cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify(a.body),
      })
      expect(response.status).toBe(200)
      expect(crossings, 'application connections requested inside the auth transaction').toEqual([])
    } finally {
      await close()
    }
  }, 30_000)

  it('reads through the held auth connection while creating an invited social account', async () => {
    const email = `${randomUUID()}@outside.example`
    const owner = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic inviter',
        email: `${randomUUID()}@inviter.example`,
        emailVerified: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic invited team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({ organizationId: team.id, userId: owner.id, role: 'owner', createdAt: new Date() })
      .execute()
    await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .execute()
    const { app, crossings, close } = await witnessed(email)
    const realFetch = globalThis.fetch
    // Google's token endpoint answers the code exchange; the profile comes from the fake.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith('https://oauth2.googleapis.com/token')) return realFetch(input, init)
      return Response.json({
        access_token: 'access',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: 'header.payload.signature',
      })
    })
    try {
      const started = await app.request(`${BASE}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      })
      expect(started.status).toBe(200)
      const state = new URL(((await started.json()) as { url: string }).url).searchParams.get(
        'state',
      )
      const cookie = started.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      const callback = await app.request(
        `${BASE}/api/auth/callback/google?code=code&state=${state}`,
        { headers: { cookie } },
      )
      expect(callback.status).toBe(302)
      expect(new URL(callback.headers.get('location') as string, BASE).pathname).toBe('/')
      const created = await db
        .selectFrom('auth.user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst()
      expect(created, 'the invited address got its account').toBeDefined()
      expect(crossings, 'application connections requested inside the auth transaction').toEqual([])
    } finally {
      fetchSpy.mockRestore()
      await close()
    }
  }, 30_000)
})
