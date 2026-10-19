import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpOAuthCleanupJob } from './oauth.ts'

const serverUrl = process.env.DATABASE_URL
const ago = (days: number) => new Date(Date.now() - days * 86400000)

describe.skipIf(!serverUrl)('DCR client retention', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('expires abandoned DCR clients after 24 hours and unused DCR clients after 90 days', async () => {
    const user = await createTestUser(db)
    const client = async (
      age: number,
      extra: { clientDiscoveryId?: string; userId?: string } = {},
    ) => {
      const id = randomUUID()
      await db
        .insertInto('auth.oauthClient')
        .values({
          clientId: id,
          redirectUris: sql`${JSON.stringify(['https://client.test/callback'])}::jsonb`,
          createdAt: ago(age),
          updatedAt: ago(age),
          ...extra,
        })
        .execute()
      return id
    }
    const abandoned = await client(25 / 24),
      fresh = await client(23 / 24),
      inactive = await client(100),
      recentUse = await client(100),
      coalescedUse = await client(100),
      revoked = await client(2),
      approved = await client(2),
      discovered = await client(100, { clientDiscoveryId: 'cimd' }),
      managed = await client(100, { userId: user.id })
    for (const [id, lastUsed] of [
      [inactive, 92],
      [recentUse, 1],
      [coalescedUse, 90.5],
      [revoked, 2],
    ] as const)
      await db
        .insertInto('mcp_oauth_client_activity')
        .values({ client_id: id, consented_at: ago(100), last_used_at: ago(lastUsed) })
        .execute()
    // Also preserve existing consent rows during an upgrade/consent activity write race.
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId: approved,
        userId: user.id,
        scopes: sql`${JSON.stringify(['mcp:tools'])}::jsonb`,
        resources: sql`${JSON.stringify(['https://hourmere.test/mcp'])}::jsonb`,
        createdAt: ago(1),
        updatedAt: ago(1),
      })
      .execute()
    const job = mcpOAuthCleanupJob(db)
    const run = () =>
      job.handler({}, { id: randomUUID(), attempt: 1, signal: new AbortController().signal })
    await run()
    const retained = async () =>
      (await db.selectFrom('auth.oauthClient').select('clientId').execute())
        .map((r) => r.clientId)
        .sort()
    expect(await retained()).toEqual(
      [fresh, recentUse, coalescedUse, revoked, approved, discovered, managed].sort(),
    )
    expect(
      await db
        .selectFrom('mcp_oauth_client_activity')
        .select('client_id')
        .where('client_id', '=', inactive)
        .execute(),
    ).toHaveLength(0)
    expect(
      await db
        .selectFrom('auth.oauthClient')
        .select('clientId')
        .where('clientId', '=', abandoned)
        .execute(),
    ).toHaveLength(0)
    await run()
    expect(await retained()).toEqual(
      [fresh, recentUse, coalescedUse, revoked, approved, discovered, managed].sort(),
    )
  })
})
