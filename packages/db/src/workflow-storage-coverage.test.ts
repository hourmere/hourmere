import { describe, expect, it } from 'vitest'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  assertWorkflowStorageProtections,
  workflowMigration,
} from './workflow-storage-protections.ts'

const serverUrl = process.env.DATABASE_URL

/** Objects that cannot be dropped alone; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.workflow_definitions.workflow_definitions_organization_id_id':
    'FK target of workflow_revisions_workflow; the primary key already makes it unique, and it cannot be dropped while that FK exists',
  'constraint public.workflow_revisions.workflow_revisions_pkey':
    'FK target of workflow_definitions_current_revision; it cannot be dropped while that FK exists, which keeps the current revision existing',
}

describe.skipIf(!serverUrl)('workflow definition storage constraint coverage', () => {
  it('fails a protection assertion when any object created by 0076 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: workflowMigration,
      assertions: assertWorkflowStorageProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
