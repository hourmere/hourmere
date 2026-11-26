import { describe, expect, it } from 'vitest'
import { assertOwnershipTransferAuditProtections } from './ownership-transfer-audit-protections.ts'
import { assertOwnershipTransferStorageProtections } from './ownership-transfer-storage-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('ownership transfer constraint coverage', () => {
  it('fails a storage or audit protection assertion when any object is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0195_ownership_transfer.sql',
      assertions: async (pool) => {
        await assertOwnershipTransferStorageProtections(pool)
        await assertOwnershipTransferAuditProtections(pool)
      },
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter(({ status }) => status === 'covered')).toHaveLength(
      report.objects.length,
    )
  }, 600_000)
})
