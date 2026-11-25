import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { seedCheckoutHolds } from './payment-checkout-attempt-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const migration = '0189_stripe_webhook_event_receipts.sql'

async function paymentData(pool: pg.Pool) {
  const tables = ['bookings', 'booking_attendees', 'booking_hosts', 'payment_checkout_attempts']
  return Promise.all(
    tables.map(
      async (table) =>
        (await pool.query(`SELECT to_jsonb(t)::text AS contents FROM ${table} t ORDER BY contents`))
          .rows,
    ),
  )
}

describe.skipIf(!process.env.DATABASE_URL)('Stripe webhook event receipt migration', () => {
  it('preserves populated hold and Checkout data, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-stripe-webhook-upgrade-'))
    const serverUrl = process.env.DATABASE_URL as string
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await createTestDatabase(serverUrl, directory)
      const [pending, cancelled] = await seedCheckoutHolds(upgraded.pool)
      await upgraded.pool.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp(),
          payment_reference = 'pi_test_late', payment_refund_required = true WHERE id = $1`,
        [cancelled],
      )
      await upgraded.pool.query(
        `INSERT INTO payment_checkout_attempts
          (id, booking_id, account_id, mode, amount_minor, currency, idempotency_key, started_at, session_id)
          VALUES ($1, $2, 'acct_synthetic', 'test', 4500, 'usd', $3, clock_timestamp(), NULL),
                 ($4, $5, 'acct_synthetic', 'test', 5000, 'usd', $6, clock_timestamp(), 'cs_test_late')`,
        [randomUUID(), pending, 'checkout_pending', randomUUID(), cancelled, 'checkout_late'],
      )
      const before = await paymentData(upgraded.pool)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await paymentData(upgraded.pool)).toEqual(before)
      await expect(
        upgraded.pool.query('SELECT event_id FROM payment_stripe_events'),
      ).resolves.toMatchObject({ rows: [] })

      fresh = await createTestDatabase(serverUrl, directory)
      const schema = await snapshotSchema(upgraded.pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      await upgraded.pool.query('INSERT INTO payment_stripe_events VALUES ($1)', ['evt_test_seen'])
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await paymentData(upgraded.pool)).toEqual(before)
      await expect(
        upgraded.pool.query('SELECT event_id FROM payment_stripe_events'),
      ).resolves.toMatchObject({ rows: [{ event_id: 'evt_test_seen' }] })
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
