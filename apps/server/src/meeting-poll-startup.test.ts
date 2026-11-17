import '@hono/zod-openapi'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { ensureMeetingPollKey } from '@hourmere/scheduling'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixture } from '../../../packages/db/src/meeting-poll-protections.ts'
import { startServer } from './server.ts'

describe.skipIf(!process.env.DATABASE_URL)('meeting poll startup key fence', () => {
  let database: TestDatabase
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    const db = createDb(database.pool)
    await db
      .transaction()
      .execute((trx) => ensureMeetingPollKey(trx, 'retained-meeting-poll-test-secret-32'))
    await fixture(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })
  it.each(['web', 'all', 'worker'])(
    'refuses %s startup before any listener serves with the wrong secret',
    async (role) => {
      let running: Awaited<ReturnType<typeof startServer>> | undefined
      try {
        await expect(
          (async () => {
            running = await startServer({
              DATABASE_URL: database.url,
              BETTER_AUTH_SECRET: 'replacement-meeting-poll-test-secret-32',
              HOURMERE_ROLE: role,
              PUBLIC_URL: 'http://localhost',
              PORT: '0',
              SIGNUP: 'closed',
            })
          })(),
        ).rejects.toMatchObject({ code: 'meeting_poll_key_mismatch' })
        expect(running).toBeUndefined()
      } finally {
        await running?.close()
      }
    },
  )
})
