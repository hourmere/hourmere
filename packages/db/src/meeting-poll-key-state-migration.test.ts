import { randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { assertMeetingPollKeyStateProtections } from './meeting-poll-key-state-protections.ts'
import { fixture, insert } from './meeting-poll-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0084_meeting_poll_key_state.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Every row of every table, with its physical version, except the table 0084 adds. */
async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(
      `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
       WHERE table_schema IN ('public','auth') AND table_type='BASE TABLE'
         AND table_name NOT IN ('schema_migrations','meeting_poll_key_state') ORDER BY 1,2`,
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

/** Keyed meeting-poll data as the previous version stores it: voters, a counter and mail. */
async function seedMeetingPolls(pool: pg.Pool) {
  const f = await fixture(pool)
  await insert(pool, 'meeting_poll_mailbox_counters', {
    organization_id: f.organization,
    poll_id: f.poll,
    email_key: f.voterValues.email_key,
  })
  await insert(pool, 'meeting_poll_deliveries', {
    organization_id: f.organization,
    poll_id: f.poll,
    voter_id: f.voter,
    kind: 'invitation',
    capability_ciphertext: randomBytes(64),
  })
}

describe.skipIf(!serverUrl)('meeting poll key state migration', () => {
  it('keeps populated poll data, records no key, equals a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-poll-key-'))
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
      await seedMeetingPolls(upgraded.pool)
      const pool = upgraded.pool
      const before = await records(pool)
      for (const table of [
        'auth.user',
        'public.bookings',
        'public.meeting_polls',
        'public.meeting_poll_voters',
        'public.meeting_poll_mailbox_counters',
        'public.meeting_poll_deliveries',
      ])
        expect(before[table]?.length, table).toBeGreaterThan(0)
      const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool)).toEqual(before)
      // The migration records no key: the first fence use after it does.
      expect((await pool.query('SELECT * FROM meeting_poll_key_state')).rows).toEqual([])
      expect(
        (
          await pool.query('SELECT * FROM schema_migrations WHERE name <> $1 ORDER BY name', [
            migration,
          ])
        ).rows,
      ).toEqual(ledger)

      fresh = await createTestDatabase(serverUrl as string, directory)
      const schema = await snapshotSchema(pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records(pool)).toEqual(before)
      expect(await snapshotSchema(pool)).toEqual(schema)
      await assertMeetingPollKeyStateProtections(pool)
      await assertMeetingPollKeyStateProtections(fresh.pool)
      expect((await pool.query('SELECT * FROM meeting_poll_key_state')).rows).toEqual([])
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
