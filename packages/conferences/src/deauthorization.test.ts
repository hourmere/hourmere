import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType, updateEventType } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { deauthorizeZoomConnections } from './deauthorization.ts'
import {
  authorizeZoomMeetings,
  beginZoomConnection,
  type ConferenceDeps,
  finishZoomConnection,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { zoomScopes } from './zoom.ts'

const serverUrl = process.env.DATABASE_URL
const removedIdentity = {
  userId: 'removed-zoom-user',
  accountId: 'shared-zoom-account',
  deauthorizationTime: '2100-01-01T00:00:00Z',
}
function barrier<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function completes(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('Zoom deauthorization identity validation', () => {
  it.each([
    { userId: '', accountId: 'account' },
    { userId: 'bad user', accountId: 'account' },
    { userId: 'x'.repeat(129), accountId: 'account' },
    { userId: 'user', accountId: '' },
    { userId: 'user', accountId: 'bad account' },
    { userId: 'user', accountId: 'x'.repeat(129) },
  ])('rejects malformed identity before accessing storage: %#', async (identity) => {
    await expect(
      deauthorizeZoomConnections(
        { db: {} as Db },
        { ...identity, deauthorizationTime: removedIdentity.deauthorizationTime },
      ),
    ).resolves.toBeUndefined()
  })
})

describe.skipIf(!serverUrl)('Zoom deauthorization cleanup (real Postgres)', () => {
  let database: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    other: typeof owner,
    teamOwner: typeof owner,
    provider: ReturnType<typeof fakeZoom>,
    deps: ConferenceDeps
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
    owner = await conferenceTestSession(db)
    other = await conferenceTestSession(db)
    const teamId = await createFixtures(db).organization('zoom-deauthorization-team')
    await createFixtures(db).member(owner.user.id, teamId, 'owner')
    teamOwner = {
      ...owner,
      organization: {
        id: teamId,
        name: 'Zoom team',
        slug: 'zoom-deauthorization-team',
        personal: false,
      },
    }
  })
  beforeEach(async () => {
    await db.deleteFrom('event_types').execute()
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    provider = fakeZoom()
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    deps = {
      db,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
    }
  })
  afterAll(async () => {
    await database?.drop()
  })
  async function connect(userId: string, principal = owner) {
    provider.controls.identity.id = userId
    provider.controls.identity.account_id = removedIdentity.accountId
    const url = new URL((await authorizeZoomMeetings(deps, principal)).authorizationUrl)
    expect(
      await finishZoomConnection(
        deps,
        principal,
        new URLSearchParams({
          state: url.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('external_user_id', '=', userId)
      .executeTakeFirstOrThrow()
  }
  function event(slug: string, connectionId: string, principal = owner) {
    return createEventType(
      { db, principal, automaticZoom: true, now: () => Temporal.Now.instant() },
      {
        slug,
        title: slug,
        durationMinutes: 30,
        location: { kind: 'zoom', autoCreate: true },
        zoomConnectionId: connectionId,
      },
    )
  }
  const row = (id: string) =>
    db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const setting = (id: string) =>
    db.selectFrom('event_types').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it.each(['active', 'refreshing'] as const)(
    'clears existing %s credentials, refresh claims, errors and identity metadata',
    async (status) => {
      const connection = await connect(removedIdentity.userId)
      await db
        .updateTable('conference_connections')
        .set({
          status,
          credentials: status === 'active' ? connection.credentials : null,
          operation_id: status === 'refreshing' ? randomUUID() : null,
          last_error: 'provider_unavailable',
        })
        .where('id', '=', connection.id)
        .execute()
      const seeded = await row(connection.id)
      expect(seeded.operation_id !== null).toBe(status === 'refreshing')
      expect(seeded.credentials !== null).toBe(status === 'active')
      expect(seeded.last_error).toBe('provider_unavailable')

      await expect(deauthorizeZoomConnections({ db }, removedIdentity)).resolves.toBeUndefined()

      expect(await row(connection.id)).toMatchObject({
        credentials: null,
        operation_id: null,
        last_error: null,
        external_user_id: null,
        account_email: null,
        display_name: null,
        scopes: [],
        status: 'disconnected',
      })
    },
  )

  it('erases only the matching Zoom user and preserves its event settings like local disconnect', async () => {
    const removed = await connect(removedIdentity.userId)
    const sameOwner = await connect('another-zoom-user')
    const sameAccount = await connect('another-owner-zoom-user', other)
    const affected = await event('removed', removed.id)
    const unaffected = await event('other-identity', sameOwner.id)
    const otherUserEvent = await event('other-user', sameAccount.id, other)
    const inactive = await event('already-inactive', removed.id)
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', inactive.id)
      .execute()
    const passive = await event('passive', removed.id)
    await updateEventType({ db, principal: owner, now: () => Temporal.Now.instant() }, passive.id, {
      location: { kind: 'zoom' },
    })
    await beginZoomConnection(deps, owner)
    await beginZoomConnection(deps, other)
    const otherAttempts = await db
      .selectFrom('conference_oauth_states')
      .selectAll()
      .where('user_id', '=', other.user.id)
      .execute()
    const unchanged = await Promise.all(
      [unaffected, otherUserEvent, inactive, passive].map((value) => setting(value.id)),
    )
    const calls = provider.calls.length
    const originalAffected = await setting(affected.id)

    // Cleanup needs only storage; it still works after operator disables OAuth.
    await deauthorizeZoomConnections({ db }, removedIdentity)

    expect(await row(removed.id)).toMatchObject({
      user_id: owner.user.id,
      external_user_id: null,
      account_email: null,
      display_name: null,
      credentials: null,
      operation_id: null,
      scopes: [],
      status: 'disconnected',
      last_error: null,
    })
    expect(await row(sameOwner.id)).toEqual(sameOwner)
    expect(await row(sameAccount.id)).toEqual(sameAccount)
    expect(await setting(affected.id)).toEqual(originalAffected)
    expect(
      await Promise.all(
        [unaffected, otherUserEvent, inactive, passive].map((value) => setting(value.id)),
      ),
    ).toEqual(unchanged)
    expect(
      await db
        .selectFrom('conference_oauth_states')
        .selectAll()
        .where('user_id', '=', owner.user.id)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('conference_oauth_states')
        .selectAll()
        .where('user_id', '=', other.user.id)
        .execute(),
    ).toEqual(otherAttempts)
    expect(provider.calls).toHaveLength(calls)
  })

  it('treats unknown users and duplicate notifications as no-ops, including timestamps', async () => {
    const connection = await connect(removedIdentity.userId)
    await event('removed', connection.id)
    const original = await row(connection.id)
    const originalEvents = await db.selectFrom('event_types').selectAll().execute()
    await deauthorizeZoomConnections({ db }, { ...removedIdentity, userId: 'unknown-zoom-user' })
    expect(await row(connection.id)).toEqual(original)
    expect(await db.selectFrom('event_types').selectAll().execute()).toEqual(originalEvents)
    await deauthorizeZoomConnections({ db }, removedIdentity)
    const disconnected = await row(connection.id)
    const events = await db.selectFrom('event_types').selectAll().execute()
    await deauthorizeZoomConnections({ db }, removedIdentity)
    expect(await row(connection.id)).toEqual(disconnected)
    expect(await db.selectFrom('event_types').selectAll().execute()).toEqual(events)
  })

  it('rechecks identity after acquiring the owner lock for concurrent duplicate deliveries', async () => {
    const connection = await connect(removedIdentity.userId)
    const discovered = barrier(),
      release = barrier()
    let first = true
    const paused = db.withPlugin({
      transformQuery(args) {
        return args.node
      },
      async transformResult(args) {
        if (first) {
          first = false
          discovered.resolve()
          await release.promise
        }
        return args.result
      },
    })
    const duplicate = deauthorizeZoomConnections({ db: paused }, removedIdentity)
    await discovered.promise
    try {
      await deauthorizeZoomConnections({ db }, removedIdentity)
      const disconnected = await database.pool.query<{ updated: string }>(
        'SELECT updated_at::text AS updated FROM conference_connections WHERE id=$1',
        [connection.id],
      )
      release.resolve()
      await duplicate
      const after = await database.pool.query<{ updated: string }>(
        'SELECT updated_at::text AS updated FROM conference_connections WHERE id=$1',
        [connection.id],
      )
      expect(after.rows).toEqual(disconnected.rows)
    } finally {
      release.resolve()
      await duplicate
    }
  })

  it('invalidates a pending reconnect before it can exchange an OAuth code', async () => {
    const connection = await connect(removedIdentity.userId)
    const pending = new URL(
      (await beginZoomConnection(deps, owner, connection.id)).authorizationUrl,
    )
    const calls = provider.calls.length
    await deauthorizeZoomConnections({ db }, removedIdentity)
    expect(
      await finishZoomConnection(
        deps,
        owner,
        new URLSearchParams({
          state: pending.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('invalid_state')
    expect(provider.calls).toHaveLength(calls)
    expect((await row(connection.id)).external_user_id).toBeNull()
  })

  it('completes during an in-flight refresh and prevents credential resurrection', async () => {
    const connection = await connect(removedIdentity.userId)
    const entered = barrier(),
      release = barrier<Response>()
    provider.controls.tokenHook = async () => {
      entered.resolve()
      return release.promise
    }
    const refreshing = refreshConference(deps, owner, connection.id).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    await entered.promise
    const cleanup = deauthorizeZoomConnections({ db }, removedIdentity)
    let cleared: Awaited<ReturnType<typeof row>> | undefined
    try {
      expect(await completes(cleanup)).toBe(true)
      cleared = await row(connection.id)
      expect(cleared).toMatchObject({
        status: 'disconnected',
        credentials: null,
        operation_id: null,
        external_user_id: null,
      })
    } finally {
      release.resolve(Response.json(provider.controls.token))
      await Promise.all([refreshing, cleanup])
    }
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(await row(connection.id)).toEqual(cleared)
  })

  for (const authorization of ['unbound', 'reconnect'] as const)
    it.each(['token', 'identity'] as const)(
      `completes during ${authorization} OAuth %s I/O and retires the claimed state`,
      async (phase) => {
        const connection = await connect(removedIdentity.userId)
        const pending = new URL(
          (
            await authorizeZoomMeetings(
              deps,
              owner,
              authorization === 'reconnect' ? connection.id : undefined,
            )
          ).authorizationUrl,
        )
        const entered = barrier(),
          release = barrier<Response>()
        const hook = async () => {
          entered.resolve()
          return release.promise
        }
        if (phase === 'token') provider.controls.tokenHook = hook
        else provider.controls.identityHook = hook
        const query = new URLSearchParams({
          state: pending.searchParams.get('state') as string,
          code: 'synthetic-code',
        })
        const finishing = finishZoomConnection(deps, owner, query)
        await entered.promise
        const cleanup = deauthorizeZoomConnections({ db }, removedIdentity)
        let cleared: Awaited<ReturnType<typeof row>> | undefined
        try {
          expect(await completes(cleanup)).toBe(true)
          cleared = await row(connection.id)
          expect(cleared).toMatchObject({
            status: 'disconnected',
            credentials: null,
            operation_id: null,
            external_user_id: null,
          })
          expect(
            await db
              .selectFrom('conference_oauth_states')
              .select('state_hash')
              .where('user_id', '=', owner.user.id)
              .execute(),
          ).toEqual([])
        } finally {
          release.resolve(
            Response.json(phase === 'token' ? provider.controls.token : provider.controls.identity),
          )
          await Promise.all([finishing, cleanup])
        }
        expect(await finishing).toBe('invalid_state')
        expect(await row(connection.id)).toEqual(cleared)
        expect(
          await db
            .selectFrom('conference_connections')
            .select('id')
            .where('user_id', '=', owner.user.id)
            .execute(),
        ).toEqual([{ id: connection.id }])
        expect(await finishZoomConnection(deps, owner, query)).toBe('invalid_state')
      },
    )

  it('retries concurrent settings edits without an owner/event lock deadlock', async () => {
    const connection = await connect(removedIdentity.userId)
    const affected = await event('team-removed', connection.id, teamOwner)
    const entered = barrier(),
      release = barrier()
    let queries = 0
    const paused = db.withPlugin({
      transformQuery(args) {
        return args.node
      },
      async transformResult(args) {
        // Initial candidate, owner lock, then locked identity recheck. Pause while
        // owner protection is held, before touching organization/event settings.
        if (++queries === 3) {
          entered.resolve()
          await release.promise
        }
        return args.result
      },
    })
    const cleanup = deauthorizeZoomConnections({ db: paused }, removedIdentity)
    await entered.promise
    const editing = updateEventType(
      { db, principal: teamOwner, now: () => Temporal.Now.instant() },
      affected.id,
      { title: 'Concurrent edit' },
    )
    try {
      await vi.waitFor(async () => {
        const result = await database.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked',
        )
        expect(result.rows[0]?.blocked).toBe(true)
      })
    } finally {
      release.resolve()
    }
    const outcomes = await Promise.allSettled([cleanup, editing])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(queries).toBeGreaterThan(3)
    expect(await setting(affected.id)).toMatchObject({ title: 'Concurrent edit', is_active: true })
    expect((await row(connection.id)).external_user_id).toBeNull()
  })

  it('allows booking foreign-key inserts while holding automatic event settings locks', async () => {
    const connection = await connect(removedIdentity.userId)
    const affected = await event('booking-key-share', connection.id)
    const entered = barrier(),
      release = barrier()
    let queries = 0
    const paused = db.withPlugin({
      transformQuery(args) {
        return args.node
      },
      async transformResult(args) {
        // Candidate, owner, connection, event discovery, organization, event lock.
        // Hold the event lock while a booking insert checks its composite FK.
        if (++queries === 6) {
          entered.resolve()
          await release.promise
        }
        return args.result
      },
    })
    const cleanup = deauthorizeZoomConnections({ db: paused }, removedIdentity)
    await entered.promise
    const inserting = createFixtures(db).booking(
      owner.organization.id,
      [],
      '2026-11-01T12:00:00Z',
      '2026-11-01T12:30:00Z',
      { eventTypeId: affected.id, attendee: null },
    )
    try {
      expect(await completes(inserting)).toBe(true)
      const id = await inserting
      expect(
        await db
          .selectFrom('bookings')
          .select('event_type_id')
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ event_type_id: affected.id })
    } finally {
      release.resolve()
      const [, id] = await Promise.all([cleanup, inserting])
      await db.deleteFrom('bookings').where('id', '=', id).execute()
    }
    expect((await row(connection.id)).external_user_id).toBeNull()
    expect((await setting(affected.id)).is_active).toBe(true)
  })

  it('bounds contention retries and rolls back without erasing or changing settings', async () => {
    const connection = await connect(removedIdentity.userId)
    const affected = await event('contended', connection.id)
    const before = await setting(affected.id)
    const blocker = await database.pool.connect()
    let attempts = 0
    const counted = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return () => {
            attempts++
            return target.transaction()
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM event_types WHERE id=$1 FOR UPDATE', [affected.id])
      await expect(
        deauthorizeZoomConnections({ db: counted }, removedIdentity),
      ).rejects.toMatchObject({
        code: '55P03',
      })
      expect(attempts).toBe(3)
      expect(await row(connection.id)).toEqual(connection)
      expect(await setting(affected.id)).toEqual(before)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
  })
})
