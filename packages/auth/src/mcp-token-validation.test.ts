import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { signJWT } from 'better-auth/plugins/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Auth, createAuth, createAuthPool, createMcpOAuthResolver } from './index.ts'
import { mcpOAuthPlugins, withMcpOAuthIntent } from './mcp-oauth.ts'
import { ensurePersonalOrganization } from './organizations.ts'

const serverUrl = process.env.DATABASE_URL,
  BASE = 'http://localhost:4198',
  CLIENT = 'https://validation.test/client.json'
describe.skipIf(!serverUrl)('MCP access-token profile validation', () => {
  let owned: TestDatabase,
    db: Db,
    pool: ReturnType<typeof createAuthPool>,
    auth: Auth,
    userId: string,
    organizationId: string,
    grantId: string
  const secret = randomBytes(32).toString('base64')
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: BASE,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
    })
    const u = await db
      .insertInto('auth.user')
      .values({ name: 'Synthetic Host', email: 'host@validation.test', emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    userId = u.id
    organizationId = await ensurePersonalOrganization(db, userId)
    grantId = (
      await db
        .insertInto('mcp_oauth_grants')
        .values({ user_id: userId, organization_id: organizationId, client_id: CLIENT })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId: CLIENT,
        redirectUris: JSON.stringify(['https://validation.test/callback']),
      })
      .execute()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId: CLIENT,
        userId,
        referenceId: grantId,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${BASE}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
  })
  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })
  async function token(changes: Record<string, unknown> = {}, typ = 'at+jwt') {
    const context = { context: await auth.$context } as Parameters<typeof signJWT>[0]
    return signJWT(context, {
      header: { typ },
      payload: {
        sub: userId,
        client_id: CLIENT,
        scope: 'mcp:tools',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: `${BASE}/api/auth`,
        aud: `${BASE}/mcp`,
        'https://hourmere.com/organization': organizationId,
        'https://hourmere.com/grant': grantId,
        ...changes,
      },
    })
  }
  const resolve = (value: string) =>
    createMcpOAuthResolver({ auth, db, publicUrl: BASE })(
      new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${value}` } }),
    )
  it('accepts a correctly signed current grant', async () =>
    expect((await resolve(await token())).ok).toBe(true))
  it.each([
    [
      'future-issued-at',
      { iat: Math.floor(Date.now() / 1000) + 3600, exp: Math.floor(Date.now() / 1000) + 3900 },
    ],
    ['excessive-lifetime', { exp: Math.floor(Date.now() / 1000) + 3600 }],
    ['unknown-confirmation', { cnf: { method: 'unsupported' } }],
    ['empty-confirmation-key', { cnf: { jkt: '' } }],
    ['missing-session', { sid: '00000000-0000-7000-8000-000000000001' }],
    ['audience', { aud: 'https://other.test/mcp' }],
    ['issuer', { iss: 'https://other.test/api/auth' }],
    ['expiry', { exp: 1 }],
    ['not-before', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ['missing subject', { sub: undefined }],
    ['unknown grant', { 'https://hourmere.com/grant': '00000000-0000-7000-8000-000000000001' }],
    ['invalid organization', { 'https://hourmere.com/organization': 'invalid' }],
    ['other client', { client_id: 'https://other.test/client.json' }],
  ])('rejects a valid signature with wrong %s', async (_label, changes) =>
    expect(await resolve(await token(changes))).toEqual({ ok: false, error: 'invalid_token' }),
  )
  it('rejects a session/identity JWT and grants without the required scope', async () => {
    expect(await resolve(await token({}, 'JWT'))).toEqual({ ok: false, error: 'invalid_token' })
    expect(await resolve(await token({ scope: 'offline_access' }))).toEqual({
      ok: false,
      error: 'insufficient_scope',
    })
  })
  it('rejects unsecured, symmetric, malformed, and overlong JWTs', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: userId, aud: `${BASE}/mcp` })).toString(
        'base64url',
      ),
      header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'at+jwt' })).toString('base64url'),
      input = `${header}.${payload}`
    const symmetric = `${input}.${createHmac('sha256', 'synthetic-test-secret').update(input).digest('base64url')}`
    for (const value of [
      symmetric,
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`,
      'bad.token.signature',
      'x'.repeat(17000),
    ])
      expect(await resolve(value)).toEqual({ ok: false, error: 'invalid_token' })
  })
  it('rejects a newly unverified user and a removed consent immediately', async () => {
    const value = await token()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', userId)
      .execute()
    try {
      expect(await resolve(value)).toEqual({ ok: false, error: 'invalid_token' })
    } finally {
      await db
        .updateTable('auth.user')
        .set({ emailVerified: true })
        .where('id', '=', userId)
        .execute()
    }
    const consent = await db
      .selectFrom('auth.oauthConsent')
      .selectAll()
      .where('referenceId', '=', grantId)
      .executeTakeFirstOrThrow()
    await db.deleteFrom('auth.oauthConsent').where('id', '=', consent.id).execute()
    try {
      expect(await resolve(value)).toEqual({ ok: false, error: 'invalid_token' })
    } finally {
      await db
        .insertInto('auth.oauthConsent')
        .values({
          ...consent,
          scopes: JSON.stringify(consent.scopes),
          resources: JSON.stringify(consent.resources),
        })
        .execute()
    }
  })
  it.each([
    ['scopes', ['offline_access']],
    ['resources', ['https://other.test/mcp']],
  ] as const)(
    'rejects a stored consent whose %s no longer authorizes MCP',
    async (field, value) => {
      await db
        .updateTable('auth.oauthConsent')
        .set({ [field]: JSON.stringify(value) })
        .where('referenceId', '=', grantId)
        .execute()
      try {
        expect(await resolve(await token())).toEqual({ ok: false, error: 'invalid_token' })
      } finally {
        await db
          .updateTable('auth.oauthConsent')
          .set({
            [field]: JSON.stringify(
              field === 'scopes' ? ['mcp:tools', 'offline_access'] : [`${BASE}/mcp`],
            ),
          })
          .where('referenceId', '=', grantId)
          .execute()
      }
    },
  )
  it.each([
    ['organization', { 'https://hourmere.com/organization': randomUUID() }],
    ['subject', { sub: randomUUID() }],
  ])('binds the live grant to its token %s', async (_label, changes) => {
    expect(await resolve(await token(changes))).toEqual({ ok: false, error: 'invalid_token' })
  })
  it('rejects an identity JWT before requesting public-key infrastructure', async () => {
    const value = await token({}, 'JWT')
    let lookups = 0
    const observed = {
      api: {
        getJwks: async () => {
          lookups++
          return auth.api.getJwks()
        },
      },
    } as unknown as Auth
    expect(
      await createMcpOAuthResolver({ auth: observed, db, publicUrl: BASE })(
        new Request(`${BASE}/mcp`, { headers: { authorization: `Bearer ${value}` } }),
      ),
    ).toEqual({ ok: false, error: 'invalid_token' })
    expect(lookups).toBe(0)
  })
  it('checks membership separately at token issuance and consent binding', async () => {
    const provider = mcpOAuthPlugins(db, BASE)[1].options
    const user = await db
      .selectFrom('auth.user')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    const member = await db
      .selectFrom('auth.member')
      .selectAll()
      .where('userId', '=', userId)
      .where('organizationId', '=', organizationId)
      .executeTakeFirstOrThrow()
    await db.deleteFrom('auth.member').where('id', '=', member.id).execute()
    try {
      const claims = provider.customAccessTokenClaims
      if (!claims) throw new Error('Missing token policy')
      // Issuance answers the token endpoint's client: RFC 6749 invalid_grant, not the
      // browser flow's organization selection.
      await expect(
        claims({ user, referenceId: grantId, scopes: ['mcp:tools'] }),
      ).rejects.toMatchObject({ status: 'BAD_REQUEST', body: { error: 'invalid_grant' } })
      const intent = { id: randomUUID(), userId, sessionId: randomUUID(), organizationId, grantId }
      const bind = provider.postLogin?.consentReferenceId
      if (typeof bind !== 'function') throw new Error('Missing consent binding policy')
      await expect(
        withMcpOAuthIntent(intent, () =>
          bind({ user, session: { id: intent.sessionId } } as Parameters<typeof bind>[0]),
        ),
      ).rejects.toMatchObject({ status: 'FORBIDDEN' })
    } finally {
      await db.insertInto('auth.member').values(member).execute()
    }
  })
  it('matches both the user and browser session before clearing organization selection', async () => {
    const redirect = mcpOAuthPlugins(db, BASE)[1].options.postLogin?.shouldRedirect
    if (typeof redirect !== 'function') throw new Error('Missing post-login policy')
    const intent = { id: randomUUID(), userId, sessionId: randomUUID(), organizationId, grantId }
    const check = (user: string, session: string) =>
      withMcpOAuthIntent(intent, () =>
        redirect({ user: { id: user }, session: { id: session } } as Parameters<
          typeof redirect
        >[0]),
      )
    expect(await check(userId, intent.sessionId)).toBe(false)
    expect(await check(randomUUID(), intent.sessionId)).toBe(true)
    expect(await check(userId, randomUUID())).toBe(true)
  })
  it('refuses authenticated OAuth client administration and session JWT response headers', async () => {
    const sessionToken = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(sessionToken).digest('base64')
    const headers = {
      cookie: `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`,
      origin: BASE,
      'content-type': 'application/json',
      'x-hourmere-client-ip': '198.18.42.91',
    }
    const session = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers }))
    expect(session.status).toBe(200)
    expect(session.headers.has('set-auth-jwt')).toBe(false)
    const create = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/create-client`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          client_name: 'Unapproved management',
          redirect_uris: ['https://validation.test/admin'],
        }),
      }),
    )
    expect(create.status).toBe(401)
  })
  it('requires the current consent to retain offline access before ignoring the browser session', async () => {
    await db
      .updateTable('auth.oauthConsent')
      .set({ scopes: JSON.stringify(['mcp:tools']) })
      .where('referenceId', '=', grantId)
      .execute()
    try {
      expect(await resolve(await token({ scope: 'mcp:tools offline_access', sid: null }))).toEqual({
        ok: false,
        error: 'invalid_token',
      })
      const issue = mcpOAuthPlugins(db, BASE)[1].options.customAccessTokenClaims
      if (!issue) throw new Error('Missing token policy')
      const user = await db
        .selectFrom('auth.user')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      await expect(
        issue({ user, referenceId: grantId, scopes: ['mcp:tools', 'offline_access'] }),
      ).rejects.toMatchObject({ body: { error: 'invalid_grant' } })
    } finally {
      await db
        .updateTable('auth.oauthConsent')
        .set({ scopes: JSON.stringify(['mcp:tools', 'offline_access']) })
        .where('referenceId', '=', grantId)
        .execute()
    }
  })
  it('accepts offline tokens without a live session and expires them at the original consent deadline', async () => {
    for (const sid of [null, undefined, randomUUID()]) {
      expect((await resolve(await token({ scope: 'mcp:tools offline_access', sid }))).ok).toBe(true)
    }
    const consent = await db
      .selectFrom('auth.oauthConsent')
      .select('createdAt')
      .where('referenceId', '=', grantId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('auth.oauthConsent')
      .set({ createdAt: new Date(Date.now() - 30 * 86400000 - 1000) })
      .where('referenceId', '=', grantId)
      .execute()
    try {
      expect(await resolve(await token({ scope: 'mcp:tools offline_access', sid: null }))).toEqual({
        ok: false,
        error: 'invalid_token',
      })
      const issue = mcpOAuthPlugins(db, BASE)[1].options.customAccessTokenClaims
      if (!issue) throw new Error('Missing token policy')
      const user = await db
        .selectFrom('auth.user')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      await expect(
        issue({ user, referenceId: grantId, scopes: ['mcp:tools', 'offline_access'] }),
      ).rejects.toMatchObject({ body: { error: 'invalid_grant' } })
    } finally {
      await db
        .updateTable('auth.oauthConsent')
        .set({ createdAt: consent.createdAt })
        .where('referenceId', '=', grantId)
        .execute()
    }
  })
  it('records successful MCP activity without extending the original consent', async () => {
    const old = new Date(Date.now() - 2 * 86400000)
    await db
      .insertInto('mcp_oauth_client_activity')
      .values({ client_id: CLIENT, consented_at: old, last_used_at: old })
      .onConflict((oc) => oc.column('client_id').doUpdateSet({ last_used_at: old }))
      .execute()
    expect((await resolve(await token())).ok).toBe(true)
    const activity = await db
      .selectFrom('mcp_oauth_client_activity')
      .selectAll()
      .where('client_id', '=', CLIENT)
      .executeTakeFirstOrThrow()
    expect(new Date(activity.last_used_at).getTime()).toBeGreaterThan(old.getTime())
  })
  it('records successful token issuance activity', async () => {
    const old = new Date(Date.now() - 2 * 86400000)
    await db
      .insertInto('mcp_oauth_client_activity')
      .values({ client_id: CLIENT, consented_at: old, last_used_at: old })
      .onConflict((oc) => oc.column('client_id').doUpdateSet({ last_used_at: old }))
      .execute()
    const issue = mcpOAuthPlugins(db, BASE)[1].options.customAccessTokenClaims
    if (!issue) throw new Error('Missing token policy')
    const user = await db
      .selectFrom('auth.user')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    await issue({ user, referenceId: grantId, scopes: ['mcp:tools', 'offline_access'] })
    const activity = await db
      .selectFrom('mcp_oauth_client_activity')
      .select('last_used_at')
      .where('client_id', '=', CLIENT)
      .executeTakeFirstOrThrow()
    expect(new Date(activity.last_used_at).getTime()).toBeGreaterThan(old.getTime())
  })
  it.each([
    ['register', 5],
    ['authorize', 30],
    ['token', 20],
  ] as const)('limits the %s provider endpoint outside production', async (endpoint, limit) => {
    expect(process.env.NODE_ENV).not.toBe('production')
    const headers = {
      'x-hourmere-client-ip': `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`,
      'content-type':
        endpoint === 'token' ? 'application/x-www-form-urlencoded' : 'application/json',
    }
    const statuses: number[] = []
    for (let i = 0; i <= limit; i++) {
      const response = await auth.handler(
        new Request(
          `${BASE}/api/auth/oauth2/${endpoint}`,
          endpoint === 'authorize'
            ? { headers }
            : {
                method: 'POST',
                headers,
                body:
                  endpoint === 'token'
                    ? 'grant_type=refresh_token&client_id=unknown&refresh_token=unknown'
                    : JSON.stringify({
                        redirect_uris: ['https://validation.test/callback'],
                        token_endpoint_auth_method: 'none',
                      }),
              },
        ),
      )
      statuses.push(response.status)
      if (i === limit) {
        expect(response.status).toBe(429)
        expect(Number(response.headers.get('x-retry-after'))).toBeGreaterThan(0)
      }
    }
    expect(statuses.slice(0, limit).includes(429)).toBe(false)
    expect(statuses[limit]).toBe(429)
  })
  it('does not downgrade public-key database failures to invalid-token responses', async () => {
    const value = await token(),
      broken = {
        api: {
          getJwks: async () => {
            throw new Error('synthetic key-store outage')
          },
        },
      } as unknown as Auth
    await expect(
      createMcpOAuthResolver({ auth: broken, db, publicUrl: BASE })(
        new Request(`${BASE}/mcp`, { headers: { authorization: `Bearer ${value}` } }),
      ),
    ).rejects.toThrow('synthetic key-store outage')
  })
})
