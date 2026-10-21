import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { ConferenceWork } from '@hourmere/scheduling/conferences'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { conferenceEncryptionKey } from './credentials.ts'
import {
  authorizeZoomMeetings,
  type ConferenceDeps,
  disconnectConference,
  finishZoomConnection,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { credentials, readTokens } from './tokens.ts'
import { createZoomConferenceWork } from './worker.ts'
import { zoomScopes } from './zoom.ts'

const databaseUrl = process.env.DATABASE_URL,
  now = Date.parse('2030-11-03T12:00Z')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe.skipIf(!databaseUrl)('Zoom worker unlocked provider phases (real Postgres)', () => {
  let database: TestDatabase,
    requestPool: pg.Pool,
    db: Db,
    requestDb: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    provider: ReturnType<typeof fakeZoom>,
    deps: ConferenceDeps,
    c: ConferenceWork
  const releases: ReturnType<typeof deferred>[] = [],
    pending: Promise<unknown>[] = []
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    // An accidentally retained row lock fails an assertion instead of hanging the test.
    requestPool = new pg.Pool({
      connectionString: database.url,
      max: 1,
      options: '-c lock_timeout=1000',
    })
    requestDb = createDb(requestPool)
  })
  beforeEach(async () => {
    owner = await conferenceTestSession(db)
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2035-01-01Z') })
      .where('id', '=', owner.sessionId)
      .execute()
    provider = fakeZoom('http://localhost:5173', () => now)
    provider.controls.identity.id = `synthetic-${owner.user.id}`
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    deps = {
      db,
      now: () => now,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
    }
    const auth = new URL((await authorizeZoomMeetings(deps, owner)).authorizationUrl)
    expect(
      await finishZoomConnection(
        deps,
        owner,
        new URLSearchParams({ state: auth.searchParams.get('state') as string, code: 'fake' }),
      ),
    ).toBe('connected')
    const row = await db
      .selectFrom('conference_connections')
      .select('id')
      .where('user_id', '=', owner.user.id)
      .executeTakeFirstOrThrow()
    c = {
      rootBookingId: randomUUID(),
      organizerUserId: owner.user.id,
      connectionId: row.id,
      externalUserId: provider.controls.identity.id as string,
      meetingId: null,
      create: true,
      createStarted: true,
      booking: {
        title: 'Synthetic worker meeting',
        start_at: new Date('2030-11-04T09:00Z'),
        end_at: new Date('2030-11-04T09:30Z'),
        status: 'confirmed',
      },
    }
    provider.calls.length = 0
  })
  afterEach(async () => {
    for (const release of releases) release.resolve()
    await Promise.allSettled(pending)
    releases.length = 0
    pending.length = 0
  })
  afterAll(async () => {
    await requestPool?.end()
    await database?.drop()
  })
  const row = () =>
    db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', c.connectionId as string)
      .executeTakeFirstOrThrow()
  async function expire() {
    const value = credentials(
      conferenceEncryptionKey(TEST_CONFERENCE_KEY),
      owner.user.id,
      c.connectionId as string,
      c.externalUserId as string,
      {
        accessToken: 'synthetic-expired',
        refreshToken: 'synthetic-old-refresh',
        expiresAt: now - 1,
        scopes: zoomScopes('meetings'),
      },
      'meetings',
    )
    await db
      .updateTable('conference_connections')
      .set({ credentials: value })
      .where('id', '=', c.connectionId as string)
      .execute()
  }
  function pause(stage: 'refresh' | 'identity' | 'meeting', status = 200) {
    const entered = deferred(),
      release = deferred()
    releases.push(release)
    const hook = async () => {
      entered.resolve()
      await release.promise
      return Response.json(
        stage === 'refresh'
          ? provider.controls.token
          : stage === 'identity'
            ? provider.controls.identity
            : {
                id: 81234567890,
                host_id: c.externalUserId,
                type: 2,
                join_url: 'https://zoom.us/j/81234567890',
                start_time: new Date(
                  c.booking.start_at.getTime() - (c.meetingId ? 3600000 : 0),
                ).toISOString(),
                duration: 30,
              },
        { status },
      )
    }
    if (stage === 'refresh') provider.controls.tokenHook = hook
    else if (stage === 'identity') provider.controls.identityHook = hook
    else provider.controls.meetingHook = hook
    return { entered: entered.promise, release: release.resolve }
  }
  function run(custom = deps) {
    const promise = createZoomConferenceWork(custom, provider.meetings)(
      c,
      AbortSignal.timeout(10000),
    )
    pending.push(promise)
    return promise
  }
  const meetingCalls = () => provider.calls.filter((call) => call.url.includes('/meetings'))

  it('retires a crashed refresh after taking over its expired token lease', async () => {
    const abandoned = randomUUID()
    await db
      .updateTable('conference_connections')
      .set({ status: 'refreshing', credentials: null, operation_id: abandoned })
      .where('id', '=', c.connectionId as string)
      .execute()
    await db
      .insertInto('conference_token_operations')
      .values({ user_id: owner.user.id, operation_id: abandoned, expires_at: new Date(0) })
      .execute()

    expect(await run()).toMatchObject({ error: 'needs_reauth' })
    expect(await row()).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
      last_error: 'needs_reauth',
    })
    expect(provider.calls).toHaveLength(0)
  })

  it('preserves a refreshing claim while another worker owns its live token lease', async () => {
    await expire()
    const gate = pause('refresh'),
      running = run()
    await gate.entered
    const original = await row()

    expect(await run()).toMatchObject({ error: 'provider_unavailable' })
    expect(await row()).toMatchObject({
      status: 'refreshing',
      credentials: null,
      operation_id: original.operation_id,
      last_error: null,
    })
    expect(provider.calls).toHaveLength(1)
    gate.release()
    expect(await running).toMatchObject({ meetingId: '81234567890' })
    expect(await row()).toMatchObject({ status: 'active', operation_id: null })
  })

  for (const stage of ['refresh', 'identity', 'meeting'] as const)
    for (const action of ['disconnect', 'delete owner'] as const)
      it(`allows ${action} to commit while worker ${stage} is blocked`, async () => {
        if (stage === 'refresh') await expire()
        const gate = pause(stage),
          running = run()
        await gate.entered
        if (action === 'disconnect')
          await expect(
            disconnectConference({ ...deps, db: requestDb }, owner, c.connectionId as string),
          ).resolves.toBeUndefined()
        else
          await expect(
            requestDb.deleteFrom('auth.user').where('id', '=', owner.user.id).execute(),
          ).resolves.toHaveLength(1)
        expect(await row()).toMatchObject({ status: 'disconnected', credentials: null })
        gate.release()
        expect(await running).toMatchObject({
          error: 'needs_reauth',
          ...(stage === 'meeting' && { meetingId: '81234567890' }),
        })
        expect(await row()).toMatchObject({ status: 'disconnected', credentials: null })
        expect(meetingCalls()).toHaveLength(stage === 'meeting' ? 1 : 0)
      })

  for (const action of ['cancel', 'reschedule'] as const)
    it(`checks the connection after meeting lookup before ${action}`, async () => {
      c.meetingId = '81234567890'
      c.create = false
      if (action === 'cancel') c.booking.status = 'cancelled'
      const gate = pause('meeting'),
        running = run()
      await gate.entered
      await disconnectConference({ ...deps, db: requestDb }, owner, c.connectionId as string)
      gate.release()
      expect(await running).toMatchObject({ error: 'needs_reauth' })
      expect(meetingCalls()).toHaveLength(1)
      expect(meetingCalls()[0]?.init.method).toBe('GET')
    })

  function afterCommit(db: Db, hook: () => Promise<void>): Db {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'connection')
          return () => ({
            execute: (body: (db: Db) => Promise<unknown>) =>
              target.connection().execute((connection) => body(afterCommit(connection, hook))),
          })
        if (property === 'transaction')
          return () => ({
            execute: async (body: (db: Db) => Promise<unknown>) => {
              const value = await target.transaction().execute(body)
              await hook()
              return value
            },
          })
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Db
  }

  it('preserves an abandoned refresh if its newly acquired lease is lost before recovery', async () => {
    const abandoned = randomUUID()
    await db
      .updateTable('conference_connections')
      .set({ status: 'refreshing', credentials: null, operation_id: abandoned })
      .where('id', '=', c.connectionId as string)
      .execute()
    let lost = false
    const observed = afterCommit(db, async () => {
      if (lost) return
      const lease = await db
        .selectFrom('conference_token_operations')
        .select('operation_id')
        .where('user_id', '=', owner.user.id)
        .executeTakeFirst()
      if (!lease) return
      lost = true
      await requestDb
        .updateTable('conference_token_operations')
        .set({ expires_at: new Date(0) })
        .where('user_id', '=', owner.user.id)
        .execute()
    })

    expect(await run({ ...deps, db: observed })).toMatchObject({ error: 'provider_unavailable' })
    expect(lost).toBe(true)
    expect(await row()).toMatchObject({
      status: 'refreshing',
      credentials: null,
      operation_id: abandoned,
      last_error: null,
    })
    expect(provider.calls).toHaveLength(0)
  })

  it('checks refresh ownership again before contacting the rotating endpoint', async () => {
    await expire()
    let invalidated = false
    const observed = afterCommit(db, async () => {
      if (invalidated || (await row()).status !== 'refreshing') return
      invalidated = true
      await requestDb
        .updateTable('conference_connections')
        .set({ status: 'needs_reauth', operation_id: null })
        .where('id', '=', c.connectionId as string)
        .execute()
    })
    expect(await run({ ...deps, db: observed })).toMatchObject({ error: 'needs_reauth' })
    expect(invalidated).toBe(true)
    expect(provider.calls).toHaveLength(0)
  })

  for (const phase of ['before connection claim', 'after connection claim'] as const)
    it(`checks the token lease ${phase} before contacting Zoom`, async () => {
      await expire()
      let invalidated = false
      const observed = afterCommit(db, async () => {
        if (invalidated) return
        const lease = await db
          .selectFrom('conference_token_operations')
          .select('operation_id')
          .where('user_id', '=', owner.user.id)
          .executeTakeFirst()
        const status = (await row()).status
        if (!lease || (status === 'refreshing') !== (phase === 'after connection claim')) return
        invalidated = true
        await requestDb
          .deleteFrom('conference_token_operations')
          .where('user_id', '=', owner.user.id)
          .execute()
      })
      expect(await run({ ...deps, db: observed })).toMatchObject({
        error: phase === 'before connection claim' ? 'provider_unavailable' : 'needs_reauth',
      })
      expect(invalidated).toBe(true)
      expect(provider.calls).toHaveLength(0)
      expect(await row()).toMatchObject({
        status: phase === 'before connection claim' ? 'active' : 'refreshing',
      })
    })

  it('passes the configured token-operation deadline into the worker refresh signal', async () => {
    await expire()
    const deadline = new AbortController(),
      entered = deferred(),
      release = deferred(),
      nativeTimeout = AbortSignal.timeout.bind(AbortSignal),
      timeouts = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => (ms === 4321 ? deadline.signal : nativeTimeout(ms)))
    releases.push(release)
    let observedSignal: AbortSignal | undefined
    provider.controls.tokenHook = async (init) => {
      observedSignal = init.signal ?? undefined
      entered.resolve()
      await release.promise
      return Response.json(provider.controls.token)
    }
    try {
      const running = run({ ...deps, timeoutMs: 4321 })
      await entered.promise
      deadline.abort(new DOMException('Synthetic token-operation deadline', 'TimeoutError'))
      expect(observedSignal?.aborted).toBe(true)
      expect(await running).toMatchObject({ error: 'provider_unavailable' })
      expect(await row()).toMatchObject({ status: 'active' })
      expect(meetingCalls()).toHaveLength(0)
    } finally {
      timeouts.mockRestore()
    }
  })

  it('discards a refresh result after its token lease expires without changing the connection claim', async () => {
    await expire()
    const gate = pause('refresh'),
      running = run()
    await gate.entered
    await requestDb
      .updateTable('conference_token_operations')
      .set({ expires_at: new Date(0) })
      .where('user_id', '=', owner.user.id)
      .execute()
    gate.release()
    expect(await running).toMatchObject({ error: 'needs_reauth' })
    expect(await row()).toMatchObject({ status: 'refreshing', credentials: null })
    expect(meetingCalls()).toHaveLength(0)
  })

  it('recovers on the next attempt when the lease expires after a successful refresh response', async () => {
    await expire()
    let responseReturned = false,
      expired = false
    provider.controls.tokenHook = async () => {
      responseReturned = true
      return Response.json(provider.controls.token)
    }
    const observed = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction')
          return () => ({
            execute: async (body: (db: Db) => Promise<unknown>) => {
              // Model a stalled database between the successful response and the
              // credential transaction, without waiting for the real lease clock.
              if (responseReturned && !expired) {
                expired = true
                await requestDb
                  .updateTable('conference_token_operations')
                  .set({ expires_at: new Date(0) })
                  .where('user_id', '=', owner.user.id)
                  .execute()
              }
              return target.transaction().execute(body)
            },
          })
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Db

    expect(await run({ ...deps, db: observed })).toMatchObject({ error: 'needs_reauth' })
    expect(expired).toBe(true)
    expect(await row()).toMatchObject({ status: 'refreshing', credentials: null })
    expect(await run()).toMatchObject({ error: 'needs_reauth' })
    expect(await row()).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
      last_error: 'needs_reauth',
    })
    expect(provider.calls).toHaveLength(1)
    expect(meetingCalls()).toHaveLength(0)
  })

  it('preserves the replacement OAuth grant when an expired worker lease finishes later', async () => {
    const authorization = new URL((await authorizeZoomMeetings(deps, owner)).authorizationUrl),
      later = fakeZoom('http://localhost:5173', () => now)
    later.controls.identity = { ...provider.controls.identity }
    later.controls.token.scope = zoomScopes('meetings').join(' ')
    later.controls.token.refresh_token = 'synthetic-expired-lease-replacement'
    await expire()
    const gate = pause('refresh'),
      running = run()
    await gate.entered
    await requestDb
      .updateTable('conference_token_operations')
      .set({ expires_at: new Date(0) })
      .where('user_id', '=', owner.user.id)
      .execute()
    expect(
      await finishZoomConnection(
        {
          ...deps,
          zoom: { client: later.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
        },
        owner,
        new URLSearchParams({
          state: authorization.searchParams.get('state') as string,
          code: 'synthetic-replacement',
        }),
      ),
    ).toBe('connected')
    const stored = (await row()).credentials as Buffer
    gate.release()
    expect(await running).toMatchObject({ error: 'needs_reauth' })
    expect((await row()).credentials?.equals(stored)).toBe(true)
    expect(
      readTokens(
        conferenceEncryptionKey(TEST_CONFERENCE_KEY),
        owner.user.id,
        c.connectionId as string,
        c.externalUserId as string,
        stored,
        'meetings',
      ).refreshToken === 'synthetic-expired-lease-replacement',
    ).toBe(true)
  })

  it('checks the sampled revision before starting identity I/O', async () => {
    let changed = false
    const observed = afterCommit(db, async () => {
      if (changed) return
      changed = true
      await requestDb
        .updateTable('conference_connections')
        .set({ display_name: 'Changed after token sample' })
        .where('id', '=', c.connectionId as string)
        .execute()
    })
    expect(await run({ ...deps, db: observed })).toMatchObject({ error: 'needs_reauth' })
    expect(provider.calls).toHaveLength(0)
  })

  it('never overwrites a replacement grant when refresh ownership changes during I/O', async () => {
    await expire()
    const gate = pause('refresh'),
      running = run()
    await gate.entered
    const replacement = credentials(
      conferenceEncryptionKey(TEST_CONFERENCE_KEY),
      owner.user.id,
      c.connectionId as string,
      c.externalUserId as string,
      {
        accessToken: 'synthetic-new-access',
        refreshToken: 'synthetic-new-refresh',
        expiresAt: now + 3600000,
        scopes: zoomScopes('meetings'),
      },
      'meetings',
    )
    await requestDb
      .updateTable('conference_connections')
      .set({ credentials: replacement, operation_id: null, status: 'active' })
      .where('id', '=', c.connectionId as string)
      .execute()
    gate.release()
    expect(await running).toMatchObject({ error: 'needs_reauth' })
    expect((await row()).credentials?.equals(replacement)).toBe(true)
    expect(meetingCalls()).toHaveLength(0)
  })

  it('rejects a refresh claim changed only by a concurrent connection revision', async () => {
    await expire()
    const gate = pause('refresh'),
      running = run()
    await gate.entered
    await requestDb
      .updateTable('conference_connections')
      .set({ display_name: 'Changed during refresh' })
      .where('id', '=', c.connectionId as string)
      .execute()
    gate.release()
    expect(await running).toMatchObject({ error: 'needs_reauth' })
    expect(await row()).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
    })
    expect(meetingCalls()).toHaveLength(0)
  })

  it('does not retire a newer grant after an old identity request rejects access', async () => {
    const gate = pause('identity', 401),
      running = run(),
      original = (await row()).credentials
    await gate.entered
    await requestDb
      .updateTable('conference_connections')
      .set({ display_name: 'Newer connection revision' })
      .where('id', '=', c.connectionId as string)
      .execute()
    gate.release()
    expect(await running).toMatchObject({ error: 'needs_reauth' })
    expect(await row()).toMatchObject({ status: 'active', last_error: null })
    expect((await row()).credentials?.equals(original as Buffer)).toBe(true)
    expect(meetingCalls()).toHaveLength(0)
  })

  for (const kind of ['late identity rejection', 'unreadable ciphertext'] as const)
    it(`keeps successful OAuth storage when a worker observes ${kind} during exchange`, async () => {
      const authorization = new URL((await authorizeZoomMeetings(deps, owner)).authorizationUrl),
        later = fakeZoom('http://localhost:5173', () => now),
        exchangeEntered = deferred(),
        releaseExchange = deferred()
      releases.push(releaseExchange)
      later.controls.identity = { ...provider.controls.identity }
      later.controls.token.scope = zoomScopes('meetings').join(' ')
      later.controls.token.refresh_token = 'synthetic-newer-oauth-refresh'
      later.controls.tokenHook = async () => {
        exchangeEntered.resolve()
        await releaseExchange.promise
        return Response.json(later.controls.token)
      }
      let worker: ReturnType<typeof run> | undefined, identity: ReturnType<typeof pause> | undefined
      if (kind === 'late identity rejection') {
        identity = pause('identity', 401)
        worker = run()
        await identity.entered
      } else
        await db
          .updateTable('conference_connections')
          .set({ credentials: Buffer.from('synthetic-unreadable-ciphertext') })
          .where('id', '=', c.connectionId as string)
          .execute()
      const original = (await row()).credentials
      const callback = finishZoomConnection(
        {
          ...deps,
          zoom: { client: later.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
        },
        owner,
        new URLSearchParams({
          state: authorization.searchParams.get('state') as string,
          code: 'synthetic-newer',
        }),
      )
      pending.push(callback)
      await exchangeEntered.promise
      if (identity) identity.release()
      else worker = run()
      expect(await worker).toMatchObject({ error: 'needs_reauth' })
      expect(await row()).toMatchObject({ status: 'active', last_error: null })
      expect((await row()).credentials?.equals(original as Buffer)).toBe(true)
      releaseExchange.resolve()
      expect(await callback).toBe('connected')
      expect(
        readTokens(
          conferenceEncryptionKey(TEST_CONFERENCE_KEY),
          owner.user.id,
          c.connectionId as string,
          c.externalUserId as string,
          (await row()).credentials as Buffer,
          'meetings',
        ).refreshToken === 'synthetic-newer-oauth-refresh',
      ).toBe(true)
      expect(meetingCalls()).toHaveLength(0)
    })

  it('lets a later OAuth callback retry after worker rotation and stores the newer grant', async () => {
    const authorization = new URL((await authorizeZoomMeetings(deps, owner)).authorizationUrl)
    await expire()
    const gate = pause('refresh'),
      running = run(),
      later = fakeZoom('http://localhost:5173', () => now)
    later.controls.identity = { ...provider.controls.identity }
    later.controls.token.scope = zoomScopes('meetings').join(' ')
    later.controls.token.refresh_token = 'synthetic-later-oauth-refresh'
    await gate.entered
    const callbackDeps = {
        ...deps,
        zoom: { client: later.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
      },
      query = new URLSearchParams({
        state: authorization.searchParams.get('state') as string,
        code: 'synthetic-later',
      })
    expect(await finishZoomConnection(callbackDeps, owner, query)).toBe('busy')
    const state = await db
      .selectFrom('conference_oauth_states')
      .select(['claimed', 'verifier'])
      .where('user_id', '=', owner.user.id)
      .executeTakeFirstOrThrow()
    expect(state.claimed).toBe(false)
    expect(state.verifier).not.toBeNull()
    expect(later.calls).toHaveLength(0)
    gate.release()
    await running
    expect(await finishZoomConnection(callbackDeps, owner, query)).toBe('connected')
    const stored = await row()
    expect(
      readTokens(
        conferenceEncryptionKey(TEST_CONFERENCE_KEY),
        owner.user.id,
        c.connectionId as string,
        c.externalUserId as string,
        stored.credentials as Buffer,
        'meetings',
      ).refreshToken === 'synthetic-later-oauth-refresh',
    ).toBe(true)
  })

  it('makes no worker refresh call while a prior OAuth exchange owns the token operation', async () => {
    const authorization = new URL((await authorizeZoomMeetings(deps, owner)).authorizationUrl)
    await expire()
    const gate = pause('refresh'),
      callback = finishZoomConnection(
        deps,
        owner,
        new URLSearchParams({
          state: authorization.searchParams.get('state') as string,
          code: 'synthetic-prior',
        }),
      )
    pending.push(callback)
    await gate.entered
    expect(await run()).toMatchObject({ error: 'provider_unavailable' })
    expect(provider.calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
    gate.release()
    expect(await callback).toBe('connected')
  })
})
