import { sql, type Transaction } from 'kysely'
import { writeAuditEvent } from './audit.ts'
import type { Database } from './index.ts'

interface PendingTransferScope {
  organizationId: string
  transferId?: string
  membershipId?: string
  userId?: string
  expireOnly?: boolean
  requestId?: string | undefined
}

/** Retire a matching offer under the caller's organization write lock. */
export async function retirePendingOwnershipTransfer(
  trx: Transaction<Database>,
  { organizationId, transferId, membershipId, userId, expireOnly, requestId }: PendingTransferScope,
) {
  let pending = trx
    .selectFrom('organization_ownership_transfers')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('state', '=', 'pending')
    .forUpdate()

  if (transferId) pending = pending.where('id', '=', transferId)
  if (membershipId) {
    pending = pending.where((eb) =>
      eb.or([
        eb('initiator_membership_id', '=', membershipId),
        eb('target_membership_id', '=', membershipId),
      ]),
    )
  }
  if (userId) {
    pending = pending.where((eb) =>
      eb.or([eb('initiator_user_id', '=', userId), eb('target_user_id', '=', userId)]),
    )
  }

  // Both state and timestamp use one wall-clock sample taken after the offer row is locked.
  const retired = await trx
    .with('pending_transfer', () => pending)
    .with('transfer_clock', (db) =>
      db.selectFrom('pending_transfer').select(['id', sql<Date>`clock_timestamp()`.as('now')]),
    )
    .updateTable('organization_ownership_transfers as transfer')
    .from('transfer_clock')
    .set((eb) => ({
      state: eb
        .case()
        .when('transfer.expires_at', '<=', eb.ref('transfer_clock.now'))
        .then('expired')
        .else('invalidated')
        .end(),
      terminal_at: eb.ref('transfer_clock.now'),
    }))
    .whereRef('transfer.id', '=', 'transfer_clock.id')
    .$if(expireOnly === true, (update) =>
      update.whereRef('transfer.expires_at', '<=', 'transfer_clock.now'),
    )
    .returning('transfer.state')
    .executeTakeFirst()
  if (!retired) return undefined

  const expired = retired.state === 'expired'
  await writeAuditEvent(trx, {
    organizationId,
    actor: { type: 'system', id: 'ownership-transfer' },
    credential: { type: 'none' },
    action: expired
      ? 'organization.ownership_transfer_expired'
      : 'organization.ownership_transfer_invalidated',
    targetType: 'organization',
    targetId: organizationId,
    requestId,
  })
  return expired ? 'expired' : 'invalidated'
}
