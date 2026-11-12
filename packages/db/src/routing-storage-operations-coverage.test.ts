import { describe, expect, it } from 'vitest'
import {
  assertRoutingOperationProtections,
  operationsMigration,
} from './routing-storage-operations-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('routing form operation constraint coverage', () => {
  it('fails a protection assertion when any object created by 0083 is dropped', async () => {
    // Nothing references the operations table, so every object can be dropped alone and none
    // is allow-listed.
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: operationsMigration,
      assertions: assertRoutingOperationProtections,
      allowList: {},
    })
    expect(report.problems).toEqual([])
    expect(report.objects).toHaveLength(18)
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length,
    )
  }, 600_000)
})
