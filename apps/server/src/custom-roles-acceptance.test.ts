import '@hono/zod-openapi'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import {
  type ApiKeyScope,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { proveMailbox } from '../../../packages/db/src/sso-identity-fixtures.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { productRoutes, productTools } from './server.ts'
import { BROWSER_BINDING_COOKIE } from './sso-mailbox-proof.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4398'
const secret = randomBytes(32).toString('base64')
const clientId = 'https://custom-roles-client.test/metadata.json'
const redirectUri = 'https://custom-roles-client.test/callback'
const signup = { mode: 'closed', allowedDomains: [] } as const
const capabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false, ssoOperatorSetting: true }
const branding = '/api/v1/branding'
const brand = '#123456'
const ownerColor = '#2B3344'
const privateEmail = 'private-invitee@example.test'
const coordinatorPermissions = ['analytics.read', 'branding.read', 'branding.update']
const expectedOrganization = 'X-Expected-Organization-Id'
const reviewedAuthorization = 'X-Hourmere-Reviewed-Team-Authorization'
const teamPath = (teamId: string) => `/api/v1/teams/${teamId}`
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

type Browser = { teamId: string; headers: Headers }
type ToolResult = {
  isError?: boolean
  content?: { text: string }[]
  structuredContent?: Record<string, unknown>
}
type RpcResult = ToolResult & { tools?: { name: string }[] }

