import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { productionAppOptions } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4386'
const secret = randomBytes(32).toString('base64')
const clientId = 'https://sso-read-compat.example.test/client.json'
const now = Temporal.Instant.from('2030-04-10T12:00:00Z')
const unavailable = async (): Promise<never> => {
  throw new Error('Team read reached an external dependency')
}
// The auth workspace owns the Better Auth JWT signer.
const { signJWT } = createRequire(import.meta.resolve('@hourmere/auth'))('better-auth/plugins/jwt')

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
type App = ReturnType<typeof createApp>
type CredentialHeaders = Record<string, string>

async function capture(response: Response) {
  return {
    status: response.status,
    statusText: response.statusText,
    // Keep exact cookie equality without printing a fixture credential on mismatch.
    headers: [...response.headers].map(([name, value]) => [
      name,
      name === 'set-cookie' ? createHash('sha256').update(value).digest('hex') : value,
    ]),
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

function mcpCall(
  app: App,
  headers: CredentialHeaders,
  name = 'list_bookings',
  args: Record<string, unknown> = {},
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
}

function mcpResult(body: string) {
  const data = body.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : body).result
}

describe.skipIf(!serverUrl)('SSO team read compatibility', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: App
  let legacy: App
  let fixture: Awaited<ReturnType<typeof seedTeam>>
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    const config = loadConfig({
      DATABASE_URL: owned.url,
      PUBLIC_URL: publicUrl,
      BETTER_AUTH_SECRET: secret,
      MCP_OAUTH_ENABLED: 'true',
    })
    authPool = createAuthPool(owned.url, config.signup)
    auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret,
      signup: config.signup,
      mailer: { send: unavailable },
      mcpOAuth: true,
      mcpMetadataFetcher: unavailable,
    })
    const options = productionAppOptions({
      config,
      db,
      auth,
      resolveCaller: createCallerResolver({ auth, db }),
      resolveMcpOAuth: createMcpOAuthResolver({ auth, db, publicUrl }),
      checkDb: unavailable,
      waitlist: { verify: unavailable, remove: unavailable },
      invitationMailLimits: { secret },
      webhookSettings: { enabled: false },
      webhookQueue: { enqueue: unavailable },
      notify: unavailable,
      notifyAttendeeNoShow: unavailable,
      googleCalendar: undefined,
      microsoftCalendar: undefined,
      zoomConference: undefined,
      enqueueCalendarSync: unavailable,
      enqueueCalendarWritebackRecovery: unavailable,
      mailboxProofQueue: { enqueue: unavailable },
    })
    app = createApp(options)
    // The same routes, records, authentication and transports, with the new hook omitted.
    const { ssoTeamReads: _ssoTeamReads, ...legacyOptions } = options
    legacy = createApp(legacyOptions)
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://sso-read-compat.example.test/callback']),
      })
      .execute()
    fixture = await seedTeam()
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function oauthFor(userId: string, organizationId: string): Promise<CredentialHeaders> {
    const { id: grantId } = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: userId, organization_id: organizationId, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId,
        referenceId: grantId,
        scopes: JSON.stringify(['mcp:tools']),
        resources: JSON.stringify([`${publicUrl}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const issuedAt = Math.floor(Date.now() / 1000)
    const token: string = await signJWT(
      { context: await auth.$context },
      {
        header: { typ: 'at+jwt' },
        payload: {
          sub: userId,
          client_id: clientId,
          scope: 'mcp:tools',
          iat: issuedAt,
          exp: issuedAt + 300,
          iss: `${publicUrl}/api/auth`,
          aud: `${publicUrl}/mcp`,
          'https://hourmere.com/organization': organizationId,
          'https://hourmere.com/grant': grantId,
        },
      },
    )
    return bearer(token)
  }

  async function seedTeam() {
    const owner = await createTestUser(db, 'SSO read owner')
    const member = await createTestUser(db, 'SSO read member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const f = createFixtures(db)
    const personalOrganizationId = owner.principal.organization.id
    const personalEventTypeId = await f.eventType(personalOrganizationId, owner.id, {
      slug: 'personal-intro',
    })
    const scheduleId = await f.schedule(owner.id, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(team.id, null, {
      slug: 'owner-intro',
      hosts: [{ userId: owner.id, scheduleId }],
    })
    const memberEventTypeId = await f.eventType(team.id, null, {
      slug: 'member-intro',
      hosts: [{ userId: member.id }],
    })
    const bookingId = await f.booking(
      team.id,
      [owner.id],
      '2030-04-11T13:00:00Z',
      '2030-04-11T13:30:00Z',
      { eventTypeId },
    )
    const { id: webhookId } = await db
      .insertInto('webhooks')
      .values({
        organization_id: team.id,
        url: 'https://hooks.example.test/',
        events: ['booking.created'],
        secret_ciphertext: Buffer.alloc(30, 1),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { secret, publicUrl },
        {
          userId: owner.id,
          organizationId: team.id,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const makeKey = async (organizationId: string, scope: 'full' | 'bookings' = 'full') =>
      bearer(
        (
          await auth.api.createApiKey({
            body: { userId: owner.id, metadata: { organizationId, scope } },
          })
        ).key,
      )
    return {
      teamId: team.id,
      memberId: member.id,
      eventTypeId,
      memberEventTypeId,
      bookingId,
      webhookId,
      personalEventTypeId,
      sessionId: session.id,
      browser: { cookie: session.cookie.split(';')[0] as string },
      teamKey: await makeKey(team.id),
      bookingsKey: await makeKey(team.id, 'bookings'),
      personalKey: await makeKey(personalOrganizationId),
      oauth: await oauthFor(owner.id, team.id),
    }
  }

  function policyStatements() {
    return statements.filter((statement) =>
      /\b(?:from|join)\s+(?:"?public"?\.)?"?sso_policies\b/i.test(statement),
    )
  }

  it('preserves the response bytes and headers of team reads without a policy', async () => {
    const clock = vi.spyOn(Temporal.Now, 'instant').mockReturnValue(now)
    const {
      browser,
      teamKey,
      bookingsKey,
      oauth,
      teamId,
      memberId,
      eventTypeId,
      memberEventTypeId,
      bookingId,
      webhookId,
      sessionId,
    } = fixture
    try {
      const rest = (app: App, path: string, headers: CredentialHeaders = browser) =>
        app.request(`/api/v1${path}`, { headers })
      const routes = [
        {
          name: 'own summary',
          request: (app: App) => rest(app, '/me'),
          example: teamId,
        },
        {
          name: 'event types',
          request: (app: App) => rest(app, '/event-types'),
          example: eventTypeId,
        },
        {
          name: 'bookings',
          request: (app: App) => rest(app, '/bookings'),
          example: bookingId,
        },
        {
          name: 'member departure impact',
          request: (app: App) =>
            rest(app, `/team/members/${memberId}/departure-impact?teamId=${teamId}`),
          example: memberEventTypeId,
        },
        {
          name: 'private availability',
          request: (app: App) =>
            rest(
              app,
              `/event-types/${eventTypeId}/availability-troubleshooting?date=2030-04-11&timeZone=UTC`,
            ),
          example: eventTypeId,
        },
        {
          name: 'webhooks',
          request: (app: App) => rest(app, '/webhooks'),
          example: webhookId,
        },
        {
          name: 'API key',
          request: (app: App) => rest(app, '/event-types', teamKey),
          example: eventTypeId,
        },
        {
          name: 'MCP API key',
          request: (app: App) => mcpCall(app, teamKey),
          example: bookingId,
        },
        {
          name: 'MCP OAuth',
          request: (app: App) => mcpCall(app, oauth),
          example: bookingId,
        },
      ]
      for (const { name, request, example } of routes) {
        statements.length = 0
        const before = await capture(await request(legacy))
        const previousQueryCount = statements.length
        statements.length = 0
        const after = await capture(await request(app))
        expect(after.status, name).toBe(200)
        expect(new TextDecoder().decode(after.bytes), name).toContain(example)
        expect(after, name).toEqual(before)
        expect(policyStatements(), name).toHaveLength(1)
        const machine = name === 'API key' || name.startsWith('MCP')
        expect(statements, name).toHaveLength(previousQueryCount + (machine ? 0 : 1))
        expect(
          statements.some((statement) => statement.includes('sso_delegation_bindings')),
          name,
        ).toBe(false)
      }
      const errors = [
        {
          path: '/event-types/not-a-uuid',
          headers: browser,
          status: 404,
          body: '{"error":"event_type_not_found"}',
        },
        {
          path: '/webhooks',
          headers: bookingsKey,
          status: 403,
          body: '{"error":"insufficient_scope","message":"This API key does not allow this operation."}',
        },
        {
          path: '/event-types',
          headers: {},
          status: 401,
          body: '{"error":"unauthorized"}',
        },
      ]
      for (const { path, headers, status, body } of errors) {
        const before = await capture(await rest(legacy, path, headers))
        const after = await capture(await rest(app, path, headers))
        expect(after.status, path).toBe(status)
        expect(new TextDecoder().decode(after.bytes), path).toBe(body)
        expect(after, path).toEqual(before)
      }

      // Credential resolution renews a near-expiry session. Reset its stored deadline
      // between apps so they both exercise the renewal and emit the signed cookie.
      async function prepareRenewal() {
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(Date.now() + 3_600_000) })
          .where('id', '=', sessionId)
          .execute()
      }
      await prepareRenewal()
      const before = await capture(await rest(legacy, '/event-types'))
      expect(before.headers.some(([name]) => name === 'set-cookie')).toBe(true)
      await prepareRenewal()
      expect(await capture(await rest(app, '/event-types'))).toEqual(before)
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses unbound API keys and MCP OAuth without a redirect, and skips personal lookups', async () => {
    const { teamId, teamKey, personalKey, personalEventTypeId, oauth } = await seedTeam()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: teamId, require_sso: true })
      .execute()

    statements.length = 0
    const response = await app.request('/api/v1/event-types', { headers: teamKey })
    expect(response.status).toBe(403)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.json()).toEqual({ error: 'sso_required' })
    expect(policyStatements()).toHaveLength(1)

    statements.length = 0
    const head = await app.request('/api/v1/event-types', { method: 'HEAD', headers: teamKey })
    expect(head.status).toBe(403)
    expect(await head.text()).toBe('')
    expect(policyStatements()).toHaveLength(1)

    statements.length = 0
    const readPost = await app.request('/api/v1/open-time-snippets', {
      method: 'POST',
      headers: { ...teamKey, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(readPost.status).toBe(403)
    expect(await readPost.json()).toEqual({ error: 'sso_required' })
    expect(policyStatements()).toHaveLength(1)

    for (const headers of [teamKey, oauth]) {
      statements.length = 0
      const response = await mcpCall(app, headers)
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(mcpResult(await response.text())).toEqual({
        isError: true,
        content: [{ type: 'text', text: '{"error":"sso_required"}' }],
      })
      expect(policyStatements()).toHaveLength(1)
      expect(statements.some((statement) => statement.includes('sso_delegation_bindings'))).toBe(
        false,
      )
    }

    statements.length = 0
    const personal = await app.request('/api/v1/event-types', { headers: personalKey })
    expect(personal.status).toBe(200)
    expect(await personal.text()).toContain(personalEventTypeId)
    expect(policyStatements()).toHaveLength(1)

    statements.length = 0
    const personalMcp = await mcpCall(app, personalKey)
    expect(personalMcp.status).toBe(200)
    expect(mcpResult(await personalMcp.text())).toMatchObject({
      structuredContent: { data: [] },
    })
    expect(policyStatements()).toHaveLength(1)
  })

  it('answers workflows_disabled before the team proof check on workflow reads', async () => {
    const { teamId, teamKey } = await seedTeam()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: teamId, require_sso: true })
      .execute()
    const id = randomUUID()
    for (const path of [`/workflows/${id}`, `/workflows/${id}/runs`]) {
      statements.length = 0
      const response = await app.request(`/api/v1${path}`, { headers: teamKey })
      expect(response.status, path).toBe(404)
      expect(await response.json(), path).toMatchObject({ error: 'workflows_disabled' })
      // The only match is the API-key lookup, which carries the delegation status;
      // no separate team proof lookup runs before workflows_disabled.
      expect(policyStatements(), path).toHaveLength(1)
    }
    for (const tool of ['get_workflow', 'list_workflow_runs']) {
      statements.length = 0
      const response = await mcpCall(app, teamKey, tool, { id })
      expect(mcpResult(await response.text()), tool).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('"workflows_disabled"') }],
      })
      expect(policyStatements(), tool).toHaveLength(1)
    }
  })

  it('refuses host and configuration MCP writes from unbound credentials', async () => {
    const { teamId, teamKey, oauth, bookingId, eventTypeId, webhookId } = await seedTeam()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: teamId, require_sso: true })
      .execute()

    const start = '2030-04-11T14:00:00Z'
    const writes = [
      ['cancel_booking', { bookingId }],
      ['reschedule_booking', { bookingId, start }],
      ['retry_conference', { bookingId }],
      ['retry_calendar_copy', { bookingId }],
      ['close_meeting_poll', { id: eventTypeId, expectedHostRevision: 1 }],
      ['remove_unverified_meeting_poll_voters', { id: eventTypeId, expectedHostRevision: 1 }],
      ['update_event_type', { id: eventTypeId, title: 'Changed' }],
      ['set_event_type_waitlist', { id: eventTypeId, enabled: true }],
      ['revoke_one_time_link', { eventTypeId, id: eventTypeId }],
      ['set_branding', { brandPrimaryColor: '#aa0000' }],
      ['set_audit_log_settings', { retention: 'days', retentionDays: 60 }],
      ['delete_webhook', { id: webhookId }],
      ['test_slack_destination', { id: webhookId }],
    ] as const
    for (const headers of [teamKey, oauth]) {
      for (const [tool, args] of writes) {
        statements.length = 0
        const response = await mcpCall(app, headers, tool, args)
        expect(response.status, tool).toBe(200)
        expect(response.headers.get('location'), tool).toBeNull()
        expect(mcpResult(await response.text()), tool).toEqual({
          isError: true,
          content: [{ type: 'text', text: '{"error":"sso_required"}' }],
        })
        expect(policyStatements(), tool).toHaveLength(1)
      }

      // These same tools still take the established capability path as the invitee.
      const manageToken = 'missing-manage-token'
      for (const [tool, args] of [
        ['cancel_booking', { manageToken }],
        ['reschedule_booking', { manageToken, start }],
      ] as const) {
        statements.length = 0
        const response = await mcpCall(app, headers, tool, args)
        expect(response.status, tool).toBe(200)
        expect(mcpResult(await response.text()), tool).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: expect.stringContaining('"booking_not_found"') }],
        })
        // Machine credentials project their own policy in the authentication query.
        expect(policyStatements(), tool).toHaveLength(1)
      }
    }
  })
})
