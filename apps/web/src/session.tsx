import {
  createContext,
  Fragment,
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
import { admin } from './i18n/admin.ts'
import { AccountLanguage, useI18n } from './i18n/runtime.tsx'
import type { UiText } from './i18n/translate.ts'
import { registerCatalog } from './i18n/translate.ts'
import { signInPath } from './next-path.ts'

registerCatalog(admin)

export type Me = Schemas['Me']

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; me: Me }
  | { status: 'signed-out'; reason: SignedOutReason }
  | { status: 'error'; message: UiText }

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
  /**
   * A message for a signed-in page that must outlive it: pages start over when the account
   * or organization changes (see RequireSession), and this says why.
   */
  notice: Notice | null
  setNotice: (notice: Notice | null) => void
}

export interface Notice {
  message: UiText
  /**
   * The page it is about (a pathname). It is shown only there and dropped once the person is
   * elsewhere, including when it arrives after they left (a slow request).
   */
  path: string
}

const SessionContext = createContext<Session | null>(null)

/** The state after the server said nobody is signed in (401). */
const lapsed = (s: SessionState): SessionState =>
  s.status === 'signed-out'
    ? s
    : { status: 'signed-out', reason: s.status === 'signed-in' ? 'expired' : 'visit' }

type MeResult = { ok: true; me: Me } | { ok: false; status: number; message: UiText }

async function fetchMe(signal: AbortSignal): Promise<MeResult> {
  const { data, error, response } = await api.GET('/api/v1/me', { signal })
  if (data) return { ok: true, me: data }
  return {
    ok: false,
    status: response.status,
    message: errorMessage(requestError(response.status, error)),
  }
}

/** Who is signed in, from GET /api/v1/me; the rest of the app reads it with useSession. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [accountLocale, setAccountLocale] = useState<{
    userId: string
    locale: string | undefined
  } | null>(null)
  const signedInUserId = state.status === 'signed-in' ? state.me.user.id : null
  useEffect(() => {
    if (!signedInUserId) {
      setAccountLocale(null)
      return
    }
    const controller = new AbortController()
    api.GET('/api/v1/profile', { signal: controller.signal }).then(
      ({ data }) => {
        if (!controller.signal.aborted)
          setAccountLocale({ userId: signedInUserId, locale: data?.locale ?? undefined })
      },
      () => {
        /* Account defaults are optional; UI remains usable offline. */
      },
    )
    return () => controller.abort()
  }, [signedInUserId])
  // Counts the moments the session ended (sign-out, or a 401). An answer to a request that
  // started before the latest one is stale: applying it would sign a signed-out person back
  // in, e.g. a background check that the server answered just before the sign-out.
  const epoch = useRef(0)
  const refreshing = useRef<{ promise: Promise<Me | null>; controller: AbortController } | null>(
    null,
  )

  /** Makes every request in flight stale and cancels the background check. */
  const invalidate = useCallback(() => {
    epoch.current += 1
    refreshing.current?.controller.abort()
    refreshing.current = null
    setNotice(null)
  }, [])

  const load = useCallback((signal: AbortSignal) => {
    const started = epoch.current
    fetchMe(signal).then(
      (result) => {
        if (signal.aborted || epoch.current !== started) return
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
  useEffect(
    () =>
      onUnauthorized(() => {
        invalidate()
        setState(lapsed)
      }),
    [invalidate],
  )

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    load(new AbortController().signal)
  }, [load])

  const refresh = useCallback(() => {
    if (refreshing.current) return refreshing.current.promise
    const started = epoch.current
    const controller = new AbortController()
    const promise: Promise<Me | null> = fetchMe(controller.signal)
      .then(
        (result) => {
          // The session ended after this check started (see epoch).
          if (epoch.current !== started) return null
          if (result.ok) {
            setState({ status: 'signed-in', me: result.me })
            return result.me
          }
          if (result.status === 401) setState(lapsed)
          return null
        },
        // Offline for a moment, or cancelled: what is on screen stays.
        () => null,
      )
      .finally(() => {
        if (refreshing.current?.promise === promise) refreshing.current = null
      })
    refreshing.current = { promise, controller }
    return promise
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
    // Before (a check answered while signing out is stale) and after (one started meanwhile).
    invalidate()
    await endSession()
    invalidate()
    setState({ status: 'signed-out', reason: 'signed-out' })
  }, [invalidate])

  const session = useMemo(
    () => ({ state, reload, refresh, signOut, notice, setNotice }),
    [state, reload, refresh, signOut, notice],
  )
  return (
    <SessionContext value={session}>
      <AccountLanguage
        locale={accountLocale?.userId === signedInUserId ? accountLocale?.locale : undefined}
      >
        {children}
      </AccountLanguage>
    </SessionContext>
  )
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
  const { t, ui } = useI18n()

  const { state, reload } = useSession()
  const location = useLocation()
  if (state.status === 'loading') return <PageStatus>{t('Loading…')}</PageStatus>
  if (state.status === 'error') {
    return (
      <div className="page-status">
        <p role="alert">{ui(state.message)}</p>
        <button type="button" className="button" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  }
  if (state.status === 'signed-out') {
    const to =
      state.reason === 'signed-out' ? '/sign-in' : signInPath(location.pathname + location.search)
    return <Navigate to={to} replace />
  }
  // Pages keep state for the account and organization they started with (a key list, a key
  // shown once). When either changes, e.g. after signing in as someone else in another tab,
  // everything below starts over rather than showing one account's data under another.
  const { user, organization } = state.me
  return (
    <Fragment key={`${user.id}:${organization.id}`}>
      <Outlet />
    </Fragment>
  )
}
