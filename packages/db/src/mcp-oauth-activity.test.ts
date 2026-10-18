import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0030_mcp_oauth_client_activity.sql'

describe.skipIf(!serverUrl)('MCP OAuth activity migration', () => {
  it('preserves predecessor credentials and backfills consent and token activity, then reruns without changes', async () => {
    const name = `hourmere_test_activity_${process.pid}_${randomUUID().replaceAll('-', '')}`
    const admin = createPool(serverUrl as string)
    const prior = await mkdtemp(join(tmpdir(), 'hourmere-oauth-predecessor-'))
    let pool: ReturnType<typeof createPool> | undefined
    try {
      await admin.query(`CREATE DATABASE ${name}`)
      const url = new URL(serverUrl as string)
      url.pathname = `/${name}`
      pool = createPool(url.href)
      for (const file of await readdir(migrationsDir))
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(prior, file))
      await runMigrations(pool, prior)
      await pool.query(`INSERT INTO auth."oauthClient" ("clientId", "redirectUris", "createdAt", "updatedAt")
        VALUES ('approved', '["https://client.test/callback"]', '2026-01-01', '2026-01-01'),
               ('revoked', '["https://client.test/callback"]', '2026-01-01', '2026-01-01'),
               ('abandoned', '["https://client.test/callback"]', '2026-01-01', '2026-01-01')`)
      const user = await pool.query<{
        id: string
      }>(`INSERT INTO auth."user" (name,email,"emailVerified")
        VALUES ('MCP migration user', 'migration@example.test', true) RETURNING id`)
      const userId = user.rows[0]?.id
      await pool.query(
        `INSERT INTO auth."oauthConsent" ("clientId", "userId", scopes, resources, "createdAt", "updatedAt")
        VALUES ('approved', $1, '["mcp:tools","offline_access"]', '["https://hourmere.test/mcp"]', '2026-01-02', '2026-01-03')`,
        [userId],
      )
      await pool.query(
        `INSERT INTO auth."oauthRefreshToken" (token,"clientId","userId",scopes,"createdAt","expiresAt",revoked)
        VALUES ('synthetic-hashed-approved','approved',$1,'["mcp:tools","offline_access"]','2026-01-10','2026-02-01',null),
               ('synthetic-hashed-revoked','revoked',$1,'["mcp:tools","offline_access"]','2026-01-04','2026-02-01','2026-01-05')`,
        [userId],
      )
      const snapshot = async () =>
        (
          await pool?.query(
            `SELECT "clientId",token,"expiresAt",revoked FROM auth."oauthRefreshToken" ORDER BY "clientId"`,
          )
        )?.rows
      const before = await snapshot()
      // Only this migration joins the predecessor set, so later migrations cannot change
      // what this test applies or observes.
      await copyFile(join(migrationsDir, migration), join(prior, migration))
      expect(await runMigrations(pool, prior)).toEqual([migration])
      const activity = await pool.query(
        `SELECT client_id, consented_at::text, last_used_at::text FROM mcp_oauth_client_activity ORDER BY client_id`,
      )
      expect(activity.rows).toEqual([
        {
          client_id: 'approved',
          consented_at: '2026-01-02 00:00:00+00',
          last_used_at: '2026-01-10 00:00:00+00',
        },
        {
          client_id: 'revoked',
          consented_at: '2026-01-04 00:00:00+00',
          last_used_at: '2026-01-04 00:00:00+00',
        },
      ])
      expect(await snapshot()).toEqual(before)
      expect(await runMigrations(pool, prior)).toEqual([])
      expect(await snapshot()).toEqual(before)
      await expect(
        pool.query(`DELETE FROM auth."oauthClient" WHERE "clientId"='approved'`),
      ).resolves.toBeDefined()
      expect((await pool.query(`SELECT client_id FROM mcp_oauth_client_activity`)).rows).toEqual([
        { client_id: 'revoked' },
      ])
    } finally {
      await pool?.end()
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
      await rm(prior, { recursive: true, force: true })
    }
  })
  it('installs an empty activity table on a fresh database and is a no-op on rerun', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      expect((await owned.pool.query('SELECT * FROM mcp_oauth_client_activity')).rows).toEqual([])
      expect(await runMigrations(owned.pool)).toEqual([])
    } finally {
      await owned.drop()
    }
  })
})
