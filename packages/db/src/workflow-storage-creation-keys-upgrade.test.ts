import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'
import {
  assertCreationKeyProtections,
  creationKeyMigration,
  creationKeyTable,
} from './workflow-storage-creation-keys-protections.ts'
import { revisionContent } from './workflow-storage-protections.ts'

const serverUrl = process.env.DATABASE_URL
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

// Every row of every table, with its tuple identity: a rewrite or an in-place update of an
// existing row changes xmin or ctid even when the values stay the same.
async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
      AND table_name <> 'schema_migrations' ORDER BY table_schema,table_name`)
  ).rows
  const rows: Record<string, unknown[]> = {}
  for (const table of tables)
    rows[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT value,xmin,ctid FROM (SELECT to_jsonb(t)::text AS value,xmin::text,ctid::text
        FROM ${quote(table.schema)}.${quote(table.name)} t) r ORDER BY value COLLATE "C"`,
      )
    ).rows
  return rows
}

// Workflow definitions of 0076 with their revisions (an enabled team workflow at revision 2, a
// personal one and a tombstone), and execution rows of 0079 that name them: a history record
// and a mail reservation.
async function seedWorkflows(pool: pg.Pool) {
  const personal = (
    await pool.query<{ organization: string; user: string }>(
      `SELECT organization_id AS organization,user_id AS user FROM personal_organizations
      ORDER BY user_id LIMIT 1`,
    )
  ).rows[0] as { organization: string; user: string }
  const team = (
    await pool.query<{ id: string }>(
      `SELECT id FROM auth.organization o WHERE NOT EXISTS
        (SELECT FROM personal_organizations p WHERE p.organization_id=o.id) ORDER BY id LIMIT 1`,
    )
  ).rows[0]?.id as string
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const define = async (organization: string, owner: string | null, revisions: number) => {
      const id = (
        await client.query<{ id: string }>(
          'INSERT INTO workflow_definitions (organization_id,owner_user_id) VALUES ($1,$2) RETURNING id',
          [organization, owner],
        )
      ).rows[0]?.id as string
      for (let revision = 1; revision <= revisions; revision++)
        await client.query(
          'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,$3,$4)',
          [
            organization,
            id,
            revision,
            JSON.stringify(revisionContent({ name: `Synthetic upgrade workflow ${revision}` })),
          ],
        )
      return id
    }
    const enabled = await define(team, null, 2)
    await client.query('UPDATE workflow_definitions SET enabled=true WHERE id=$1', [enabled])
    await define(personal.organization, personal.user, 1)
    const deleted = await define(team, null, 1)
    await client.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [deleted])
    await client.query(
      `INSERT INTO workflow_run_history (run_id,organization_id,workflow_id,revision,trigger,
        due_at,finished_at,outcome,sent) VALUES ($1,$2,$3,2,'before_start',
        now()-interval '2 hours',now()-interval '1 hour','completed',1)`,
      [randomUUID(), team, enabled],
    )
    await client.query(
      `INSERT INTO workflow_mail_reservations (organization_id,run_id,claim_id,reserved_at)
      VALUES ($1,$2,$3,now()-interval '1 hour')`,
      [team, randomUUID(), randomUUID()],
    )
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

describe.skipIf(!serverUrl)('workflow creation key storage upgrade', () => {
  it('preserves every predecessor row, matches a fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-key-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-workflow-key-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      // Every migration before 0087: the predecessor schema, whatever lower numbers main has.
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < creationKeyMigration)
        .sort()
      expect(files).toContain('0079_workflow_execution.sql')
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early, { tag: 'wf_key_upgrade' })
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedWorkflows(upgraded.pool)
      const pool = upgraded.pool

      const before = await records(pool)
      for (const table of [
        'auth.user',
        'auth.organization',
        'auth.apikey',
        'public.personal_organizations',
        'public.event_types',
        'public.bookings',
        'public.workflow_definitions',
        'public.workflow_revisions',
        'public.workflow_run_history',
        'public.workflow_mail_reservations',
      ])
        expect(before[table]?.length, table).toBeGreaterThan(0)
      expect(before['public.workflow_definitions']).toHaveLength(3)
      expect(before['public.workflow_revisions']).toHaveLength(4)
      expect(before[`public.${creationKeyTable}`]).toBeUndefined()
      const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows

      await copyFile(
        join(migrationsDir, creationKeyMigration),
        join(directory, creationKeyMigration),
      )
      expect(await runMigrations(pool, directory)).toEqual([creationKeyMigration])
      // Every predecessor row is unchanged, down to its tuple, and the new table is empty: no
      // existing definition gets a key.
      const after = await records(pool)
      expect(after[`public.${creationKeyTable}`]).toEqual([])
      const { [`public.${creationKeyTable}`]: _keys, ...kept } = after
      expect(kept).toEqual(before)
      expect(
        (
          await pool.query('SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name', [
            creationKeyMigration,
          ])
        ).rows,
      ).toEqual(ledger)

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'wf_key_fresh' })
      const schema = await snapshotSchema(pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(JSON.stringify(schema)).toContain('workflow_creation_keys_scope')

      const ledgerAfter = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await records(pool)).toEqual(after)
      expect((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(
        ledgerAfter,
      )
      // The upgraded and the fresh database enforce the same protections.
      await assertCreationKeyProtections(pool)
      await assertCreationKeyProtections(fresh.pool)
      expect(pool.totalCount).toBeLessThanOrEqual(3)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(3)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
      await rm(early, { recursive: true, force: true })
    }
  }, 180_000)
})
