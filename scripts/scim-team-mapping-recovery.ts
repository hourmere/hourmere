// Offline SCIM resource test harness. The production image does not ship this entry point.

import { ScimMappingRecovery } from '../apps/server/src/scim-team-mapping-recovery.ts'
import { runScimTeamMappingRecovery } from '../apps/server/src/scim-team-mapping-recovery-cli.ts'

const [flag, action, mappingId, parentOrganizationId, childOrganizationId, ...extra] =
  process.argv.slice(2)
const target = ScimMappingRecovery.safeParse({
  action,
  mappingId,
  parentOrganizationId,
  childOrganizationId,
})
const url = process.env.DATABASE_URL

if (flag !== '--resource-test' || !target.success || extra.length > 0 || !url) {
  console.error(
    'Usage with the resource test database configured: scim-team-mapping-recovery.ts --resource-test <suspend|detach> <mapping UUID> <parent UUID> <child UUID>',
  )
  process.exitCode = 1
} else {
  process.exitCode = await runScimTeamMappingRecovery(url, target.data, true)
}
