import { ApiKeyScopeError, MCP_OAUTH_SCOPE, type Principal, teamRoles } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { checkTeamWriteDeadline } from '@hourmere/db/team-write'
import { DomainError } from '@hourmere/scheduling'
import { type Selectable, sql, type Transaction } from 'kysely'
import { z } from 'zod'
import {
  captureMappingConsentProof,
  lockMappingOwner,
  lockMappingOwnerSession,
  type MappingOwnerIdentity,
  mappingDenied,
  mappingMember,
  mappingUuid,
  recheckMappingConsentProof,
} from './scim-team-hierarchy-proof.ts'
import {
  recordScimMappingChange,
  type ScimMappingNoticeQueue,
} from './scim-team-mapping-notices.ts'
import { lockMappingTeams, retireScimTeamMapping } from './scim-team-mapping-retirement.ts'
import { SCIM_MAPPING_CONSENT } from './sso.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { teamReadAccess, teamWriteCheck } from './sso-team-reads.ts'
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
export const ScimTeamMappingApproval = z.discriminatedUnion('action', [
  link.extend({ proofAttemptId: mappingUuid.optional() }),
  unlink.extend({ proofAttemptId: mappingUuid.optional() }),
])

export type ScimTeamMappingApprovalInput = z.input<typeof ScimTeamMappingApproval>

export interface ScimTeamHierarchyDeps extends FreshProofDeps {
  /** Whether directory resources and their management interfaces are enabled. */
  resourcesEnabled: boolean
  notices?: ScimMappingNoticeQueue | undefined
}

type MappingIntent = Selectable<Database['scim_team_mapping_intents']>
type MappingConsent = Selectable<Database['scim_team_mapping_consents']>
const clockTime = sql<Date>`clock_timestamp()`
const topologyConflict = () => new DomainError('conflict', 'scim_mapping_topology_conflict')

type MappingActor = Omit<MappingOwnerIdentity, 'sessionId'> & { sessionId: string | null }

function mappingActor(deps: ScimTeamHierarchyDeps, principal: Principal): MappingActor {
  if (!deps.resourcesEnabled) throw new DomainError('not_found', 'scim_resources_disabled')
  const organizationId = mappingUuid.safeParse(principal.organization.id)
  const userId = mappingUuid.safeParse(principal.user.id)
  const sessionId = mappingUuid
    .nullable()
    .safeParse(principal.kind === 'session' ? principal.sessionId : null)
  if (!organizationId.success || !userId.success || !sessionId.success) throw mappingDenied()
  return { organizationId: organizationId.data, userId: userId.data, sessionId: sessionId.data }
}

function intentInput(input: z.output<typeof ScimTeamMappingApproval>) {
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
  const { sessionId, ...identity } = mappingActor(deps, principal)
  if (sessionId === null) throw mappingDenied()
  const actor = { ...identity, sessionId }
  const parsed = ScimTeamMappingApproval.safeParse(input)
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
          .catch((error: unknown) => {
            if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === '23514' &&
              'constraint' in error &&
              error.constraint === 'scim_team_mapping_consents_lifetime'
            )
              throw mappingDenied()
            throw error
          })
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

function ownsApproval(actor: MappingActor, consent: MappingConsent) {
  return (
    actor.organizationId === consent.organization_id &&
    actor.userId === consent.owner_id &&
    (actor.sessionId === null || actor.sessionId === consent.session_id)
  )
}

async function lockApprovedOwners(
  trx: Db,
  intent: MappingIntent,
  approvals: MappingConsent[],
  actor: MappingActor,
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
  const organizations = await lockMappingTeams(trx, teams)
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
  if (actor.sessionId !== null)
    await lockMappingOwnerSession(trx, { ...actor, sessionId: actor.sessionId })
  for (const { identity, owner, consent } of owners) {
    await recheckMappingConsentProof(trx, identity, owner, consent, ssoOidcEnabled)
  }
  await assertLiveApprovals(trx, intent.id)
  return consents
}

async function currentLinkGeneration(trx: Db, childOrganizationId: string) {
  const generation = await trx
    .selectFrom('scim_team_link_generations')
    .select('generation')
    .where('child_organization_id', '=', childOrganizationId)
    .executeTakeFirst()
  return generation?.generation ?? 0
}

