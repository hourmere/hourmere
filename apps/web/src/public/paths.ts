// The shapes of handles and event type slugs (packages/scheduling: profile.ts, event-types.ts),
// so an address that cannot be a booking page shows "not found" without asking the server.
// Both are lowercase; the server also finds them case-insensitively.
import { useCallback, useEffect, useState } from 'react'

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** The handle in lowercase, or undefined when no booking page can have it. */
export function normalizedHandle(value: string): string | undefined {
  const lower = value.toLowerCase()
  return HANDLE.test(lower) ? lower : undefined
}

export function normalizedSlug(value: string): string | undefined {
  const lower = value.toLowerCase()
  return SLUG.test(lower) ? lower : undefined
}

export type RequestState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

/**
 * Loads data for a public page, like useLoad, but keeps the error itself so a page can tell
 * "not found" from "offline". `load` must be stable.
 */
export function useRequest<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<RequestState<T>>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: version only triggers a reload
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error })
      },
    )
    return () => controller.abort()
  }, [load, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  return [state, reload] as const
}
