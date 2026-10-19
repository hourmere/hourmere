import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  authorizeZoomMeetings,
  beginZoomConnection,
  type ConferenceDeps,
  disconnectConference,
  finishZoomConnection,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { zoomScopes } from './zoom.ts'

const databaseUrl = process.env.DATABASE_URL
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe.skipIf(!databaseUrl)('Zoom provider phase races (real Postgres)', () => {
  let database: TestDatabase, db: Db
  let owner: Awaited<ReturnType<typeof conferenceTestSession>>
  let provider: ReturnType<typeof fakeZoom>, deps: ConferenceDeps
  const gates: ReturnType<typeof deferred>[] = []
  const pending: Promise<unknown>[] = []

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
  })
  beforeEach(async () => {
    owner = await conferenceTestSession(db)
    provider = fakeZoom()
    provider.controls.identity.id = `synthetic-${owner.user.id}`
    deps = withProvider(provider)
  })
  afterEach(async () => {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled(pending)
    gates.length = 0
    pending.length = 0
  })
  afterAll(async () => {
    await database?.drop()
  })

  function withProvider(client: ReturnType<typeof fakeZoom>): ConferenceDeps {
    return {
      db,
      zoom: { client: client.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
    }
  }
  function replacementProvider(refreshToken = 'synthetic-new-refresh') {
    const replacement = fakeZoom()
    replacement.controls.identity = { ...provider.controls.identity }
    replacement.controls.token.refresh_token = refreshToken
    return replacement
  }
  function observe<T>(promise: Promise<T>) {
    const observed = promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    pending.push(observed)
    return observed
  }
  async function progresses(promise: Promise<unknown>) {
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
  function pause(phase: 'token' | 'identity') {
    const entered = deferred(),
      release = deferred(),
      response = structuredClone(
        phase === 'token' ? provider.controls.token : provider.controls.identity,
      )
    let status = 200
    gates.push(release)
    const hook = async () => {
      entered.resolve()
      await release.promise
      return Response.json(response, { status })
    }
    if (phase === 'token') provider.controls.tokenHook = hook
    else provider.controls.identityHook = hook
    return {
      entered: entered.promise,
      release: (responseStatus = 200) => {
        status = responseStatus
        release.resolve()
      },
    }
  }
  function query(state: string) {
    return new URLSearchParams({ state, code: 'synthetic-code' })
  }
  async function start(id?: string) {
    const authorization = await beginZoomConnection(deps, owner, id)
    return new URL(authorization.authorizationUrl).searchParams.get('state') as string
  }
  async function connect() {
    expect(await finishZoomConnection(deps, owner, query(await start()))).toBe('connected')
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('user_id', '=', owner.user.id)
      .executeTakeFirstOrThrow()
  }
  function row(id: string) {
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  it('rejects a replay while its one-use exchange remains in flight', async () => {
    const state = await start(),
      gate = pause('token'),
      first = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    const replay = observe(finishZoomConnection(deps, owner, query(state)))
    expect(await progresses(replay)).toBe(true)
    expect(await replay).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    expect(provider.calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
    gate.release()
    expect(await first).toEqual({ status: 'fulfilled', value: 'connected' })
  })

  it.each(['token', 'identity'] as const)(
    'disconnect completes during callback %s I/O and prevents credential resurrection',
    async (phase) => {
      const initial = await connect(),
        state = await start(initial.id),
        gate = pause(phase),
        finishing = observe(finishZoomConnection(deps, owner, query(state)))
      await gate.entered
      const disconnecting = observe(disconnectConference(deps, owner, initial.id))
      expect(await progresses(disconnecting)).toBe(true)
      expect((await disconnecting).status).toBe('fulfilled')
      gate.release()
      expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
      expect(await row(initial.id)).toMatchObject({
        status: 'disconnected',
        credentials: null,
        operation_id: null,
      })
      expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
    },
  )

  it('logout completes during callback I/O and invalidates the claimed state', async () => {
    const state = await start(),
      gate = pause('token'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    const logout = observe(
      db.deleteFrom('auth.session').where('id', '=', owner.sessionId).execute(),
    )
    expect(await progresses(logout)).toBe(true)
    expect((await logout).status).toBe('fulfilled')
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    expect(
      await db
        .selectFrom('conference_connections')
        .select('id')
        .where('user_id', '=', owner.user.id)
        .execute(),
    ).toHaveLength(0)
  })

  it('session expiry during callback I/O rejects an otherwise live claimed state', async () => {
    const state = await start(),
      gate = pause('identity'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    const expiry = observe(
      db
        .updateTable('auth.session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', owner.sessionId)
        .execute(),
    )
    expect(await progresses(expiry)).toBe(true)
    expect((await expiry).status).toBe('fulfilled')
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    expect(
      await db
        .selectFrom('conference_connections')
        .select('id')
        .where('user_id', '=', owner.user.id)
        .execute(),
    ).toHaveLength(0)
  })

  it.each(['expiry', 'mode', 'connection', 'claim'] as const)(
    'rechecks state %s after callback I/O without overwriting unchanged credentials',
    async (change) => {
      const initial = await connect(),
        state = await start(),
        gate = pause('identity'),
        finishing = observe(finishZoomConnection(deps, owner, query(state)))
      await gate.entered
      const changes = {
          expiry: { expires_at: new Date(0) },
          mode: { mode: 'meetings' },
          connection: { connection_id: initial.id },
          claim: { claimed: false, verifier: Buffer.alloc(32) },
        },
        updating = observe(
          db
            .updateTable('conference_oauth_states')
            .set(changes[change])
            .where('user_id', '=', owner.user.id)
            .execute(),
        )
      expect(await progresses(updating)).toBe(true)
      expect((await updating).status).toBe('fulfilled')
      gate.release()
      expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
      const current = await row(initial.id)
      expect(current.status).toBe('active')
      expect(current.credentials?.equals(initial.credentials as Buffer)).toBe(true)
    },
  )

  it('a meetings upgrade supersedes an older same-connection callback during I/O', async () => {
    const initial = await connect(),
      state = await start(initial.id),
      gate = pause('token'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    const authorizing = observe(authorizeZoomMeetings(deps, owner, initial.id))
    expect(await progresses(authorizing)).toBe(true)
    const authorization = await authorizing
    expect(authorization.status).toBe('fulfilled')
    if (authorization.status !== 'fulfilled') throw new Error('Expected meetings authorization')
    const newerState = new URL(authorization.value.authorizationUrl).searchParams.get(
        'state',
      ) as string,
      replacement = replacementProvider()
    replacement.controls.token.scope = zoomScopes('meetings').join(' ')
    expect(await finishZoomConnection(withProvider(replacement), owner, query(newerState))).toBe(
      'connected',
    )
    const upgraded = await row(initial.id)
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    const current = await row(initial.id)
    expect(current.mode).toBe('meetings')
    expect(current.status).toBe('active')
    expect(current.credentials?.equals(upgraded.credentials as Buffer)).toBe(true)
  })

  it('an unbound callback cannot overwrite credentials refreshed during its provider I/O', async () => {
    const initial = await connect(),
      state = await start(),
      gate = pause('identity'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    const replacement = replacementProvider(),
      refreshing = observe(refreshConference(withProvider(replacement), owner, initial.id))
    expect(await progresses(refreshing)).toBe(true)
    expect((await refreshing).status).toBe('fulfilled')
    const refreshed = await row(initial.id)
    expect(refreshed.credentials?.equals(initial.credentials as Buffer)).toBe(false)
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    const current = await row(initial.id)
    expect(current.status).toBe('active')
    expect(current.credentials?.equals(refreshed.credentials as Buffer)).toBe(true)
  })

  it.each(['token', 'identity'] as const)(
    'disconnect completes during refresh %s I/O without restoring retired credentials',
    async (phase) => {
      const initial = await connect(),
        gate = pause(phase),
        refreshing = observe(refreshConference(deps, owner, initial.id))
      await gate.entered
      expect(await row(initial.id)).toMatchObject({ status: 'refreshing', credentials: null })
      const disconnecting = observe(disconnectConference(deps, owner, initial.id))
      expect(await progresses(disconnecting)).toBe(true)
      expect((await disconnecting).status).toBe('fulfilled')
      gate.release()
      expect((await refreshing).status).toBe('rejected')
      expect(await row(initial.id)).toMatchObject({
        status: 'disconnected',
        credentials: null,
        operation_id: null,
      })
    },
  )

  it('reconnection completes during refresh I/O and the old operation preserves its new grant', async () => {
    const initial = await connect(),
      gate = pause('token'),
      refreshing = observe(refreshConference(deps, owner, initial.id))
    await gate.entered
    const authorizing = observe(beginZoomConnection(deps, owner, initial.id))
    expect(await progresses(authorizing)).toBe(true)
    const authorization = await authorizing
    expect(authorization.status).toBe('fulfilled')
    if (authorization.status !== 'fulfilled') throw new Error('Expected reconnection authorization')
    const state = new URL(authorization.value.authorizationUrl).searchParams.get('state') as string,
      replacement = replacementProvider()
    expect(await finishZoomConnection(withProvider(replacement), owner, query(state))).toBe(
      'connected',
    )
    const reconnected = await row(initial.id)
    gate.release()
    expect((await refreshing).status).toBe('rejected')
    const current = await row(initial.id)
    expect(current.status).toBe('active')
    expect(current.operation_id).toBeNull()
    expect(current.credentials?.equals(reconnected.credentials as Buffer)).toBe(true)
  })

  it('logout completes during refresh I/O without persisting its rotated grant', async () => {
    const initial = await connect(),
      gate = pause('token'),
      refreshing = observe(refreshConference(deps, owner, initial.id))
    await gate.entered
    const logout = observe(
      db.deleteFrom('auth.session').where('id', '=', owner.sessionId).execute(),
    )
    expect(await progresses(logout)).toBe(true)
    expect((await logout).status).toBe('fulfilled')
    gate.release()
    expect((await refreshing).status).toBe('rejected')
    expect((await row(initial.id)).credentials).toBeNull()
  })

  it('session expiry during refresh I/O clears its claimed grant without restoring access', async () => {
    const initial = await connect(),
      gate = pause('identity'),
      refreshing = observe(refreshConference(deps, owner, initial.id))
    await gate.entered
    const expiry = observe(
      db
        .updateTable('auth.session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', owner.sessionId)
        .execute(),
    )
    expect(await progresses(expiry)).toBe(true)
    expect((await expiry).status).toBe('fulfilled')
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(await row(initial.id)).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
    })
  })

  it('an obsolete refresh preserves a newer operation claim in the same status', async () => {
    const initial = await connect(),
      gate = pause('identity'),
      refreshing = observe(refreshConference(deps, owner, initial.id))
    await gate.entered
    const operation = randomUUID(),
      claiming = observe(
        db
          .updateTable('conference_connections')
          .set({ operation_id: operation })
          .where('id', '=', initial.id)
          .execute(),
      )
    expect(await progresses(claiming)).toBe(true)
    expect((await claiming).status).toBe('fulfilled')
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(await row(initial.id)).toMatchObject({
      status: 'refreshing',
      credentials: null,
      operation_id: operation,
    })
  })

  it.each(['external identity', 'mode'] as const)(
    'a refresh cannot restore credentials after its %s changes under the same operation',
    async (change) => {
      const initial = await connect(),
        gate = pause('token'),
        refreshing = observe(refreshConference(deps, owner, initial.id))
      await gate.entered
      const claim = await row(initial.id),
        changes = {
          'external identity': { external_user_id: `synthetic-new-${randomUUID()}` },
          mode: { mode: 'meetings', scopes: zoomScopes('meetings') },
        },
        updating = observe(
          db
            .updateTable('conference_connections')
            .set(changes[change])
            .where('id', '=', initial.id)
            .execute(),
        )
      expect(await progresses(updating)).toBe(true)
      expect((await updating).status).toBe('fulfilled')
      // A retryable token failure may restore the prior grant only for the same claim.
      gate.release(503)
      const outcome = await refreshing,
        current = await row(initial.id)
      expect(current.credentials === null).toBe(true)
      expect(current).toMatchObject({
        status: 'refreshing',
        operation_id: claim.operation_id,
        ...changes[change],
      })
      expect(outcome).toMatchObject({
        status: 'rejected',
        error: { code: 'zoom_needs_reauth' },
      })
    },
  )

  it.each(['token', 'identity'] as const)(
    'provider %s failure consumes state without writing partial credentials',
    async (phase) => {
      const state = await start(),
        gate = pause(phase),
        finishing = observe(finishZoomConnection(deps, owner, query(state)))
      await gate.entered
      // Return a provider error only after proving the durable claim is already one-use.
      const replay = observe(finishZoomConnection(deps, owner, query(state)))
      expect(await progresses(replay)).toBe(true)
      expect(await replay).toEqual({ status: 'fulfilled', value: 'invalid_state' })
      gate.release(503)
      expect(await finishing).toEqual({ status: 'fulfilled', value: 'provider_unavailable' })
      expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
      expect(
        await db
          .selectFrom('conference_connections')
          .select('id')
          .where('user_id', '=', owner.user.id)
          .execute(),
      ).toHaveLength(0)
    },
  )
})
