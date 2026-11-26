import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { MIGRATION_COVERAGE_TIMEOUT } from './testing/migration-replay.ts'

async function assertEventDeduplication(pool: pg.Pool) {
  const insert = 'INSERT INTO payment_stripe_events (event_id) VALUES ($1)'
  await expect(pool.query(insert, ['evt_test_first'])).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query(insert, ['evt_test_second'])).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query(insert, ['evt_test_first'])).rejects.toMatchObject({
    code: '23505',
    constraint: 'payment_stripe_events_pkey',
  })
}

describe.skipIf(!process.env.DATABASE_URL)('Stripe webhook event receipt constraints', () => {
  it(
    'rejects duplicate event IDs only while the primary key exists',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: process.env.DATABASE_URL as string,
        migration: '0189_stripe_webhook_event_receipts.sql',
        assertions: assertEventDeduplication,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
