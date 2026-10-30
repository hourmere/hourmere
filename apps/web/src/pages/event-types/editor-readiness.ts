import { useEffect, useRef, useState } from 'react'
import type { EventType } from '../../api/resources.ts'
import type { Me } from '../../session.tsx'
import { type EventReadiness, loadEventReadiness } from './event-readiness.ts'

type EditorReadiness =
  | { status: 'unchecked' | 'loading' | 'error' | 'unavailable' }
  | { status: 'ready'; item: EventReadiness | undefined }

/** Observations belong to a saved version, independently of the editable form. */
export function useEditorReadiness(me: Me, saved: EventType | null, contextChanged: boolean) {
  const [observation, setObservation] = useState<{
    version: EventType | null
    state: EditorReadiness
  }>({ version: saved, state: { status: 'unchecked' } })
  const [attempt, setAttempt] = useState(0)
  const revision = useRef(0)
  const request = useRef<AbortController | null>(null)

  function invalidate() {
    revision.current += 1
    request.current?.abort()
    setObservation({ version: saved, state: { status: 'unchecked' } })
  }

  // A save replaces the observed version; a retry explicitly checks that version again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly requests another observation
  useEffect(() => {
    if (!saved || contextChanged) {
      setObservation({
        version: saved,
        state: { status: contextChanged ? 'unavailable' : 'unchecked' },
      })
      return
    }
    const controller = new AbortController()
    request.current = controller
    const observedRevision = ++revision.current
    setObservation({ version: saved, state: { status: 'loading' } })
    loadEventReadiness(me, controller.signal).then(
      (items) => {
        if (controller.signal.aborted || observedRevision !== revision.current) return
        setObservation({
          version: saved,
          state: items ? { status: 'ready', item: items.get(saved.id) } : { status: 'unavailable' },
        })
      },
      () => {
        if (controller.signal.aborted || observedRevision !== revision.current) return
        setObservation({ version: saved, state: { status: 'error' } })
      },
    )
    return () => controller.abort()
  }, [me, saved, contextChanged, attempt])

  function retry() {
    invalidate()
    setAttempt((value) => value + 1)
  }

  // Hide the previous saved version immediately, before the next effect starts its read.
  const state: EditorReadiness =
    observation.version === saved ? observation.state : { status: 'loading' }
  return [state, retry, invalidate] as const
}
