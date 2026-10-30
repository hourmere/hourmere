import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { getActiveOrganizationMember } from './api/auth.ts'
import { useLoad } from './hooks.ts'
import { useMe } from './session.tsx'

type ManagementRole = 'owner' | 'admin'
type Access = (
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; role: ManagementRole | null; roles: string[] | null }
) & {
  revoke: () => void
  reload: () => void
  contextError: unknown
  reportContextChanged: (error: unknown) => void
}

const TeamManagementContext = createContext<Access | null>(null)

/** Shares the current team's checked membership between navigation and its pages. */
export function TeamManagementProvider({ children }: { children: ReactNode }) {
  const me = useMe()
  const [revoked, setRevoked] = useState(false)
  const [contextError, reportContextChanged] = useState<unknown>(null)
  const load = useCallback(
    async (signal: AbortSignal): Promise<string[] | null> => {
      if (me.principal.kind !== 'session') return null
      if (me.organization.personal) return ['owner']
      const member = await getActiveOrganizationMember(signal)
      const roles = member.role.split(',').map((role) => role.trim())
      if (
        member.userId !== me.user.id ||
        member.organizationId !== me.organization.id ||
        roles.some((role) => !['owner', 'admin', 'member'].includes(role))
      )
        return null
      return [...new Set(roles)]
    },
    [me],
  )
  const [membership, reload] = useLoad(load)
  const revoke = useCallback(() => setRevoked(true), [])
  const recovery = { revoke, reload, contextError, reportContextChanged }
  const roles = membership.status === 'ready' ? membership.data : null
  const role = me.organization.personal
    ? null
    : roles?.includes('owner')
      ? 'owner'
      : roles?.includes('admin')
        ? 'admin'
        : null
  const access: Access = revoked
    ? { status: 'ready', role: null, roles: null, ...recovery }
    : membership.status === 'ready'
      ? { status: 'ready', role, roles, ...recovery }
      : membership.status === 'error'
        ? { status: 'error', ...recovery }
        : { status: 'loading', ...recovery }
  return <TeamManagementContext value={access}>{children}</TeamManagementContext>
}

export function useTeamManagementAccess(): Access {
  const access = useContext(TeamManagementContext)
  if (!access) throw new Error('Team management must be inside the admin frame')
  return access
}
