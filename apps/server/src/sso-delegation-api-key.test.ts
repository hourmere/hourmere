import { randomBytes } from 'node:crypto'
import {
  type CallerResolver,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  ensurePersonalOrganization,
  type SsoDelegationStatus,
  ssoDelegationStatus,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { suspendScimMember } from '../../../packages/db/src/scim-suspension-fixtures.ts'
import {
  bindingValues,
  type IdentityFixture,
  identityFixture,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { insert } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { whoamiTool } from './mcp/whoami.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const enabled = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const disabled = { ssoOidcEnabled: false, ssoSamlEnabled: false }

describe.skipIf(!serverUrl)('SSO delegation on the REST API-key path', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: IdentityFixture
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'key_sso' })
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    authPool = createAuthPool(owned.url, signup, { connectionTimeoutMillis: 5000 })
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('This test needs no mail') },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  beforeEach(async () => {
    const client = await owned.pool.connect()
    try {
      fixture = await identityFixture(client)
    } finally {
      client.release()
    }
  })

  function instance(
    capabilities = enabled,
    enforce = true,
    resolveCaller = createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
  ) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller,
      publicUrl,
      mcp: mcpEndpoint({ tools: [whoamiTool] }),
      ...(enforce && { ssoTeamReads: { db, capabilities } }),
    })
  }

  async function key(organizationId = fixture.team, userId = fixture.member) {
    const { id, key } = await auth.api.createApiKey({
      body: {
        userId,
        name: 'Synthetic delegation key',
        metadata: { organizationId, scope: 'read' },
      },
    })
    return { id, headers: { authorization: `Bearer ${key}` } }
  }

  const me = (app: ReturnType<typeof instance>, headers: Record<string, string>) =>
    app.request(new URL('/api/v1/me', publicUrl), { headers, redirect: 'manual' })

  const mcpWhoami = (app: ReturnType<typeof instance>, headers: Record<string, string>) =>
    app.request('/mcp', {
      method: 'POST',
      headers: {
        ...headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    })

  async function expectRefused(response: Response) {
    expect(response.status).toBe(403)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toBe('{"error":"sso_required"}')
  }

  async function policy(requireSso = true) {
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: requireSso })
      .execute()
  }

  async function bind(id: string) {
    const client = await owned.pool.connect()
    try {
      return await insert(
        client,
        'sso_delegation_bindings',
        bindingValues(fixture, { api_key_id: id }),
      )
    } finally {
      client.release()
    }
  }

  async function joinOtherTeam() {
    await db
      .insertInto('auth.member')
      .values({
        userId: fixture.member,
        organizationId: fixture.otherTeam,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
  }

  const move = (id: string, organizationId: string) =>
    auth.api.updateApiKey({
      body: { keyId: id, userId: fixture.member, metadata: { organizationId } },
    })

  async function waitForBlockedTransaction(blocker: PoolClient) {
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid
    expect(pid).toBeDefined()
    await expect
      .poll(
        async () =>
          (
            await owned.pool.query<{ waiting: boolean }>(
              `SELECT EXISTS (
                 SELECT FROM pg_stat_activity
                 WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
               ) AS waiting`,
              [pid],
            )
          ).rows[0]?.waiting,
        { timeout: 5000 },
      )
      .toBe(true)
  }

  it('keeps successful response bytes and two caller queries for team keys', async () => {
    const credential = await key()
    async function outcome(app: ReturnType<typeof instance>) {
      statements.length = 0
      const response = await me(app, credential.headers)
      return { status: response.status, bytes: await response.text(), queries: statements.length }
    }

    const previous = await outcome(instance(disabled, false))
    expect(previous.status).toBe(200)
    // Persisted key metadata and member/key/organization lookup, with no SSO round-trip.
    expect(previous.queries).toBe(2)
    expect(await outcome(instance(disabled))).toEqual(previous)
    expect(await outcome(instance())).toEqual(previous)
    await policy(false)
    expect(await outcome(instance())).toEqual(previous)

    statements.length = 0
    const mcp = await mcpWhoami(instance(), credential.headers)
    expect(mcp.status).toBe(200)
    expect(await mcp.text()).toContain(fixture.team)
    expect(statements).toHaveLength(2)
  })

  it('keeps browser session authorization within its existing membership and team policy queries', async () => {
    const personal = await ensurePersonalOrganization(db, fixture.member)
    const app = instance(disabled)
    for (const [organizationId, queryCount] of [
      [fixture.team, 2],
      [personal, 1],
    ] as const) {
      const session = await db.transaction().execute((trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          {
            userId: fixture.member,
            organizationId,
            now: new Date().toISOString(),
            headers: new Headers(),
          },
        ),
      )
      statements.length = 0
      const response = await me(app, { cookie: session.cookie.split(';')[0] as string })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ organization: { id: organizationId } })
      expect(statements).toHaveLength(queryCount)
    }
  })

  it.each([
    { kind: 'ordinary', enforced: false },
    { kind: 'delegated', enforced: true },
  ])('refuses a suspended team for an $kind API key in REST and MCP', async ({ enforced }) => {
    const credential = await key()
    const personal = await ensurePersonalOrganization(db, fixture.member)
    await joinOtherTeam()
    const personalKey = await key(personal)
    const otherTeamKey = await key(fixture.otherTeam)
    const otherMemberKey = await key(fixture.team, fixture.owner)
    const capabilities = enforced ? enabled : disabled
    const app = instance(capabilities)
    if (enforced) {
      await policy()
      await bind(credential.id)
    }
    async function expectAccess(headers: Record<string, string>, organizationId: string) {
      const rest = await me(app, headers)
      expect(rest.status).toBe(200)
      expect(await rest.json()).toMatchObject({ organization: { id: organizationId } })
      const mcp = await mcpWhoami(app, headers)
      expect(mcp.status).toBe(200)
      expect(await mcp.text()).toContain(organizationId)
    }

    await expectAccess(credential.headers, fixture.team)
    const resolvedRest = Promise.withResolvers<Awaited<ReturnType<CallerResolver>>>()
    const resolvedMcp = Promise.withResolvers<Awaited<ReturnType<CallerResolver>>>()
    const release = Promise.withResolvers<void>()
    const resolveCaller = createCallerResolver({ auth, db, ssoCapabilities: capabilities })
    const pauseAfterResolution =
      (resolved: typeof resolvedRest): CallerResolver =>
      async (headers) => {
        const result = await resolveCaller(headers)
        resolved.resolve(result)
        await release.promise
        return result
      }
    const pendingRest = me(
      instance(capabilities, true, pauseAfterResolution(resolvedRest)),
      credential.headers,
    )
    const pendingMcp = mcpWhoami(
      instance(capabilities, true, pauseAfterResolution(resolvedMcp)),
      credential.headers,
    )
    try {
      for (const decision of await Promise.all([resolvedRest.promise, resolvedMcp.promise]))
        expect(decision).toMatchObject({
          ok: true,
          principal: { ssoDelegationStatus: enforced ? 'valid' : null },
        })
      await suspendScimMember(db, fixture.team, fixture.member, { revoke: true })
    } finally {
      release.resolve()
    }
    const [inFlightRest, inFlightMcp] = await Promise.all([pendingRest, pendingMcp])
    expect(inFlightRest.status).toBe(200)
    expect(await inFlightRest.json()).toMatchObject({ organization: { id: fixture.team } })
    expect(inFlightMcp.status).toBe(200)
    expect(await inFlightMcp.text()).toContain(fixture.team)
    const rest = await me(app, credential.headers)
    expect(rest.status).toBe(401)
    expect(await rest.json()).toEqual({ error: 'unauthorized' })
    const mcp = await mcpWhoami(app, credential.headers)
    expect(mcp.status).toBe(401)
    expect(await mcp.json()).toMatchObject({ error: 'unauthorized' })
    await expectAccess(personalKey.headers, personal)
    await expectAccess(otherTeamKey.headers, fixture.otherTeam)
    if (!enforced) await expectAccess(otherMemberKey.headers, fixture.team)
  })

  it('denies an unbound key on a seeded enforced team even with both protocols off', async () => {
    const credential = await key()
    const unbound = await key()
    const on = instance()
    const off = instance(disabled)
    await policy()

    await expectRefused(await me(off, credential.headers))
    await expectRefused(await me(on, credential.headers))
    await bind(credential.id)
    const response = await me(on, credential.headers)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      principal: { apiKeyScope: 'read' },
      organization: { id: fixture.team },
    })
    await expectRefused(await me(on, unbound.headers))
    await expectRefused(await me(off, credential.headers))
  })

  it('rechecks the persisted key organization when evaluating a stale binding', async () => {
    const { id } = await key()
    await joinOtherTeam()
    await policy()
    await bind(id)
    const decision = () =>
      sql<{
        status: SsoDelegationStatus
      }>`SELECT ${ssoDelegationStatus(
        sql<string>`${fixture.team}`,
        sql<string>`${fixture.member}`,
        'api_key',
        sql<string>`${id}`,
        enabled,
      )} AS status`.execute(db)
    await expect(decision()).resolves.toMatchObject({ rows: [{ status: 'valid' }] })
    // Model a stale lease left by an older process that rewrote the key directly.
    await db
      .updateTable('auth.apikey')
      .set({ metadata: JSON.stringify({ organizationId: fixture.otherTeam, scope: 'read' }) })
      .where('id', '=', id)
      .execute()
    await expect(decision()).resolves.toMatchObject({ rows: [{ status: 'required' }] })
  })

  it('deletes a binding that commits while a native key move waits and never revives it', async () => {
    const credential = await key()
    await joinOtherTeam()
    await policy()
    const app = instance()

    const binder = await owned.pool.connect()
    let pending: ReturnType<typeof move> | undefined
    try {
      await binder.query('BEGIN')
      await binder.query('SELECT id FROM auth.apikey WHERE id = $1 FOR SHARE', [credential.id])
      pending = move(credential.id, fixture.otherTeam)
      void pending.catch(() => {})
      await waitForBlockedTransaction(binder)
      await insert(
        binder,
        'sso_delegation_bindings',
        bindingValues(fixture, { api_key_id: credential.id }),
      )
      await binder.query('COMMIT')
    } finally {
      await binder.query('ROLLBACK')
      binder.release()
    }
    await expect(pending).resolves.toMatchObject({
      metadata: { organizationId: fixture.otherTeam, scope: 'read' },
    })
    expect(
      await db
        .selectFrom('sso_delegation_bindings')
        .select('id')
        .where('api_key_id', '=', credential.id)
        .executeTakeFirst(),
    ).toBeUndefined()
    const other = await me(app, credential.headers)
    expect(other.status).toBe(200)
    expect(await other.json()).toMatchObject({ organization: { id: fixture.otherTeam } })
    await move(credential.id, fixture.team)
    await expectRefused(await me(app, credential.headers))
  })

  it('keeps the old key organization visible until binding deletion can commit', async () => {
    const { id } = await key()
    await joinOtherTeam()
    await bind(id)
    const organization = async () =>
      (
        await owned.pool.query<{ organization: string }>(
          `SELECT metadata::jsonb ->> 'organizationId' AS organization
           FROM auth.apikey WHERE id = $1`,
          [id],
        )
      ).rows[0]?.organization

    const blocker = await owned.pool.connect()
    let pending: ReturnType<typeof move> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM sso_delegation_bindings WHERE api_key_id = $1 FOR UPDATE',
        [id],
      )
      pending = move(id, fixture.otherTeam)
      void pending.catch(() => {})
      await waitForBlockedTransaction(blocker)
      await expect(organization()).resolves.toBe(fixture.team)
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await expect(pending).resolves.toMatchObject({
      metadata: { organizationId: fixture.otherTeam, scope: 'read' },
    })
    await expect(organization()).resolves.toBe(fixture.otherTeam)
  })
})
