import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { getActiveOrganizationMember } from './api/auth.ts'
import { errorMessage, RequestError } from './api/errors.ts'
import type { Loaded } from './hooks.ts'
import { useMe } from './session.tsx'

type ManagementRole = 'owner' | 'admin'
type Access = (
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; role: ManagementRole | null; roles: string[] | null }
) & {
  revoke: () => void
  reload: () => void
  recheck: (signal: AbortSignal) => Promise<boolean>
  contextError: unknown
  reportContextChanged: (error: unknown) => void
}

const TeamManagementContext = createContext<Access | null>(null)
const canManage = (roles: string[] | null) =>
  !!roles?.some((role) => role === 'owner' || role === 'admin')

/** Shares the current team's checked membership between navigation and its pages. */
export function TeamManagementProvider({ children }: { children: ReactNode }) {
  const me = useMe()
  const [revoked, setRevoked] = useState(false)
  const [contextError, reportContextChanged] = useState<unknown>(null)
  const [membership, setMembership] = useState<Loaded<string[] | null>>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const userId = me.user.id
  const organizationId = me.organization.id
  const personal = me.organization.personal
  const principalKind = me.principal.kind
  // Session refreshes replace `me` even when its context is unchanged. Cache only within
  // this identity so a failed background check cannot discard confirmed access or drafts.
  const load = useMemo(() => {
    let confirmedRoles: string[] | null = null
    let latestCheck = 0
    return async (signal: AbortSignal): Promise<string[] | null> => {
      const check = ++latestCheck
      const current = () => !signal.aborted && check === latestCheck
      try {
        let checkedRoles: string[] | null = null
        if (principalKind === 'session') {
          if (personal) checkedRoles = ['owner']
          else {
            const member = await getActiveOrganizationMember(signal)
            const roles = member.role.split(',').map((role) => role.trim())
            checkedRoles =
              member.userId !== userId ||
              member.organizationId !== organizationId ||
              roles.some((role) => !['owner', 'admin', 'member'].includes(role))
                ? null
                : [...new Set(roles)]
          }
        }
        signal.throwIfAborted()
        if (current()) {
          confirmedRoles = checkedRoles
          setMembership({ status: 'ready', data: checkedRoles })
        }
        return confirmedRoles
      } catch (error) {
        signal.throwIfAborted()
        if (!current()) return confirmedRoles
        if (
          error instanceof RequestError &&
          error.status >= 400 &&
          error.status < 500 &&
          (error.status === 404 ||
            error.code === 'MEMBER_NOT_FOUND' ||
            error.code === 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' ||
            error.code === 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION')
        ) {
          confirmedRoles = null
          setMembership({ status: 'ready', data: null })
          return null
        }
        if (canManage(confirmedRoles)) return confirmedRoles
        setMembership({ status: 'error', message: errorMessage(error) })
        throw error
      }
    }
  }, [userId, organizationId, personal, principalKind])
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  const recheck = useCallback(
    async (signal: AbortSignal) => !personal && canManage(await load(signal)),
    [load, personal],
  )
  // `version` requests a fresh role read without clearing confirmed membership.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [load, version])
  const revoke = useCallback(() => setRevoked(true), [])
  const recovery = { revoke, reload, recheck, contextError, reportContextChanged }
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
