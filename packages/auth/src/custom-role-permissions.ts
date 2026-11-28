import { customRoleCatalogueV1, isCustomRolePermission } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import type { Principal } from './caller.ts'
import { isUuid } from './organizations.ts'
import { teamRoles } from './team-management.ts'

export interface TeamPermissionMembership {
  userId: string
  emailVerified: boolean
  memberId: string
  /** The exact live Better Auth role string, for each operation's existing predicate. */
  role: string
  personal: boolean
}

export interface TeamPermissionCheck {
  operation: string
  /**
   * Run the existing operation predicate. Base Member and independent relationship
   * authority use 'base'. Team authority that depends on a fixed management role
   * uses 'elevated'.
   */
  fixed: (membership: TeamPermissionMembership) => 'denied' | 'base' | 'elevated'
  /** Confirms the issued fixed authority covers this operation, target and projection. */
  versionedFixed?: boolean
  /** Current transport, proof and object/field checks for the custom path. Omission denies. */
  custom?: boolean
}

export interface TeamPermissionDecision {
  operation: string
  allowed: boolean
  source: 'fixed' | 'custom' | null
}

export interface TeamPermissionResult {
  decisions: TeamPermissionDecision[]
  membershipGeneration: number | null
  policyVersion: { masterEpoch: number; teamEpoch: number } | null
}

export interface TeamPermissionOptions {
  /** An in-process rollout capability. Production keeps the default off. */
  available?: boolean
  /** The exact authorization accepted for this credential by its authentication path. */
  credential?: { authorizationId: string; generation: number }
}

const operationsV1: ReadonlySet<string> = new Set([
  ...customRoleCatalogueV1.fixed,
  ...customRoleCatalogueV1.phaseOne,
  ...customRoleCatalogueV1.phaseTwoPersonalData,
])
const phaseOne: ReadonlySet<string> = new Set(customRoleCatalogueV1.phaseOne)

function credentialBinding(principal: Principal) {
  switch (principal.kind) {
    case 'session':
      return { field: 'session_id', id: principal.sessionId } as const
    case 'api_key':
      return { field: 'api_key_id', id: principal.apiKeyId } as const
    case 'oauth':
      return { field: 'oauth_grant_id', id: principal.oauthGrantId } as const
  }
}

export async function getTeamCredentialAuthorization(db: Db, principal: Principal) {
  const { field, id } = credentialBinding(principal)
  if (!id || !isUuid(id) || !isUuid(principal.user.id) || !isUuid(principal.organization.id))
    return undefined
  const row = await db
    .selectFrom('team_credential_authorizations')
    .select(['id', 'credential_generation'])
    .where(field, '=', id)
    .where('organization_id', '=', principal.organization.id)
    .where('user_id', '=', principal.user.id)
    .executeTakeFirst()
  return row && { authorizationId: row.id, generation: row.credential_generation }
}

export async function withTeamCredential<T extends Principal>(
  db: Db,
  principal: T,
  available: boolean,
  membershipGeneration: number,
): Promise<T> {
  if (principal.organization.personal) return principal
  if (!available && membershipGeneration <= 1) return principal
  const credential = await getTeamCredentialAuthorization(db, principal)
  return {
    ...principal,
    customRoleAuthorization: { available, ...(credential && { credential }) },
  }
}

/**
 * Resolve every operation against a single current PostgreSQL snapshot. Callers
 * authenticate the principal and enforce their credential/operation-specific
 * predicates. Later service writes must call inside their write transaction,
 * after acquiring the organization and resource locks. This result is never a
 * reusable credential, and the next decision always re-reads live state.
 */
