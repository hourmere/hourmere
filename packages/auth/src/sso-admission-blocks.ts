import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

interface AdmissionMember {
  organizationId: string
  userId: string
}

export type SsoAdmissionRemoval = (trx: Db, member: AdmissionMember) => Promise<void>

export const SCIM_MANAGED_RESOURCE_CODE = 'scim_managed_resource'
export const SCIM_MANAGED_RESOURCE_MESSAGE = 'This resource is managed by your identity provider.'

/**
 * The caller holds the organization lock through the membership deletion. Every removal or
 * departure records its tombstone while OIDC is on (docs/sso.md, "Leaving/removal creates a
 * team-local admission tombstone"), whether or not the team has configured a provider or JIT
 * yet, so a later configuration cannot readmit a person removed before it.
 */
export const recordSsoAdmissionRemoval: SsoAdmissionRemoval = (trx, member) =>
  recordAdmissionRemoval(trx, member, false)

/** Keep the account decision too, even if the account changes its mailbox after removal. */
export const recordScimManagedRemoval: SsoAdmissionRemoval = (trx, member) =>
  recordAdmissionRemoval(trx, member, true)

async function recordAdmissionRemoval(
  trx: Db,
  { organizationId, userId }: AdmissionMember,
  keepAccount: boolean,
) {
  // Keep the current local mailbox and each live link's last proof after account deletion.
  const { rows } = await sql<{ mailbox: string }>`
    SELECT mailbox
    FROM (
      SELECT lower(btrim(email)) AS mailbox FROM auth."user" WHERE id = ${userId}
      UNION
      SELECT proven_email FROM sso_identity_links
      WHERE organization_id = ${organizationId} AND user_id = ${userId} AND retired_at IS NULL
    ) AS mailboxes
    WHERE char_length(mailbox) BETWEEN 1 AND 320
  `.execute(trx)
  const mailboxes = rows.map(({ mailbox }) => mailbox)
  if (!keepAccount && mailboxes.length === 0) return

  // A native invitation may have restored membership while leaving the old block active.
  // Preserve its history and date the new decision so an intervening invitation is stale.
  const previous = trx
    .updateTable('scim_membership_blocks')
    .set({ cleared_at: sql`clock_timestamp()` })
    .where('organization_id', '=', organizationId)
    .where('source', '=', 'local')
    .where('kind', '=', 'removal')
    .where('cleared_at', 'is', null)
  if (keepAccount) {
    await previous
      .where((eb) =>
        eb.or([
          eb('user_id', '=', userId),
          ...(mailboxes.length > 0 ? [eb('identity_email', 'in', mailboxes)] : []),
        ]),
      )
      .execute()
  } else {
    await previous.where('identity_email', 'in', mailboxes).execute()
  }
  const identity: { user_id: string | null; identity_email: string | null }[] = mailboxes.map(
    (mailbox) => ({ user_id: null, identity_email: mailbox }),
  )
  if (keepAccount) identity.push({ user_id: userId, identity_email: null })
  await trx
    .insertInto('scim_membership_blocks')
    .values(
      identity.map((key) => ({
        organization_id: organizationId,
        ...key,
        source: 'local',
        kind: 'removal',
        created_at: sql`clock_timestamp()`,
      })),
    )
    .execute()
}

/**
 * A current invitation can clear a prior local removal under the organization lock. A
 * SCIM-issued invitation (one a SCIM claim is bound to) never does: the same rule as native
 * acceptance in scim-claims.ts, so both acceptance paths refuse it while any blocker is live.
 */
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
          AND NOT EXISTS (
            SELECT 1 FROM scim_user_claims AS claim
            WHERE claim.organization_id = invitation."organizationId"
              AND claim.invitation_id = invitation.id
          )
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
