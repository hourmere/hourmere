import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0031_discard_sign_in_id_tokens.sql'

async function seed(pool: pg.Pool, retainedIdTokens: boolean) {
  const userId = '00000000-0000-4000-8000-000000000001'
  await pool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
     VALUES ($1, 'Synthetic migration user', 'id-token-migration@example.test', true,
       'https://example.test/avatar', '2026-01-02T03:04:05.123456Z', '2026-02-03T04:05:06.654321Z')`,
    [userId],
  )
  for (const [index, provider] of ['google', 'microsoft', 'credential'].entries()) {
    await pool.query(
      `INSERT INTO auth.account (id, "accountId", "providerId", "userId", "accessToken",
       "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope,
       password, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-05-06T07:08:09.123456Z',
         '2026-08-09T10:11:12.654321Z', $8, $9,
         '2026-01-02T03:04:05.123456Z', '2026-02-03T04:05:06.654321Z')`,
      [
        `00000000-0000-4000-8000-00000000000${index + 2}`,
        `synthetic-${provider}-identity`,
        provider,
        userId,
        `synthetic-encrypted-access-${provider}-é-\\`,
        `synthetic-encrypted-refresh-${provider}-東京`,
        retainedIdTokens && provider !== 'credential' ? `synthetic-${provider}-id-token` : null,
        `openid email profile synthetic:${provider}`,
        `synthetic-password-hash-${provider}`,
      ],
    )
  }
}

// Serialize in PostgreSQL so timestamp microseconds survive, then compare UTF-8 bytes
// for every column except the one this data-only migration deliberately clears.
async function preservedColumns(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT id, encode(convert_to((to_jsonb(a) - 'idToken')::text, 'UTF8'), 'hex') AS bytes
       FROM auth.account a ORDER BY id`,
    )
  ).rows
}

async function accounts(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT encode(convert_to(to_jsonb(a)::text, 'UTF8'), 'hex') AS bytes
       FROM auth.account a ORDER BY id`,
    )
  ).rows
}

async function tuples(pool: pg.Pool, onlyAlreadyNull = false) {
  return (
    await pool.query(
      `SELECT id, xmin::text, ctid::text FROM auth.account
       ${onlyAlreadyNull ? `WHERE "idToken" IS NULL` : ''} ORDER BY id`,
    )
  ).rows
}

async function schema(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT column_name, ordinal_position, data_type, udt_schema, udt_name, is_nullable,
       column_default FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'account' ORDER BY ordinal_position`,
    )
  ).rows
}

describe.skipIf(!serverUrl)('discard sign-in ID tokens migration', () => {
  it('clears only retained ID tokens, preserves all other bytes, matches a fresh install and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-id-token-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(predecessor, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      await seed(pool, true)
      const before = await preservedColumns(pool)
      const alreadyNull = await tuples(pool, true)
      expect(alreadyNull).toHaveLength(1)
      const usersBefore = (await pool.query('SELECT to_jsonb(u)::text FROM auth."user" u')).rows
      const schemaBefore = await schema(pool)

      // Add only 0031, so subsequent migrations cannot affect this upgrade assertion.
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(
        (await pool.query('SELECT "idToken" IS NULL AS discarded FROM auth.account ORDER BY id'))
          .rows,
      ).toEqual([{ discarded: true }, { discarded: true }, { discarded: true }])
      expect(await preservedColumns(pool)).toEqual(before)
      expect((await tuples(pool)).filter((row) => row.id === alreadyNull[0]?.id)).toEqual(
        alreadyNull,
      )
      expect((await pool.query('SELECT to_jsonb(u)::text FROM auth."user" u')).rows).toEqual(
        usersBefore,
      )
      expect(await schema(pool)).toEqual(schemaBefore)

      const cleaned = await accounts(pool)
      const cleanedTuples = await tuples(pool)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await accounts(pool)).toEqual(cleaned)
      expect(await tuples(pool)).toEqual(cleanedTuples)
      const sql = await readFile(join(predecessor, migration), 'utf8')
      expect((await pool.query(sql)).rowCount).toBe(0)
      expect(await accounts(pool)).toEqual(cleaned)
      expect(await tuples(pool)).toEqual(cleanedTuples)

      fresh = await createTestDatabase(serverUrl as string, predecessor)
      await seed(fresh.pool, false)
      expect(await accounts(fresh.pool)).toEqual(cleaned)
      expect(await schema(fresh.pool)).toEqual(schemaBefore)
      const ledger = 'SELECT name, checksum FROM schema_migrations ORDER BY name'
      expect((await fresh.pool.query(ledger)).rows).toEqual((await pool.query(ledger)).rows)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  })
})
