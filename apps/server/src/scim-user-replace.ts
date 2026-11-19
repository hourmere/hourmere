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
import { normalizeScimUserPatch, parseScimUserPatch } from './scim-user-patch.ts'
import {
  assertScimActiveUnchanged,
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
  if (request.hasWritePrecondition)
    return {
      status: 412,
      body: scimError(412, 'Conditional writes are not supported.'),
    }
  if (!SCIM_USER_ID.test(id)) return scimUserNotFound
  const projection = parseScimProjection(request.query, scimUserQuery)
  if (!projection.ok) return projection.reply
  const body = await request.body?.()
  if (!body) return invalidSyntax('The request body is required.').reply
  if (!body.ok) return body.reply
  const { principal } = request
  const organizationId = principal.organizationId
  try {
    const write =
      method === 'PATCH'
        ? { method, operations: parseScimUserPatch(body.value) }
        : { method, ...parseScimUserWrite(body.value, 'PUT') }
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
        if (write.method === 'PUT') assertScimActiveUnchanged(write.active, entry.active)
        const { profile, managers } =
          write.method === 'PATCH'
            ? normalizeScimUserPatch(entry, write.operations)
            : { profile: write.profile, managers: [write.profile.manager_id] }
        await validateScimManager(trx, organizationId, connectionId, ...managers)
        const fields = Object.keys(profile) as (keyof typeof profile)[]
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
            ...(write.method === 'PATCH'
              ? { details: { operations: write.operations.map(({ op }) => op) } }
              : {}),
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
