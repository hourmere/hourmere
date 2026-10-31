import { useEffect, useRef, useState } from 'react'
import type { EventType } from '../../api/resources.ts'
import type { Me } from '../../session.tsx'
import { type EventReadiness, loadEventReadiness, readinessErrorStatus } from './event-readiness.ts'

export type EditorReadiness =
  | { status: 'unchecked' | 'loading' | 'error' | 'unavailable' }
  | { status: 'ready'; item: EventReadiness | undefined }

/** Observations belong to a saved version, independently of the editable form. */
export function useEditorReadiness(me: Me, saved: EventType | null, contextChanged: boolean) {
  const [observation, setObservation] = useState<{
    version: EventType | null
    state: EditorReadiness
  }>({ version: saved, state: { status: 'unchecked' } })
  // Draft edits invalidate the editor's checks, but cannot change the saved link's
  // eligibility. Keep that observation until a new saved version or explicit retry.
  const [shareObservation, setShareObservation] = useState(observation)
  const [attempt, setAttempt] = useState(0)
  const revision = useRef(0)
  const request = useRef<AbortController | null>(null)

  function invalidate() {
    revision.current += 1
    request.current?.abort()
    setObservation({ version: saved, state: { status: 'unchecked' } })
    setShareObservation((current) =>
      current.state.status === 'loading'
        ? { version: saved, state: { status: 'unchecked' } }
        : current,
    )
  }

  // A save replaces the observed version; a retry explicitly checks that version again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly requests another observation
  useEffect(() => {
    if (!saved || contextChanged) {
      const next: typeof observation = {
        version: saved,
        state: { status: contextChanged ? 'unavailable' : 'unchecked' },
      }
      setObservation(next)
      setShareObservation(next)
      return
    }
    const controller = new AbortController()
    request.current = controller
    const observedRevision = ++revision.current
    const loading: typeof observation = { version: saved, state: { status: 'loading' } }
    setObservation(loading)
    setShareObservation(loading)
    loadEventReadiness(me, controller.signal).then(
      (items) => {
        if (controller.signal.aborted || observedRevision !== revision.current) return
        const next: typeof observation = {
          version: saved,
          state: items ? { status: 'ready', item: items.get(saved.id) } : { status: 'unavailable' },
        }
        setObservation(next)
        setShareObservation(next)
      },
      (err: unknown) => {
        if (controller.signal.aborted || observedRevision !== revision.current) return
        const next = { version: saved, state: { status: readinessErrorStatus(me, err) } }
        setObservation(next)
        setShareObservation(next)
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
  const shareState: EditorReadiness =
    shareObservation.version === saved ? shareObservation.state : { status: 'loading' }
  return [state, retry, invalidate, shareState] as const
}
