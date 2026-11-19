import type { Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import {
  type ScimReply,
  type ScimResourceHandler,
  type ScimResourceRequest,
  scimError,
} from './scim.ts'
import { parseScimProjection, projectScimResource, scimUserQuery } from './scim-query.ts'
import {
  invalidSyntax,
  lockScimWriteConnection,
  parseScimUserWrite,
  refuse,
  scimUserWriteError,
  validateScimManager,
} from './scim-user-write.ts'
import { readScimUser, SCIM_USER_ID, scimUserNotFound } from './scim-users.ts'

async function replace(db: Db, request: ScimResourceRequest, id: string): Promise<ScimReply> {
  if (request.hasWritePrecondition)
    return {
      status: 412,
      body: scimError(412, 'Conditional writes are not supported.'),
    }
  if (!SCIM_USER_ID.test(id)) return scimUserNotFound
  const projection = parseScimProjection(request.query, scimUserQuery)
  if (!projection.ok) return projection.reply
  const body = await request.body?.()
  if (!body) return invalidSyntax('The request body must be a User object.').reply
  if (!body.ok) return body.reply
  const { principal } = request
  const organizationId = principal.organizationId
  try {
    const { profile, active } = parseScimUserWrite(body.value, 'PUT')
    const fields = Object.keys(profile) as (keyof typeof profile)[]
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const connectionId = await lockScimWriteConnection(trx, principal)
        // Acceptance takes the same organization lock before it reaches the claim and User.
        const entry = await trx
          .selectFrom('scim_users')
          .select(fields)
          .select('active')
          .where('id', '=', id)
          .where('organization_id', '=', organizationId)
          .where('connection_id', '=', connectionId)
          .where('retired_at', 'is', null)
          .forUpdate()
          .executeTakeFirst()
        if (!entry) return scimUserNotFound
        if (active !== undefined && active !== entry.active)
          throw refuse(403, 'Changing the active attribute is not supported yet.', 'mutability')
        await validateScimManager(trx, organizationId, connectionId, profile.manager_id)
        if (fields.some((field) => profile[field] !== entry[field])) {
          if (profile.work_email?.toLowerCase() !== entry.work_email?.trim().toLowerCase()) {
            // The old proof cannot claim the new mailbox. Keep the invitation under its own
            // acceptance rules and leave completed claims and their links intact.
            await trx
              .updateTable('scim_user_claims')
              .set({ invalidated_at: sql<Date>`clock_timestamp()` })
              .where('scim_user_id', '=', id)
              .where('organization_id', '=', organizationId)
              .where('connection_id', '=', connectionId)
              .where('completed_at', 'is', null)
              .where('invalidated_at', 'is', null)
              .execute()
          }
          await trx
            .updateTable('scim_users')
            .set({ ...profile, updated_at: sql<Date>`clock_timestamp()` })
            .where('id', '=', id)
            .executeTakeFirst()
          await writeAuditEvent(trx, {
            organizationId,
            actor: { type: 'scim_token', id: principal.tokenId },
            credential: { type: 'none' },
            action: 'scim_user.updated',
            targetType: 'scim_user',
            targetId: id,
          })
        }
        const representation = await readScimUser(trx, request, id)
        if (!representation) throw new Error('The replaced User is not readable.')
        return {
          status: 200,
          body: projectScimResource(scimUserQuery, representation, projection.value),
        }
      })
  } catch (error) {
    const reply = scimUserWriteError(error)
    if (reply) return reply
    throw error
  }
}

/** PUT /Users/{id}, registered only by the SCIM resource test harness. */
export function scimUserReplacement(db: Db): ScimResourceHandler {
  return (request) => {
    if (request.method !== 'PUT') return
    const match = /^\/Users\/([^/]*)$/.exec(request.path)
    if (match?.[1] !== undefined) return replace(db, request, match[1])
  }
}
