import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { betterAuth } from 'better-auth'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { organization } from 'better-auth/plugins/organization'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../apps/server/src/app.ts'
import { createCallerResolver } from './caller.ts'
import { beforeHook } from './hooks.ts'
import * as authExports from './index.ts'
import { type Auth, createAuth, createAuthPool } from './index.ts'
import { organizationOperationRecords, recordTeamRoleChange } from './organization-operations.ts'
import { isUuid, organizationGuards } from './organizations.ts'
import {
  checkTeamManagementAccess,
  TeamManagementError,
  teamManagementDenied,
  teamRoles,
  teamSession,
  teamSessionUser,
} from './team-management.ts'
import * as removalExports from './team-member-removal.ts'
import { removeTeamMember, teamMemberRemovalTarget } from './team-member-removal.ts'
import type { createTeamRolePolicy } from './team-role-policy.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4393'
const secret = 'synthetic-atomic-member-removal-secret-000000000000'
type Remove = typeof removeTeamMember
type Replacement = readonly [string, string]

/** Break an isolated source copy and keep the checked-in protection unchanged. */
function sourceCopy(replacement?: Replacement): Remove {
  let source = readFileSync('packages/auth/src/team-member-removal.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { checkTeamManagementAccess, isUuid, teamManagementDenied, teamRoles }
  return new Function(...Object.keys(bindings), `${source}; return removeTeamMember`)(
    ...Object.values(bindings),
  ) as Remove
}

function policySourceCopy(
  replacement?: Replacement,
  remove: Remove = removeTeamMember,
): typeof createTeamRolePolicy {
  let source = readFileSync('packages/auth/src/team-role-policy.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    AsyncLocalStorage,
    tryGetCurrentAuthEndpointContext,
    APIError,
    getSessionFromCtx,
    recordTeamRoleChange,
    isUuid,
    checkTeamManagementAccess,
    TeamManagementError,
    teamRoles,
    teamSession,
    teamSessionUser,
    removeTeamMember: remove,
    teamMemberRemovalTarget,
  }
  return new Function(...Object.keys(bindings), `${source}; return createTeamRolePolicy`)(
    ...Object.values(bindings),
  ) as typeof createTeamRolePolicy
}

async function sourceExportCopy(reexportTransactionHelper = false) {
  const location = new URL('./team-member-removal.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (reexportTransactionHelper) source += '\nexport { removeTeamMemberInTransaction }\n'
  source = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

function verifyExportBoundary(module: Record<string, unknown>) {
  expect(module).not.toHaveProperty('removeTeamMemberInTransaction')
  expect(module).toHaveProperty('removeTeamMember', expect.any(Function))
}

describe('member removal exports', () => {
  it('exposes only the checked removal entry at the package and module boundaries', async () => {
    verifyExportBoundary(authExports)
    verifyExportBoundary(removalExports)
    verifyExportBoundary(await sourceExportCopy())
  })

  it('detects a transaction helper export from a source copy with a real assertion', async () => {
    const copy = await sourceExportCopy(true)
    expect(() => verifyExportBoundary(copy)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

describe.skipIf(!serverUrl)('atomic member removal protections through HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let resolveCaller: ReturnType<typeof createCallerResolver>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'removal_guards' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    resolveCaller = createCallerResolver({ auth, db })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture(actorRole = 'owner', targetRole = 'member') {
    const actor = await createTestUser(db, 'Removal actor')
    const target = await createTestUser(db, 'Removal target')
    const survivor = await createTestUser(db, 'Remaining host')
    const team = await createTestTeam(db, [
      { user: actor, role: actorRole },
      { user: target, role: targetRole },
      { user: survivor, role: 'owner' },
    ])
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', target.id)
      .executeTakeFirstOrThrow()
    const token = randomBytes(24).toString('base64url')
    const login = await db
      .insertInto('auth.session')
      .values({
        userId: actor.id,
        token,
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    const eventId = await createFixtures(db).eventType(team.id, null, {
      hosts: [{ userId: target.id }],
    })
    return {
      actor,
      target,
      survivor,
      team,
      memberId: member.id,
      eventId,
      cookie,
      sessionId: login.id,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function app(remove: Remove = removeTeamMember) {
    return createApp({
      authHandler: auth.handler,
      resolveCaller,
      publicUrl: origin,
      checkDb: async () => {},
      routes: [
        ({ app, caller }) => {
          app.post('/api/v1/removal-protection', caller, async (c) => {
            const input = (await c.req.json()) as { teamId: string; memberUserId: string }
            try {
              return c.json(
                await remove(db, c.var.principal, {
                  ...input,
                  expectedOrganizationId: c.req.header('X-Expected-Organization-Id') ?? '',
                }),
              )
            } catch (error) {
              if (!(error instanceof TeamManagementError)) throw error
              throw new DomainError(
                error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
                error.code,
              )
            }
          })
        },
      ],
    })
  }

  function request(f: Fixture, remove?: Remove, teamId = f.team.id, memberUserId = f.target.id) {
    return app(remove).request('/api/v1/removal-protection', {
      method: 'POST',
      headers: {
        cookie: f.cookie,
        origin,
        'content-type': 'application/json',
        'X-Expected-Organization-Id': f.team.id,
      },
      body: JSON.stringify({ teamId, memberUserId }),
    })
  }

  function native(f: Fixture, handler: (request: Request) => Promise<Response> = auth.handler) {
    return handler(
      new Request(`${origin}/api/auth/organization/remove-member`, {
        method: 'POST',
        headers: {
          cookie: f.cookie,
          origin,
          'content-type': 'application/json',
          'X-Expected-Organization-Id': f.team.id,
        },
        body: JSON.stringify({ organizationId: f.team.id, memberIdOrEmail: f.memberId }),
      }),
    )
  }

  function copiedNativePolicy(replacement?: Replacement, remove: Remove = removeTeamMember) {
    const policy = policySourceCopy(replacement, remove)(db)
    // Use the real pinned native endpoint, auth adapter transaction and recorder. Only
    // the policy is a source copy; the removed protection must fail a behavior assertion.
    const copiedAuth = betterAuth({
      database: authPool,
      baseURL: origin,
      secret,
      advanced: { database: { generateId: 'uuid' }, disableOriginCheck: false },
      onAPIError: { throw: true },
      logger: { log: () => {} },
      hooks: { before: beforeHook(db, policy.before) },
      plugins: [
        organizationOperationRecords(),
        {
          id: 'copied-removal-policy',
          init(ctx) {
            const adapter = ctx.adapter
            policy.adapter(adapter)
            const transaction = adapter.transaction
            adapter.transaction = (callback) => transaction((trx) => callback(policy.adapter(trx)))
          },
        },
        organization({ organizationHooks: organizationGuards(db) }),
      ],
    })
    return policy.handler(copiedAuth.handler)
  }

  function member(f: Fixture) {
    return db.selectFrom('auth.member').select('id').where('id', '=', f.memberId).executeTakeFirst()
  }

  async function active(id: string) {
    return (
      await db
        .selectFrom('event_types')
        .select('is_active')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).is_active
  }

  async function verifyCallerTransaction(remove: Remove = removeTeamMember) {
    const f = await fixture()
    const principal = {
      kind: 'session' as const,
      user: f.actor.principal.user,
      organization: f.team.as(f.actor).organization,
      sessionId: f.sessionId,
    }
    await expect(
      db.transaction().execute(async (trx) => {
        const result = await remove(trx, principal, {
          teamId: f.team.id,
          memberUserId: f.target.id,
          expectedOrganizationId: f.team.id,
        })
        expect(result.deactivatedEventTypeIds).toEqual([f.eventId])
        expect(
          await trx
            .selectFrom('auth.member')
            .select('id')
            .where('id', '=', f.memberId)
            .executeTakeFirst(),
        ).toBeUndefined()
        throw new Error('Synthetic caller rollback')
      }),
    ).rejects.toThrow('Synthetic caller rollback')
    expect(await member(f)).toBeDefined()
    expect(await active(f.eventId)).toBe(true)
    expect(
      await db
        .selectFrom('organization_operations')
        .select('id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([])
  }

  it('reuses a caller transaction so its rollback preserves membership and event activation', () =>
    verifyCallerTransaction())

  it('detects a nested removal transaction in a source copy with a real assertion', async () => {
    await expect(
      verifyCallerTransaction(sourceCopy(['return db.isTransaction', 'return false'])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each(['owner', 'member, admin'])(
    'protects the trusted Better Auth removeMember API for %s with atomic removal',
    async (actorRole) => {
      const f = await fixture(actorRole)
      await auth.api.removeMember({
        headers: new Headers({ cookie: f.cookie, 'X-Expected-Organization-Id': f.team.id }),
        body: { organizationId: f.team.id, memberIdOrEmail: f.memberId },
      })
      expect(await member(f)).toBeUndefined()
      expect(await active(f.eventId)).toBe(false)
      const operations = await db
        .selectFrom('organization_operations')
        .select(['operation', 'actor_user_id', 'target_user_id'])
        .where('organization_id', '=', f.team.id)
        .execute()
      expect(operations).toEqual([
        { operation: 'member_removed', actor_user_id: f.actor.id, target_user_id: f.target.id },
      ])
    },
  )

  it('refuses trusted native removal without an expected organization', async () => {
    const f = await fixture()
    await expect(
      auth.api.removeMember({
        headers: new Headers({ cookie: f.cookie }),
        body: { organizationId: f.team.id, memberIdOrEmail: f.memberId },
      }),
    ).rejects.toMatchObject({ body: { code: 'ORGANIZATION_CONTEXT_CHANGED' } })
    expect(await member(f)).toBeDefined()
    expect(await active(f.eventId)).toBe(true)
  })

  it('rolls back native revocation and deactivation when its removal record fails', async () => {
    const f = await fixture()
    await owned.pool.query(`
      CREATE FUNCTION public.reject_removal_protection_record() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation = 'member_removed' THEN
          RAISE EXCEPTION 'Synthetic native removal record failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_removal_protection_record BEFORE INSERT
      ON public.organization_operations FOR EACH ROW
      EXECUTE FUNCTION public.reject_removal_protection_record();
    `)
    try {
      await expect(native(f)).rejects.toThrow('Synthetic native removal record failure')
      expect(await member(f)).toBeDefined()
      expect(await active(f.eventId)).toBe(true)
      expect(
        await db
          .selectFrom('organization_operations')
          .select('id')
          .where('organization_id', '=', f.team.id)
          .execute(),
      ).toEqual([])
    } finally {
      await owned.pool.query(`
        DROP TRIGGER reject_removal_protection_record ON public.organization_operations;
        DROP FUNCTION public.reject_removal_protection_record();
      `)
    }
  })

  async function verifyNativeBoundary(replacement?: Replacement) {
    const f = await fixture()
    expect((await native(f, copiedNativePolicy(replacement))).status).toBe(200)
    expect(await active(f.eventId)).toBe(false)
    expect(await member(f)).toBeUndefined()
    expect(
      await db
        .selectFrom('organization_operations')
        .select('id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toHaveLength(1)
  }

  it('passes native boundary assertions with an unmodified policy source copy', () =>
    verifyNativeBoundary())

  it('detects a bypassed native persistence interceptor with a real assertion', async () => {
    await expect(
      verifyNativeBoundary([
        "if (ctx?.path !== remove || request.model !== 'member') return deleteOne(request)",
        "if (true || request.model !== 'member') return deleteOne(request)",
      ]),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function verifyNativeRecheck(
    change: 'role' | 'context',
    handler: (request: Request) => Promise<Response> = auth.handler,
  ) {
    const f = await fixture()
    const holder = await owned.pool.connect()
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [f.team.id])
      pending = native(f, handler)
      await vi.waitFor(
        async () => {
          const blocked = await owned.pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock'
              AND $1 = ANY(pg_blocking_pids(pid))) AS blocked`,
            [holderPid],
          )
          expect(blocked.rows[0]?.blocked).toBe(true)
        },
        { interval: 10, timeout: 2_000 },
      )
      if (change === 'role') {
        await holder.query(
          'UPDATE auth.member SET role = $1 WHERE "organizationId" = $2 AND "userId" = $3',
          ['member', f.team.id, f.actor.id],
        )
      } else {
        await holder.query(
          'UPDATE auth.session SET "activeOrganizationId" = $1 WHERE "userId" = $2',
          [f.actor.principal.organization.id, f.actor.id],
        )
      }
      await holder.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(change === 'role' ? 403 : 409)
      expect(await member(f)).toBeDefined()
      expect(await active(f.eventId)).toBe(true)
      expect(
        await db
          .selectFrom('organization_operations')
          .select('id')
          .where('organization_id', '=', f.team.id)
          .execute(),
      ).toEqual([])
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending ? [pending] : [])
    }
  }

  it.each(['role', 'context'] as const)(
    'rechecks native removal after a concurrent actor %s change while waiting',
    (change) => verifyNativeRecheck(change),
  )

  it.each(['role', 'context'] as const)(
    'detects missing locked native %s rechecks with a real assertion',
    async (change) => {
      await expect(
        verifyNativeRecheck(
          change,
          copiedNativePolicy(
            [
              'const { actor, member, principal, expectedOrganizationId } = await removal(ctx, trx, true)',
              'const { actor, member, principal, expectedOrganizationId } = await removal(ctx, trx, false)',
            ],
            sourceCopy([
              'checkTeamManagementAccess(trx, principal, input.teamId, true, {',
              'checkTeamManagementAccess(trx, principal, input.teamId, false, {',
            ]),
          ),
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  async function verifyTarget(remove: Remove, actorRole: string, targetRole: string) {
    const f = await fixture(actorRole, targetRole)
    expect((await request(f, remove)).status).toBe(403)
    expect(await member(f)).toBeDefined()
  }

  async function verifyTeamBinding(remove: Remove) {
    const f = await fixture()
    const other = await fixture()
    // Isolate team binding from the independent prohibition on owner targets.
    await db
      .deleteFrom('auth.member')
      .where('userId', '=', other.target.id)
      .where('organizationId', '!=', other.team.id)
      .execute()
    const response = await request(f, remove, f.team.id, other.target.id)
    expect(response.status).toBe(403)
    expect(await member(other)).toBeDefined()
    expect(await member(f)).toBeDefined()
  }

  async function verifyDeactivation(remove: Remove) {
    const f = await fixture()
    const fx = createFixtures(db)
    const collective = await fx.eventType(f.team.id, null, {
      hosts: [{ userId: f.target.id }, { userId: f.survivor.id }],
    })
    const pool = await fx.eventType(f.team.id, null, {
      hosts: [{ userId: f.target.id }],
    })
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'collective' })
      .where('id', '=', collective)
      .execute()
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'round_robin' })
      .where('id', '=', pool)
      .execute()
    expect((await request(f, remove)).status).toBe(200)
    for (const id of [f.eventId, collective, pool]) expect(await active(id)).toBe(false)
    expect(await member(f)).toBeUndefined()
  }

  async function verifyRemainingHost(
    remove: Remove,
    stale: 'absent' | 'unverified' | 'other_team',
  ) {
    const f = await fixture()
    const other = await createTestUser(db, 'Stale configured host')
    if (stale === 'unverified') {
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', other.id)
        .execute()
      await db
        .insertInto('auth.member')
        .values({
          organizationId: f.team.id,
          userId: other.id,
          role: 'member',
          createdAt: new Date(),
        })
        .execute()
    }
    if (stale === 'other_team') await createTestTeam(db, [{ user: other, role: 'member' }])
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'round_robin' })
      .where('id', '=', f.eventId)
      .execute()
    await db
      .insertInto('event_type_hosts')
      .values({ event_type_id: f.eventId, user_id: other.id })
      .execute()
    const response = await request(f, remove)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ deactivatedEventTypeIds: [f.eventId] })
    expect(await active(f.eventId)).toBe(false)
  }

  async function verifyScope(remove: Remove, scope: 'team' | 'personal' | 'unrelated' | 'deleted') {
    const f = await fixture()
    const fx = createFixtures(db)
    const team =
      scope === 'team' ? await createTestTeam(db, [{ user: f.target, role: 'member' }]) : f.team
    const eventId = await fx.eventType(team.id, scope === 'personal' ? f.target.id : null, {
      hosts: [{ userId: scope === 'unrelated' ? f.survivor.id : f.target.id }],
    })
    if (scope === 'deleted') {
      await db
        .updateTable('event_types')
        .set({ deleted_at: new Date() })
        .where('id', '=', eventId)
        .execute()
    }
    const response = await request(f, remove)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ deactivatedEventTypeIds: [f.eventId] })
    expect(await active(f.eventId)).toBe(false)
    expect(await active(eventId)).toBe(true)
  }

  async function verifyRecord(remove: Remove) {
    const f = await fixture()
    expect((await request(f, remove)).status).toBe(200)
    const records = await db
      .selectFrom('organization_operations')
      .select(['operation', 'actor_user_id', 'target_user_id', 'organization_id'])
      .where('organization_id', '=', f.team.id)
      .execute()
    expect(records).toEqual([
      {
        operation: 'member_removed',
        actor_user_id: f.actor.id,
        target_user_id: f.target.id,
        organization_id: f.team.id,
      },
    ])
  }

  async function verifyAtomicity(remove: Remove) {
    const f = await fixture()
    await owned.pool.query(`
      CREATE FUNCTION public.reject_copied_removal_record() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Synthetic copied removal failure';
      END $$;
      CREATE TRIGGER reject_copied_removal_record BEFORE INSERT
      ON public.organization_operations FOR EACH ROW
      EXECUTE FUNCTION public.reject_copied_removal_record();
    `)
    try {
      expect((await request(f, remove)).status).toBe(500)
      expect(await member(f)).toBeDefined()
      expect(await active(f.eventId)).toBe(true)
    } finally {
      await owned.pool.query(`
        DROP TRIGGER reject_copied_removal_record ON public.organization_operations;
        DROP FUNCTION public.reject_copied_removal_record();
      `)
    }
  }

  it('passes the removal assertions against an unmodified source copy', async () => {
    const remove = sourceCopy()
    await verifyTarget(remove, 'owner', 'owner,member')
    await verifyTarget(remove, 'admin', 'admin')
    await verifyTeamBinding(remove)
    await verifyDeactivation(remove)
    await verifyRemainingHost(remove, 'absent')
    await verifyRemainingHost(remove, 'unverified')
    await verifyRemainingHost(remove, 'other_team')
    for (const scope of ['team', 'personal', 'unrelated', 'deleted'] as const)
      await verifyScope(remove, scope)
    await verifyRecord(remove)
    await verifyAtomicity(remove)
  })

  const mutations: {
    name: string
    replacement: Replacement
    verify: (remove: Remove) => Promise<void>
  }[] = [
    {
      name: 'owner target refusal',
      replacement: ["roles.includes('owner') ||", 'false ||'],
      verify: (remove) => verifyTarget(remove, 'owner', 'owner,member'),
    },
    {
      name: 'admin target refusal',
      replacement: ["(actor.role !== 'owner' && roles.includes('admin'))", 'false'],
      verify: (remove) => verifyTarget(remove, 'admin', 'admin'),
    },
    {
      name: 'unknown role target refusal',
      replacement: ["(!roles.includes('admin') && !roles.includes('member')) ||", 'false ||'],
      verify: (remove) => verifyTarget(remove, 'owner', 'custom'),
    },
    {
      name: 'target team binding',
      replacement: [".where('organizationId', '=', actor.organizationId)", ''],
      verify: verifyTeamBinding,
    },
    {
      name: 'individual and collective deactivation',
      replacement: [
        '.set({ is_active: false, updated_at: new Date() })',
        '.set({ is_active: true, updated_at: new Date() })',
      ],
      verify: verifyDeactivation,
    },
    {
      name: 'last round-robin host deactivation',
      replacement: [
        "if (event.scheduling_type === 'round_robin') {",
        "if (event.scheduling_type === 'round_robin') { continue;",
      ],
      verify: verifyDeactivation,
    },
    {
      name: 'removed host excluded from remaining pool',
      replacement: [".where('host.user_id', '!=', member.userId)", ''],
      verify: verifyDeactivation,
    },
    {
      name: 'remaining pool current membership',
      replacement: [
        ".innerJoin('auth.member as member', 'member.userId', 'host.user_id')",
        ".innerJoin('auth.member as member', (join) => join.onTrue())",
      ],
      verify: (remove) => verifyRemainingHost(remove, 'absent'),
    },
    {
      name: 'remaining pool team membership',
      replacement: [".where('member.organizationId', '=', actor.organizationId)", ''],
      verify: (remove) => verifyRemainingHost(remove, 'other_team'),
    },
    {
      name: 'remaining pool email proof',
      replacement: [".where('user.emailVerified', '=', true)", ''],
      verify: (remove) => verifyRemainingHost(remove, 'unverified'),
    },
    {
      name: 'other team event isolation',
      replacement: [".where('event.organization_id', '=', actor.organizationId)", ''],
      verify: (remove) => verifyScope(remove, 'team'),
    },
    {
      name: 'personal event isolation',
      replacement: [".where('event.owner_user_id', 'is', null)", ''],
      verify: (remove) => verifyScope(remove, 'personal'),
    },
    {
      name: 'deleted event isolation',
      replacement: [".where('event.deleted_at', 'is', null)", ''],
      verify: (remove) => verifyScope(remove, 'deleted'),
    },
    {
      name: 'unrelated team host isolation',
      replacement: [".where('host.user_id', '=', member.userId)", ''],
      verify: (remove) => verifyScope(remove, 'unrelated'),
    },
    {
      name: 'membership revocation',
      replacement: [
        ".deleteFrom('auth.member')",
        ".deleteFrom('auth.member').where('id', '=', '00000000-0000-0000-0000-000000000000')",
      ],
      verify: verifyDeactivation,
    },
    {
      name: 'removal operation actor',
      replacement: ['actor_user_id: actor.userId,', 'actor_user_id: member.userId,'],
      verify: verifyRecord,
    },
    {
      name: 'atomic removal transaction',
      replacement: [
        'const write = async (trx: Transaction<Database>) => {',
        'const write = async (_transaction: Transaction<Database>) => { const trx = db;',
      ],
      verify: verifyAtomicity,
    },
  ]

  it.each(mutations)(
    'detects broken $name with a real HTTP assertion',
    async ({ replacement, verify }) => {
      await expect(verify(sourceCopy(replacement))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})

import { AsyncLocalStorage } from 'node:async_hooks'
