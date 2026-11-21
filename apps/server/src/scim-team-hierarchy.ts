import { type Principal, teamRoles } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { type Selectable, sql } from 'kysely'
import { z } from 'zod'
import {
  captureMappingConsentProof,
  lockMappingOwner,
  lockMappingOwnerSession,
  type MappingOwnerIdentity,
  mappingDenied,
  mappingUuid,
  recheckMappingConsentProof,
} from './scim-team-hierarchy-proof.ts'
import { SCIM_MAPPING_CONSENT } from './sso.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const inputScope = {
  intentId: mappingUuid,
  parentOrganizationId: mappingUuid,
  childOrganizationId: mappingUuid,
  connectionId: mappingUuid,
}
const link = z.strictObject({
  ...inputScope,
  action: z.literal('link'),
  externalId: z
    .string()
    .refine(
      (value) =>
        value.isWellFormed() &&
        !value.includes('\u0000') &&
        [...value].length >= 1 &&
        [...value].length <= 256,
    ),
  linkGeneration: z.int32().nonnegative(),
  allowGroupRetirement: z.literal(true),
})
const unlink = z.strictObject({
  ...inputScope,
  action: z.literal('unlink'),
  mappingId: mappingUuid,
})
const approval = z.discriminatedUnion('action', [
  link.extend({ proofAttemptId: mappingUuid.optional() }),
  unlink.extend({ proofAttemptId: mappingUuid.optional() }),
])

export type ScimTeamMappingApprovalInput = z.input<typeof approval>

export interface ScimTeamHierarchyDeps extends FreshProofDeps {
  /** No production registration. The SCIM resource test harness supplies this flag. */
  resourcesEnabled: boolean
}

type MappingIntent = Selectable<Database['scim_team_mapping_intents']>
type MappingConsent = Selectable<Database['scim_team_mapping_consents']>
const clockTime = sql<Date>`clock_timestamp()`
const topologyConflict = () => new DomainError('conflict', 'scim_mapping_topology_conflict')

function mappingActor(deps: ScimTeamHierarchyDeps, principal: Principal): MappingOwnerIdentity {
  if (!deps.resourcesEnabled) throw new DomainError('not_found', 'scim_resources_disabled')
  if (principal.kind !== 'session') throw mappingDenied()
  const organizationId = mappingUuid.safeParse(principal.organization.id)
  const userId = mappingUuid.safeParse(principal.user.id)
  const sessionId = mappingUuid.safeParse(principal.sessionId)
  if (!organizationId.success || !userId.success || !sessionId.success) throw mappingDenied()
  return { organizationId: organizationId.data, userId: userId.data, sessionId: sessionId.data }
}

function intentInput(input: z.output<typeof approval>) {
  return {
    id: input.intentId,
    action: input.action,
    parent_organization_id: input.parentOrganizationId,
    child_organization_id: input.childOrganizationId,
    connection_id: input.connectionId,
    external_id: input.action === 'link' ? input.externalId : null,
    link_generation: input.action === 'link' ? input.linkGeneration : null,
    allow_group_retirement: input.action === 'link' ? input.allowGroupRetirement : null,
    mapping_id: input.action === 'unlink' ? input.mappingId : null,
  }
}

async function assertLiveApprovals(trx: Db, intentId: string, organizationId?: string) {
  const approvals = await trx
    .selectFrom('scim_team_mapping_consents as consent')
    .innerJoin('auth.session as session', (join) =>
      join
        .onRef('session.id', '=', 'consent.session_id')
        .onRef('session.userId', '=', 'consent.owner_id'),
    )
    .select('consent.organization_id')
    .where('consent.intent_id', '=', intentId)
    .where('consent.expires_at', '>', clockTime)
    .where('session.expiresAt', '>', clockTime)
    .$if(organizationId !== undefined, (query) =>
      query.where('consent.organization_id', '=', organizationId as string),
    )
    .execute()
  if (approvals.length !== (organizationId === undefined ? 2 : 1)) throw mappingDenied()
}

/**
 * One current owner approves from their own active team. The intent nonce must
 * be shared with the other owner together with the exact same input.
 */
