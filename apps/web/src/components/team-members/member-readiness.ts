import { useEffect, useState } from 'react'
import type { ListedOrganizationMember } from '../../api/auth.ts'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'

export type MemberHealth = Schemas['MemberReadinessPage']['members'][number]['health']
type State =
  | { status: 'loading' | 'error' | 'unavailable' }
  | { status: 'ready'; data: Map<string, MemberHealth> }

export function useMemberReadiness(
  organizationId: string,
  currentUserId: string | undefined,
  role: string | null,
  members: ListedOrganizationMember[],
) {
  const memberIds = members
    .map((member) => member.id)
    .sort()
    .join(',')
  const [version, setVersion] = useState(0)
  const context = `${organizationId}:${currentUserId}:${role}:${memberIds}:${version}`
  const [result, setResult] = useState<{ context: string; state: State }>()
  useEffect(() => {
    if (!currentUserId || !role || !memberIds) return
    let controller: AbortController | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      setResult({ context, state: { status: 'loading' } })
      unwrap(
        api.GET('/api/v1/teams/{teamId}/member-readiness', {
          params: {
            path: { teamId: organizationId },
            query: { memberIds },
            header: { 'x-expected-organization-id': organizationId },
          },
          signal,
        }),
      ).then(
        (page) => {
          if (signal.aborted) return
          if (page.organizationId !== organizationId) {
            setResult({ context, state: { status: 'unavailable' } })
            return
          }
          const requested = new Set(memberIds.split(','))
          const data = new Map<string, MemberHealth>()
          for (const member of page.members) {
            if (!requested.has(member.memberId)) continue
            // Keep only coarse health fields, even if the response gains private detail.
            data.set(member.memberId, {
              defaultSchedule: member.health.defaultSchedule,
              selectedCalendars: member.health.selectedCalendars,
              conferenceAccounts: member.health.conferenceAccounts,
            })
          }
          setResult({ context, state: { status: 'ready', data } })
        },
        (error: unknown) => {
          if (signal.aborted) return
          setResult({
            context,
            state: {
              status:
                (error instanceof RequestError && error.status === 403) ||
                isOrganizationContextChanged(error)
                  ? 'unavailable'
                  : 'error',
            },
          })
        },
      )
    }
    const refresh = () => {
      // Returning to a tab commonly fires both visibility and focus before the next paint.
      controller?.abort()
      setResult({ context, state: { status: 'loading' } })
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(load, 30)
    }
    const visible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    load()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller?.abort()
      clearTimeout(refreshTimer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [organizationId, currentUserId, role, memberIds, context])
  const state: State = result?.context === context ? result.state : { status: 'loading' }
  return [state, () => setVersion((value) => value + 1)] as const
}
