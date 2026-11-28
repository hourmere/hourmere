import { randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { proveMailbox } from '../../../../packages/db/src/sso-identity-fixtures.ts'
import { createApp } from '../app.ts'
import { productRoutes } from '../server.ts'
import { BROWSER_BINDING_COOKIE } from '../sso-mailbox-proof.ts'
import { customRoleRoutes } from './custom-roles.ts'
import { PUBLIC_URL, productApp, syntheticSessionCookie } from './test-app.ts'

const databaseUrl = process.env.DATABASE_URL
const capabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false, ssoOperatorSetting: true }
const initialRole = { name: 'Scheduling coordinator', permissionIds: ['event_types.create'] }

it('hard-disables every custom-role route before lookup, credential resolution or validation', async () => {
  const db = {} as Db
  const resolveCaller = vi.fn()
  const app = createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    publicUrl: PUBLIC_URL,
    resolveCaller,
    routes: productRoutes({
      db,
      publicUrl: PUBLIC_URL,
      socialProviders: {},
      invitationMailLimits: { secret: 'synthetic-hard-off-test' },
    }),
  })
  const paths = [
    ['GET', 'permissions'],
    ['GET', 'roles'],
    ['POST', 'roles'],
    ['GET', 'roles/wrong'],
    ['PATCH', 'roles/wrong'],
    ['DELETE', 'roles/wrong'],
    ['PUT', 'members/wrong/custom-role'],
  ]
  for (const [method, suffix] of paths) {
    const response = await app.request(`/api/v1/teams/wrong/${suffix}`, {
      method,
      headers: { authorization: 'Bearer synthetic' },
    })
    expect(response.status, `${method} ${suffix}`).toBe(404)
    expect(await response.json()).toEqual({ error: 'custom_roles_disabled' })
  }
  expect(resolveCaller).not.toHaveBeenCalled()
})