export async function approveScimTeamMapping(
  deps: ScimTeamHierarchyDeps,
  principal: Principal,
  headers: Headers,
  input: ScimTeamMappingApprovalInput,
) {
  const actor = mappingActor(deps, principal)
  const parsed = approval.safeParse(input)
  if (!parsed.success) throw new DomainError('invalid', 'invalid_request')
  const agreed = parsed.data
  const intent = intentInput(agreed)
  const teams = [intent.parent_organization_id, intent.child_organization_id]
  if (!teams.includes(actor.organizationId)) throw mappingDenied()
  const expected = mappingUuid.safeParse(headers.get(EXPECTED_ORGANIZATION_HEADER))

  let owner: Awaited<ReturnType<typeof lockMappingOwner>> | undefined
  return runWithFreshProof(
    deps,
    {
      headers,
      ...actor,
      operation: SCIM_MAPPING_CONSENT,
      // Before both owners approve, the counterpart stays an opaque input.
      // This ceremony changes only the approving side's consent.
      scimMappingConsentEnabled: true,
      proofMode: 'administration',
      input: agreed,
      schema: agreed.action === 'link' ? link : unlink,
    },
    {
      authorize: async (trx) => {
        owner = await lockMappingOwner(trx, actor)
        await lockMappingOwnerSession(trx, actor)
        if (!expected.success || expected.data !== actor.organizationId) throw mappingDenied()
        if (teams[0] === teams[1]) throw topologyConflict()
      },
      mutate: async (trx, _input, _browserBinding, _mailboxProof, attemptId) => {
        if (!owner) throw mappingDenied()
        const proof = await captureMappingConsentProof(trx, actor, owner, attemptId)
        await trx
          .insertInto('scim_team_mapping_intents')
          .values(intent)
          .onConflict((conflict) => conflict.column('id').doNothing())
          .execute()
        const stored = await trx
          .selectFrom('scim_team_mapping_intents')
          .selectAll()
          .where('id', '=', intent.id)
          .where('consumed_at', 'is', null)
          .forUpdate()
          .executeTakeFirst()
        if (
          !stored ||
          !Object.entries(intent).every(
            ([key, value]) => stored[key as keyof MappingIntent] === value,
          )
        )
          throw mappingDenied()

        const consent = await trx
          .insertInto('scim_team_mapping_consents')
          .values({
            intent_id: intent.id,
            organization_id: actor.organizationId,
            owner_id: actor.userId,
            member_id: owner.id,
            session_id: actor.sessionId,
            approved_at: clockTime,
            ...proof,
          })
          .onConflict((conflict) => conflict.columns(['intent_id', 'organization_id']).doNothing())
          .returning('organization_id')
          .executeTakeFirst()
        if (!consent) throw mappingDenied()
        await assertLiveApprovals(trx, intent.id, actor.organizationId)
        return { intentId: intent.id }
      },
    },
  )
}

function readApprovals(trx: Db, intentId: string) {
  return trx
    .selectFrom('scim_team_mapping_consents')
    .selectAll()
    .where('intent_id', '=', intentId)
    .orderBy('organization_id')
}

function ownsApproval(actor: MappingOwnerIdentity, consent: MappingConsent) {
  return (
    actor.organizationId === consent.organization_id &&
    actor.userId === consent.owner_id &&
    actor.sessionId === consent.session_id
  )
}

