import { customRoleCatalogueV1 } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import type { ApiKeyScope } from './api-key-metadata.ts'
import { isUuid } from './organizations.ts'

export const TEAM_AUTHORIZATION_REVIEW_HEADER = 'X-Hourmere-Reviewed-Team-Authorization'

const ownerOnlyOperations = new Set([
  'audit.update_retention',
  'members.assign_role',
  'scim.approve_mapping',
  'scim.create_token',
  'scim.link_team',
  'scim.rotate_token',
  'scim.unlink_team',
  'sso.activate_provider',
  'sso.deactivate_provider',
  'sso.set_enforcement',
  'sso.nominate_recovery',
  'sso.accept_recovery',
  'sso.use_recovery',
])

export async function teamAuthorizationFacts(
  db: Db,
  teamId: string,
  userId: string,
  available: boolean,
  scimResourcesEnabled = false,
) {
  const row = await db
    .selectFrom('auth.member as member')
    .innerJoin('auth.user as user', 'user.id', 'member.userId')
    .innerJoin('team_member_authorizations as authorization', (join) =>
      join
        .onRef('authorization.organization_id', '=', 'member.organizationId')
        .onRef('authorization.member_id', '=', 'member.id')
        .onRef('authorization.user_id', '=', 'member.userId'),
    )
    .innerJoin('team_custom_role_policies as team', 'team.organization_id', 'member.organizationId')
    .innerJoin('custom_role_master_policy as master', (join) =>
      join.on('master.singleton', '=', true),
    )
    .leftJoin('custom_role_assignments as assignment', (join) =>
      join
        .onRef('assignment.organization_id', '=', 'member.organizationId')
        .onRef('assignment.member_id', '=', 'member.id')
        .onRef('assignment.user_id', '=', 'member.userId')
        .onRef('assignment.assigned_by_user_id', '!=', 'member.userId'),
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
      'member.role as liveRole',
      'authorization.fixed_role as fixedRole',
      'authorization.generation',
      'team.enabled as teamEnabled',
      'master.enabled as masterEnabled',
      'team.policy_epoch as teamEpoch',
      'master.policy_epoch as masterEpoch',
      'revision.catalogue_version as catalogueVersion',
      'revision.permission_ids as assignedPermissions',
    ])
    .where('member.organizationId', '=', teamId)
    .where('member.userId', '=', userId)
    .where('user.emailVerified', '=', true)
    .where(({ not }) => not(scimSuspended(teamId, userId, scimResourcesEnabled)))
    .executeTakeFirst()
  if (!row) return undefined
  const custom =
    available &&
    row.teamEnabled &&
    row.masterEnabled &&
    row.fixedRole === 'member' &&
    row.liveRole.trim() === 'member' &&
    row.catalogueVersion === customRoleCatalogueV1.version
      ? (row.assignedPermissions ?? [])
      : []
  const permissionIds = custom.every((id) =>
    customRoleCatalogueV1.phaseOne.some((operation) => operation === id),
  )
    ? custom
    : []
  const elevated =
    (row.fixedRole === 'owner' || row.fixedRole === 'admin') &&
    row.liveRole.trim() === row.fixedRole
  return {
    ...row,
    permissionIds,
    elevated,
    ceiling: {
      organization_id: teamId,
      user_id: userId,
      member_id: row.memberId,
      member_generation: row.generation,
      master_epoch: row.masterEpoch,
      policy_epoch: row.teamEpoch,
      catalogue_version: customRoleCatalogueV1.version,
      // Service predicates still constrain each fixed operation, target and projection.
      permission_ids: elevated
        ? [
            ...customRoleCatalogueV1.fixed.filter(
              (id) => row.fixedRole === 'owner' || !ownerOnlyOperations.has(id),
            ),
            ...customRoleCatalogueV1.phaseOne,
            ...customRoleCatalogueV1.phaseTwoPersonalData,
          ]
        : permissionIds,
    },
  }
}

type TeamAuthorizationFacts = NonNullable<Awaited<ReturnType<typeof teamAuthorizationFacts>>>

export async function currentSessionTeamCeiling(
  db: Db,
  facts: TeamAuthorizationFacts,
  sessionId: string,
  reviewedId?: string,
) {
  if (!isUuid(sessionId) || (reviewedId !== undefined && !isUuid(reviewedId))) return undefined
  const ceiling = await db
    .selectFrom('team_credential_authorizations as credential')
    .innerJoin('auth.session as session', 'session.id', 'credential.session_id')
    .select(['credential.id', 'credential.credential_generation', 'credential.permission_ids'])
    .where('credential.session_id', '=', sessionId)
    .where('credential.organization_id', '=', facts.ceiling.organization_id)
    .where('credential.user_id', '=', facts.ceiling.user_id)
    .where('credential.member_id', '=', facts.memberId)
    .where('credential.member_generation', '=', facts.generation)
    .where('credential.catalogue_version', '=', customRoleCatalogueV1.version)
    .whereRef('session.userId', '=', 'credential.user_id')
    .where('session.activeOrganizationId', '=', facts.ceiling.organization_id)
    .where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)
    .$if(!facts.elevated, (query) =>
      query
        .where('credential.master_epoch', '=', facts.masterEpoch)
        .where('credential.policy_epoch', '=', facts.teamEpoch),
    )
    .$if(reviewedId !== undefined, (query) =>
      query.where('credential.id', '=', reviewedId as string),
    )
    .$if(db.isTransaction, (query) => query.forShare('session'))
    .executeTakeFirst()
  if (!ceiling || !facts.ceiling.permission_ids.every((id) => ceiling.permission_ids.includes(id)))
    return undefined
  return ceiling
}

export async function lockCustomRoleMaster(db: Db) {
  return db
    .selectFrom('custom_role_master_policy')
    .select(['enabled', 'policy_epoch'])
    .where('singleton', '=', true)
    .forShare()
    .executeTakeFirst()
}

const readKeyCustomOperations = new Set([
  'analytics.read',
  'branding.read',
  'event_types.list_host_candidates',
  'routing_forms.read',
  'workflows.read',
  'workflows.read_runs',
])
const mcpCustomOperations = new Set([
  'analytics.read',
  'branding.read',
  'branding.update',
  'event_notifications.update',
  'event_types.assign_hosts',
  'event_types.create',
  'event_types.duplicate',
  'event_types.update',
  'routing_forms.preview',
  'routing_forms.read',
  'workflows.preview',
  'workflows.read',
  'workflows.read_runs',
])

export function customOperationTransportAllows(
  operation: string,
  transport: ApiKeyScope | 'oauth' | 'session',
) {
  if (transport === 'session') return true
  if (transport === 'oauth') return mcpCustomOperations.has(operation)
  if (transport === 'full') return operation !== 'readiness.read_team'
  return transport === 'read' && readKeyCustomOperations.has(operation)
}

export function customCredentialPermissions(
  facts: TeamAuthorizationFacts,
  transport: ApiKeyScope | 'oauth',
) {
  if (facts.elevated) return facts.ceiling.permission_ids
  return facts.permissionIds.filter((id) => customOperationTransportAllows(id, transport))
}
