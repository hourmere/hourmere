import '@hono/zod-openapi'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http'
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
import type { MailMessage } from '@hourmere/mail'
import { leaveTeamMember } from '@hourmere/scheduling'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { mcpOAuthRoutes } from './mcp/oauth.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { closeServer } from './shutdown.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const bootstrap = process.env.DATABASE_URL
const secret = 'synthetic-revocation-oauth-secret-at-least-thirty-two-characters'
const callback = 'https://connector.test/callback'
const signup = { mode: 'closed', allowedDomains: [] } as const
let nextAddress = 0
let transportAddress = '198.18.0.1'
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
  const outbox: MailMessage[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'revoke_oauth' })
    db = createDb(owned.pool)
    // Reuse one auth pool and its two lock connections across every scenario.
    pool = createAuthPool(owned.url, signup)
    server = createServer((req, res) => {
      getRequestListener(mounted.fetch)(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await application()
  })

  afterAll(async () => {
    if (server) await closeServer(server)
    await pool?.end()
    await owned?.drop()
  })

  async function application() {
    const auth: Auth = createAuth({
      db,
      pool,
      baseURL: base,
      secret,
      signup,
      mcpOAuth: true,
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
      mailer: { send: async (message) => void outbox.push(message) },
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
        mcpOAuthRoutes({ auth, db, publicUrl: base }),
        memberLeaveRoutes({ db }),
        memberRemovalRoutes({ db }),
      ],
      mcp: mcpEndpoint({
        tools: [whoamiTool],
        oauth: {
          resolve: createMcpOAuthResolver({ auth, db, publicUrl: base }),
          handler: auth.handler,
        },
      }),
    })
  }

  async function session(user: TestUser, organizationId: string) {
    const before = outbox.length
    const requested = await http(`${base}/api/auth/sign-in/magic-link`, {
      headers: { origin: base },
      body: { email: user.email, callbackURL: '/' },
    })
    expect(requested.status).toBe(200)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const mail = outbox.slice(before).find((message) => message.to === user.email)
    const link = mail?.text.match(/https?:\/\/\S+/)?.[0]
    expect(link !== undefined).toBe(true)
    const verification = await pressConfirmButton(mounted, new URL(link as string))
    const verified = await http(verification.href)
    expect(verified.status).toBe(302)
    const cookie = (verified.headers['set-cookie'] ?? [])
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(cookie.includes('better-auth.session_token=')).toBe(true)
    const headers = { cookie, origin: base }
    const activated = await http(`${base}/api/auth/organization/set-active`, {
      headers,
      body: { organizationId },
    })
    expect(activated.status).toBe(200)
    return { headers }
  }

  async function fixture() {
    transportAddress = `198.18.${Math.floor(++nextAddress / 250)}.${(nextAddress % 250) + 1}`
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

  async function depart(f: Fixture, action: 'leave' | 'remove', native: boolean) {
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', f.member.id)
      .where('organizationId', '=', f.team.id)
      .executeTakeFirstOrThrow()
    const path = native
      ? `/api/auth/organization/${action === 'leave' ? 'leave' : 'remove-member'}`
      : action === 'leave'
        ? `/api/v1/teams/${f.team.id}/leave`
        : `/api/v1/team/members/${f.member.id}/removal`
    const body = native
      ? {
          organizationId: f.team.id,
          ...(action === 'remove' ? { memberIdOrEmail: membership.id } : {}),
        }
      : action === 'leave'
        ? {}
        : { teamId: f.team.id }
    const response = await http(`${base}${path}`, {
      headers: {
        ...(action === 'leave' ? f.memberSession.headers : f.ownerSession.headers),
        'x-expected-organization-id': f.team.id,
      },
      body,
    })
    expect(response.status).toBe(200)
    const remainingMembership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', f.member.id)
      .where('organizationId', '=', f.team.id)
      .executeTakeFirst()
    expect(remainingMembership === undefined).toBe(true)
  }

  const invalidGrant = (response: HttpResponse) => {
    expect(response.status).toBe(400)
    expect(json<{ error: string }>(response).error).toBe('invalid_grant')
  }

  async function revocationScenario(action: 'leave' | 'remove', native: boolean) {
    const f = await fixture()
    const tokens = await connect(f)
    const surviving = await connect(f, f.otherTeam.id)
    await assertOrganization(tokens.access_token, f.team.id)
    // Rotate before departure, then exercise both ordinary refresh and lost-response replay.
    const rotated = await refresh(f, tokens.refresh_token)
    expect(rotated.status).toBe(200)
    const next = json<{ access_token: string; refresh_token: string }>(rotated)
    const codeAuthorization = await begin(f)
    const code = await approve(f, codeAuthorization)
    const pending = await begin(f)
    await depart(f, action, native)
    return { f, tokens, next, codeAuthorization, code, pending, surviving }
  }
  async function assertRevoked(action: 'leave' | 'remove', native: boolean) {
    const scenario = await revocationScenario(action, native)
    const { f, tokens, next, codeAuthorization, code, pending, surviving } = scenario
    expect((await mcp(tokens.access_token, f.memberSession.headers.cookie)).status).toBe(401)
    expect((await mcp(next.access_token)).status).toBe(401)
    invalidGrant(await refresh(f, next.refresh_token))
    invalidGrant(await refresh(f, tokens.refresh_token))
    invalidGrant(await exchange(f, codeAuthorization, code))
    const consent = await post('/api/v1/mcp-oauth/consent', f.memberSession, {
      oauthQuery: pending.oauthQuery,
      intentId: pending.intentId,
      accept: true,
    })
    expect(consent.status).toBe(403)
    const newSelection = await post('/api/v1/mcp-oauth/select', f.memberSession, {
      oauthQuery: pending.oauthQuery,
      organizationId: f.team.id,
    })
    expect(newSelection.status).toBe(403)
    await assertOrganization(surviving.access_token, f.otherTeam.id)
    const renewed = await refresh(f, surviving.refresh_token)
    expect(renewed.status).toBe(200)
    await assertOrganization(json<{ access_token: string }>(renewed).access_token, f.otherTeam.id)
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

  async function bindingScenario() {
    const f = await fixture()
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

  async function assertBinding() {
    const { f, grant, refreshedToken } = await bindingScenario()
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

  it.each([
    { action: 'leave', native: false, path: 'REST leave' },
    { action: 'remove', native: false, path: 'REST removal' },
    { action: 'leave', native: true, path: 'native organization/leave' },
    { action: 'remove', native: true, path: 'native organization/remove-member' },
  ] as const)(
    'refuses issued access/refresh tokens, replay, code and pending grant after $path',
    async ({ action, native }) => {
      await assertRevoked(action, native)
    },
    30_000,
  )
  it('keeps an existing OAuth grant in its consented team after a web switch', async () => {
    await assertBinding()
  }, 30_000)
})
