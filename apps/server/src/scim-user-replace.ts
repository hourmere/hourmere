import type { Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import {
  type ScimReply,
  type ScimResourceHandler,
  type ScimResourceRequest,
  scimError,
} from './scim.ts'
import { parseScimPatch } from './scim-patch.ts'
import { parseScimProjection, projectScimResource, scimUserQuery } from './scim-query.ts'
import { applyScimUserLifecycle } from './scim-user-lifecycle.ts'
import { normalizeScimUserPatch } from './scim-user-patch.ts'
import {
  invalidSyntax,
  lockScimWriteConnection,
  parseScimUserWrite,
  scimUserWriteError,
  validateScimManager,
} from './scim-user-write.ts'
import { readScimUser, SCIM_USER_ID, scimUserNotFound } from './scim-users.ts'

async function replace(
  db: Db,
  request: ScimResourceRequest,
  id: string,
  method: 'PUT' | 'PATCH',
): Promise<ScimReply> {
  if (!SCIM_USER_ID.test(id)) return scimUserNotFound
  const projection = parseScimProjection(request.query, scimUserQuery)
  // Read the request before taking a lock, but only report validation errors for live IDs.
  const body = !request.hasWritePrecondition && projection.ok ? await request.body?.() : undefined
  const { principal } = request
  const organizationId = principal.organizationId
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const connectionId = await lockScimWriteConnection(trx, principal)
        // Acceptance takes the same organization lock before it reaches the claim and User.
        const entry = await trx
          .selectFrom('scim_users')
          .selectAll()
          .where('id', '=', id)
          .where('organization_id', '=', organizationId)
          .where('connection_id', '=', connectionId)
          .where('retired_at', 'is', null)
          .forUpdate()
          .executeTakeFirst()
        if (!entry) return scimUserNotFound
        if (request.hasWritePrecondition)
          return { status: 412, body: scimError(412, 'Conditional writes are not supported.') }
        if (!projection.ok) return projection.reply
        if (!body) return invalidSyntax('The request body is required.').reply
        if (!body.ok) return body.reply
        const write =
          method === 'PATCH'
            ? { method, operations: parseScimPatch(body.value, 'User') }
            : { method, ...parseScimUserWrite(body.value) }
        const normalized =
          write.method === 'PATCH'
            ? normalizeScimUserPatch(entry, write.operations)
            : {
                ...write,
                managers: [write.profile.manager_id],
                deactivationRequested: write.active === false,
              }
        const { profile, managers, active = entry.active } = normalized
        await validateScimManager(trx, organizationId, connectionId, ...managers)
        const actor = { type: 'scim_token', id: principal.tokenId } as const
        await applyScimUserLifecycle(trx, entry, normalized, actor)
        const fields = Object.keys(profile) as (keyof typeof profile)[]
        const profileChanged = fields.some((field) => profile[field] !== entry[field])
        const activeChanged = active !== entry.active
        if (profileChanged || activeChanged) {
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
            .set({
              ...(profileChanged ? profile : {}),
              active,
              updated_at: sql<Date>`clock_timestamp()`,
            })
            .where('id', '=', id)
            .executeTakeFirst()
        }
        if (profileChanged) {
          await writeAuditEvent(trx, {
            organizationId,
            actor,
            credential: { type: 'none' },
            action: 'scim_user.updated',
            targetType: 'scim_user',
            targetId: id,
            ...(write.method === 'PATCH'
              ? { details: { operations: write.operations.map(({ op }) => op) } }
              : {}),
          })
        }
        if (activeChanged) {
          await writeAuditEvent(trx, {
            organizationId,
            actor,
            credential: { type: 'none' },
            action: active ? 'scim_user.reactivated' : 'scim_user.deactivated',
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

/** PUT and PATCH /Users/{id}, registered only by the SCIM resource test harness. */
export function scimUserReplacement(db: Db): ScimResourceHandler {
  return (request) => {
    if (request.method !== 'PUT' && request.method !== 'PATCH') return
    const match = /^\/Users\/([^/]*)$/.exec(request.path)
    if (match?.[1] !== undefined) return replace(db, request, match[1], request.method)
  }
}
