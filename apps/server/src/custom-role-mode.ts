import {
  checkTeamManagementAccess,
  currentSessionTeamCeiling,
  lockCustomRoleMaster,
  type Principal,
  requireFixedRoleOwner,
  teamAuthorizationFacts,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { DomainError } from '@hourmere/scheduling'

type Session = Extract<Principal, { kind: 'session' }>

export const customRolesDisabled = () => new DomainError('not_found', 'custom_roles_disabled')
export const customRolesDenied = () => new DomainError('forbidden', 'team_management_access_denied')
export const roleRevisionConflict = () => new DomainError('conflict', 'role_revision_conflict')

export async function customRoleMode(
  db: Db,
  principal: Session,
  teamId: string,
  expectedOrganizationId: string,
) {
  await checkTeamManagementAccess(db, principal, teamId, 'share', {
    expectedOrganizationId,
    allowPersonal: false,
  })
  await requireFixedRoleOwner(db, principal, teamId)
  const master = await lockCustomRoleMaster(db)
  if (!master?.enabled) throw customRolesDisabled()
  const team = await db
    .selectFrom('team_custom_role_policies')
    .select(['enabled', 'policy_epoch'])
    .where('organization_id', '=', teamId)
    .executeTakeFirst()
  if (!team) throw customRolesDisabled()
  const renewals = await db
    .selectFrom('custom_role_assignments as assignment')
    .innerJoin('auth.member as member', 'member.id', 'assignment.member_id')
    .innerJoin(
      'team_member_authorizations as authorization',
      'authorization.member_id',
      'member.id',
    )
    .innerJoin('auth.user as user', 'user.id', 'member.userId')
    .select(['member.id as memberId', 'user.name'])
    .where('assignment.organization_id', '=', teamId)
    .where('authorization.fixed_role', '=', 'member')
    .where(({ not, ref }) =>
      not(scimSuspended(teamId, ref('member.userId'), principal.scimResourcesEnabled === true)),
    )
    .orderBy('member.id')
    .execute()
  return {
    enabled: team.enabled,
    policyVersion: { masterEpoch: master.policy_epoch, teamEpoch: team.policy_epoch },
    renewals,
  }
}

export async function setCustomRoleMode(
  db: Db,
  principal: Session,
  teamId: string,
  mode: Awaited<ReturnType<typeof customRoleMode>>,
  enabled: boolean,
) {
  if (mode.enabled === enabled) return mode
  if (enabled) {
    const ambiguous = await db
      .selectFrom('auth.member as member')
      .leftJoin(
        'team_member_authorizations as authorization',
        'authorization.member_id',
        'member.id',
      )
      .select('member.id')
      .where('member.organizationId', '=', teamId)
      .where('authorization.fixed_role', 'is', null)
      .limit(1)
      .executeTakeFirst()
    if (ambiguous) throw new DomainError('conflict', 'custom_role_ambiguous_memberships')
  }
  const { masterEpoch, teamEpoch } = mode.policyVersion
  const policyVersion = { masterEpoch, teamEpoch: teamEpoch + 1 }
  await db
    .updateTable('team_custom_role_policies')
    .set({ enabled, policy_epoch: policyVersion.teamEpoch })
    .where('organization_id', '=', teamId)
    .executeTakeFirstOrThrow()
  await writeAuditEvent(db, {
    organizationId: teamId,
    action: enabled ? 'team.custom_roles_enabled' : 'team.custom_roles_disabled',
    actor: { type: 'user', id: principal.user.id },
    credential: { type: 'session' },
    targetType: 'organization',
    targetId: teamId,
    details: {
      masterEpoch,
      oldPolicyEpoch: teamEpoch,
      newPolicyEpoch: policyVersion.teamEpoch,
      outcome: 'succeeded',
    },
  })
  return { ...mode, enabled, policyVersion }
}

export async function renewalFacts(db: Db, principal: Session, teamId: string, available: boolean) {
  const facts = await teamAuthorizationFacts(
    db,
    teamId,
    principal.user.id,
    available,
    principal.scimResourcesEnabled === true,
  )
  if (!facts || facts.generation <= 1) return undefined
  const current = await currentSessionTeamCeiling(db, facts, principal.sessionId)
  return { facts, current }
}

export async function renewTeamSession(
  db: Db,
  principal: Session,
  facts: NonNullable<Awaited<ReturnType<typeof renewalFacts>>>['facts'],
) {
  const replaced = await db
    .deleteFrom('team_credential_authorizations')
    .where('organization_id', '=', facts.ceiling.organization_id)
    .where('session_id', '=', principal.sessionId)
    .returning('credential_generation')
    .executeTakeFirst()
  await db
    .insertInto('team_credential_authorizations')
    .values({
      ...facts.ceiling,
      session_id: principal.sessionId,
      credential_generation: (replaced?.credential_generation ?? 0) + 1,
    })
    .execute()
  return { renewed: true as const }
}
