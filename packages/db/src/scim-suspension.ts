import { type Expression, sql, type Transaction } from 'kysely'
import type { Database } from './index.ts'

interface ScimMembershipSuspension {
  organizationId: string
  userId: string
  connectionId: string
  scimUserId: string
}

/** Persist a suspension and end its session authorization in the caller's READ COMMITTED transaction. */
export async function suspendScimMembership(
  trx: Transaction<Database>,
  { organizationId, userId, connectionId, scimUserId }: ScimMembershipSuspension,
) {
  // Team selection and proof issuance take the corresponding team lock before
  // checking suspension. They can finish before revocation or see the committed block.
  await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', organizationId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('personal_organizations')
            .select('organization_id')
            .where('organization_id', '=', organizationId),
        ),
      ),
    )
    .forUpdate()
    .executeTakeFirstOrThrow()

  // Sessions can carry proofs for several teams. Serialize suspensions of this account
  // so two teams cannot each delete a session whose proofs the other needs to remove.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.scim-session-revocation:${userId.toLowerCase()}`}, 0))`.execute(
    trx,
  )

  const block = await trx
    .insertInto('scim_membership_blocks')
    .columns(['organization_id', 'user_id', 'source', 'kind', 'connection_id', 'scim_user_id'])
    .expression((eb) =>
      eb
        .selectFrom('scim_users')
        .select([
          'organization_id',
          'linked_user_id',
          eb.val('scim').as('source'),
          eb.val('suspension').as('kind'),
          'connection_id',
          'id',
        ])
        .where('organization_id', '=', organizationId)
        .where('connection_id', '=', connectionId)
        .where('id', '=', scimUserId)
        .where('linked_user_id', '=', userId)
        .where('retired_at', 'is', null),
    )
    .returning('id')
    .executeTakeFirstOrThrow()

  // Delete by indexed account ID in one batch. A simultaneous rolling refresh only
  // updates the existing row, so it either completes before deletion or finds no session.
  await trx
    .deleteFrom('auth.session')
    .where('userId', '=', userId)
    .where(sql<string>`lower("activeOrganizationId")`, '=', organizationId.toLowerCase())
    .execute()

  // Deleting a session cascades its proofs. Remove the team's proofs on surviving
  // sessions through the member index, keeping their other team proofs usable.
  await trx
    .deleteFrom('sso_browser_proofs')
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .where('member_id', 'in', (eb) =>
      eb
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', userId),
    )
    .execute()

  return block
}

/** Project whether the team already has SCIM storage without a separate lookup. */
export function scimProvisioned(organizationId: Expression<string>) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM scim_connections WHERE organization_id = ${organizationId}::uuid
  )`
}

/** Embed the account's live team suspension in an existing authorization statement. */
export function scimSuspended(
  organizationId: Expression<string> | string,
  userId: Expression<string> | string,
) {
  return sql<boolean>`CASE WHEN EXISTS (
    SELECT 1 FROM scim_membership_blocks AS block
    WHERE block.organization_id = ${organizationId}::uuid AND block.user_id = ${userId}::uuid
      AND block.source = 'scim' AND block.kind = 'suspension' AND block.cleared_at IS NULL
  ) THEN NOT EXISTS (
    SELECT 1 FROM personal_organizations AS personal
    WHERE personal.organization_id = ${organizationId}::uuid
  ) ELSE false END`
}
