import { describe, expect, it } from 'vitest'
import { assertChangeDeadlineProtections } from './change-deadlines-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { MIGRATION_COVERAGE_TIMEOUT } from './testing/migration-replay.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('change deadline constraint coverage', () => {
  it(
    'fails a protection assertion when any object created by 0089 is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration: '0089_change_deadlines.sql',
        assertions: assertChangeDeadlineProtections,
      })
      expect(report.problems).toEqual([])
      expect(report.objects.map((object) => object.key).sort()).toEqual([
        'constraint public.bookings.bookings_cancel_cutoff_range',
        'constraint public.bookings.bookings_reschedule_cutoff_range',
        'constraint public.event_types.event_types_cancel_cutoff_range',
        'constraint public.event_types.event_types_reschedule_cutoff_range',
      ])
      expect(report.results.map((result) => result.status)).toEqual(Array(4).fill('covered'))
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
