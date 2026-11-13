import { describe, expect, it } from 'vitest'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  assertExecutionStorageProtections,
  executionMigration,
} from './workflow-storage-execution-protections.ts'

const serverUrl = process.env.DATABASE_URL

/** Objects that cannot be dropped alone; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.workflow_enrollments.workflow_enrollments_booking_key':
    'FK target of workflow_runs_enrollment; the primary key already makes it unique, and it cannot be dropped while that FK exists',
  'constraint public.workflow_runs.workflow_runs_booking_key':
    'FK target of workflow_recipient_claims_run; the primary key already makes it unique, and it cannot be dropped while that FK exists',
}

describe.skipIf(!serverUrl)('workflow execution storage constraint coverage', () => {
  it('fails a protection assertion when any object created by 0079 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: executionMigration,
      assertions: assertExecutionStorageProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
