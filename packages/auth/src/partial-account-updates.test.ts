import { randomUUID } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Auth, createAuth, createAuthPool } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const signup = { mode: 'open', allowedDomains: [] } as const
const providers = ['google', 'microsoft'] as const
const legacyExpiry = new Date('2030-01-01T00:00:00Z')
const replacementExpiry = new Date('2031-01-01T00:00:00Z')

interface StoredAccount {
  id: string
  userId: string
  providerId: string
  accountId: string
  accessToken: string | null
  refreshToken: string | null
  refreshTokenExpiresAt: Date | null
  idToken: string | null
  scope: string | null
}

describe.skipIf(!serverUrl)('partial sign-in account updates', () => {
  let owned: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db: createDb(owned.pool),
      baseURL: 'http://localhost:43828',
      secret: 'synthetic-partial-account-test-secret-at-least-32-characters',
      signup,
      mailer: { send: async () => {} },
    })
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture(provider: (typeof providers)[number]) {
    const id = randomUUID()
    const userId = randomUUID()
    const accountId = randomUUID()
    await owned.pool.query(
      'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
      [userId, 'Synthetic account user', `${userId}@example.test`],
    )
    // Seed legacy credentials outside the hooks, as an existing installation may hold them.
    await owned.pool.query(
      `INSERT INTO auth.account
       (id, "userId", "providerId", "accountId", "accessToken", "refreshToken",
        "refreshTokenExpiresAt", "idToken", scope, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'openid profile email', now())`,
      [
        id,
        userId,
        provider,
        accountId,
        'synthetic-retained-access',
        'synthetic-legacy-refresh',
        legacyExpiry,
        'synthetic-legacy-id-token',
      ],
    )
    const stored = async () => {
      const result = await owned.pool.query<StoredAccount>(
        'SELECT * FROM auth.account WHERE id = $1',
        [id],
      )
      expect(result.rowCount).toBe(1)
      const account = result.rows[0] as StoredAccount
      expect([account.id, account.userId, account.providerId, account.accountId]).toEqual([
        id,
        userId,
        provider,
        accountId,
      ])
      expect(account.accessToken === 'synthetic-retained-access').toBe(true)
      return account
    }
    return { id, stored }
  }

  it.each(providers)(
    'uses the stored %s provider for a replacement-token patch',
    async (provider) => {
      const f = await fixture(provider)
      await (await auth.$context).internalAdapter.updateAccount(f.id, {
        refreshToken: 'synthetic-replacement-refresh',
        refreshTokenExpiresAt: replacementExpiry,
        idToken: 'synthetic-replacement-id-token',
      })
      const account = await f.stored()
      expect(account.idToken === null).toBe(true)
      if (provider === 'google') {
        expect(account.refreshToken === null).toBe(true)
        expect(account.refreshTokenExpiresAt === null).toBe(true)
      } else {
        expect(account.refreshToken === 'synthetic-replacement-refresh').toBe(true)
        expect(account.refreshTokenExpiresAt?.getTime()).toBe(replacementExpiry.getTime())
      }
    },
  )

  it.each(providers)(
    'cleans legacy %s tokens when the patch omits every token',
    async (provider) => {
      const f = await fixture(provider)
      await (await auth.$context).internalAdapter.updateAccount(f.id, { scope: 'openid email' })
      const account = await f.stored()
      expect(account.idToken === null).toBe(true)
      expect(account.scope).toBe('openid email')
      if (provider === 'google') {
        expect(account.refreshToken === null).toBe(true)
        expect(account.refreshTokenExpiresAt === null).toBe(true)
      } else {
        expect(account.refreshToken === 'synthetic-legacy-refresh').toBe(true)
        expect(account.refreshTokenExpiresAt?.getTime()).toBe(legacyExpiry.getTime())
      }
    },
  )

  it.each(providers)('guards the %s transaction adapter before persistence', async (provider) => {
    const f = await fixture(provider)
    await (await auth.$context).adapter.transaction((trx) =>
      trx.update({
        model: 'account',
        where: [{ field: 'id', value: f.id }],
        update: {
          refreshToken: 'synthetic-transaction-refresh',
          refreshTokenExpiresAt: replacementExpiry,
        },
      }),
    )
    const account = await f.stored()
    if (provider === 'google') {
      expect(account.refreshToken === null).toBe(true)
      expect(account.refreshTokenExpiresAt === null).toBe(true)
    } else {
      expect(account.refreshToken === 'synthetic-transaction-refresh').toBe(true)
      expect(account.refreshTokenExpiresAt?.getTime()).toBe(replacementExpiry.getTime())
    }
  })
})
