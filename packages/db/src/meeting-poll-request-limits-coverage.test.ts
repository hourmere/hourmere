import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { attempts } from './meeting-poll-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { MIGRATION_COVERAGE_TIMEOUT } from './testing/migration-replay.ts'

export async function assertRequestLimitProtections(pool: pg.Pool) {
  const first = `INSERT INTO meeting_poll_request_limits VALUES (decode(repeat('ab',32),'hex'),1,now())`
  const results = await attempts(
    pool,
    [
      { sql: first },
      { sql: "UPDATE meeting_poll_request_limits SET key_digest = decode('ab','hex')" },
      { sql: 'UPDATE meeting_poll_request_limits SET hits = 0' },
      { sql: 'UPDATE meeting_poll_request_limits SET hits = NULL' },
      { sql: 'UPDATE meeting_poll_request_limits SET reset_at = NULL' },
    ],
    first,
  )
  expect(
    results.map((error) =>
      error ? [error.code, error.code === '23502' ? error.column : error.constraint] : ['accepted'],
    ),
  ).toEqual([
    ['23505', 'meeting_poll_request_limits_pkey'],
    ['23514', 'meeting_poll_request_limits_digest_length'],
    ['23514', 'meeting_poll_request_limits_positive_hits'],
    ['23502', 'hits'],
    ['23502', 'reset_at'],
  ])
}

describe.skipIf(!process.env.DATABASE_URL)('meeting poll shared request budget schema', () => {
  it(
    'protects every new constraint',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: process.env.DATABASE_URL as string,
        migration: '0108_meeting_poll_request_limits.sql',
        assertions: assertRequestLimitProtections,
      })
      expect(report.problems).toEqual([])
      expect(report.results).toHaveLength(5)
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
