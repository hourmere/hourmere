import { describe, expect, it } from 'vitest'
import { detailsCheckBranches, latestDetailsCheckMigration } from './audit-details-check-source.ts'
import { assertOwnershipTransferAuditProtections } from './ownership-transfer-audit-protections.ts'
import { assertOwnershipTransferStorageProtections } from './ownership-transfer-storage-protections.ts'
import { createTestDatabase } from './testing.ts'

const migration = '0195_ownership_transfer.sql'
const predecessorMigration = '0194_team_slug_reservations.sql'
const serverUrl = process.env.DATABASE_URL

it('preserves every predecessor audit detail rule when adding the offer rule', () => {
  const latest = latestDetailsCheckMigration(migration)
  expect(latest).toBe(predecessorMigration)
  const predecessor = detailsCheckBranches(latest)
  const current = detailsCheckBranches(migration)
  const offered = "    WHEN action = 'organization.ownership_transfer_offered' THEN"
  expect(current.head).toBe(predecessor.head)
  expect(current.tail).toBe(predecessor.tail)
  expect(current.branches.filter(({ when }) => when.startsWith(offered))).toHaveLength(1)
  expect(current.branches.filter(({ when }) => !when.startsWith(offered))).toEqual(
    predecessor.branches,
  )
})

describe.skipIf(!serverUrl)('ownership transfer storage migration', () => {
  it('applies storage and audit protections on the installed schema', async () => {
    const db = await createTestDatabase(serverUrl as string)
    try {
      await assertOwnershipTransferStorageProtections(db.pool)
      await assertOwnershipTransferAuditProtections(db.pool)
    } finally {
      await db.drop()
    }
  })
})
