import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import { seedCheckoutHolds } from './payment-checkout-attempt-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

async function assertCheckoutAttemptProtections(pool: pg.Pool) {
  const [booking, otherBooking] = await seedCheckoutHolds(pool)
  const attempt = randomUUID()
  const key = `checkout:${attempt}`
  const insert = `INSERT INTO payment_checkout_attempts
    (id,booking_id,account_id,mode,amount_minor,currency,idempotency_key,started_at,session_id)
    VALUES ($1,$2,'acct_synthetic','test',4500,'usd',$3,clock_timestamp(),$4)`
  await expect(
    pool.query(insert, [attempt, booking, key, 'cs_test_example']),
  ).resolves.toMatchObject({ rowCount: 1 })
  const other = randomUUID()
  const otherKey = `checkout:${other}`
  const insertCases = [
    { values: [attempt, otherBooking, otherKey, null], constraint: 'pkey' },
    { values: [other, booking, otherKey, null], constraint: 'booking_id_key' },
    { values: [other, otherBooking, key, null], constraint: 'idempotency_key_key' },
    { values: [other, otherBooking, otherKey, 'cs_test_example'], constraint: 'session_id_key' },
  ]
  for (const { values, constraint } of insertCases)
    await expect(pool.query(insert, values)).rejects.toMatchObject({
      code: '23505',
      constraint: `payment_checkout_attempts_${constraint}`,
    })

  await expect(pool.query('DELETE FROM bookings WHERE id = $1', [booking])).rejects.toMatchObject({
    code: '23001',
    constraint: 'payment_checkout_attempts_booking_id_fkey',
  })

  const updateCases = [
    { update: 'amount_minor = -1', constraint: 'positive_amount' },
    { update: "currency = 'USD'", constraint: 'currency' },
    { update: "mode = 'other'", constraint: 'mode' },
    { update: 'started_at = NULL', constraint: 'session_started' },
  ]
  for (const { update, constraint } of updateCases)
    await expect(
      pool.query(`UPDATE payment_checkout_attempts SET ${update} WHERE id = $1`, [attempt]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: `payment_checkout_attempts_${constraint}`,
    })

  for (const column of [
    'booking_id',
    'account_id',
    'mode',
    'amount_minor',
    'currency',
    'idempotency_key',
  ])
    await expect(
      pool.query(`UPDATE payment_checkout_attempts SET ${column} = NULL WHERE id = $1`, [attempt]),
    ).rejects.toMatchObject({ code: '23502', column })
}

describe.skipIf(!process.env.DATABASE_URL)('payment Checkout attempt constraints', () => {
  it('fails an assertion when any 0124 object is dropped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-checkout-coverage-'))
    try {
      // The refund migration adds a foreign key to the Checkout attempt primary key.
      // Test each independently in its own coverage suite.
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < '0190')
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      const report = await checkConstraintCoverage({
        serverUrl: process.env.DATABASE_URL as string,
        migration: '0124_payment_checkout_attempts.sql',
        migrationsDirectory: directory,
        assertions: assertCheckoutAttemptProtections,
      })
      expect(report.problems).toEqual([])
    } finally {
      await rm(directory, { recursive: true })
    }
  }, 600_000)
})
