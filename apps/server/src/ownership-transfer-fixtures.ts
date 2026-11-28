import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

export async function seedPendingOwnershipTransfer(
  db: Db,
  organizationId: string,
  initiatorUserId: string,
  targetUserId: string,
) {
  const members = await db
    .selectFrom('auth.member')
    .select(['id', 'userId'])
    .where('organizationId', '=', organizationId)
    .where('userId', 'in', [initiatorUserId, targetUserId])
    .execute()
  const initiator = members.find(({ userId }) => userId === initiatorUserId)
  const target = members.find(({ userId }) => userId === targetUserId)
  if (!initiator || !target) throw new Error('Expected both transfer memberships')
  const offer = await db
    .insertInto('organization_ownership_transfers')
    .values({
      organization_id: organizationId,
      initiator_user_id: initiatorUserId,
      initiator_membership_id: initiator.id,
      target_user_id: targetUserId,
      target_membership_id: target.id,
      created_at: sql`clock_timestamp()`,
      expires_at: sql`clock_timestamp() + interval '24 hours'`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return () =>
    db
      .selectFrom('organization_ownership_transfers')
      .select(['state', 'terminal_at'])
      .where('id', '=', offer.id)
      .executeTakeFirstOrThrow()
}
