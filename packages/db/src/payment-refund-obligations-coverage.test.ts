import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { seedCheckoutHolds } from './payment-checkout-attempt-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { MIGRATION_COVERAGE_TIMEOUT } from './testing/migration-replay.ts'

async function assertRefundProtections(pool: pg.Pool) {
  const [first, second] = await seedCheckoutHolds(pool)
  const firstAttempt = randomUUID()
  const secondAttempt = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO payment_checkout_attempts
        (id, booking_id, account_id, mode, amount_minor, currency, idempotency_key)
       VALUES ($1, $2, 'acct_synthetic', 'test', 5000, 'usd', 'checkout_first'),
              ($3, $4, 'acct_synthetic', 'test', 5000, 'usd', 'checkout_second')`,
      [firstAttempt, first, secondAttempt, second],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })

  const successor = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO bookings (id, organization_id, event_type_id, start_at, end_at, title, source)
       SELECT $1, organization_id, event_type_id, start_at + interval '1 day',
              end_at + interval '1 day', title, source FROM bookings WHERE id = $2`,
      [successor, first],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  const associate = 'UPDATE payment_checkout_attempts SET current_booking_id = $1 WHERE id = $2'
  await expect(pool.query(associate, [successor, firstAttempt])).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(pool.query(associate, [successor, secondAttempt])).rejects.toMatchObject({
    code: '23505',
    constraint: 'payment_checkout_attempts_current_booking_id_key',
  })
  await expect(pool.query(associate, [randomUUID(), secondAttempt])).rejects.toMatchObject({
    code: '23503',
    constraint: 'payment_checkout_attempts_current_booking_id_fkey',
  })
  await expect(pool.query('DELETE FROM bookings WHERE id = $1', [successor])).rejects.toMatchObject(
    {
      code: '23001',
      constraint: 'payment_checkout_attempts_current_booking_id_fkey',
    },
  )

  const refund = randomUUID()
  const another = randomUUID()
  const insert = `INSERT INTO payment_refund_obligations
    (id, attempt_id, account_id, mode, payment_reference, amount_minor, currency)
    VALUES ($1, $2, 'acct_synthetic', 'test', $3, 5000, 'usd')`
  await expect(pool.query(insert, [refund, firstAttempt, 'pi_fixture_one'])).resolves.toMatchObject(
    {
      rowCount: 1,
    },
  )
  for (const [values, constraint, code] of [
    [[refund, secondAttempt, 'pi_fixture_two'], 'pkey', '23505'],
    [[another, firstAttempt, 'pi_fixture_two'], 'attempt_id_key', '23505'],
    [[another, secondAttempt, 'pi_fixture_one'], 'payment_reference_key', '23505'],
    [[another, randomUUID(), 'pi_fixture_two'], 'attempt_id_fkey', '23503'],
  ] as const) {
    await expect(pool.query(insert, [...values])).rejects.toMatchObject({
      code,
      constraint: `payment_refund_obligations_${constraint}`,
    })
  }
  await expect(
    pool.query(insert, [another, secondAttempt, 'pi_fixture_two']),
  ).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query('DELETE FROM payment_checkout_attempts WHERE id = $1', [firstAttempt]),
  ).rejects.toMatchObject({
    code: '23001',
    constraint: 'payment_refund_obligations_attempt_id_fkey',
  })
  await expect(
    pool.query(
      'SELECT state, attempts, first_attempted_at, num_nonnulls(created_at, next_attempt_at) AS timestamps FROM payment_refund_obligations WHERE id = $1',
      [refund],
    ),
  ).resolves.toMatchObject({
    rows: [{ state: 'requested', attempts: 0, first_attempted_at: null, timestamps: 2 }],
  })

  for (const column of [
    'attempt_id',
    'account_id',
    'mode',
    'payment_reference',
    'amount_minor',
    'currency',
    'state',
    'attempts',
    'next_attempt_at',
    'created_at',
  ]) {
    await expect(
      pool.query(`UPDATE payment_refund_obligations SET ${column} = NULL WHERE id = $1`, [refund]),
    ).rejects.toMatchObject({ code: '23502', column })
  }
  for (const [assignment, constraint] of [
    ["mode = 'other'", 'binding'],
    ['amount_minor = 0', 'binding'],
    ["currency = 'USD'", 'binding'],
    ["state = 'succeeded'", 'state'],
    ["stripe_refund_id = 're_fixture'", 'state'],
    ['attempts = 1', 'attempts'],
    ['lease_token = gen_random_uuid()', 'lease'],
  ]) {
    await expect(
      pool.query(`UPDATE payment_refund_obligations SET ${assignment} WHERE id = $1`, [refund]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: `payment_refund_obligations_${constraint}`,
    })
  }
  const saveProviderId = `UPDATE payment_refund_obligations SET state = 'pending',
    stripe_refund_id = 're_fixture' WHERE id = $1`
  await expect(pool.query(saveProviderId, [refund])).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query(saveProviderId, [another])).rejects.toMatchObject({
    code: '23505',
    constraint: 'payment_refund_obligations_stripe_refund_id_key',
  })

  await expect(
    pool.query(
      "INSERT INTO payment_stripe_events (event_id, finding) VALUES ('evt_bad', 'mismatch')",
    ),
  ).rejects.toMatchObject({ code: '23514', constraint: 'payment_stripe_events_finding_shape' })
  await expect(
    pool.query(`INSERT INTO payment_stripe_events
      (event_id, finding, account_id, mode, session_id, payment_reference)
      VALUES ('evt_finding', 'paid_checkout_binding_mismatch', 'acct_synthetic', 'test',
        'cs_test_fixture', 'pi_fixture_two')`),
  ).resolves.toMatchObject({ rowCount: 1 })
  for (const index of [
    'bookings_payment_reconciliation_scan',
    'payment_refund_obligations_due',
    'payment_stripe_events_findings',
  ]) {
    await expect(
      pool.query('SELECT to_regclass($1)::text AS name', [index]),
    ).resolves.toMatchObject({
      rows: [{ name: index }],
    })
  }
}

describe.skipIf(!process.env.DATABASE_URL)('payment refund obligation constraints', () => {
  it(
    'fails an assertion when any 0190 object is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: process.env.DATABASE_URL as string,
        migration: '0190_payment_refund_obligations.sql',
        assertions: assertRefundProtections,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
