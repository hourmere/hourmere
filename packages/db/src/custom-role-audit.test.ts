import { expect, it } from 'vitest'
import { auditDetails } from './audit.ts'
import { detailsCheckBranches, latestDetailsCheckMigration } from './audit-details-check-source.ts'

const migration = '0197_custom_role_storage.sql'
const offered = "    WHEN action = 'organization.ownership_transfer_offered' "
const actions = Object.keys(auditDetails).filter(
  (action) =>
    action.startsWith('custom_role.') ||
    action.startsWith('membership.custom_role_') ||
    action.startsWith('team.custom_roles_'),
)

it('extends the previous audit constraint while retaining every prior branch', () => {
  const predecessor = detailsCheckBranches(latestDetailsCheckMigration(migration))
  const current = detailsCheckBranches(migration)
  const custom = current.branches.find(({ when }) =>
    when.startsWith("    WHEN action IN ('custom_role.created',"),
  )
  expect(current.head).toBe(predecessor.head)
  expect(current.tail).toBe(predecessor.tail)
  const previousHadOffer = predecessor.branches.some(({ when }) => when.startsWith(offered))
  expect(
    current.branches.filter(
      (branch) => branch !== custom && (previousHadOffer || !branch.when.startsWith(offered)),
    ),
  ).toEqual(predecessor.branches)
  expect(custom?.when).toBe(
    `    WHEN action IN (${actions.map((action) => `'${action}'`).join(',')}) THEN coalesce(`,
  )
})
