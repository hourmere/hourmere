import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mayHoldApiKeys } from './api-keys.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('mayHoldApiKeys', () => {
  let testDb: TestDatabase
  let db: Db
  let seq = 0

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  async function user(emailVerified: boolean) {
    const u = await db
      .insertInto('auth.user')
      .values({ name: '', email: `user${++seq}@example.com`, emailVerified })
      .returning('id')
      .executeTakeFirstOrThrow()
    const s = await db
      .insertInto('auth.session')
      .values({
        userId: u.id,
        token: `token-${seq}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { userId: u.id, sessionId: s.id }
  }

  const status = (code: string) => ({ body: expect.objectContaining({ code }) })

  it('allows a verified user, with a live session or in a server-side call', async () => {
    const { userId, sessionId } = await user(true)
    await expect(mayHoldApiKeys(db, userId, sessionId)).resolves.toBeUndefined()
    await expect(mayHoldApiKeys(db, userId, undefined)).resolves.toBeUndefined()
  })

  it('refuses a user whose email is not verified', async () => {
    const { userId, sessionId } = await user(false)
    await expect(mayHoldApiKeys(db, userId, sessionId)).rejects.toMatchObject(
      status('EMAIL_NOT_VERIFIED'),
    )
    await expect(mayHoldApiKeys(db, userId, undefined)).rejects.toMatchObject(
      status('EMAIL_NOT_VERIFIED'),
    )
  })

  it('refuses a request whose session was revoked after it was loaded', async () => {
    // What a verified-looking account shows when its real owner's email-link sign-in has
    // revoked the session the request started with.
    const { userId, sessionId } = await user(true)
    await db.deleteFrom('auth.session').where('id', '=', sessionId).execute()
    await expect(mayHoldApiKeys(db, userId, sessionId)).rejects.toMatchObject(
      status('UNAUTHORIZED_SESSION'),
    )
  })

  it('refuses an unknown user', async () => {
    await expect(
      mayHoldApiKeys(db, '00000000-0000-4000-8000-000000000000', undefined),
    ).rejects.toMatchObject(status('UNAUTHORIZED_SESSION'))
  })
})
