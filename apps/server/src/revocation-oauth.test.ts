import '@hono/zod-openapi'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { mcpOAuthRoutes } from './mcp/oauth.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { closeServer } from './shutdown.ts'

const bootstrap = process.env.DATABASE_URL
const secret = 'synthetic-revocation-oauth-secret-at-least-thirty-two-characters'
const callback = 'https://connector.test/callback'
const signup = { mode: 'closed', allowedDomains: [] } as const
let nextAddress = 0
let transportAddress = '198.18.0.1'
type Mutation = readonly [string, string]
type Factories = {
  auth: typeof createAuth
  resolve: typeof createMcpOAuthResolver
  routes: typeof mcpOAuthRoutes
}

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const resolvePackage = (specifier: string) => {
    try {
      return import.meta.resolve(specifier)
    } catch {
      return pathToFileURL(createRequire(location).resolve(specifier)).href
    }
  }
  const code = stripTypeScriptTypes(source).replace(/from '([^']+)'/g, (_, specifier: string) => {
    const resolved =
      replacements[specifier] ??
      (specifier.startsWith('node:') ? specifier : undefined) ??
      (specifier.startsWith('.') ? new URL(specifier, location).href : resolvePackage(specifier))
    return `from '${resolved}'`
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

/** In-memory modules keep mutations out of working files and concurrent test workers. */
async function sourceCopy(oauthMutations: Mutation[] = [], brokerMutations: Mutation[] = []) {
  const oauthLocation = new URL('../../../packages/auth/src/mcp-oauth.ts', import.meta.url)
  let oauth = readFileSync(oauthLocation, 'utf8')
  for (const [before, after] of oauthMutations) {
    expect(oauth.includes(before), 'mutation matches the OAuth protection').toBe(true)
    oauth = oauth.replace(before, after)
  }
  const indexLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const indexUrl = moduleUrl(readFileSync(indexLocation, 'utf8'), indexLocation, {
    './mcp-oauth.ts': moduleUrl(oauth, oauthLocation),
  })
  const copiedAuth = (await import(indexUrl)) as typeof import('@hourmere/auth')
  const brokerLocation = new URL('./mcp/oauth.ts', import.meta.url)
  let broker = readFileSync(brokerLocation, 'utf8')
  for (const [before, after] of brokerMutations) {
    expect(broker.includes(before), 'mutation matches the consent broker protection').toBe(true)
    broker = broker.replace(before, after)
  }
  // Bind the broker's ordinary imports in Vitest's runtime. In particular, DomainError
  // must retain the constructor that createApp uses to map service refusals to HTTP 403.
  const imports = /^import\s+\{([\s\S]*?)\}\s+from\s+'([^']+)'\n/gm
  broker = stripTypeScriptTypes(broker)
  const bindings: Record<string, unknown> = {}
  for (const match of broker.matchAll(imports)) {
    const specifier = match[2] as string
    const imported =
      specifier === '@hourmere/auth'
        ? copiedAuth
        : ((await import(
            specifier.startsWith('.') ? new URL(specifier, brokerLocation).href : specifier
          )) as Record<string, unknown>)
    for (const item of (match[1] as string).split(',')) {
      const [name, alias = name] = item.trim().split(/\s+as\s+/)
      if (name && alias) bindings[alias] = imported[name as keyof typeof imported]
    }
  }
  const copiedRoutes = new Function(
    ...Object.keys(bindings),
    `${broker.replace(imports, '').replace(/\bexport /g, '')}; return mcpOAuthRoutes`,
  )(...Object.values(bindings)) as typeof mcpOAuthRoutes
  return {
    auth: copiedAuth.createAuth,
    resolve: copiedAuth.createMcpOAuthResolver,
    routes: copiedRoutes,
  } satisfies Factories
}

