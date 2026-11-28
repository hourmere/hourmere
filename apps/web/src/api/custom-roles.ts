import { unwrapSsoWrite } from '../pages/sso/setup.ts'
import { api, type Schemas, unwrap } from './client.ts'

export type CustomTeamRole = Schemas['CustomTeamRole']
export type CustomRoleAssignment = Schemas['CustomTeamRoleAssignment']

type RoleDefinition = Pick<CustomTeamRole, 'name' | 'permissionIds'>
type CustomRoleChange =
  | { kind: 'create'; definition: RoleDefinition }
  | { kind: 'publish'; roleId: string; expectedRevision: number; definition: RoleDefinition }
  | { kind: 'archive'; roleId: string; expectedRevision: number }

function teamRequest(teamId: string, signal: AbortSignal) {
  return {
    params: { path: { teamId } },
    headers: { 'X-Expected-Organization-Id': teamId },
    signal,
    cache: 'no-store' as const,
  }
}

export function loadPermissionsMode(teamId: string, signal: AbortSignal) {
  return unwrap(api.GET('/api/v1/teams/{teamId}/permissions-mode', teamRequest(teamId, signal)))
}

export function changePermissionsMode(
  teamId: string,
  enabled: boolean,
  { masterEpoch, teamEpoch }: NonNullable<Schemas['TeamPermissions']['policyVersion']>,
  signal: AbortSignal,
  proofAttemptId?: string,
) {
  return unwrapSsoWrite(
    api.PUT('/api/v1/teams/{teamId}/permissions-mode', {
      ...teamRequest(teamId, signal),
      body: {
        enabled,
        expectedMasterEpoch: masterEpoch,
        expectedTeamEpoch: teamEpoch,
        proofAttemptId,
      },
    }),
  )
}

export async function loadCustomRoles(teamId: string, signal: AbortSignal) {
  const request = teamRequest(teamId, signal)
  const roles: CustomTeamRole[] = []
  let after: string | undefined
  const limit = 100
  while (true) {
    const page = await unwrap(
      api.GET('/api/v1/teams/{teamId}/roles', {
        ...request,
        params: { ...request.params, query: { limit, after } },
      }),
    )
    roles.push(...page)
    if (page.length < limit) return roles
    const next = page.at(-1)?.id
    if (!next || next === after) throw new Error('Could not load custom roles.')
    after = next
  }
}

export function changeCustomRole(
  teamId: string,
  change: CustomRoleChange,
  signal: AbortSignal,
  proofAttemptId?: string,
) {
  const request = teamRequest(teamId, signal)
  if (change.kind === 'create')
    return unwrapSsoWrite(
      api.POST('/api/v1/teams/{teamId}/roles', {
        ...request,
        body: { ...change.definition, proofAttemptId },
      }),
    )
  const { roleId, expectedRevision } = change
  const params = { path: { teamId, roleId } }
  if (change.kind === 'publish')
    return unwrapSsoWrite(
      api.PATCH('/api/v1/teams/{teamId}/roles/{roleId}', {
        ...request,
        params,
        body: { ...change.definition, expectedRevision, proofAttemptId },
      }),
    )
  return unwrapSsoWrite(
    api.DELETE('/api/v1/teams/{teamId}/roles/{roleId}', {
      ...request,
      params,
      body: { expectedRevision, proofAttemptId },
    }),
  )
}

export function loadCustomRoleAssignment(teamId: string, memberId: string, signal: AbortSignal) {
  return unwrap(
    api.GET('/api/v1/teams/{teamId}/members/{memberId}/custom-role', {
      ...teamRequest(teamId, signal),
      params: { path: { teamId, memberId } },
    }),
  )
}

export function changeCustomRoleAssignment(
  teamId: string,
  assignment: CustomRoleAssignment,
  nextRole: CustomTeamRole | null,
  signal: AbortSignal,
  proofAttemptId?: string,
) {
  const { memberId, generation, revision } = assignment
  return unwrapSsoWrite(
    api.PUT('/api/v1/teams/{teamId}/members/{memberId}/custom-role', {
      ...teamRequest(teamId, signal),
      params: { path: { teamId, memberId } },
      body: {
        expectedGeneration: generation,
        expectedRevision: nextRole?.revision ?? revision,
        roleId: nextRole?.id ?? null,
        proofAttemptId,
      },
    }),
  )
}

export function loadTeamPermissions(teamId: string, signal: AbortSignal) {
  return unwrap(api.GET('/api/v1/teams/{teamId}/permissions', teamRequest(teamId, signal)))
}

export function renewTeamPermissions(
  teamId: string,
  version: NonNullable<Schemas['TeamPermissions']['policyVersion']>,
  generation: number,
  signal: AbortSignal,
  proofAttemptId?: string,
) {
  return unwrapSsoWrite(
    api.POST('/api/v1/teams/{teamId}/permissions/renew', {
      ...teamRequest(teamId, signal),
      body: {
        expectedGeneration: generation,
        expectedTeamEpoch: version.teamEpoch,
        expectedMasterEpoch: version.masterEpoch,
        proofAttemptId,
      },
    }),
  )
}
