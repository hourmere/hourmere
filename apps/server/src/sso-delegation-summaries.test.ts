import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  ensurePersonalOrganization,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindingValues,
  type IdentityFixture,
  identityFixture,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { insert } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { productRoutes } from './server.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const clientId = 'https://delegate.example.test/client.json'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const listKeys = '/api/auth/api-key/list?sortBy=createdAt&sortDirection=desc'
const listGrants = '/api/v1/mcp-oauth/connections'
const unavailable = async (): Promise<never> => {
  throw new Error('Credential inventory reached an external dependency')
}

describe.skipIf(!databaseUrl)('owned SSO delegation inventories', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let fixture: IdentityFixture
  let off: ReturnType<typeof instance>
  let on: ReturnType<typeof instance>
  const statements: string[] = []

  function instance(enabled: boolean) {
    const ssoCapabilities = { ssoOidcEnabled: enabled, ssoSamlEnabled: false }
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: unavailable },
      mcpOAuth: true,
      mcpMetadataFetcher: unavailable,
      ssoCapabilities,
    })
    const app = createApp({
      checkDb: unavailable,
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      ssoTeamReads: { db, capabilities: ssoCapabilities },
      routes: productRoutes({
        ...ssoCapabilities,
        publicUrl,
        db,
        mcpAuth: auth,
        invitationMailLimits: { secret },
        socialProviders: {},
      }),
    })
    return { app, auth }
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    authPool = createAuthPool(owned.url, signup)
    off = instance(false)
    on = instance(true)
    const client = await owned.pool.connect()
    try {
      fixture = await identityFixture(client)
    } finally {
      client.release()
    }
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        name: 'Delegation test client',
        redirectUris: JSON.stringify(['https://delegate.example.test/callback']),
      })
      .execute()
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function browser(userId: string) {
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId,
          organizationId: fixture.team,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    return { cookie: session.cookie.split(';')[0] as string }
  }

  async function key(userId: string, organizationId: string) {
    const { id } = await off.auth.api.createApiKey({
      body: { userId, name: 'Integration', metadata: { organizationId, scope: 'full' } },
    })
    return id
  }

  async function grant(userId: string, organizationId: string, ageMs: number) {
    const { id: credentialId } = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: userId, organization_id: organizationId, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    const createdAt = new Date(Date.now() - ageMs)
    const row = await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId,
        referenceId: credentialId,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${publicUrl}/mcp`]),
        createdAt,
        updatedAt: createdAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const organization = await db
      .selectFrom('auth.organization')
      .select('name')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow()
    return {
      credentialId,
      connection: {
        id: row.id,
        clientName: 'Delegation test client',
        clientId,
        organizationName: organization.name,
        createdAt: createdAt.toISOString(),
      },
    }
  }

  async function read(
    { app }: ReturnType<typeof instance>,
    path: string,
    headers: Record<string, string>,
  ) {
    const response = await app.request(new URL(path, publicUrl), { headers })
    expect(response.status, path).toBe(200)
    return response.text()
  }

  it('preserves hard-off inventory bytes and exposes live bindings only to their owner', async () => {
    const member = await browser(fixture.member)
    const owner = await browser(fixture.owner)
    const personal = await ensurePersonalOrganization(db, fixture.member)
    const memberKey = await key(fixture.member, fixture.team)
    const personalKey = await key(fixture.member, personal)
    const ownerKey = await key(fixture.owner, fixture.team)
    const memberGrant = await grant(fixture.member, fixture.team, 0)
    const personalGrant = await grant(fixture.member, personal, 60_000)
    const ownerGrant = await grant(fixture.owner, fixture.team, 0)
    const keyBytes = await read(off, listKeys, member)
    const grantBytes = await read(off, listGrants, member)
    const keyInventory: { apiKeys: { id: string }[]; total: number } = JSON.parse(keyBytes)
    expect(Object.keys(keyInventory)).toEqual(['apiKeys', 'total'])
    expect(keyInventory.total).toBe(2)
    expect(keyInventory.apiKeys.map((row) => row.id).sort()).toEqual(
      [memberKey, personalKey].sort(),
    )
    for (const row of keyInventory.apiKeys) {
      expect(Object.keys(row).sort()).toEqual([
        'configId',
        'createdAt',
        'enabled',
        'expiresAt',
        'id',
        'lastRefillAt',
        'lastRequest',
        'metadata',
        'name',
        'permissions',
        'prefix',
        'rateLimitEnabled',
        'rateLimitMax',
        'rateLimitTimeWindow',
        'referenceId',
        'refillAmount',
        'refillInterval',
        'remaining',
        'requestCount',
        'start',
        'updatedAt',
      ])
    }
    expect(grantBytes).toBe(
      JSON.stringify({ data: [memberGrant.connection, personalGrant.connection] }),
    )

    const client = await owned.pool.connect()
    let keySummary: { id: string; expiresAt: string }
    let grantSummary: { id: string; expiresAt: string }
    try {
      const keyBinding = await insert(
        client,
        'sso_delegation_bindings',
        bindingValues(fixture, { api_key_id: memberKey }),
      )
      const grantBinding = await insert(
        client,
        'sso_delegation_bindings',
        bindingValues(fixture, { oauth_grant_id: memberGrant.credentialId }),
      )
      keySummary = {
        id: keyBinding.id as string,
        expiresAt: (keyBinding.expires_at as Date).toISOString(),
      }
      grantSummary = {
        id: grantBinding.id as string,
        expiresAt: (grantBinding.expires_at as Date).toISOString(),
      }
    } finally {
      client.release()
    }

    statements.length = 0
    expect(await read(off, listKeys, member)).toBe(keyBytes)
    expect(await read(off, listGrants, member)).toBe(grantBytes)
    expect(statements.some((statement) => statement.includes('sso_delegation_bindings'))).toBe(
      false,
    )

    expect(JSON.parse(await read(on, listKeys, member))).toEqual({
      ...keyInventory,
      apiKeys: keyInventory.apiKeys.map((row) =>
        row.id === memberKey ? { ...row, ssoDelegation: keySummary } : row,
      ),
    })
    expect(JSON.parse(await read(on, listGrants, member))).toEqual({
      data: [
        {
          ...memberGrant.connection,
          credentialId: memberGrant.credentialId,
          ssoDelegation: grantSummary,
        },
        personalGrant.connection,
      ],
    })
    expect(await read(on, listKeys, owner)).toBe(await read(off, listKeys, owner))
    expect(JSON.parse(await read(on, listKeys, owner))).toMatchObject({
      apiKeys: [{ id: ownerKey }],
      total: 1,
    })
    expect(JSON.parse(await read(on, listGrants, owner))).toEqual({
      data: [{ ...ownerGrant.connection, credentialId: ownerGrant.credentialId }],
    })
  })
})
