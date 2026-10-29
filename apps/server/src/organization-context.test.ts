import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const bootstrap = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = 'synthetic-organization-context-session-secret-000000'
const refused = {
  error: 'organization_context_changed',
  message: 'Your team context changed. Reload the page before trying again.',
}

describe.skipIf(!bootstrap)('organization-bound event-type web writes', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>
  let afterResolution: (() => Promise<void>) | undefined

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: {
        send: async () => {
          throw new Error('Real mail forbidden')
        },
      },
    })
    const resolve = createCallerResolver({ auth, db })
    app = createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const result = await resolve(headers)
        const hook = afterResolution
        afterResolution = undefined
        await hook?.()
        return result
      },
      routes: [eventTypeRoutes({ db })],
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture() {
    const user = await createTestUser(db, 'Context owner')
    const first = await createTestTeam(db, [{ user, role: 'owner' }], 'First team')
    const second = await createTestTeam(db, [{ user, role: 'owner' }], 'Second team')
    await createFixtures(db).schedule(user.id, { timeZone: 'UTC' })
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: first.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    const event = await createEventType(testContext(db, first.as(user)), {
      slug: 'round',
      title: 'Original title',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: [{ userId: user.id }],
    })
    return { user, first, second, sessionId: session.id, cookie, event }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const input = () => ({ slug: `new-${randomUUID()}`, title: 'Created title', durationMinutes: 30 })
  async function request(
    f: Fixture,
    method: string,
    path: string,
    body?: object,
    expected: string | undefined = f.first.id,
    extra: Record<string, string> = {},
  ) {
    return app.request(path, {
      method,
      headers: {
        cookie: f.cookie,
        origin,
        ...(expected === undefined || path === '/api/auth/organization/set-active'
          ? {}
          : { [EXPECTED_ORGANIZATION_HEADER]: expected }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function switchTo(f: Fixture, organizationId: string) {
    const response = await request(f, 'POST', '/api/auth/organization/set-active', {
      organizationId,
    })
    expect(response.status).toBe(200)
  }
  async function expectRefused(response: Response) {
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(refused)
  }
  async function expectUnchanged(f: Fixture) {
    expect(
      await db
        .selectFrom('event_types')
        .select(['title', 'is_active', 'deleted_at'])
        .where('id', '=', f.event.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      title: 'Original title',
      is_active: true,
      deleted_at: null,
    })
    expect(
      await db
        .selectFrom('round_robin_state')
        .select('enabled')
        .where('event_type_id', '=', f.event.id)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('event_types')
        .select('id')
        .where('organization_id', 'in', [f.first.id, f.second.id])
        .execute(),
    ).toHaveLength(1)
  }
  const operations = ['create', 'edit', 'enable', 'disable', 'activate', 'delete'] as const
  function write(f: Fixture, operation: (typeof operations)[number], expected?: string) {
    const path = `/api/v1/event-types/${f.event.id}`
    if (operation === 'create') return request(f, 'POST', '/api/v1/event-types', input(), expected)
    if (operation === 'delete') return request(f, 'DELETE', path, undefined, expected)
    if (operation === 'activate')
      return request(f, 'POST', `${path}/round-robin/activate`, {}, expected)
    return request(
      f,
      'PATCH',
      path,
      operation === 'edit' ? { title: 'New title' } : { isActive: operation === 'enable' },
      expected,
    )
  }

  it.each(operations)('refuses a missing expected organization for %s', async (operation) => {
    const f = await fixture()
    // Explicit absence, rather than the request helper's normal pinned draft organization.
    const path =
      operation === 'create' ? '/api/v1/event-types' : `/api/v1/event-types/${f.event.id}`
    const method =
      operation === 'create' || operation === 'activate'
        ? 'POST'
        : operation === 'delete'
          ? 'DELETE'
          : 'PATCH'
    const response = await app.request(
      operation === 'activate' ? `${path}/round-robin/activate` : path,
      {
        method,
        headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
        ...(method === 'DELETE'
          ? {}
          : {
              body: JSON.stringify(
                operation === 'create'
                  ? input()
                  : operation === 'activate'
                    ? {}
                    : operation === 'edit'
                      ? { title: 'New title' }
                      : { isActive: operation === 'enable' },
              ),
            }),
      },
    )
    await expectRefused(response)
    await expectUnchanged(f)
  })

  it.each(operations)('refuses cross-tab drift after switching for %s', async (operation) => {
    const f = await fixture()
    await switchTo(f, f.second.id)
    await expectRefused(await write(f, operation, f.first.id))
    await expectUnchanged(f)
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', f.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: f.second.id })
  })

  it.each(operations)('accepts the creation-time organization for %s', async (operation) => {
    const f = await fixture()
    const response = await write(f, operation, f.first.id.toUpperCase())
    expect(response.status).toBe(operation === 'create' ? 201 : operation === 'delete' ? 204 : 200)
  })

  it.each(['not-a-uuid', '', 'foreign-team'])('refuses forged context %j', async (value) => {
    const f = await fixture()
    const foreign = await createTestTeam(db, [])
    await expectRefused(await write(f, 'create', value === 'foreign-team' ? foreign.id : value))
    await expectUnchanged(f)
  })

  it('refuses target mismatch and missing targets identically when expected matches the current team', async () => {
    const f = await fixture()
    await switchTo(f, f.second.id)
    for (const target of [f.event.id, randomUUID(), 'not-a-uuid'])
      await expectRefused(
        await request(
          f,
          'PATCH',
          `/api/v1/event-types/${target}`,
          { title: 'Forged' },
          f.second.id,
        ),
      )
    await expectUnchanged(f)
  })

  it('does not use a forged context to grant an ordinary member management access', async () => {
    const f = await fixture()
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.first.id)
      .where('userId', '=', f.user.id)
      .execute()
    const response = await write(f, 'edit', f.first.id)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
    await expectUnchanged(f)
  })

  it('refuses a removed member after the resolver falls back to personal context', async () => {
    const f = await fixture()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.first.id)
      .where('userId', '=', f.user.id)
      .execute()
    await expectRefused(await write(f, 'create', f.first.id))
    await expectUnchanged(f)
  })

  it.each(['switch', 'remove', 'demote', 'expired session', 'deleted session'] as const)(
    'rechecks %s after caller resolution',
    async (change) => {
      const f = await fixture()
      afterResolution = async () => {
        if (change === 'switch')
          await db
            .updateTable('auth.session')
            .set({ activeOrganizationId: f.second.id })
            .where('id', '=', f.sessionId)
            .execute()
        else if (change === 'remove')
          await db
            .deleteFrom('auth.member')
            .where('organizationId', '=', f.first.id)
            .where('userId', '=', f.user.id)
            .execute()
        else if (change === 'expired session')
          await db
            .updateTable('auth.session')
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where('id', '=', f.sessionId)
            .execute()
        else if (change === 'deleted session')
          await db.deleteFrom('auth.session').where('id', '=', f.sessionId).execute()
        else
          await db
            .updateTable('auth.member')
            .set({ role: 'member' })
            .where('organizationId', '=', f.first.id)
            .where('userId', '=', f.user.id)
            .execute()
      }
      const response = await write(f, 'create', f.first.id)
      if (change === 'switch') await expectRefused(response)
      else {
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
      }
      await expectUnchanged(f)
    },
  )

  it('observes a switch committed while waiting for the shared authorization lock', async () => {
    const f = await fixture()
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.first.id])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      pending = write(f, 'create', f.first.id)
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
            [pid],
          )
          expect(result.rows[0]?.n).toBeGreaterThan(0)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
        f.second.id,
        f.sessionId,
      ])
      await holder.query('COMMIT')
      await expectRefused(await pending)
      await expectUnchanged(f)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  })

  it('requires context for personal drafts and preserves their binding across team switches', async () => {
    const f = await fixture()
    const personalId = f.user.principal.organization.id
    await switchTo(f, personalId)
    const legacy = await app.request('/api/v1/event-types', {
      method: 'POST',
      headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    })
    await expectRefused(legacy)
    const personal = await write(f, 'create', personalId)
    expect(personal.status).toBe(201)
    expect(await personal.json()).toMatchObject({
      organizationId: personalId,
      ownerUserId: f.user.id,
    })
    await expectRefused(await write(f, 'create', f.first.id))
    await switchTo(f, f.first.id)
    await expectRefused(await write(f, 'create', personalId))
    await expectUnchanged(f)
  })

  it.each(['switch', 'removal'] as const)(
    'refuses an old team-create form without context after %s falls back to personal',
    async (change) => {
      const f = await fixture()
      const personalId = f.user.principal.organization.id
      if (change === 'switch') await switchTo(f, personalId)
      else
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.first.id)
          .where('userId', '=', f.user.id)
          .execute()
      const response = await app.request('/api/v1/event-types', {
        method: 'POST',
        headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(input()),
      })
      await expectRefused(response)
      await expectUnchanged(f)
      expect(
        await db
          .selectFrom('event_types')
          .select('id')
          .where('organization_id', '=', personalId)
          .execute(),
      ).toEqual([])
    },
  )

  it('keeps API keys pinned independently of web switches and ignores a forged web header', async () => {
    const f = await fixture()
    const key = await auth.api.createApiKey({
      body: { userId: f.user.id, metadata: { organizationId: f.first.id } },
    })
    await switchTo(f, f.second.id)
    for (const expected of [undefined, f.second.id]) {
      const response = await app.request('/api/v1/event-types', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.key}`,
          'content-type': 'application/json',
          ...(expected === undefined ? {} : { [EXPECTED_ORGANIZATION_HEADER]: expected }),
        },
        body: JSON.stringify(input()),
      })
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ organizationId: f.first.id })
    }
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.first.id)
      .where('userId', '=', f.user.id)
      .execute()
    const denied = await app.request('/api/v1/event-types', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: f.first.id,
      },
      body: JSON.stringify(input()),
    })
    expect(denied.status).toBe(401)
  })

  it.each(['https://foreign.example', 'null', 'missing'])(
    'preserves CSRF refusal before context inspection for %s',
    async (source) => {
      const f = await fixture()
      const headers: Record<string, string> = {
        cookie: f.cookie,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: f.first.id,
      }
      if (source !== 'missing') headers.origin = source
      const response = await app.request('/api/v1/event-types', {
        method: 'POST',
        headers,
        body: JSON.stringify(input()),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'forbidden' })
      await expectUnchanged(f)
    },
  )
})
