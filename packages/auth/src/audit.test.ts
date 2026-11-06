import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { DBTransactionAdapter } from 'better-auth/adapters'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../apps/server/src/app.ts'
import { authAuditRecords, withAuthAuditTransaction } from './audit.ts'
import { createCallerResolver } from './caller.ts'
import { type Auth, createAuth, createAuthPool } from './index.ts'
import { ensurePersonalOrganization } from './organizations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4471'
const secret = 'synthetic-audit-auth-test-secret-long-enough'

describe.skipIf(!serverUrl)('auth audit persistence', () => {
  let owned: TestDatabase, db: Db, auth: Auth
  let pool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
      mcpOAuth: true,
    })
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  })
  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })
  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({ name: 'Audit actor', email: `${randomUUID()}@example.test`, emailVerified: true })
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
      ...user,
      organizationId,
      sessionId: session.id,
      token,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  function post(path: string, body: unknown, actor?: Awaited<ReturnType<typeof account>>) {
    return app.request(`/api/auth${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(actor
          ? { cookie: actor.cookie, 'x-expected-organization-id': actor.organizationId }
          : {}),
      },
      body: JSON.stringify(body),
    })
  }
  async function events(organizationId: string) {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM audit_events WHERE organization_id=${organizationId} ORDER BY id`.execute(db)
    ).rows
  }
  function event(
    row: Record<string, unknown> | undefined,
    action: string,
    actor: Awaited<ReturnType<typeof account>>,
    targetId: string,
    details: Record<string, unknown> = {},
  ) {
    expect(row).toMatchObject({
      action,
      organization_id: actor.organizationId,
      actor_type: 'user',
      actor_id: actor.id,
      credential_type: 'session',
      credential_id: actor.sessionId,
      target_id: targetId,
      details,
    })
  }
  async function teamFixture() {
    const actor = await account(),
      target = await account()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Audit team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({ organizationId: team.id, userId: actor.id, role: 'owner', createdAt: new Date() })
      .execute()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: team.id })
      .where('id', '=', actor.sessionId)
      .execute()
    return { actor: { ...actor, organizationId: team.id }, target }
  }
  it('records invitation admission, acceptance and administrative removal', async () => {
    const { actor, target } = await teamFixture()
    const invite = await post(
      '/organization/invite-member',
      { organizationId: actor.organizationId, email: target.email, role: 'member' },
      actor,
    )
    expect(invite.status).toBe(200)
    const invitation = (await invite.json()) as { id: string }
    event((await events(actor.organizationId))[0], 'membership.invited', actor, invitation.id)
    const accept = await post(
      '/organization/accept-invitation',
      { invitationId: invitation.id },
      target,
    )
    expect(accept.status).toBe(200)
    event(
      (await events(actor.organizationId))[1],
      'membership.accepted',
      { ...target, organizationId: actor.organizationId },
      invitation.id,
    )
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', target.id)
      .where('organizationId', '=', actor.organizationId)
      .executeTakeFirstOrThrow()
    expect(
      (
        await post(
          '/organization/remove-member',
          { organizationId: actor.organizationId, memberIdOrEmail: member.id },
          actor,
        )
      ).status,
    ).toBe(200)
    event((await events(actor.organizationId))[2], 'membership.removed', actor, target.id)
  })
  it('records concurrent role changes as two ordered events and team settings privately', async () => {
    const { actor, target } = await teamFixture(),
      second = await account()
    const members = await db
      .insertInto('auth.member')
      .values(
        [target, second].map((user) => ({
          organizationId: actor.organizationId,
          userId: user.id,
          role: 'member',
          createdAt: new Date(),
        })),
      )
      .returning(['id', 'userId'])
      .execute()
    const responses = await Promise.all(
      members.map((member) =>
        post(
          '/organization/update-member-role',
          { organizationId: actor.organizationId, memberId: member.id, role: 'admin' },
          actor,
        ),
      ),
    )
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const rows = await events(actor.organizationId)
    expect(rows).toHaveLength(2)
    for (const row of rows)
      event(row, 'membership.role_changed', actor, String(row.target_id), {
        oldRole: 'member',
        newRole: 'admin',
      })
    expect(new Date(String(rows[1]?.occurred_at)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(rows[0]?.occurred_at)).getTime(),
    )
    expect(
      (
        await post(
          '/organization/update',
          { organizationId: actor.organizationId, data: { name: 'Private new title' } },
          actor,
        )
      ).status,
    ).toBe(200)
    event(
      (await events(actor.organizationId))[2],
      'organization.updated',
      actor,
      actor.organizationId,
    )
    expect(JSON.stringify(await events(actor.organizationId))).not.toContain('Private new title')
  })
  it('records key create, disable and delete without key material; isolates organizations', async () => {
    const actor = await account(),
      other = await account()
    const created = await post(
      '/api-key/create',
      { name: 'private label', metadata: { scope: 'bookings' } },
      actor,
    )
    expect(created.status).toBe(200)
    const key = (await created.json()) as { id: string; key: string }
    event((await events(actor.organizationId))[0], 'api_key.created', actor, key.id, {
      scope: 'bookings',
    })
    expect(JSON.stringify(await events(actor.organizationId))).not.toContain(key.key)
    expect(
      (await post('/api-key/update', { keyId: key.id, name: 'Renamed private label' }, actor))
        .status,
    ).toBe(200)
    event((await events(actor.organizationId))[1], 'api_key.updated', actor, key.id)
    expect((await post('/api-key/update', { keyId: key.id, enabled: false }, actor)).status).toBe(
      200,
    )
    event((await events(actor.organizationId))[2], 'api_key.revoked', actor, key.id)
    expect((await post('/api-key/delete', { keyId: key.id }, actor)).status).toBe(200)
    event((await events(actor.organizationId))[3], 'api_key.revoked', actor, key.id)
    expect(await events(other.organizationId)).toEqual([])
  })
  it('records explicit session revocation by id without storing its bearer token', async () => {
    const actor = await account()
    const token = randomBytes(24).toString('base64url')
    const target = await db
      .insertInto('auth.session')
      .values({
        userId: actor.id,
        token,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    expect((await post('/revoke-session', { token }, actor)).status).toBe(200)
    const rows = await events(actor.organizationId)
    expect(rows).toHaveLength(1)
    event(rows[0], 'session.revoked', actor, target.id)
    expect(JSON.stringify(rows)).not.toContain(token)
  })
  it('records one actual revocation when two requests race for the same session', async () => {
    const actor = await account(),
      token = randomBytes(24).toString('base64url')
    const target = await db
      .insertInto('auth.session')
      .values({
        userId: actor.id,
        token,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const secondToken = randomBytes(24).toString('base64url')
    const secondSession = await db
      .insertInto('auth.session')
      .values({
        userId: actor.id,
        token: secondToken,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
        activeOrganizationId: actor.organizationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const secondSignature = createHmac('sha256', secret).update(secondToken).digest('base64')
    const secondActor = {
      ...actor,
      sessionId: secondSession.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${secondToken}.${secondSignature}`)}`,
    }
    const blocker = await owned.pool.connect()
    let responses: Response[]
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM auth.session WHERE id=$1 FOR UPDATE', [target.id])
      const requests = [
        post('/revoke-session', { token }, actor),
        post('/revoke-session', { token }, secondActor),
      ]
      let waiting = 0
      const deadline = Date.now() + 5000
      while (waiting < 2 && Date.now() < deadline) {
        const locks = await owned.pool.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        )
        waiting = Number(locks.rows[0]?.count ?? 0)
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await blocker.query('COMMIT')
      responses = await Promise.all(requests)
      expect(waiting).toBeGreaterThanOrEqual(2)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    expect(responses.every((response) => response.status === 200)).toBe(true)
    const rows = await events(actor.organizationId)
    expect(rows).toHaveLength(1)
    expect([actor.sessionId, secondActor.sessionId]).toContain(rows[0]?.credential_id)
    event(
      rows[0],
      'session.revoked',
      { ...actor, sessionId: String(rows[0]?.credential_id) },
      target.id,
    )
  })
  it('records sign-in method addition and removal without provider credentials', async () => {
    const actor = await account()
    const context = await auth.$context
    const added = await context.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'account',
      data: {
        userId: actor.id,
        providerId: 'google',
        accountId: randomUUID(),
        accessToken: 'synthetic-provider-token',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    const initial = await events(actor.organizationId)
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({
      action: 'sign_in_method.added',
      actor_type: 'user',
      actor_id: actor.id,
      credential_type: 'none',
      target_id: added.id,
      details: {},
    })
    await db
      .insertInto('auth.account')
      .values({
        userId: actor.id,
        providerId: 'microsoft',
        accountId: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    expect((await post('/unlink-account', { accountId: added.id }, actor)).status).toBe(200)
    event((await events(actor.organizationId))[1], 'sign_in_method.removed', actor, added.id)
    expect(JSON.stringify(await events(actor.organizationId))).not.toContain(
      'synthetic-provider-token',
    )
  })
  it('records every revoked session in a bulk operation', async () => {
    const actor = await account()
    const rows = await db
      .insertInto('auth.session')
      .values(
        [1, 2].map(() => ({
          userId: actor.id,
          token: randomBytes(24).toString('base64url'),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })),
      )
      .returning('id')
      .execute()
    expect((await post('/revoke-other-sessions', {}, actor)).status).toBe(200)
    const recorded = await events(actor.organizationId)
    expect(recorded).toHaveLength(2)
    expect(recorded.map((row) => row.target_id).sort()).toEqual(rows.map((row) => row.id).sort())
    for (const row of recorded) event(row, 'session.revoked', actor, String(row.target_id))
  })
  it('enumerates more than the native default page when revoking all sessions', async () => {
    const actor = await account()
    await db
      .insertInto('auth.session')
      .values(
        Array.from({ length: 105 }, () => ({
          userId: actor.id,
          token: randomBytes(24).toString('base64url'),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })),
      )
      .execute()
    expect((await post('/revoke-sessions', {}, actor)).status).toBe(200)
    expect(
      await db.selectFrom('auth.session').select('id').where('userId', '=', actor.id).execute(),
    ).toEqual([])
    const rows = await events(actor.organizationId)
    expect(rows).toHaveLength(106)
    for (const row of rows) event(row, 'session.revoked', actor, String(row.target_id))
  })
  it('rolls back every bulk revocation if a later session audit fails', async () => {
    const actor = await account()
    const sessions = await db
      .insertInto('auth.session')
      .values(
        [1, 2, 3].map(() => ({
          userId: actor.id,
          token: randomBytes(24).toString('base64url'),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })),
      )
      .returning('id')
      .execute()
    await sql`CREATE FUNCTION reject_later_session_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM audit_events WHERE action='session.revoked' AND actor_id=NEW.actor_id) THEN
        RAISE EXCEPTION 'synthetic later session audit failure';
      END IF; RETURN NEW; END $$`.execute(db)
    await sql`CREATE TRIGGER reject_later_session_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_later_session_audit()`.execute(
      db,
    )
    try {
      expect((await post('/revoke-other-sessions', {}, actor)).status).toBe(500)
      const remaining = await db
        .selectFrom('auth.session')
        .select('id')
        .where('userId', '=', actor.id)
        .execute()
      expect(remaining.map((row) => row.id).sort()).toEqual(
        [actor.sessionId, ...sessions.map((row) => row.id)].sort(),
      )
      expect(await events(actor.organizationId)).toEqual([])
    } finally {
      await sql`DROP TRIGGER reject_later_session_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION reject_later_session_audit()`.execute(db)
    }
  })
  it('attributes sign-out and refuses success when its audit fails', async () => {
    const actor = await account()
    await sql`CREATE FUNCTION reject_signout_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic signout audit failure'; END $$`.execute(
      db,
    )
    await sql`CREATE TRIGGER reject_signout_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_signout_audit()`.execute(
      db,
    )
    try {
      expect((await post('/sign-out', {}, actor)).status).toBe(500)
      expect(
        await db
          .selectFrom('auth.session')
          .select('id')
          .where('id', '=', actor.sessionId)
          .executeTakeFirst(),
      ).toBeDefined()
      expect(await events(actor.organizationId)).toEqual([])
    } finally {
      await sql`DROP TRIGGER reject_signout_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION reject_signout_audit()`.execute(db)
    }
    expect((await post('/sign-out', {}, actor)).status).toBe(200)
    event((await events(actor.organizationId))[0], 'session.revoked', actor, actor.sessionId)
  })
  it('does not commit sign-out when post-delete attribution cannot resolve its organization', async () => {
    const actor = await account()
    await db.deleteFrom('personal_organizations').where('user_id', '=', actor.id).execute()
    expect((await post('/sign-out', {}, actor)).status).toBe(500)
    expect(
      await db
        .selectFrom('auth.session')
        .select('id')
        .where('id', '=', actor.sessionId)
        .executeTakeFirst(),
    ).toBeDefined()
    expect(await events(actor.organizationId)).toEqual([])
  })
  it('drains delayed native adapter siblings before rolling back a failed bulk request', async () => {
    const actor = await account()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finished = false
    let lateQueryAfterTransaction = false
    const result = db
      .transaction()
      .execute((trx) =>
        withAuthAuditTransaction(trx, async () => {
          const adapter = {
            create: async (request: { data: { fail?: boolean } }) => {
              if (request.data.fail) throw new Error('synthetic attribution failure')
              entered()
              await gate
              lateQueryAfterTransaction = finished
              await trx
                .updateTable('auth.organization')
                .set({ name: 'must roll back' })
                .where('id', '=', actor.organizationId)
                .execute()
              return null
            },
            update: async () => null,
            updateMany: async () => 0,
            incrementOne: async () => null,
            delete: async () => {},
            deleteMany: async () => 0,
            consumeOne: async () => null,
            transaction: async () => {},
          } as unknown as DBTransactionAdapter
          await authAuditRecords().init?.({ adapter } as never)
          await Promise.all([
            adapter.create({ model: 'synthetic', data: { fail: true } }),
            adapter.create({ model: 'synthetic', data: {} }),
          ])
        }),
      )
      .then(
        () => null,
        (error) => error,
      )
      .finally(() => {
        finished = true
      })
    await started
    // Give a broken wrapper time to close its transaction before the delayed sibling.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const endedBeforeRelease = finished
    release()
    const failure = await result
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe('synthetic attribution failure')
    expect(endedBeforeRelease).toBe(false)
    expect(lateQueryAfterTransaction).toBe(false)
    expect(
      (
        await db
          .selectFrom('auth.organization')
          .select('name')
          .where('id', '=', actor.organizationId)
          .executeTakeFirstOrThrow()
      ).name,
    ).not.toBe('must roll back')
  })
  it('refuses a native sibling that reaches its mutation only after transaction closure', async () => {
    const actor = await account()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reachedMutation = false
    let sibling: Promise<unknown> | undefined
    const result = await db
      .transaction()
      .execute((trx) =>
        withAuthAuditTransaction(trx, async () => {
          const adapter = {
            create: async () => {
              reachedMutation = true
              await trx
                .updateTable('auth.organization')
                .set({ name: 'late untracked write' })
                .where('id', '=', actor.organizationId)
                .execute()
              return null
            },
            update: async () => null,
            updateMany: async () => 0,
            incrementOne: async () => null,
            delete: async () => {},
            deleteMany: async () => 0,
            consumeOne: async () => null,
            transaction: async () => {},
          } as unknown as DBTransactionAdapter
          await authAuditRecords().init?.({ adapter } as never)
          const late = (async () => {
            await gate
            return adapter.create({ model: 'synthetic', data: {} })
          })()
          sibling = late.then(
            () => null,
            (error) => error,
          )
          await Promise.all([Promise.reject(new Error('synthetic early failure')), late])
        }),
      )
      .then(
        () => null,
        (error) => error,
      )
    release()
    const rejected = await sibling
    expect(result).toBeInstanceOf(Error)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toBe('Auth transaction is closing')
    expect(reachedMutation).toBe(false)
    expect(
      (
        await db
          .selectFrom('auth.organization')
          .select('name')
          .where('id', '=', actor.organizationId)
          .executeTakeFirstOrThrow()
      ).name,
    ).not.toBe('late untracked write')
  })
  it('fails closed when the audit INSERT fails and rolls back key creation', async () => {
    const actor = await account()
    await sql`CREATE FUNCTION reject_auth_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`.execute(
      db,
    )
    await sql`CREATE TRIGGER reject_auth_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_auth_audit()`.execute(
      db,
    )
    try {
      const response = await post('/api-key/create', {}, actor)
      expect(response.status).toBe(500)
      expect(
        await db
          .selectFrom('auth.apikey')
          .select('id')
          .where('referenceId', '=', actor.id)
          .execute(),
      ).toEqual([])
      expect(await events(actor.organizationId)).toEqual([])
    } finally {
      await sql`DROP TRIGGER reject_auth_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION reject_auth_audit()`.execute(db)
    }
  })
  it('records public OAuth client registration without inventing an organization', async () => {
    const response = await post('/oauth2/register', {
      client_name: 'Synthetic app',
      redirect_uris: ['https://example.test/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })
    expect(response.status).toBe(201)
    const client = (await response.json()) as { client_id: string }
    const rows = (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM audit_events WHERE target_id=${client.client_id}`.execute(db)
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'oauth.client_registered',
      organization_id: null,
      actor_type: 'anonymous',
      credential_type: 'none',
      details: {},
    })
  })
})
