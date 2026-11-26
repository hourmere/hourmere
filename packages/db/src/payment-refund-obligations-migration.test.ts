import { randomUUID } from 'node:crypto'
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

const migration = '0190_payment_refund_obligations.sql'

async function existingData(pool: pg.Pool) {
  const tables = [
    ['bookings', ''],
    ['booking_attendees', ''],
    ['booking_hosts', ''],
    ['payment_checkout_attempts', " - 'current_booking_id'"],
    [
      'payment_stripe_events',
      " - ARRAY['finding', 'account_id', 'mode', 'session_id', 'payment_reference']",
    ],
  ]
  return Promise.all(
    tables.map(
      async ([table, additions]) =>
        (
          await pool.query(
            `SELECT (to_jsonb(t)${additions})::text AS contents FROM ${table} t ORDER BY contents`,
          )
        ).rows,
    ),
  )
}

describe.skipIf(!process.env.DATABASE_URL)('payment refund obligation migration', () => {
  const replay = useMigrationReplay(process.env.DATABASE_URL as string, migration)

  it('keeps predecessor records and backfills only bound late payments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-refunds-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await replay.predecessor.clone(directory)
      const [bound, unbound] = await seedCheckoutHolds(upgraded.pool)
      await upgraded.pool.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp(),
          payment_reference = CASE WHEN id = $1 THEN 'pi_fixture_bound' ELSE 'pi_fixture_unbound' END,
          payment_refund_required = true WHERE id IN ($1, $2)`,
        [bound, unbound],
      )
      const boundAttempt = randomUUID()
      await upgraded.pool.query(
        `INSERT INTO payment_checkout_attempts
          (id, booking_id, account_id, mode, amount_minor, currency, idempotency_key, started_at, session_id)
          VALUES ($1, $2, 'acct_synthetic', 'test', 5000, 'usd', 'checkout_bound', clock_timestamp(),
                  'cs_fixture_bound'),
                 ($3, $4, 'acct_synthetic', 'test', 6000, 'usd', 'checkout_unbound', clock_timestamp(),
                  NULL)`,
        [boundAttempt, bound, randomUUID(), unbound],
      )
      await upgraded.pool.query('INSERT INTO payment_stripe_events (event_id) VALUES ($1)', [
        'evt_fixture_seen',
      ])
      const before = await existingData(upgraded.pool)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await existingData(upgraded.pool)).toEqual(before)
      await expect(
        upgraded.pool.query('SELECT * FROM payment_refund_obligations'),
      ).resolves.toMatchObject({
        rows: [
          {
            attempt_id: boundAttempt,
            account_id: 'acct_synthetic',
            mode: 'test',
            payment_reference: 'pi_fixture_bound',
            amount_minor: 5000,
            currency: 'usd',
            state: 'requested',
            stripe_refund_id: null,
            attempts: 0,
          },
        ],
      })
      await expect(
        upgraded.pool.query('SELECT current_booking_id FROM payment_checkout_attempts'),
      ).resolves.toMatchObject({
        rows: [{ current_booking_id: null }, { current_booking_id: null }],
      })

      fresh = await replay.predecessor.clone(directory)
      const schema = await snapshotSchema(fresh.pool)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      await expect(
        fresh.pool.query('SELECT id FROM payment_refund_obligations'),
      ).resolves.toMatchObject({
        rows: [],
      })
      const obligations = (await upgraded.pool.query('SELECT * FROM payment_refund_obligations'))
        .rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await existingData(upgraded.pool)).toEqual(before)
      expect((await upgraded.pool.query('SELECT * FROM payment_refund_obligations')).rows).toEqual(
        obligations,
      )
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
})
