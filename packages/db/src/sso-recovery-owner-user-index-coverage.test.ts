import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { ssoFixture } from './sso-storage-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0182_sso_recovery_owner_user_index.sql'
const index = 'sso_recovery_owners_user_id'

async function assertUserIndex(pool: pg.Pool) {
  await expect(
    pool.query(
      `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index
       WHERE indexrelid = to_regclass($1) AND indisready AND indisvalid`,
      [`public.${index}`],
    ),
  ).resolves.toMatchObject({
    rows: [
      { definition: `CREATE INDEX ${index} ON public.sso_recovery_owners USING btree (user_id)` },
    ],
  })
}

async function seedRecoveryOwners(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    const f = await ssoFixture(client)
    await client.query(
      `INSERT INTO sso_policies (organization_id, require_sso, policy_revision)
       VALUES ($1, true, 7), ($2, false, 3)`,
      [f.team, f.otherTeam],
    )
    await client.query(
      `INSERT INTO sso_recovery_owners
         (organization_id, user_id, member_id, nominated_by_user_id, accepted_at)
       VALUES ($1, $2, $3, $4, '2026-06-04T15:04:09.123456Z'),
              ($5, $6, $7, $6, '2026-06-05T16:05:10.234567Z')`,
      [f.team, f.owner, f.ownerMember, f.coOwner, f.otherTeam, f.otherOwner, f.otherOwnerMember],
    )
  } finally {
    client.release()
  }
}

async function recoveryRows(pool: pg.Pool) {
  return (
    await pool.query(`SELECT to_jsonb(owner)::text AS value, xmin::text, ctid::text
      FROM sso_recovery_owners owner ORDER BY organization_id, user_id`)
  ).rows
}

describe.skipIf(!serverUrl)('SSO recovery owner user index', () => {
  it('has a valid user_id index and fails the assertion when it is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertUserIndex,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [`index public.sso_recovery_owners.${index}`, 'covered'],
    ])
  }, 600_000)

  it('bounds the write-lock wait, preserves predecessor rows and matches a fresh install', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-owner-index-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(directory, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_owner_up' })
      await seedRecoveryOwners(upgraded.pool)
      const before = await recoveryRows(upgraded.pool)
      expect(before).toHaveLength(2)
      await copyFile(join(migrationsDir, migration), join(directory, migration))

      const writer = await upgraded.pool.connect()
      try {
        await writer.query('BEGIN')
        await writer.query('LOCK TABLE sso_recovery_owners IN ROW EXCLUSIVE MODE')
        await expect(runMigrations(upgraded.pool, directory)).rejects.toMatchObject({
          cause: { code: '55P03' },
        })
      } finally {
        await writer.query('ROLLBACK').finally(() => writer.release())
      }

      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_owner_new' })
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await recoveryRows(upgraded.pool)).toEqual(before)
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect(await recoveryRows(upgraded.pool)).toEqual(before)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
