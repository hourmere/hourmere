import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { signJWT } from 'better-auth/plugins/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiKeyRules } from './api-keys.ts'
import { displayNameRules } from './display-name.ts'
import type { beforeHook } from './hooks.ts'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
} from './index.ts'
import { invitationRules } from './invitations.ts'
import { checkListQuery, emptyMemberList } from './lists.ts'
import { defaultMagicLinkErrorRedirect } from './magic-link.ts'
import { organizationContext } from './organization-context.ts'
import { ensurePersonalOrganization, isUuid, personalOwner } from './organizations.ts'
import { fixedTeamRole, teamRoleDenied } from './team-role-policy.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43830'
const secret = 'synthetic-team-session-boundary-secret-at-least-32-characters'
const signup = { mode: 'open', allowedDomains: [] } as const
const rejection = {
  code: 'SESSION_REQUIRED',
  message: 'Organization management requires a browser session without Authorization',
}

describe.skipIf(!serverUrl)('browser-only organization management', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  const fixtures = new Map<string, Awaited<ReturnType<typeof fixture>>>()

  function createFixtureAuth() {
    return createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
    })
  }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createFixtureAuth()
    for (const role of ['owner', 'admin'] as const) fixtures.set(role, await fixture(role))
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function actor() {
    const id = randomUUID()
    const email = `${id}@example.test`
    await db
      .insertInto('auth.user')
      .values({ id, name: 'Synthetic boundary actor', email, emailVerified: true })
      .execute()
    await ensurePersonalOrganization(db, id)
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        token,
        userId: id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id,
      email,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(role: 'owner' | 'admin') {
    const owner = await actor()
    const caller = role === 'owner' ? owner : await actor()
    const target = await actor()
    const organizationId = randomUUID()
    await db
      .insertInto('auth.organization')
      .values({
        id: organizationId,
        name: 'Synthetic boundary team',
        slug: organizationId,
        createdAt: new Date(),
      })
      .execute()
    await db
      .insertInto('auth.member')
      .values({ organizationId, userId: owner.id, role: 'owner', createdAt: new Date() })
      .execute()
    if (role === 'admin') {
      await db
        .insertInto('auth.member')
        .values({ organizationId, userId: caller.id, role: 'admin', createdAt: new Date() })
        .execute()
    }
    const member = await db
      .insertInto('auth.member')
      .values({ organizationId, userId: target.id, role: 'member', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: organizationId })
      .where('id', '=', caller.sessionId)
      .execute()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId,
        inviterId: owner.id,
        email: caller.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const key = await auth.api.createApiKey({
      body: { userId: caller.id, metadata: { organizationId } },
    })
    const apiKey = `Bearer ${key.key}`
    const resolvedKey = await createCallerResolver({ auth, db })(
      new Headers({ authorization: apiKey }),
    )
    expect(resolvedKey.ok && resolvedKey.principal.kind === 'api_key').toBe(true)

    const clientId = `https://boundary.test/${randomUUID()}.json`
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: caller.id, organization_id: organizationId, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthClient')
      .values({ clientId, redirectUris: JSON.stringify(['https://boundary.test/callback']) })
      .execute()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: caller.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const oauth = `Bearer ${await signJWT(
      { context: await auth.$context } as Parameters<typeof signJWT>[0],
      {
        header: { typ: 'at+jwt' },
        payload: {
          sub: caller.id,
          client_id: clientId,
          scope: 'mcp:tools',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: `${origin}/api/auth`,
          aud: `${origin}/mcp`,
          'https://hourmere.com/organization': organizationId,
          'https://hourmere.com/grant': grant.id,
        },
      },
    )}`
    const resolvedOAuth = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
      new Request(`${origin}/mcp`, { headers: { authorization: oauth } }),
    )
    expect(resolvedOAuth.ok).toBe(true)
    return {
      caller,
      organizationId,
      memberId: member.id,
      invitationId: invitation.id,
      apiKey,
      oauth,
    }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>
  type Operation = { path: string; method: 'GET' | 'POST'; body?: object }

  function operations(f: Fixture): Operation[] {
    return [
      { path: 'list', method: 'GET' },
      { path: `get-organization?organizationId=${f.organizationId}`, method: 'GET' },
      { path: `get-full-organization?organizationId=${f.organizationId}`, method: 'GET' },
      { path: 'get-active-member', method: 'GET' },
      { path: 'get-active-member-role', method: 'GET' },
      { path: `list-members?organizationId=${f.organizationId}`, method: 'GET' },
      { path: `list-invitations?organizationId=${f.organizationId}`, method: 'GET' },
      { path: 'list-user-invitations', method: 'GET' },
      { path: `get-invitation?id=${f.invitationId}`, method: 'GET' },
      {
        path: 'create',
        method: 'POST',
        body: { name: 'Synthetic denied team', slug: randomUUID() },
      },
      { path: 'check-slug', method: 'POST', body: { slug: f.organizationId } },
      { path: 'set-active', method: 'POST', body: { organizationId: f.organizationId } },
      {
        path: 'update',
        method: 'POST',
        body: { organizationId: f.organizationId, data: { name: 'Synthetic denied update' } },
      },
      { path: 'delete', method: 'POST', body: { organizationId: f.organizationId } },
      {
        path: 'invite-member',
        method: 'POST',
        body: {
          organizationId: f.organizationId,
          email: 'synthetic@boundary.test',
          role: 'member',
        },
      },
      { path: 'cancel-invitation', method: 'POST', body: { invitationId: f.invitationId } },
      { path: 'accept-invitation', method: 'POST', body: { invitationId: f.invitationId } },
      { path: 'reject-invitation', method: 'POST', body: { invitationId: f.invitationId } },
      {
        path: 'update-member-role',
        method: 'POST',
        body: { organizationId: f.organizationId, memberId: f.memberId, role: 'admin' },
      },
      {
        path: 'remove-member',
        method: 'POST',
        body: { organizationId: f.organizationId, memberIdOrEmail: f.memberId },
      },
      { path: 'leave', method: 'POST', body: { organizationId: f.organizationId } },
      {
        path: 'has-permission',
        method: 'POST',
        body: { organizationId: f.organizationId, permissions: { member: ['delete'] } },
      },
    ]
  }

  function request(f: Fixture, operation: Operation, authorization?: string, selected = auth) {
    return selected.handler(
      new Request(`${origin}/api/auth/organization/${operation.path}`, {
        method: operation.method,
        headers: {
          cookie: f.caller.cookie,
          origin,
          'content-type': 'application/json',
          'x-expected-organization-id': f.organizationId,
          ...(authorization === undefined ? {} : { authorization }),
        },
        ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
      }),
    )
  }

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(rejection)
  }

  describe.each(['owner', 'admin'] as const)('%s browser session', (role) => {
    it('retains cookie-only team reads and writes', async () => {
      const f = fixtures.get(role) as Fixture
      const response = await request(f, {
        path: `get-full-organization?organizationId=${f.organizationId}`,
        method: 'GET',
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { id: string }).id).toBe(f.organizationId)
      const updated = await request(f, {
        path: 'update',
        method: 'POST',
        body: { organizationId: f.organizationId, data: { name: 'Synthetic boundary team' } },
      })
      expect(updated.status).toBe(200)
    })

    it.each(['apiKey', 'oauth', 'empty'] as const)(
      'denies %s Authorization throughout organization reads and writes despite the valid cookie',
      async (credential) => {
        const f = fixtures.get(role) as Fixture
        const authorization = credential === 'empty' ? '' : f[credential]
        for (const operation of operations(f)) {
          await expectDenied(await request(f, operation, authorization))
        }
        const organization = await db
          .selectFrom('auth.organization')
          .select('name')
          .where('id', '=', f.organizationId)
          .executeTakeFirstOrThrow()
        expect(organization.name).toBe('Synthetic boundary team')
        const member = await db
          .selectFrom('auth.member')
          .select('role')
          .where('id', '=', f.memberId)
          .executeTakeFirstOrThrow()
        expect(member.role).toBe('member')
        const invitation = await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', f.invitationId)
          .executeTakeFirstOrThrow()
        expect(invitation.status).toBe('pending')
        const records = await db
          .selectFrom('organization_operations')
          .select('id')
          .where('organization_id', '=', f.organizationId)
          .execute()
        expect(records).toEqual([])
      },
    )
  })

  it.each(['Bearer invalid', 'Basic synthetic', 'Bearer', 'DPoP synthetic'])(
    'treats every present Authorization scheme as the agent boundary (%s)',
    async (authorization) => {
      const f = fixtures.get('owner') as Fixture
      await expectDenied(await request(f, { path: 'list-members', method: 'GET' }, authorization))
    },
  )

  it('denies before target validation or organization context can reveal target existence', async () => {
    const f = fixtures.get('owner') as Fixture
    for (const organizationId of [f.organizationId, randomUUID(), 'invalid']) {
      await expectDenied(
        await request(
          f,
          { path: `get-full-organization?organizationId=${organizationId}`, method: 'GET' },
          f.apiKey,
        ),
      )
      await expectDenied(
        await request(
          f,
          { path: 'update', method: 'POST', body: { organizationId, data: {} } },
          f.apiKey,
        ),
      )
    }
  })

  it('preserves trusted server-side organization APIs', async () => {
    const f = fixtures.get('owner') as Fixture
    const organization = await auth.api.getFullOrganization({
      headers: new Headers({ cookie: f.caller.cookie, authorization: f.apiKey }),
      query: { organizationId: f.organizationId },
    })
    expect(organization?.id).toBe(f.organizationId)
  })

  it('keeps standalone auth invitation fixtures usable without server job wiring', async () => {
    const f = fixtures.get('owner') as Fixture
    const response = await request(f, {
      path: 'invite-member',
      method: 'POST',
      body: { organizationId: f.organizationId, email: `${randomUUID()}@example.test` },
    })
    expect(response.status).toBe(200)
    const invitation = (await response.json()) as {
      id: string
      delivery: { generation: number; state: string; attempts: number }
    }
    expect(invitation.delivery).toEqual({ generation: 1, state: 'queued', attempts: 0 })
    const delivery = await db
      .selectFrom('invitation_deliveries')
      .select(['generation', 'state', 'attempts'])
      .where('invitation_id', '=', invitation.id)
      .executeTakeFirstOrThrow()
    expect(delivery).toEqual(invitation.delivery)
  })

  function sourceCopy(removeBoundary: boolean): typeof beforeHook {
    let source = readFileSync('packages/auth/src/hooks.ts', 'utf8')
    if (removeBoundary) {
      const original = '    requireOrganizationSession(ctx)\n'
      expect(source.includes(original), 'mutation must match source').toBe(true)
      source = source.replace(original, '')
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const bindings = {
      APIError,
      createAuthMiddleware,
      getSessionFromCtx,
      apiKeyRules,
      displayNameRules,
      invitationRules,
      checkListQuery,
      emptyMemberList,
      defaultMagicLinkErrorRedirect,
      organizationContext,
      isUuid,
      personalOwner,
      fixedTeamRole,
      teamRoleDenied,
    }
    return new Function(...Object.keys(bindings), `${source}; return beforeHook`)(
      ...Object.values(bindings),
    ) as typeof beforeHook
  }

  async function verifyBoundary(hook: typeof beforeHook) {
    const selected = createFixtureAuth()
    selected.options.hooks = { before: hook(db, async () => {}) }
    const f = fixtures.get('owner') as Fixture
    const operation = {
      path: `get-full-organization?organizationId=${f.organizationId}`,
      method: 'GET',
    } as const
    expect((await request(f, operation, undefined, selected)).status).toBe(200)
    await expectDenied(await request(f, operation, f.apiKey, selected))
  }

  it('passes the real HTTP boundary assertions with an unmodified auth hook source copy', async () => {
    await expect(verifyBoundary(sourceCopy(false))).resolves.toBeUndefined()
  })

  it('detects removal of Authorization precedence with a real HTTP assertion failure', async () => {
    const hook = sourceCopy(true)
    await expect(verifyBoundary(hook)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
