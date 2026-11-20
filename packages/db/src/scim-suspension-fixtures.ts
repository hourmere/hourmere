import type { Db } from './index.ts'

/** Seed a suspended SCIM resource while keeping its membership and credentials in place. */
export async function suspendScimMember(db: Db, organizationId: string, userId: string) {
  return db.transaction().execute(async (trx) => {
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
    return trx
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: organizationId,
        user_id: userId,
        source: 'scim',
        kind: 'suspension',
        connection_id: connectionId,
        scim_user_id: scimUserId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  })
}
