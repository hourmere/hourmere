// Real HTTP, PostgreSQL and the executable CLI; no mail or external provider traffic.
import { spawn } from 'node:child_process'
import { serve } from '@hono/node-server'
import '@hono/zod-openapi'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { leaveTeamMember } from '@hourmere/scheduling'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { productRoutes, productTools } from './server.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const bootstrap = process.env.DATABASE_URL
const secret = 'synthetic-revocation-regression-session-secret-0000000000'
type Departure = 'removal' | 'leave'
type Credential = { id: string; key: string }
type Identity = { organization: { id: string } }

describe.skipIf(!bootstrap)('membership revocation across REST, MCP and the CLI', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let server: ReturnType<typeof serve> | undefined
  let app: ReturnType<typeof createApp>
  let origin: string
  const outbox: MailMessage[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'revoke_keys' })
    db = createDb(owned.pool)
    // All scenarios share one auth pool (10 + 2 lock connections), closed before DB teardown.
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    server = serve({ fetch: (request) => app.fetch(request), hostname: '127.0.0.1', port: 0 })
    if (!server.listening) await new Promise<void>((resolve) => server?.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
      mailer: { send: async (message) => void outbox.push(message) },
    })
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: origin,
      routes: productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
      mcp: mcpEndpoint({ tools: productTools({ db }) }),
    })
  })

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      )
    }
    await authPool?.end()
    await owned?.drop()
  })

  async function session(user: TestUser, organizationId: string) {
    const before = outbox.length
    const requested = await post('/api/auth/sign-in/magic-link', '', {
      email: user.email,
      callbackURL: '/app',
    })
    expect(requested.status).toBe(200)
    await requested.body?.cancel()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const link = outbox
      .slice(before)
      .find((message) => message.to === user.email)
      ?.text.match(/https?:\/\/\S+/)?.[0]
    expect(typeof link === 'string').toBe(true)
    const verified = await pressConfirmButton(
      { request: (url) => fetch(url) },
      new URL(link as string),
    )
    const response = await fetch(verified, { redirect: 'manual' })
    expect(response.status).toBe(302)
    await response.body?.cancel()
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(cookie.includes('better-auth.session_token=')).toBe(true)
    const switched = await post('/api/auth/organization/set-active', cookie, { organizationId })
    expect(switched.status).toBe(200)
    await switched.body?.cancel()
    return cookie
  }

  function post(path: string, cookie: string, body: unknown, organizationId?: string) {
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        ...(organizationId ? { 'x-expected-organization-id': organizationId } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  async function fixture() {
    const member = await createTestUser(db, 'Departing administrator')
    const owner = await createTestUser(db, 'Continuing owner')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'admin' },
    ])
    const other = await createTestTeam(db, [{ user: member, role: 'owner' }])
    const cookie = await session(member, team.id)
    const ownerCookie = await session(owner, team.id)
    async function key(organizationId: string): Promise<Credential> {
      const response = await post('/api/auth/api-key/create', cookie, {
        name: 'Revocation regression',
        metadata: { organizationId },
      })
      expect(response.status).toBe(200)
      const value = (await response.json()) as Credential
      expect(typeof value.key === 'string' && value.key.startsWith('hm_')).toBe(true)
      return value
    }
    return {
      member,
      team,
      other,
      cookie,
      ownerCookie,
      key: await key(team.id),
      otherKey: await key(other.id),
      personalKey: await key(member.principal.organization.id),
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function rest(key: Credential, cookie?: string, path = '/api/v1/me') {
    return fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${key.key}`, ...(cookie ? { cookie } : {}) },
    })
  }

  function mcp(authorization: string | undefined, cookie?: string, tool = 'whoami') {
    return fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': tool,
        ...(authorization === undefined ? {} : { authorization }),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
  }

  async function mcpIdentity(key: Credential) {
    const response = await mcp(`Bearer ${key.key}`)
    expect(response.status).toBe(200)
    const text = await response.text()
    const value = JSON.parse(
      response.headers.get('content-type')?.startsWith('text/event-stream')
        ? (text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5) ?? '{}')
        : text,
    )
    expect(value.result?.isError).not.toBe(true)
    return value.result.structuredContent as Identity
  }

  async function cli(key: Credential, command = 'whoami') {
    const child = spawn(process.execPath, ['tools/cli/src/index.ts', command], {
      env: { ...process.env, HOURMERE_URL: origin, HOURMERE_API_KEY: key.key },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(10_000),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect((stdout + stderr).includes(key.key)).toBe(false)
    return {
      code,
      data: stdout ? JSON.parse(stdout) : undefined,
      error: stderr ? JSON.parse(stderr) : undefined,
    }
  }

  async function depart(f: Fixture, departure: Departure, native = false) {
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', f.member.id)
      .where('organizationId', '=', f.team.id)
      .executeTakeFirstOrThrow()
    const response = native
      ? await post(
          `/api/auth/organization/${departure === 'removal' ? 'remove-member' : 'leave'}`,
          departure === 'removal' ? f.ownerCookie : f.cookie,
          {
            organizationId: f.team.id,
            ...(departure === 'removal' ? { memberIdOrEmail: membership.id } : {}),
          },
          f.team.id,
        )
      : departure === 'removal'
        ? await post(
            `/api/v1/team/members/${f.member.id}/removal`,
            f.ownerCookie,
            { teamId: f.team.id },
            f.team.id,
          )
        : await post(`/api/v1/teams/${f.team.id}/leave`, f.cookie, {}, f.team.id)
    expect(response.status).toBe(200)
    await response.body?.cancel()
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('userId', '=', f.member.id)
        .where('organizationId', '=', f.team.id)
        .executeTakeFirst(),
    ).toBeUndefined()
  }

  async function expectIdentity(key: Credential, organizationId: string, executable = true) {
    const response = await rest(key)
    expect(response.status).toBe(200)
    expect(
      ((await response.json()) as Identity).organization.id,
      'API key must retain its issued organization',
    ).toBe(organizationId)
    expect((await mcpIdentity(key)).organization.id).toBe(organizationId)
    if (executable) {
      const result = await cli(key)
      expect(result.code).toBe(0)
      expect(result.data.organization.id).toBe(organizationId)
    }
  }

  async function verifyRevocation(departure: Departure, native = false) {
    const f = await fixture()
    await expectIdentity(f.key, f.team.id)
    const client = new Client({ name: 'retained-revocation-client', version: '1.0.0' })
    const clientStatuses: number[] = []
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${f.key.key}` } },
      fetch: async (request, init) => {
        const response = await fetch(request, init)
        clientStatuses.push(response.status)
        return response
      },
    })
    try {
      await client.connect(transport)
      expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).not.toBe(true)
      await depart(f, departure, native)
      for (const path of ['/api/v1/me', '/api/v1/bookings']) {
        const response = await rest(f.key, f.cookie, path)
        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
        expect(await response.json()).toMatchObject({ error: 'unauthorized' })
      }
      // The same connected SDK client must authenticate each later tool message again.
      clientStatuses.length = 0
      const rejected = await client.callTool({ name: 'list_bookings', arguments: {} }).then(
        () => false,
        () => true,
      )
      expect(rejected).toBe(true)
      expect(clientStatuses).toContain(401)
      for (const tool of ['whoami', 'list_bookings']) {
        const response = await mcp(`Bearer ${f.key.key}`, f.cookie, tool)
        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
        expect(await response.json()).toMatchObject({ error: 'unauthorized' })
      }
      for (const command of ['whoami', 'list']) {
        const result = await cli(f.key, command)
        expect(result.code).toBe(1)
        expect(result.error).toMatchObject({ error: 'unauthorized', status: 401 })
      }
    } finally {
      await client.close()
    }
    // Revocation is team-scoped: the person's other team and personal credentials survive.
    await expectIdentity(f.otherKey, f.other.id)
    await expectIdentity(f.personalKey, f.member.principal.organization.id)
  }

  it.each<Departure>(['removal', 'leave'])(
    'rejects the old team key after %s through REST, MCP and the executable CLI',
    async (departure) => verifyRevocation(departure),
    30_000,
  )

  it.each<Departure>(['removal', 'leave'])(
    'rejects the old team key after native Better Auth %s through REST, MCP and the CLI',
    async (departure) => verifyRevocation(departure, true),
    30_000,
  )

  async function verifyBinding() {
    const f = await fixture()
    await expectIdentity(f.key, f.team.id)
    for (const organizationId of [f.other.id, f.member.principal.organization.id, f.team.id]) {
      const switched = await post('/api/auth/organization/set-active', f.cookie, { organizationId })
      expect(switched.status).toBe(200)
      await switched.body?.cancel()
      const sessionIdentity = await fetch(`${origin}/api/v1/me`, { headers: { cookie: f.cookie } })
      expect(sessionIdentity.status).toBe(200)
      expect(((await sessionIdentity.json()) as Identity).organization.id).toBe(organizationId)
      await expectIdentity(f.key, f.team.id)
      await expectIdentity(f.otherKey, f.other.id, false)
      await expectIdentity(f.personalKey, f.member.principal.organization.id, false)
    }
  }

  it('keeps issued API keys bound to their organizations while the web session switches teams', async () => {
    await verifyBinding()
  }, 30_000)

  async function verifyNoFallback() {
    const f = await fixture()
    const authenticated = await fetch(`${origin}/api/v1/me`, { headers: { cookie: f.cookie } })
    expect(authenticated.status).toBe(200)
    await authenticated.body?.cancel()
    for (const authorization of ['Bearer hm_invalid_synthetic_key', 'Bearer invalid', 'Bearer']) {
      const response = await fetch(`${origin}/api/v1/me`, {
        headers: { authorization, cookie: f.cookie },
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: 'unauthorized' })
      const tool = await mcp(authorization, f.cookie)
      expect(tool.status).toBe(401)
      expect(await tool.json()).toMatchObject({ error: 'unauthorized' })
    }
    const cookieOnly = await mcp(undefined, f.cookie)
    expect(cookieOnly.status).toBe(401)
    expect(await cookieOnly.json()).toMatchObject({ error: 'unauthorized' })
    const result = await cli({ id: 'synthetic', key: 'hm_invalid_synthetic_key' })
    expect(result.code).toBe(1)
    expect(result.error).toMatchObject({ error: 'unauthorized', status: 401 })
  }

  it('never falls back from an invalid bearer to a live web session', async () => {
    await verifyNoFallback()
  })
})
