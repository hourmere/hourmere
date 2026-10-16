import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './api/errors.ts'

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string }

/**
 * Loads data for a page: `load` runs on mount and again on `reload()`, and is aborted when
 * the page goes away. `load` must be stable (a module-level function or a useCallback).
 * A reload keeps showing the previous data until the new data arrives.
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  // `version` is a dependency only to run the effect again on reload().
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: errorMessage(err) })
      },
    )
    return () => controller.abort()
  }, [load, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  return [state, reload] as const
}

/** Sets the browser tab's title for the current page. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Hourmere`
  }, [title])
}

/**
 * True while the calling component is mounted. Async work (a save, a delete) checks it
 * before acting on its result: once the person has left the page, a late answer must not
 * navigate away from where they are now, or touch what they are editing there.
 */
export function useMounted() {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