describe.skipIf(!databaseUrl)('custom role browser REST', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof productApp>
  const teamId = randomUUID()
  const organization = { id: teamId, name: 'Roles fixture', slug: teamId, personal: false }
  const principals = new Map<string, Principal>()
  const root = `/api/v1/teams/${teamId}`
  const browserBinding = randomBytes(32).toString('base64url')

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = createDb(owned.pool)
    app = productApp(db, principals, [
      customRoleRoutes({ db, capabilities, publicUrl: PUBLIC_URL, enabled: true }),
    ])
    await db
      .insertInto('auth.organization')
      .values({ id: teamId, name: organization.name, slug: teamId, createdAt: new Date() })
      .execute()
    await db
      .updateTable('custom_role_master_policy')
      .set({ enabled: true, policy_epoch: 1 })
      .execute()
    await db
      .updateTable('team_custom_role_policies')
      .set({ enabled: true, policy_epoch: 1 })
      .where('organization_id', '=', teamId)
      .execute()
    for (const role of ['owner', 'admin', 'member', 'admin, unexpected']) {
      const id = randomUUID()
      const user = { id, name: role, email: `${id}@example.test` }
      await db
        .insertInto('auth.user')
        .values({ ...user, emailVerified: true })
        .execute()
      await db
        .insertInto('auth.member')
        .values({ organizationId: teamId, userId: id, role, createdAt: new Date() })
        .execute()
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: id,
          token: randomUUID(),
          activeOrganizationId: teamId,
          expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      principals.set(encodeURIComponent(role), {
        kind: 'session',
        user,
        organization,
        sessionId: session.id,
      })
    }
  })

  afterAll(async () => owned?.drop())

  async function request(
    method: string,
    path: string,
    input?: unknown,
    role = 'owner',
    extra?: Record<string, string>,
  ) {
    const headers = new Headers(extra)
    if (!headers.has('origin')) headers.set('origin', PUBLIC_URL)
    headers.set('X-Expected-Organization-Id', teamId)
    headers.set(
      'cookie',
      `${syntheticSessionCookie(encodeURIComponent(role))}; ${BROWSER_BINDING_COOKIE}=${browserBinding}`,
    )
    if (input !== undefined) headers.set('content-type', 'application/json')
    const response = await app.request(`${root}${path}`, {
      method,
      headers,
      ...(input !== undefined && { body: JSON.stringify(input) }),
    })
    return { status: response.status, body: await response.json() }
  }

  async function verify(attemptId: string) {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await proveMailbox(client, { id: attemptId, organization_id: teamId })
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it('requires same-origin Owner cookie, binds fresh proof to input, and consumes it once', async () => {
    const denied = { status: 403, body: { error: 'team_management_access_denied' } }
    await expect(request('POST', '/roles', initialRole, 'admin')).resolves.toEqual(denied)
    await expect(
      request('POST', '/roles', initialRole, 'owner', { authorization: 'Bearer synthetic' }),
    ).resolves.toEqual(denied)
    await expect(
      request('POST', '/roles', initialRole, 'owner', { origin: 'https://other.example' }),
    ).resolves.toEqual(denied)
    await expect(request('GET', '/roles', undefined, 'member')).resolves.toEqual(denied)
    await expect(
      request('POST', '/roles', { ...initialRole, permissionIds: ['members.assign_role'] }),
    ).resolves.toMatchObject({ status: 400, body: { error: 'invalid_request' } })

    await expect(
      request('GET', '/permissions', undefined, 'admin, unexpected'),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        decisions: expect.arrayContaining([
          { operation: 'members.read_private', allowed: false, source: null },
        ]),
      },
    })
    await db.transaction().execute(async (trx) => {
      const owner = principals.get('owner')
      if (owner?.kind !== 'session') throw new Error('Missing owner session')
      const lock = `hourmere.organization-context:${owner.sessionId}`
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`.execute(trx)
      await expect(request('POST', '/roles', initialRole)).resolves.toMatchObject({
        status: 409,
        body: { error: 'organization_context_changed' },
      })
    })
    await expect(db.selectFrom('sso_attempts').select('id').execute()).resolves.toEqual([])

    const challenge = await request('POST', '/roles', initialRole)
    expect(challenge).toMatchObject({
      status: 403,
      body: { error: 'sso_reauthentication_required', proofMethods: ['mailbox'] },
    })
    const attempt = z.object({ attemptId: z.uuid() })
    const { attemptId: proofAttemptId } = attempt.parse(challenge.body)
    expect(proofAttemptId).toEqual(expect.any(String))
    await verify(proofAttemptId)

    const changed = await request('POST', '/roles', {
      ...initialRole,
      name: 'Changed',
      proofAttemptId,
    })
    expect(changed).toMatchObject({
      status: 403,
      body: { error: 'sso_reauthentication_required' },
    })
    expect(attempt.parse(changed.body).attemptId).not.toBe(proofAttemptId)

    const input = { ...initialRole, proofAttemptId }
    const created = await request('POST', '/roles', input)
    expect(created).toMatchObject({ status: 200, body: { role: { ...initialRole, revision: 1 } } })
    await expect(request('POST', '/roles', input)).resolves.toMatchObject({ status: 403 })
    await expect(request('GET', '/roles')).resolves.toMatchObject({
      status: 200,
      body: [z.object({ role: z.unknown() }).parse(created.body).role],
    })
    await expect(request('GET', '/permissions', undefined, 'member')).resolves.toMatchObject({
      status: 200,
      body: {
        decisions: expect.arrayContaining([
          { operation: 'members.read', allowed: true, source: 'fixed' },
          { operation: 'invitations.create', allowed: false, source: null },
        ]),
      },
    })
    const audit = await db
      .selectFrom('audit_events')
      .select(['actor_id', 'credential_id'])
      .where('organization_id', '=', teamId)
      .where('action', '=', 'custom_role.created')
      .execute()
    expect(audit).toEqual([{ actor_id: principals.get('owner')?.user.id, credential_id: null }])
  })
})
