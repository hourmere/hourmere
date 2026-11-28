import { customRoleCatalogueV1 } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { type AuditAction, writeAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import type { Principal } from './caller.ts'
import { resolveTeamPermissions } from './custom-role-permissions.ts'
import { isUuid } from './organizations.ts'
import { ssoRecoveryOwner } from './sso-recovery-membership.ts'
import { checkTeamManagementAccess, teamManagementDenied, teamSession } from './team-management.ts'
import { lockTeamSsoProof, ssoHardOff, type TeamSsoCapabilities } from './team-sso.ts'

type CustomRoleWriteErrorCode =
  | 'custom_roles_disabled'
  | 'invalid_request'
  | 'role_in_use'
  | 'role_revision_conflict'

export class CustomRoleWriteError extends Error {
  readonly code: CustomRoleWriteErrorCode

  constructor(code: CustomRoleWriteErrorCode) {
    super(code)
    this.code = code
  }
}

export interface CustomRoleView {
  id: string
  revision: number
  catalogueVersion: number
  name: string
  permissionIds: string[]
  archived: boolean
}

interface RoleDefinition {
  name: string
  permissionIds: readonly string[]
}

export type CustomRoleCommand =
  | ({ kind: 'create' } & RoleDefinition)
  | ({ kind: 'publish'; roleId: string; expectedRevision: number } & RoleDefinition)
  | { kind: 'archive'; roleId: string; expectedRevision: number }
  | {
      kind: 'assign'
      memberId: string
      expectedGeneration: number
      roleId: string | null
      expectedRevision: number | null
    }

export type CustomRoleWriteResult =
  | { kind: 'role'; role: CustomRoleView }
  | {
      kind: 'assignment'
      memberId: string
      generation: number
      roleId: string | null
      revision: number | null
    }

interface RoleAccess {
  /** Rollout authority is supplied in-process and never comes from a request. */
  enabled: boolean
  principal: Principal
  teamId: string
  expectedOrganizationId: string
}

const phaseOne: ReadonlySet<string> = new Set(customRoleCatalogueV1.phaseOne)
const phaseTwo: ReadonlySet<string> = new Set(customRoleCatalogueV1.phaseTwoPersonalData)
const conflicts = () => new CustomRoleWriteError('role_revision_conflict')
const invalid = () => new CustomRoleWriteError('invalid_request')

function requireBrowserRoleAccess({ enabled, principal }: RoleAccess) {
  if (!enabled) throw new CustomRoleWriteError('custom_roles_disabled')
  if (principal.kind !== 'session') throw teamManagementDenied()
  return principal
}

async function lockRoleAccess(trx: Db, access: RoleAccess, lock: true | 'share') {
  const principal = requireBrowserRoleAccess(access)
  if (!trx.isTransaction) throw new Error('Custom role access requires a transaction')
  const { organizationId } = await checkTeamManagementAccess(trx, principal, access.teamId, lock, {
    expectedOrganizationId: access.expectedOrganizationId,
    allowPersonal: false,
  })
  const resolved = await resolveTeamPermissions(trx, principal, organizationId, [
    {
      operation: 'members.assign_role',
      fixed: ({ role }) => (role.trim() === 'owner' ? 'elevated' : 'denied'),
    },
  ])
  if (!resolved?.decisions[0]?.allowed) throw teamManagementDenied()
  const master = await trx
    .selectFrom('custom_role_master_policy')
    .select(['enabled', 'policy_epoch'])
    .where('singleton', '=', true)
    .forShare()
    .executeTakeFirst()
  const team = await trx
    .selectFrom('team_custom_role_policies')
    .select(['enabled', 'policy_epoch'])
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!master?.enabled || !team?.enabled) throw new CustomRoleWriteError('custom_roles_disabled')
  return {
    principal,
    organizationId,
    audit: {
      policyEpoch: team.policy_epoch,
      masterEpoch: master.policy_epoch,
      outcome: 'succeeded',
    },
  }
}

