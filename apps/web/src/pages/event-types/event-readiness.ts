import { useEffect, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import type { Me } from '../../session.tsx'

export type SelfEventReadiness = Schemas['SelfReadinessPage']['eventTypes']['data'][number]
export type TeamEventReadiness = Schemas['TeamReadinessPage']['eventTypes']['data'][number]
export type EventReadiness = SelfEventReadiness | TeamEventReadiness

export function useEventReadiness(me: Me) {
  const [state, setState] = useState<
    { status: 'loading' | 'error' } | { status: 'ready'; data: Map<string, EventReadiness> }
  >({ status: 'loading' })
  const [version, setVersion] = useState(0)
  // A retry replaces previous observations, including a previous successful check.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly requests a new observation
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    loadEventReadiness(me, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      },
    )
    return () => controller.abort()
  }, [me, version])
  const retry = () => {
    setState({ status: 'loading' })
    setVersion((value) => value + 1)
  }
  return [state, retry] as const
}

/** Read event pages only; each event summary already covers its required hosts. */
export async function loadEventReadiness(me: Me, signal: AbortSignal) {
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
      for (const item of result.eventTypes.data) items.set(item.eventTypeId, item)
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
