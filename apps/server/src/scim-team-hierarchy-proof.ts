import { teamRoles } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { z } from 'zod'
import { SCIM_MAPPING_CONSENT } from './sso.ts'
import { sha256 } from './sso-mailbox-proof.ts'

export const mappingDenied = () => new DomainError('forbidden', 'scim_mapping_access_denied')

export const mappingUuid = z.uuid().transform((value) => value.toLowerCase())

// Consent outlives cleanup of the consumed fresh proof attempt. Persist only the
// facts needed to recheck its authority, with the proof's original absolute deadline.
const stepUp = z.strictObject({
  providerId: mappingUuid,
  providerRevision: z.number().int(),
  linkId: mappingUuid,
  linkGeneration: z.number().int(),
})
const proofContext = z.strictObject({
  memberVersion: z.string(),
  mailboxDigest: z.string().nullable(),
  policyRevision: z.number().int(),
  trustGeneration: z.number().int(),
  stepUp: stepUp.nullable(),
})

export interface MappingOwnerIdentity {
  organizationId: string
  userId: string
  sessionId: string
}

export async function lockMappingOwner(trx: Db, { organizationId, userId }: MappingOwnerIdentity) {
  // The membership row version also invalidates consent after demotion followed by
  // re-promotion to owner, with no additional work on the native role-write path.
  const { rows } = await sql<{
    id: string
    role: string
    memberVersion: string
    mailbox: string
  }>`
    SELECT m.id, m.role, m.xmin::text AS "memberVersion", lower(btrim(u.email)) AS mailbox
    FROM auth.member m JOIN auth."user" u ON u.id = m."userId"
    WHERE m."organizationId" = ${organizationId}::uuid AND u.id = ${userId}::uuid
      AND u."emailVerified"
      AND NOT EXISTS (
        SELECT 1 FROM personal_organizations WHERE organization_id = ${organizationId}::uuid
      )
      AND NOT EXISTS (
        SELECT 1 FROM scim_membership_blocks b
        WHERE b.organization_id = ${organizationId}::uuid AND b.cleared_at IS NULL
          AND (b.user_id = u.id OR b.identity_email = lower(btrim(u.email)))
      )
    FOR SHARE OF m
  `.execute(trx)
  const owner = rows[0]
  if (!owner || !teamRoles(owner.role).includes('owner')) throw mappingDenied()
  return owner
}

type MappingOwner = Awaited<ReturnType<typeof lockMappingOwner>>

export async function lockMappingOwnerSession(trx: Db, identity: MappingOwnerIdentity) {
  const { organizationId, sessionId, userId } = identity
  const session = await trx
    .selectFrom('auth.session')
    .select('activeOrganizationId')
    .where('id', '=', sessionId)
    .where('userId', '=', userId)
    .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
    .forShare()
    .executeTakeFirst()
  if (session?.activeOrganizationId?.toLowerCase() !== organizationId) throw mappingDenied()
}

function loadPolicy(trx: Db, organizationId: string) {
  return trx
    .selectFrom('sso_policies')
    .select(['require_sso', 'policy_revision', 'trust_generation'])
    .where('organization_id', '=', organizationId)
    .forShare()
    .executeTakeFirst()
}

function liveStepUp(
  trx: Db,
  { organizationId, userId }: MappingOwnerIdentity,
  providerId: string,
  linkId: string,
) {
  return trx
    .selectFrom('sso_identity_links as link')
    .innerJoin('sso_providers as provider', 'provider.id', 'link.provider_id')
    .select([
      'provider.id as providerId',
      'provider.revision as providerRevision',
      'link.id as linkId',
      'link.generation as linkGeneration',
    ])
    .where('link.organization_id', '=', organizationId)
    .where('provider.organization_id', '=', organizationId)
    .where('link.user_id', '=', userId)
    .where('link.id', '=', linkId)
    .where('provider.id', '=', providerId)
    .where('provider.protocol', '=', 'oidc')
    .where('provider.enabled', '=', true)
    .where('provider.retired_at', 'is', null)
    .where('link.retired_at', 'is', null)
    .forShare(['provider', 'link'])
    .executeTakeFirst()
}

export async function captureMappingConsentProof(
  trx: Db,
  identity: MappingOwnerIdentity,
  owner: MappingOwner,
  attemptId: string,
) {
  const attempt = await trx
    .selectFrom('sso_attempts')
    .select([
      'requires_mailbox',
      'requires_sso',
      'mailbox',
      'step_up_provider_id',
      'step_up_link_id',
    ])
    .select(
      sql<string>`least(expires_at, mailbox_proof_expires_at, step_up_proof_expires_at)::text`.as(
        'deadline',
      ),
    )
    .where('id', '=', attemptId)
    .where('kind', '=', 'fresh_proof')
    .where('operation', '=', SCIM_MAPPING_CONSENT)
    .where('organization_id', '=', identity.organizationId)
    .where('user_id', '=', identity.userId)
    .where('session_id', '=', identity.sessionId)
    .where('consumed_at', 'is not', null)
    .executeTakeFirst()
  if (!attempt || (attempt.requires_mailbox && attempt.mailbox !== owner.mailbox))
    throw mappingDenied()
  const policy = await loadPolicy(trx, identity.organizationId)
  const providerProof =
    attempt.requires_sso && attempt.step_up_provider_id && attempt.step_up_link_id
      ? await liveStepUp(trx, identity, attempt.step_up_provider_id, attempt.step_up_link_id)
      : undefined
  if (
    attempt.requires_sso !== (policy?.require_sso ?? false) ||
    (attempt.requires_sso && !providerProof)
  )
    throw mappingDenied()
  return {
    proof_kind: attempt.requires_sso ? 'sso' : 'mailbox',
    expires_at: attempt.deadline,
    proof_context: {
      memberVersion: owner.memberVersion,
      mailboxDigest: attempt.requires_mailbox ? sha256(owner.mailbox) : null,
      policyRevision: policy?.policy_revision ?? 0,
      trustGeneration: policy?.trust_generation ?? 1,
      stepUp: providerProof ?? null,
    } satisfies z.infer<typeof proofContext>,
  }
}

export async function recheckMappingConsentProof(
  trx: Db,
  identity: MappingOwnerIdentity,
  owner: MappingOwner,
  saved: { member_id: string; proof_kind: string; proof_context: unknown },
  ssoOidcEnabled: boolean,
) {
  const { data: proof, success } = proofContext.safeParse(saved.proof_context)
  const policy = await loadPolicy(trx, identity.organizationId)
  if (
    !success ||
    owner.id !== saved.member_id ||
    owner.memberVersion !== proof.memberVersion ||
    proof.policyRevision !== (policy?.policy_revision ?? 0) ||
    proof.trustGeneration !== (policy?.trust_generation ?? 1) ||
    saved.proof_kind !== (policy?.require_sso ? 'sso' : 'mailbox') ||
    (proof.mailboxDigest !== null && proof.mailboxDigest !== sha256(owner.mailbox))
  ) {
    throw mappingDenied()
  }
  if (saved.proof_kind === 'mailbox') {
    if (proof.mailboxDigest === null || proof.stepUp !== null) throw mappingDenied()
    return
  }
  if (!ssoOidcEnabled || !proof.stepUp) throw mappingDenied()
  const current = await liveStepUp(trx, identity, proof.stepUp.providerId, proof.stepUp.linkId)
  if (
    !current ||
    current.providerRevision !== proof.stepUp.providerRevision ||
    current.linkGeneration !== proof.stepUp.linkGeneration
  ) {
    throw mappingDenied()
  }
}
