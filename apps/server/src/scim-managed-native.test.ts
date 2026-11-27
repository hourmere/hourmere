import { randomBytes, randomUUID } from 'node:crypto'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createBrowserSession,
  ensurePersonalOrganization,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nativeTeamLeave } from './native-team-leave.ts'

const databaseUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4396'
const secret = randomBytes(32).toString('base64')
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const denied = {
  code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
  message: 'team_management_access_denied',
}
const managedConflict = {
  code: 'scim_managed_resource',
  message: 'This resource is managed by your identity provider.',
}

function json<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe.skipIf(!databaseUrl)('SCIM managed memberships in native Better Auth', () => {
  let owned: TestDatabase
  let pool: pg.Pool
  let db: Db
  let auth: Auth

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_native' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool,
      signup,
      baseURL: origin,
      secret,
      scimResourcesEnabled: true,
      leaveTeamMember: nativeTeamLeave(db),
      mailer: { send: async () => {} },
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({
        name: 'Account name',
        email: `native-${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ...user, personal: await ensurePersonalOrganization(db, user.id) }
  }

  function add(organizationId: string, userId: string, role = 'member') {
    return db
      .insertInto('auth.member')
      .values({ organizationId, userId, role, createdAt: new Date() })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function session(userId: string, organizationId: string) {
    const browser = await db
      .transaction()
      .execute((trx) =>
        createBrowserSession(
          trx,
          { secret, publicUrl: origin },
          { userId, organizationId, now: new Date().toISOString(), headers: new Headers() },
        ),
      )
    return {
      cookie: browser.cookie.split(';')[0] as string,
      'x-expected-organization-id': organizationId,
      origin,
    }
  }

  function post(path: string, headers: Headers | Record<string, string>, body: unknown) {
    const requestHeaders = new Headers(headers)
    requestHeaders.set('content-type', 'application/json')
    return auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
      }),
    )
  }

  async function response(result: Response) {
    return { status: result.status, body: await result.json() }
  }

  async function fixture(role = 'member') {
    const owner = await account()
    const recipient = await account()
    const other = await account()
    const { id: team } = await db
      .insertInto('auth.organization')
      .values({ name: 'Native SCIM team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await add(team, owner.id, 'owner')
    const member = await add(team, other.id, role)
    const ownerSession = await session(owner.id, team)
    const memberSession = await session(other.id, team)
    const recipientSession = await session(recipient.id, recipient.personal)
    const invite = (createdAt = new Date()) =>
      db
        .insertInto('auth.invitation')
        .values({
          email: recipient.email,
          organizationId: team,
          inviterId: owner.id,
          role: 'member',
          status: 'pending',
          createdAt,
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    const connection = () =>
      db
        .insertInto('scim_connections')
        .values({ organization_id: team })
        .returning('id')
        .executeTakeFirstOrThrow()
    const roleChange = (role: string) =>
      post('organization/update-member-role', ownerSession, {
        organizationId: team,
        memberId: member.id,
        role,
      })
    const trustedAdd = () =>
      auth.api.addMember({ body: { organizationId: team, userId: recipient.id, role: 'member' } })
    const accept = (invitationId: string) =>
      post('organization/accept-invitation', recipientSession, { invitationId })
    const admitted = () =>
      db
        .selectFrom('auth.member')
        .selectAll()
        .where('organizationId', '=', team)
        .where('userId', '=', recipient.id)
        .executeTakeFirst()
    const entry = async (options: { active?: boolean; unlinked?: boolean } = {}) => {
      const { id } = await connection()
      return db
        .insertInto('scim_users')
        .values({
          organization_id: team,
          connection_id: id,
          user_name: options.unlinked ? recipient.email : other.email,
          linked_user_id: options.unlinked ? null : other.id,
          linked_member_id: options.unlinked ? null : member.id,
          active: options.active ?? true,
          display_name: 'Directory name',
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    }
    return {
      team,
      other,
      member,
      ownerSession,
      memberSession,
      recipient,
      invite,
      connection,
      roleChange,
      trustedAdd,
      accept,
      admitted,
      entry,
    }
  }

  it('keeps name changes out of the managed team while preserving personal and image writes', async () => {
    const f = await fixture()
    const entry = await f.entry()
    expect(
      await response(
        await post('update-user', f.memberSession, {
          name: 'Unmanaged name',
          image: '/uncommitted.png',
        }),
      ),
    ).toEqual({ status: 409, body: managedConflict })
    await expect(
      auth.api.updateUser({
        headers: new Headers(f.memberSession),
        body: { name: 'Trusted unmanaged name' },
      }),
    ).rejects.toMatchObject({ status: 'CONFLICT', body: managedConflict })
    const readAccount = () =>
      db
        .selectFrom('auth.user')
        .select(['name', 'image'])
        .where('id', '=', f.other.id)
        .executeTakeFirstOrThrow()
    expect(await readAccount()).toEqual({ name: 'Account name', image: null })
    expect(await response(await post('update-user', f.memberSession, { name: 42 }))).toEqual({
      status: 400,
      body: {
        code: 'INVALID_DISPLAY_NAME',
        message: 'Name must be a single line of text between 1 and 200 characters.',
      },
    })
    expect(await readAccount()).toEqual({ name: 'Account name', image: null })
    expect(
      await response(await post('update-user', f.memberSession, { image: '/personal.png' })),
    ).toEqual({ status: 200, body: { status: true } })
    const personalSession = await session(f.other.id, f.other.personal)
    expect(
      await response(await post('update-user', personalSession, { name: 'Personal name' })),
    ).toEqual({ status: 200, body: { status: true } })
    expect(await readAccount()).toEqual({ name: 'Personal name', image: '/personal.png' })
    expect(
      await db.selectFrom('scim_users').selectAll().where('id', '=', entry.id).executeTakeFirst(),
    ).toEqual(entry)
  })

  it('refuses an unsupported field in the native name write rather than silently dropping it', async () => {
    const f = await fixture()
    const stored = () =>
      db.selectFrom('auth.user').selectAll().where('id', '=', f.other.id).executeTakeFirstOrThrow()
    const before = await stored()
    const { internalAdapter } = await auth.$context
    const original = internalAdapter.updateUser
    // Simulate a future additional field that Better Auth already parsed for the adapter.
    const update = vi
      .spyOn(internalAdapter, 'updateUser')
      .mockImplementation((id, data) => original(id, { ...data, futureField: 'New data' }))
    try {
      expect(
        await response(
          await post('update-user', f.memberSession, { name: 'New name', image: '/new.png' }),
        ),
      ).toEqual({
        status: 400,
        body: {
          code: 'UNSUPPORTED_USER_UPDATE_FIELDS',
          message: 'This name update includes unsupported fields.',
        },
      })
      expect(await stored()).toEqual(before)
    } finally {
      update.mockRestore()
    }
  })

  it('does not elevate a suspended managed member and preserves ordinary owner authority', async () => {
    const f = await fixture()
    const entry = await f.entry({ active: false })
    await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.team,
        user_id: f.other.id,
        source: 'scim',
        kind: 'suspension',
        connection_id: entry.connection_id,
        scim_user_id: entry.id,
      })
      .execute()
    expect(await response(await f.roleChange('admin'))).toEqual({
      status: 409,
      body: managedConflict,
    })
    expect(
      await db
        .selectFrom('auth.member')
        .selectAll()
        .where('id', '=', f.member.id)
        .executeTakeFirst(),
    ).toEqual(f.member)

    const privileged = await fixture('admin')
    await privileged.entry()
    expect(await response(await privileged.roleChange('member'))).toEqual({
      status: 200,
      body: json({ ...privileged.member, role: 'member' }),
    })
  })

  it('requires a new invitation to clear local removal and never clears SCIM suspension', async () => {
    const f = await fixture()
    const entry = await f.entry({ unlinked: true })
    const old = await f.invite(new Date(Date.now() - 3000))
    const local = await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.team,
        identity_email: f.recipient.email,
        source: 'local',
        kind: 'removal',
        created_at: new Date(Date.now() - 2000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const cleared = () =>
      db
        .selectFrom('scim_membership_blocks')
        .select('cleared_at')
        .where('id', '=', local.id)
        .executeTakeFirstOrThrow()
    expect(await response(await f.accept(old.id))).toEqual({ status: 403, body: denied })
    expect(await cleared()).toEqual({ cleared_at: null })
    expect(await f.admitted()).toBeUndefined()
    await db
      .updateTable('auth.invitation')
      .set({ status: 'canceled' })
      .where('id', '=', old.id)
      .execute()
    const current = await f.invite()
    const blocked = await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.team,
        identity_email: f.recipient.email,
        source: 'scim',
        kind: 'suspension',
        connection_id: entry.connection_id,
        scim_user_id: entry.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    expect(await response(await f.accept(current.id))).toEqual({ status: 403, body: denied })
    expect(await cleared()).toEqual({ cleared_at: null })
    expect(await f.admitted()).toBeUndefined()
    await db
      .updateTable('scim_membership_blocks')
      .set({ cleared_at: new Date() })
      .where('id', '=', blocked.id)
      .execute()
    expect(await response(await f.accept(current.id))).toEqual({
      status: 200,
      body: {
        invitation: json({ ...current, status: 'accepted' }),
        member: json(await f.admitted()),
      },
    })
    expect(await cleared()).toEqual({ cleared_at: expect.any(Date) })
  })

  it.each(['add', 'accept'] as const)(
    'rechecks native %s after waiting on a concurrent organization lock',
    async (operation) => {
      const f = await fixture()
      await f.connection()
      const invitation = await f.invite(new Date(Date.now() - 2000))
      const lock = Promise.withResolvers<number>()
      const release = Promise.withResolvers<void>()
      const blocking = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', f.team)
          .forUpdate()
          .executeTakeFirstOrThrow()
        const { pid } = await trx
          .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
          .executeTakeFirstOrThrow()
        lock.resolve(pid)
        await release.promise
        await trx
          .insertInto('scim_membership_blocks')
          .values({
            organization_id: f.team,
            identity_email: f.recipient.email,
            source: 'local',
            kind: 'removal',
          })
          .execute()
      })
      const pid = await lock.promise
      const writing =
        operation === 'add'
          ? f.trustedAdd().catch((error: unknown) => error)
          : f.accept(invitation.id).then(response)
      try {
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: boolean }>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND ${pid} = ANY(pg_blocking_pids(pid))
                AND query LIKE '%"auth"."organization"%for update%'
            ) AS waiting
          `.execute(db)
            expect(rows[0]?.waiting).toBe(true)
          },
          { timeout: 3500, interval: 25 },
        )
      } finally {
        release.resolve()
        await Promise.allSettled([blocking, writing])
      }
      await blocking
      if (operation === 'add') {
        expect(await writing).toMatchObject({ status: 'FORBIDDEN', body: denied })
      } else {
        expect(await writing).toEqual({ status: 403, body: denied })
      }
      expect(await f.admitted()).toBeUndefined()
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', invitation.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending' })
    },
  )

  it('preserves native responses and PostgreSQL statement counts for a team without SCIM', async () => {
    const f = await fixture()
    const invitation = await f.invite()
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    const counts: Record<string, number> = {}
    async function measured<T>(operation: string, request: () => Promise<T>) {
      queries.mockClear()
      const result = await request()
      counts[operation] = queries.mock.calls.length
      return result
    }
    try {
      const named = await measured('profile', () =>
        post('update-user', f.memberSession, { name: 'Manual name' }),
      )
      expect(await response(named)).toEqual({ status: 200, body: { status: true } })

      const changed = await measured('role', () => f.roleChange('admin'))
      expect(await response(changed)).toEqual({
        status: 200,
        body: json({ ...f.member, role: 'admin' }),
      })
      const removed = await measured('remove', () =>
        post('organization/remove-member', f.ownerSession, {
          organizationId: f.team,
          memberIdOrEmail: f.member.id,
        }),
      )
      expect(await response(removed)).toEqual({
        status: 200,
        body: { member: json({ ...f.member, role: 'admin' }) },
      })

      const accepted = await measured('accept', () => f.accept(invitation.id))
      const member = await f.admitted()
      expect(member).toBeDefined()
      expect(await response(accepted)).toEqual({
        status: 200,
        body: { invitation: json({ ...invitation, status: 'accepted' }), member: json(member) },
      })
      const recipientSession = await session(f.recipient.id, f.team)
      const departure = await measured('leave', () =>
        post('organization/leave', recipientSession, { organizationId: f.team }),
      )
      const { id, name, email, image } = f.recipient
      expect(await response(departure)).toEqual({
        status: 200,
        body: json({ ...member, user: { id, name, email, image } }),
      })

      const trusted = await measured('add', () => f.trustedAdd())
      expect(trusted).toEqual(await f.admitted())
      // Role changes, removals and departures each check for a pending transfer once.
      expect(counts).toEqual({ profile: 3, role: 44, remove: 58, accept: 34, leave: 42, add: 13 })
    } finally {
      queries.mockRestore()
    }
  })
})