type HttpResponse = { status: number; headers: IncomingHttpHeaders; body: string }
function http(
  url: string,
  init: { headers?: Record<string, string>; body?: object | URLSearchParams } = {},
) {
  return new Promise<HttpResponse>((resolve, reject) => {
    const form = init.body instanceof URLSearchParams
    const body = init.body ? (form ? init.body.toString() : JSON.stringify(init.body)) : undefined
    const req = request(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        agent: false,
        headers: {
          accept: 'application/json',
          'x-forwarded-for': transportAddress,
          ...(body && {
            'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          }),
          ...init.headers,
        },
      },
      (res) => {
        let result = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          result += chunk
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: result }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

// Response bodies can contain one-time credentials: never pass them to a matcher.
function json<T>(response: HttpResponse): T {
  const body = response.headers['content-type']?.startsWith('text/event-stream')
    ? (response.body
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5) ?? '{}')
    : response.body
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error('Expected a structured HTTP response')
  }
}

describe.skipIf(!bootstrap)('OAuth team revocation over real HTTP and Postgres', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let server: Server
  let base: string
  let mounted: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'revoke_oauth' })
    db = createDb(owned.pool)
    // Every copied factory shares this pool and its two lock connections (at most 22 total).
    pool = createAuthPool(owned.url, signup)
    server = createServer((req, res) => {
      getRequestListener(mounted.fetch)(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    if (server) await closeServer(server)
    await pool?.end()
    await owned?.drop()
  })

  async function application(
    factories: Factories = {
      auth: createAuth,
      resolve: createMcpOAuthResolver,
      routes: mcpOAuthRoutes,
    },
  ) {
    const auth: Auth = factories.auth({
      db,
      pool,
      baseURL: base,
      secret,
      signup,
      mcpOAuth: true,
      mailer: { send: async () => {} },
      // Even a regression in client discovery must never call a real metadata endpoint.
      mcpMetadataFetcher: async () => new Response(null, { status: 404 }),
    })
    await auth.$context
    mounted = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: base,
      trustedProxies: ['127.0.0.1'],
      routes: [
        factories.routes({ auth, db, publicUrl: base }),
        memberLeaveRoutes({ db }),
        memberRemovalRoutes({ db }),
      ],
      mcp: mcpEndpoint({
        tools: [whoamiTool],
        oauth: { resolve: factories.resolve({ auth, db, publicUrl: base }), handler: auth.handler },
      }),
    })
  }

  async function session(user: TestUser, organizationId: string) {
    const token = randomBytes(24).toString('base64url')
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id: row.id,
      headers: {
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        origin: base,
      },
    }
  }

  async function fixture(factories?: Factories) {
    transportAddress = `198.18.${Math.floor(++nextAddress / 250)}.${(nextAddress % 250) + 1}`
    await application(factories)
    const member = await createTestUser(db, 'Departing OAuth administrator')
    const owner = await createTestUser(db, 'Remaining owner')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'admin' },
    ])
    const otherTeam = await createTestTeam(db, [{ user: member, role: 'owner' }])
    const memberSession = await session(member, team.id)
    const ownerSession = await session(owner, team.id)
    const registration = await http(`${base}/api/auth/oauth2/register`, {
      body: {
        client_name: 'Synthetic revocation connector',
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    })
    expect(registration.status).toBe(201)
    const clientId = json<{ client_id: string }>(registration).client_id
    return { member, owner, team, otherTeam, memberSession, ownerSession, clientId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  const post = (path: string, s: Fixture['memberSession'], body: object) =>
    http(`${base}${path}`, { headers: s.headers, body })

  async function begin(f: Fixture, organizationId = f.team.id) {
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({
      client_id: f.clientId,
      redirect_uri: callback,
      response_type: 'code',
      scope: 'mcp:tools offline_access',
      resource: `${base}/mcp`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(16).toString('base64url'),
      prompt: 'consent',
    })
    const initial = await http(`${base}/api/auth/oauth2/authorize?${query}`, {
      headers: {
        ...f.memberSession.headers,
        accept: 'text/html,application/xhtml+xml',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    expect(initial.status).toBe(302)
    const selection = new URL(initial.headers.location as string, base)
    const selected = await post('/api/v1/mcp-oauth/select', f.memberSession, {
      oauthQuery: selection.searchParams.toString(),
      organizationId,
    })
    expect(selected.status).toBe(200)
    const continued = new URL(json<{ redirectUrl: string }>(selected).redirectUrl)
    expect(continued.pathname).toBe('/oauth/consent')
    expect(new URLSearchParams(continued.hash.slice(1)).has('intent')).toBe(true)
    return {
      verifier,
      oauthQuery: continued.searchParams.toString(),
      intentId: new URLSearchParams(continued.hash.slice(1)).get('intent') as string,
    }
  }
  type Authorization = Awaited<ReturnType<typeof begin>>

  async function approve(f: Fixture, a: Authorization) {
    const response = await post('/api/v1/mcp-oauth/consent', f.memberSession, {
      oauthQuery: a.oauthQuery,
      intentId: a.intentId,
      accept: true,
    })
    expect(response.status).toBe(200)
    return new URL(json<{ redirectUrl: string }>(response).redirectUrl).searchParams.get(
      'code',
    ) as string
  }

  const exchange = (f: Fixture, a: Authorization, code: string) =>
    http(`${base}/api/auth/oauth2/token`, {
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: f.clientId,
        code,
        code_verifier: a.verifier,
        redirect_uri: callback,
        resource: `${base}/mcp`,
      }),
    })
  const refresh = (f: Fixture, token: string) =>
    http(`${base}/api/auth/oauth2/token`, {
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: f.clientId,
        refresh_token: token,
        resource: `${base}/mcp`,
      }),
    })

  async function connect(f: Fixture, organizationId = f.team.id) {
    const a = await begin(f, organizationId)
    const response = await exchange(f, a, await approve(f, a))
    expect(response.status).toBe(200)
    return json<{ access_token: string; refresh_token: string }>(response)
  }

  function mcp(token?: string, cookie?: string) {
    return http(`${base}/mcp`, {
      headers: {
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'whoami',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(cookie ? { cookie } : {}),
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'whoami',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    })
  }

  async function assertOrganization(token: string, organizationId: string) {
    const response = await mcp(token)
    expect(response.status).toBe(200)
    const body = json<{
      result: { isError?: boolean; structuredContent: { organization: { id: string } } }
    }>(response)
    expect(body.result.isError === true).toBe(false)
    expect(body.result.structuredContent.organization.id).toBe(organizationId)
  }

  async function depart(f: Fixture, action: 'leave' | 'remove') {
    const response = await http(
      `${base}${action === 'leave' ? `/api/v1/teams/${f.team.id}/leave` : `/api/v1/team/members/${f.member.id}/removal`}`,
      {
        headers: {
          ...(action === 'leave' ? f.memberSession.headers : f.ownerSession.headers),
          'x-expected-organization-id': f.team.id,
        },
        body: action === 'leave' ? {} : { teamId: f.team.id },
      },
    )
    expect(response.status).toBe(200)
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', f.member.id)
      .where('organizationId', '=', f.team.id)
      .executeTakeFirst()
    expect(membership === undefined).toBe(true)
  }

  const invalidGrant = (response: HttpResponse) => {
    expect(response.status).toBe(400)
    expect(json<{ error: string }>(response).error).toBe('invalid_grant')
  }

  async function revocationScenario(
    action: 'leave' | 'remove',
    factories?: Factories,
    includeSurvivor = false,
  ) {
    const f = await fixture(factories)
    const tokens = await connect(f)
    const surviving = includeSurvivor ? await connect(f, f.otherTeam.id) : undefined
    await assertOrganization(tokens.access_token, f.team.id)
    // Rotate before departure, then exercise both ordinary refresh and lost-response replay.
    const rotated = await refresh(f, tokens.refresh_token)
    expect(rotated.status).toBe(200)
    const next = json<{ access_token: string; refresh_token: string }>(rotated)
    const codeAuthorization = await begin(f)
    const code = await approve(f, codeAuthorization)
    const pending = await begin(f)
    await depart(f, action)
    return { f, tokens, next, codeAuthorization, code, pending, surviving }
  }
  type RevocationScenario = Awaited<ReturnType<typeof revocationScenario>>

  async function assertRevocationArea(scenario: RevocationScenario, area = 'all') {
    const { f, tokens, next, codeAuthorization, code, pending } = scenario
    if (area === 'all' || area === 'access') {
      expect((await mcp(tokens.access_token, f.memberSession.headers.cookie)).status).toBe(401)
      expect((await mcp(next.access_token)).status).toBe(401)
    }
    if (area === 'all' || area === 'refresh') invalidGrant(await refresh(f, next.refresh_token))
    if (area === 'all' || area === 'replay') invalidGrant(await refresh(f, tokens.refresh_token))
    if (area === 'all' || area === 'code') invalidGrant(await exchange(f, codeAuthorization, code))
    if (area === 'all' || area === 'consent') {
      const consent = await post('/api/v1/mcp-oauth/consent', f.memberSession, {
        oauthQuery: pending.oauthQuery,
        intentId: pending.intentId,
        accept: true,
      })
      expect(consent.status).toBe(403)
    }
  }

  async function assertRevoked(action: 'leave' | 'remove', factories?: Factories) {
    const scenario = await revocationScenario(action, factories, true)
    const { f, pending, surviving } = scenario
    await assertRevocationArea(scenario)
    const newSelection = await post('/api/v1/mcp-oauth/select', f.memberSession, {
      oauthQuery: pending.oauthQuery,
      organizationId: f.team.id,
    })
    expect(newSelection.status).toBe(403)
    if (surviving) {
      await assertOrganization(surviving.access_token, f.otherTeam.id)
      const renewed = await refresh(f, surviving.refresh_token)
      expect(renewed.status).toBe(200)
      await assertOrganization(json<{ access_token: string }>(renewed).access_token, f.otherTeam.id)
    }
    // A different, still-valid team and the personal session survive this team's departure.
    const me = await http(`${base}/api/v1/me`, { headers: f.memberSession.headers })
    expect(me.status).toBe(200)
    expect(json<{ organization: { id: string } }>(me).organization.id).toBe(
      f.member.principal.organization.id,
    )
    const switched = await post('/api/auth/organization/set-active', f.memberSession, {
      organizationId: f.otherTeam.id,
    })
    expect(switched.status).toBe(200)
  }

  async function bindingScenario(factories?: Factories) {
    const f = await fixture(factories)
    const tokens = await connect(f)
    const grant = await db
      .selectFrom('mcp_oauth_grants')
      .select(['id', 'organization_id'])
      .where('user_id', '=', f.member.id)
      .where('client_id', '=', f.clientId)
      .executeTakeFirstOrThrow()
    const switched = await post('/api/auth/organization/set-active', f.memberSession, {
      organizationId: f.otherTeam.id,
    })
    expect(switched.status).toBe(200)
    const me = await http(`${base}/api/v1/me`, { headers: f.memberSession.headers })
    expect(me.status).toBe(200)
    expect(json<{ organization: { id: string } }>(me).organization.id).toBe(f.otherTeam.id)
    await assertOrganization(tokens.access_token, f.team.id)
    const rotated = await refresh(f, tokens.refresh_token)
    expect(rotated.status).toBe(200)
    return { f, grant, refreshedToken: json<{ access_token: string }>(rotated).access_token }
  }

  async function assertBinding(factories?: Factories) {
    const { f, grant, refreshedToken } = await bindingScenario(factories)
    await assertOrganization(refreshedToken, f.team.id)
    const unchanged = await db
      .selectFrom('mcp_oauth_grants')
      .select('organization_id')
      .where('id', '=', grant.id)
      .executeTakeFirstOrThrow()
    expect(unchanged.organization_id).toBe(f.team.id)
    // A valid cookie accompanies each invalid credential; none authenticates the MCP call.
    for (const token of [undefined, 'malformed-oauth-token', 'hm_unknown-revocation-key']) {
      expect((await mcp(token, f.memberSession.headers.cookie)).status).toBe(401)
    }
  }

  it.each(['leave', 'remove'] as const)(
    'refuses issued access/refresh tokens, replay, code and pending grant after %s',
    async (action) => {
      await assertRevoked(action)
    },
    30_000,
  )
  it('keeps an existing OAuth grant in its consented team after a web switch', async () => {
    await assertBinding()
  }, 30_000)

  it('passes revocation and binding assertions with unchanged isolated source copies', async () => {
    const copy = await sourceCopy()
    await assertRevoked('remove', copy)
    await assertBinding(copy)
  }, 30_000)

  it('detects omitting live membership from access-token resolution', async () => {
    const copy = await sourceCopy([
      [
        `.innerJoin('auth.member as m', (j) =>
        j.onRef('m.userId', '=', 'g.user_id').onRef('m.organizationId', '=', 'g.organization_id'),
      )`,
        '',
      ],
    ])
    const scenario = await revocationScenario('remove', copy)
    await expect(assertRevocationArea(scenario, 'access')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 30_000)

  it('detects omitting membership at authorization-code exchange', async () => {
    const copy = await sourceCopy([['if (!row) throw refusal()', '']])
    const scenario = await revocationScenario('leave', copy)
    await expect(assertRevocationArea(scenario, 'code')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 30_000)

  it('detects omitting both membership checks for ordinary refresh', async () => {
    const copy = await sourceCopy([
      ['await requireMembership(db, refresh.userId, consent.organization_id, invalidGrant)', ''],
      ['await requireMembership(db, user.id, grant.organization_id, invalidGrant)', ''],
    ])
    const scenario = await revocationScenario('remove', copy)
    await expect(assertRevocationArea(scenario, 'refresh')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 30_000)

  it('detects omitting membership on lost-response refresh replay', async () => {
    const copy = await sourceCopy([
      ['await requireMembership(db, refresh.userId, consent.organization_id, invalidGrant)', ''],
    ])
    const scenario = await revocationScenario('leave', copy)
    await expect(assertRevocationArea(scenario, 'replay')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 30_000)

  it("detects accepting a departed member's pending grant consent", async () => {
    const copy = await sourceCopy(
      [['if (!row) throw refusal()', '']],
      [['if (!orgs.some((o) => o.id === row.organization_id)) throw forbidden()', '']],
    )
    const scenario = await revocationScenario('remove', copy)
    await expect(assertRevocationArea(scenario, 'consent')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 30_000)

  it("detects retargeting refreshed OAuth tokens to the web session's active team", async () => {
    const copy = await sourceCopy([
      [
        "'https://hourmere.com/organization': grant.organization_id,",
        "'https://hourmere.com/organization': (await db.selectFrom('auth.session').select('activeOrganizationId').where('userId', '=', user.id).executeTakeFirstOrThrow()).activeOrganizationId,",
      ],
    ])
    const scenario = await bindingScenario(copy)
    await expect(
      assertOrganization(scenario.refreshedToken, scenario.f.team.id),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  }, 30_000)
})
