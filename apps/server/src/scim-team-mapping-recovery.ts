import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { mappingDenied, mappingUuid } from './scim-team-hierarchy-proof.ts'
import {
  recordScimMappingChange,
  type ScimMappingNoticeQueue,
} from './scim-team-mapping-notices.ts'
import { lockMappingTeams, retireScimTeamMapping } from './scim-team-mapping-retirement.ts'

export const ScimMappingRecovery = z.strictObject({
  action: z.enum(['suspend', 'detach']),
  mappingId: mappingUuid,
  parentOrganizationId: mappingUuid,
  childOrganizationId: mappingUuid,
})

export async function recoverScimTeamMapping(
  db: Db,
  queue: ScimMappingNoticeQueue,
  input: z.input<typeof ScimMappingRecovery>,
) {
  const parsed = ScimMappingRecovery.safeParse(input)
  if (!parsed.success) throw mappingDenied()
  const { action, mappingId, parentOrganizationId, childOrganizationId } = parsed.data
  const teams = [parentOrganizationId, childOrganizationId].sort()
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      const organizations = await lockMappingTeams(trx, teams)
      const mapping = await trx
        .selectFrom('scim_team_mappings')
        .select(['suspended_at', 'retired_at'])
        .where('id', '=', mappingId)
        .where('parent_organization_id', '=', parentOrganizationId)
        .where('child_organization_id', '=', childOrganizationId)
        .forUpdate()
        .executeTakeFirst()
      if (!mapping) throw mappingDenied()
      if (mapping.retired_at || (action === 'suspend' && mapping.suspended_at)) return 'unchanged'
      if (organizations.length !== teams.length) throw mappingDenied()

      if (action === 'suspend') {
        await trx
          .updateTable('scim_team_mappings')
          .set({ suspended_at: sql<Date>`clock_timestamp()` })
          .where('id', '=', mappingId)
          .execute()
      } else {
        await retireScimTeamMapping(trx, mappingId, childOrganizationId)
      }
      await recordScimMappingChange(
        trx,
        queue,
        mappingId,
        action === 'suspend' ? 'suspended' : 'unlinked',
        teams.map((organizationId) => ({
          organizationId,
          actor: { type: 'system', id: 'scim-mapping-recovery' },
        })),
      )
      return action === 'suspend' ? 'suspended' : 'detached'
    })
}
