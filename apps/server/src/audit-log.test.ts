// The audit log over REST, MCP and the CLI: one service, so the same callers get the same
// answers, page for page, and the same refusals.
import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { auditLogTools } from './mcp/audit-log.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { AuditEventPage, AuditLogSettings, auditLogRoutes } from './routes/audit-log.ts'
import { instanceRoutes } from './routes/instance.ts'
import { openApiDocument, productApp, responseAndRequestStrictness } from './routes/test-app.ts'

const serverUrl = process.env.DATABASE_URL
type Body = {
  data: { occurredAt: string; actor: { id: string } }[]
  nextCursor: string | null
  error?: string
  [field: string]: unknown
}
const URL = 'http://localhost:4187'

describe('audit log OpenAPI', () => {
  it('keeps responses open and requests strict', async () => {
    const doc = await openApiDocument(
      productApp({} as Db, new Map(), [
        auditLogRoutes({ db: {} as Db, auditLogRetentionDays: null }),
      ]),
    )
    expect(
      responseAndRequestStrictness(doc, ['/api/v1/audit-events', '/api/v1/audit-log/settings']),
    ).toEqual({ closedResponses: [], openRequests: [] })
  })
})

describe.skipIf(!serverUrl)('audit log over REST, MCP and the CLI (real Postgres)', () => {
  let owned: TestDatabase
  let db: Db
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let outsider: TestUser
  let team: TestTeam
  let other: TestTeam
  let app: ReturnType<typeof createApp>
  const tokens = new Map<string, Principal>()

  function bearer(user: TestUser, scope: ApiKeyScope, acting?: TestTeam) {
    const token = `hm_${randomUUID().replaceAll('-', '')}`
    const base = acting ? acting.as(user) : user.principal
    tokens.set(token, { ...base, kind: 'api_key', apiKeyScope: scope, apiKeyId: randomUUID() })
    return token
  }
  function oauth(user: TestUser, acting?: TestTeam) {
    const token = randomUUID()
    const base = acting ? acting.as(user) : user.principal
    tokens.set(token, {
      user: base.user,
      organization: base.organization,
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: randomUUID(),
      scopes: ['mcp:tools'],
    })
    return token
  }
  function session(user: TestUser, acting?: TestTeam) {
    const token = randomUUID()
    const base = acting ? acting.as(user) : user.principal
    tokens.set(token, {
      user: base.user,
      organization: base.organization,
      kind: 'session',
      sessionId: randomUUID(),
    })
    return token
  }
  const resolveCaller: CallerResolver = async (headers) => {
    const authorization = headers.get('authorization')
    const token =
      authorization === null
        ? /(?:^|;\s*)test_session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1]
        : authorization.replace(/^Bearer /, '')
    const principal = tokens.get(token ?? '')
    return principal && (authorization === null) === (principal.kind === 'session')
      ? { ok: true, principal, setCookie: [] }
      : { ok: false, error: 'unauthorized', setCookie: [] }
  }

  const rest = async (
    token: string,
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const response = await app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(tokens.get(token)?.kind === 'session'
          ? { cookie: `test_session=${token}`, origin: URL }
          : { authorization: `Bearer ${token}` }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return { status: response.status, body: (await response.json()) as Body }
  }
  async function mcp(token: string, method: string, params: object = {}) {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await res.text()
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(data ? data.slice(6) : text).result
  }
  const tool = (token: string, name: string, args: object = {}) =>
    mcp(token, 'tools/call', { name, arguments: args })
  const toolError = (result: { isError?: boolean; content: { text: string }[] }) => {
    expect(result.isError).toBe(true)
    return JSON.parse(result.content[0]?.text ?? '')
  }
  async function cli(token: string, argv: string[], input: object = {}) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [...argv, '--input', '-'],
      env: { HOURMERE_URL: URL, HOURMERE_API_KEY: token },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (request, init) => app.request(request, init),
    })
    return {
      code,
      stdout: stdout ? JSON.parse(stdout) : null,
      stderr: stderr ? JSON.parse(stderr) : null,
    }
  }
  const query = (input: Record<string, string | number>) =>
    new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)])).toString()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'audit_http' })
    db = createDb(owned.pool)
    owner = await createTestUser(db, 'Audit owner')
    admin = await createTestUser(db, 'Audit admin')
    member = await createTestUser(db, 'Audit member')
    outsider = await createTestUser(db, 'Audit outsider')
    team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    other = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
    for (let i = 0; i < 5; i += 1)
      await sql`INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_id,
          credential_type, credential_id, action, target_type, target_id)
        VALUES (${team.id}, ${`2026-11-0${i + 1}T12:00:00Z`}::timestamptz, 'user', ${owner.id},
          'session', ${randomUUID()}, ${i % 2 ? 'api_key.revoked' : 'membership.removed'},
          'organization', ${team.id})`.execute(db)
    await sql`INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
        action, target_type, target_id)
      VALUES (${other.id}, 'user', ${outsider.id}, 'none', 'membership.removed', 'organization',
        ${other.id})`.execute(db)
    app = createApp({
      publicUrl: URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: [
        auditLogRoutes({ db, auditLogRetentionDays: 400 }),
        instanceRoutes({ publicUrl: URL, socialProviders: {} }),
      ],
      mcp: mcpEndpoint({
        tools: auditLogTools({ db, auditLogRetentionDays: 400 }),
        oauth: {
          handler: async () => new Response(null, { status: 404 }),
          resolve: async (request) => {
            const principal = tokens.get(
              request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
            )
            return principal?.kind === 'oauth'
              ? { ok: true, principal }
              : { ok: false, error: 'invalid_token' }
          },
        },
      }),
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('answers every page and the settings identically over REST, MCP and the CLI', async () => {
    for (const user of [owner, admin]) {
      const token = bearer(user, 'full', team)
      const filters = { from: '2026-11-02T00:00:00Z', to: '2026-11-06T00:00:00+00:00', limit: 2 }
      const pages: unknown[] = []
      let cursor: string | null = null
      do {
        const input: Record<string, string | number> = { ...filters, ...(cursor ? { cursor } : {}) }
        const viaRest = await rest(token, `/api/v1/audit-events?${query(input)}`)
        expect(viaRest.status).toBe(200)
        const viaMcp = await tool(token, 'list_audit_events', input)
        const viaCli = await cli(token, ['audit-log', 'list'], input)
        expect(viaCli.code).toBe(0)
        expect(viaMcp.structuredContent).toEqual(viaRest.body)
        expect(viaCli.stdout).toEqual(viaRest.body)
        // The published schema describes every field: parsing keeps the body whole.
        expect(AuditEventPage.parse(viaRest.body)).toEqual(viaRest.body)
        pages.push(...viaRest.body.data)
        cursor = viaRest.body.nextCursor
      } while (cursor)
      expect(pages.map((event) => (event as { occurredAt: string }).occurredAt)).toEqual([
        '2026-11-05T12:00:00.000000Z',
        '2026-11-04T12:00:00.000000Z',
        '2026-11-03T12:00:00.000000Z',
        '2026-11-02T12:00:00.000000Z',
      ])
      // Session IDs never leave the server.
      expect(
        pages.every(
          (event) =>
            JSON.stringify((event as { credential: unknown }).credential) ===
            JSON.stringify({
              type: 'session',
              apiKeyId: null,
              apiKeyScope: null,
              oauthClientId: null,
              oauthGrantId: null,
            }),
        ),
      ).toBe(true)
      const settings = await rest(token, '/api/v1/audit-log/settings')
      expect(settings).toEqual({
        status: 200,
        body: {
          retention: 'instance',
          retentionDays: null,
          instanceRetentionDays: 400,
          effectiveRetentionDays: 400,
          canChangeRetention: user === owner,
        },
      })
      expect(AuditLogSettings.parse(settings.body)).toEqual(settings.body)
      expect((await tool(token, 'get_audit_log_settings')).structuredContent).toEqual(settings.body)
      expect((await cli(token, ['audit-log', 'settings'])).stdout).toEqual(settings.body)
    }
  })

  it('changes retention the same way on every surface and refuses admins alike', async () => {
    const token = bearer(owner, 'full', team)
    const viaRest = await rest(token, '/api/v1/audit-log/settings', {
      method: 'PUT',
      body: { retention: 'days', retentionDays: 90 },
    })
    expect(viaRest).toMatchObject({ status: 200, body: { effectiveRetentionDays: 90 } })
    const viaMcp = await tool(token, 'set_audit_log_settings', { retention: 'forever' })
    expect(viaMcp.structuredContent).toMatchObject({
      retention: 'forever',
      effectiveRetentionDays: null,
    })
    const viaCli = await cli(token, ['audit-log', 'set-retention'], { retention: 'instance' })
    expect(viaCli).toMatchObject({
      code: 0,
      stdout: { retention: 'instance', effectiveRetentionDays: 400 },
    })
    const recorded = await rest(
      token,
      `/api/v1/audit-events?${query({ action: 'audit_log.retention_updated' })}`,
    )
    expect(recorded.body.data).toHaveLength(3)

    const adminToken = bearer(admin, 'full', team)
    const refusal = { error: 'insufficient_role', message: expect.any(String) }
    expect(
      await rest(adminToken, '/api/v1/audit-log/settings', {
        method: 'PUT',
        body: { retention: 'forever' },
      }),
    ).toEqual({ status: 403, body: refusal })
    expect(
      toolError(await tool(adminToken, 'set_audit_log_settings', { retention: 'forever' })),
    ).toEqual(refusal)
    expect(
      await cli(adminToken, ['audit-log', 'set-retention'], { retention: 'forever' }),
    ).toMatchObject({
      code: 1,
      stderr: { error: 'insufficient_role' },
    })
    // Invalid choices: 400 over every surface, nothing recorded.
    for (const body of [{ retention: 'days', retentionDays: 29 }, { retention: 'days' }]) {
      expect(
        (await rest(token, '/api/v1/audit-log/settings', { method: 'PUT', body })).status,
      ).toBe(400)
      expect(toolError(await tool(token, 'set_audit_log_settings', body)).error).toBe(
        'invalid_request',
      )
      expect((await cli(token, ['audit-log', 'set-retention'], body)).stderr.error).toBe(
        'invalid_request',
      )
    }
    expect(
      (
        await rest(
          token,
          `/api/v1/audit-events?${query({ action: 'audit_log.retention_updated' })}`,
        )
      ).body.data,
    ).toHaveLength(3)
  })

  it('refuses read and bookings keys before anything else and hides the tools from them', async () => {
    for (const scope of ['read', 'bookings'] as const) {
      const token = bearer(owner, scope, team)
      const denied = {
        error: 'insufficient_scope',
        message: 'This API key does not allow this operation.',
      }
      for (const path of [
        '/api/v1/audit-events',
        '/api/v1/audit-events?limit=1000&cursor=garbage',
        '/api/v1/audit-log/settings',
      ])
        expect(await rest(token, path)).toEqual({ status: 403, body: denied })
      expect(
        await rest(token, '/api/v1/audit-log/settings', {
          method: 'PUT',
          body: { retention: 'forever' },
        }),
      ).toEqual({ status: 403, body: denied })
      const listed = (await mcp(token, 'tools/list')).tools.map(
        (entry: { name: string }) => entry.name,
      )
      expect(listed).toEqual([])
      for (const name of ['list_audit_events', 'get_audit_log_settings', 'set_audit_log_settings'])
        expect(toolError(await tool(token, name, { limit: 1000 }))).toEqual(denied)
      for (const command of ['list', 'settings', 'set-retention'])
        expect((await cli(token, ['audit-log', command])).stderr).toMatchObject({
          error: 'insufficient_scope',
        })
    }
    const full = (await mcp(bearer(owner, 'full', team), 'tools/list')).tools.map(
      (entry: { name: string }) => entry.name,
    )
    expect(full.sort()).toEqual([
      'get_audit_log_settings',
      'list_audit_events',
      'set_audit_log_settings',
    ])
  })

  it('gives members and foreign or stale contexts one uniform refusal without leaking existence', async () => {
    const memberToken = bearer(member, 'full', team)
    const refusal = { error: 'team_management_access_denied' }
    for (const path of [
      '/api/v1/audit-events?actorType=invalid',
      '/api/v1/audit-events?from=yesterday',
      '/api/v1/audit-events?cursor=',
    ])
      expect(await rest(memberToken, path)).toEqual({ status: 403, body: refusal })
    expect(
      await rest(memberToken, '/api/v1/audit-log/settings', {
        method: 'PUT',
        body: { retention: 'invalid' },
      }),
    ).toEqual({ status: 403, body: refusal })

    for (const path of [
      '/api/v1/audit-events',
      `/api/v1/audit-events?${query({ actorType: 'user', actorId: owner.id })}`,
      '/api/v1/audit-events?cursor=garbage',
      '/api/v1/audit-log/settings',
    ])
      expect(await rest(memberToken, path)).toEqual({ status: 403, body: refusal })
    expect(toolError(await tool(memberToken, 'list_audit_events'))).toEqual(refusal)
    expect(toolError(await tool(memberToken, 'get_audit_log_settings'))).toEqual(refusal)
    expect((await cli(memberToken, ['audit-log', 'list'])).stderr).toMatchObject({
      error: 'team_management_access_denied',
    })
    // A session that names another team, existing or not, gets the same answer as a member.
    const ownerSession = session(owner, team)
    for (const expected of [other.id, randomUUID(), 'not-a-uuid'])
      expect(
        await rest(ownerSession, '/api/v1/audit-events', {
          headers: { 'x-expected-organization-id': expected },
        }),
      ).toEqual({ status: 403, body: refusal })
    // Session writes must name their space; a missing expectation is a recoverable conflict.
    expect(
      await rest(ownerSession, '/api/v1/audit-log/settings', {
        method: 'PUT',
        body: { retention: 'forever' },
      }),
    ).toMatchObject({ status: 409, body: { error: 'organization_context_changed' } })
    // The other team's owner sees only its own event.
    const otherPage = await rest(bearer(outsider, 'full', other), '/api/v1/audit-events')
    expect(otherPage.body.data.map((event: { actor: { id: string } }) => event.actor.id)).toEqual([
      outsider.id,
    ])
  })

  it('keeps OAuth native access while checking current membership and owner-only retention', async () => {
    for (const user of [owner, admin]) {
      const token = oauth(user, team)
      expect((await mcp(token, 'tools/list')).tools).toHaveLength(3)
      const page = await tool(token, 'list_audit_events', { action: 'membership.removed' })
      expect(page.isError).toBeFalsy()
      expect(page.structuredContent.data).toHaveLength(3)
      expect(
        (await tool(token, 'get_audit_log_settings')).structuredContent.canChangeRetention,
      ).toBe(user === owner)
      const update = await tool(token, 'set_audit_log_settings', { retention: 'instance' })
      if (user === owner) expect(update.isError).toBeFalsy()
      else expect(toolError(update).error).toBe('insufficient_role')
    }
    for (const user of [member, outsider]) {
      const token = oauth(user, team)
      for (const name of ['list_audit_events', 'get_audit_log_settings', 'set_audit_log_settings'])
        expect(
          toolError(
            await tool(
              token,
              name,
              name === 'set_audit_log_settings' ? { retention: 'forever' } : {},
            ),
          ),
        ).toEqual({ error: 'team_management_access_denied' })
    }
    const personal = oauth(owner)
    expect((await tool(personal, 'list_audit_events')).structuredContent.data).toEqual([])
    expect(
      (await tool(personal, 'set_audit_log_settings', { retention: 'forever' })).structuredContent
        .effectiveRetentionDays,
    ).toBeNull()
  })

  it('answers invalid filters with the same codes on every surface', async () => {
    const token = bearer(owner, 'full', team)
    for (const [input, code] of [
      [{ limit: 0 }, 'invalid_limit'],
      [{ limit: 101 }, 'invalid_limit'],
      [{ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }, 'invalid_range'],
      [{ cursor: 'garbage' }, 'invalid_cursor'],
      [{ actorId: owner.id }, 'invalid_request'],
    ] as const) {
      const viaRest = await rest(token, `/api/v1/audit-events?${query(input)}`)
      expect([viaRest.status, viaRest.body.error]).toEqual([400, code])
      expect(toolError(await tool(token, 'list_audit_events', input)).error).toBe(code)
      expect((await cli(token, ['audit-log', 'list'], input)).stderr.error).toBe(code)
    }
    // Query-string shapes REST alone can receive.
    for (const path of [
      '?limit=abc',
      '?limit=-1',
      '?from=yesterday',
      '?actorType=robot',
      '?action=Drop',
    ])
      expect((await rest(token, `/api/v1/audit-events${path}`)).status).toBe(400)
  })
})
