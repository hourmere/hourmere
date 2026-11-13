// SCIM claim completion (docs/scim.md, the claim completion rows of the plan). A SCIM User's
// pending claim is completed only by a proof that runs on an existing interface; this step
// supports one, the acceptance of the invitation the SCIM create bound to the claim. The SSO
// linking completion step adds its proof as another method of ScimClaimCompletion. Claims
// without an invitation are never completed here, and nothing is ever linked by email alone.
import type { Db } from '@hourmere/db'
import { type AuditEvent, writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'

/** What invitation acceptance has proven once it holds its locks. */
export interface ScimInvitationProof {
  /** The invitation's organization, whose update lock the acceptance holds. */
  organizationId: string
  /** The pending member invitation being accepted, locked by the acceptance. */
  invitationId: string
  /** The signed-in account accepting it: its address is verified and is the invitation's. */
  userId: string
  /** That account's address, trimmed and lower-cased, read under its row lock. */
  mailbox: string
  /**
   * The database instant, after the acceptance's lock waits, at which it found the invitation
   * unexpired (timestamptz text). The claim's expiry is judged at the same instant.
   */
  checkedAt: string
  /** Who accepts, for the `scim_user.claimed` event. */
  audit: Pick<AuditEvent, 'actor' | 'credential'>
}

/** Finishes a completion once the native acceptance has inserted the member row. */
export type ScimClaimFinish = (
  trx: Db,
  member: { id: string; userId: string; organizationId: string },
) => Promise<void>

/**
 * The admission decision for a proof: refused (a live admission blocker), or admitted, with a
 * finish step when the claim can be completed. An admission without a finish is the ordinary
 * invitation acceptance; the entry stays unlinked.
 */
export type ScimClaimDecision = { refused: true } | { refused: false; finish?: ScimClaimFinish }

/**
 * Completes SCIM claims inside the existing acceptance transactions. This is the resource test
 * flag of docs/scim.md: only test harnesses pass it to createAuth, in code, and the production
 * options never do. The SSO linking completion step extends this interface with its own proof.
 */
export interface ScimClaimCompletion {
  /**
   * Invitation acceptance calls this after its organization, session and invitation locks and
   * its own recipient, expiry, inviter, membership and capacity checks, in its transaction.
   */
  invitation(trx: Db, proof: ScimInvitationProof): Promise<ScimClaimDecision>
}

const admitted: ScimClaimDecision = { refused: false }

export const scimClaimCompletion: ScimClaimCompletion = {
  async invitation(trx, proof) {
    // Only the claim the SCIM create bound to this invitation; an invitation without one is
    // an ordinary acceptance. Locked after the invitation (docs/data-model.md).
    const claim = await trx
      .selectFrom('scim_user_claims')
      .select([
        'id',
        'connection_id',
        'scim_user_id',
        'work_email',
        'completed_at',
        'invalidated_at',
        // The instant at which the acceptance found its invitation unexpired.
        sql<boolean>`expires_at > ${proof.checkedAt}::timestamptz`.as('current'),
      ])
      .where('organization_id', '=', proof.organizationId)
      .where('invitation_id', '=', proof.invitationId)
      .forUpdate()
      .executeTakeFirst()
    if (!claim) return admitted
    // A SCIM-issued invitation never clears an admission blocker: a live local or SCIM
    // suspension or removal of this account or of the proven mailbox refuses admission.
    const blocked = await trx
      .selectFrom('scim_membership_blocks')
      .select('id')
      .where('organization_id', '=', proof.organizationId)
      .where('cleared_at', 'is', null)
      .where((eb) =>
        eb.or([eb('user_id', '=', proof.userId), eb('identity_email', '=', proof.mailbox)]),
      )
      .executeTakeFirst()
    if (blocked) return { refused: true }
    // The resource, after its claim.
    const entry = await trx
      .selectFrom('scim_users')
      .select(['id', 'linked_user_id', 'retired_at'])
      .where('organization_id', '=', proof.organizationId)
      .where('connection_id', '=', claim.connection_id)
      .where('id', '=', claim.scim_user_id)
      .forUpdate()
      .executeTakeFirst()
    // An expired claim is not completed even when an administrator resent its invitation:
    // the person is admitted by that invitation alone and the entry stays unlinked.
    if (
      !entry ||
      entry.retired_at !== null ||
      entry.linked_user_id !== null ||
      claim.completed_at !== null ||
      claim.invalidated_at !== null ||
      !claim.current ||
      claim.work_email !== proof.mailbox
    )
      return admitted
    // One live entry per account in a connection: an account another live entry already
    // links is admitted by its invitation, and this entry stays unlinked.
    const linked = await trx
      .selectFrom('scim_users')
      .select('id')
      .where('connection_id', '=', claim.connection_id)
      .where('linked_user_id', '=', proof.userId)
      .where('retired_at', 'is', null)
      .executeTakeFirst()
    if (linked) return admitted
    return {
      refused: false,
      finish: async (trx, member) => {
        if (member.userId !== proof.userId || member.organizationId !== proof.organizationId)
          throw new Error('The admitted member is not the proven account.')
        // The account and its new membership only: no profile, address or sign-in method of
        // the account changes, and the entry's own profile and timestamps stay as provisioned.
        const link = await trx
          .updateTable('scim_users')
          .set({ linked_user_id: proof.userId, linked_member_id: member.id })
          .where('id', '=', entry.id)
          .where('linked_user_id', 'is', null)
          .where('retired_at', 'is', null)
          .executeTakeFirst()
        const completion = await trx
          .updateTable('scim_user_claims')
          .set({ completed_at: sql<Date>`clock_timestamp()` })
          .where('id', '=', claim.id)
          .where('completed_at', 'is', null)
          .where('invalidated_at', 'is', null)
          .executeTakeFirst()
        if (link.numUpdatedRows !== 1n || completion.numUpdatedRows !== 1n)
          throw new Error('The SCIM claim changed while it was being completed.')
        await writeAuditEvent(trx, {
          organizationId: proof.organizationId,
          ...proof.audit,
          action: 'scim_user.claimed',
          targetType: 'scim_user',
          targetId: entry.id,
        })
      },
    }
  },
}
