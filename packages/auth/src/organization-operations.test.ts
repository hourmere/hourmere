import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { type AuthEndpointContext, runWithEndpointContext } from '@better-auth/core/context'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { leaveTeamMember } from '@hourmere/scheduling'
import type { DBTransactionAdapter } from 'better-auth/adapters'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Auth, createAuth, createAuthPool } from './index.ts'
import { ensurePersonalOrganization } from './organizations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43829'
const secret = 'synthetic-member-operation-test-secret-at-least-32-characters'
const signup = { mode: 'open', allowedDomains: [] } as const

interface Operation {
  id: string
  organization_id: string
  operation: string
  actor_user_id: string
  booking_id: null
  target_user_id: string
  previous_role: string
  new_role: string | null
  source: string
  api_key_id: null
  oauth_consent_id: null
  occurred_at: Date
}

describe.skipIf(!serverUrl)('member operation attribution', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
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
      .values({ id, name: 'Synthetic member', email, emailVerified: true })
      .execute()
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        token,
        userId: id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id,
      email,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture() {
    const owner = await actor()
    const target = await actor()
    const organizationId = randomUUID()
    await db
      .insertInto('auth.organization')
      .values({
        id: organizationId,
        name: 'Synthetic team',
        slug: organizationId,
        createdAt: new Date(),
      })
      .execute()
    await db
      .insertInto('auth.member')
      .values({ organizationId, userId: owner.id, role: 'owner', createdAt: new Date() })
      .execute()
    const member = await db
      .insertInto('auth.member')
      .values({ organizationId, userId: target.id, role: 'member', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: organizationId })
      .where('userId', 'in', [owner.id, target.id])
      .execute()
    return { owner, target, organizationId, memberId: member.id }
  }

  function post(path: string, cookie: string, body: object, expectedOrganizationId?: string) {
    return auth.handler(
      new Request(`${origin}/api/auth/organization/${path}`, {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/json',
          ...(expectedOrganizationId === undefined
            ? {}
            : { 'X-Expected-Organization-Id': expectedOrganizationId }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  async function operations(organizationId: string) {
    return (
      await owned.pool.query<Operation>(
        'SELECT * FROM public.organization_operations WHERE organization_id = $1 ORDER BY occurred_at, id',
        [organizationId],
      )
    ).rows
  }

  async function membership(id: string) {
    return db.selectFrom('auth.member').selectAll().where('id', '=', id).executeTakeFirst()
  }

  function expected(f: Awaited<ReturnType<typeof fixture>>, actorUserId: string, newRole?: string) {
    return {
      id: expect.any(String),
      organization_id: f.organizationId,
      operation: newRole === undefined ? 'member_removed' : 'member_role_changed',
      actor_user_id: actorUserId,
      booking_id: null,
      target_user_id: f.target.id,
      previous_role: 'member',
      new_role: newRole ?? null,
      source: 'web',
      api_key_id: null,
      oauth_consent_id: null,
      occurred_at: expect.any(Date),
    }
  }

  it('records the actual session actor and stored target while retaining only allowlisted fields', async () => {
    const f = await fixture()
    const response = await post(
      'remove-member',
      f.owner.cookie,
      {
        organizationId: f.organizationId,
        memberIdOrEmail: f.target.email,
        actorUserId: f.target.id,
        targetUserId: f.owner.id,
        source: 'api',
        apiKeyId: randomUUID(),
        token: 'synthetic-private-value',
        emailBody: 'synthetic-private-value',
        responses: { answer: 'synthetic-private-value' },
      },
      f.organizationId,
    )
    expect(response.status).toBe(200)
    expect(await membership(f.memberId)).toBeUndefined()
    const records = await operations(f.organizationId)
    expect(JSON.stringify(records).includes('synthetic-private-value')).toBe(false)
    expect(JSON.stringify(records).includes(f.owner.cookie)).toBe(false)
    expect(JSON.stringify(records).includes(f.target.email)).toBe(false)
    expect(records).toEqual([expected(f, f.owner.id)])
  })

  it('attributes ordinary leave to the member and clears their active team', async () => {
    const f = await fixture()
    const response = await post(
      'leave',
      f.target.cookie,
      { organizationId: f.organizationId },
      f.organizationId,
    )
    expect(response.status).toBe(200)
    expect(await membership(f.memberId)).toBeUndefined()
    expect(await operations(f.organizationId)).toEqual([expected(f, f.target.id)])
    const session = await db
      .selectFrom('auth.session')
      .select('activeOrganizationId')
      .where('userId', '=', f.target.id)
      .executeTakeFirstOrThrow()
    expect(session.activeOrganizationId).toBe(await ensurePersonalOrganization(db, f.target.id))
  })

  it('retains only allowlisted role-change attribution without session credentials', async () => {
    const f = await fixture()
    const response = await post(
      'update-member-role',
      f.owner.cookie,
      {
        organizationId: f.organizationId,
        memberId: f.memberId,
        role: 'admin',
        actorUserId: f.target.id,
        token: 'synthetic-private-value',
        emailBody: 'synthetic-private-value',
        responses: { answer: 'synthetic-private-value' },
      },
      f.organizationId,
    )
    expect(response.status).toBe(200)
    const records = await operations(f.organizationId)
    expect(JSON.stringify(records).includes('synthetic-private-value')).toBe(false)
    expect(JSON.stringify(records).includes(f.owner.cookie)).toBe(false)
    expect(JSON.stringify(records).includes(f.target.email)).toBe(false)
    expect(records).toEqual([expected(f, f.owner.id, 'admin')])
  })

  it('retains before/after roles and does not emit a second event for a no-op', async () => {
    const f = await fixture()
    for (const role of ['admin', 'admin']) {
      const response = await post(
        'update-member-role',
        f.owner.cookie,
        {
          organizationId: f.organizationId,
          memberId: f.memberId,
          role,
        },
        f.organizationId,
      )
      expect(response.status).toBe(200)
    }
    expect((await membership(f.memberId))?.role).toBe('admin')
    expect(await operations(f.organizationId)).toEqual([expected(f, f.owner.id, 'admin')])
    const response = await post(
      'update-member-role',
      f.owner.cookie,
      {
        organizationId: f.organizationId,
        memberId: f.memberId,
        role: 'member',
      },
      f.organizationId,
    )
    expect(response.status).toBe(200)
    expect(await operations(f.organizationId)).toEqual([
      expected(f, f.owner.id, 'admin'),
      { ...expected(f, f.owner.id, 'member'), previous_role: 'admin' },
    ])
  })

  it('does not record rejected operations or direct adapter maintenance', async () => {
    const f = await fixture()
    const denied = await post(
      'remove-member',
      f.target.cookie,
      {
        organizationId: f.organizationId,
        memberIdOrEmail: f.owner.email,
      },
      f.organizationId,
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
    })
    const other = await fixture()
    const crossTeam = await post(
      'update-member-role',
      f.owner.cookie,
      {
        organizationId: f.organizationId,
        memberId: other.memberId,
        role: 'admin',
      },
      f.organizationId,
    )
    expect(crossTeam.status).toBe(403)
    expect(await crossTeam.json()).toEqual({
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: 'team_management_access_denied',
    })
    expect((await membership(f.memberId))?.role).toBe('member')
    expect((await membership(other.memberId))?.role).toBe('member')
    expect(await operations(f.organizationId)).toEqual([])
    expect(await operations(other.organizationId)).toEqual([])
    const adapter = (await auth.$context).adapter
    await adapter.update({
      model: 'member',
      where: [{ field: 'id', value: f.memberId }],
      update: { role: 'admin' },
    })
    await adapter.transaction((trx) =>
      trx.delete({ model: 'member', where: [{ field: 'id', value: f.memberId }] }),
    )
    expect(await membership(f.memberId)).toBeUndefined()
    expect(await operations(f.organizationId)).toEqual([])
  })

  it.each(['remove-member', 'leave', 'update-member-role'] as const)(
    'checks %s context before persistence and records an admitted request exactly once',
    async (path) => {
      const f = await fixture()
      const caller = path === 'leave' ? f.target : f.owner
      const body = {
        organizationId: f.organizationId,
        ...(path === 'remove-member' ? { memberIdOrEmail: f.memberId } : {}),
        ...(path === 'update-member-role' ? { memberId: f.memberId, role: 'admin' } : {}),
      }
      const before = await membership(f.memberId)
      async function refused(expectedOrganizationId?: string, status = 409) {
        const response = await post(path, caller.cookie, body, expectedOrganizationId)
        expect(response.status).toBe(status)
        expect(await response.json()).toMatchObject({
          code: status === 409 ? 'ORGANIZATION_CONTEXT_CHANGED' : 'TEAM_MANAGEMENT_ACCESS_DENIED',
        })
        expect(await membership(f.memberId)).toEqual(before)
        expect(await operations(f.organizationId)).toEqual([])
      }

      await refused()
      await refused('not-a-uuid', 403)
      const personalId = await ensurePersonalOrganization(db, caller.id)
      expect((await post('set-active', caller.cookie, { organizationId: personalId })).status).toBe(
        200,
      )
      // Keep the draft's original context after a real session switch. Even a header
      // replaced with the current context cannot authorize the old draft's target.
      await refused(f.organizationId, path === 'leave' ? 403 : 409)
      await refused(personalId)
      expect(await operations(personalId)).toEqual([])

      expect(
        (await post('set-active', caller.cookie, { organizationId: f.organizationId })).status,
      ).toBe(200)
      const response = await post(path, caller.cookie, body, f.organizationId)
      expect(response.status).toBe(200)
      if (path === 'update-member-role') {
        expect((await membership(f.memberId))?.role).toBe('admin')
      } else {
        expect(await membership(f.memberId)).toBeUndefined()
      }
      expect(await operations(f.organizationId)).toEqual([
        expected(f, caller.id, path === 'update-member-role' ? 'admin' : undefined),
      ])
    },
  )

  it('denies personal role changes and does not record legacy member maintenance', async () => {
    const f = await fixture()
    const personalId = await ensurePersonalOrganization(db, f.owner.id)
    expect((await post('set-active', f.owner.cookie, { organizationId: personalId })).status).toBe(
      200,
    )
    const legacy = await db
      .insertInto('auth.member')
      .values({
        organizationId: personalId,
        userId: f.target.id,
        role: 'member',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const updated = await post(
      'update-member-role',
      f.owner.cookie,
      {
        organizationId: personalId,
        memberId: legacy.id,
        role: 'admin',
      },
      personalId,
    )
    expect(updated.status).toBe(403)
    expect(await updated.json()).toEqual({
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: 'team_management_access_denied',
    })
    expect((await membership(legacy.id))?.role).toBe('member')
    expect(await operations(personalId)).toEqual([])
    const context = await auth.$context
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.owner.cookie }) })
    await runWithEndpointContext(
      {
        path: '/organization/update-member-role',
        context: { ...context, session } as unknown as AuthEndpointContext['context'],
      },
      () =>
        context.adapter.transaction((trx) =>
          trx.update({
            model: 'member',
            where: [{ field: 'id', value: legacy.id }],
            update: { role: 'admin' },
          }),
        ),
    )
    expect((await membership(legacy.id))?.role).toBe('admin')
    const removed = await post(
      'remove-member',
      f.owner.cookie,
      {
        organizationId: personalId,
        memberIdOrEmail: legacy.id,
      },
      personalId,
    )
    expect(removed.status).toBe(403)
    expect(await removed.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
    expect(await membership(legacy.id)).toBeDefined()
    expect(await operations(personalId)).toEqual([])
  })

  it('does not attribute unrelated endpoint maintenance to its session', async () => {
    const f = await fixture()
    const context = await auth.$context
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.owner.cookie }) })
    expect(session?.user.id).toBe(f.owner.id)
    await runWithEndpointContext(
      {
        path: '/organization/maintenance',
        context: { ...context, session } as unknown as AuthEndpointContext['context'],
      },
      () =>
        context.adapter.transaction((trx) =>
          trx.delete({ model: 'member', where: [{ field: 'id', value: f.memberId }] }),
        ),
    )
    expect(await membership(f.memberId)).toBeUndefined()
    expect(await operations(f.organizationId)).toEqual([])
  })

  it('records the committed previous role after an intervening change to a perceived no-op', async () => {
    const f = await fixture()
    const context = await auth.$context
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.owner.cookie }) })
    expect(session?.user.id).toBe(f.owner.id)
    await runWithEndpointContext(
      {
        path: '/organization/update-member-role',
        context: { ...context, session } as unknown as AuthEndpointContext['context'],
      },
      () =>
        context.adapter.transaction(async (trx) => {
          const findOne = trx.findOne
          let changed = false
          trx.findOne = async <T>(request: Parameters<DBTransactionAdapter['findOne']>[0]) => {
            const snapshot = await findOne<T>(request)
            if (request.model === 'member' && !changed) {
              changed = true
              // Commit on a separate connection after the attribution read, before its
              // update. This makes the otherwise timing-sensitive race deterministic.
              await db
                .updateTable('auth.member')
                .set({ role: 'admin' })
                .where('id', '=', f.memberId)
                .execute()
            }
            return snapshot
          }
          await trx.update({
            model: 'member',
            where: [{ field: 'id', value: f.memberId }],
            update: { role: 'member' },
          })
        }),
    )
    expect((await membership(f.memberId))?.role).toBe('member')
    expect(await operations(f.organizationId)).toEqual([
      { ...expected(f, f.owner.id, 'member'), previous_role: 'admin' },
    ])
  })

  it('records the role from the member actually removed and stamps it after deletion', async () => {
    const f = await fixture()
    const context = await auth.$context
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.owner.cookie }) })
    let deletedAt = 0
    await runWithEndpointContext(
      {
        path: '/organization/remove-member',
        context: { ...context, session } as unknown as AuthEndpointContext['context'],
      },
      () =>
        context.adapter.transaction(async (trx) => {
          const consumeOne = trx.consumeOne
          trx.consumeOne = async <T>(
            request: Parameters<DBTransactionAdapter['consumeOne']>[0],
          ) => {
            if (request.model === 'member')
              await db
                .updateTable('auth.member')
                .set({ role: 'admin' })
                .where('id', '=', f.memberId)
                .execute()
            const removed = await consumeOne<T>(request)
            if (request.model === 'member') {
              await setTimeout(15)
              deletedAt = Date.now()
            }
            return removed
          }
          await trx.delete({ model: 'member', where: [{ field: 'id', value: f.memberId }] })
        }),
    )
    expect(await membership(f.memberId)).toBeUndefined()
    const records = await operations(f.organizationId)
    expect(records).toEqual([{ ...expected(f, f.owner.id), previous_role: 'admin' }])
    expect((records[0]?.occurred_at.getTime() ?? 0) >= deletedAt).toBe(true)
  })

  it.each(['organizationId', 'userId'] as const)(
    'discards removal attribution if the stored %s changed before deletion',
    async (changedField) => {
      const f = await fixture()
      const other = await fixture()
      const context = await auth.$context
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: f.owner.cookie }),
      })
      await runWithEndpointContext(
        {
          path: '/organization/remove-member',
          context: { ...context, session } as unknown as AuthEndpointContext['context'],
        },
        () =>
          context.adapter.transaction(async (trx) => {
            const consumeOne = trx.consumeOne
            trx.consumeOne = async <T>(
              request: Parameters<DBTransactionAdapter['consumeOne']>[0],
            ) => {
              if (request.model === 'member')
                await db
                  .updateTable('auth.member')
                  .set({
                    [changedField]:
                      changedField === 'organizationId' ? other.organizationId : other.owner.id,
                  })
                  .where('id', '=', f.memberId)
                  .execute()
              return consumeOne<T>(request)
            }
            await trx.delete({ model: 'member', where: [{ field: 'id', value: f.memberId }] })
          }),
      )
      const remaining = await membership(f.memberId)
      expect(remaining !== undefined).toBe(true)
      expect(remaining?.[changedField]).toBe(
        changedField === 'organizationId' ? other.organizationId : other.owner.id,
      )
      expect(await operations(f.organizationId)).toEqual([])
      expect(await operations(other.organizationId)).toEqual([])
    },
  )

  it.each(['remove-member', 'leave', 'update-member-role'] as const)(
    'rolls back %s when its operation record cannot be written',
    async (path) => {
      const f = await fixture()
      await owned.pool.query(`
        CREATE FUNCTION public.reject_synthetic_member_operation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'Synthetic operation record failure';
        END $$;
        CREATE TRIGGER reject_synthetic_member_operation BEFORE INSERT
        ON public.organization_operations FOR EACH ROW
        EXECUTE FUNCTION public.reject_synthetic_member_operation();
      `)
      try {
        const body = {
          organizationId: f.organizationId,
          memberIdOrEmail: f.memberId,
          memberId: f.memberId,
          role: 'admin',
        }
        const failed = await post(
          path,
          path === 'leave' ? f.target.cookie : f.owner.cookie,
          body,
          f.organizationId,
        ).then(
          () => false,
          (error: unknown) =>
            error instanceof Error && error.message.includes('Synthetic operation record failure'),
        )
        expect(failed).toBe(true)
        expect((await membership(f.memberId))?.role).toBe('member')
        expect(await operations(f.organizationId)).toEqual([])
      } finally {
        await owned.pool.query(`
          DROP TRIGGER reject_synthetic_member_operation ON public.organization_operations;
          DROP FUNCTION public.reject_synthetic_member_operation();
        `)
      }
    },
  )

  it('keeps concurrent sessions distinct and records only the real role transition', async () => {
    const f = await fixture()
    const secondOwner = await actor()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.organizationId,
        userId: secondOwner.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    expect(
      (await post('set-active', secondOwner.cookie, { organizationId: f.organizationId })).status,
    ).toBe(200)
    const results = await Promise.all(
      [f.owner.cookie, secondOwner.cookie].map((cookie) =>
        post(
          'update-member-role',
          cookie,
          {
            organizationId: f.organizationId,
            memberId: f.memberId,
            role: 'admin',
          },
          f.organizationId,
        ),
      ),
    )
    expect(results.map((response) => response.status)).toEqual([200, 200])
    const records = await operations(f.organizationId)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual(expected(f, records[0]?.actor_user_id as string, 'admin'))
    expect([f.owner.id, secondOwner.id]).toContain(records[0]?.actor_user_id)
  })

  it.each([
    ['remove-member', 'admin', 'admin'],
    ['update-member-role', 'admin', 'member'],
    ['update-member-role', 'member', 'admin'],
  ] as const)(
    'locks the organization before its member for %s requesting %s',
    async (path, requestedRole, changedRole) => {
      const f = await fixture()
      if (path === 'update-member-role') {
        await db
          .updateTable('auth.member')
          .set({ role: requestedRole })
          .where('id', '=', f.memberId)
          .execute()
      }
      const parent = await owned.pool.connect()
      const parentPid = (await parent.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid
      let writerWaiting = false
      let memberLocked = false
      let committed = false
      let pending: Promise<{ response: Response } | { failed: true }> | undefined
      try {
        await parent.query('BEGIN')
        await parent.query("SET LOCAL lock_timeout = '250ms'")
        await parent.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
          f.organizationId,
        ])
        pending = post(
          path,
          f.owner.cookie,
          {
            organizationId: f.organizationId,
            memberIdOrEmail: f.memberId,
            memberId: f.memberId,
            role: requestedRole,
          },
          f.organizationId,
        ).then(
          (response) => ({ response }),
          () => ({ failed: true as const }),
        )
        const deadline = Date.now() + 3_000
        while (Date.now() < deadline) {
          const blocked = await owned.pool.query<{ blocked: boolean }>(
            `
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND $1 = ANY(pg_blocking_pids(pid))
            ) AS blocked
          `,
            [parentPid],
          )
          if (blocked.rows[0]?.blocked) {
            writerWaiting = true
            break
          }
          await setTimeout(10)
        }
        // A team-management writer already owns the parent lock and next locks the
        // member. The operation waiting for that parent must not hold the member yet.
        memberLocked = await parent
          .query('SELECT id FROM auth.member WHERE id = $1 FOR UPDATE', [f.memberId])
          .then(
            () => true,
            () => false,
          )
        if (memberLocked) {
          await parent.query('UPDATE auth.member SET role = $2 WHERE id = $1', [
            f.memberId,
            changedRole,
          ])
          await parent.query('COMMIT')
          committed = true
        }
      } finally {
        if (!committed) await parent.query('ROLLBACK')
        parent.release()
      }
      const outcome = await pending
      expect(writerWaiting).toBe(true)
      expect(memberLocked).toBe(true)
      expect(
        outcome !== undefined && 'response' in outcome && outcome.response.status === 200,
      ).toBe(true)
      expect(await operations(f.organizationId)).toEqual([
        {
          ...expected(f, f.owner.id, path === 'remove-member' ? undefined : requestedRole),
          previous_role: changedRole,
        },
      ])
    },
  )
})