function roleQuery(db: Db, organizationId: string) {
  return db
    .selectFrom('custom_roles as role')
    .innerJoin('custom_role_revisions as revision', (join) =>
      join
        .onRef('revision.organization_id', '=', 'role.organization_id')
        .onRef('revision.role_id', '=', 'role.id')
        .onRef('revision.revision', '=', 'role.active_revision'),
    )
    .select([
      'role.id',
      'revision.revision',
      'revision.catalogue_version as catalogueVersion',
      'revision.name',
      'revision.permission_ids as permissionIds',
      sql<boolean>`role.archived_at IS NOT NULL`.as('archived'),
    ])
    .where('role.organization_id', '=', organizationId)
}

async function lockedRole(trx: Db, teamId: string, roleId: string) {
  if (!isUuid(roleId)) throw teamManagementDenied()
  const role = await roleQuery(trx, teamId)
    .where('role.id', '=', roleId)
    .forUpdate('role')
    .executeTakeFirst()
  if (!role) throw teamManagementDenied()
  return role
}

export async function readCustomRoles(
  db: Db,
  access: RoleAccess & {
    roleId?: string
    after?: string
    limit?: number
    ssoCapabilities?: TeamSsoCapabilities
  },
): Promise<CustomRoleView[]> {
  const principal = requireBrowserRoleAccess(access)
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      const { organizationId } = await lockRoleAccess(trx, access, 'share')
      await lockTeamSsoProof(
        { capabilities: access.ssoCapabilities ?? ssoHardOff },
        trx,
        { userId: principal.user.id, sessionId: principal.sessionId },
        organizationId,
        () => {
          throw teamManagementDenied()
        },
        { organizationLocked: true },
      )
      let query = roleQuery(trx, organizationId).where('role.archived_at', 'is', null)
      if (access.roleId !== undefined) {
        if (!isUuid(access.roleId)) throw teamManagementDenied()
        const role = await query.where('role.id', '=', access.roleId).executeTakeFirst()
        if (!role) throw teamManagementDenied()
        return [role]
      }
      if (access.after !== undefined) {
        if (!isUuid(access.after)) throw invalid()
        query = query.where('role.id', '>', access.after)
      }
      const limit = access.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid()
      return query.orderBy('role.id').limit(limit).execute()
    })
}

function roleDefinition({ name, permissionIds }: RoleDefinition) {
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    [...trimmed].length > 100 ||
    permissionIds.length > phaseOne.size ||
    new Set(permissionIds).size !== permissionIds.length ||
    !permissionIds.every((id) => phaseOne.has(id))
  )
    throw invalid()
  return { name: trimmed, permissionIds: [...permissionIds].sort() }
}

type LockedRoleAccess = Awaited<ReturnType<typeof lockRoleAccess>>

function journal(
  trx: Db,
  scope: LockedRoleAccess,
  action: AuditAction,
  targetType: 'custom_role' | 'membership',
  targetId: string,
  details: Record<string, unknown>,
) {
  return writeAuditEvent(trx, {
    organizationId: scope.organizationId,
    actor: { type: 'user', id: scope.principal.user.id },
    credential: { type: 'session' },
    action,
    targetType,
    targetId,
    details: { ...details, ...scope.audit },
  })
}

async function insertRevision(
  trx: Db,
  organizationId: string,
  roleId: string,
  revision: number,
  definition: ReturnType<typeof roleDefinition>,
): Promise<CustomRoleView> {
  const catalogueVersion = customRoleCatalogueV1.version
  await trx
    .insertInto('custom_role_revisions')
    .values({
      organization_id: organizationId,
      role_id: roleId,
      revision,
      catalogue_version: catalogueVersion,
      name: definition.name,
      permission_ids: definition.permissionIds,
    })
    .execute()
  return { id: roleId, revision, catalogueVersion, archived: false, ...definition }
}

