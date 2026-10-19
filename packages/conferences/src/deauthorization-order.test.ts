import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { deauthorizeZoomConnections } from './deauthorization.ts'
import {
  beginZoomConnection,
  type ConferenceDeps,
  finishZoomConnection,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'

vi.mock('node:timers/promises', async (original) => {
  const actual = await original<typeof import('node:timers/promises')>()
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) }
})

const serverUrl = process.env.DATABASE_URL
const identity = { userId: 'reconnected-zoom-user', accountId: 'synthetic-account' }

describe('Zoom deauthorization retry validation', () => {
  it.each(['', 'not-a-time', '2026-02-30T12:00:00Z', '2026-10-19'])(
    'ignores invalid removal time %s',
    async (deauthorizationTime) => {
      await expect(
        deauthorizeZoomConnections({ db: {} as Db }, { ...identity, deauthorizationTime }),
      ).resolves.toBeUndefined()
    },
  )

  it('backs off between bounded NOWAIT retries after releasing the transaction', async () => {
    vi.mocked(setTimeout).mockClear()
    const execute = vi.fn().mockRejectedValue({ code: '55P03' })
    const db = { transaction: () => ({ execute }) } as unknown as Db
    await expect(
      deauthorizeZoomConnections(
        { db },
        { ...identity, deauthorizationTime: '2026-10-19T12:00:00Z' },
      ),
    ).rejects.toMatchObject({ code: '55P03' })
    expect(execute).toHaveBeenCalledTimes(3)
    expect(vi.mocked(setTimeout).mock.calls.map(([delay]) => delay)).toEqual([20, 40])
  })
})

describe.skipIf(!serverUrl)('Zoom removal ordering (real Postgres)', () => {
  let database: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    deps: ConferenceDeps,
    provider: ReturnType<typeof fakeZoom>,
    now: number
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
    owner = await conferenceTestSession(db)
  })
  afterAll(async () => database?.drop())
  beforeEach(async () => {
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    now = Date.now()
    provider = fakeZoom(undefined, () => now)
    provider.controls.identity.id = identity.userId
    deps = {
      db,
      now: () => now,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY },
    }
  })
  const row = (id: string) =>
    db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const remove = (time = now, database = db) =>
    deauthorizeZoomConnections(
      { db: database },
      { ...identity, deauthorizationTime: new Date(time).toISOString() },
    )
  async function connect(id?: string) {
    const url = new URL((await beginZoomConnection(deps, owner, id)).authorizationUrl)
    expect(
      await finishZoomConnection(
        deps,
        owner,
        new URLSearchParams({
          state: url.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('external_user_id', '=', identity.userId)
      .executeTakeFirstOrThrow()
  }

  it('ignores a replay or delayed retry after removing and reconnecting the same identity', async () => {
    const old = await connect()
    now += 1000
    const removedAt = now
    await remove(removedAt)
    now += 1000
    const current = await connect()
    expect(current.id).not.toBe(old.id)
    expect(current.authorized_at?.getTime()).toBe(now)
    await beginZoomConnection(deps, owner, current.id)
    const states = await db.selectFrom('conference_oauth_states').selectAll().execute()
    const beforeRetry = await row(current.id)
    await remove(removedAt)
    expect(await row(current.id)).toEqual(beforeRetry)
    expect(await db.selectFrom('conference_oauth_states').selectAll().execute()).toEqual(states)
    expect((await row(old.id)).credentials).toBeNull()
    await remove(now)
    expect(await row(current.id)).toMatchObject({
      status: 'disconnected',
      credentials: null,
      external_user_id: null,
    })
  })

  it('advances authorization time on reconsent of an existing row', async () => {
    const initial = await connect()
    now += 1000
    const removalTime = now
    now += 1000
    const renewed = await connect(initial.id)
    expect(renewed.id).toBe(initial.id)
    expect(renewed.created_at).toEqual(initial.created_at)
    expect(renewed.authorized_at?.getTime()).toBe(now)
    await remove(removalTime)
    expect(await row(initial.id)).toEqual(renewed)
  })

  it('rechecks removal ordering after a concurrent authorization wins the owner lock', async () => {
    const initial = await connect()
    now += 1000
    const removedAt = now
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const discovered = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    const paused = db.withPlugin({
      transformQuery: (args) => args.node,
      async transformResult(args) {
        if (first) {
          first = false
          entered()
          await held
        }
        return args.result
      },
    })
    const cleanup = remove(removedAt, paused)
    await discovered
    try {
      now += 1000
      const renewed = await connect(initial.id)
      release()
      await cleanup
      expect(await row(initial.id)).toEqual(renewed)
    } finally {
      release()
      await cleanup
    }
  })

  it('does not treat token refresh as a new authorization', async () => {
    const initial = await connect()
    now += 1000
    const removedAt = now
    now += 1000
    await refreshConference(deps, owner, initial.id)
    expect((await row(initial.id)).authorized_at).toEqual(initial.authorized_at)
    await remove(removedAt)
    expect(await row(initial.id)).toMatchObject({
      status: 'disconnected',
      credentials: null,
      external_user_id: null,
    })
  })

  it('uses creation time for legacy grants without inventing an authorization history', async () => {
    const initial = await connect()
    await db
      .updateTable('conference_connections')
      .set({ authorized_at: null, created_at: new Date(now) })
      .where('id', '=', initial.id)
      .execute()
    const legacy = await row(initial.id)
    await remove(now - 1)
    expect(await row(initial.id)).toEqual(legacy)
    await remove(now)
    expect((await row(initial.id)).credentials).toBeNull()
  })
})
