import { useEffect, useState } from 'react'
import { getActiveOrganizationMember } from '../../api/auth.ts'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { Me } from '../../session.tsx'

export type SelfEventReadiness = Schemas['SelfReadinessPage']['eventTypes']['data'][number]
export type TeamEventReadiness = Schemas['TeamReadinessPage']['eventTypes']['data'][number]
export type EventReadiness = SelfEventReadiness | TeamEventReadiness

/** Preserve existing links unless the service reports a configuration problem. */
export function teamReadinessBlocksSharing(item: EventReadiness | undefined) {
  if (!item || !('reasonCodes' in item) || item.summary === 'partial_pool') return false
  return (
    item.summary === 'configuration_blocked' ||
    item.summary === 'dependency_unavailable' ||
    item.reasonCodes.some((reason) =>
      [
        'default_schedule_required',
        'host_configuration_required',
        'calendar_attention_required',
        'optional_feature_attention_required',
      ].includes(reason),
    )
  )
}

export function readinessErrorStatus(me: Me, err: unknown): 'unavailable' | 'error' {
  return !me.organization.personal &&
    err instanceof RequestError &&
    err.status === 403 &&
    err.code === 'team_management_access_denied'
    ? 'unavailable'
    : 'error'
}

export function useEventReadiness(me: Me, refreshVersion = 0) {
  const [state, setState] = useState<
    | { status: 'loading' | 'error' | 'unavailable' }
    | { status: 'ready'; data: Map<string, EventReadiness> }
  >({ status: 'loading' })
  const [version, setVersion] = useState(0)
  // A retry replaces previous observations, including a previous successful check.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly requests a new observation
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    loadEventReadiness(me, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setState(data ? { status: 'ready', data } : { status: 'unavailable' })
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setState({ status: readinessErrorStatus(me, err) })
      },
    )
    return () => controller.abort()
  }, [me, version, refreshVersion])
  const retry = () => {
    setState({ status: 'loading' })
    setVersion((value) => value + 1)
  }
  return [state, retry] as const
}

/** Read event pages only; each event summary already covers its required hosts. */
export async function loadEventReadiness(me: Me, signal: AbortSignal) {
  // Readiness and membership reads require a browser session, even when the list itself
  // is available to an API-key caller. A membership 401 would invalidate that valid caller.
  if (me.principal.kind !== 'session') return null
  if (!me.organization.personal) {
    const member = await getActiveOrganizationMember(signal)
    if (member.organizationId !== me.organization.id || member.userId !== me.user.id)
      throw new Error('Membership context changed')
    const roles = member.role.split(',').map((role) => role.trim())
    if (!roles.includes('owner') && !roles.includes('admin')) return null
  }
  const items = new Map<string, EventReadiness>()
  const cursors = new Set<string>()
  let eventTypeCursor: string | undefined
  do {
    const query = { limit: 100, ...(eventTypeCursor && { eventTypeCursor }) }
    let page:
      | Schemas['SelfReadinessPage']['eventTypes']
      | Schemas['TeamReadinessPage']['eventTypes']
    if (me.organization.personal) {
      const result = await unwrap(api.GET('/api/v1/readiness/self', { params: { query }, signal }))
      if (
        result.member.subject.kind !== 'member' ||
        result.member.subject.organizationId !== me.organization.id
      )
        throw new Error('Readiness context changed')
      page = result.eventTypes
      for (const item of result.eventTypes.data) {
        if (
          item.subject.kind !== 'event_type' ||
          item.subject.organizationId !== me.organization.id
        )
          throw new Error('Readiness context changed')
        items.set(item.subject.id, item)
      }
    } else {
      const result = await unwrap(
        api.GET('/api/v1/teams/{teamId}/readiness', {
          params: { path: { teamId: me.organization.id }, query },
          signal,
        }),
      )
      if (result.organizationId !== me.organization.id) throw new Error('Readiness context changed')
      page = result.eventTypes
      for (const item of result.eventTypes.data) {
        // Team hints use only the coarse projection, even if a response gains fields.
        items.set(item.eventTypeId, {
          eventTypeId: item.eventTypeId,
          enablement: item.enablement,
          activation: item.activation,
          summary: item.summary,
          completeness: item.completeness,
          evaluatedAt: item.evaluatedAt,
          reasonCodes: item.reasonCodes,
          fixKinds: item.fixKinds.filter((fix) =>
            ['edit_event', 'ask_member', 'retry_summary'].includes(fix),
          ),
        })
      }
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    eventTypeCursor = page.nextCursor ?? undefined
    if (eventTypeCursor) {
      if (cursors.has(eventTypeCursor)) throw new Error('Repeated readiness cursor')
      cursors.add(eventTypeCursor)
    }
  } while (eventTypeCursor)
  return items
}
