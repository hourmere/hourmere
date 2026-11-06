import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0069_sms_delivery_limits.sql'
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function inventory(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}

async function records(pool: pg.Pool, tables: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    const columns = [...table.columns.map(quote), 'xmin::text AS _xmin', 'ctid::text AS _ctid']
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map(({ row }) => row)
  }
  return result
}

describe.skipIf(!serverUrl)('SMS delivery migration', () => {
  it('preserves populated predecessor rows, matches fresh install, and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sms-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'sms_old' })
      await seedEarly(upgraded.pool)
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      const tables = await inventory(upgraded.pool)
      const before = await records(upgraded.pool, tables)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      expect(before['public.booking_notifications']?.length).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool, tables)).toEqual(before)
      expect((await upgraded.pool.query('SELECT * FROM sms_deliveries')).rows).toEqual([])
      const schema = await snapshotSchema(upgraded.pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'sms_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await upgraded.pool.query(ledger)).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool, tables)).toEqual(before)
      expect((await upgraded.pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)
  it('kills source-copy removal of ledger privacy and shape constraints', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'sms_checks',
      migrate: false,
    })
    const source = await readFile(join(migrationsDir, migration), 'utf8')
    const cases: [string, string, Record<string, unknown>][] = [
      ['octet_length(key_hash) = 32', 'true', { key_hash: Buffer.alloc(31) }],
      ['octet_length(request_hash) = 32', 'true', { request_hash: Buffer.alloc(31) }],
      ['octet_length(recipient_hash) = 32', 'true', { recipient_hash: Buffer.alloc(31) }],
      [
        "status IN ('dispatching','accepted','failed','unknown','expired')",
        'true',
        { status: 'invalid' },
      ],
      ["recipient_mask ~ '^\\+\\*{4}[0-9]{2}$'", 'true', { recipient_mask: '+14155550123' }],
      [
        'num_nonnulls(request_hash,recipient_hash,recipient_mask,organization_id,provider_message_id) = 0',
        'true',
        { status: 'expired' },
      ],
      [
        'num_nonnulls(request_hash,recipient_hash,recipient_mask,organization_id) = 4',
        'true',
        { request_hash: null },
      ],
      [
        "provider_message_id IS NULL OR status = 'accepted'",
        'true',
        { provider_message_id: 'SMsynthetic' },
      ],
    ]
    try {
      for (const [before, after, changes] of cases) {
        expect(source).toContain(before)
        const invalid = async () => {
          const row = {
            key_hash: Buffer.alloc(32),
            request_hash: Buffer.alloc(32),
            recipient_hash: Buffer.alloc(32),
            recipient_mask: '+****23',
            organization_id: '00000000-0000-4000-8000-000000000001',
            provider_message_id: null,
            status: 'dispatching',
            ...changes,
          }
          await expect(
            owned.pool.query(
              `INSERT INTO sms_deliveries (${Object.keys(row).join(',')}) VALUES (${Object.values(
                row,
              )
                .map((_, index) => `$${index + 1}`)
                .join(',')})`,
              Object.values(row),
            ),
          ).rejects.toMatchObject({ code: '23514' })
        }
        for (const mutant of [false, true, false]) {
          await owned.pool.query('DROP TABLE IF EXISTS sms_deliveries')
          await owned.pool.query(mutant ? source.replace(before, after) : source)
          if (mutant)
            await expect(invalid(), before).rejects.toMatchObject({ name: 'AssertionError' })
          else await invalid()
        }
      }
    } finally {
      await owned.drop()
    }
  }, 30_000)
})