describe.skipIf(!databaseUrl)('custom roles across REST, API keys, MCP OAuth and CLI', () => {
  let database: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>
  let db: Db
  let auth: ReturnType<typeof createAuth>
  let app: ReturnType<typeof createApp>
  let server: ReturnType<typeof serve>
  let cliUrl: string

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'role_acceptance',
    })
    database.pool.options.max = 8
    db = createDb(database.pool)
    authPool = createAuthPool(database.url, signup)
    auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('Role acceptance sends no mail') },
      mcpOAuth: true,
      mcpMetadataFetcher: async (url) =>
        String(url) === clientId
          ? Response.json({
              client_id: clientId,
              client_name: 'Synthetic connector',
              redirect_uris: [redirectUri],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            })
          : new Response(null, { status: 404 }),
      ssoCapabilities: capabilities,
      customRolesEnabled: true,
    })
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, customRolesEnabled: true }),
      publicUrl,
      routes: productRoutes({
        db,
        publicUrl,
        ...capabilities,
        mcpAuth: auth,
        customRolesEnabled: true,
        socialProviders: {},
        invitationMailLimits: { secret },
      }),
      ssoTeamReads: { db, capabilities },
      mcp: mcpEndpoint({
        tools: productTools({ db, publicUrl }),
        oauth: {
          resolve: createMcpOAuthResolver({ auth, db, publicUrl, customRolesEnabled: true }),
          handler: auth.handler,
        },
      }),
    })
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.once('listening', resolve)
      })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
    cliUrl = `http://127.0.0.1:${address.port}`
    await db
      .updateTable('custom_role_master_policy')
      .set({ enabled: true, policy_epoch: 1 })
      .execute()
  })

  afterAll(async () => {
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
    } finally {
      try {
        await authPool?.end()
      } finally {
        await database?.drop()
      }
    }
  })

  async function browser(user: TestUser, teamId: string): Promise<Browser> {
    const token = randomBytes(32).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: teamId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const session = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    const binding = `${BROWSER_BINDING_COOKIE}=${randomBytes(32).toString('base64url')}`
    return {
      teamId,
      headers: new Headers({
        cookie: `${session}; ${binding}`,
        origin: publicUrl,
        [expectedOrganization]: teamId,
      }),
    }
  }

  async function request(
    path: string,
    headers: NonNullable<RequestInit['headers']>,
    method = 'GET',
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const requestHeaders = new Headers(headers)
    if (body !== undefined) requestHeaders.set('content-type', 'application/json')
    return app.request(new URL(path, publicUrl), {
      headers: requestHeaders,
      method,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  async function confirmWrite(
    actor: Browser,
    path: string,
    method: string,
    input: Record<string, unknown>,
  ) {
    const challenge = await request(path, actor.headers, method, input)
    expect(challenge.status).toBe(403)
    const { attemptId } = z
      .object({ error: z.literal('sso_reauthentication_required'), attemptId: z.uuid() })
      .parse(await challenge.json())
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN')
      await proveMailbox(client, { id: attemptId, organization_id: actor.teamId })
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    return {
      attemptId,
      response: await request(path, actor.headers, method, { ...input, proofAttemptId: attemptId }),
    }
  }

  async function provedWrite(
    actor: Browser,
    path: string,
    method: string,
    input: Record<string, unknown>,
  ) {
    const { response: completed } = await confirmWrite(actor, path, method, input)
    expect(completed.status).toBe(200)
    return completed.json() as Promise<unknown>
  }

  function changeMode(actor: Browser, enabled: boolean, expectedTeamEpoch: number) {
    return provedWrite(actor, `${teamPath(actor.teamId)}/permissions-mode`, 'PUT', {
      enabled,
      expectedTeamEpoch,
      expectedMasterEpoch: 1,
    })
  }

  async function issueKey(actor: Browser, scope: ApiKeyScope, authorizationId?: string) {
    const headers = new Headers(actor.headers)
    if (authorizationId) headers.set(reviewedAuthorization, authorizationId)
    const response = await request('/api/auth/api-key/create', headers, 'POST', {
      metadata: { organizationId: actor.teamId, scope },
    })
    expect(response.status).toBe(200)
    const result = (await response.json()) as { id: string; key: string }
    if (!result.key?.startsWith('hm_')) throw new Error('Expected a test API key')
    return result
  }

  async function oauth(actor: Browser, authorizationId?: string) {
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'mcp:tools offline_access',
      resource: `${publicUrl}/mcp`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(16).toString('base64url'),
      prompt: 'consent',
    })
    const authorize = await request(`/api/auth/oauth2/authorize?${query}`, actor.headers)
    expect(authorize.status).toBe(302)
    const selection = new URL(authorize.headers.get('location') ?? '', publicUrl)
    expect(selection.pathname).toBe('/oauth/authorize')
    const selected = await request('/api/v1/mcp-oauth/select', actor.headers, 'POST', {
      oauthQuery: selection.searchParams.toString(),
      organizationId: actor.teamId,
    })
    expect(selected.status).toBe(200)
    const { redirectUrl } = (await selected.json()) as { redirectUrl: string }
    const consent = new URL(redirectUrl, publicUrl)
    expect(consent.pathname).toBe('/oauth/consent')
    const oauthQuery = consent.searchParams.toString()
    const intentId = new URLSearchParams(consent.hash.slice(1)).get('intent')
    const headers = new Headers(actor.headers)
    if (authorizationId) {
      const info = await request('/api/v1/mcp-oauth/request', headers, 'POST', {
        oauthQuery,
        intentId,
      })
      expect(info.status).toBe(200)
      expect(await info.json()).toMatchObject({
        selectedOrganization: {
          id: actor.teamId,
          teamAuthorizationReviewRequired: true,
          teamPermissionIds: coordinatorPermissions,
        },
      })
      headers.set(reviewedAuthorization, authorizationId)
    }
    const approved = await request('/api/v1/mcp-oauth/consent', headers, 'POST', {
      oauthQuery,
      intentId,
      accept: true,
      ...(authorizationId && { reviewedTeamAuthorization: true }),
    })
    expect(approved.status).toBe(200)
    const callback = new URL(((await approved.json()) as { redirectUrl: string }).redirectUrl)
    const code = callback.searchParams.get('code')
    if (!code) throw new Error('Expected a synthetic authorization code')
    return exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    })
  }

  function tokenRequest(input: Record<string, string>) {
    return app.request(new URL('/api/auth/oauth2/token', publicUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        resource: `${publicUrl}/mcp`,
        ...input,
      }),
    })
  }

  async function exchange(input: Record<string, string>) {
    const response = await tokenRequest(input)
    expect(response.status).toBe(200)
    const tokens = (await response.json()) as { access_token: string; refresh_token: string }
    if (!tokens.access_token || !tokens.refresh_token)
      throw new Error('Expected an offline OAuth token pair')
    return tokens
  }

  function refresh(refreshToken: string) {
    return exchange({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  function mcpRequest(token: string, name?: string, args: Record<string, unknown> = {}) {
    return request(
      '/mcp',
      { ...bearer(token), accept: 'application/json, text/event-stream' },
      'POST',
      {
        jsonrpc: '2.0',
        id: 1,
        method: name ? 'tools/call' : 'tools/list',
        ...(name && { params: { name, arguments: args } }),
      },
    )
  }

  async function rpc(token: string, name?: string, args: Record<string, unknown> = {}) {
    const result = await mcpRequest(token, name, args)
    expect(result.status).toBe(200)
    const body = await result.text()
    const event = body.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(event ? event.slice(6) : body) as {
      result?: RpcResult
      error?: { code: number; message: string }
    }
  }

  async function allowedTools(token: string) {
    return (await rpc(token)).result?.tools?.map(({ name }) => name) ?? []
  }

  function toolError(result: ToolResult | undefined) {
    expect(result?.isError).toBe(true)
    return JSON.parse(result?.content?.[0]?.text ?? 'null') as { error: string }
  }

  async function cli(key: string, argv: string[], input: Record<string, unknown> = {}) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [...argv, '--input', '-'],
      env: { HOURMERE_URL: cliUrl, HOURMERE_API_KEY: key },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
    })
    expect((stdout + stderr).includes(key)).toBe(false)
    return {
      code,
      data: stdout ? JSON.parse(stdout) : undefined,
      error: stderr ? JSON.parse(stderr) : undefined,
    }
  }

  async function fixture() {
    const owner = await createTestUser(db, 'Custom role owner')
    const member = await createTestUser(db, 'Custom role assignee')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const { id: memberId } = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', member.id)
      .executeTakeFirstOrThrow()
    return {
      owner,
      member,
      team,
      memberId,
      ownerBrowser: await browser(owner, team.id),
      memberBrowser: await browser(member, team.id),
    }
  }

  async function renewBrowser(
    actor: Browser,
    expectedGeneration: number,
    expectedTeamEpoch: number,
  ) {
    const permissions = `${teamPath(actor.teamId)}/permissions`
    await provedWrite(actor, `${permissions}/renew`, 'POST', {
      expectedGeneration,
      expectedTeamEpoch,
      expectedMasterEpoch: 1,
    })
    const renewed = await request(permissions, actor.headers)
    expect(renewed.status).toBe(200)
    return z.object({ credentialAuthorizationId: z.uuid() }).parse(await renewed.json())
      .credentialAuthorizationId
  }

  async function assignCoordinator(f: Awaited<ReturnType<typeof fixture>>) {
    const team = teamPath(f.team.id)
    const { role } = z.object({ role: z.object({ id: z.uuid() }) }).parse(
      await provedWrite(f.ownerBrowser, `${team}/roles`, 'POST', {
        name: 'Coordinator',
        permissionIds: coordinatorPermissions,
      }),
    )
    await provedWrite(f.ownerBrowser, `${team}/members/${f.memberId}/custom-role`, 'PUT', {
      expectedGeneration: 1,
      expectedRevision: 1,
      roleId: role.id,
    })
  }

  it('preserves fixed-role sessions, key scopes and OAuth across team opt-in, disable and re-enable', async () => {
    const f = await fixture()
    const ownerKey = await issueKey(f.ownerBrowser, 'full')
    const ownerRead = await issueKey(f.ownerBrowser, 'read')
    const ownerBookings = await issueKey(f.ownerBrowser, 'bookings')
    const ownerGrant = await oauth(f.ownerBrowser)
    const team = teamPath(f.team.id)
    const update = { brandPrimaryColor: ownerColor }

    const initial = await request(`${team}/permissions-mode`, f.ownerBrowser.headers)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ enabled: false, renewals: [] })

    for (const [enabled, epoch] of [
      [true, 0],
      [false, 1],
      [true, 2],
    ] as const) {
      await changeMode(f.ownerBrowser, enabled, epoch)
      expect((await request(branding, f.ownerBrowser.headers, 'PATCH', update)).status).toBe(200)
      expect((await request(branding, bearer(ownerKey.key), 'PATCH', update)).status).toBe(200)
      expect((await request(branding, bearer(ownerRead.key))).status).toBe(200)
      expect((await request(branding, bearer(ownerBookings.key))).status).toBe(403)
      for (const { key } of [ownerKey, ownerRead, ownerBookings])
        expect((await request('/api/v1/bookings', bearer(key))).status).toBe(200)
      expect((await cli(ownerKey.key, ['branding', 'get'])).data).toMatchObject(update)
      expect(
        (await rpc(ownerGrant.access_token, 'get_branding')).result?.structuredContent,
      ).toMatchObject(update)
      expect(
        (await rpc(ownerGrant.access_token, 'whoami')).result?.structuredContent,
      ).toMatchObject({ organization: { id: f.team.id } })
    }

    const refreshedOwnerGrant = await refresh(ownerGrant.refresh_token)
    expect(
      (await rpc(refreshedOwnerGrant.access_token, 'get_branding')).result?.structuredContent,
    ).toMatchObject(update)

    const role = { name: 'Cannot create', permissionIds: ['branding.read'] }
    const mutations = [
      { method: 'GET', path: '/roles' },
      { method: 'POST', path: '/roles', body: role },
      { method: 'PATCH', path: `/roles/${f.memberId}`, body: { ...role, expectedRevision: 1 } },
      { method: 'DELETE', path: `/roles/${f.memberId}`, body: { expectedRevision: 1 } },
      {
        method: 'PUT',
        path: `/members/${f.memberId}/custom-role`,
        body: { expectedGeneration: 1, expectedRevision: null, roleId: null },
      },
      {
        method: 'PUT',
        path: '/permissions-mode',
        body: { enabled: false, expectedTeamEpoch: 3, expectedMasterEpoch: 1 },
      },
    ]
    for (const token of [ownerKey.key, ownerGrant.access_token]) {
      const headers = { ...Object.fromEntries(f.ownerBrowser.headers), ...bearer(token) }
      for (const { method, path, body } of mutations) {
        const response = await request(`${team}${path}`, headers, method, body)
        expect(response.status, `${method} ${path}`).toBe(403)
        expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
      }
      const roleTools = (await allowedTools(token)).filter((name) =>
        /custom.*role|role.*assign|permissions_mode|team_permissions/.test(name),
      )
      expect(roleTools).toEqual([])
      const missingTool = await rpc(token, 'create_custom_team_role', role)
      expect(missingTool.result?.structuredContent).toBeUndefined()
      expect(Boolean(missingTool.error || missingTool.result?.isError)).toBe(true)
    }
    await expect(cli(ownerKey.key, ['roles', 'create'], role)).resolves.toMatchObject({
      code: 1,
      error: { error: 'invalid_command' },
    })
    await expect(
      db.selectFrom('custom_roles').select('id').where('organization_id', '=', f.team.id).execute(),
    ).resolves.toEqual([])
  })

  it('limits opt-in to a fixed Owner, rejects stale epochs and blocks ambiguous memberships', async () => {
    const f = await fixture()
    const path = `${teamPath(f.team.id)}/permissions-mode`
    const input = { enabled: true, expectedTeamEpoch: 0, expectedMasterEpoch: 1 }
    for (const role of ['member', 'admin', 'admin, member']) {
      await db.updateTable('auth.member').set({ role }).where('id', '=', f.memberId).execute()
      const forbidden = await request(path, f.memberBrowser.headers, 'PUT', input)
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toEqual({ error: 'team_management_access_denied' })
    }

    const ambiguous = await confirmWrite(f.ownerBrowser, path, 'PUT', input)
    expect(ambiguous.response.status).toBe(409)
    expect(await ambiguous.response.json()).toEqual({ error: 'custom_role_ambiguous_memberships' })
    const attempt = await db
      .selectFrom('sso_attempts')
      .select('consumed_at')
      .where('id', '=', ambiguous.attemptId)
      .executeTakeFirstOrThrow()
    expect(attempt.consumed_at).toBeNull()
    const unchanged = await request(path, f.ownerBrowser.headers)
    expect(await unchanged.json()).toMatchObject({
      enabled: false,
      policyVersion: { teamEpoch: 0 },
    })

    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', f.memberId)
      .execute()
    await changeMode(f.ownerBrowser, true, 0)
    const stale = await request(path, f.ownerBrowser.headers, 'PUT', {
      enabled: false,
      expectedTeamEpoch: 0,
      expectedMasterEpoch: 1,
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'role_revision_conflict' })
    const staleMaster = await request(path, f.ownerBrowser.headers, 'PUT', {
      enabled: false,
      expectedTeamEpoch: 1,
      expectedMasterEpoch: 0,
    })
    expect(staleMaster.status).toBe(409)
    expect(await staleMaster.json()).toEqual({ error: 'role_revision_conflict' })
    const enabled = await request(path, f.ownerBrowser.headers)
    expect(await enabled.json()).toMatchObject({ enabled: true, policyVersion: { teamEpoch: 1 } })
  })

  it('intersects renewed grants with scope and immediately rejects cached direct calls after revocation', async () => {
    const f = await fixture()
    const oldKey = await issueKey(f.memberBrowser, 'full')
    const oldGrant = await oauth(f.memberBrowser)
    const otherTeam = await createTestTeam(db, [{ user: f.member, role: 'member' }])
    const otherKey = await issueKey(await browser(f.member, otherTeam.id), 'full')
    await changeMode(f.ownerBrowser, true, 0)

    const team = teamPath(f.team.id)
    await assignCoordinator(f)
    const enabled = await request(`${team}/permissions-mode`, f.ownerBrowser.headers)
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({
      enabled: true,
      renewals: [{ memberId: f.memberId }],
    })
    expect((await request(branding, f.memberBrowser.headers)).status).toBe(403)
    expect((await request(branding, bearer(oldKey.key))).status).toBe(403)
    expect((await allowedTools(oldGrant.access_token)).includes('get_branding')).toBe(false)

    const credentialAuthorizationId = await renewBrowser(f.memberBrowser, 2, 1)
    const full = await issueKey(f.memberBrowser, 'full', credentialAuthorizationId)
    const read = await issueKey(f.memberBrowser, 'read', credentialAuthorizationId)
    const freshGrant = await oauth(f.memberBrowser, credentialAuthorizationId)
    expect(full.id === oldKey.id).toBe(false)

    const staleBrowser = await browser(f.member, f.team.id)
    staleBrowser.headers.set(reviewedAuthorization, credentialAuthorizationId)
    const cannotIssue = await request('/api/auth/api-key/create', staleBrowser.headers, 'POST', {
      metadata: { organizationId: f.team.id, scope: 'full' },
    })
    expect(cannotIssue.status).toBe(403)
    for (const [keyId, metadata] of [
      [full.id, { organizationId: otherTeam.id }],
      [oldKey.id, null],
      [otherKey.id, { organizationId: f.team.id }],
    ] as const) {
      const cannotRetarget = await request(
        '/api/auth/api-key/update',
        f.memberBrowser.headers,
        'POST',
        { keyId, metadata },
      )
      expect(cannotRetarget.status).toBe(409)
    }

    const update = { brandPrimaryColor: brand }
    expect((await request(branding, f.memberBrowser.headers, 'PATCH', update)).status).toBe(200)
    expect((await request(branding, bearer(full.key), 'PATCH', update)).status).toBe(200)
    expect((await request(branding, bearer(read.key))).status).toBe(200)
    const scope = await request(branding, bearer(read.key), 'PATCH', update)
    expect(scope.status).toBe(403)
    expect(await scope.json()).toMatchObject({ error: 'insufficient_scope' })
    expect(toolError((await rpc(read.key, 'set_branding', update)).result)).toMatchObject({
      error: 'insufficient_scope',
    })
    expect(
      (await request(branding, { ...bearer(otherKey.key), [expectedOrganization]: f.team.id }))
        .status,
    ).toBe(403)
    expect((await request(branding, bearer(oldKey.key))).status).toBe(403)
    expect(await allowedTools(freshGrant.access_token)).toEqual(
      expect.arrayContaining(['get_branding', 'set_branding']),
    )
    await expect(rpc(freshGrant.access_token, 'set_branding', update)).resolves.toMatchObject({
      result: { structuredContent: update },
    })
    await expect(cli(full.key, ['branding', 'set'], update)).resolves.toMatchObject({
      code: 0,
      data: update,
    })

    const bookingId = await createFixtures(db).booking(
      f.team.id,
      [f.owner.id],
      '2026-12-01T12:00:00Z',
      '2026-12-01T12:30:00Z',
      { attendee: { name: 'Private invitee', email: privateEmail } },
    )
    const booking = await db
      .selectFrom('bookings')
      .select('created_at')
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow()
    const date = new Date(booking.created_at).toISOString().slice(0, 10)
    const range = { startDate: date, endDate: date, timeZone: 'UTC' }
    const totals = { created: 1, cancelled: 0, rescheduled: 0, noShows: 0 }
    const aggregate = { ...range, totals, data: [{ date, ...totals }] }
    const analytics = await request(
      `/api/v1/analytics/bookings?${new URLSearchParams(range)}`,
      bearer(read.key),
    )
    expect(analytics.status).toBe(200)
    expect(await analytics.json()).toEqual(aggregate)
    expect(
      (await rpc(freshGrant.access_token, 'get_booking_activity', range)).result?.structuredContent,
    ).toEqual(aggregate)
    expect((await cli(full.key, ['booking-activity'], range)).data).toEqual(aggregate)

    const detail = `/api/v1/bookings/${bookingId}`
    const csv = '/api/v1/bookings/export.csv?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z'
    const ownerCsv = await request(csv, f.ownerBrowser.headers)
    expect(ownerCsv.status).toBe(200)
    expect((await ownerCsv.text()).includes(privateEmail)).toBe(true)
    for (const [path, status, headers] of [
      [detail, 404, f.memberBrowser.headers],
      [detail, 404, bearer(full.key)],
      [`/api/v1/team/bookings/${bookingId}`, 403, f.memberBrowser.headers],
      [`/api/v1/team/bookings/${bookingId}`, 403, bearer(full.key)],
      [csv, 403, bearer(full.key)],
    ] as const) {
      const denied = await request(path, headers)
      expect(denied.status).toBe(status)
      expect((await denied.text()).includes(privateEmail)).toBe(false)
    }
    expect(
      toolError((await rpc(freshGrant.access_token, 'get_booking', { bookingId })).result),
    ).toMatchObject({ error: 'booking_not_found' })
    await expect(cli(full.key, ['booking'], { bookingId })).resolves.toMatchObject({
      code: 1,
      error: { error: 'booking_not_found' },
    })

    for (const [enabled, epoch] of [
      [false, 1],
      [true, 2],
    ] as const) {
      await changeMode(f.ownerBrowser, enabled, epoch)
      expect((await request(branding, f.memberBrowser.headers)).status).toBe(403)
      expect((await request(branding, bearer(full.key))).status).toBe(403)
      expect((await request('/api/v1/bookings', bearer(full.key))).status).toBe(200)
      expect(await allowedTools(freshGrant.access_token)).not.toContain('set_branding')
    }
    const staleRefresh = await refresh(freshGrant.refresh_token)
    expect(await allowedTools(staleRefresh.access_token)).not.toContain('set_branding')
    const renewedId = await renewBrowser(f.memberBrowser, 2, 3)
    const replacement = await issueKey(f.memberBrowser, 'full', renewedId)
    const replacementGrant = await oauth(f.memberBrowser, renewedId)
    expect((await request(branding, bearer(full.key))).status).toBe(403)
    expect((await request(branding, bearer(replacement.key))).status).toBe(200)
    expect((await mcpRequest(freshGrant.access_token, 'whoami')).status).toBe(401)
    const oldRefresh = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: staleRefresh.refresh_token,
    })
    expect(oldRefresh.status).toBe(400)
    const refreshed = await refresh(replacementGrant.refresh_token)
    expect(await allowedTools(refreshed.access_token)).toContain('set_branding')
    await expect(rpc(refreshed.access_token, 'set_branding', update)).resolves.toMatchObject({
      result: { structuredContent: update },
    })

    // Reach the write lock with an accepted credential, then commit revocation ahead of it.
    let raced: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', f.team.id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        raced = request(branding, bearer(replacement.key), 'PATCH', {
          brandPrimaryColor: '#334455',
        })
        await vi.waitFor(async () => {
          const { rows } = await database.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND wait_event_type = 'Lock' AND query ILIKE '%"auth"."organization"%'
            ) AS waiting`,
          )
          expect(rows[0]?.waiting).toBe(true)
        })
        await trx
          .deleteFrom('custom_role_assignments')
          .where('member_id', '=', f.memberId)
          .execute()
      })
    } finally {
      await raced
    }
    expect((await raced)?.status).toBe(403)
    expect(await allowedTools(replacement.key)).not.toContain('set_branding')
    const cached = await rpc(refreshed.access_token, 'set_branding', {
      brandPrimaryColor: '#334455',
    })
    expect(Boolean(cached.error || cached.result?.isError)).toBe(true)
    expect(
      (await cli(replacement.key, ['branding', 'set'], { brandPrimaryColor: '#334455' })).code,
    ).toBe(1)
    const unchanged = await request(branding, f.ownerBrowser.headers)
    expect(await unchanged.json()).toMatchObject(update)
  })

  it('keeps newly acquired Admin authority behind renewal and key replacement after native promotion', async () => {
    const f = await fixture()
    const legacy = await issueKey(f.memberBrowser, 'full')
    await changeMode(f.ownerBrowser, true, 0)
    await assignCoordinator(f)
    const reviewed = await renewBrowser(f.memberBrowser, 2, 1)
    const issued = await issueKey(f.memberBrowser, 'full', reviewed)
    expect((await request(branding, bearer(issued.key))).status).toBe(200)

    const setRole = (role: 'member' | 'admin') =>
      request('/api/auth/organization/update-member-role', f.ownerBrowser.headers, 'POST', {
        organizationId: f.team.id,
        memberId: f.memberId,
        role,
      })
    expect((await setRole('admin')).status).toBe(200)
    const audit = '/api/v1/audit-events'
    const ssoPolicy = '/api/v1/team/sso/policy'
    expect((await request(audit, f.memberBrowser.headers)).status).toBe(403)
    for (const { key } of [legacy, issued]) {
      expect((await request('/api/v1/bookings', bearer(key))).status).toBe(200)
      expect((await request(audit, bearer(key))).status).toBe(403)
      expect((await request(ssoPolicy, bearer(key))).status).toBe(403)
      expect(await allowedTools(key)).not.toContain('get_sso_policy')
      expect((await rpc(key, 'get_sso_policy')).result?.isError).toBe(true)
      expect((await rpc(key, 'list_audit_events')).result?.isError).toBe(true)
      expect((await cli(key, ['audit-log', 'list'])).code).toBe(1)
    }

    const adminReview = await renewBrowser(f.memberBrowser, 3, 1)
    expect((await request(audit, f.memberBrowser.headers)).status).toBe(200)
    const renewed = await issueKey(f.memberBrowser, 'full', adminReview)
    expect((await request(audit, bearer(renewed.key))).status).toBe(200)
    expect((await request(ssoPolicy, bearer(renewed.key))).status).toBe(200)
    expect((await request(audit, bearer(issued.key))).status).toBe(403)
    expect((await cli(renewed.key, ['audit-log', 'list'])).code).toBe(0)

    expect((await setRole('member')).status).toBe(200)
    expect((await setRole('admin')).status).toBe(200)
    expect((await request(audit, f.memberBrowser.headers)).status).toBe(403)
    expect((await request(audit, bearer(renewed.key))).status).toBe(403)
  })
})
