import type { OrganizationMember } from './auth.ts'
import { notifyUnauthorized } from './client.ts'
import { errorFromResponse, RequestError } from './errors.ts'

export type ManageableTeamRole = 'admin' | 'member'

/** Bind the role write to the team where the confirmation opened. */
export async function changeTeamMemberRole(
  organizationId: string,
  memberId: string,
  role: ManageableTeamRole,
  signal?: AbortSignal,
): Promise<OrganizationMember> {
  const response = await fetch('/api/auth/organization/update-member-role', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Expected-Organization-Id': organizationId,
    },
    body: JSON.stringify({ organizationId, memberId, role }),
    ...(signal && { signal }),
  })
  if (response.status === 401) notifyUnauthorized()
  if (!response.ok) throw await errorFromResponse(response)
  const member: unknown = await response.json().catch(() => undefined)
  // A successful status alone does not confirm which membership was changed.
  if (
    !member ||
    typeof member !== 'object' ||
    !('id' in member) ||
    typeof member.id !== 'string' ||
    member.id.toLowerCase() !== memberId.toLowerCase() ||
    !('organizationId' in member) ||
    typeof member.organizationId !== 'string' ||
    member.organizationId.toLowerCase() !== organizationId.toLowerCase() ||
    !('role' in member) ||
    member.role !== role ||
    !('userId' in member) ||
    typeof member.userId !== 'string' ||
    !('createdAt' in member) ||
    typeof member.createdAt !== 'string'
  )
    throw new RequestError(502, 'ROLE_CHANGE_UNCONFIRMED', 'The role change was not confirmed.')
  return member as OrganizationMember
}
