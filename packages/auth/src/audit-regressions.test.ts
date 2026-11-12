import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpOAuthBroker } from '../../../apps/server/src/mcp/oauth.ts'
import { type Auth, createAuth, createAuthPool } from './index.ts'
import { ensurePersonalOrganization } from './organizations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4471'
const secret = 'synthetic-audit-regression-secret-long-enough'
function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved = replacements[specifier]
      if (!resolved && specifier.startsWith('node:')) resolved = specifier
      if (!resolved) {
        if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
        else {
          try {
            resolved = import.meta.resolve(specifier)
          } catch {
            resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
          }
        }
      }
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}
async function sourceCopy(file: string, before: string, after: string): Promise<typeof createAuth> {
  const location = new URL(file, import.meta.url)
  const source = readFileSync(location, 'utf8')
  expect(source.includes(before), 'mutation matches production source').toBe(true)
  const replacement = moduleUrl(source.replace(before, after), location)
  const replacements = { [file]: replacement }
  if (file === './audit.ts') {
    const native = new URL('./team-native-atomicity.ts', import.meta.url)
    replacements['./team-native-atomicity.ts'] = moduleUrl(
      readFileSync(native, 'utf8'),
      native,
      replacements,
    )
  }
  if (file === './invitation-cancellation.ts') {
    const hooks = new URL('./hooks.ts', import.meta.url)
    replacements['./hooks.ts'] = moduleUrl(readFileSync(hooks, 'utf8'), hooks, replacements)
  }
  const index = new URL('./index.ts', import.meta.url)
  return (await import(moduleUrl(readFileSync(index, 'utf8'), index, replacements))).createAuth
}

