import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../packages/calendars/src/google.ts'
import {
  beginGoogleConnection,
  finishGoogleConnection,
  lockUser,
} from '../../../packages/calendars/src/index.ts'
import {
  calendarTestSession,
  fakeGoogle,
  TEST_CALENDAR_KEY,
  TEST_PUBLIC_URL,
} from '../../../packages/calendars/src/testing.ts'
import { createTestTeam } from '../../../packages/scheduling/src/testing.ts'
import { createApp } from './app.ts'
import { calendarRoutes } from './routes/calendars.ts'

describe.skipIf(!process.env.DATABASE_URL)('API key calendar write revalidation', () => {
  let database: TestDatabase, db: Db, pool: ReturnType<typeof createAuthPool>, auth: Auth
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    pool = createAuthPool(database.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: TEST_PUBLIC_URL,
      secret: 'synthetic-calendar-write-test-secret-000000000000',
      signup,
      mailer: { send: async () => {} },
    })
  })
  afterAll(async () => {
    await pool?.end()
    await database?.drop()
  })

  async function setup() {
    const owner = await calendarTestSession(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: `key-${owner.user.id}`, time_zone: 'UTC' })
      .execute()
    const provider = fakeGoogle()
    provider.controls.identity.sub = owner.user.id
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    const now = Date.now()
    let checkedAt = now
    let onLock: ((query: string) => void) | undefined
    const deps = {
      db: db.withPlugin({
        transformQuery(args) {
          onLock?.(JSON.stringify(args.node))
          return args.node
        },
        async transformResult(args) {
          return args.result
        },
      }),
      now: () => checkedAt,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    const state = new URL(
      (await beginGoogleConnection(deps, owner, 'sync')).authorizationUrl,
    ).searchParams.get('state') as string
    expect(
      await finishGoogleConnection(deps, owner, new URLSearchParams({ state, code: 'synthetic' })),
    ).toBe('connected')
    const calendar = await db
      .selectFrom('calendars as c')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .select(['c.id', 'c.connection_id'])
      .where('cc.user_id', '=', owner.user.id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendars')
      .set({ check_conflicts: true })
      .where('id', '=', calendar.id)
      .execute()
    const key = await auth.api.createApiKey({ body: { userId: owner.user.id } })
    const headers = { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }
    const resolve = createCallerResolver({ auth, db })
    let afterResolution: (() => Promise<void>) | undefined
    const app = createApp({
      publicUrl: TEST_PUBLIC_URL,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const result = await resolve(headers)
        // Deterministic gap: the real resolver has accepted the key, no write has begun.
        if (afterResolution) {
          expect(result.ok).toBe(true)
          const hook = afterResolution
          afterResolution = undefined
          await hook()
        }
        return result
      },
      routes: [calendarRoutes(deps)],
    })
    return {
      owner,
      now,
      key,
      calendar,
      provider,
      app,
      headers,
      advanceClock: (instant: number) => {
        checkedAt = instant
      },
      onLock: (hook: (query: string) => void) => {
        onLock = hook
      },
      afterResolve: (hook: () => Promise<void>) => {
        afterResolution = hook
      },
    }
  }

  const writes = ['conflicts', 'destination', 'refresh', 'sync'] as const
  function request(s: Awaited<ReturnType<typeof setup>>, write: (typeof writes)[number]) {
    return s.app.request(
      write === 'conflicts'
        ? `/api/v1/calendars/${s.calendar.id}`
        : write === 'destination'
          ? '/api/v1/calendar-destination'
          : write === 'sync'
            ? `/api/v1/calendars/${s.calendar.id}/sync`
            : `/api/v1/calendar-connections/${s.calendar.connection_id}/refresh`,
      {
        method: write === 'conflicts' ? 'PATCH' : write === 'destination' ? 'PUT' : 'POST',
        headers: s.headers,
        body: JSON.stringify(
          write === 'conflicts'
            ? { checkConflicts: false }
            : write === 'destination'
              ? { calendarId: s.calendar.id }
              : {},
        ),
      },
    )
  }
  async function snapshot(s: Awaited<ReturnType<typeof setup>>) {
    return {
      connection: await db
        .selectFrom('calendar_connections')
        .selectAll()
        .where('id', '=', s.calendar.connection_id)
        .executeTakeFirst(),
      calendar: await db
        .selectFrom('calendars')
        .selectAll()
        .where('id', '=', s.calendar.id)
        .execute(),
      profile: await db
        .selectFrom('profiles')
        .selectAll()
        .where('user_id', '=', s.owner.user.id)
        .execute(),
    }
  }

  it.each(writes)(
    'rejects a key disabled after resolution before %s and leaves data unchanged',
    async (write) => {
      const s = await setup()
      const before = await snapshot(s),
        calls = s.provider.calls.length
      s.afterResolve(async () => {
        await db
          .updateTable('auth.apikey')
          .set({ enabled: false })
          .where('id', '=', s.key.id)
          .execute()
      })
      const response = await request(s, write)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
      expect(await response.json()).toEqual({ error: 'unauthorized' })
      expect(await snapshot(s)).toEqual(before)
      expect(s.provider.calls).toHaveLength(calls)
      const atResolution = await request(s, write)
      expect(atResolution.status).toBe(response.status)
      expect(await atResolution.json()).toEqual({ error: 'unauthorized' })
    },
  )

  it.each([
    'deleted',
    'expired',
    'owner',
    'organization',
    'invalid metadata',
    'legacy organization',
  ])('rejects a key changed after resolution: %s', async (change) => {
    const s = await setup(),
      other = await calendarTestSession(db)
    const before = await snapshot(s)
    s.afterResolve(async () => {
      if (change === 'deleted') {
        // A different live key must never stand in for the credential that resolved.
        await auth.api.createApiKey({ body: { userId: s.owner.user.id } })
        await db.deleteFrom('auth.apikey').where('id', '=', s.key.id).execute()
        return
      }
      if (change === 'invalid metadata') {
        // Only this owned test database bypasses the new storage invariant, so the
        // transaction-level guard is still exercised against a corrupted row.
        await database.pool.query('ALTER TABLE auth.apikey DISABLE TRIGGER api_key_scope_guard')
        try {
          await db
            .updateTable('auth.apikey')
            .set({ metadata: '{' })
            .where('id', '=', s.key.id)
            .execute()
        } finally {
          await database.pool.query('ALTER TABLE auth.apikey ENABLE TRIGGER api_key_scope_guard')
        }
        return
      }
      await db
        .updateTable('auth.apikey')
        .set(
          change === 'expired'
            ? { expiresAt: new Date(s.now) }
            : change === 'owner'
              ? { referenceId: other.user.id }
              : change === 'legacy organization'
                ? { metadata: JSON.stringify({ scope: 'full' }) }
                : {
                    metadata: JSON.stringify({
                      organizationId: other.organization.id,
                      scope: 'full',
                    }),
                  },
        )
        .where('id', '=', s.key.id)
        .execute()
    })
    // An organization-free key must not keep authority in a stale non-personal organization.
    if (change === 'legacy organization') {
      const team = await createTestTeam(db, [
        { user: { ...s.owner.user, principal: s.owner }, role: 'owner' },
      ])
      await db
        .updateTable('auth.apikey')
        .set({ metadata: JSON.stringify({ organizationId: team.id, scope: 'full' }) })
        .where('id', '=', s.key.id)
        .execute()
    }
    const response = await request(s, 'destination')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(await snapshot(s)).toEqual(before)
  })

  it('returns notFound when the resolved API-key user has been deleted', async () => {
    const s = await setup()
    const resolved = await createCallerResolver({ auth, db })(new Headers(s.headers))
    if (!resolved.ok) throw new Error('Synthetic key did not resolve')
    await db.deleteFrom('auth.user').where('id', '=', s.owner.user.id).execute()
    await expect(
      db.transaction().execute((trx) => lockUser(trx, resolved.principal, Date.now())),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'calendar_connection_not_found' })
  })

  it('accepts uppercase UUID metadata in the same organization', async () => {
    const s = await setup()
    await db
      .updateTable('auth.apikey')
      .set({
        metadata: JSON.stringify({
          organizationId: s.owner.organization.id.toUpperCase(),
          scope: 'full',
        }),
      })
      .where('id', '=', s.key.id)
      .execute()
    expect((await request(s, 'destination')).status).toBe(204)
  })

  it.each(['owner', 'key'] as const)(
    'checks expiration after waiting for the %s lock',
    async (locked) => {
      const s = await setup()
      const deadline = Date.now() + 60_000
      await db
        .updateTable('auth.apikey')
        .set({ expiresAt: new Date(deadline) })
        .where('id', '=', s.key.id)
        .execute()
      const before = await snapshot(s)
      const entered = Promise.withResolvers<void>()
      s.onLock((query) => {
        if (
          query.includes(`"name":"${locked === 'owner' ? 'user' : 'apikey'}"`) &&
          query.includes(locked === 'owner' ? 'ForUpdate' : 'ForShare')
        )
          entered.resolve()
      })
      const holder = await database.pool.connect()
      let pending: Promise<Response> | undefined
      try {
        s.afterResolve(async () => {
          await holder.query('BEGIN')
          if (locked === 'owner')
            await holder.query('SELECT id FROM auth."user" WHERE id = $1 FOR UPDATE', [
              s.owner.user.id,
            ])
          else await holder.query('SELECT id FROM auth.apikey WHERE id = $1 FOR UPDATE', [s.key.id])
        })
        pending = Promise.resolve(request(s, 'destination'))
        await entered.promise
        s.advanceClock(deadline)
        await holder.query('COMMIT')
        const response = await pending
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'unauthorized' })
        expect(await snapshot(s)).toEqual(before)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await pending
      }
    },
  )

  it.each([null, true])(
    'accepts enabled=%s legacy personal keys without expiration',
    async (enabled) => {
      const s = await setup()
      await db
        .updateTable('auth.apikey')
        .set({ enabled, expiresAt: null, metadata: JSON.stringify({ scope: 'full' }) })
        .where('id', '=', s.key.id)
        .execute()
      expect((await request(s, 'destination')).status).toBe(204)
    },
  )
})
