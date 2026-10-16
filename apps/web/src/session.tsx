import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { signOut as endSession } from './api/auth.ts'
import { api, onUnauthorized, type Schemas } from './api/client.ts'
import { errorMessage, requestError } from './api/errors.ts'
import { signInPath } from './next-path.ts'

export type Me = Schemas['Me']

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; me: Me }
  | { status: 'signed-out'; reason: SignedOutReason }
  | { status: 'error'; message: string }

/**
 * Why nobody is signed in: `visit` when nobody was (the first page load), `signed-out` when
 * the person signed out here, `expired` when the session ended while the app was open.
 */
export type SignedOutReason = 'visit' | 'signed-out' | 'expired'

interface Session {
  state: SessionState
  /** Asks the server again who is signed in, showing the loading state meanwhile. */
  reload: () => void
  /**
   * Asks again in the background, e.g. when the window regains focus: the organization may
   * have changed in another tab. Keeps the current state if the server cannot be reached.
   * Resolves to the caller, or null when nobody is signed in (or it is not known).
   */
  refresh: () => Promise<Me | null>
  /** Ends the session on the server; throws if that fails. */
  signOut: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

/** The state after the server said nobody is signed in (401). */
const lapsed = (s: SessionState): SessionState =>
  s.status === 'signed-out'
    ? s
    : { status: 'signed-out', reason: s.status === 'signed-in' ? 'expired' : 'visit' }

type MeResult = { ok: true; me: Me } | { ok: false; status: number; message: string }

async function fetchMe(signal: AbortSignal): Promise<MeResult> {
  const { data, error, response } = await api.GET('/api/v1/me', { signal })
  if (data) return { ok: true, me: data }
  return {
    ok: false,
    status: response.status,
    message: requestError(response.status, error).message,
  }
}

/** Who is signed in, from GET /api/v1/me; the rest of the app reads it with useSession. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  const refreshing = useRef<Promise<Me | null> | null>(null)

  const load = useCallback((signal: AbortSignal) => {
    fetchMe(signal).then(
      (result) => {
        if (signal.aborted) return
        if (result.ok) setState({ status: 'signed-in', me: result.me })
        else if (result.status === 401) setState(lapsed)
        else setState({ status: 'error', message: result.message })
      },
      (err: unknown) => {
        if (!signal.aborted) setState({ status: 'error', message: errorMessage(err) })
      },
    )
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  // A request that finds the session gone (it expired, or was revoked elsewhere).
  useEffect(() => onUnauthorized(() => setState(lapsed)), [])

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    load(new AbortController().signal)
  }, [load])

  const refresh = useCallback(() => {
    refreshing.current ??= fetchMe(new AbortController().signal)
      .then(
        (result) => {
          if (result.ok) {
            setState({ status: 'signed-in', me: result.me })
            return result.me
          }
          if (result.status === 401) setState(lapsed)
          return null
        },
        // Offline for a moment: what is on screen stays.
        () => null,
      )
      .finally(() => {
        refreshing.current = null
      })
    return refreshing.current
  }, [])

  // Coming back to the app (another tab, another window): check who is signed in and in
  // which organization, so the app does not act on what it saw when it started.
  useEffect(() => {
    const onFocus = () => void refresh()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const signOut = useCallback(async () => {
    await endSession()
    setState({ status: 'signed-out', reason: 'signed-out' })
  }, [])

  const session = useMemo(
    () => ({ state, reload, refresh, signOut }),
    [state, reload, refresh, signOut],
  )
  return <SessionContext value={session}>{children}</SessionContext>
}

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used inside <SessionProvider>')
  return session
}

/** The signed-in caller; only for pages behind <RequireSession>. */
export function useMe(): Me {
  const { state } = useSession()
  if (state.status !== 'signed-in') throw new Error('useMe must be used behind <RequireSession>')
  return state.me
}

/** Shows a page-sized status (loading or a failure) while the session is not known. */
export function PageStatus({ children }: { children: ReactNode }) {
  return (
    <div className="page-status" role="status">
      {children}
    </div>
  )
}

/**
 * The gate for signed-in pages: renders them once GET /api/v1/me succeeds, and otherwise
 * sends the visitor to sign in, remembering where they were going.
 */
export function RequireSession() {
  const { state, reload } = useSession()
  const location = useLocation()
  if (state.status === 'loading') return <PageStatus>Loading…</PageStatus>
  if (state.status === 'error') {
    return (
      <div className="page-status">
        <p role="alert">{state.message}</p>
        <button type="button" className="button" onClick={reload}>
          Try again
        </button>
      </div>
    )
  }
  if (state.status === 'signed-out') {
    const to =
      state.reason === 'signed-out' ? '/sign-in' : signInPath(location.pathname + location.search)
    return <Navigate to={to} replace />
  }
  return <Outlet />
}
