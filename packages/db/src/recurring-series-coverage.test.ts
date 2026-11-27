import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertRecurringSeriesProtections,
  assertSeriesCompleteness,
  assertSeriesOrdinals,
  assertSeriesScope,
} from './recurring-series-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { MIGRATION_COVERAGE_TIMEOUT } from './testing/migration-replay.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0126_recurring_series.sql'
const allowList = {
  'constraint public.booking_series.booking_series_organization_id_id_key':
    'Foreign-key target for occurrences; the primary key already makes the ID unique.',
  'constraint public.booking_series_occurrences.booking_series_occurrences_organization_id_id_key':
    'Foreign-key target for booking membership; the primary key already makes the ID unique.',
}

describe.skipIf(!serverUrl)('recurring series protections', () => {
  let database: TestDatabase | undefined
  let pool: pg.Pool

  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_guards' })
    pool = database.pool
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('rejects cross-organization and cross-member references', async () => {
    await assertSeriesScope(pool)
  })

  it('rejects duplicate occurrence ordinals and duplicate confirmed members', async () => {
    await assertSeriesOrdinals(pool)
  })

  it('rejects incomplete series at commit', async () => {
    await assertSeriesCompleteness(pool)
  })
})

describe.skipIf(!serverUrl)('recurring series constraint coverage', () => {
  it(
    'fails a protection assertion when any independently protective object is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        assertions: assertRecurringSeriesProtections,
        allowList,
      })
      expect(report.problems).toEqual([])
      expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
        report.objects.length - Object.keys(allowList).length,
      )
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