type ApplyWrite = () => Promise<CustomRoleWriteResult>

async function prepareRoleEdit(
  trx: Db,
  scope: LockedRoleAccess,
  command: Exclude<CustomRoleCommand, { kind: 'assign' }>,
): Promise<ApplyWrite> {
  const { organizationId } = scope
  if (command.kind === 'create') {
    const definition = roleDefinition(command)
    return async () => {
      const { id } = await trx
        .insertInto('custom_roles')
        .values({ organization_id: organizationId, active_revision: 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      const role = await insertRevision(trx, organizationId, id, 1, definition)
      await journal(trx, scope, 'custom_role.created', 'custom_role', id, {
        roleId: id,
        newRevision: 1,
      })
      return { kind: 'role', role }
    }
  }

  const current = await lockedRole(trx, organizationId, command.roleId)
  const { id, revision } = current
  if (revision !== command.expectedRevision) throw conflicts()
  const updateRole = trx
    .updateTable('custom_roles')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
  if (command.kind === 'archive') {
    if (current.archived) return async () => ({ kind: 'role', role: current })
    const assignment = await trx
      .selectFrom('custom_role_assignments')
      .select('role_id')
      .where('organization_id', '=', organizationId)
      .where('role_id', '=', id)
      .limit(1)
      .executeTakeFirst()
    if (assignment) throw new CustomRoleWriteError('role_in_use')
    return async () => {
      await updateRole.set({ archived_at: sql<string>`clock_timestamp()` }).execute()
      await journal(trx, scope, 'custom_role.archived', 'custom_role', id, {
        roleId: id,
        oldRevision: revision,
      })
      return { kind: 'role', role: { ...current, archived: true } }
    }
  }

  if (current.archived) throw conflicts()
  const definition = roleDefinition(command)
  if (
    current.catalogueVersion === customRoleCatalogueV1.version &&
    definition.name === current.name &&
    definition.permissionIds.length === current.permissionIds.length &&
    definition.permissionIds.every((id) => current.permissionIds.includes(id))
  )
    return async () => ({ kind: 'role', role: current })
  return async () => {
    const role = await insertRevision(trx, organizationId, id, revision + 1, definition)
    await updateRole.set({ active_revision: role.revision }).execute()
    await journal(trx, scope, 'custom_role.revised', 'custom_role', id, {
      roleId: id,
      oldRevision: revision,
      newRevision: role.revision,
    })
    return { kind: 'role', role }
  }
}

function personalData(role: CustomRoleView) {
  const personalDataPermissionIds = role.permissionIds.filter((id) => phaseTwo.has(id))
  return personalDataPermissionIds.length ? { personalDataPermissionIds } : {}
}

async function prepareAssignment(
  trx: Db,
  scope: LockedRoleAccess,
  command: Extract<CustomRoleCommand, { kind: 'assign' }>,
): Promise<ApplyWrite> {
  const { organizationId, principal } = scope
  if (!isUuid(command.memberId)) throw teamManagementDenied()
  const member = await trx
    .selectFrom('auth.member')
    .select(['id', 'userId', 'role'])
    .select(ssoRecoveryOwner)
    .where('organizationId', '=', organizationId)
    .where('id', '=', command.memberId)
    .where(({ not, ref, exists, selectFrom }) =>
      not(
        scimSuspended(organizationId, ref('userId'), principal.scimResourcesEnabled === true),
      ).and(
        not(
          exists(
            selectFrom('scim_membership_blocks')
              .select('id')
              .where('organization_id', '=', organizationId)
              .where('cleared_at', 'is', null)
              .where(({ eb, or }) =>
                or([
                  eb('user_id', '=', ref('auth.member.userId')),
                  eb(
                    'identity_email',
                    '=',
                    sql<string>`(SELECT lower(btrim(email))
                    FROM auth."user" WHERE id = ${ref('auth.member.userId')}
                      AND "emailVerified" IS TRUE)`,
                  ),
                ]),
              ),
          ),
        ),
      ),
    )
    .forShare()
    .executeTakeFirst()
  if (
    !member ||
    member.userId === principal.user.id ||
    member.role.trim() !== 'member' ||
    member.recoveryOwner
  )
    throw teamManagementDenied()

  const authorization = trx
    .selectFrom('team_member_authorizations')
    .select(['generation', 'fixed_role'])
    .where('organization_id', '=', organizationId)
    .where('member_id', '=', member.id)
    .where('user_id', '=', member.userId)
  const grant = await authorization.forUpdate().executeTakeFirst()
  if (grant?.fixed_role !== 'member') throw teamManagementDenied()
  const assignments = trx
    .selectFrom('custom_role_assignments')
    .select('role_id')
    .where('organization_id', '=', organizationId)
    .where('member_id', '=', member.id)
    .where('user_id', '=', member.userId)
  const assignment = await assignments.forUpdate().executeTakeFirst()
  const current = assignment && (await lockedRole(trx, organizationId, assignment.role_id))
  const next =
    command.roleId === null
      ? null
      : current && command.roleId.toLowerCase() === current.id
        ? current
        : await lockedRole(trx, organizationId, command.roleId)
  if (
    next &&
    (next.archived ||
      next.catalogueVersion !== customRoleCatalogueV1.version ||
      !next.permissionIds.every((id) => phaseOne.has(id)))
  )
    throw teamManagementDenied()
  if (
    grant.generation !== command.expectedGeneration ||
    command.expectedRevision !== ((next ?? current)?.revision ?? null)
  )
    throw conflicts()
  const result = (generation: number): CustomRoleWriteResult => ({
    kind: 'assignment',
    memberId: member.id,
    generation,
    roleId: next?.id ?? null,
    revision: next?.revision ?? null,
  })
  if (next?.id === current?.id) return async () => result(grant.generation)
  return async () => {
    if (next) {
      await trx
        .insertInto('custom_role_assignments')
        .values({
          organization_id: organizationId,
          member_id: member.id,
          user_id: member.userId,
          role_id: next.id,
          assigned_by_user_id: principal.user.id,
        })
        .onConflict((conflict) =>
          conflict.columns(['organization_id', 'member_id']).doUpdateSet({
            role_id: next.id,
            assigned_by_user_id: principal.user.id,
          }),
        )
        .execute()
      await journal(trx, scope, 'membership.custom_role_assigned', 'membership', member.id, {
        roleId: next.id,
        newRevision: next.revision,
        ...(current && { oldRoleId: current.id, oldRevision: current.revision }),
        ...personalData(next),
      })
    } else if (current) {
      await trx
        .deleteFrom('custom_role_assignments')
        .where('organization_id', '=', organizationId)
        .where('member_id', '=', member.id)
        .where('user_id', '=', member.userId)
        .execute()
      await journal(trx, scope, 'membership.custom_role_cleared', 'membership', member.id, {
        roleId: current.id,
        oldRevision: current.revision,
        ...personalData(current),
      })
    }
    const { generation } = await authorization.executeTakeFirstOrThrow()
    return result(generation)
  }
}

/** Transaction callbacks for same-origin browser REST's fresh administration proof gate. */
export function customRoleWrite(access: RoleAccess & { command: CustomRoleCommand }) {
  const prepare = async (trx: Db) => {
    const scope = await lockRoleAccess(trx, access, true)
    const apply =
      access.command.kind === 'assign'
        ? await prepareAssignment(trx, scope, access.command)
        : await prepareRoleEdit(trx, scope, access.command)
    // Check the session at the end of preflight, after all potentially contended locks.
    await teamSession(trx, scope.principal, true)
    return apply
  }
  return {
    async authorize(trx: Db) {
      await prepare(trx)
    },
    async mutate(trx: Db) {
      const apply = await prepare(trx)
      return apply()
    },
  }
}
