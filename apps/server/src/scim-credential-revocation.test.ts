import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
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
import { SCIM_ERROR_SCHEMA } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { scimUserReplacement } from './scim-user-replace.ts'

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
      scimResourcesEnabled: true,
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

  async function fixture(role = 'member') {
    const owner = await createTestUser(db, 'Team owner')
    const member = await createTestUser(db, 'Booking host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role },
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
    return { owner, member, team, booking, prepare }
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

  function app(notify?: BookingNotifier, teamWriteAccess = true, scimResources = false) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
      publicUrl,
      routes: [bookingRoutes({ db, notify })],
      ...(scimResources && { scim: { db, enabled: true, resources: scimUserReplacement(db) } }),
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

  async function provision(f: Fixture) {
    const target = await f.prepare()
    await db
      .updateTable('scim_users')
      .set({ active: true })
      .where('id', '=', target.scimUserId)
      .execute()
    const bearer = `scim_${randomBytes(32).toString('base64url')}`
    const { id: tokenId } = await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: f.team.id,
        name: 'Synthetic IdP',
        token_hash: createHash('sha256').update(bearer).digest('base64url'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const instance = app(undefined, true, true)
    const request = (method: 'PUT' | 'PATCH', body: unknown) =>
      instance.request(`${publicUrl}/scim/v2/${f.team.id}/Users/${target.scimUserId}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/scim+json' },
        body: JSON.stringify(body),
      })
    return {
      ...target,
      tokenId,
      instance,
      put: (attributes: Record<string, unknown>) =>
        request('PUT', { schemas: [SCIM_URN.user], userName: f.member.email, ...attributes }),
      patch: (...operations: unknown[]) =>
        request('PATCH', {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: operations,
        }),
      entry: () =>
        db
          .selectFrom('scim_users')
          .selectAll()
          .where('id', '=', target.scimUserId)
          .executeTakeFirstOrThrow(),
      blocks: () =>
        db
          .selectFrom('scim_membership_blocks')
          .selectAll()
          .where('organization_id', '=', f.team.id)
          .orderBy('id')
          .execute(),
      events: () =>
        db
          .selectFrom('audit_events')
          .select(['action', 'actor_type', 'actor_id', 'details'])
          .where('target_id', '=', target.scimUserId)
          .orderBy('id')
          .execute(),
    }
  }

  async function expectScimError(response: Response, status: number, scimType?: string) {
    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toBe('application/scim+json')
    expect(await response.json()).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail: expect.any(String),
      ...(scimType ? { scimType } : {}),
    })
  }

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

  it.each(['owner', 'admin', 'member, admin'])(
    'refuses SCIM deactivation and demotion of %s',
    async (role) => {
      const f = await fixture(role)
      const user = await provision(f)
      const before = await user.entry()
      for (const response of [
        await user.put({ active: false, title: 'Must roll back' }),
        await user.put({ roles: [] }),
        await user.patch({ op: 'replace', value: { active: 'False' } }),
        await user.patch(
          { op: 'replace', path: 'active', value: false },
          { op: 'replace', path: 'active', value: true },
        ),
        await user.patch({ op: 'replace', path: 'roles', value: [] }),
        await user.patch({ op: 'remove', path: 'roles[value eq "admin"]' }),
      ])
        await expectScimError(response, 403, 'mutability')
      expect(await user.entry()).toEqual(before)
      expect(await user.blocks()).toEqual([])
      expect(await user.events()).toEqual([])
    },
  )

  it.each([
    ['member', 'admin', 403],
    ['admin', 'member', 200],
  ] as const)(
    'waits on the organization for a local %s → %s role change',
    async (from, to, status) => {
      const f = await fixture(from)
      const user = await provision(f)
      const { linked_member_id: memberId } = await user.entry()
      if (!memberId) throw new Error('Expected the membership link')
      const ownerSession = await db.transaction().execute((trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          {
            userId: f.owner.id,
            organizationId: f.team.id,
            now: new Date().toISOString(),
            headers: new Headers(),
          },
        ),
      )
      const stalled = await owned.pool.connect()
      let local: Promise<Response> | undefined
      let remote: Promise<Response> | undefined
      try {
        await stalled.query('BEGIN')
        const blocker = await stalled.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        // Stall the native role writer after it has acquired the organization lock.
        await stalled.query('SELECT id FROM auth.member WHERE id=$1 FOR UPDATE', [memberId])
        local = Promise.resolve(
          user.instance.request(`${publicUrl}/api/auth/organization/update-member-role`, {
            method: 'POST',
            headers: {
              origin: publicUrl,
              cookie: ownerSession.cookie.split(';')[0] as string,
              'content-type': 'application/json',
              'x-expected-organization-id': f.team.id,
            },
            body: JSON.stringify({ organizationId: f.team.id, memberId, role: to }),
          }),
        )
        const nativePid = await vi.waitFor(
          async () => {
            const waiting = await owned.pool.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%"auth"."member"%'`,
              [blocker.rows[0]?.pid],
            )
            expect(waiting.rows).toHaveLength(1)
            return waiting.rows[0]?.pid as number
          },
          { timeout: 3000, interval: 20 },
        )
        remote = Promise.resolve(user.put({ active: false }))
        await waitForOrganizationLock(nativePid, 'for update')
      } finally {
        await stalled.query('ROLLBACK')
        stalled.release()
        await Promise.allSettled([local, remote])
      }
      expect((await local)?.status).toBe(200)
      const response = await remote
      if (!response) throw new Error('Expected a SCIM request')
      expect(response.status).toBe(status)
      if (status === 403) await expectScimError(response, 403, 'mutability')
      expect((await user.entry()).active).toBe(status === 403)
      expect(await user.blocks()).toHaveLength(status === 403 ? 0 : 1)
    },
  )

  it.each(['linked account suspension', 'verified mailbox removal', 'removed membership'] as const)(
    'honors a local %s on reactivation',
    async (blocker) => {
      const f = await fixture()
      const user = await provision(f)
      expect((await user.put({ active: false })).status).toBe(200)
      if (blocker === 'removed membership') {
        await db
          .deleteFrom('auth.member')
          .where('userId', '=', f.member.id)
          .where('organizationId', '=', f.team.id)
          .execute()
      } else {
        await db
          .insertInto('scim_membership_blocks')
          .values({
            organization_id: f.team.id,
            source: 'local',
            ...(blocker === 'linked account suspension'
              ? { user_id: f.member.id, kind: 'suspension' }
              : { identity_email: f.member.email, kind: 'removal' }),
          })
          .execute()
      }
      const before = await user.entry()
      const blocks = await user.blocks()
      const events = await user.events()
      await expectScimError(
        await user.patch({ op: 'replace', value: { active: 'True', title: 'Must roll back' } }),
        403,
        'mutability',
      )
      expect(await user.entry()).toEqual(before)
      expect(await user.blocks()).toEqual(blocks)
      expect(await user.events()).toEqual(events)
      if (blocker === 'removed membership') expect(before.linked_member_id).toBeNull()
    },
  )

  it('reactivates the linked account after local reinstatement and blocker clearance', async () => {
    const f = await fixture()
    const user = await provision(f)
    expect((await user.put({ active: false })).status).toBe(200)
    const membership = await db
      .deleteFrom('auth.member')
      .where('userId', '=', f.member.id)
      .where('organizationId', '=', f.team.id)
      .returning(['userId', 'organizationId', 'role', 'createdAt'])
      .executeTakeFirstOrThrow()
    const local = await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.team.id,
        identity_email: f.member.email,
        source: 'local',
        kind: 'removal',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    // Model a local administrator explicitly restoring membership and clearing its own blocker.
    const restored = await db
      .insertInto('auth.member')
      .values(membership)
      .returning('id')
      .executeTakeFirstOrThrow()
    await expectScimError(await user.put({ active: true }), 403, 'mutability')
    await db
      .updateTable('scim_membership_blocks')
      .set({ cleared_at: sql`clock_timestamp()` })
      .where('id', '=', local.id)
      .execute()
    expect((await user.put({ active: true })).status).toBe(200)
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('userId', '=', f.member.id)
        .where('organizationId', '=', f.team.id)
        .execute(),
    ).toEqual([restored])
    expect(await user.entry()).toMatchObject({
      active: true,
      linked_user_id: f.member.id,
      linked_member_id: null,
    })
  })

  it('waits for a concurrent local suspension before deciding a SCIM reactivation', async () => {
    const f = await fixture()
    const user = await provision(f)
    expect((await user.put({ active: false })).status).toBe(200)
    const before = await user.entry()
    const [scimBlock] = await user.blocks()
    const events = await user.events()

    let reactivation: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', f.team.id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('scim_membership_blocks')
          .values({
            organization_id: f.team.id,
            user_id: f.member.id,
            source: 'local',
            kind: 'suspension',
          })
          .execute()
        reactivation = Promise.resolve(
          user.patch({ op: 'replace', value: { active: true, title: 'Must roll back' } }),
        )
        await waitForOrganizationLock(await backend(trx), 'for update')
      })
    } finally {
      await Promise.allSettled([reactivation])
    }
    if (!reactivation) throw new Error('Expected a SCIM reactivation request')
    await expectScimError(await reactivation, 403, 'mutability')
    expect(await user.entry()).toEqual(before)
    expect(await user.events()).toEqual(events)
    expect(await user.blocks()).toEqual([
      scimBlock,
      expect.objectContaining({ source: 'local', kind: 'suspension', cleared_at: null }),
    ])
  })

  it('reactivates access without restoring an old key or OAuth grant', async () => {
    const f = await fixture()
    const user = await provision(f)
    const key = await issueKey(f)
    const grant = await issueGrant(f)
    const keyStatus = async (token: string) => (await me(user.instance, token)).status
    const oauthOrganization = async (token: string) =>
      (await mcpResult(await mcp(user.instance, token, 'whoami'))).structuredContent?.organization

    expect(await keyStatus(key)).toBe(200)
    expect(await oauthOrganization(grant)).toMatchObject({ id: f.team.id })
    const deactivated = await user.patch({ op: 'Replace', value: { active: 'False' } })
    expect(deactivated.status).toBe(200)
    expect(await deactivated.json()).toMatchObject({ active: false })
    const inactive = await user.entry()
    expect((await user.put({ active: false })).status).toBe(200)
    expect(await user.entry()).toEqual(inactive)

    const reactivated = await user.put({ active: true })
    expect(reactivated.status).toBe(200)
    expect(await reactivated.json()).toMatchObject({ active: true })
    expect(await user.blocks()).toEqual([
      expect.objectContaining({ source: 'scim', cleared_at: expect.anything() }),
    ])
    const oauthStatus = async (token: string) => (await mcp(user.instance, token, 'whoami')).status
    expect(await Promise.all([keyStatus(key), oauthStatus(grant)])).toEqual([401, 401])
    expect(await keyStatus(await issueKey(f))).toBe(200)
    expect(await oauthOrganization(await issueGrant(f))).toMatchObject({ id: f.team.id })
    expect(await user.events()).toEqual(
      ['scim_user.credentials_revoked', 'scim_user.deactivated', 'scim_user.reactivated'].map(
        (action) => ({
          action,
          actor_type: 'scim_token',
          actor_id: user.tokenId,
          details: {},
        }),
      ),
    )
  })

  it.each([false, true])('rolls back active=%s when its lifecycle audit fails', async (active) => {
    const f = await fixture()
    const user = await provision(f)
    const key = await issueKey(f)
    if (active) expect((await user.put({ active: false })).status).toBe(200)
    const entry = await user.entry()
    const blocks = await user.blocks()
    const events = await user.events()
    const action = active ? 'scim_user.reactivated' : 'scim_user.deactivated'
    await sql`CREATE FUNCTION refuse_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected lifecycle audit failure'; END $$`.execute(db)
    try {
      await sql`CREATE TRIGGER refuse_lifecycle_audit BEFORE INSERT ON audit_events
        FOR EACH ROW WHEN (NEW.action = ${sql.lit(action)}) EXECUTE FUNCTION refuse_lifecycle_audit()`.execute(
        db,
      )
      await expectScimError(await user.put({ active, title: 'Must roll back' }), 500)
      expect(await user.entry()).toEqual(entry)
      expect(await user.blocks()).toEqual(blocks)
      expect(await user.events()).toEqual(events)
      expect((await me(user.instance, key)).status).toBe(active ? 401 : 200)
    } finally {
      await sql`DROP TRIGGER IF EXISTS refuse_lifecycle_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION refuse_lifecycle_audit()`.execute(db)
    }
  })

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
