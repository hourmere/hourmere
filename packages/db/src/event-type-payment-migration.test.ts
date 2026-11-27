import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { seedCheckoutHolds } from './payment-checkout-attempt-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const migration = '0191_event_type_payment.sql'

describe.skipIf(!process.env.DATABASE_URL)('event type payment migration', () => {
  it('keeps existing event settings and booking rows, and matches a fresh install', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-event-price-upgrade-'))
    const serverUrl = process.env.DATABASE_URL as string
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await createTestDatabase(serverUrl, directory)
      await seedCheckoutHolds(upgraded.pool)
      await upgraded.pool.query(
        `UPDATE event_types SET allowed_durations_minutes = ARRAY[20,30,45],
         description = 'Pick a time for a technical consultation', minimum_notice_minutes = 90,
         buffer_before_minutes = 15 WHERE slug = 'consultation'`,
      )
      const eventBefore = await upgraded.pool.query(
        'SELECT to_jsonb(event) AS data FROM event_types event',
      )
      const bookingRows = 'SELECT to_jsonb(booking) AS data FROM bookings booking ORDER BY id'
      const bookingsBefore = await upgraded.pool.query(bookingRows)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      const eventAfter = await upgraded.pool.query(
        "SELECT to_jsonb(event) - 'payment' AS data, payment FROM event_types event",
      )
      expect(eventAfter.rows).toEqual(eventBefore.rows.map((row) => ({ ...row, payment: null })))
      expect((await upgraded.pool.query(bookingRows)).rows).toEqual(bookingsBefore.rows)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      fresh = await createTestDatabase(serverUrl, directory)
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
    } finally {
      await upgraded?.drop()
      await fresh?.drop()
      await rm(directory, { recursive: true })
    }
  }, 90_000)
})
