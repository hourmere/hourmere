import type { Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import type { ScimReply, ScimResourceHandler, ScimResourceRequest } from './scim.ts'
import { visibleScimGroups } from './scim-groups.ts'
import {
  mappingMemberships,
  removeManagedChildMemberships,
} from './scim-managed-child-memberships.ts'
import {
  recordScimMappingChange,
  type ScimMappingNoticeQueue,
} from './scim-team-mapping-notices.ts'
import { lockMappingTeams } from './scim-team-mapping-retirement.ts'
import { lockScimTokenConnection, refuse, scimWriteRefusal } from './scim-user-write.ts'
import { scimUserNotFound as notFound, SCIM_USER_ID as RESOURCE_ID } from './scim-users.ts'

async function retire(
  db: Db,
  notices: ScimMappingNoticeQueue,
  request: ScimResourceRequest,
  id: string,
): Promise<ScimReply> {
  if (!RESOURCE_ID.test(id)) return notFound
  const { principal } = request
  const { organizationId } = principal
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // The same order as the other Group writes: both teams in ascending ID order,
        // then the credential, then the mapping and its Group.
        const group = visibleScimGroups(trx, principal).where('scim_group.id', '=', id)
        const candidate = await group.select('child.id as childId').executeTakeFirst()
        if (!candidate) return notFound
        const { childId } = candidate
        const teams = await lockMappingTeams(trx, [organizationId, childId])
        if (teams.length !== 2) return notFound
        const connectionId = await lockScimTokenConnection(trx, principal)
        const row = await group
          .select('mapping.id as mappingId')
          .where('child.id', '=', childId)
          .where('mapping.connection_id', '=', connectionId)
          .forUpdate(['mapping', 'scim_group'])
          .executeTakeFirst()
        if (!row) return notFound
        if (request.hasWritePrecondition)
          return refuse(412, 'Conditional writes are not supported.').reply

        // Ends only the access this mapping sourced, or refuses as a whole. The child
        // team, its local members and blockers, its name and its history all stay.
        await removeManagedChildMemberships(
          trx,
          await mappingMemberships(trx, row.mappingId, childId),
        )
        // Retiring the mapping ends the hierarchy link and releases the externalId. The
        // Group row stays, so its ID answers 404 from now on and is never assigned again.
        await trx
          .updateTable('scim_team_mappings')
          .set({ retired_at: sql<Date>`clock_timestamp()` })
          .where('id', '=', row.mappingId)
          .execute()

        const actor = { type: 'scim_token', id: principal.tokenId } as const
        await writeAuditEvent(trx, {
          organizationId,
          actor,
          credential: { type: 'none' },
          action: 'scim_group.deleted',
          targetType: 'scim_group',
          targetId: id,
        })
        // The child journal names no foreign token.
        await recordScimMappingChange(trx, notices, row.mappingId, 'unlinked', [
          { organizationId, actor },
          { organizationId: childId, actor: { type: 'system', id: 'scim-group-retirement' } },
        ])
        return { status: 204, body: null }
      })
  } catch (error) {
    const reply = scimWriteRefusal(error)
    if (reply) return reply
    throw error
  }
}

/** DELETE /Groups/{id}, injected only by the SCIM resource test harness. */
export function scimGroupRetirement(db: Db, notices: ScimMappingNoticeQueue): ScimResourceHandler {
  return (request) => {
    if (request.method !== 'DELETE') return
    const match = /^\/Groups\/([^/]*)$/.exec(request.path)
    if (match?.[1] !== undefined) return retire(db, notices, request, match[1])
  }
}
