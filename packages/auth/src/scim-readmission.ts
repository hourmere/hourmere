import type { Db } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import { createAuthEndpoint, sensitiveSessionMiddleware } from 'better-auth/api'
import { sql } from 'kysely'
import { z } from 'zod'
import { finishScimClaim } from './scim-claims.ts'
import { TeamManagementError, teamSession, teamSessionUser } from './team-management.ts'
import { teamRoleDenied } from './team-role-policy.ts'

/** Browser-session confirmation of a fresh SCIM entry for a retained member. */
export function scimReadmission(db: Db) {
  return {
    id: 'scim-readmission',
    endpoints: {
      completeScimReadmission: createAuthEndpoint(
        '/organization/complete-scim-readmission',
        {
          method: 'POST',
          requireHeaders: true,
          use: [sensitiveSessionMiddleware],
          body: z.strictObject({ organizationId: z.uuid(), scimUserId: z.uuid() }),
        },
        async (ctx) => {
          if (ctx.headers?.has('authorization')) throw teamRoleDenied()
          const { organizationId, scimUserId } = ctx.body
          const { user, session } = ctx.context.session
          const principal = { kind: 'session', user, sessionId: session.id } as const
          try {
            await db
              .transaction()
              .setIsolationLevel('read committed')
              .execute((trx) => completeReadmission(trx, principal, organizationId, scimUserId))
          } catch (error) {
            if (error instanceof TeamManagementError) throw teamRoleDenied()
            throw error
          }
          return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        },
      ),
    },
  }
}

async function completeReadmission(
  trx: Db,
  principal: { kind: 'session'; user: { id: string }; sessionId: string },
  organizationId: string,
  scimUserId: string,
) {
  const { id: userId } = principal.user
  const account = await teamSessionUser(trx, principal, true)
  const mailbox = account.email.trim().toLowerCase()
  const team = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', organizationId)
    .forUpdate()
    .executeTakeFirst()
  if (!team) throw teamRoleDenied()
  await teamSession(trx, principal, true)
  const member = await trx
    .selectFrom('auth.member')
    .select(['id', 'userId', 'organizationId'])
    .where('organizationId', '=', team.id)
    .where('userId', '=', userId)
    .where('role', '=', 'member')
    .executeTakeFirst()
  if (!member) throw teamRoleDenied()

  const claim = await trx
    .selectFrom('scim_user_claims as claim')
    .innerJoin('scim_users as entry', 'entry.id', 'claim.scim_user_id')
    .select(['claim.id', 'entry.connection_id', 'entry.normalized_user_name', 'entry.external_id'])
    .where('entry.id', '=', scimUserId)
    .where('claim.organization_id', '=', team.id)
    .where('claim.invitation_id', 'is', null)
    .where('claim.work_email', '=', mailbox)
    .where('claim.completed_at', 'is', null)
    .where('claim.invalidated_at', 'is', null)
    .where('claim.expires_at', '>', sql<Date>`clock_timestamp()`)
    .where('entry.active', '=', true)
    .where('entry.retired_at', 'is', null)
    .where('entry.linked_user_id', 'is', null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('scim_users as linked')
            .select('linked.id')
            .whereRef('linked.connection_id', '=', 'entry.connection_id')
            .where('linked.linked_user_id', '=', userId)
            .where('linked.retired_at', 'is', null),
        ),
      ),
    )
    .forUpdate(['claim', 'entry'])
    .executeTakeFirst()
  if (!claim) throw teamRoleDenied()

  // All blocker writers serialize on the team. Match both proven identities,
  // while allowing only this account's same-connection retired suspension.
  const blocks = await trx
    .selectFrom('scim_membership_blocks as block')
    .select('block.id')
    .select(({ and, eb, exists, selectFrom }) =>
      and([
        eb('block.source', '=', 'scim'),
        eb('block.kind', '=', 'suspension'),
        eb('block.user_id', '=', userId),
        eb('block.connection_id', '=', claim.connection_id),
        exists(
          selectFrom('scim_users as previous')
            .select('previous.id')
            .whereRef('previous.id', '=', 'block.scim_user_id')
            .where('previous.linked_user_id', '=', userId)
            .where('previous.retired_at', 'is not', null)
            .where(({ eb, or }) =>
              or([
                eb('previous.normalized_user_name', '=', claim.normalized_user_name),
                eb('previous.external_id', '=', claim.external_id),
              ]),
            ),
        ),
      ]).as('retiredSuspension'),
    )
    .where('block.organization_id', '=', team.id)
    .where('block.cleared_at', 'is', null)
    .where(({ eb, or }) =>
      or([eb('block.user_id', '=', userId), eb('block.identity_email', '=', mailbox)]),
    )
    .forUpdate('block')
    .execute()
  if (blocks.length !== 1 || !blocks[0]?.retiredSuspension) throw teamRoleDenied()
  await trx
    .updateTable('scim_membership_blocks')
    .set({ cleared_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', blocks[0].id)
    .executeTakeFirst()
  await finishScimClaim(
    { organizationId: team.id, userId, audit: auditActor(principal) },
    scimUserId,
    claim.id,
  )(trx, member)
}
