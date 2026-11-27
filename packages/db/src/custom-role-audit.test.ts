import { expect, it } from 'vitest'
import { auditDetails } from './audit.ts'
import { detailsCheckBranches } from './audit-details-check-source.ts'

const migration = '0197_custom_role_storage.sql'
const actions = Object.keys(auditDetails).filter(
  (action) =>
    action.startsWith('custom_role.') ||
    action.startsWith('membership.custom_role_') ||
    action.startsWith('team.custom_roles_'),
)

it('includes every custom-role audit action in the details constraint', () => {
  const { branches } = detailsCheckBranches(migration)
  const custom = branches.find(({ when }) =>
    when.startsWith("    WHEN action IN ('custom_role.created',"),
  )
  expect(custom?.when).toBe(
    `    WHEN action IN (${actions.map((action) => `'${action}'`).join(',')}) THEN coalesce(`,
  )
})
