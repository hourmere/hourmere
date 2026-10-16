import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  /** `ended` when the person signed out here, rather than the session lapsing. */
  | { status: 'signed-out'; ended: boolean }
  | { status: 'error'; message: string }

interface Session {
  state: SessionState
  /** Asks the server again who is signed in. */
  reload: () => void
  /** Ends the session on the server; throws if that fails. */
  signOut: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

/** Who is signed in, from GET /api/v1/me; the rest of the app reads it with useSession. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  const load = useCallback((signal: AbortSignal) => {
    api.GET('/api/v1/me', { signal }).then(
      ({ data, error, response }) => {
        if (signal.aborted) return
        if (data) setState({ status: 'signed-in', me: data })
        else if (response.status === 401) setState({ status: 'signed-out', ended: false })
        else setState({ status: 'error', message: requestError(response.status, error).message })
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
  useEffect(
    () =>
      onUnauthorized(() =>
        setState((s) => (s.status === 'signed-out' ? s : { status: 'signed-out', ended: false })),
      ),
    [],
  )

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    load(new AbortController().signal)
  }, [load])
  const signOut = useCallback(async () => {
    await endSession()
    setState({ status: 'signed-out', ended: true })
  }, [])

  const session = useMemo(() => ({ state, reload, signOut }), [state, reload, signOut])
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
    const to = state.ended ? '/sign-in' : signInPath(location.pathname + location.search)
    return <Navigate to={to} replace />
  }
  return <Outlet />
}
