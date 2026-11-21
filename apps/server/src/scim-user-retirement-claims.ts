import type { Database } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { sql, type Transaction } from 'kysely'

/** The caller holds the organization update lock and the live resource row lock. */
export async function retireScimUserClaims(
  trx: Transaction<Database>,
  {
    organizationId,
    connectionId,
    scimUserId,
  }: {
    organizationId: string
    connectionId: string
    scimUserId: string
  },
  actor: { type: 'scim_token'; id: string },
) {
  // A profile change can invalidate a claim while leaving its invitation usable.
  // Revoke SCIM's own invitation, preserving an administrator's issuance or renewal.
  // The original issuance audit lives longer than the invitation's initial lifetime.
  const invitations = await trx
    .updateTable('auth.invitation')
    .set({ status: 'canceled' })
    .where('organizationId', '=', organizationId)
    .where('status', '=', 'pending')
    .where('id', 'in', (eb) =>
      eb
        .selectFrom('scim_user_claims')
        .select('invitation_id')
        .where('organization_id', '=', organizationId)
        .where('connection_id', '=', connectionId)
        .where('scim_user_id', '=', scimUserId)
        .where('completed_at', 'is', null)
        .whereRef('expires_at', '=', 'auth.invitation.expiresAt'),
    )
    .where(({ exists, ref, selectFrom }) =>
      exists(
        selectFrom('audit_events')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('action', '=', 'membership.invited')
          .whereRef('occurred_at', '>=', 'auth.invitation.createdAt')
          .where('actor_type', '=', 'scim_token')
          .where('target_type', '=', 'invitation')
          .where('target_id', '=', sql<string>`${ref('auth.invitation.id')}::text`),
      ),
    )
    .returning('id')
    .execute()
  if (invitations.length) {
    // The mail sender locks invitation before delivery. Keep terminal mail outcomes.
    await trx
      .updateTable('invitation_deliveries')
      .set({
        state: 'skipped',
        last_error_code: 'invitation_ineligible',
        lease_id: null,
        lease_until: null,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where(
        'invitation_id',
        'in',
        invitations.map(({ id }) => id),
      )
      .where('state', 'in', ['queued', 'sending'])
      .execute()
    for (const { id } of invitations) {
      await writeAuditEvent(trx, {
        organizationId,
        actor,
        credential: { type: 'none' },
        action: 'membership.invitation_cancelled',
        targetType: 'invitation',
        targetId: id,
      })
    }
  }
  await trx
    .updateTable('scim_user_claims')
    .set({ invalidated_at: sql<Date>`clock_timestamp()` })
    .where('organization_id', '=', organizationId)
    .where('connection_id', '=', connectionId)
    .where('scim_user_id', '=', scimUserId)
    .where('completed_at', 'is', null)
    .where('invalidated_at', 'is', null)
    .execute()
}
