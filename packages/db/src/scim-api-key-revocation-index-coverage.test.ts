import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CompiledQuery, Kysely, PostgresDialect } from 'kysely'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { Database } from './index.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { suspendScimMembership } from './scim-suspension.ts'
import { prepareScimSuspension } from './scim-suspension-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0178_scim_api_key_revocation_index.sql'
const index = 'apikey_scim_revocation_idx'
const organizationId = 'abcdef01-0000-4000-8000-000000000001'
const userId = 'abcdef01-0000-4000-8000-000000000002'
const otherUser = 'abcdef01-0000-4000-8000-000000000003'
const otherTeam = 'abcdef01-0000-4000-8000-000000000004'

async function seed(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES
       ($1, 'Member', 'member@example.test', true),
       ($2, 'Owner', 'owner@example.test', true)`,
    [userId, otherUser],
  )
  await pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt") VALUES
       ($1, 'Managed team', 'scim-index-team', now()),
       ($2, 'Other team', 'scim-index-other', now())`,
    [organizationId, otherTeam],
  )
  await pool.query(
    `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES
       ($1, $2, 'member', now()), ($1, $3, 'owner', now()),
       ($4, $2, 'owner', now())`,
    [organizationId, userId, otherUser, otherTeam],
  )
  const rows = [
    ['Managed', userId.toUpperCase(), organizationId.toUpperCase(), 'bookings'],
    ['Other team', userId, otherTeam, 'read'],
    ['Other member', otherUser, organizationId, 'full'],
    ['Legacy personal', userId, null, 'full'],
  ] as const
  for (const [name, owner, team, scope] of rows) {
    await pool.query(
      `INSERT INTO auth.apikey
         (name, "configId", "referenceId", key, enabled, "requestCount", "createdAt", "updatedAt", metadata)
       VALUES ($1, 'default', $2, encode(sha256(convert_to($1, 'UTF8')), 'hex'), true, 7,
         '2026-01-02T03:04:05.123456Z', '2026-01-03T01:02:03.654321Z', $3)`,
      [name, owner, JSON.stringify({ scope, ...(team && { organizationId: team }) })],
    )
  }
  // An unrecognized legacy organization value can occupy more than a btree tuple.
  await pool.query(
    `INSERT INTO auth.apikey
       (name, "configId", "referenceId", key, "createdAt", "updatedAt", metadata)
     SELECT 'Legacy organization', 'default', $1, 'synthetic-legacy-hash', now(), now(),
       jsonb_build_object('scope', 'full', 'organizationId', string_agg(gen_random_uuid()::text, ''))::text
     FROM generate_series(1, 200)`,
    [userId],
  )
}

async function keyRows(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT name, encode(sha256(convert_to(to_jsonb(key_row)::text, 'UTF8')), 'hex') AS fingerprint,
         xmin::text, ctid::text FROM auth.apikey key_row ORDER BY name`,
    )
  ).rows
}

async function assertRevocationIndex(pool: pg.Pool) {
  await seed(pool)
  // Other teams and accounts must not make the actual revocation statement scan the table.
  await pool.query(`INSERT INTO auth.apikey
      ("configId", "referenceId", key, "createdAt", "updatedAt", metadata)
    SELECT 'default', gen_random_uuid()::text, 'synthetic-hash-' || n, now(), now(),
      jsonb_build_object('scope', 'full', 'organizationId', gen_random_uuid())::text
    FROM generate_series(1, 2000) n`)
  await pool.query('ANALYZE auth.apikey')

  let deletion: CompiledQuery | undefined
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log(event) {
      if (event.level === 'query' && event.query.sql.startsWith('delete from "auth"."apikey"'))
        deletion = event.query
    },
  })
  await db.transaction().execute(async (trx) => {
    const target = await prepareScimSuspension(trx, organizationId, userId)
    await suspendScimMembership(trx, target, { type: 'system' })
  })
  if (!deletion) throw new Error('Missing API key revocation statement')
  const plan = (
    await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${deletion.sql}`, [
      ...deletion.parameters,
    ])
  ).rows.map((row) => row['QUERY PLAN'])
  expect(plan.join('\n')).toContain(index)
  const condition = plan.find((line) => line.includes('Index Cond:'))
  expect(condition).toContain('lower("referenceId")')
  expect(condition).toContain("metadata)::jsonb ->> 'organizationId'")
  expect(
    (await pool.query('SELECT name FROM auth.apikey WHERE name IS NOT NULL ORDER BY name')).rows,
  ).toEqual([
    { name: 'Legacy organization' },
    { name: 'Legacy personal' },
    { name: 'Other member' },
    { name: 'Other team' },
  ])
}

describe.skipIf(!serverUrl)('SCIM API key revocation index', () => {
  it('uses the index for both revocation predicates and fails the plan assertion when dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertRevocationIndex,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [`index auth.apikey.${index}`, 'covered'],
    ])
  }, 600_000)

  it('preserves populated predecessor keys, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-key-index-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(directory, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'scim_key_up' })
      await seed(upgraded.pool)
      const before = await keyRows(upgraded.pool)
      expect(before).toHaveLength(5)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'scim_key_new' })
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await keyRows(upgraded.pool)).toEqual(before)
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect(await keyRows(upgraded.pool)).toEqual(before)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
