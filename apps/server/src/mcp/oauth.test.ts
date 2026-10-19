import { randomBytes, randomUUID } from 'node:crypto'
import { CLIENT_IP_HEADER, type Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { mcpOAuthBroker, mcpOAuthRoutes } from './oauth.ts'

const serverUrl = process.env.DATABASE_URL
const BASE = 'https://hourmere.test'
const CALLBACK = 'https://connector.test/callback'
const query = (clientId: string) =>
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: 'code',
    resource: `${BASE}/mcp`,
    scope: 'mcp:tools offline_access',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    sig: 'synthetic-provider-verified-signature',
    exp: String(Math.floor(Date.now() / 1000) + 300),
  })

describe.skipIf(!serverUrl)('MCP OAuth broker guards', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture() {
    const user = await createTestUser(db)
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const clientId = `synthetic-${randomUUID()}`
    await db
      .insertInto('auth.oauthClient')
      .values({ clientId, redirectUris: JSON.stringify([CALLBACK]) })
      .execute()
    const principal: Extract<Principal, { kind: 'session' }> = {
      ...user.principal,
      kind: 'session',
      sessionId: row.id,
    }
    const calls: Request[] = []
    const auth = {
      handler: async (request: Request) => {
        calls.push(request)
        const path = new URL(request.url).pathname
        if (path.endsWith('/public-client-prelogin'))
          return Response.json({ client_id: clientId, client_name: 'Synthetic connector' })
        const { oauth_query: oauthQuery } = (await request.json()) as { oauth_query: string }
        return Response.json({
          url: path.endsWith('/continue')
            ? `${BASE}/oauth/consent?${oauthQuery}`
            : `${CALLBACK}?code=synthetic-code`,
        })
      },
    }
    const broker = mcpOAuthBroker({ auth, db, publicUrl: BASE })
    const q = query(clientId)
    const headers = new Headers({
      cookie: 'synthetic-session-cookie',
      authorization: 'Bearer never-forward',
      origin: BASE,
      [CLIENT_IP_HEADER]: '203.0.113.254',
    })
    return { user, principal, clientId, calls, auth, broker, q, headers }
  }
  it('rejects resource, PKCE, scope and duplicate tampering before consulting even a permissive provider', async () => {
    const f = await fixture()
    const mutations = [
      (q: URLSearchParams) => q.set('resource', 'https://other.test/mcp'),
      (q: URLSearchParams) => q.set('code_challenge_method', 'plain'),
      (q: URLSearchParams) => q.set('scope', 'mcp:tools admin'),
      (q: URLSearchParams) => q.append('client_id', f.clientId),
    ]
    for (const change of mutations) {
      const q = new URLSearchParams(f.q)
      change(q)
      await expect(f.broker.info(f.principal, q.toString(), f.headers)).rejects.toMatchObject({
        code: 'invalid_oauth_request',
      })
    }
    expect(f.calls).toHaveLength(0)
    await expect(f.broker.info(f.principal, f.q.toString(), f.headers)).resolves.toMatchObject({
      clientId: f.clientId,
    })
  })
  it('requires a live approving session inside the broker even when caller resolution was already done', async () => {
    const f = await fixture()
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.principal.sessionId)
      .execute()
    await expect(f.broker.info(f.principal, f.q.toString(), f.headers)).rejects.toMatchObject({
      code: 'oauth_request_expired',
    })
  })
  it('checks both organization and client on the persisted grant at approval', async () => {
    for (const mismatch of ['organization', 'client']) {
      const f = await fixture()
      const selection = await f.broker.select(
        f.principal,
        f.q.toString(),
        f.principal.organization.id,
        f.headers,
      )
      const intentId = new URLSearchParams(new URL(selection.redirectUrl).hash.slice(1)).get(
        'intent',
      ) as string
      const intent = await db
        .selectFrom('mcp_oauth_intents')
        .select('grant_id')
        .where('id', '=', intentId)
        .executeTakeFirstOrThrow()
      if (mismatch === 'organization') {
        const team = await createTestTeam(db, [{ user: f.user, role: 'owner' }])
        await db
          .updateTable('mcp_oauth_grants')
          .set({ organization_id: team.id })
          .where('id', '=', intent.grant_id)
          .execute()
      } else {
        await db
          .updateTable('mcp_oauth_grants')
          .set({ client_id: `other-${randomUUID()}` })
          .where('id', '=', intent.grant_id)
          .execute()
      }
      await expect(
        f.broker.consent(f.principal, f.q.toString(), intentId, true, f.headers),
      ).rejects.toMatchObject({ code: 'oauth_request_expired' })
      expect(f.calls.some((request) => new URL(request.url).pathname.endsWith('/consent'))).toBe(
        false,
      )
    }
  })
  it('revokes refresh rows and encrypted replay responses as well as deleting consent and grant', async () => {
    const f = await fixture(),
      now = new Date()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({
        user_id: f.user.id,
        organization_id: f.principal.organization.id,
        client_id: f.clientId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const consent = await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId: f.clientId,
        userId: f.user.id,
        referenceId: grant.id,
        resources: JSON.stringify([`${BASE}/mcp`]),
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        createdAt: now,
        updatedAt: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const refresh = await db
      .insertInto('auth.oauthRefreshToken')
      .values({
        clientId: f.clientId,
        userId: f.user.id,
        referenceId: grant.id,
        token: `synthetic-hash-${randomUUID()}`,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        createdAt: now,
        expiresAt: new Date(Date.now() + 86400000),
        rotationReplayResponse: 'synthetic-encrypted-response',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await f.broker.revoke(f.principal, consent.id)
    const row = await db
      .selectFrom('auth.oauthRefreshToken')
      .select(['revoked', 'rotationReplayResponse'])
      .where('id', '=', refresh.id)
      .executeTakeFirstOrThrow()
    expect(row.revoked).not.toBeNull()
    expect(row.rotationReplayResponse).toBeNull()
    expect(
      await db.selectFrom('auth.oauthConsent').select('id').where('id', '=', consent.id).execute(),
    ).toHaveLength(0)
    expect(
      await db.selectFrom('mcp_oauth_grants').select('id').where('id', '=', grant.id).execute(),
    ).toHaveLength(0)
  })
  it('buckets broker provider calls by trusted transport IP and never forwards a forged internal header', async () => {
    const f = await fixture(),
      buckets = new Map<string, number>()
    const auth = {
      handler: async (request: Request) => {
        const ip = request.headers.get(CLIENT_IP_HEADER) ?? 'shared-no-ip'
        const count = (buckets.get(ip) ?? 0) + 1
        buckets.set(ip, count)
        if (count > 2) return new Response(null, { status: 429 })
        return f.auth.handler(request)
      },
    }
    const app = createApp({
      checkDb: async () => {},
      publicUrl: BASE,
      authHandler: auth.handler,
      trustedProxies: ['10.0.0.1'],
      resolveCaller: async () => ({ ok: true, principal: f.principal, setCookie: [] }),
      routes: [mcpOAuthRoutes({ auth, db, publicUrl: BASE })],
    })
    const request = (ip: string) =>
      app.request(
        `${BASE}/api/v1/mcp-oauth/request`,
        {
          method: 'POST',
          headers: {
            ...Object.fromEntries(f.headers),
            'content-type': 'application/json',
            'x-forwarded-for': ip,
          },
          body: JSON.stringify({ oauthQuery: f.q.toString() }),
        },
        { incoming: { socket: { remoteAddress: '10.0.0.1' } } },
      )
    expect((await request('198.51.100.1')).status).toBe(200)
    expect((await request('198.51.100.1')).status).toBe(200)
    expect((await request('198.51.100.1')).status).toBe(400)
    expect((await request('198.51.100.2')).status).toBe(200)
    expect([...buckets.entries()]).toEqual([
      ['198.51.100.1', 3],
      ['198.51.100.2', 1],
    ])
    for (const call of f.calls) {
      expect(call.headers.has('authorization')).toBe(false)
      expect(call.headers.get('origin')).toBe(BASE)
      expect(call.headers.get(CLIENT_IP_HEADER)).not.toBe('203.0.113.254')
    }
    const selection = await f.broker.select(
      f.principal,
      f.q.toString(),
      f.principal.organization.id,
      f.headers,
      '198.51.100.3',
    )
    const intentId = new URLSearchParams(new URL(selection.redirectUrl).hash.slice(1)).get(
      'intent',
    ) as string
    await f.broker.consent(f.principal, f.q.toString(), intentId, true, f.headers, '198.51.100.3')
    expect(
      await db
        .selectFrom('mcp_oauth_client_activity')
        .select('client_id')
        .where('client_id', '=', f.clientId)
        .execute(),
    ).toHaveLength(1)
    expect(
      f.calls
        .filter((call) => /\/(continue|consent)$/.test(new URL(call.url).pathname))
        .map((call) => call.headers.get(CLIENT_IP_HEADER)),
    ).toEqual(['198.51.100.3', '198.51.100.3'])
  })
  it('records completed consent when the provider resumes a previously approved connection', async () => {
    const f = await fixture()
    const auth = {
      handler: async (request: Request) =>
        new URL(request.url).pathname.endsWith('/continue')
          ? Response.json({ url: `${CALLBACK}?code=synthetic-code` })
          : f.auth.handler(request),
    }
    const broker = mcpOAuthBroker({ auth, db, publicUrl: BASE })
    const selected = await broker.select(
      f.principal,
      f.q.toString(),
      f.principal.organization.id,
      f.headers,
    )
    expect(new URL(selected.redirectUrl).origin).toBe(new URL(CALLBACK).origin)
    expect(
      await db
        .selectFrom('mcp_oauth_client_activity')
        .select('client_id')
        .where('client_id', '=', f.clientId)
        .execute(),
    ).toHaveLength(1)
  })
})
