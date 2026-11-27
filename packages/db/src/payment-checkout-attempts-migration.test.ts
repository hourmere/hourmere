import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { seedCheckoutHolds } from './payment-checkout-attempt-fixtures.ts'
import { MIGRATION_REPLAY_TIMEOUT, useMigrationReplay } from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

vi.setConfig({ testTimeout: MIGRATION_REPLAY_TIMEOUT, hookTimeout: MIGRATION_REPLAY_TIMEOUT })

const migration = '0124_payment_checkout_attempts.sql'

async function retainedData(pool: pg.Pool) {
  return Promise.all(
    [
      'auth."user"',
      'auth.organization',
      'event_types',
      'bookings',
      'booking_attendees',
      'booking_hosts',
    ].map(
      async (table) =>
        (
          await pool.query(
            `SELECT to_jsonb(t)::text AS contents, xmin::text, ctid::text FROM ${table} t ORDER BY contents`,
          )
        ).rows,
    ),
  )
}

describe.skipIf(!process.env.DATABASE_URL)('payment Checkout attempts migration', () => {
  const replay = useMigrationReplay(process.env.DATABASE_URL as string, migration)

  it('preserves existing payment holds, matches a fresh install and reruns without changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-checkout-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = await readdir(migrationsDir)
      for (const file of files.filter((file) => file.endsWith('.sql') && file < migration))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await replay.predecessor.clone(directory)
      const [pending, cancelled] = await seedCheckoutHolds(upgraded.pool)
      await upgraded.pool.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp(),
          payment_reference = 'pi_synthetic_late', payment_refund_required = true WHERE id = $1`,
        [cancelled],
      )
      expect(
        (await upgraded.pool.query('SELECT status FROM bookings WHERE id = $1', [pending])).rows,
      ).toEqual([{ status: 'pending_payment' }])
      const before = await retainedData(upgraded.pool)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await retainedData(upgraded.pool)).toEqual(before)
      await expect(
        upgraded.pool.query('SELECT * FROM payment_checkout_attempts'),
      ).resolves.toMatchObject({
        rows: [],
      })

      fresh = await replay.predecessor.clone(directory)
      const schema = await snapshotSchema(upgraded.pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await retainedData(upgraded.pool)).toEqual(before)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
