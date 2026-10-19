import { randomUUID } from 'node:crypto'
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
    const connection = (await connections())[0]
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

  it('refuses callback exchange after its acquired lease is replaced', async () => {
    const state = await start(),
      gate = pauseCommit(2), // State consumption commits before the token lease acquisition.
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
