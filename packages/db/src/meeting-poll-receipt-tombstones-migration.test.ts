import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { digest, fixture, insert } from './meeting-poll-protections.ts'
import {
  assertMeetingPollReceiptTombstoneProtections,
  CLEARED_FINGERPRINT,
  RECEIPT_OPERATIONS,
} from './meeting-poll-receipt-tombstones-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0088_meeting_poll_receipt_tombstones.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Every row of every table as JSON, except receipts, which the migration may change. */
async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(
      `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
       WHERE table_schema IN ('public','auth') AND table_type='BASE TABLE'
         AND table_name NOT IN ('schema_migrations','meeting_poll_operations') ORDER BY 1,2`,
    )
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT to_jsonb(t)::text, xmin::text, ctid::text FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows
  return result
}

const receipts = async (pool: pg.Pool) =>
  (await pool.query('SELECT * FROM meeting_poll_operations ORDER BY id')).rows as Record<
    string,
    unknown
  >[]

/** A live poll and a deleted one, each with a receipt of every operation. */
async function seedReceipts(pool: pg.Pool) {
  const polls = [await fixture(pool), await fixture(pool)]
  for (const f of polls)
    for (const operation of RECEIPT_OPERATIONS)
      await insert(pool, 'meeting_poll_operations', {
        organization_id: f.organization,
        poll_id: f.poll,
        operation,
        actor_scope_digest: digest(),
        idempotency_key_digest: digest(),
        request_fingerprint: digest(),
      })
  // Deleted under the previous trigger: its tombstones still hold every fingerprint.
  await pool.query('DELETE FROM meeting_polls WHERE id=$1', [polls[1]?.poll])
}

describe.skipIf(!serverUrl)('meeting poll receipt tombstone migration', () => {
  it('clears old non-create tombstone fingerprints only, equals a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-poll-receipts-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of files.filter((file) => file < '0013'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(upgraded.pool)
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedReceipts(upgraded.pool)
      const pool = upgraded.pool
      const before = await records(pool)
      const receiptsBefore = await receipts(pool)
      const tombstones = receiptsBefore.filter((row) => row.poll_id === null)
      expect(tombstones).toHaveLength(RECEIPT_OPERATIONS.length)
      for (const row of tombstones)
        expect(row.request_fingerprint, 'the old trigger kept it').not.toEqual(CLEARED_FINGERPRINT)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool)).toEqual(before)
      // Live receipts and the create tombstone are untouched; other tombstones are cleared.
      expect(await receipts(pool)).toEqual(
        receiptsBefore.map((row) =>
          row.poll_id === null && row.operation !== 'create'
            ? { ...row, request_fingerprint: CLEARED_FINGERPRINT }
            : row,
        ),
      )

      fresh = await createTestDatabase(serverUrl as string, directory)
      const schema = await snapshotSchema(pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const settled = await receipts(pool)
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records(pool)).toEqual(before)
      expect(await receipts(pool)).toEqual(settled)
      await assertMeetingPollReceiptTombstoneProtections(pool)
      await assertMeetingPollReceiptTombstoneProtections(fresh.pool)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
