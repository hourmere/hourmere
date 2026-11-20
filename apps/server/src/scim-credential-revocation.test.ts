import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  createMcpOAuthResolver,
  MCP_OAUTH_SCOPE,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { suspendScimMembership } from '@hourmere/db/scim-suspension'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingNotifier } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { SignJWT } from 'jose'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prepareScimSuspension } from '../../../packages/db/src/scim-suspension-fixtures.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { bookingRoutes } from './routes/bookings.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const clientId = 'https://connector.example.test/client.json'
const signup = { mode: 'closed', allowedDomains: [] } as const
const capabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const secret = randomBytes(32).toString('base64url')

describe.skipIf(!serverUrl)('SCIM suspension and credential-authorized writes', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  const signer = generateKeyPairSync('ed25519')
  let kid: string
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'scim_cred_write' })
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool,
      baseURL: publicUrl,
      secret,
      signup,
      mcpOAuth: true,
      mailer: { send: async () => expect.unreachable('This test uses synthetic sessions') },
      mcpMetadataFetcher: async () => new Response(null, { status: 404 }),
    })
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://connector.example.test/callback']),
      })
      .execute()
    const signingKey = await db
      .insertInto('auth.jwks')
      .values({
        alg: 'EdDSA',
        publicKey: JSON.stringify(signer.publicKey.export({ format: 'jwk' })),
        privateKey: '{}',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    kid = signingKey.id
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db, 'Team owner')
    const member = await createTestUser(db, 'Booking host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const start = Temporal.Now.instant().add({ hours: 24 })
    const booking = (offset = 0) =>
      createFixtures(db).booking(
        team.id,
        [member.id],
        start.add({ hours: offset }).toString(),
        start.add({ hours: offset, minutes: 30 }).toString(),
      )
    const prepare = () =>
      db.transaction().execute((trx) => prepareScimSuspension(trx, team.id, member.id))
    return { member, team, booking, prepare }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function issueKey({ member, team }: Fixture) {
    const key = await auth.api.createApiKey({
      body: { userId: member.id, metadata: { organizationId: team.id, scope: 'bookings' } },
    })
    return key.key
  }

  async function issueGrant({ member, team }: Fixture) {
    const { id: grantId } = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: member.id, organization_id: team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: member.id,
        referenceId: grantId,
        scopes: JSON.stringify([MCP_OAUTH_SCOPE, 'offline_access']),
        resources: JSON.stringify([`${publicUrl}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const iat = Math.floor(Date.now() / 1000)
    return new SignJWT({
      sub: member.id,
      client_id: clientId,
      scope: `${MCP_OAUTH_SCOPE} offline_access`,
      iat,
      exp: iat + 300,
      iss: `${publicUrl}/api/auth`,
      aud: `${publicUrl}/mcp`,
      'https://hourmere.com/organization': team.id,
      'https://hourmere.com/grant': grantId,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
      .sign(signer.privateKey)
  }

  function app(notify?: BookingNotifier, teamWriteAccess = true) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
      publicUrl,
      routes: [bookingRoutes({ db, notify })],
      ssoTeamReads: teamWriteAccess ? { db, capabilities } : undefined,
      mcp: mcpEndpoint({
        tools: [whoamiTool, ...bookingTools({ db, notify })],
        oauth: {
          resolve: createMcpOAuthResolver({ auth, db, publicUrl, ssoCapabilities: capabilities }),
          handler: auth.handler,
        },
      }),
    })
  }

  type App = ReturnType<typeof app>

  function cancelBooking(instance: App, bookingId: string, headers: Record<string, string>) {
    return instance.request(`/api/v1/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    })
  }

  function mcp(instance: App, token: string, name: string, args = {}) {
    return instance.request(`${publicUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
  }

  async function mcpResult(response: Response) {
    expect(response.status).toBe(200)
    const body = await response.text()
    const data = body.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(data ? data.slice(6) : body).result as {
      isError?: boolean
      content: { text: string }[]
      structuredContent?: Record<string, unknown>
    }
  }

  const me = (instance: App, key: string) =>
    instance.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })

  const bookingState = (id: string) =>
    db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()

  const backend = async (connection: Db) =>
    (
      await connection
        .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
        .executeTakeFirstOrThrow()
    ).pid

  async function waitForOrganizationLock(blockingPid: number, lockMode: string) {
    await vi.waitFor(
      async () => {
        const { rows } = await owned.pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT FROM pg_stat_activity
             WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
               AND query LIKE '%"auth"."organization"%' AND query LIKE $2) AS blocked`,
          [blockingPid, `%${lockMode}%`],
        )
        expect(rows[0]?.blocked).toBe(true)
      },
      { timeout: 3000, interval: 20 },
    )
  }

  it.each([
    ['api_key', false],
    ['oauth', false],
    ['api_key', true],
    ['oauth', true],
  ] as const)(
    'rejects an admitted %s cancellation after revocation (blocker cleared: %s)',
    async (kind, cleared) => {
      const f = await fixture()
      const bookingId = await f.booking()
      const target = await f.prepare()
      const instance = app()
      const credential = kind === 'api_key' ? await issueKey(f) : await issueGrant(f)
      let pending: Promise<Response> | undefined
      try {
        await db.transaction().execute(async (trx) => {
          const pid = await backend(trx)
          await trx
            .selectFrom('auth.organization')
            .select('id')
            .where('id', '=', f.team.id)
            .forUpdate()
            .executeTakeFirstOrThrow()
          pending = Promise.resolve(
            kind === 'api_key'
              ? cancelBooking(instance, bookingId, { authorization: `Bearer ${credential}` })
              : mcp(instance, credential, 'cancel_booking', { bookingId }),
          )
          void pending.catch(() => {})
          // Authentication has admitted the request while the key or grant is still live.
          // PostgreSQL confirms the write is waiting at the team boundary before revocation.
          await waitForOrganizationLock(pid, 'for key share')
          const block = await suspendScimMembership(trx, target, { type: 'system' })
          // Model the storage state seen by a delayed write after a later reactivation.
          if (cleared)
            await trx
              .updateTable('scim_membership_blocks')
              .set({ cleared_at: sql`clock_timestamp()` })
              .where('id', '=', block.id)
              .execute()
        })
      } finally {
        await pending
      }
      if (!pending) throw new Error('Expected a pending booking cancellation')
      const response = await pending
      if (kind === 'api_key') {
        expect(response.status).toBe(cleared ? 401 : 403)
        expect(await response.json()).toMatchObject({
          error: cleared ? 'unauthorized' : 'sso_required',
        })
      } else {
        const result = await mcpResult(response)
        expect(result.isError).toBe(true)
        expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ error: 'sso_required' })
      }
      expect(await bookingState(bookingId)).toEqual({ status: 'confirmed' })
    },
  )

  it('lets the member’s already locked browser write finish before suspending that session', async () => {
    const f = await fixture()
    const bookingId = await f.booking()
    const target = await f.prepare()
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId: f.member.id,
          organizationId: f.team.id,
          now: new Date().toISOString(),
          headers: new Headers(),
        },
      ),
    )
    const writerReady = Promise.withResolvers<number>()
    const releaseWriter = Promise.withResolvers<void>()
    const instance = app(async (trx) => {
      await trx
        .selectFrom('auth.session')
        .select('id')
        .where('id', '=', session.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      writerReady.resolve(await backend(trx))
      await releaseWriter.promise
    })
    const writing = Promise.resolve(
      cancelBooking(instance, bookingId, {
        cookie: session.cookie.split(';')[0] as string,
        origin: publicUrl,
        'x-expected-organization-id': f.team.id,
      }),
    )
    let suspending: Promise<unknown> | undefined
    try {
      const pid = await Promise.race([
        writerReady.promise,
        writing.then((response) => {
          throw new Error(`The booking write finished with ${response.status} before locking`)
        }),
      ])
      suspending = db
        .transaction()
        .execute((trx) => suspendScimMembership(trx, target, { type: 'system' }))
      void suspending.catch(() => {})
      // The writer holds its session. Suspension must wait on the team before deleting it.
      await waitForOrganizationLock(pid, 'for update')
    } finally {
      releaseWriter.resolve()
      await Promise.allSettled([writing, suspending])
    }
    expect((await writing).status).toBe(200)
    await suspending
    expect(await bookingState(bookingId)).toEqual({ status: 'cancelled' })
    const remaining = await db
      .selectFrom('auth.session')
      .select('id')
      .where('id', '=', session.id)
      .executeTakeFirst()
    expect(remaining).toBeUndefined()
  })

  it('keeps both credential reads at two app-database statements and adds no team write SQL without SCIM', async () => {
    const f = await fixture()
    const key = await issueKey(f)
    const token = await issueGrant(f)
    const guarded = app()
    const baseline = app(undefined, false)

    statements.length = 0
    const identity = await me(guarded, key)
    expect(identity.status).toBe(200)
    expect(await identity.json()).toMatchObject({ organization: { id: f.team.id } })
    expect(statements).toHaveLength(2)

    statements.length = 0
    const who = await mcpResult(await mcp(guarded, token, 'whoami'))
    expect(who.structuredContent).toMatchObject({ organization: { id: f.team.id } })
    expect(statements).toHaveLength(2)

    for (const kind of ['api_key', 'oauth'] as const) {
      const trace = async (instance: App, bookingId: string) => {
        statements.length = 0
        if (kind === 'api_key') {
          const response = await cancelBooking(instance, bookingId, {
            authorization: `Bearer ${key}`,
          })
          expect(response.status).toBe(200)
        } else {
          const result = await mcpResult(
            await mcp(instance, token, 'cancel_booking', { bookingId }),
          )
          expect(result.isError ?? false).toBe(false)
        }
        return [...statements]
      }
      const legacy = await trace(baseline, await f.booking(kind === 'api_key' ? 0 : 2))
      expect(await trace(guarded, await f.booking(kind === 'api_key' ? 1 : 3))).toEqual(legacy)
    }
  })
})
