import type { Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { suspendScimMembership } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import {
  type ScimReply,
  type ScimResourceHandler,
  type ScimResourceRequest,
  scimError,
} from './scim.ts'
import {
  removeManagedChildMemberships,
  scimUserWriteTransaction,
  sourcedChildMemberships,
  touchSourcedGroups,
} from './scim-managed-child-memberships.ts'
import { assertScimUserCanRetire } from './scim-user-lifecycle.ts'
import { retireScimUserClaims } from './scim-user-retirement-claims.ts'
import { scimUserWriteError } from './scim-user-write.ts'
import { SCIM_USER_ID, scimUserNotFound } from './scim-users.ts'

async function retire(db: Db, request: ScimResourceRequest, id: string): Promise<ScimReply> {
  if (!SCIM_USER_ID.test(id)) return scimUserNotFound
  const { principal } = request
  const { organizationId } = principal
  try {
    // The team locks precede the token, User and current role read.
    return await scimUserWriteTransaction(db, principal, id, async (trx, connectionId) => {
      const entry = await trx
        .selectFrom('scim_users')
        .select(['id', 'organization_id', 'connection_id', 'linked_user_id'])
        .where('id', '=', id)
        .where('organization_id', '=', organizationId)
        .where('connection_id', '=', connectionId)
        .where('retired_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()
      if (!entry) return scimUserNotFound
      if (request.hasWritePrecondition)
        return { status: 412, body: scimError(412, 'Conditional writes are not supported.') }
      await assertScimUserCanRetire(trx, entry)
      // Retirement ends the child access this User sourced, or refuses as a whole.
      await touchSourcedGroups(trx, entry)
      await removeManagedChildMemberships(trx, await sourcedChildMemberships(trx, entry))

      const actor = { type: 'scim_token', id: principal.tokenId } as const
      const scope = { organizationId, connectionId, scimUserId: entry.id }
      if (entry.linked_user_id !== null)
        await suspendScimMembership(trx, { ...scope, userId: entry.linked_user_id }, actor, {
          reuseExistingBlock: true,
        })
      await retireScimUserClaims(trx, scope, actor)
      await trx
        .updateTable('scim_users')
        .set({
          active: false,
          retired_at: sql<Date>`statement_timestamp()`,
          updated_at: sql<Date>`statement_timestamp()`,
        })
        .where('id', '=', entry.id)
        .executeTakeFirst()
      await writeAuditEvent(trx, {
        organizationId,
        actor,
        credential: { type: 'none' },
        action: 'scim_user.retired',
        targetType: 'scim_user',
        targetId: entry.id,
      })
      return { status: 204, body: null }
    })
  } catch (error) {
    const reply = scimUserWriteError(error)
    if (reply) return reply
    throw error
  }
}

/** DELETE /Users/{id}. */
export function scimUserRetirement(db: Db): ScimResourceHandler {
  return (request) => {
    if (request.method !== 'DELETE') return
    const match = /^\/Users\/([^/]*)$/.exec(request.path)
    if (match?.[1] !== undefined) return retire(db, request, match[1])
  }
}
