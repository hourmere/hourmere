import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  organizationContext,
  serializeOrganizationContext,
} from '../../../packages/auth/src/organization-context.ts'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4386'
const policy: SignupPolicy = { mode: 'open', allowedDomains: [] }
const header = 'x-expected-organization-id'

describe.skipIf(!serverUrl)('organization web write context', () => {
  let testDb: TestDatabase
  let db: Db
  let pool: pg.Pool
  let auth: Auth
  let app: ReturnType<typeof createApp>
  const secret = randomBytes(32).toString('base64')

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    pool = createAuthPool(testDb.url, policy)
    auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: policy,
      mailer: { send: async () => {} },
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
    await testDb?.drop()
  })

  function post(action: string, cookie: string, body: unknown, expected?: string, from = origin) {
    return app.request(`/api/auth/organization/${action}`, {
      method: 'POST',
      headers: {
        cookie,
        origin: from,
        'content-type': 'application/json',
        ...(expected === undefined ? {} : { [header]: expected }),
      },
      body: JSON.stringify(body),
    })
  }

  async function user() {
    return db
      .insertInto('auth.user')
      .values({
        name: 'Context fixture',
        email: `${randomUUID()}@example.com`,
        emailVerified: true,
      })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow()
  }

  async function fixture() {
    const actor = await user()
    const peer = await user()
    const survivor = await user()
    const personal = await ensurePersonalOrganization(db, actor.id)
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        token,
        userId: actor.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: personal,
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    async function team() {
      const org = await db
        .insertInto('auth.organization')
        .values({ name: 'Original team', slug: randomUUID(), createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
      const members = await db
        .insertInto('auth.member')
        .values(
          [
            [actor.id, 'owner'],
            [peer.id, 'member'],
            [survivor.id, 'owner'],
          ].map(([userId, role]) => ({
            userId: userId as string,
            role: role as string,
            organizationId: org.id,
            createdAt: new Date(),
          })),
        )
        .returning(['id', 'userId'])
        .execute()
      const invitation = await db
        .insertInto('auth.invitation')
        .values({
          organizationId: org.id,
          inviterId: actor.id,
          email: `${randomUUID()}@example.com`,
          role: 'member',
          status: 'pending',
          createdAt: new Date(Date.now() - 3_600_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning(['id', 'email'])
        .executeTakeFirstOrThrow()
      return {
        id: org.id,
        memberId: members.find((m) => m.userId === peer.id)?.id as string,
        invitation,
      }
    }
    const first = await team()
    const second = await team()
    expect((await post('set-active', cookie, { organizationId: first.id })).status).toBe(200)
    return { actor, peer, cookie, first, second, personal }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  const operations = [
    [
      'invite-member',
      (f: Fixture) => ({
        email: `${randomUUID()}@example.com`,
        role: 'member',
        organizationId: f.first.id,
      }),
    ],
    ['cancel-invitation', (f: Fixture) => ({ invitationId: f.first.invitation.id })],
    [
      'update-member-role',
      (f: Fixture) => ({ memberId: f.first.memberId, role: 'admin', organizationId: f.first.id }),
    ],
    [
      'remove-member',
      (f: Fixture) => ({ memberIdOrEmail: f.first.memberId, organizationId: f.first.id }),
    ],
    ['leave', (f: Fixture) => ({ organizationId: f.first.id })],
    ['update', (f: Fixture) => ({ organizationId: f.first.id, data: { name: 'Saved team' } })],
  ] as const

  async function snapshot(f: Fixture) {
    return {
      organizations: await db
        .selectFrom('auth.organization')
        .select(['id', 'name'])
        .where('id', 'in', [f.first.id, f.second.id])
        .orderBy('id')
        .execute(),
      members: await db
        .selectFrom('auth.member')
        .select(['id', 'role'])
        .where('organizationId', 'in', [f.first.id, f.second.id])
        .orderBy('id')
        .execute(),
      invitations: await db
        .selectFrom('auth.invitation')
        .select(['id', 'status'])
        .where('organizationId', 'in', [f.first.id, f.second.id])
        .orderBy('id')
        .execute(),
    }
  }
  async function refused(response: Response) {
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: 'ORGANIZATION_CONTEXT_CHANGED',
      message: 'Your team context changed. Reload this page before trying again.',
    })
  }

  it.each(operations)(
    'refuses missing context and cross-tab drift for %s, then permits a fresh action',
    async (action, body) => {
      const f = await fixture()
      const draft = body(f)
      const before = await snapshot(f)
      await refused(await post(action, f.cookie, draft))
      expect(await snapshot(f)).toEqual(before)
      // Both tabs share the same real cookie/session. The old form stays pinned to first.
      expect((await post('set-active', f.cookie, { organizationId: f.second.id })).status).toBe(200)
      await refused(await post(action, f.cookie, draft, f.first.id))
      expect(await snapshot(f)).toEqual(before)
      expect((await post('set-active', f.cookie, { organizationId: f.first.id })).status).toBe(200)
      expect((await post(action, f.cookie, draft, f.first.id)).status).toBe(200)
    },
  )

  it('rejects forged expectations, organization fields and target object ids without writes', async () => {
    const f = await fixture()
    const before = await snapshot(f)
    for (const expected of [f.second.id, randomUUID(), 'not-an-id']) {
      await refused(
        await post(
          'update',
          f.cookie,
          { organizationId: f.first.id, data: { name: 'Forged' } },
          expected,
        ),
      )
    }
    await refused(
      await post(
        'update',
        f.cookie,
        { organizationId: f.second.id, data: { name: 'Forged' } },
        f.first.id,
      ),
    )
    for (const invitationId of [f.second.invitation.id, randomUUID()]) {
      await refused(await post('cancel-invitation', f.cookie, { invitationId }, f.first.id))
    }
    for (const memberId of [f.second.memberId, randomUUID()]) {
      await refused(
        await post(
          'update-member-role',
          f.cookie,
          { organizationId: f.first.id, memberId, role: 'admin' },
          f.first.id,
        ),
      )
      await refused(
        await post(
          'remove-member',
          f.cookie,
          { organizationId: f.first.id, memberIdOrEmail: memberId },
          f.first.id,
        ),
      )
    }
    expect(await snapshot(f)).toEqual(before)
  })

  it('binds invitation resends to the original team', async () => {
    const f = await fixture()
    const body = {
      organizationId: f.first.id,
      email: f.first.invitation.email,
      role: 'member',
      resend: true,
      invitationId: f.first.invitation.id,
      expectedGeneration: 1,
      requestId: randomUUID(),
    }
    const before = await snapshot(f)
    expect((await post('set-active', f.cookie, { organizationId: f.second.id })).status).toBe(200)
    await refused(await post('invite-member', f.cookie, body, f.first.id))
    expect(await snapshot(f)).toEqual(before)
    expect((await post('set-active', f.cookie, { organizationId: f.first.id })).status).toBe(200)
    const resent = await post('invite-member', f.cookie, body, f.first.id)
    expect(resent.status).toBe(200)
    expect(await resent.json()).toMatchObject({ id: f.first.invitation.id, status: 'pending' })
  })

  it('uses the effective personal organization after removal and keeps role authorization', async () => {
    const f = await fixture()
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.first.id)
      .where('userId', '=', f.actor.id)
      .execute()
    const denied = await post(
      'invite-member',
      f.cookie,
      { organizationId: f.first.id, email: 'role@example.com', role: 'member' },
      f.first.id,
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'TEAM_INVITATION_ACCESS_DENIED',
    })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.first.id)
      .where('userId', '=', f.actor.id)
      .execute()
    const before = await snapshot(f)
    await refused(
      await post(
        'update',
        f.cookie,
        { organizationId: f.first.id, data: { name: 'Removed' } },
        f.first.id,
      ),
    )
    // Forging the fallback cannot authorize a write to the removed team's target.
    await refused(
      await post(
        'update',
        f.cookie,
        { organizationId: f.first.id, data: { name: 'Removed' } },
        f.personal,
      ),
    )
    expect(await snapshot(f)).toEqual(before)
  })

  it('supports active-organization defaults and preserves same-origin CSRF checks', async () => {
    const f = await fixture()
    const before = await snapshot(f)
    const denied = await post(
      'update',
      f.cookie,
      { data: { name: 'Cross origin' } },
      f.first.id,
      'https://other.example',
    )
    expect(denied.status).toBe(403)
    expect(await snapshot(f)).toEqual(before)
    const updated = await post('update', f.cookie, { data: { name: 'Saved default' } }, f.first.id)
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ id: f.first.id, name: 'Saved default' })
  })

  it('rejects an omitted target when the cached session and live organization differ', async () => {
    const f = await fixture()
    // This is Better Auth's real cached context before another tab switches the same row.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) })
    expect(session).toBeDefined()
    expect((await post('set-active', f.cookie, { organizationId: f.second.id })).status).toBe(200)
    const before = await snapshot(f)
    for (const path of ['invite-member', 'update-member-role', 'remove-member', 'update']) {
      const ctx = {
        path: `/organization/${path}`,
        body: {},
        request: new Request(origin, { headers: { [header]: f.second.id } }),
        context: { session },
      } as unknown as Parameters<typeof organizationContext>[0]
      await expect(organizationContext(ctx, db)).rejects.toMatchObject({
        status: 'CONFLICT',
        body: { code: 'ORGANIZATION_CONTEXT_CHANGED' },
      })
    }
    expect(await snapshot(f)).toEqual(before)
  })

  it.each([
    'set-active',
    'create',
    'accept-invitation',
    'get-organization',
    'get-full-organization',
  ])('orders an overlapping %s after a covered write finishes', async (action) => {
    const f = await fixture()
    const outside = await db
      .insertInto('auth.organization')
      .values({ name: 'Outside team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: outside.id,
        userId: f.peer.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: outside.id,
        inviterId: f.peer.id,
        email: f.actor.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const adapter = (await auth.$context).adapter
    const original = adapter.update.bind(adapter)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const spy = vi.spyOn(adapter, 'update')
    spy.mockImplementation((async (request: Parameters<typeof original>[0]) => {
      if (request.model === 'organization' && request.update.name === 'Ordered write') {
        entered.resolve()
        await resume.promise
      }
      return original(request)
    }) as typeof original)
    let write: Promise<Response> | undefined
    let transition: Promise<Response> | undefined
    try {
      write = Promise.resolve(
        post(
          'update',
          f.cookie,
          { organizationId: f.first.id, data: { name: 'Ordered write' } },
          f.first.id,
        ),
      )
      await entered.promise
      transition = Promise.resolve(
        action.startsWith('get-')
          ? app.request(`/api/auth/organization/${action}?organizationId=${outside.id}`, {
              headers: { cookie: f.cookie },
            })
          : post(
              action,
              f.cookie,
              action === 'set-active'
                ? { organizationId: f.second.id }
                : action === 'create'
                  ? { name: 'Created while writing', slug: randomUUID() }
                  : { invitationId: invitation.id },
            ),
      )
      await vi.waitFor(
        async () => {
          const result = await testDb.pool.query<{ blocked: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'
          ) AS blocked`)
          expect(result.rows[0]?.blocked).toBe(true)
        },
        { interval: 10, timeout: 1_000 },
      )
      const current = await auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) })
      expect(
        current && 'activeOrganizationId' in current.session
          ? current.session.activeOrganizationId
          : undefined,
      ).toBe(f.first.id)
      resume.resolve()
      const [written, transitioned] = await Promise.all([write, transition])
      expect(written.status).toBe(200)
      expect(transitioned.status).toBe(action.startsWith('get-') ? 403 : 200)
      expect(
        await db
          .selectFrom('auth.organization')
          .select('name')
          .where('id', '=', f.first.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Ordered write' })
      await refused(
        await post(
          'update',
          f.cookie,
          { organizationId: f.first.id, data: { name: 'Stale after transition' } },
          f.first.id,
        ),
      )
    } finally {
      resume.resolve()
      await Promise.allSettled([write, transition])
      spy.mockRestore()
    }
  })

  it('handles twelve same-session waiters and twelve distinct sessions without pool starvation', async () => {
    async function burst(requests: (Promise<Response> | Response)[]) {
      const pending = Promise.all(requests)
      let timer: ReturnType<typeof setTimeout> | undefined
      let completed = false
      try {
        const responses = await Promise.race([
          pending,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 1_500)
          }),
        ])
        completed = responses !== null
        expect(
          responses,
          'Organization writes must finish without exhausting their query pool',
        ).not.toBeNull()
        expect(responses?.map((response) => response.status)).toEqual(Array(12).fill(200))
      } finally {
        clearTimeout(timer)
        // A source-copy mutation may reserve every application connection for locks. Cancel
        // only its advisory waiters in this fixture's private DB so assertion cleanup ends.
        if (!completed) {
          await pool.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%pg_advisory_xact_lock%'`)
          await pending
        }
      }
    }
    const shared = await fixture()
    await burst(
      Array.from({ length: 12 }, (_, index) =>
        post(
          'update',
          shared.cookie,
          { organizationId: shared.first.id, data: { name: `Queued ${index}` } },
          shared.first.id,
        ),
      ),
    )
    const actors: Fixture[] = []
    for (let index = 0; index < 12; index++) actors.push(await fixture())
    await burst(
      actors.map((f) =>
        post(
          'update',
          f.cookie,
          { organizationId: f.first.id, data: { name: 'Concurrent actor' } },
          f.first.id,
        ),
      ),
    )
  })

  it('rereads the operation session after waiting for its organization lock', async () => {
    const f = await fixture()
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) })
    const locks = (pool as pg.Pool & { organizationLocks: pg.Pool }).organizationLocks
    const holder = await locks.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `hourmere.organization-context:${session?.session.id}`,
      ])
      pending = Promise.resolve(
        post(
          'update',
          f.cookie,
          { organizationId: f.first.id, data: { name: 'Stale waiter' } },
          f.first.id,
        ),
      )
      await vi.waitFor(
        async () => {
          const result = await testDb.pool.query<{ blocked: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'
        ) AS blocked`)
          expect(result.rows[0]?.blocked).toBe(true)
        },
        { interval: 10, timeout: 1_000 },
      )
      // Trusted server calls deliberately retain their API semantics outside the web lock.
      await auth.api.setActiveOrganization({
        headers: new Headers({ cookie: f.cookie }),
        body: { organizationId: f.second.id },
      })
      await holder.query('COMMIT')
      await refused(await pending)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  })

  it('releases the organization lock when the wrapped handler throws', async () => {
    const f = await fixture()
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) })
    expect(session).toBeDefined()
    const handler = serializeOrganizationContext(
      db,
      async () => {
        throw new Error('Synthetic handler failure')
      },
      async () => session,
    )
    await expect(
      handler(new Request(`${origin}/api/auth/organization/update`, { method: 'POST' })),
    ).rejects.toThrow('Synthetic handler failure')
    const released = await testDb.pool.query<{ released: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS released',
      [`hourmere.organization-context:${session?.session.id}`],
    )
    expect(released.rows[0]?.released).toBe(true)
  })

  it('closes the lazily reused lock pool together with its auth pool, including callback teardown', async () => {
    const owned = createAuthPool(testDb.url, policy)
    const locks = (owned as pg.Pool & { organizationLocks: pg.Pool }).organizationLocks
    expect(owned.totalCount).toBe(0)
    expect(locks.totalCount).toBe(0)
    let closed = false
    try {
      const authPid = (await owned.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      const lockPid = (await locks.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      await new Promise<void>((resolve) => owned.end(resolve))
      closed = true
      expect(owned.totalCount).toBe(0)
      expect(locks.totalCount).toBe(0)
      await vi.waitFor(async () => {
        const connected = await testDb.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid = ANY($1::int[])',
          [[authPid, lockPid]],
        )
        expect(connected.rows[0]?.n).toBe(0)
      })
    } finally {
      if (!closed) await owned.end()
      else if (locks.totalCount > 0) await locks.end()
    }
  })

  it('refuses direct team deletion while create and explicit switching stay target-bound', async () => {
    const f = await fixture()
    const deleted = await post('delete', f.cookie, { organizationId: f.first.id })
    expect(deleted.status).toBe(403)
    expect(await deleted.json()).toMatchObject({ code: 'TEAM_OPERATION_NOT_SUPPORTED' })
    expect(
      await db
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', f.first.id)
        .executeTakeFirst(),
    ).toBeDefined()
    const created = await post('create', f.cookie, { name: 'New team', slug: randomUUID() })
    expect(created.status).toBe(200)
    expect((await post('set-active', f.cookie, { organizationId: f.first.id })).status).toBe(200)
  })
})
