import { randomUUID } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { conferenceTestSession } from './testing.ts'
import { type TokenOperation, withTokenOperation } from './token-operation.ts'

const databaseUrl = process.env.DATABASE_URL
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe.skipIf(!databaseUrl)('Zoom token-operation durable leases', () => {
  let database: TestDatabase, db: Db, owner: string
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = (await conferenceTestSession(db)).user.id
  })
  afterAll(async () => {
    await database?.drop()
  })
  it('takes over an already expired lease without taking the busy path', async () => {
    await db
      .insertInto('conference_token_operations')
      .values({ user_id: owner, operation_id: randomUUID(), expires_at: new Date(0) })
      .execute()
    try {
      const result = await withTokenOperation(
        db,
        owner,
        async () => 'acquired',
        async () => 'busy',
      )
      expect(result).toBe('acquired')
      expect(await db.selectFrom('conference_token_operations').selectAll().execute()).toHaveLength(
        0,
      )
    } finally {
      await db.deleteFrom('conference_token_operations').where('user_id', '=', owner).execute()
    }
  })
  it.each(['success', 'rejection', 'rollback'] as const)(
    'releases the lease after %s without reserving a connection during I/O',
    async (outcome) => {
      const pool = createPool(database.url)
      pool.options.max = 1
      try {
        const connectionDb = createDb(pool)
        const operation = withTokenOperation(connectionDb, owner, async (connection, lease) => {
          expect(pool.totalCount - pool.idleCount).toBe(0)
          await connection.transaction().execute(async (transaction) => {
            expect(await lease.current(transaction)).toBe(true)
            if (outcome === 'rollback') throw new Error('synthetic rollback')
          })
          if (outcome === 'rejection') throw new Error('synthetic rejection')
          return 'completed'
        })
        if (outcome === 'success') expect(await operation).toBe('completed')
        else await expect(operation).rejects.toThrow(`synthetic ${outcome}`)
        expect(
          await db.selectFrom('conference_token_operations').selectAll().execute(),
        ).toHaveLength(0)
      } finally {
        await pool.end()
      }
    },
  )
  it('an expired lease cannot store results or delete a replacement lease', async () => {
    const oldEntered = deferred(),
      releaseOld = deferred(),
      newEntered = deferred(),
      releaseNew = deferred()
    let oldLease!: TokenOperation,
      newId = ''
    const old = withTokenOperation(db, owner, async (_db, lease) => {
      oldLease = lease
      oldEntered.resolve()
      await releaseOld.promise
    })
    let replacement: Promise<void> | undefined
    try {
      await oldEntered.promise
      await db
        .updateTable('conference_token_operations')
        .set({ expires_at: new Date(0) })
        .where('user_id', '=', owner)
        .execute()
      await db.transaction().execute(async (tx) => {
        expect(await oldLease.current(tx)).toBe(false)
      })
      replacement = withTokenOperation(db, owner, async (_db, lease) => {
        newId = lease.id
        newEntered.resolve()
        await releaseNew.promise
      })
      await newEntered.promise
      await db.transaction().execute(async (tx) => {
        expect(await oldLease.current(tx)).toBe(false)
      })
      releaseOld.resolve()
      await old
      const current = await db
        .selectFrom('conference_token_operations')
        .select('operation_id')
        .where('user_id', '=', owner)
        .executeTakeFirst()
      expect(current?.operation_id === newId).toBe(true)
    } finally {
      releaseOld.resolve()
      releaseNew.resolve()
      await Promise.allSettled([old, replacement])
    }
  })
  it('does not take over a live lease and exposes a bounded provider signal', async () => {
    const controller = new AbortController(),
      deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
    try {
      await withTokenOperation(
        db,
        owner,
        async (_db, lease) => {
          const contender = await withTokenOperation(
            db,
            owner,
            async () => 'incorrectly acquired',
            async () => 'busy',
          )
          expect(contender).toBe('busy')
          expect(lease.signal.aborted).toBe(false)
          controller.abort()
          expect(lease.signal.aborted).toBe(true)
          expect(deadline).toHaveBeenCalledWith(1234)
        },
        undefined,
        1234,
      )
    } finally {
      deadline.mockRestore()
    }
  })
  it('protects the absent lease gap while a credential retirement holds the owner', async () => {
    const holder = await database.pool.connect(),
      entered = deferred(),
      release = deferred()
    let operation: Promise<void> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth."user" WHERE id=$1 FOR KEY SHARE', [owner])
      operation = withTokenOperation(db, owner, async () => {
        entered.resolve()
        await release.promise
      })
      let stop = false
      const waiting = (async () => {
        while (!stop) {
          const result = await database.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND wait_event_type='Lock' AND query LIKE '%for update%') AS waiting`,
          )
          if (result.rows[0]?.waiting) return true
        }
        return false
      })()
      try {
        expect(await Promise.race([waiting, entered.promise.then(() => false)])).toBe(true)
      } finally {
        stop = true
        await waiting
      }
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      release.resolve()
      await operation
    }
  })
  it('does not accept another operation id as its lease', async () => {
    await withTokenOperation(db, owner, async (_db, lease) => {
      await db
        .updateTable('conference_token_operations')
        .set({ operation_id: randomUUID() })
        .where('user_id', '=', owner)
        .execute()
      await db.transaction().execute(async (tx) => {
        expect(await lease.current(tx)).toBe(false)
      })
    })
    await db.deleteFrom('conference_token_operations').where('user_id', '=', owner).execute()
  })
})