export async function resolveTeamPermissions(
  db: Db,
  principal: Principal,
  teamId: string,
  checks: readonly TeamPermissionCheck[],
  options: TeamPermissionOptions = {},
): Promise<TeamPermissionResult | undefined> {
  if (
    !isUuid(teamId) ||
    !isUuid(principal.user.id) ||
    teamId.toLowerCase() !== principal.organization.id.toLowerCase() ||
    (principal.kind === 'session' && !isUuid(principal.sessionId))
  )
    return undefined

  const binding = credentialBinding(principal)
  const accepted = options.credential
  const bindCredential =
    binding.id &&
    isUuid(binding.id) &&
    accepted &&
    isUuid(accepted.authorizationId) &&
    Number.isInteger(accepted.generation) &&
    accepted.generation >= 1 &&
    accepted.generation <= 2_147_483_647
  let query = db
    .selectFrom('auth.member as member')
    .innerJoin('auth.user as user', 'user.id', 'member.userId')
    .leftJoin(
      'personal_organizations as personal',
      'personal.organization_id',
      'member.organizationId',
    )
    .leftJoin('team_member_authorizations as authorization', (join) =>
      join
        .onRef('authorization.organization_id', '=', 'member.organizationId')
        .onRef('authorization.member_id', '=', 'member.id')
        .onRef('authorization.user_id', '=', 'member.userId'),
    )
    .leftJoin('team_custom_role_policies as team', 'team.organization_id', 'member.organizationId')
    .leftJoin('custom_role_master_policy as master', (join) =>
      join.on('master.singleton', '=', true),
    )
    .leftJoin('team_credential_authorizations as credential', (join) =>
      join
        .onRef('credential.organization_id', '=', 'authorization.organization_id')
        .onRef('credential.member_id', '=', 'authorization.member_id')
        .onRef('credential.user_id', '=', 'authorization.user_id')
        .onRef('credential.member_generation', '=', 'authorization.generation')
        .on(
          bindCredential
            ? sql<boolean>`credential.id = ${accepted.authorizationId}::uuid
                AND credential.${sql.ref(binding.field)} = ${binding.id}::uuid
                AND credential.credential_generation = ${accepted.generation}`
            : sql<boolean>`false`,
        ),
    )
    .leftJoin('custom_role_assignments as assignment', (join) =>
      join
        .onRef('assignment.organization_id', '=', 'authorization.organization_id')
        .onRef('assignment.member_id', '=', 'authorization.member_id')
        .onRef('assignment.user_id', '=', 'authorization.user_id')
        .onRef('assignment.assigned_by_user_id', '!=', 'member.userId')
        .on('team.enabled', '=', true)
        .on('master.enabled', '=', true)
        .on('authorization.fixed_role', '=', 'member')
        .on(sql<boolean>`${options.available === true}`),
    )
    .leftJoin('custom_roles as role', (join) =>
      join
        .onRef('role.organization_id', '=', 'assignment.organization_id')
        .onRef('role.id', '=', 'assignment.role_id')
        .on('role.archived_at', 'is', null),
    )
    .leftJoin('custom_role_revisions as revision', (join) =>
      join
        .onRef('revision.organization_id', '=', 'role.organization_id')
        .onRef('revision.role_id', '=', 'role.id')
        .onRef('revision.revision', '=', 'role.active_revision'),
    )
    .select([
      'member.id as memberId',
      'member.userId',
      'user.emailVerified',
      'member.role',
      'personal.organization_id as personalId',
      'authorization.generation',
      'authorization.legacy_role_tokens as snapshotTokens',
      'team.policy_epoch as teamEpoch',
      'master.policy_epoch as masterEpoch',
      'credential.catalogue_version as ceilingCatalogue',
      'credential.policy_epoch as ceilingTeamEpoch',
      'credential.master_epoch as ceilingMasterEpoch',
      'credential.permission_ids as ceilingPermissions',
      'revision.catalogue_version as revisionCatalogue',
      'revision.permission_ids as revisionPermissions',
    ])
    .where('member.organizationId', '=', teamId)
    .where('member.userId', '=', principal.user.id)
    .where((eb) =>
      eb.not(scimSuspended(teamId, principal.user.id, principal.scimResourcesEnabled === true)),
    )
  if (principal.kind === 'session') {
    const sessionId = principal.sessionId
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('auth.session as session')
          .select('session.id')
          .where('session.id', '=', sessionId)
          .whereRef('session.userId', '=', 'member.userId')
          .where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)
          .where((eb) =>
            eb.or([
              eb(sql<string>`lower(session."activeOrganizationId")`, '=', teamId.toLowerCase()),
              eb.and([
                eb('personal.organization_id', 'is not', null),
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('auth.member as active')
                      .select('active.id')
                      .where(
                        sql<string>`active."organizationId"::text`,
                        '=',
                        sql<string>`lower(session."activeOrganizationId")`,
                      )
                      .whereRef('active.userId', '=', 'session.userId')
                      .where((eb) =>
                        eb.not(
                          scimSuspended(
                            eb.ref('active.organizationId'),
                            eb.ref('active.userId'),
                            principal.scimResourcesEnabled === true,
                          ),
                        ),
                      ),
                  ),
                ),
              ]),
            ]),
          ),
      ),
    )
  }

  const facts = await query.executeTakeFirst()
  if (!facts) return undefined
  const personal = facts.personalId !== null
  const membership = {
    userId: facts.userId,
    emailVerified: facts.emailVerified,
    memberId: facts.memberId,
    role: facts.role,
    personal,
  }
  const {
    generation,
    ceilingPermissions,
    revisionCatalogue,
    revisionPermissions,
    teamEpoch,
    masterEpoch,
  } = facts
  const ceilingValid =
    facts.ceilingCatalogue === customRoleCatalogueV1.version &&
    ceilingPermissions &&
    new Set(ceilingPermissions).size === ceilingPermissions.length &&
    ceilingPermissions.every((id) => operationsV1.has(id))
  const liveTokens = teamRoles(membership.role)
  const customValid =
    !personal &&
    membership.emailVerified &&
    liveTokens.length === 1 &&
    liveTokens[0] === 'member' &&
    facts.snapshotTokens?.length === 1 &&
    facts.snapshotTokens[0] === 'member' &&
    revisionCatalogue !== null &&
    revisionPermissions &&
    new Set(revisionPermissions).size === revisionPermissions.length &&
    revisionPermissions.every((id) => isCustomRolePermission(revisionCatalogue, id))

  const decisions = checks.map(
    ({ operation, fixed, versionedFixed, custom }): TeamPermissionDecision => {
      const fixedVerdict = fixed(membership)
      const inCeiling = ceilingValid && ceilingPermissions.includes(operation)
      if (
        fixedVerdict === 'base' ||
        (fixedVerdict === 'elevated' &&
          (generation === null || generation === 1 || (inCeiling && versionedFixed === true)))
      )
        return { operation, allowed: true, source: 'fixed' }
      if (
        custom === true &&
        customValid &&
        phaseOne.has(operation) &&
        inCeiling &&
        teamEpoch === facts.ceilingTeamEpoch &&
        masterEpoch === facts.ceilingMasterEpoch &&
        revisionPermissions.some((id) => id === operation)
      )
        return { operation, allowed: true, source: 'custom' }
      return { operation, allowed: false, source: null }
    },
  )
  return {
    decisions,
    membershipGeneration: generation,
    policyVersion: teamEpoch !== null && masterEpoch !== null ? { teamEpoch, masterEpoch } : null,
  }
}
