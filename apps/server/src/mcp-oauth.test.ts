import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto'
import {
  CLIENT_IP_HEADER,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
  MCP_OAUTH_SCOPE,
  withMcpOAuthIntent,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { mcpOAuthCleanupJob, mcpOAuthRoutes } from './mcp/oauth.ts'
import { whoamiTool } from './mcp/whoami.ts'

const serverUrl = process.env.DATABASE_URL
const BASE = 'http://localhost:4197'
const CLIENT = 'https://client.test/metadata.json'
const CALLBACK = 'https://client.test/callback'
const secret = randomBytes(32).toString('base64')
let nextAddress = 0
const testIp = () => `198.18.${Math.floor(++nextAddress / 250)}.${(nextAddress % 250) + 1}`
const queryOf = (url: URL) => url.searchParams.toString()
function redirectOf(value: unknown) {
  const v = value as { url?: unknown; redirect_uri?: unknown }
  const target = v.url ?? v.redirect_uri
  if (typeof target !== 'string') throw new Error('Expected an OAuth redirect result')
  return new URL(target, BASE)
}

describe.skipIf(!serverUrl)('MCP OAuth provider foundation', () => {
  let owned: TestDatabase,
    db: Db,
    pool: ReturnType<typeof createAuthPool>,
    auth: ReturnType<typeof createAuth>
  const fetched: string[] = []
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool,
      baseURL: BASE,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
      mcpMetadataFetcher: async (input) => {
        const url = String(input)
        fetched.push(url)
        if (url !== CLIENT) return new Response(null, { status: 404 })
        return Response.json(
          {
            client_id: CLIENT,
            client_name: 'Synthetic connector',
            redirect_uris: [CALLBACK],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          },
          { headers: { 'cache-control': 'max-age=600' } },
        )
      },
    })
    await auth.$context
  })
  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })
  const request = (path: string, init?: RequestInit) => {
    // Each independent synthetic flow has its own transport address. Rate-limit behavior
    // itself is exercised separately with a fixed address.
    const headers = new Headers(init?.headers)
    headers.set(CLIENT_IP_HEADER, testIp())
    return auth.handler(new Request(new URL(path, BASE), { ...init, headers }))
  }
  async function session(existingUser?: Awaited<ReturnType<typeof createTestUser>>) {
    const user = existingUser ?? (await createTestUser(db))
    const token = randomBytes(24).toString('base64url')
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
        activeOrganizationId: user.principal.organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      user,
      sessionId: row.id,
      principal: { ...user.principal, kind: 'session' as const, sessionId: row.id },
      headers: new Headers({
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        origin: BASE,
      }),
    }
  }
  function authorization() {
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({
      client_id: CLIENT,
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: `${MCP_OAUTH_SCOPE} offline_access`,
      resource: `${BASE}/mcp`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(16).toString('base64url'),
    })
    return { verifier, query }
  }
  it('publishes resource and issuer metadata with PKCE and no machine grant', async () => {
    const resource = await request('/.well-known/oauth-protected-resource/mcp')
    expect(resource.status).toBe(200)
    expect(await resource.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [`${BASE}/api/auth`],
      scopes_supported: [MCP_OAUTH_SCOPE],
    })
    const metadata = await request('/.well-known/oauth-authorization-server/api/auth')
    expect(metadata.status).toBe(200)
    const doc = (await metadata.json()) as {
      issuer: string
      grant_types_supported: string[]
      code_challenge_methods_supported: string[]
      client_id_metadata_document_supported: boolean
      authorization_response_iss_parameter_supported: boolean
    }
    expect(doc.issuer).toBe(`${BASE}/api/auth`)
    expect(doc.code_challenge_methods_supported).toContain('S256')
    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(doc.client_id_metadata_document_supported).toBe(true)
    expect(doc.authorization_response_iss_parameter_supported).toBe(true)
  })
  it('keeps private signing material encrypted and disables session JWT minting', async () => {
    const jwks = await request('/api/auth/jwks')
    expect(jwks.status).toBe(200)
    const document = (await jwks.json()) as { keys: Record<string, unknown>[] }
    expect(document.keys.length > 0).toBe(true)
    expect(document.keys.some((key) => Object.hasOwn(key, 'd'))).toBe(false)
    const rows = await db.selectFrom('auth.jwks').select(['publicKey', 'privateKey']).execute()
    expect(rows.length > 0).toBe(true)
    for (const row of rows) {
      expect(row.privateKey.includes('"d":')).toBe(false)
      expect(row.privateKey === row.publicKey).toBe(false)
    }
    const s = await session()
    expect((await request('/api/auth/token', { headers: s.headers })).status).toBe(404)
    const sessionResponse = await request('/api/auth/get-session', { headers: s.headers })
    expect(sessionResponse.status).toBe(200)
    expect(sessionResponse.headers.has('set-auth-jwt')).toBe(false)
  })
  it('signs continuations, resolves only injected HTTPS metadata and refuses tampering', async () => {
    const { query } = authorization()
    const answer = await request(`/api/auth/oauth2/authorize?${query}`)
    expect(answer.status).toBe(302)
    const location = answer.headers.get('location')
    expect(typeof location === 'string').toBe(true)
    const signed = new URL(location as string, BASE)
    expect(signed.pathname).toBe('/oauth/authorize')
    expect(signed.searchParams.has('sig')).toBe(true)
    const valid = await request('/api/auth/oauth2/public-client-prelogin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ client_id: CLIENT, oauth_query: queryOf(signed) }),
    })
    expect(valid.status).toBe(200)
    expect(fetched.length > 0).toBe(true)
    expect(fetched.every((url) => url === CLIENT)).toBe(true)
    signed.searchParams.set('redirect_uri', 'https://other.test/callback')
    const tampered = await request('/api/auth/oauth2/public-client-prelogin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ client_id: CLIENT, oauth_query: queryOf(signed) }),
    })
    expect(tampered.status >= 400).toBe(true)
  })
  it('pins consent and code/refresh tokens to a trusted organization choice across active-team switches', async () => {
    const s = await session(),
      team = await createTestTeam(db, [{ user: s.user, role: 'owner' }])
    const { query, verifier } = authorization()
    const answer = await request(`/api/auth/oauth2/authorize?${query}`, { headers: s.headers })
    expect(answer.status).toBe(302)
    const selection = new URL(answer.headers.get('location') as string, BASE)
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: s.user.id, organization_id: team.id, client_id: CLIENT })
      .returning('id')
      .executeTakeFirstOrThrow()
    const intent = {
      grantId: grant.id,
      id: randomUUID(),
      userId: s.user.id,
      sessionId: s.sessionId,
      organizationId: team.id,
    }
    const headers = new Headers(s.headers)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json')
    const continuation = await withMcpOAuthIntent(intent, () =>
      request('/api/auth/oauth2/continue', {
        method: 'POST',
        headers,
        body: JSON.stringify({ postLogin: true, oauth_query: queryOf(selection) }),
      }),
    )
    expect(continuation.status).toBe(200)
    const continued = redirectOf(await continuation.json())
    expect(continued.pathname).toBe('/oauth/consent')
    // A different tab's active organization must not decide what this consent means.
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: s.user.principal.organization.id })
      .where('id', '=', s.sessionId)
      .execute()
    const approval = await withMcpOAuthIntent(intent, () =>
      request('/api/auth/oauth2/consent', {
        method: 'POST',
        headers,
        body: JSON.stringify({ accept: true, oauth_query: queryOf(continued) }),
      }),
    )
    expect(approval.status).toBe(200)
    const approved = redirectOf(await approval.json())
    expect(approved.origin).toBe(new URL(CALLBACK).origin)
    expect(approved.pathname).toBe('/callback')
    expect(approved.searchParams.get('iss')).toBe(`${BASE}/api/auth`)
    const code = approved.searchParams.get('code')
    expect(typeof code === 'string').toBe(true)
    const token = await request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT,
        code: code as string,
        code_verifier: verifier,
        redirect_uri: CALLBACK,
        resource: `${BASE}/mcp`,
      }),
    })
    expect(token.status).toBe(200)
    const tokens = (await token.json()) as { access_token: string; refresh_token: string }
    expect(typeof tokens.access_token === 'string').toBe(true)
    expect(typeof tokens.refresh_token === 'string').toBe(true)
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1] as string, 'base64url').toString(),
    )
    expect(claims['https://hourmere.com/organization']).toBe(team.id)
    expect(
      await db
        .selectFrom('auth.oauthConsent')
        .select('referenceId')
        .where('userId', '=', s.user.id)
        .execute(),
    ).toEqual([{ referenceId: grant.id }])
    const refresh = await request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT,
        refresh_token: tokens.refresh_token,
        resource: `${BASE}/mcp`,
      }),
    })
    expect(refresh.status).toBe(200)
    const next = (await refresh.json()) as { access_token: string }
    const nextClaims = JSON.parse(
      Buffer.from(next.access_token.split('.')[1] as string, 'base64url').toString(),
    )
    expect(nextClaims['https://hourmere.com/organization']).toBe(team.id)
  })
  function app(trustedProxies: readonly string[] = []) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: BASE,
      mcpOAuthEnabled: true,
      trustedProxies,
      routes: [mcpOAuthRoutes({ auth, db, publicUrl: BASE })],
      mcp: mcpEndpoint({
        tools: [whoamiTool],
        oauth: {
          resolve: createMcpOAuthResolver({ auth, db, publicUrl: BASE }),
          handler: auth.handler,
        },
      }),
    })
  }
  async function api(
    path: string,
    s: Awaited<ReturnType<typeof session>>,
    body?: object,
    method = 'POST',
  ) {
    const headers = new Headers(s.headers)
    headers.set('content-type', 'application/json')
    return app().request(
      `${BASE}/api/v1/mcp-oauth/${path}`,
      {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      { incoming: { socket: { remoteAddress: testIp() } } },
    )
  }
  async function begin(
    s: Awaited<ReturnType<typeof session>>,
    organizationId = s.user.principal.organization.id,
    additional: Record<string, string> = {},
  ) {
    const a = authorization()
    a.query.set('prompt', 'consent')
    for (const [k, v] of Object.entries(additional)) a.query.set(k, v)
    const initial = await request(`/api/auth/oauth2/authorize?${a.query}`, { headers: s.headers })
    expect(initial.status).toBe(302)
    const selection = new URL(initial.headers.get('location') as string, BASE)
    const info = await api('request', s, { oauthQuery: queryOf(selection) })
    expect(info.status).toBe(200)
    expect(
      ((await info.json()) as { organizations: { id: string }[] }).organizations.some(
        (o) => o.id === organizationId,
      ),
    ).toBe(true)
    const selected = await api('select', s, { oauthQuery: queryOf(selection), organizationId })
    expect(selected.status).toBe(200)
    const continued = new URL(((await selected.json()) as { redirectUrl: string }).redirectUrl)
    expect(continued.pathname).toBe('/oauth/consent')
    const intentId = new URLSearchParams(continued.hash.slice(1)).get('intent') as string
    expect(typeof intentId === 'string').toBe(true)
    return { ...a, selection, continued, intentId, oauthQuery: queryOf(continued) }
  }
  async function approved(
    s: Awaited<ReturnType<typeof session>>,
    a: Awaited<ReturnType<typeof begin>>,
    accept = true,
  ) {
    const response = await api('consent', s, {
      oauthQuery: a.oauthQuery,
      intentId: a.intentId,
      accept,
    })
    expect(response.status).toBe(200)
    return new URL(((await response.json()) as { redirectUrl: string }).redirectUrl)
  }
  async function exchange(
    a: Awaited<ReturnType<typeof begin>>,
    code: string,
    options: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) {
    return request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT,
        code,
        code_verifier: a.verifier,
        redirect_uri: CALLBACK,
        resource: `${BASE}/mcp`,
        ...options,
      }),
    })
  }
  async function connected(
    s: Awaited<ReturnType<typeof session>>,
    organizationId = s.user.principal.organization.id,
  ) {
    const a = await begin(s, organizationId),
      url = await approved(s, a)
    const response = await exchange(a, url.searchParams.get('code') as string)
    expect(response.status).toBe(200)
    return (await response.json()) as { access_token: string; refresh_token: string }
  }
  const mcpRequest = (token?: string, extra: Record<string, string> = {}, path = '/mcp') =>
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'whoami',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: JSON.stringify({
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
      }),
    })

  it('serves discovery through the actual app and challenges OAuth clients without reading their body', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server/api/auth',
    ]) {
      const response = await app().request(`${BASE}${path}`, undefined, {
        incoming: { socket: { remoteAddress: testIp() } },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const denied = await app().request(mcpRequest())
    expect(denied.status).toBe(401)
    expect(denied.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(await denied.json()).toMatchObject({ message: expect.stringContaining('OAuth') })
    expect((await app().request(mcpRequest('bad-token'))).status).toBe(401)
  })
  it('isolates discovery rate limits by transport address without missing-IP warnings', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const server = app()
      const paths = [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-authorization-server/api/auth',
        '/.well-known/openid-configuration/api/auth',
      ]
      const discovery = (path: string, peer: string, headers?: Record<string, string>) =>
        server.request(
          `${BASE}${path}`,
          { headers },
          {
            incoming: { socket: { remoteAddress: peer } },
          },
        )
      for (const path of paths) {
        // Keep the provider's existing 404s for the issuer root and disabled OIDC metadata.
        const status =
          path === '/.well-known/oauth-authorization-server' ||
          path === '/.well-known/openid-configuration/api/auth'
            ? 404
            : 200
        // Forged IP headers cannot collapse unrelated peers into one bucket.
        for (let count = 0; count < 130; count++)
          expect(
            (
              await discovery(path, testIp(), {
                [CLIENT_IP_HEADER]: '203.0.113.1',
                'x-forwarded-for': '203.0.113.1',
              })
            ).status,
          ).toBe(status)
        const noisyPeer = testIp()
        // Nor may a noisy peer evade its own bucket with forged addresses.
        for (let count = 0; count < 100; count++)
          expect(
            (
              await discovery(path, noisyPeer, {
                [CLIENT_IP_HEADER]: testIp(),
                'x-forwarded-for': testIp(),
              })
            ).status,
          ).toBe(status)
        expect((await discovery(path, noisyPeer)).status).toBe(429)
        expect((await discovery(path, testIp())).status).toBe(status)
        expect((await discovery(path, noisyPeer)).status).toBe(429)
      }
      expect(
        warnings.mock.calls.some((call) =>
          call.some((value) => String(value).includes('could not determine a client IP')),
        ),
      ).toBe(false)
    } finally {
      warnings.mockRestore()
    }
  })
  it('uses a trusted proxy client address for discovery rate limits', async () => {
    const server = app(['10.0.0.7'])
    const path = '/.well-known/oauth-authorization-server/api/auth'
    const discovery = (ip: string) =>
      server.request(
        `${BASE}${path}`,
        {
          headers: { 'x-forwarded-for': ip },
        },
        { incoming: { socket: { remoteAddress: '10.0.0.7' } } },
      )
    for (let count = 0; count < 130; count++) expect((await discovery(testIp())).status).toBe(200)
    const noisyPeer = testIp()
    for (let count = 0; count < 100; count++) expect((await discovery(noisyPeer)).status).toBe(200)
    expect((await discovery(noisyPeer)).status).toBe(429)
    expect((await discovery(testIp())).status).toBe(200)
  })
  it('limits OAuth MCP calls to 120 per consent and advertises when to retry', async () => {
    const s = await session(),
      tokens = await connected(s),
      server = app()
    for (let i = 0; i < 120; i++)
      expect((await server.request(mcpRequest(tokens.access_token))).status).toBe(200)
    const limited = await server.request(mcpRequest(tokens.access_token))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60)
    const other = await session(),
      otherTokens = await connected(other)
    expect((await server.request(mcpRequest(otherTokens.access_token))).status).toBe(200)
  })
  it('renders authorization errors locally for DCR clients, invalid clients and mismatched callbacks', async () => {
    const server = app()
    const registration = await server.request(`${BASE}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unapproved dynamic connector',
        redirect_uris: ['https://phish.invalid/landing'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(registration.status).toBe(201)
    const { client_id: clientId } = (await registration.json()) as { client_id: string }
    const { query } = authorization()
    query.set('client_id', clientId)
    query.set('redirect_uri', 'https://phish.invalid/landing')
    for (const [key, value] of [
      ['response_type', 'token'],
      ['scope', 'admin'],
      ['code_challenge', ''],
      ['prompt', 'none'],
      ['client_id', 'not-a-client'],
      ['redirect_uri', 'https://unregistered.invalid/callback'],
    ]) {
      const invalid = new URLSearchParams(query)
      invalid.set(key as string, value as string)
      const response = await server.request(`${BASE}/api/auth/oauth2/authorize?${invalid}`)
      expect(response.status).toBe(400)
      expect(response.headers.has('location')).toBe(false)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('Unable to connect to Hourmere')
    }
    for (const headers of [{ accept: 'application/json' }, { 'sec-fetch-mode': 'cors' }]) {
      const invalid = new URLSearchParams(query)
      invalid.set('client_id', 'not-a-client')
      const response = await server.request(`${BASE}/api/auth/oauth2/authorize?${invalid}`, {
        headers,
      })
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.has('location')).toBe(false)
    }
    const valid = await server.request(`${BASE}/api/auth/oauth2/authorize?${query}`)
    expect(valid.status).toBe(302)
    expect(new URL(valid.headers.get('location') as string, BASE).pathname).toBe('/oauth/authorize')
  })
  it('binds browser approval to one session, signed request and fixed organization', async () => {
    const s = await session(),
      other = await session(),
      team = await createTestTeam(db, [{ user: s.user, role: 'owner' }])
    const a = await begin(s, team.id)
    const sameUserOtherSession = await session(s.user)
    expect(
      (
        await api('consent', sameUserOtherSession, {
          oauthQuery: a.oauthQuery,
          intentId: a.intentId,
          accept: true,
        })
      ).status,
    ).toBe(409)
    const stranger = await api('consent', other, {
      oauthQuery: a.oauthQuery,
      intentId: a.intentId,
      accept: true,
    })
    expect(stranger.status).toBe(409)
    const info = await api('request', s, { oauthQuery: a.oauthQuery, intentId: a.intentId })
    expect(info.status).toBe(200)
    expect(
      ((await info.json()) as { selectedOrganization: { id: string } }).selectedOrganization.id,
    ).toBe(team.id)
    const b = await begin(s)
    expect(
      (await api('consent', s, { oauthQuery: b.oauthQuery, intentId: a.intentId, accept: true }))
        .status,
    ).toBe(409)
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: s.user.principal.organization.id })
      .where('id', '=', s.sessionId)
      .execute()
    const url = await approved(s, a)
    const token = await exchange(a, url.searchParams.get('code') as string)
    expect(token.status).toBe(200)
    const tokens = (await token.json()) as { access_token: string }
    const result = await createMcpOAuthResolver({ auth, db, publicUrl: BASE })(
      mcpRequest(tokens.access_token),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.principal.organization.id).toBe(team.id)
    expect(
      (await api('consent', s, { oauthQuery: a.oauthQuery, intentId: a.intentId, accept: true }))
        .status,
    ).toBe(409)
  })
  it('rejects cross-origin/anonymous/API-key consent before consuming body, tampering and forbidden organizations', async () => {
    const s = await session(),
      a = await begin(s),
      headers = new Headers(s.headers)
    headers.set('origin', 'https://evil.test')
    headers.set('content-type', 'application/json')
    const cross = await app().request(`${BASE}/api/v1/mcp-oauth/consent`, {
      method: 'POST',
      headers,
      body: 'not-json',
    })
    expect(cross.status).toBe(403)
    expect(
      (
        await app().request(`${BASE}/api/v1/mcp-oauth/consent`, {
          method: 'POST',
          body: 'not-json',
        })
      ).status,
    ).toBe(401)
    const q = new URLSearchParams(a.oauthQuery)
    q.set('redirect_uri', 'https://evil.test/callback')
    expect((await api('request', s, { oauthQuery: q.toString() })).status).toBe(400)
    expect((await api('request', s, { oauthQuery: a.oauthQuery + '&client_id=evil' })).status).toBe(
      400,
    )
    expect(
      (await api('select', s, { oauthQuery: queryOf(a.selection), organizationId: randomUUID() }))
        .status,
    ).toBe(403)
    const direct = await request('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: new Headers({
        ...Object.fromEntries(s.headers),
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ oauth_query: a.oauthQuery, accept: true }),
    })
    expect(direct.status >= 400).toBe(true)
  })
  it('denies once, expires intents, and checks membership again at approval', async () => {
    const s = await session(),
      a = await begin(s)
    const denial = await approved(s, a, false)
    expect(denial.searchParams.get('error')).toBe('access_denied')
    expect(denial.searchParams.has('code')).toBe(false)
    const b = await begin(s)
    await db
      .updateTable('mcp_oauth_intents')
      .set({ expires_at: new Date(0) })
      .where('id', '=', b.intentId)
      .execute()
    expect(
      (await api('consent', s, { oauthQuery: b.oauthQuery, intentId: b.intentId, accept: true }))
        .status,
    ).toBe(409)
    const team = await createTestTeam(db, [{ user: s.user, role: 'owner' }]),
      c = await begin(s, team.id)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', s.user.id)
      .execute()
    expect(
      (await api('consent', s, { oauthQuery: c.oauthQuery, intentId: c.intentId, accept: true }))
        .status,
    ).toBe(403)
  })
  it('requires PKCE/resource, uses authorization codes once, and rejects token tampering', async () => {
    const s = await session(),
      a = await begin(s),
      url = await approved(s, a),
      code = url.searchParams.get('code') as string
    expect((await exchange(a, code, { resource: 'https://other.test/mcp' })).status >= 400).toBe(
      true,
    )
    const b = await begin(s),
      u = await approved(s, b)
    expect(
      (
        await exchange(b, u.searchParams.get('code') as string, {
          code_verifier: randomBytes(32).toString('base64url'),
        })
      ).status >= 400,
    ).toBe(true)
    const c = await begin(s),
      v = await approved(s, c),
      valid = await exchange(c, v.searchParams.get('code') as string)
    expect(valid.status).toBe(200)
    const tokens = (await valid.json()) as { access_token: string }
    expect((await exchange(c, v.searchParams.get('code') as string)).status >= 400).toBe(true)
    const pieces = tokens.access_token.split('.')
    pieces[1] = Buffer.from(
      JSON.stringify({ sub: s.user.id, aud: `${BASE}/mcp`, scope: MCP_OAUTH_SCOPE }),
    ).toString('base64url')
    expect((await app().request(mcpRequest(pieces.join('.')))).status).toBe(401)
    const missing = authorization()
    missing.query.delete('code_challenge')
    const missingResult = await request(`/api/auth/oauth2/authorize?${missing.query}`)
    expect(
      missingResult.status >= 400 ||
        new URL(missingResult.headers.get('location') as string, BASE).searchParams.has('error'),
    ).toBe(true)
  })
  it('uses native OAuth callers on MCP only, then rejects revoked tokens and old codes even after reconnecting', async () => {
    const s = await session(),
      tokens = await connected(s),
      pending = await begin(s),
      oldCode = (await approved(s, pending)).searchParams.get('code') as string
    const good = await app().request(mcpRequest(tokens.access_token))
    expect(good.status).toBe(200)
    expect((await good.text()).includes('"kind":"oauth"')).toBe(true)
    const rest = await app().request(`${BASE}/api/v1/me`, {
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        cookie: s.headers.get('cookie') as string,
      },
    })
    expect(rest.status).toBe(401)
    const list = await api('connections', s, undefined, 'GET')
    const data = (await list.json()) as { data: { id: string }[] }
    expect(data.data.length).toBe(1)
    const other = await session()
    expect((await api(`connections/${data.data[0]?.id}`, other, undefined, 'DELETE')).status).toBe(
      404,
    )
    expect((await api(`connections/${data.data[0]?.id}`, s, undefined, 'DELETE')).status).toBe(200)
    const retired = await db
      .selectFrom('auth.oauthRefreshToken')
      .select(['revoked', 'rotationReplayResponse'])
      .where('userId', '=', s.user.id)
      .execute()
    expect(retired.length).toBeGreaterThan(0)
    expect(
      retired.every((row) => row.revoked !== null && row.rotationReplayResponse === null),
    ).toBe(true)
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
    const refreshed = await request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT,
        refresh_token: tokens.refresh_token,
        resource: `${BASE}/mcp`,
      }),
    })
    expect(refreshed.status >= 400).toBe(true)
    const again = await connected(s)
    expect((await app().request(mcpRequest(again.access_token))).status).toBe(200)
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
    expect((await exchange(pending, oldCode)).status >= 400).toBe(true)
  })
  it('disables native consent mutation endpoints so they cannot bypass grant revocation', async () => {
    const s = await session(),
      tokens = await connected(s),
      list = await api('connections', s, undefined, 'GET')
    const connections = (await list.json()) as { data: { id: string }[] },
      id = connections.data[0]?.id as string
    const headers = new Headers(s.headers)
    headers.set('content-type', 'application/json')
    for (const endpoint of ['delete-consent', 'update-consent'])
      for (const suffix of ['', '/']) {
        const response = await request(`/api/auth/oauth2/${endpoint}${suffix}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id, update: { scopes: ['offline_access'] } }),
        })
        expect(response.status).toBe(404)
      }
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(200)
    expect((await api(`connections/${id}`, s, undefined, 'DELETE')).status).toBe(200)
    await connected(s)
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
  })
  it('keeps offline access usable after browser expiry and sign-out, including rotated tokens', async () => {
    for (const end of ['expiry', 'sign-out']) {
      const s = await session(),
        tokens = await connected(s)
      if (end === 'expiry')
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', s.sessionId)
          .execute()
      else
        expect(
          (await request('/api/auth/sign-out', { method: 'POST', headers: s.headers })).status,
        ).toBe(200)
      expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(200)
      let previous = tokens.refresh_token
      for (let rotation = 0; rotation < 2; rotation++) {
        const refresh = await request('/api/auth/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT,
            refresh_token: previous,
            resource: `${BASE}/mcp`,
          }),
        })
        expect(refresh.status).toBe(200)
        const next = (await refresh.json()) as { access_token: string; refresh_token: string }
        expect((await app().request(mcpRequest(next.access_token))).status).toBe(200)
        previous = next.refresh_token
      }
    }
  })
  it('preserves the original consent deadline through rotation and refuses the expired connection', async () => {
    const s = await session(),
      tokens = await connected(s)
    const consentDate = new Date(Date.now() - 30 * 86400000 + 60000)
    const deadline = new Date(consentDate.getTime() + 30 * 86400000)
    await db
      .updateTable('auth.oauthConsent')
      .set({ createdAt: consentDate })
      .where('userId', '=', s.user.id)
      .execute()
    const refresh = (token: string) =>
      request('/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT,
          refresh_token: token,
          resource: `${BASE}/mcp`,
        }),
      })
    const rotated = await refresh(tokens.refresh_token)
    expect(rotated.status).toBe(200)
    const next = (await rotated.json()) as { access_token: string; refresh_token: string }
    const row = await db
      .selectFrom('auth.oauthRefreshToken')
      .select('expiresAt')
      .where('userId', '=', s.user.id)
      .where('revoked', 'is', null)
      .where('rotatedAt', 'is', null)
      .executeTakeFirstOrThrow()
    expect(new Date(row.expiresAt).getTime()).toBe(deadline.getTime())
    await db
      .updateTable('auth.oauthConsent')
      .set({ createdAt: new Date(Date.now() - 30 * 86400000 - 1000) })
      .where('userId', '=', s.user.id)
      .execute()
    expect((await refresh(next.refresh_token)).status).toBe(400)
    expect((await app().request(mcpRequest(next.access_token))).status).toBe(401)
  })
  it('starts a fresh consent lifetime on normal reconnect after expiry and retires the old generation', async () => {
    const s = await session(),
      tokens = await connected(s),
      pending = await begin(s)
    const oldCode = (await approved(s, pending)).searchParams.get('code') as string
    const oldConsent = await db
      .selectFrom('auth.oauthConsent')
      .select(['id', 'referenceId'])
      .where('userId', '=', s.user.id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('auth.oauthConsent')
      .set({ createdAt: new Date(Date.now() - 30 * 86400000 - 1000) })
      .where('id', '=', oldConsent.id)
      .execute()
    const reconnect = await begin(s),
      approvedUrl = await approved(s, reconnect)
    const response = await exchange(reconnect, approvedUrl.searchParams.get('code') as string)
    expect(response.status).toBe(200)
    const current = (await response.json()) as { access_token: string }
    const consent = await db
      .selectFrom('auth.oauthConsent')
      .select(['referenceId', 'createdAt'])
      .where('userId', '=', s.user.id)
      .executeTakeFirstOrThrow()
    expect(consent.referenceId === oldConsent.referenceId).toBe(false)
    expect(Date.now() - new Date(consent.createdAt).getTime()).toBeLessThan(60000)
    expect((await app().request(mcpRequest(current.access_token))).status).toBe(200)
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
    expect((await exchange(pending, oldCode)).status >= 400).toBe(true)
    const retired = await db
      .selectFrom('auth.oauthRefreshToken')
      .select('revoked')
      .where('userId', '=', s.user.id)
      .where('referenceId', '=', oldConsent.referenceId)
      .execute()
    expect(retired.length).toBeGreaterThan(0)
    expect(retired.every((row) => row.revoked !== null)).toBe(true)
  })
  it('keeps session-bound access tied to a live browser when offline access was not approved', async () => {
    const s = await session(),
      a = await begin(s, s.user.principal.organization.id, { scope: MCP_OAUTH_SCOPE })
    const url = await approved(s, a),
      response = await exchange(a, url.searchParams.get('code') as string)
    expect(response.status).toBe(200)
    const tokens = (await response.json()) as { access_token: string }
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(200)
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', s.sessionId)
      .execute()
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
  })
  it.each(
    ['membership', 'email', 'offline-consent'].flatMap((change) =>
      ['initial', 'replay', 'rotated'].map((mode) => [change, mode] as const),
    ),
  )('returns invalid_grant for %s during %s refresh', async (change, mode) => {
    const s = await session(),
      team = await createTestTeam(db, [{ user: s.user, role: 'owner' }]),
      tokens = await connected(s, team.id)
    let refreshToken = tokens.refresh_token
    const refresh = () =>
      request('/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT,
          refresh_token: refreshToken,
          resource: `${BASE}/mcp`,
        }),
      })
    if (mode !== 'initial') {
      const first = await refresh()
      expect(first.status).toBe(200)
      const rotated = (await first.json()) as { refresh_token: string }
      if (mode === 'rotated') refreshToken = rotated.refresh_token
    }
    if (change === 'membership')
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', team.id)
        .where('userId', '=', s.user.id)
        .execute()
    else if (change === 'email')
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', s.user.id)
        .execute()
    else
      await db
        .updateTable('auth.oauthConsent')
        .set({ scopes: JSON.stringify([MCP_OAUTH_SCOPE]) })
        .where('userId', '=', s.user.id)
        .execute()
    const refreshState = async () =>
      JSON.stringify(
        await db
          .selectFrom('auth.oauthRefreshToken')
          .selectAll()
          .where('userId', '=', s.user.id)
          .orderBy('id')
          .execute(),
      )
    const before = await refreshState()
    const denied = await refresh()
    expect(denied.status).toBe(400)
    const error = (await denied.json()) as {
      error: string
      access_token?: string
      refresh_token?: string
    }
    expect(error.error).toBe('invalid_grant')
    expect(error.access_token === undefined && error.refresh_token === undefined).toBe(true)
    expect((await refreshState()) === before).toBe(true)
  })
  it('immediately rejects removed members and disabled OAuth clients', async () => {
    const s = await session(),
      team = await createTestTeam(db, [{ user: s.user, role: 'owner' }]),
      tokens = await connected(s, team.id)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', s.user.id)
      .execute()
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
    const removedRefresh = await request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT,
        refresh_token: tokens.refresh_token,
        resource: `${BASE}/mcp`,
      }),
    })
    expect(removedRefresh.status >= 400).toBe(true)
    const personal = await connected(s)
    await db
      .updateTable('auth.oauthClient')
      .set({ disabled: true })
      .where('clientId', '=', CLIENT)
      .execute()
    try {
      expect((await app().request(mcpRequest(personal.access_token))).status).toBe(401)
    } finally {
      await db
        .updateTable('auth.oauthClient')
        .set({ disabled: false })
        .where('clientId', '=', CLIENT)
        .execute()
    }
  })
  it('rejects DPoP-bound tokens without matching proof and persists proof replay detection across resolvers', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
      jwk = key.publicKey.export({ format: 'jwk' })
    function proof(url: string, accessToken?: string, method = 'POST') {
      const header = Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk })).toString(
        'base64url',
      )
      const payload = Buffer.from(
        JSON.stringify({
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          htm: method,
          htu: url,
          ...(accessToken
            ? { ath: createHash('sha256').update(accessToken).digest('base64url') }
            : {}),
        }),
      ).toString('base64url')
      const input = `${header}.${payload}`
      return `${input}.${sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    }
    const s = await session(),
      a = await begin(s),
      u = await approved(s, a)
    const response = await exchange(
      a,
      u.searchParams.get('code') as string,
      {},
      { dpop: proof(`${BASE}/api/auth/oauth2/token`) },
    )
    expect(response.status).toBe(200)
    const tokens = (await response.json()) as { access_token: string; token_type: string }
    expect(tokens.token_type.toLowerCase()).toBe('dpop')
    expect((await app().request(mcpRequest(tokens.access_token))).status).toBe(401)
    const p = proof(`${BASE}/mcp`, tokens.access_token),
      req = mcpRequest(tokens.access_token, {
        authorization: `DPoP ${tokens.access_token}`,
        dpop: p,
      })
    expect((await app().request(req)).status).toBe(200)
    expect(
      (
        await app().request(
          mcpRequest(tokens.access_token, {
            authorization: `DPoP ${tokens.access_token}`,
            dpop: p,
          }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app().request(
          mcpRequest(tokens.access_token, {
            authorization: `DPoP ${tokens.access_token}`,
            dpop: proof(`${BASE}/wrong`, tokens.access_token),
          }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app().request(
          mcpRequest(
            tokens.access_token,
            {
              authorization: `DPoP ${tokens.access_token}`,
              dpop: proof(`${BASE}/mcp/`, tokens.access_token),
            },
            '/mcp/',
          ),
        )
      ).status,
    ).toBe(200)
  })
  it('rotates refresh tokens, encrypts retry responses and keeps an invalid refresh resource refused', async () => {
    const s = await session(),
      tokens = await connected(s)
    const refresh = (resource = `${BASE}/mcp`) =>
      request('/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT,
          refresh_token: tokens.refresh_token,
          resource,
        }),
      })
    expect((await refresh('https://other.test/mcp')).status >= 400).toBe(true)
    const first = await refresh()
    expect(first.status).toBe(200)
    const next = (await first.json()) as { access_token: string; refresh_token: string }
    expect(next.refresh_token === tokens.refresh_token).toBe(false)
    const retry = await refresh()
    expect(retry.status).toBe(200)
    const repeated = (await retry.json()) as { access_token: string; refresh_token: string }
    expect(repeated.refresh_token === next.refresh_token).toBe(true)
    const rows = await db
      .selectFrom('auth.oauthRefreshToken')
      .select(['token', 'rotationReplayResponse'])
      .where('userId', '=', s.user.id)
      .execute()
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(
        row.token.includes(tokens.refresh_token) || row.token.includes(next.refresh_token),
      ).toBe(false)
      if (row.rotationReplayResponse) {
        expect(row.rotationReplayResponse.includes(next.refresh_token)).toBe(false)
        expect(row.rotationReplayResponse.startsWith('{')).toBe(false)
      }
    }
    expect(rows.some((r) => r.rotationReplayResponse !== null)).toBe(true)
  })
  it('serializes duplicate approvals and cleans only expired correlation records', async () => {
    const s = await session(),
      a = await begin(s)
    const results = await Promise.all([
      api('consent', s, { oauthQuery: a.oauthQuery, intentId: a.intentId, accept: true }),
      api('consent', s, { oauthQuery: a.oauthQuery, intentId: a.intentId, accept: true }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const expiredId = await db
      .insertInto('mcp_oauth_intents')
      .values({
        user_id: s.user.id,
        session_id: s.sessionId,
        organization_id: s.user.principal.organization.id,
        grant_id: randomUUID(),
        request_hash: randomBytes(32),
        expires_at: new Date(0),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const job = mcpOAuthCleanupJob(db)
    await job.handler({}, { id: randomUUID(), attempt: 1, signal: new AbortController().signal })
    expect(
      await db
        .selectFrom('mcp_oauth_intents')
        .select('id')
        .where('id', '=', expiredId.id)
        .execute(),
    ).toHaveLength(0)
    expect(
      await db.selectFrom('mcp_oauth_intents').select('id').where('id', '=', a.intentId).execute(),
    ).toHaveLength(1)
  })
})
