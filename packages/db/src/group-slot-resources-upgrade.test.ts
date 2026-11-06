import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupFixture, insertSeat, insertSlot, transaction } from './group-seats-fixtures.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('slot resource upgrade', () => {
  it('preserves populated predecessor seats, backfills immutable location and matches fresh/no-op schemas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-slot-resource-predecessor-'))
    let old: TestDatabase | undefined, fresh: TestDatabase | undefined
    try {
      for (const name of await readdir(migrationsDir))
        if (name.endsWith('.sql') && name < '0061')
          await copyFile(join(migrationsDir, name), join(directory, name))
      old = await createTestDatabase(serverUrl as string, directory)
      expect(
        (await old.pool.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'))
          .rows,
      ).toEqual([{ name: '0060_calcom_import_state.sql' }])
      const f = await groupFixture(old.pool)
      const location = { kind: 'link', url: 'https://example.test/shared' }
      const ids = await transaction(old.pool, async (client) => {
        const slot = await insertSlot(client, f, {
          location,
          created_at: '2030-01-01T01:02:03.123456Z',
          updated_at: '2030-01-02T01:02:03.654321Z',
        })
        await client.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
          slot,
          f.host,
        ])
        const first = await insertSeat(client, f, slot, 'first@example.test', {
          location,
          responses: { topic: 'Private answer' },
        })
        const second = await insertSeat(client, f, slot, 'second@example.test', { location })
        return { slot, first, second }
      })
      const before = (
        await old.pool.query('SELECT to_jsonb(b)::text AS row FROM bookings b ORDER BY id')
      ).rows
      const hosts = (
        await old.pool.query('SELECT to_jsonb(h)::text AS row FROM booking_hosts h ORDER BY id')
      ).rows
      const slots = (
        await old.pool.query('SELECT to_jsonb(s)::text AS row FROM group_slots s ORDER BY id')
      ).rows
      expect(await runMigrations(old.pool)).toEqual(
        (await readdir(migrationsDir))
          .filter((name) => name.endsWith('.sql') && name >= '0061')
          .sort(),
      )
      expect(
        (
          await old.pool.query(
            "SELECT (to_jsonb(s)-'location_option'-'ical_organizer_name'-'ical_organizer_email')::text AS row FROM group_slots s ORDER BY id",
          )
        ).rows,
      ).toEqual(slots)
      expect(
        (await old.pool.query('SELECT to_jsonb(b)::text AS row FROM bookings b ORDER BY id')).rows,
      ).toEqual(before)
      expect(
        (await old.pool.query('SELECT to_jsonb(h)::text AS row FROM booking_hosts h ORDER BY id'))
          .rows,
      ).toEqual(hosts)
      expect(
        (await old.pool.query('SELECT location_option FROM group_slots WHERE id=$1', [ids.slot]))
          .rows,
      ).toEqual([{ location_option: { id: 'legacy', ...location } }])
      await expect(
        old.pool.query('UPDATE group_slots SET location_option=NULL WHERE id=$1', [ids.slot]),
      ).rejects.toMatchObject({ constraint: 'group_slot_location_option_immutable' })
      await expect(
        transaction(old.pool, (client) =>
          insertSeat(client, f, ids.slot, 'third@example.test', {
            location: { kind: 'link', url: 'https://example.test/different' },
          }),
        ),
      ).rejects.toMatchObject({ constraint: 'group_seat_location_option' })
      await transaction(old.pool, (client) =>
        insertSeat(client, f, ids.slot, 'third@example.test', { location }),
      )
      const after = await snapshotSchema(old.pool)
      await runMigrations(old.pool)
      expect(await snapshotSchema(old.pool)).toEqual(after)
      fresh = await createTestDatabase(serverUrl as string)
      expect(await snapshotSchema(fresh.pool)).toEqual(after)
    } finally {
      await old?.drop()
      await fresh?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
