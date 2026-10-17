import { createHmac, randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { signJWT } from 'better-auth/plugins/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Auth, createAuth, createAuthPool, createMcpOAuthResolver } from './index.ts'
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
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: BASE,
      secret: randomBytes(32).toString('base64'),
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
        scopes: JSON.stringify(['mcp:tools']),
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
