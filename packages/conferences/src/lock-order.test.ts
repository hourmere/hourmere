import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { beginZoomConnection } from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('Zoom owner/session/state lock order (real Postgres)', () => {
  let database: TestDatabase
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
  })
  afterAll(async () => {
    await database?.drop()
  })
  for (const pending of [false, true])
    for (const first of ['logout', 'owner deletion'] as const) {
      it(`${first} first, ${pending ? 'with pending OAuth state' : 'without OAuth state'}: both operations commit without deadlock`, async () => {
        const db = createDb(database.pool),
          owner = await conferenceTestSession(db),
          provider = fakeZoom()
        if (pending)
          await beginZoomConnection(
            { db, zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY } },
            owner,
          )
        const deletion = await database.pool.connect(),
          logout = await database.pool.connect()
        const deletionPid = (
          await deletion.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]?.pid
        const logoutPid = (await logout.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid
        const finish = async (client: typeof deletion, statement: string, id: string) => {
          try {
            await client.query(statement, [id])
            await client.query('COMMIT')
            return { committed: true, code: null }
          } catch (error) {
            await client.query('ROLLBACK')
            return { committed: false, code: (error as { code?: string }).code }
          }
        }
        const barrier = async (waiter: number | undefined, blocker: number | undefined) => {
          await vi.waitFor(
            async () => {
              const result = await database.pool.query<{ blocked: boolean }>(
                'SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked',
                [waiter, blocker],
              )
              expect(result.rows[0]?.blocked).toBe(true)
            },
            { timeout: 2000, interval: 10 },
          )
        }
        try {
          await deletion.query('BEGIN')
          await logout.query('BEGIN')
          let outcomes: Awaited<ReturnType<typeof finish>>[]
          if (first === 'logout') {
            await logout.query('SELECT id FROM auth.session WHERE id=$1 FOR UPDATE', [
              owner.sessionId,
            ])
            const removing = finish(deletion, 'DELETE FROM auth."user" WHERE id=$1', owner.user.id)
            await barrier(deletionPid, logoutPid)
            outcomes = await Promise.all([
              removing,
              finish(logout, 'DELETE FROM auth.session WHERE id=$1', owner.sessionId),
            ])
          } else {
            await deletion.query('DELETE FROM auth."user" WHERE id=$1', [owner.user.id])
            const exiting = finish(logout, 'DELETE FROM auth.session WHERE id=$1', owner.sessionId)
            await barrier(logoutPid, deletionPid)
            await deletion.query('COMMIT')
            outcomes = [{ committed: true, code: null }, await exiting]
          }
          expect(outcomes).toEqual([
            { committed: true, code: null },
            { committed: true, code: null },
          ])
          expect(
            await db.selectFrom('auth.user').select('id').where('id', '=', owner.user.id).execute(),
          ).toHaveLength(0)
          expect(
            await db
              .selectFrom('auth.session')
              .select('id')
              .where('userId', '=', owner.user.id)
              .execute(),
          ).toHaveLength(0)
          expect(
            await db
              .selectFrom('conference_oauth_states')
              .select('state_hash')
              .where('user_id', '=', owner.user.id)
              .execute(),
          ).toHaveLength(0)
          expect(provider.calls).toHaveLength(0)
        } finally {
          for (const client of [deletion, logout]) {
            await client.query('ROLLBACK').catch(() => {})
            client.release()
          }
        }
      })
    }
})
