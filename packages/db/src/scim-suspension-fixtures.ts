import type { Transaction } from 'kysely'
import type { Database, Db } from './index.ts'
import { suspendScimMembership } from './scim-suspension.ts'

interface SuspensionFixtureOptions {
  revoke?: true
}

/** By default preserve session and proof rows to test denial against an existing blocker. */
export async function suspendScimMember(
  db: Db,
  organizationId: string,
  userId: string,
  { revoke }: SuspensionFixtureOptions = {},
) {
  return db.transaction().execute(async (trx) => {
    if (revoke) {
      // Match the lifecycle lock order before fixture inserts take FK key-share locks.
      await trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow()
    }
    const target = await prepareScimSuspension(trx, organizationId, userId)
    if (revoke) return suspendScimMembership(trx, target, { type: 'system' })
    return trx
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: organizationId,
        user_id: userId,
        source: 'scim',
        kind: 'suspension',
        connection_id: target.connectionId,
        scim_user_id: target.scimUserId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  })
}

/** Create the linked SCIM resource before a test exercises the suspension transaction. */
export async function prepareScimSuspension(
  trx: Transaction<Database>,
  organizationId: string,
  userId: string,
) {
  const { id: linkedMemberId, email } = await trx
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select(['m.id', 'u.email'])
    .where('m.organizationId', '=', organizationId)
    .where('m.userId', '=', userId)
    .executeTakeFirstOrThrow()
  const { id: connectionId } = await trx
    .insertInto('scim_connections')
    .values({ organization_id: organizationId })
    .returning('id')
    .executeTakeFirstOrThrow()
  const { id: scimUserId } = await trx
    .insertInto('scim_users')
    .values({
      organization_id: organizationId,
      connection_id: connectionId,
      user_name: email,
      active: false,
      linked_user_id: userId,
      linked_member_id: linkedMemberId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { organizationId, userId, connectionId, scimUserId }
}