export async function listScimTeamMappings(
  deps: ScimTeamHierarchyDeps,
  principal: Principal,
  expectedOrganizationId?: string,
) {
  const { organizationId, sessionId, userId } = mappingActor(deps, principal)
  if (
    expectedOrganizationId !== undefined &&
    mappingUuid.safeParse(expectedOrganizationId).data !== organizationId
  )
    throw mappingDenied()
  return deps.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const member = await mappingMember(trx, { organizationId, userId }, false)
      const roles = teamRoles(member?.role)
      const owner = roles.includes('owner')
      if (!owner && !roles.includes('admin')) throw mappingDenied()
      if (sessionId !== null)
        await lockMappingOwnerSession(trx, { organizationId, userId, sessionId }, false)
      const access = await teamReadAccess({ ...deps, db: trx }, principal)()
      if (!access.allowed) throw mappingDenied()
      const mappings = await trx
        .selectFrom('scim_team_mappings')
        .select([
          'id',
          'parent_organization_id as parentOrganizationId',
          'child_organization_id as childOrganizationId',
          'connection_id as connectionId',
          'external_id as externalId',
          sql<
            'pending' | 'suspended'
          >`CASE WHEN suspended_at IS NULL THEN 'pending' ELSE 'suspended' END`.as('state'),
        ])
        .where((eb) =>
          eb.or([
            eb('live_parent_organization_id', '=', organizationId),
            eb('live_child_organization_id', '=', organizationId),
          ]),
        )
        .orderBy('id')
        .execute()
      const connection = owner
        ? await trx
            .selectFrom('scim_connections')
            .select('id')
            .where('organization_id', '=', organizationId)
            .executeTakeFirst()
        : undefined
      return {
        mappings,
        connectionId: connection?.id ?? null,
        linkGeneration: owner ? await currentLinkGeneration(trx, organizationId) : null,
      }
    })
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

async function unlinkTeams(trx: Transaction<Database>, intent: MappingIntent) {
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

  await retireScimTeamMapping(trx, mapping.id, intent.child_organization_id)
  return mapping.id
}

/** Apply one approved operation with both organization update locks held through commit. */
export async function commitScimTeamMapping(
  deps: ScimTeamHierarchyDeps,
  principal: Principal,
  intentId: string,
  expectedAction?: { action: 'link' } | { action: 'unlink'; mappingId: string },
) {
  const actor = mappingActor(deps, principal)
  if (principal.kind === 'api_key' && principal.apiKeyScope !== 'full') throw new ApiKeyScopeError()
  if (
    principal.kind === 'oauth' &&
    (!principal.oauthGrantId || !principal.scopes.includes(MCP_OAUTH_SCOPE))
  )
    throw mappingDenied()
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
      if (
        !intent ||
        (expectedAction && intent.action !== expectedAction.action) ||
        (expectedAction?.action === 'unlink' &&
          mappingUuid.safeParse(expectedAction.mappingId).data !== intent.mapping_id)
      )
        throw mappingDenied()
      const consents = await readApprovals(trx, intent.id).execute()
      if (consents.length !== 2 || !consents.some((consent) => ownsApproval(actor, consent)))
        throw mappingDenied()

      const current = await lockApprovedOwners(
        trx,
        intent,
        consents,
        actor,
        deps.capabilities.ssoOidcEnabled,
      )
      const delegationDeadline =
        principal.kind === 'session'
          ? undefined
          : await teamWriteCheck(deps, principal, true)
              .lockProof(trx)
              .catch((error: unknown) => {
                if (error instanceof DomainError && error.code === 'sso_required')
                  throw mappingDenied()
                throw error
              })
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
      await recordScimMappingChange(
        trx,
        deps.notices,
        mappingId,
        intent.action === 'link' ? 'linked' : 'unlinked',
        current.map(({ organization_id, owner_id }) => ({
          organizationId: organization_id,
          actor: { type: 'user', id: owner_id },
        })),
      )
      await trx
        .updateTable('scim_team_mapping_intents')
        .set({ consumed_at: clockTime })
        .where('id', '=', intent.id)
        .execute()
      await assertLiveApprovals(trx, intent.id)
      await checkTeamWriteDeadline(trx, delegationDeadline, () => {
        throw mappingDenied()
      })
      return { mappingId, generation }
    })
}
