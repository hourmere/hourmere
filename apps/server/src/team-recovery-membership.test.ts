import { randomBytes } from 'node:crypto'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  ensurePersonalOrganization,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  claimedDomainValues,
  oidcProviderValues,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { nativeTeamLeave } from './native-team-leave.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:43873'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const capabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const operations = [
  'REST leave',
  'native leave',
  'REST removal',
  'native removal',
  'demotion',
] as const
type Operation = (typeof operations)[number]

describe.skipIf(!databaseUrl)('team membership and SSO recovery ownership', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: ReturnType<typeof createApp>
  let enforcedApp: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'sso_members' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool,
      baseURL: publicUrl,
      secret,
      signup,
      ssoCapabilities: capabilities,
      leaveTeamMember: nativeTeamLeave(db),
      mailer: { send: async () => {} },
    })
    // Complete Better Auth's one-time PostgreSQL schema check before counting route queries.
    await auth.api.getSession({ headers: new Headers() })
    const appDeps = {
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [memberLeaveRoutes({ db }), memberRemovalRoutes({ db })],
    }
    app = createApp(appDeps)
    enforcedApp = createApp({ ...appDeps, ssoTeamReads: { db, capabilities } })
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  async function fixture(
    targetRole: 'owner' | 'admin' = 'owner',
    actorRole: 'owner' | 'admin' = 'owner',
  ) {
    const actor = await createTestUser(db, 'Acting owner')
    const target = await createTestUser(db, 'Departing member')
    const other = await createTestUser(db, 'Another owner')
    const team = await createTestTeam(db, [
      { user: actor, role: actorRole },
      { user: target, role: targetRole },
      { user: other, role: 'owner' },
    ])
    async function participant(userId: string) {
      const member = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', team.id)
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow()
      const personal = await ensurePersonalOrganization(db, userId)
      const session = await db.transaction().execute((trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          {
            userId,
            organizationId: team.id,
            now: Temporal.Now.instant().toString(),
            headers: new Headers(),
          },
        ),
      )
      return {
        userId,
        memberId: member.id,
        sessionId: session.id,
        cookie: session.cookie.split(';')[0] as string,
        personal,
      }
    }
    return {
      teamId: team.id,
      actor: await participant(actor.id),
      target: await participant(target.id),
      other: await participant(other.id),
    }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  function request(f: Fixture, operation: Operation, server = app) {
    const self = operation.endsWith('leave')
    const headers = {
      cookie: (self ? f.target : f.actor).cookie,
      origin: publicUrl,
      'content-type': 'application/json',
      'x-expected-organization-id': f.teamId,
    }
    const post = (path: string, body: Record<string, string>) =>
      server.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    const organizationId = f.teamId
    switch (operation) {
      case 'REST leave':
        return post(`/api/v1/teams/${f.teamId}/leave`, {})
      case 'native leave':
        return post('/api/auth/organization/leave', { organizationId })
      case 'REST removal':
        return post(`/api/v1/team/members/${f.target.userId}/removal`, { teamId: f.teamId })
      case 'native removal':
        return post('/api/auth/organization/remove-member', {
          organizationId,
          memberIdOrEmail: f.target.memberId,
        })
      case 'demotion':
        return post('/api/auth/organization/update-member-role', {
          organizationId,
          memberId: f.target.memberId,
          role: 'member',
        })
    }
  }

  // Measured against the predecessor with the same HTTP composition and PostgreSQL driver.
  const queryCounts: Record<Operation, number> = {
    'REST leave': 25,
    'native leave': 43,
    'REST removal': 35,
    'native removal': 57,
    demotion: 43,
  }

  it.each(operations)(
    'keeps the PostgreSQL query count for %s on a team without SSO',
    async (operation) => {
      const f = await fixture(operation.endsWith('leave') ? 'owner' : 'admin')
      const queries = vi.spyOn(pg.Client.prototype, 'query')
      try {
        expect((await request(f, operation)).status).toBe(200)
        expect(queries).toHaveBeenCalledTimes(queryCounts[operation])
      } finally {
        queries.mockRestore()
      }
    },
  )

  it.each(['native removal', 'demotion'] as const)(
    'keeps the PostgreSQL query count for %s with a stored unenforced policy',
    async (operation) => {
      const f = await fixture('admin')
      await db
        .insertInto('sso_policies')
        .values({ organization_id: f.teamId, require_sso: false })
        .execute()
      const queries = vi.spyOn(pg.Client.prototype, 'query')
      try {
        expect((await request(f, operation)).status).toBe(200)
        expect(queries).toHaveBeenCalledTimes(queryCounts[operation])
      } finally {
        queries.mockRestore()
      }
    },
  )

  async function recover(f: Fixture, owner = f.target) {
    await db
      .insertInto('sso_recovery_owners')
      .values({
        organization_id: f.teamId,
        member_id: owner.memberId,
        user_id: owner.userId,
        nominated_by_user_id: f.actor.userId,
      })
      .execute()
  }

  // Records are only inserted for owners; model one left behind on a non-owner role.
  async function formerOwner(f: Fixture) {
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', f.target.memberId)
      .execute()
  }

  function recoveryOwners(f: Fixture) {
    return db
      .selectFrom('sso_recovery_owners')
      .select('user_id')
      .where('organization_id', '=', f.teamId)
      .orderBy('user_id')
      .execute()
  }

  function removalAudits(f: Fixture) {
    return db
      .selectFrom('audit_events')
      .select(['actor_id', 'target_id', 'target_type', 'details'])
      .where('organization_id', '=', f.teamId)
      .where('action', '=', 'sso_recovery.removed')
      .execute()
  }

  function policy(f: Fixture) {
    return db
      .selectFrom('sso_policies')
      .select(['policy_revision', 'trust_generation'])
      .where('organization_id', '=', f.teamId)
      .executeTakeFirst()
  }

  function memberRole(f: Fixture) {
    return db
      .selectFrom('auth.member')
      .select('role')
      .where('id', '=', f.target.memberId)
      .executeTakeFirst()
  }

  async function enforce(f: Fixture, ...actors: Fixture['actor'][]) {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('sso_policies')
        .values({
          organization_id: f.teamId,
          require_sso: true,
          policy_revision: 4,
          trust_generation: 3,
        })
        .execute()
      const provider = await trx
        .insertInto('sso_providers')
        .values({
          ...oidcProviderValues(f.teamId),
          enabled: true,
        })
        .returning(['id', 'issuer'])
        .executeTakeFirstOrThrow()
      const domain = await trx
        .insertInto('sso_domains')
        .values(claimedDomainValues(f.teamId))
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('sso_provider_domains')
        .values({
          organization_id: f.teamId,
          provider_id: provider.id,
          domain_id: domain.id,
        })
        .execute()
      for (const actor of actors) {
        const link = await trx
          .insertInto('sso_identity_links')
          .values({
            organization_id: f.teamId,
            provider_id: provider.id,
            user_id: actor.userId,
            issuer: provider.issuer,
            subject: actor.userId,
            proven_email: `${actor.userId}@example.test`,
            email_proven_at: new Date(Date.now() - 60000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('sso_browser_proofs')
          .values({
            organization_id: f.teamId,
            provider_id: provider.id,
            domain_id: domain.id,
            member_id: actor.memberId,
            session_id: actor.sessionId,
            user_id: actor.userId,
            link_id: link.id,
            domain_generation: 1,
            link_generation: 1,
            trust_generation: 3,
            expires_at: new Date(Date.now() + 60000),
          })
          .execute()
      }
    })
  }

  const departures = ['REST leave', 'native leave'] as const
  const ownerTargetActions = ['REST removal', 'native removal', 'demotion'] as const

  it.each(departures)(
    'protects the last recovery owner of an enforced team during %s',
    async (operation) => {
      const f = await fixture()
      await recover(f)
      await enforce(f, f.target)
      const response = await request(f, operation, enforcedApp)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        [operation.startsWith('REST') ? 'error' : 'code']: 'sso_recovery_required',
      })
      expect(await memberRole(f)).toEqual({ role: 'owner' })
      expect(await recoveryOwners(f)).toEqual([{ user_id: f.target.userId }])
      expect(await removalAudits(f)).toEqual([])
      expect(await policy(f)).toEqual({ policy_revision: 4, trust_generation: 3 })
    },
  )

  // Recovery status never loosens owner protection: another owner stays untouchable.
  it.each(
    ownerTargetActions.flatMap((operation) =>
      [false, true].flatMap((enforced) =>
        [false, true].map((recovery) => [operation, enforced, recovery] as const),
      ),
    ),
  )(
    'refuses %s of another owner (enforced: %s, recovery owner: %s)',
    async (operation, enforced, recovery) => {
      const f = await fixture()
      if (recovery) {
        await recover(f)
        await recover(f, f.other)
      }
      if (enforced) await enforce(f, f.actor)
      const before = await policy(f)
      const response = await request(f, operation, enforced ? enforcedApp : app)
      expect(response.status).toBe(403)
      expect(await memberRole(f)).toEqual({ role: 'owner' })
      const owners = await recoveryOwners(f)
      expect(owners).toHaveLength(recovery ? 2 : 0)
      if (recovery) expect(owners).toContainEqual({ user_id: f.target.userId })
      expect(await removalAudits(f)).toEqual([])
      expect(await policy(f)).toEqual(before)
    },
  )

  it.each(['REST leave', 'native leave'] as const)(
    'reports the recovery requirement for a sole team owner during %s',
    async (operation) => {
      const f = await fixture('owner', 'admin')
      await db
        .updateTable('auth.member')
        .set({ role: 'admin' })
        .where('id', '=', f.other.memberId)
        .execute()
      await recover(f)
      await enforce(f, f.target)
      const response = await request(f, operation, enforcedApp)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        [operation.startsWith('REST') ? 'error' : 'code']: 'sso_recovery_required',
      })
      expect(await memberRole(f)).toEqual({ role: 'owner' })
      expect(await recoveryOwners(f)).toEqual([{ user_id: f.target.userId }])
    },
  )

  it.each(operations)(
    'deletes non-last recovery status during %s without reviving it later',
    async (operation) => {
      // Owners may only leave; a record left on a former owner follows the allowed admin paths.
      const f = await fixture()
      const actor = operation.endsWith('leave') ? f.target : f.actor
      await recover(f)
      await recover(f, f.other)
      if (!operation.endsWith('leave')) await formerOwner(f)
      await enforce(f, actor)
      expect((await request(f, operation, enforcedApp)).status).toBe(200)
      expect(await memberRole(f)).toEqual(operation === 'demotion' ? { role: 'member' } : undefined)
      expect(await recoveryOwners(f)).toEqual([{ user_id: f.other.userId }])
      expect(await removalAudits(f)).toEqual([
        {
          actor_id: actor.userId,
          target_type: 'member',
          target_id: f.target.memberId,
          details: {},
        },
      ])
      expect(await policy(f)).toEqual({ policy_revision: 5, trust_generation: 3 })
      if (operation === 'demotion') {
        await db
          .updateTable('auth.member')
          .set({ role: 'owner' })
          .where('id', '=', f.target.memberId)
          .execute()
      } else {
        await db
          .insertInto('auth.member')
          .values({
            organizationId: f.teamId,
            userId: f.target.userId,
            role: 'owner',
            createdAt: new Date(),
          })
          .execute()
      }
      expect(await recoveryOwners(f)).toEqual([{ user_id: f.other.userId }])
    },
  )

  // Main allows no owner demotion, so departure is the only allowed transition that
  // can drop the sole recovery owner of an unenforced team.
  it.each(departures)(
    'lets the only recovery owner leave an unenforced team during %s',
    async (operation) => {
      const f = await fixture()
      await recover(f)
      expect((await request(f, operation)).status).toBe(200)
      expect(await memberRole(f)).toBeUndefined()
      expect(await recoveryOwners(f)).toEqual([])
      expect(await removalAudits(f)).toHaveLength(1)
    },
  )

  it('refuses self-demotion of the only recovery owner on an unenforced team', async () => {
    const f = await fixture()
    await recover(f)
    expect((await request({ ...f, actor: f.target }, 'demotion')).status).toBe(403)
    expect(await memberRole(f)).toEqual({ role: 'owner' })
    expect(await recoveryOwners(f)).toEqual([{ user_id: f.target.userId }])
  })

  it('rolls back recovery deletion and its audit when demotion cannot commit', async () => {
    const f = await fixture()
    await recover(f)
    await formerOwner(f)
    await sql`CREATE FUNCTION refuse_role_change_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture role change audit failure'; END $$`.execute(db)
    await sql`CREATE TRIGGER refuse_role_change_audit BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'membership.role_changed')
      EXECUTE FUNCTION refuse_role_change_audit()`.execute(db)
    try {
      expect((await request(f, 'demotion')).status).toBe(500)
      expect(await memberRole(f)).toEqual({ role: 'admin' })
      expect(await recoveryOwners(f)).toEqual([{ user_id: f.target.userId }])
      expect(await removalAudits(f)).toEqual([])
      expect(await policy(f)).toBeUndefined()
    } finally {
      await sql`DROP TRIGGER refuse_role_change_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION refuse_role_change_audit()`.execute(db)
    }
  })

  it('serializes two recovery owner departures and retains one recovery owner', async () => {
    const f = await fixture()
    await recover(f)
    await recover(f, f.other)
    await enforce(f, f.target, f.other)
    const responses = await Promise.all([
      request(f, 'REST leave', enforcedApp),
      request({ ...f, target: f.other }, 'REST leave', enforcedApp),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409])
    expect(await responses.find(({ status }) => status === 409)?.json()).toEqual({
      error: 'sso_recovery_required',
    })
    expect(await recoveryOwners(f)).toHaveLength(1)
    expect(await removalAudits(f)).toHaveLength(1)
  })

  it.each(['REST removal', 'native removal'] as const)(
    'does not let an admin remove a recovery owner via %s',
    async (operation) => {
      const f = await fixture('owner', 'admin')
      await recover(f)
      expect((await request(f, operation)).status).toBe(403)
      expect(await memberRole(f)).toEqual({ role: 'owner' })
      expect(await recoveryOwners(f)).toEqual([{ user_id: f.target.userId }])
      expect(await removalAudits(f)).toEqual([])
    },
  )
})
