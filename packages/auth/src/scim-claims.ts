// SCIM claim completion joins ordinary invitation acceptance or explicit OIDC account
// linking. Both call it only after current-account and mailbox proof.
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

/** A current ordinary member explicitly linking their verified OIDC identity. */
type ScimLinkProof = Omit<ScimInvitationProof, 'invitationId'>

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

/** Completes SCIM claims inside the transaction that validates their proof. */
export interface ScimClaimCompletion {
  /**
   * Invitation acceptance calls this after its organization, session and invitation locks and
   * its own recipient, expiry, inviter, membership and capacity checks, in its transaction.
   */
  invitation(trx: Db, proof: ScimInvitationProof): Promise<ScimClaimDecision>
  /** Explicit OIDC linking holds an update lock on the team before this claim check. */
  link?(trx: Db, proof: ScimLinkProof): Promise<ScimClaimDecision>
}

const admitted: ScimClaimDecision = { refused: false }

function liveBlock(trx: Db, { organizationId, userId, mailbox }: ScimLinkProof) {
  return trx
    .selectFrom('scim_membership_blocks')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('cleared_at', 'is', null)
    .where((eb) => eb.or([eb('user_id', '=', userId), eb('identity_email', '=', mailbox)]))
    .executeTakeFirst()
}

function alreadyLinked(trx: Db, connectionId: string, userId: string) {
  return trx
    .selectFrom('scim_users')
    .select('id')
    .where('connection_id', '=', connectionId)
    .where('linked_user_id', '=', userId)
    .where('retired_at', 'is', null)
    .executeTakeFirst()
}

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
    const blocked = await liveBlock(trx, proof)
    if (blocked) return { refused: true }
    // The resource, after its claim.
    const entry = await trx
      .selectFrom('scim_users')
      .select(['id', 'active', 'linked_user_id', 'retired_at'])
      .where('organization_id', '=', proof.organizationId)
      .where('connection_id', '=', claim.connection_id)
      .where('id', '=', claim.scim_user_id)
      .forUpdate()
      .executeTakeFirst()
    if (entry?.retired_at === null && !entry.active) return { refused: true }
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
    const linked = await alreadyLinked(trx, claim.connection_id, proof.userId)
    if (linked) return admitted
    return { refused: false, finish: finishScimClaim(proof, entry.id, claim.id) }
  },
  async link(trx, proof) {
    const claims = await trx
      .selectFrom('scim_user_claims as claim')
      .innerJoin('scim_users as entry', (join) =>
        join
          .onRef('entry.id', '=', 'claim.scim_user_id')
          .onRef('entry.organization_id', '=', 'claim.organization_id')
          .onRef('entry.connection_id', '=', 'claim.connection_id'),
      )
      .select(['claim.id', 'claim.connection_id', 'claim.scim_user_id'])
      .where('claim.organization_id', '=', proof.organizationId)
      .where('claim.work_email', '=', proof.mailbox)
      .where('claim.invitation_id', 'is', null)
      .where('claim.completed_at', 'is', null)
      .where('claim.invalidated_at', 'is', null)
      .where('claim.expires_at', '>', sql<Date>`${proof.checkedAt}::timestamptz`)
      .where('entry.active', '=', true)
      .where('entry.retired_at', 'is', null)
      .where('entry.linked_user_id', 'is', null)
      .orderBy('claim.id')
      .limit(2)
      .forUpdate(['claim', 'entry'])
      .execute()
    const [claim] = claims
    if (!claim) return admitted
    if (await liveBlock(trx, proof)) return { refused: true }
    // Leave the entries unlinked when the proof matches more than one candidate.
    if (claims.length !== 1 || (await alreadyLinked(trx, claim.connection_id, proof.userId)))
      return admitted
    return { refused: false, finish: finishScimClaim(proof, claim.scim_user_id, claim.id) }
  },
}

/** A directory invitation that would attach a claim waits until provisioning resumes. */
export const scimClaimAdmissionOnly: ScimClaimCompletion = {
  async invitation(trx, proof) {
    const decision = await scimClaimCompletion.invitation(trx, proof)
    if (decision.refused || decision.finish) return { refused: true }
    return admitted
  },
}

/** Attach the claim to a member after its admission has been checked under the team lock. */
export function finishScimClaim(
  proof: Pick<ScimInvitationProof, 'organizationId' | 'userId' | 'audit'>,
  entryId: string,
  claimId: string,
): ScimClaimFinish {
  return async (trx, member) => {
    if (member.userId !== proof.userId || member.organizationId !== proof.organizationId)
      throw new Error('The admitted member is not the proven account.')
    // The account and its membership only: no profile, address or sign-in method of
    // the account changes, and the entry's own profile and timestamps stay as provisioned.
    const link = await trx
      .updateTable('scim_users')
      .set({ linked_user_id: proof.userId, linked_member_id: member.id })
      .where('id', '=', entryId)
      .where('linked_user_id', 'is', null)
      .where('retired_at', 'is', null)
      .executeTakeFirst()
    const completion = await trx
      .updateTable('scim_user_claims')
      .set({ completed_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', claimId)
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
      targetId: entryId,
    })
  }
}
