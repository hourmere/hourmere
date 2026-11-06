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
  async function expiry(factory = createAuth) {
    const auth = instance(factory),
      actor = await account(),
      other = await account()
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
    expect((await post(auth, '/api-key/create', {}, actor)).status).toBe(200)
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
    expect(await events(actor.organizationId)).toHaveLength(1)
  }
  it('does not attribute expired foreign keys to a creating user', () => expiry(), 30000)
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
  }
  it('preserves native revoked-token status and family invalidation after disconnect', () =>
    disconnected())
  it('kills a source copy requiring a deleted OAuth grant', async () => {
    await expect(
      disconnected(
        await sourceCopy(
          './audit.ts',
          'organizationId = grant?.organization_id ?? null',
          "if (!grant) throw new Error('OAuth audit requires its organization grant'); organizationId = grant.organization_id",
        ),
      ),
    ).rejects.toThrow(/native revocation status after disconnect/)
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
