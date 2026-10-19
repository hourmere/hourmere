import { createHash, randomUUID } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  beginZoomConnection,
  type ConferenceDeps,
  finishZoomConnection,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe.skipIf(!databaseUrl)('browser Zoom token lease fencing (real Postgres)', () => {
  let database: TestDatabase, db: Db, controlledDb: Db, controlledPool: pg.Pool
  let owner: Awaited<ReturnType<typeof conferenceTestSession>>
  let provider: ReturnType<typeof fakeZoom>, deps: ConferenceDeps
  let afterCommit: (() => Promise<void>) | undefined
  const gates: ReturnType<typeof deferred>[] = []
  const pending: Promise<unknown>[] = []

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    controlledPool = createPool(database.url)
    controlledPool.options.max = 1
    const proxy = new Proxy(controlledPool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (input: unknown, ...args: unknown[]) => {
                    const result = await Reflect.apply(connection.query, connection, [
                      input,
                      ...args,
                    ])
                    const statement =
                      typeof input === 'string' ? input : (input as { text?: string })?.text
                    if (statement?.trim().toLowerCase() === 'commit') await afterCommit?.()
                    return result
                  }
                const value = Reflect.get(connection, key)
                return typeof value === 'function' ? value.bind(connection) : value
              },
            })
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    controlledDb = createDb(proxy)
  })
  beforeEach(async () => {
    owner = await conferenceTestSession(db)
    provider = fakeZoom()
    provider.controls.identity.id = `synthetic-lease-${owner.user.id}`
    deps = {
      db,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY },
    }
  })
  afterEach(async () => {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled(pending)
    afterCommit = undefined
    gates.length = 0
    pending.length = 0
  })
  afterAll(async () => {
    await controlledPool?.end()
    await database?.drop()
  })

  function observe<T>(promise: Promise<T>) {
    const result = promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    pending.push(result)
    return result
  }
  function query(state: string) {
    return new URLSearchParams({ state, code: 'synthetic-code' })
  }
  async function start() {
    const authorization = await beginZoomConnection(deps, owner)
    return new URL(authorization.authorizationUrl).searchParams.get('state') as string
  }
  function row(id: string) {
    return db
      .selectFrom('conference_connections')
      .select(['status', 'credentials', 'operation_id', 'mode', 'external_user_id', 'last_error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }
  function connections() {
    return db
      .selectFrom('conference_connections')
      .select('id')
      .where('user_id', '=', owner.user.id)
      .execute()
  }
  async function connect() {
    expect(await finishZoomConnection(deps, owner, query(await start()))).toBe('connected')
    const connection = await db
      .selectFrom('conference_connections')
      .select('id')
      .where('user_id', '=', owner.user.id)
      .where('external_user_id', '=', String(provider.controls.identity.id))
      .executeTakeFirst()
    if (!connection) throw new Error('Expected the synthetic Zoom connection')
    return connection.id
  }
  function pauseCommit(number: number) {
    const entered = deferred(),
      release = deferred()
    let count = 0
    gates.push(release)
    afterCommit = async () => {
      if (++count !== number) return
      entered.resolve()
      await release.promise
    }
    return { entered: entered.promise, release: release.resolve }
  }
  function pauseIdentity() {
    const entered = deferred(),
      release = deferred(),
      response = structuredClone(provider.controls.identity)
    gates.push(release)
    provider.controls.identityHook = async () => {
      entered.resolve()
      await release.promise
      return Response.json(response)
    }
    return { entered: entered.promise, release: release.resolve }
  }
  async function replaceLease() {
    const operation = randomUUID()
    await db
      .updateTable('conference_token_operations')
      .set({ operation_id: operation })
      .where('user_id', '=', owner.user.id)
      .execute()
    return operation
  }
  function leaseRow() {
    return db
      .selectFrom('conference_token_operations')
      .select('operation_id')
      .where('user_id', '=', owner.user.id)
      .executeTakeFirst()
  }

  it('returns busy on one lease attempt without consuming state, then accepts the same callback', async () => {
    const state = await start(),
      hash = createHash('sha256').update(state).digest('hex'),
      operation = randomUUID()
    await db
      .insertInto('conference_token_operations')
      .values({
        user_id: owner.user.id,
        operation_id: operation,
        expires_at: new Date(Date.now() + 60000),
      })
      .execute()
    const attempt = () =>
        db
          .selectFrom('conference_oauth_states')
          .selectAll()
          .where('state_hash', '=', hash)
          .executeTakeFirstOrThrow(),
      original = await attempt()
    let attempts = 0
    const failOnRetry = db.withPlugin({
      transformQuery(args) {
        if (
          args.node.kind === 'InsertQueryNode' &&
          args.node.into?.table.identifier.name === 'conference_token_operations'
        ) {
          // A regression to polling fails a real result assertion instead of a test timeout.
          if (++attempts > 1) throw new Error('Unexpected callback lease polling')
        }
        return args.node
      },
      async transformResult(args) {
        return args.result
      },
    })
    expect(await finishZoomConnection({ ...deps, db: failOnRetry }, owner, query(state))).toBe(
      'busy',
    )
    expect(attempts).toBe(1)
    expect(await attempt()).toEqual(original)
    expect(provider.calls).toHaveLength(0)
    expect((await leaseRow())?.operation_id).toBe(operation)
    await db
      .deleteFrom('conference_token_operations')
      .where('user_id', '=', owner.user.id)
      .execute()
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('connected')
    expect(await connections()).toHaveLength(1)
    expect(provider.calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  it('does not consume callback state after its lease is replaced before the claim', async () => {
    const state = await start(),
      hash = createHash('sha256').update(state).digest('hex'),
      gate = pauseCommit(1),
      finishing = observe(finishZoomConnection({ ...deps, db: controlledDb }, owner, query(state)))
    await gate.entered
    const replacement = await replaceLease()
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    const attempt = await db
      .selectFrom('conference_oauth_states')
      .select(['claimed', 'verifier'])
      .where('state_hash', '=', hash)
      .executeTakeFirstOrThrow()
    expect(attempt.claimed).toBe(false)
    expect(attempt.verifier).not.toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect((await leaseRow())?.operation_id).toBe(replacement)
  })

  it('retires an abandoned refresh after taking over its expired lease without contacting Zoom', async () => {
    const id = await connect()
    await db
      .updateTable('conference_connections')
      .set({ status: 'refreshing', credentials: null, operation_id: randomUUID() })
      .where('id', '=', id)
      .execute()
    await db
      .insertInto('conference_token_operations')
      .values({ user_id: owner.user.id, operation_id: randomUUID(), expires_at: new Date(0) })
      .execute()
    const calls = provider.calls.length
    await expect(refreshConference(deps, owner, id)).rejects.toMatchObject({
      code: 'zoom_needs_reauth',
    })
    expect(await row(id)).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
      last_error: 'needs_reauth',
    })
    expect(provider.calls).toHaveLength(calls)
    expect(await leaseRow()).toBeUndefined()
  })

  it('preserves an abandoned refresh when a replacement lease owns recovery', async () => {
    const id = await connect()
    await db
      .updateTable('conference_connections')
      .set({ status: 'refreshing', credentials: null, operation_id: randomUUID() })
      .where('id', '=', id)
      .execute()
    const original = await row(id),
      calls = provider.calls.length,
      gate = pauseCommit(1),
      refreshing = observe(refreshConference({ ...deps, db: controlledDb }, owner, id))
    await gate.entered
    const replacement = await replaceLease()
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(await row(id)).toEqual(original)
    expect(provider.calls).toHaveLength(calls)
    expect((await leaseRow())?.operation_id).toBe(replacement)
  })

  it('returns a neutral busy message for a different identity while preserving its active credentials', async () => {
    const first = await connect()
    provider.controls.identity.id = `synthetic-second-${owner.user.id}`
    const second = await connect(),
      original = await row(second)
    provider.controls.identity.id = (await row(first)).external_user_id
    const gate = pauseIdentity(),
      refreshing = observe(refreshConference(deps, owner, first))
    await gate.entered
    const calls = provider.calls.length
    await expect(refreshConference(deps, owner, second)).rejects.toMatchObject({
      code: 'zoom_refresh_in_progress',
      message: 'Zoom account operations are busy. Try again shortly.',
    })
    expect(await row(second)).toEqual(original)
    expect(provider.calls).toHaveLength(calls)
    gate.release()
    await refreshing
  })

  it('recovers a refresh discarded after its provider response outlives the lease', async () => {
    const id = await connect(),
      gate = pauseIdentity(),
      refreshing = observe(refreshConference(deps, owner, id))
    await gate.entered
    await db
      .updateTable('conference_token_operations')
      .set({ expires_at: new Date(0) })
      .where('user_id', '=', owner.user.id)
      .execute()
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(await row(id)).toMatchObject({ status: 'refreshing', credentials: null })
    const calls = provider.calls.length
    await expect(refreshConference(deps, owner, id)).rejects.toMatchObject({
      code: 'zoom_needs_reauth',
    })
    expect(await row(id)).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
      last_error: 'needs_reauth',
    })
    expect(provider.calls).toHaveLength(calls)
  })

  it('refuses callback exchange after its acquired lease is replaced', async () => {
    const state = await start(),
      gate = pauseCommit(1), // Lease acquisition commits before consuming the OAuth state.
      finishing = observe(finishZoomConnection({ ...deps, db: controlledDb }, owner, query(state)))
    await gate.entered
    const replacement = await replaceLease()
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    expect(provider.calls).toHaveLength(0)
    expect(await connections()).toHaveLength(0)
    expect((await leaseRow())?.operation_id === replacement).toBe(true)
  })

  it('does not store a callback grant after its lease expires during provider I/O', async () => {
    const state = await start(),
      gate = pauseIdentity(),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    await db
      .updateTable('conference_token_operations')
      .set({ expires_at: new Date(0) })
      .where('user_id', '=', owner.user.id)
      .execute()
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    expect(await connections()).toHaveLength(0)
    expect(await leaseRow()).toBeUndefined()
  })

  it('does not retire refresh credentials after its acquired lease is replaced', async () => {
    const id = await connect(),
      original = await row(id),
      calls = provider.calls.length,
      gate = pauseCommit(1),
      refreshing = observe(refreshConference({ ...deps, db: controlledDb }, owner, id))
    await gate.entered
    const replacement = await replaceLease()
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    const current = await row(id)
    expect(current.status).toBe('active')
    expect(current.operation_id).toBeNull()
    expect(current.credentials?.equals(original.credentials as Buffer)).toBe(true)
    expect(provider.calls).toHaveLength(calls)
    expect((await leaseRow())?.operation_id === replacement).toBe(true)
  })

  it('does not exchange refresh tokens after its retired claim loses the lease', async () => {
    const id = await connect(),
      calls = provider.calls.length,
      gate = pauseCommit(2), // Lease acquisition then durable credential retirement.
      refreshing = observe(refreshConference({ ...deps, db: controlledDb }, owner, id))
    await gate.entered
    const claimed = await row(id),
      replacement = await replaceLease()
    expect(claimed.status).toBe('refreshing')
    expect(claimed.credentials === null).toBe(true)
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(provider.calls).toHaveLength(calls)
    expect(await row(id)).toEqual(claimed)
    expect((await leaseRow())?.operation_id === replacement).toBe(true)
  })

  it('preserves a retired refresh claim and replacement lease after provider I/O', async () => {
    const id = await connect(),
      gate = pauseIdentity(),
      refreshing = observe(refreshConference(deps, owner, id))
    await gate.entered
    const claimed = await row(id),
      replacement = await replaceLease()
    expect(claimed.status).toBe('refreshing')
    expect(claimed.credentials === null).toBe(true)
    gate.release()
    expect(await refreshing).toMatchObject({
      status: 'rejected',
      error: { code: 'zoom_needs_reauth' },
    })
    expect(await row(id)).toEqual(claimed)
    expect((await leaseRow())?.operation_id === replacement).toBe(true)
  })
})