async function lockApprovedOwners(
  trx: Db,
  intent: MappingIntent,
  approvals: MappingConsent[],
  actor: MappingOwnerIdentity,
  ssoOidcEnabled: boolean,
) {
  const teams = [intent.parent_organization_id, intent.child_organization_id]
  const approvers = approvals.map(({ owner_id }) => owner_id)
  // Existing native membership writes acquire the actor identity share lock first.
  await trx
    .selectFrom('auth.user')
    .select('id')
    .where('id', 'in', approvers)
    .orderBy('id')
    .forShare()
    .execute()
  const organizations = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', 'in', teams)
    .orderBy('id')
    .forUpdate()
    .execute()
  if (organizations.length !== teams.length) throw mappingDenied()

  const current = await trx
    .selectFrom('scim_team_mapping_intents')
    .select('id')
    .where('id', '=', intent.id)
    .where('consumed_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!current) throw mappingDenied()
  const consents = await readApprovals(trx, intent.id).forUpdate().execute()
  if (
    consents.length !== 2 ||
    consents.some(
      (consent, index) =>
        !teams.includes(consent.organization_id) || consent.owner_id !== approvals[index]?.owner_id,
    ) ||
    !consents.some((consent) => ownsApproval(actor, consent))
  )
    throw mappingDenied()

  const owners = []
  for (const consent of consents) {
    const identity = {
      organizationId: consent.organization_id,
      userId: consent.owner_id,
      sessionId: consent.session_id,
    }
    owners.push({ identity, consent, owner: await lockMappingOwner(trx, identity) })
  }
  // A single owner can approve twice by switching teams. Only the submitting
  // browser's active team must match now; the other approval's session must live.
  await trx
    .selectFrom('auth.session')
    .select('id')
    .where(
      'id',
      'in',
      consents.map(({ session_id }) => session_id),
    )
    .orderBy('id')
    .forShare()
    .execute()
  await lockMappingOwnerSession(trx, actor)
  for (const { identity, owner, consent } of owners) {
    await recheckMappingConsentProof(trx, identity, owner, consent, ssoOidcEnabled)
  }
  await assertLiveApprovals(trx, intent.id)
}

async function currentLinkGeneration(trx: Db, childOrganizationId: string) {
  const generation = await trx
    .selectFrom('scim_team_link_generations')
    .select('generation')
    .where('child_organization_id', '=', childOrganizationId)
    .executeTakeFirst()
  return generation?.generation ?? 0
}

async function linkTeams(trx: Db, intent: MappingIntent) {
  const {
    parent_organization_id,
    child_organization_id,
    connection_id,
    link_generation,
    external_id,
  } = intent
  if (external_id === null || !intent.allow_group_retirement) throw mappingDenied()
  if ((await currentLinkGeneration(trx, child_organization_id)) !== link_generation)
    throw new DomainError('conflict', 'scim_mapping_generation_changed')

  // A link is both the edge and the reservation, including pending or suspended
  // mappings. Read topology only after checking both sides' owner approvals.
  const conflict = await trx
    .selectFrom('scim_team_mappings')
    .select('id')
    .where((eb) =>
      eb.or([
        eb('live_child_organization_id', 'in', [parent_organization_id, child_organization_id]),
        eb('live_parent_organization_id', '=', child_organization_id),
        eb.and([eb('live_connection_id', '=', connection_id), eb('external_id', '=', external_id)]),
      ]),
    )
    .limit(1)
    .executeTakeFirst()
  if (conflict) throw topologyConflict()

  const { id } = await trx
    .insertInto('scim_team_mappings')
    .values({ parent_organization_id, child_organization_id, connection_id, external_id })
    .returning('id')
    .executeTakeFirstOrThrow()
  return id
}

async function unlinkTeams(trx: Db, intent: MappingIntent) {
  const mapping = await trx
    .selectFrom('scim_team_mappings')
    .select('id')
    .where('id', '=', intent.mapping_id)
    .where('live_parent_organization_id', '=', intent.parent_organization_id)
    .where('live_child_organization_id', '=', intent.child_organization_id)
    .where('live_connection_id', '=', intent.connection_id)
    .forUpdate()
    .executeTakeFirst()
  if (!mapping) throw mappingDenied()

  // Native role changes lock the same child before editing the member, so a
  // concurrent promotion that commits before retirement is seen by this read.
  const roster = await trx
    .selectFrom('scim_team_managed_memberships as source')
    .innerJoin('auth.member as member', (join) =>
      join
        .onRef('member.id', '=', 'source.member_id')
        .onRef('member.userId', '=', 'source.user_id')
        .onRef('member.organizationId', '=', 'source.child_organization_id'),
    )
    .select('member.role')
    .where('source.mapping_id', '=', mapping.id)
    .where('source.child_organization_id', '=', intent.child_organization_id)
    .execute()
  if (
    roster.some(({ role }) => teamRoles(role).some((item) => item === 'owner' || item === 'admin'))
  )
    throw new DomainError('forbidden', 'scim_mapping_privileged_member')
  // The Group lifecycle steps will own roster departure and credential revocation.
  if (roster.length > 0) throw new DomainError('conflict', 'scim_mapping_roster_requires_departure')

  await trx
    .updateTable('scim_team_mappings')
    .set({ retired_at: clockTime })
    .where('id', '=', mapping.id)
    .execute()
  return mapping.id
}

/** Apply one approved operation with both organization update locks held through commit. */
export async function commitScimTeamMapping(
  deps: ScimTeamHierarchyDeps,
  principal: Principal,
  intentId: string,
) {
  const actor = mappingActor(deps, principal)
  const id = mappingUuid.safeParse(intentId)
  if (!id.success) throw mappingDenied()
  return deps.db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      // Pre-read the identities and teams so all required locks start in sorted order.
      const intent = await trx
        .selectFrom('scim_team_mapping_intents')
        .selectAll()
        .where('id', '=', id.data)
        .where('consumed_at', 'is', null)
        .executeTakeFirst()
      if (!intent) throw mappingDenied()
      const consents = await readApprovals(trx, intent.id).execute()
      if (consents.length !== 2 || !consents.some((consent) => ownsApproval(actor, consent)))
        throw mappingDenied()

      await lockApprovedOwners(trx, intent, consents, actor, deps.capabilities.ssoOidcEnabled)
      const connection = await trx
        .selectFrom('scim_connections')
        .select('id')
        .where('id', '=', intent.connection_id)
        .where('organization_id', '=', intent.parent_organization_id)
        .forKeyShare()
        .executeTakeFirst()
      if (!connection) throw mappingDenied()

      const mappingId =
        intent.action === 'link' ? await linkTeams(trx, intent) : await unlinkTeams(trx, intent)
      const generation = await currentLinkGeneration(trx, intent.child_organization_id)
      await trx
        .updateTable('scim_team_mapping_intents')
        .set({ consumed_at: clockTime })
        .where('id', '=', intent.id)
        .execute()
      await assertLiveApprovals(trx, intent.id)
      return { mappingId, generation }
    })
}
