import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

interface AdmissionMember {
  organizationId: string
  userId: string
}

export type SsoAdmissionRemoval = (trx: Db, member: AdmissionMember) => Promise<void>

/** The caller holds the organization lock through the membership deletion. */
export const recordSsoAdmissionRemoval: SsoAdmissionRemoval = async (
  trx,
  { organizationId, userId },
) => {
  // Mailbox keys survive account deletion and avoid taking a target user lock under
  // the organization lock. Keep the current local mailbox and each live link's last proof.
  const { rows } = await sql<{ mailbox: string }>`
    SELECT mailbox
    FROM (
      SELECT lower(btrim(email)) AS mailbox FROM auth."user" WHERE id = ${userId}
      UNION
      SELECT proven_email FROM sso_identity_links
      WHERE organization_id = ${organizationId} AND user_id = ${userId} AND retired_at IS NULL
    ) AS mailboxes
    WHERE char_length(mailbox) BETWEEN 1 AND 320 AND (
      EXISTS (SELECT 1 FROM sso_providers
        WHERE organization_id = ${organizationId} AND protocol = 'oidc' AND retired_at IS NULL)
      OR EXISTS (SELECT 1 FROM sso_policies
        WHERE organization_id = ${organizationId} AND admission = 'jit')
    )
  `.execute(trx)
  if (rows.length === 0) return

  // A native invitation may have restored membership while leaving the old block active.
  // Preserve its history and date the new decision so an intervening invitation is stale.
  await trx
    .updateTable('scim_membership_blocks')
    .set({ cleared_at: sql`clock_timestamp()` })
    .where('organization_id', '=', organizationId)
    .where(
      'identity_email',
      'in',
      rows.map(({ mailbox }) => mailbox),
    )
    .where('source', '=', 'local')
    .where('kind', '=', 'removal')
    .where('cleared_at', 'is', null)
    .execute()
  await trx
    .insertInto('scim_membership_blocks')
    .values(
      rows.map(({ mailbox }) => ({
        organization_id: organizationId,
        identity_email: mailbox,
        source: 'local',
        kind: 'removal',
        created_at: sql`clock_timestamp()`,
      })),
    )
    .execute()
}

/** A current invitation can clear a prior local removal under the organization lock. */
export async function checkSsoAdmissionBlocks(
  trx: Db,
  {
    organizationId,
    userId,
    mailbox,
    invitationId,
  }: AdmissionMember & {
    mailbox: string
    invitationId?: string
  },
): Promise<boolean> {
  const blocks = await trx
    .selectFrom('scim_membership_blocks as block')
    .select(['block.id', 'block.source', 'block.kind'])
    .select(
      sql<boolean>`EXISTS (
        SELECT 1 FROM auth.invitation AS invitation
        WHERE invitation.id = ${invitationId ?? null}::uuid
          AND invitation."organizationId" = block.organization_id
          AND invitation."createdAt" > block.created_at
      )`.as('reinstates'),
    )
    .where('block.organization_id', '=', organizationId)
    .where('block.cleared_at', 'is', null)
    .where((eb) =>
      eb.or([eb('block.user_id', '=', userId), eb('block.identity_email', '=', mailbox)]),
    )
    .orderBy('block.id')
    .forUpdate('block')
    .execute()
  if (
    blocks.some(
      (block) => block.source !== 'local' || block.kind !== 'removal' || !block.reinstates,
    )
  )
    return false
  if (blocks.length > 0) {
    await trx
      .updateTable('scim_membership_blocks')
      .set({ cleared_at: sql<Date>`clock_timestamp()` })
      .where(
        'id',
        'in',
        blocks.map((block) => block.id),
      )
      .execute()
  }
  return true
}
