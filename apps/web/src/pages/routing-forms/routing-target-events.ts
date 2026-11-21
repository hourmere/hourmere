import { routingTargetProblem } from '@hourmere/scheduling/routing-form-targets'
import { useEffect, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'

type EventType = Schemas['EventType']
type Target = Schemas['RoutingForm']['fallback']

export type EventRead<T> =
  | { status: 'loading' | 'denied' | 'error' | 'context' | 'unavailable' }
  | { status: 'ready'; data: T }

export interface RoutingTargetEvents {
  list: EventRead<EventType[]>
  bookingFields(id: string): EventRead<EventType>
  eventTitle(id: string): string | undefined
  retry(): void
}

const loading = { status: 'loading' } as const
const unavailable = { status: 'unavailable' } as const

function failure(error: unknown, detail = false): EventRead<never> {
  if (error instanceof RequestError) {
    if (error.status === 401 || error.status === 403) return { status: 'denied' }
    if (detail && error.status === 404) return unavailable
  }
  return { status: 'error' }
}

function eligible(organizationId: string, personalOwnerId: string | null, event: EventType) {
  return (
    routingTargetProblem(organizationId, {
      id: event.id,
      organizationId: event.organizationId,
      ownerUserId: event.ownerUserId,
      personalUserId: personalOwnerId,
      active: event.isActive,
      // The authenticated reads omit deleted events. No event price setting exists yet.
      deleted: false,
      payment: 'none',
      bookingMode: event.bookingMode,
      schedulingType: event.schedulingType,
      questions: event.questions,
    }) === undefined
  )
}

/** Existing event reads act in the session's current organization. Verify the scope of
 * their responses before showing choices or booking fields in the bound routing draft. */
export function useRoutingTargetEvents(
  organizationId: string,
  personalOwnerId: string | null,
  targets: Target[],
): RoutingTargetEvents {
  const [attempt, setAttempt] = useState(0)
  const [catalog, setCatalog] = useState<{ key: string; result: EventRead<EventType[]> }>()
  const details = useRef(new Map<string, EventRead<EventType>>())
  const [bookingReads, setBookingReads] = useState(() => new Map<string, EventRead<EventType>>())
  const key = `${organizationId}:${personalOwnerId ?? ''}:${attempt}`
  const showEvents = targets.some((target) => target.kind === 'event')

  useEffect(() => {
    if (!showEvents) return
    const controller = new AbortController()
    const { signal } = controller
    void unwrap(api.GET('/api/v1/event-types', { cache: 'no-store', signal })).then(
      ({ data }) => {
        if (signal.aborted) return
        const result: EventRead<EventType[]> = data.some(
          (event) => event.organizationId !== organizationId,
        )
          ? { status: 'context' }
          : {
              status: 'ready',
              data: data.filter((event) => eligible(organizationId, personalOwnerId, event)),
            }
        setCatalog({ key, result })
      },
      (error: unknown) => {
        if (!signal.aborted) setCatalog({ key, result: failure(error) })
      },
    )
    return () => controller.abort()
  }, [showEvents, key, organizationId, personalOwnerId])

  const list = showEvents && catalog?.key === key ? catalog.result : loading
  const eligibleIds = new Set(list.status === 'ready' ? list.data.map((event) => event.id) : [])
  const selected = new Set<string>()
  for (const target of targets) {
    if (target.kind === 'event' && eligibleIds.has(target.eventTypeId))
      selected.add(target.eventTypeId)
  }
  // The UUID-only set is stable when rules move or unrelated form fields change.
  const selectedKey = [...selected].sort().join(',')

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const ids = selectedKey ? selectedKey.split(',') : []
    const retained = new Set(ids.map((id) => `${key}:${id}`))
    for (const cacheKey of details.current.keys()) {
      if (!retained.has(cacheKey)) details.current.delete(cacheKey)
    }
    setBookingReads(new Map(details.current))

    for (const id of ids) {
      const cacheKey = `${key}:${id}`
      if (details.current.has(cacheKey)) continue
      const record = (result: EventRead<EventType>) => {
        if (signal.aborted) return
        details.current.set(cacheKey, result)
        setBookingReads(new Map(details.current))
      }
      void unwrap(
        api.GET('/api/v1/event-types/{id}', {
          cache: 'no-store',
          params: { path: { id } },
          signal,
        }),
      ).then(
        (data) => {
          if (data.organizationId !== organizationId) return record({ status: 'context' })
          record(
            data.id === id && eligible(organizationId, personalOwnerId, data)
              ? { status: 'ready', data }
              : unavailable,
          )
        },
        (error: unknown) => record(failure(error, true)),
      )
    }
    return () => controller.abort()
  }, [key, selectedKey, organizationId, personalOwnerId])

  return {
    list,
    bookingFields: (id) =>
      list.status !== 'ready'
        ? list
        : selected.has(id)
          ? (bookingReads.get(`${key}:${id}`) ?? loading)
          : unavailable,
    eventTitle: (id) =>
      list.status === 'ready' ? list.data.find((event) => event.id === id)?.title : undefined,
    retry: () => setAttempt((value) => value + 1),
  }
}
