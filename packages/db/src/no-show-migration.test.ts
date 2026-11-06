import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0062_attendee_no_show.sql'
describe.skipIf(!serverUrl)('attendee no-show migration', () => {
  it('preserves predecessor records, installs fresh, reruns without writes, and enforces paired markers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-no-show-'))
    let old: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      old = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(old.pool)
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(old.pool, directory)
      await seedLater(old.pool)
      const pool = old.pool
      const snapshot = async () =>
        (
          await pool.query(
            `SELECT to_jsonb(a)-'no_show_marked_at'-'no_show_marked_by' AS row FROM booking_attendees a ORDER BY id`,
          )
        ).rows
      const webhookSnapshot = async () => ({
        hooks: (await pool.query('SELECT to_jsonb(w) AS row FROM webhooks w ORDER BY id')).rows,
        deliveries: (
          await pool.query('SELECT to_jsonb(w) AS row FROM webhook_deliveries w ORDER BY id')
        ).rows,
      })
      const webhookBefore = await webhookSnapshot()
      expect(webhookBefore.hooks.length).toBeGreaterThan(0)
      expect(webhookBefore.deliveries.length).toBeGreaterThan(0)
      const before = await snapshot()
      expect(before.length).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(old.pool, directory)).toEqual([migration])
      expect(await snapshot()).toEqual(before)
      expect(await webhookSnapshot()).toEqual(webhookBefore)
      expect(
        (
          await old.pool.query(
            'SELECT count(*)::int AS n FROM booking_attendees WHERE no_show_marked_at IS NOT NULL OR no_show_marked_by IS NOT NULL',
          )
        ).rows,
      ).toEqual([{ n: 0 }])
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(fresh.pool)).toEqual(await snapshotSchema(old.pool))
      const ledger = (await old.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows
      expect(await runMigrations(old.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshot()).toEqual(before)
      expect(await webhookSnapshot()).toEqual(webhookBefore)
      expect((await old.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(
        ledger,
      )
      await expect(
        old.pool.query('UPDATE booking_attendees SET no_show_marked_at=now()'),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        old.pool.query('UPDATE booking_attendees SET no_show_marked_by=gen_random_uuid()'),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        pool.query(`INSERT INTO webhook_deliveries (webhook_id,organization_id,booking_id,event_id,event_type,payload)
        SELECT webhook_id,organization_id,booking_id,gen_random_uuid(),event_type,payload FROM webhook_deliveries LIMIT 1`),
      ).rejects.toMatchObject({ code: '23505' })
      await pool.query(`INSERT INTO webhook_deliveries (webhook_id,organization_id,booking_id,event_id,event_type,payload)
        SELECT webhook_id,organization_id,booking_id,gen_random_uuid(),'booking.attendee_no_show_changed',payload FROM webhook_deliveries LIMIT 1`)
      await pool.query(`INSERT INTO webhook_deliveries (webhook_id,organization_id,booking_id,event_id,event_type,payload)
        SELECT webhook_id,organization_id,booking_id,gen_random_uuid(),'booking.attendee_no_show_changed',payload FROM webhook_deliveries LIMIT 1`)
    } finally {
      await fresh?.drop()
      await old?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
})
