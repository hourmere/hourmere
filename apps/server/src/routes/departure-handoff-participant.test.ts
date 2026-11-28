import '@hono/zod-openapi'
import { randomBytes } from 'node:crypto'
import {
  type ApiKeyScope,
  type CallerResolver,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { departureHandoffTokenDigest } from '@hourmere/scheduling/departure-handoff-delivery'
import { departureHandoffStore } from '@hourmere/scheduling/departure-handoff-store'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { signTestMcpAccessToken } from '../../../../packages/auth/src/testing.ts'
import {
  createHandoffTestFixture,
  HANDOFF_NOW,
  handoffTestRecords,
} from '../../../../packages/scheduling/src/departure-handoff-apply-test-fixture.ts'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { type McpEndpointOptions, mcpEndpoint } from '../mcp/endpoint.ts'
import { productRoutes, productTools } from '../server.ts'

const publicUrl = 'https://handoff-participant.example.test'
const path = '/api/v1/booking-handoffs'
const authSecret = 'synthetic-participant-handoff-auth-secret'
const tools = { offer: 'read_booking_handoff_offer', answer: 'answer_booking_handoff_offer' }
type Action = keyof typeof tools
type Input = Record<string, unknown>
const unavailable = { error: 'handoff_offer_unavailable' }
const unauthenticated: CallerResolver = async () => ({
  ok: false,
  error: 'unauthorized',
  setCookie: [],
})

function appFor(
  db: Db,
  {
    enabled = true,
    resolveCaller = unauthenticated,
    oauth,
  }: {
    enabled?: boolean
    resolveCaller?: CallerResolver
    oauth?: McpEndpointOptions['oauth']
  } = {},
) {
  const handoffs = { store: departureHandoffStore, now: () => HANDOFF_NOW }
  const wiring = { db, ...(enabled && { departureHandoffs: handoffs }) }
  return createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    routes: productRoutes({
      ...wiring,
      publicUrl,
      socialProviders: {},
      invitationMailLimits: { secret: 'synthetic-handoff-transport-tests' },
    }),
    mcp: mcpEndpoint({ tools: productTools(wiring), ...(oauth && { oauth }) }),
  })
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

function expectPrivate(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
}

const fromIp = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })
const bearer = (value: string) => ({ authorization: `Bearer ${value}` })

async function rpc(
  app: ReturnType<typeof appFor>,
  method: string,
  params: Input,
  headers: Record<string, string>,
  ip?: string,
) {
  const response = await app.request(
    '/mcp',
    post(
      { jsonrpc: '2.0', id: 1, method, params },
      { accept: 'application/json, text/event-stream', ...headers },
    ),
    ip ? fromIp(ip) : undefined,
  )
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const text = await response.text()
  const event = text.split('\n').find((line) => line.startsWith('data: '))
  const message = JSON.parse(event ? event.slice(6) : text)
  if (!response.ok) return { status: response.status, body: message, text }
  expect(message.error).toBeUndefined()
  const result = message.result
  const body = result.isError
    ? JSON.parse(result.content[0].text)
    : (result.structuredContent ?? result)
  return { status: response.status, body, text }
}

const call = (
  app: ReturnType<typeof appFor>,
  action: Action,
  input: Input,
  headers: Record<string, string>,
  ip?: string,
) => rpc(app, 'tools/call', { name: tools[action], arguments: input }, headers, ip)