describe.skipIf(!serverUrl)('auth audit review regressions', () => {
  let owned: TestDatabase, db: Db, pool: ReturnType<typeof createAuthPool>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
  })
  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })
  function instance(factory = createAuth) {
    return factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
      mcpOAuth: true,
    })
  }
  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic actor',
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const organizationId = await ensurePersonalOrganization(db, user.id)
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
        activeOrganizationId: organizationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      user,
      organizationId,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  function post(
    auth: Auth,
    path: string,
    body: unknown,
    actor?: Awaited<ReturnType<typeof account>>,
  ) {
    return auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(actor
            ? { cookie: actor.cookie, 'x-expected-organization-id': actor.organizationId }
            : {}),
        },
        body: JSON.stringify(body),
      }),
    )
  }
  async function events(organizationId: string) {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM audit_events WHERE organization_id=${organizationId} ORDER BY id`.execute(db)
    ).rows
  }
  async function expiry(
    factory = createAuth,
    operation: 'create' | 'update' | 'delete' = 'create',
  ) {
    const auth = instance(factory),
      actor = await account(),
      other = await account()
    let own = ''
    if (operation !== 'create') {
      const created = await post(auth, '/api-key/create', {}, actor)
      expect(created.status).toBe(200)
      own = ((await created.json()) as { id: string }).id
    }
    const key = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: other.user.id,
        key: randomUUID(),
        enabled: true,
        expiresAt: new Date(0),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ organizationId: other.organizationId, scope: 'full' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    // Better Auth throttles its instance-wide cleanup for ten seconds, including across auth instances.
    await new Promise((resolve) => setTimeout(resolve, 10100))
    const response =
      operation === 'create'
        ? await post(auth, '/api-key/create', {}, actor)
        : operation === 'update'
          ? await post(auth, '/api-key/update', { keyId: own, name: 'Renamed own key' }, actor)
          : await post(auth, '/api-key/delete', { keyId: own }, actor)
    expect(response.status).toBe(200)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        !(await db
          .selectFrom('auth.apikey')
          .select('id')
          .where('id', '=', key.id)
          .executeTakeFirst())
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(
      await db.selectFrom('auth.apikey').select('id').where('id', '=', key.id).execute(),
    ).toEqual([])
    expect(await events(other.organizationId), 'foreign expiry audit isolation').toEqual([])
    expect(
      (
        await sql<{
          id: string
        }>`SELECT id FROM audit_events WHERE actor_id=${actor.user.id} AND organization_id IS DISTINCT FROM ${actor.organizationId}`.execute(
          db,
        )
      ).rows,
      'foreign expiry audit isolation',
    ).toEqual([])
    expect((await events(actor.organizationId)).map((row) => row.action)).toEqual(
      operation === 'create'
        ? ['api_key.created']
        : ['api_key.created', operation === 'update' ? 'api_key.updated' : 'api_key.revoked'],
    )
  }
  it.each(['create', 'update', 'delete'] as const)(
    'does not attribute expired foreign keys to a user calling %s',
    (operation) => expiry(createAuth, operation),
    30000,
  )
  it('kills a source copy that audits bulk expiry cleanup', async () => {
    const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8')
    const start = source.indexOf("((path === '/api-key/create'")
    const end = source.indexOf(" ||\n              (request.model === 'oauthClient'", start)
    const factory = await sourceCopy(
      './audit.ts',
      source.slice(start, end),
      "['/api-key/create', '/api-key/update', '/api-key/delete'].includes(path))",
    )
    await expect(expiry(factory)).rejects.toThrow(/foreign expiry audit isolation/)
  }, 30000)
  it.each(['update', 'delete'] as const)(
    'kills a source copy that audits expiry cleanup during key %s',
    async (operation) => {
      const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8')
      const start = source.indexOf("['update', 'delete'].includes(method) &&")
      // Include the selector's own closing parenthesis.
      const end = source.indexOf(')))) ||', start) + 1
      expect(start > 0 && end > start, 'update/delete selector found').toBe(true)
      // Drop the target-key selector and admit bulk deletion on the update/delete paths.
      const factory = await sourceCopy(
        './audit.ts',
        source.slice(start, end),
        "['update', 'delete', 'deleteMany'].includes(method)",
      )
      await expect(expiry(factory, operation)).rejects.toThrow(/foreign expiry audit isolation/)
    },
    30000,
  )
  async function spelledKeyIds(factory = createAuth) {
    const auth = instance(factory),
      actor = await account()
    const created = await post(auth, '/api-key/create', { name: 'Spelled key' }, actor)
    expect(created.status).toBe(200)
    const key = (await created.json()) as { id: string }
    expect(key.id).toBe(key.id.toLowerCase())
    const mixed = [...key.id].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('')
    expect(mixed).not.toBe(key.id)
    const stored = () =>
      db
        .selectFrom('auth.apikey')
        .select(['name', 'enabled'])
        .where('id', '=', key.id)
        .executeTakeFirst()
    const steps: [string, Record<string, unknown>, string, unknown][] = [
      [
        '/api-key/update',
        { keyId: key.id.toUpperCase(), name: 'Renamed spelled key' },
        'api_key.updated',
        { name: 'Renamed spelled key', enabled: true },
      ],
      [
        '/api-key/update',
        { keyId: mixed, enabled: false },
        'api_key.revoked',
        { name: 'Renamed spelled key', enabled: false },
      ],
      [
        '/api-key/update',
        { keyId: key.id.toUpperCase(), enabled: true },
        'api_key.reenabled',
        { name: 'Renamed spelled key', enabled: true },
      ],
      ['/api-key/delete', { keyId: mixed }, 'api_key.revoked', undefined],
    ]
    const expected = ['api_key.created']
    for (const [path, body, action, state] of steps) {
      expect((await post(auth, path, body, actor)).status).toBe(200)
      expect(await stored()).toEqual(state)
      expected.push(action)
      const rows = await events(actor.organizationId)
      expect(
        rows.map((row) => row.action),
        `spelled key id audit ${action}`,
      ).toEqual(expected)
      expect(rows.at(-1)).toMatchObject({
        actor_type: 'user',
        actor_id: actor.user.id,
        credential_type: 'session',
        credential_id: actor.sessionId,
        target_type: 'apikey',
        target_id: key.id,
        details: {},
      })
    }
  }
  it('audits uppercase and mixed-case key ids on update, disable, re-enable and delete', () =>
    spelledKeyIds())
  it('kills a source copy that compares key ids by spelling', async () => {
    await expect(
      spelledKeyIds(
        await sourceCopy(
          './audit.ts',
          'sameId(condition.value, endpoint?.body?.keyId)',
          'condition.value === endpoint?.body?.keyId',
        ),
      ),
    ).rejects.toThrow(/spelled key id audit/)
  })
  async function reenable(factory = createAuth) {
    const auth = instance(factory),
      actor = await account()
    const created = await post(auth, '/api-key/create', { metadata: { scope: 'read' } }, actor)
    expect(created.status).toBe(200)
    const key = (await created.json()) as { id: string }
    expect(
      (await post(auth, '/api-key/update', { keyId: key.id, enabled: false }, actor)).status,
    ).toBe(200)
    expect(
      (await post(auth, '/api-key/update', { keyId: key.id, enabled: true }, actor)).status,
    ).toBe(200)
    const rows = await events(actor.organizationId)
    expect(
      rows.map((row) => row.action),
      'reenable audit action',
    ).toEqual(['api_key.created', 'api_key.revoked', 'api_key.reenabled'])
    expect(rows[0]?.details, 'creation scope audit detail').toEqual({ scope: 'read' })
  }
  it('records re-enabling separately and retains creation scope', () => reenable())
  it('kills a source copy that hides re-enabling as an update', async () => {
    await expect(
      reenable(await sourceCopy('./audit.ts', "? 'api_key.reenabled'", "? 'api_key.updated'")),
    ).rejects.toThrow(/reenable audit action/)
  })
  async function disconnected(factory = createAuth) {
    const auth = instance(factory),
      actor = await account(),
      clientId = randomUUID(),
      token = randomBytes(32).toString('base64url')
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://example.test/callback']),
        tokenEndpointAuthMethod: 'none',
      })
      .execute()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({
        user_id: actor.user.id,
        organization_id: actor.organizationId,
        client_id: clientId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const consent = await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: actor.user.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthRefreshToken')
      .values({
        clientId,
        userId: actor.user.id,
        referenceId: grant.id,
        token: createHash('sha256').update(token).digest('base64url'),
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      })
      .execute()
    const broker = mcpOAuthBroker({ auth, db, publicUrl: origin })
    await broker.revoke(
      {
        kind: 'session',
        user: actor.user,
        sessionId: actor.sessionId,
        organization: { id: actor.organizationId, name: '', slug: '', personal: true },
      },
      consent.id,
    )
    const response = await auth.handler(
      new Request(`${origin}/api/auth/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, token, token_type_hint: 'refresh_token' }),
      }),
    )
    expect(response.status, 'native revocation status after disconnect').toBe(400)
    expect(
      await db
        .selectFrom('auth.oauthRefreshToken')
        .select('id')
        .where('clientId', '=', clientId)
        .execute(),
    ).toEqual([])
    // The disconnected grant no longer names an organization; the family event survives.
    expect(
      (
        await sql<
          Record<string, unknown>
        >`SELECT * FROM audit_events WHERE action='oauth.token_revoked' AND oauth_client_id=${clientId}`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({
        organization_id: null,
        actor_type: 'oauth_client',
        actor_id: clientId,
        oauth_grant_id: grant.id,
        target_id: grant.id,
        details: { familySize: 1 },
      }),
    ])
  }
  it('preserves native revoked-token status and family invalidation after disconnect', () =>
    disconnected())
  it('kills a source copy requiring a deleted OAuth grant', async () => {
    await expect(
      disconnected(
        await sourceCopy(
          './audit.ts',
          'organizationId: grant?.organization_id ?? null,',
          "organizationId: grant ? grant.organization_id : (() => { throw new Error('OAuth audit requires its organization grant') })(),",
        ),
      ),
    ).rejects.toThrow(/native revocation status after disconnect/)
  })
  type FamilyPath = 'revoke' | 'token'
  /** One client, one user, two grants in two organizations, each with refresh and access tokens. */
  async function familySetup() {
    const actor = await account(),
      clientId = randomUUID()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Family team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://example.test/callback']),
        tokenEndpointAuthMethod: 'none',
      })
      .execute()
    const grants = []
    for (const organizationId of [actor.organizationId, team.id])
      grants.push(
        await db
          .insertInto('mcp_oauth_grants')
          .values({ user_id: actor.user.id, organization_id: organizationId, client_id: clientId })
          .returning(['id', 'organization_id'])
          .executeTakeFirstOrThrow(),
      )
    const [presented, sibling] = grants as [(typeof grants)[number], (typeof grants)[number]]
    // The refresh endpoint first checks that the presented grant's consent still holds.
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: actor.user.id,
        referenceId: presented.id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const tokens = grants.map(() => randomBytes(32).toString('base64url'))
    for (const [index, grant] of grants.entries()) {
      const refresh = await db
        .insertInto('auth.oauthRefreshToken')
        .values({
          clientId,
          userId: actor.user.id,
          referenceId: grant.id,
          token: createHash('sha256')
            .update(tokens[index] as string)
            .digest('base64url'),
          scopes: JSON.stringify(['mcp:tools', 'offline_access']),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          // Presenting an already revoked refresh token is native reuse detection.
          revoked: index === 0 ? new Date(Date.now() - 60000) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('auth.oauthAccessToken')
        .values({
          clientId,
          userId: actor.user.id,
          referenceId: grant.id,
          refreshId: refresh.id,
          token: randomBytes(32).toString('base64url'),
          scopes: JSON.stringify(['mcp:tools']),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 300000),
        })
        .execute()
    }
    return { actor, clientId, presented, sibling, token: tokens[0] as string }
  }
  function presentRevoked(auth: Auth, path: FamilyPath, clientId: string, token: string) {
    return auth.handler(
      new Request(`${origin}/api/auth/oauth2/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(
          path === 'revoke'
            ? { client_id: clientId, token, token_type_hint: 'refresh_token' }
            : {
                grant_type: 'refresh_token',
                client_id: clientId,
                refresh_token: token,
                resource: `${origin}/mcp`,
              },
        ),
      }),
    )
  }
  async function familyTokens(clientId: string) {
    return {
      refresh: await db
        .selectFrom('auth.oauthRefreshToken')
        .select('id')
        .where('clientId', '=', clientId)
        .execute(),
      access: await db
        .selectFrom('auth.oauthAccessToken')
        .select('id')
        .where('clientId', '=', clientId)
        .execute(),
    }
  }
  async function family(factory = createAuth, path: FamilyPath = 'revoke') {
    const auth = instance(factory),
      { actor, clientId, presented, sibling, token } = await familySetup()
    // Unexpected errors reach the caller as exceptions; count them as a failed response.
    const status = await presentRevoked(auth, path, clientId, token).then(
      (response) => response.status,
      () => 500,
    )
    expect(status, 'native family response').toBe(400)
    expect(await familyTokens(clientId), 'family tokens invalidated').toEqual({
      refresh: [],
      access: [],
    })
    const revoked = async (organizationId: string) =>
      (await events(organizationId)).filter((row) => row.action === 'oauth.token_revoked')
    expect(await revoked(actor.organizationId), 'presented family audit').toEqual([
      expect.objectContaining({
        actor_type: 'oauth_client',
        actor_id: clientId,
        credential_type: 'oauth',
        oauth_client_id: clientId,
        oauth_grant_id: presented.id,
        target_type: 'oauth_grant',
        target_id: presented.id,
        details: { familySize: 2 },
      }),
    ])
    const other = await revoked(sibling.organization_id)
    expect(other, 'sibling family audit').toEqual([
      expect.objectContaining({
        actor_type: 'oauth_client',
        actor_id: clientId,
        credential_type: 'none',
        oauth_client_id: null,
        oauth_grant_id: null,
        target_type: 'oauth_grant',
        target_id: sibling.id,
        details: { familySize: 2 },
      }),
    ])
    expect(JSON.stringify(other), 'sibling family audit').not.toContain(presented.id)
  }
  it('records refresh-family invalidation against the presented grant with its size', () =>
    family())
  it('records refresh-token reuse at the token endpoint like revocation reuse', () =>
    family(createAuth, 'token'))
  it.each(['revoke', 'token'] as const)(
    'deletes the %s family access tokens before its refresh tokens when nothing cascades',
    async (path) => {
      // Without the cascade, the refresh tokens can only go once their access tokens are gone:
      // the deferred native deletion must run before them, in the same transaction.
      const [constraint] = (
        await sql<{ conname: string }>`SELECT c.conname FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'auth."oauthAccessToken"'::regclass AND c.contype = 'f'
          AND a.attname = 'refreshId'`.execute(db)
      ).rows
      expect(typeof constraint?.conname).toBe('string')
      const name = sql.id(constraint?.conname as string)
      await sql`ALTER TABLE auth."oauthAccessToken" DROP CONSTRAINT ${name},
      ADD CONSTRAINT ${name} FOREIGN KEY ("refreshId") REFERENCES auth."oauthRefreshToken"(id)`.execute(
        db,
      )
      try {
        await family(createAuth, path)
      } finally {
        await sql`ALTER TABLE auth."oauthAccessToken" DROP CONSTRAINT ${name},
        ADD CONSTRAINT ${name} FOREIGN KEY ("refreshId") REFERENCES auth."oauthRefreshToken"(id)
        ON DELETE CASCADE`.execute(db)
      }
    },
  )
  it.each([
    ['per-token family events', 'if (refreshFamily) {', 'if (false) {'],
    [
      'presenting grant in a sibling organization',
      `credential:
                      grantId === presentedGrant
                        ? { type: 'oauth', clientId, grantId }
                        : { type: 'none' },`,
      "credential: { type: 'oauth', clientId, grantId: presentedGrant },",
    ],
  ])('kills a source copy with %s', async (_, before, after) => {
    await expect(family(await sourceCopy('./audit.ts', before, after))).rejects.toThrow(
      /family audit/,
    )
  })
  it("records another client's revoked token only against the presenting client's family", async () => {
    const auth = instance(),
      { actor, clientId: owner, presented, token } = await familySetup()
    // A second public client, connected by the same user in another organization, presents
    // the first client's revoked token. Better Auth wipes the presenting client's family.
    const presenter = randomUUID()
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId: presenter,
        redirectUris: JSON.stringify(['https://example.test/callback']),
        tokenEndpointAuthMethod: 'none',
      })
      .execute()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Presenter team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: actor.user.id, organization_id: team.id, client_id: presenter })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthRefreshToken')
      .values({
        clientId: presenter,
        userId: actor.user.id,
        referenceId: grant.id,
        token: createHash('sha256')
          .update(randomBytes(32).toString('base64url'))
          .digest('base64url'),
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      })
      .execute()
    const status = await presentRevoked(auth, 'revoke', presenter, token).then(
      (response) => response.status,
      () => 500,
    )
    expect(status, 'cross-client family response').toBe(400)
    expect((await familyTokens(owner)).refresh, 'cross-client family').toHaveLength(2)
    expect((await familyTokens(presenter)).refresh, 'cross-client family').toEqual([])
    const revoked = async (organizationId: string) =>
      (await events(organizationId)).filter((row) => row.action === 'oauth.token_revoked')
    // The presented token's grant lost nothing: its organization gets no event naming
    // the other client.
    expect(await revoked(actor.organizationId), 'cross-client family audit').toEqual([])
    const wiped = await revoked(team.id)
    expect(wiped, 'cross-client family audit').toEqual([
      expect.objectContaining({
        actor_type: 'oauth_client',
        actor_id: presenter,
        credential_type: 'none',
        oauth_client_id: null,
        oauth_grant_id: null,
        target_type: 'oauth_grant',
        target_id: grant.id,
        details: { familySize: 1 },
      }),
    ])
    expect(JSON.stringify(wiped), 'cross-client family audit').not.toContain(presented.id)
  })
  it.each(['revoke', 'token'] as const)(
    'keeps the whole family, access tokens included, when its %s audit fails',
    async (path) => {
      const auth = instance(),
        { clientId, token } = await familySetup()
      await sql`CREATE FUNCTION reject_family_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='oauth.token_revoked' THEN RAISE EXCEPTION 'synthetic family audit failure'; END IF;
        RETURN NEW; END $$`.execute(db)
      await sql`CREATE TRIGGER reject_family_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_family_audit()`.execute(
        db,
      )
      try {
        let refused: boolean
        try {
          refused = (await presentRevoked(auth, path, clientId, token)).status >= 500
        } catch {
          refused = true
        }
        expect(refused, 'family audit failure refused').toBe(true)
        // Deletions and events commit together: nothing of the family is gone.
        const left = await familyTokens(clientId)
        expect(left.refresh, 'family refresh tokens kept').toHaveLength(2)
        expect(left.access, 'family access tokens kept').toHaveLength(2)
      } finally {
        await sql`DROP TRIGGER reject_family_audit ON audit_events`.execute(db)
        await sql`DROP FUNCTION reject_family_audit()`.execute(db)
      }
    },
  )
  async function rejection(factory = createAuth) {
    const auth = instance(factory),
      actor = await account(),
      recipient = await account()
    const created = await post(
      auth,
      '/organization/create',
      { name: 'Rejected synthetic team', slug: randomUUID() },
      actor,
    )
    expect(created.status).toBe(200)
    const team = (await created.json()) as { id: string }
    const invite = await post(
      auth,
      '/organization/invite-member',
      { organizationId: team.id, email: recipient.user.email, role: 'member' },
      { ...actor, organizationId: team.id },
    )
    expect(invite.status).toBe(200)
    const invitation = (await invite.json()) as { id: string }
    const rejected = await post(
      auth,
      '/organization/reject-invitation',
      { invitationId: invitation.id },
      recipient,
    )
    expect(rejected.status).toBe(200)
    expect(
      (
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', invitation.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('rejected')
    const rows = await events(team.id)
    expect(
      rows.map((row) => row.action),
      'rejection audit actions',
    ).toEqual(['organization.created', 'membership.invited', 'membership.invitation_rejected'])
    // The invitee never joined: no user or session ID of theirs in the team's journal.
    expect(rows[2], 'rejection attribution').toMatchObject({
      actor_type: 'external_user',
      actor_id: null,
      credential_type: 'none',
      credential_id: null,
      target_type: 'invitation',
      target_id: invitation.id,
      details: {},
    })
    for (const value of [recipient.user.email, recipient.user.id, recipient.sessionId])
      expect(JSON.stringify(rows), 'rejection attribution').not.toContain(value)
    expect(await events(recipient.organizationId)).toEqual([])
  }
  it('records an invitee rejecting an invitation in the inviting team', () => rejection())
  it('kills a source copy without the rejection audit', async () => {
    await expect(
      rejection(
        await sourceCopy(
          './team-role-policy.ts',
          "action: 'membership.invitation_rejected'",
          "action: 'membership.invited'",
        ),
      ),
    ).rejects.toThrow(/rejection audit actions/)
  })
  async function management(factory = createAuth) {
    const auth = instance(factory),
      actor = await account(),
      recipient = await account()
    const created = await post(
      auth,
      '/organization/create',
      { name: 'Private synthetic team', slug: randomUUID() },
      actor,
    )
    expect(created.status).toBe(200)
    const team = (await created.json()) as { id: string }
    const teamActor = { ...actor, organizationId: team.id }
    const invite = await post(
      auth,
      '/organization/invite-member',
      { organizationId: team.id, email: recipient.user.email, role: 'member' },
      teamActor,
    )
    expect(invite.status).toBe(200)
    const invitation = (await invite.json()) as { id: string }
    expect(
      (
        await post(
          auth,
          '/organization/cancel-invitation',
          { invitationId: invitation.id },
          teamActor,
        )
      ).status,
    ).toBe(200)
    const rows = await events(team.id)
    expect(
      rows.map((row) => row.action),
      'management audit actions',
    ).toEqual(['organization.created', 'membership.invited', 'membership.invitation_cancelled'])
    expect(rows[0]).toMatchObject({
      actor_id: actor.user.id,
      credential_id: actor.sessionId,
      target_id: team.id,
    })
    expect(rows[2]).toMatchObject({
      actor_id: actor.user.id,
      credential_id: actor.sessionId,
      target_id: invitation.id,
    })
    expect(JSON.stringify(rows)).not.toContain('Private synthetic team')
    expect(JSON.stringify(rows)).not.toContain(recipient.user.email)
    const member = await db
      .insertInto('auth.member')
      .values({
        userId: recipient.user.id,
        organizationId: team.id,
        role: 'member',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    expect(
      (
        await post(
          auth,
          '/organization/update-member-role',
          { organizationId: team.id, memberId: member.id, role: 'admin' },
          teamActor,
        )
      ).status,
    ).toBe(200)
    expect((await events(team.id))[3]?.details, 'role audit details').toEqual({
      oldRole: 'member',
      newRole: 'admin',
    })
  }
  it('records team creation, invitation cancellation and role details privately', () =>
    management())
  it.each([
    ['./team-role-policy.ts', "action: 'organization.created'", "action: 'organization.updated'"],
    [
      './invitation-cancellation.ts',
      "action: 'membership.invitation_cancelled'",
      "action: 'membership.invited'",
    ],
    ['./team-role-policy.ts', 'details: { oldRole: target.role, newRole: role }', 'details: {}'],
  ])('kills management audit source mutation %s %s', async (file, before, after) => {
    await expect(management(await sourceCopy(file, before, after))).rejects.toThrow(
      /management audit actions|role audit details/,
    )
  })
  it('kills a source copy omitting API key creation scope', async () => {
    await expect(
      reenable(
        await sourceCopy(
          './audit.ts',
          "details = { scope: metadata?.scope ?? 'full' }",
          'details = {}',
        ),
      ),
    ).rejects.toThrow(/creation scope audit detail/)
  })
})