describe('participant handoff transport privacy', () => {
  it('advertises that answering a handoff offer is non-idempotent', () => {
    const answer = productTools({ db: {} as Db }).find(
      ({ name }) => name === 'answer_booking_handoff_offer',
    )
    expect(answer?.annotations.idempotentHint).toBe(false)
  })

  it('hard-disables both operations before reading input', async () => {
    const app = appFor({} as Db, { enabled: false })
    for (const action of ['offer', 'answer']) {
      const res = await app.request(`${path}/${action}`, { method: 'POST' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(unavailable)
      expectPrivate(res)
    }
  })

  it('shares the trusted IP rate limit across both operations and counts invalid requests', async () => {
    const app = appFor({} as Db)
    for (let i = 0; i < 30; i++) {
      const res = await app.request(
        path + (i % 2 ? '/offer' : '/answer'),
        post({}, { 'x-forwarded-for': `203.0.113.${i + 1}` }),
        fromIp('2001:db8::1'),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_request' })
    }
    const res = await app.request(`${path}/answer`, post({}), fromIp('2001:db8::2'))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expectPrivate(res)
    const other = await app.request(`${path}/offer`, post({}), fromIp('2001:db8:0:1::1'))
    expect(other.status).toBe(400)
  })

  it('keeps supplied capability text out of validation responses, request logs and diagnostics', async () => {
    const sentinel = randomBytes(32).toString('base64url')
    const app = appFor(
      {
        transaction: () => {
          throw new Error(sentinel)
        },
      } as unknown as Db,
      {
        resolveCaller: async () => ({
          ok: true,
          principal: {
            kind: 'api_key',
            apiKeyId: 'synthetic-key-id',
            apiKeyScope: 'bookings',
            user: { id: 'synthetic-user-id', name: 'User', email: 'user@example.test' },
            organization: { id: 'synthetic-team-id', name: 'Team', slug: 'team', personal: false },
          },
          setCookie: [],
        }),
      },
    )
    const line = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const invalid = await app.request(`${path}/offer?token=${sentinel}`, post({ [sentinel]: 1 }))
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'invalid_request' })
      expectPrivate(invalid)
      const missing = await app.request(`${path}/${sentinel}`, post({}))
      expect(missing.status).toBe(404)
      expectPrivate(missing)
      const validShape = `00000000-0000-4000-8000-000000000001.${sentinel}`
      const failure = await app.request(`${path}/offer`, post({ token: validShape }))
      expect(failure.status).toBe(500)
      expect(await failure.json()).toEqual({ error: 'internal_error' })
      expectPrivate(failure)
      const headers = bearer('hm_synthetic')
      const mcpInvalid = await call(app, 'offer', { token: validShape, [sentinel]: true }, headers)
      expect(mcpInvalid.body).toMatchObject({ error: 'invalid_request' })
      const mcpFailure = await call(app, 'offer', { token: validShape }, headers)
      expect(mcpFailure.body).toEqual({ error: 'internal_error' })
      expect((mcpInvalid.text + mcpFailure.text).includes(sentinel)).toBe(false)
      expect(JSON.stringify(line.mock.calls).includes(sentinel)).toBe(false)
      expect(diagnostic).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(diagnostic.mock.calls).includes(sentinel)).toBe(false)
    } finally {
      line.mockRestore()
      diagnostic.mockRestore()
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)('participant handoff interfaces on PostgreSQL', () => {
  let database: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let resolveCaller: CallerResolver

  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'handoff_http',
    })
    db = createDb(database.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(database.url, signup)
    auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret: authSecret,
      signup,
      mcpOAuth: true,
      mailer: {
        send: async () => {
          throw new Error('Unexpected mail in handoff interface test')
        },
      },
    })
    resolveCaller = createCallerResolver({ auth, db })
  })
  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })

  const oauth = () => ({
    resolve: createMcpOAuthResolver({ auth, db, publicUrl }),
    handler: auth.handler,
  })

  async function setup() {
    const f = await createHandoffTestFixture(db)
    await handoffTestRecords(db).offer(
      f.ctx,
      f.input,
      { departingUserId: f.departing.id },
      (offer) => ({ ...offer, approvals: [] }),
    )
    const guest = await db
      .selectFrom('departure_handoff_recipients')
      .select('id')
      .where('source_booking_id', '=', f.booking.id)
      .where('recipient_key', '=', 'guest@example.test')
      .executeTakeFirstOrThrow()
    const secret = randomBytes(32).toString('base64url')
    const token = `${guest.id}.${secret}`
    const forgedToken = `${guest.id}.${randomBytes(32).toString('base64url')}`
    await db
      .updateTable('departure_handoff_recipients')
      .set({ token_digest: departureHandoffTokenDigest(guest.id, secret) })
      .where('id', '=', guest.id)
      .execute()

    const issueKey = async (scope: ApiKeyScope) =>
      (
        await auth.api.createApiKey({
          body: { userId: f.owner.id, metadata: { scope, organizationId: f.team.id } },
        })
      ).key
    const readOnly = await issueKey('read')
    const bookings = await issueKey('bookings')
    const full = await issueKey('full')
    const app = appFor(db, { resolveCaller, oauth: oauth() })
    const rest = async (action: Action, input: Input, headers: Record<string, string> = {}) => {
      const response = await app.request(`${path}/${action}`, post(input, headers))
      expectPrivate(response)
      const text = await response.text()
      expect(text.includes(token) || text.includes(forgedToken)).toBe(false)
      return { status: response.status, body: JSON.parse(text) }
    }
    const mcp = async (action: Action, input: Input, headers = bearer(bookings)) => {
      const result = await call(app, action, input, headers)
      expect(result.text.includes(token) || result.text.includes(forgedToken)).toBe(false)
      return { status: result.status, body: result.body }
    }
    const cli = async (action: Action, input: Input, apiKey = bookings) => {
      let stdout = ''
      let stderr = ''
      const status = await runCli({
        argv: ['booking-handoff', action, '--input', '-'],
        env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: apiKey },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (value) => {
          stdout = value
        },
        stderr: (value) => {
          stderr = value
        },
        fetch: async (input, options) => app.request(input, options),
      })
      const text = stdout + stderr
      expect(text.includes(token) || text.includes(forgedToken)).toBe(false)
      return { status, body: JSON.parse(text) }
    }
    const decision = async () =>
      (
        await db
          .selectFrom('departure_handoff_recipients')
          .select('decision')
          .where('id', '=', guest.id)
          .executeTakeFirstOrThrow()
      ).decision
    const sourceStatus = async () =>
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', f.booking.id)
          .executeTakeFirstOrThrow()
      ).status
    return {
      ...f,
      app,
      token,
      forgedToken,
      readOnly,
      bookings,
      full,
      rest,
      mcp,
      cli,
      decision,
      sourceStatus,
    }
  }

  it('keeps REST authority in the body capability and rejects invalid bearers without cookie fallback', async () => {
    const f = await setup()
    const active = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { secret: authSecret, publicUrl },
        {
          userId: f.owner.id,
          organizationId: f.team.id,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const cookie = active.cookie.split(';', 1)[0] as string
    const browser = { cookie }
    const actualCaller = await resolveCaller(new Headers(browser))
    expect(actualCaller).toMatchObject({
      ok: true,
      principal: { kind: 'session', sessionId: active.id },
    })

    const answer = { token: f.token, version: 1, decision: 'accept' }
    expect(await f.rest('offer', { token: f.forgedToken }, browser)).toEqual({
      status: 404,
      body: unavailable,
    })
    expect(await f.rest('offer', { token: f.manageToken }, bearer(f.full))).toEqual({
      status: 404,
      body: unavailable,
    })
    expect(await f.rest('answer', { ...answer, token: f.forgedToken }, bearer(f.bookings))).toEqual(
      {
        status: 404,
        body: unavailable,
      },
    )
    expect(await f.rest('answer', answer, { ...browser, ...bearer('hm_invalid') })).toMatchObject({
      status: 401,
      body: { error: 'unauthorized' },
    })
    expect(await f.rest('answer', answer, bearer(f.readOnly))).toMatchObject({
      status: 403,
      body: { error: 'insufficient_scope' },
    })
    const terms = await f.rest('offer', { token: f.token })
    expect(terms).toMatchObject({ status: 200, body: { role: 'guest', version: 1, answers: [] } })
    expect(await f.rest('offer', { token: f.token }, bearer(f.readOnly))).toEqual(terms)
    expect(await f.decision()).toBeNull()

    const query = await f.app.request(`${path}/offer?token=${f.token}`, post({}))
    expect(query.status).toBe(400)
    expectPrivate(query)
    expect(await f.rest('answer', answer)).toEqual({ status: 200, body: { decision: 'accept' } })
    expect(await f.rest('offer', { token: f.token }, browser)).toEqual({
      status: 404,
      body: unavailable,
    })
    expect(await f.sourceStatus()).toBe('confirmed')

    const cookieOnlyMcp = await call(f.app, 'offer', { token: f.token }, browser)
    expect(cookieOnlyMcp).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
  })

  it.each(['mcp', 'cli'] as const)(
    'uses the same capability, version and neutral replay response through %s',
    async (surface) => {
      const f = await setup()
      const invoke = (action: Action, input: Input, key: string) =>
        surface === 'mcp' ? f.mcp(action, input, bearer(key)) : f.cli(action, input, key)
      const success = surface === 'mcp' ? 200 : 0
      const failure = surface === 'mcp' ? 200 : 1
      const read = { token: f.token }
      const answer = { ...read, version: 1, decision: 'decline' }
      expect(await invoke('offer', { token: f.forgedToken }, f.full)).toEqual({
        status: failure,
        body: expect.objectContaining(unavailable),
      })
      const terms = await f.rest('offer', read)
      expect(await invoke('offer', read, f.readOnly)).toEqual({ status: success, body: terms.body })
      expect(await invoke('answer', answer, f.readOnly)).toMatchObject({
        status: failure,
        body: { error: 'insufficient_scope' },
      })
      expect(await invoke('answer', { ...answer, version: 2 }, f.bookings)).toMatchObject({
        status: failure,
        body: unavailable,
      })
      expect(await f.decision()).toBeNull()
      expect(await invoke('answer', answer, f.bookings)).toEqual({
        status: success,
        body: { decision: 'decline' },
      })
      expect(await invoke('answer', answer, f.full)).toMatchObject({
        status: failure,
        body: unavailable,
      })
      expect(await f.sourceStatus()).toBe('confirmed')
    },
  )

  it('allows MCP OAuth transport but never uses the grant in place of the capability', async () => {
    const f = await setup()
    const clientId = 'https://handoff-oauth.example.test/client.json'
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://handoff-oauth.example.test/callback']),
      })
      .execute()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: f.owner.id, organization_id: f.team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: f.owner.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools']),
        resources: JSON.stringify([`${publicUrl}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const now = Math.floor(Date.now() / 1000)
    const accessToken = await signTestMcpAccessToken(auth, {
      sub: f.owner.id,
      client_id: clientId,
      scope: 'mcp:tools',
      iat: now,
      exp: now + 300,
      iss: `${publicUrl}/api/auth`,
      aud: `${publicUrl}/mcp`,
      'https://hourmere.com/organization': f.team.id,
      'https://hourmere.com/grant': grant.id,
    })
    const headers = bearer(accessToken)
    expect(await f.rest('offer', { token: f.token }, headers)).toMatchObject({ status: 401 })
    expect(await f.mcp('offer', { token: f.forgedToken }, headers)).toEqual({
      status: 200,
      body: unavailable,
    })
    expect(await f.mcp('offer', { token: f.token }, headers)).toMatchObject({
      status: 200,
      body: { role: 'guest', version: 1, answers: [] },
    })
    expect(
      await f.mcp('answer', { token: f.token, version: 1, decision: 'accept' }, headers),
    ).toEqual({
      status: 200,
      body: { decision: 'accept' },
    })
    expect(await f.sourceStatus()).toBe('confirmed')
  })

  it('scopes MCP discovery and checks hard-off before scope or argument validation', async () => {
    const f = await setup()
    const readHeaders = bearer(f.readOnly)
    const enabledRead = await rpc(f.app, 'tools/list', {}, readHeaders)
    const enabledWrite = await rpc(f.app, 'tools/list', {}, bearer(f.bookings))
    const disabledApp = appFor(db, { enabled: false, resolveCaller })
    const disabled = await rpc(disabledApp, 'tools/list', {}, bearer(f.full))
    const names = (result: Awaited<ReturnType<typeof rpc>>) =>
      result.body.tools.map(({ name }: { name: string }) => name)
    expect(names(enabledRead)).toContain(tools.offer)
    expect(names(enabledRead)).not.toContain(tools.answer)
    expect(names(enabledWrite)).toEqual(expect.arrayContaining([tools.offer, tools.answer]))
    expect(names(disabled)).not.toContain(tools.offer)
    expect(names(disabled)).not.toContain(tools.answer)
    expect(await f.mcp('answer', {}, readHeaders)).toMatchObject({
      status: 200,
      body: { error: 'insufficient_scope' },
    })
    for (const action of ['offer', 'answer'] as const) {
      expect(await call(disabledApp, action, {}, readHeaders)).toMatchObject({
        status: 200,
        body: unavailable,
      })
    }
  })

  it('shares one trusted-IP budget across REST, MCP and invalid tool arguments', async () => {
    const f = await setup()
    const client = '2001:db8:42::5'
    for (let i = 0; i < 29; i++) {
      const response = await f.app.request(`${path}/offer`, post({}), fromIp(client))
      expect(response.status).toBe(400)
    }
    const headers = { ...bearer(f.bookings), 'x-forwarded-for': '203.0.113.1' }
    expect(await call(f.app, 'answer', {}, headers, client)).toMatchObject({
      status: 200,
      body: { error: 'invalid_request' },
    })
    expect(await call(f.app, 'offer', { token: f.token }, headers, '2001:db8:42::6')).toMatchObject(
      {
        status: 200,
        body: { error: 'rate_limited', retryAfterSeconds: expect.any(Number) },
      },
    )
    const answer = post({ token: f.token, version: 1, decision: 'accept' })
    const response = await f.app.request(`${path}/answer`, answer, fromIp(client))
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBeTruthy()
    expectPrivate(response)
    expect(await f.decision()).toBeNull()
  })
})
