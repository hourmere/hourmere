import {
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  createBrowserRouter,
  createRoutesFromElements,
  type Location,
  matchRoutes,
  Navigate,
  Route,
  useLocation,
  useMatch,
  useNavigate,
  useOutletContext,
  useRoutes,
} from 'react-router'
import { api } from './api/client.ts'
import { AdminLoading } from './components/AdminLoading.tsx'
import type { AppShellContext } from './components/AppShell.tsx'
import { PageSkeleton } from './components/PageSkeleton.tsx'
import { RouteErrorBoundary } from './components/RouteErrorBoundary.tsx'
import { embedQueryLanguage } from './embed/language.ts'
import { InterfaceScope, MemoryLanguage, useI18n } from './i18n/runtime.tsx'
import { translate } from './i18n/translate.ts'
import {
  AcceptInvitationPage,
  AnalyticsPage,
  ApiKeysPage,
  AppShell,
  AuditLogPage,
  AvailabilityPage,
  BookingDetailPage,
  BookingPage,
  BookingsPage,
  CalendarsPage,
  ConferencesPage,
  ConnectedAppsPage,
  CreateTeamPage,
  EmbeddedBookingPage,
  EmbeddedTeamBookingPage,
  EventTypeEditorPage,
  EventTypesPage,
  HostMeetingPollRoute,
  HostPage,
  ManageBookingPage,
  McpAuthorizePage,
  MeetingPollCreatePage,
  MeetingPollPage,
  MeetingPollsPage,
  OneTimeBookingPage,
  RequireSession,
  RoutingContinuationPage,
  RoutingFormPage,
  ScheduleEditorPage,
  SessionLayout,
  SettingsPage,
  SignInPage,
  SsoSetupPage,
  TeamBookingPage,
  TeamBookingsPage,
  TroubleshootPage,
  WorkflowEditorPage,
  WorkflowRunHistoryPage,
  WorkflowsPage,
} from './lazy-pages.tsx'
import { BookingPanelContext } from './pages/bookings/BookingPanel.tsx'
import { AppNotFoundPage, NotFoundPage } from './pages/NotFound.tsx'
import { bookingPath, PATHS } from './paths.ts'
import { useAdminPwa } from './pwa.ts'

export const appRoutes = createRoutesFromElements(
  <>
    <Route
      path="/"
      handle={{ surface: 'admin' }}
      element={
        <>
          <Navigate to={PATHS.home} replace />
          <AdminLoading />
        </>
      }
    />
    <Route element={<SessionLayout />} handle={{ surface: 'admin' }}>
      <Route path="/oauth/authorize" element={<McpAuthorizePage />} />
      <Route path="/oauth/consent" element={<McpAuthorizePage />} />
      <Route path="/sign-in" element={<SignInPage />} />
      {/* Keep the protected invitation entry ahead of the app shell and public booking routes. */}
      <Route path={PATHS.join} element={<AcceptInvitationPage />} />
      <Route path="/app" element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to={PATHS.eventTypes} replace />} />
          <Route path="event-types" element={<EventTypesPage />} />
          <Route path="event-types/new" element={<EventTypeEditorPage />} />
          <Route path="event-types/:id" element={<EventTypeEditorPage />} />
          <Route path="availability" element={<AvailabilityPage />} />
          <Route path="availability/new" element={<ScheduleEditorPage />} />
          <Route path="availability/troubleshoot" element={<TroubleshootPage />} />
          <Route path="availability/:id" element={<ScheduleEditorPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="meeting-polls" element={<MeetingPollsPage />} />
          <Route path="meeting-polls/new" element={<MeetingPollCreatePage />} />
          <Route path="meeting-polls/:id" element={<HostMeetingPollRoute />} />
          <Route path={PATHS.workflows} element={<WorkflowRoute />} />
          <Route path={PATHS.newWorkflow} element={<WorkflowRoute view="editor" />} />
          <Route path={`${PATHS.workflows}/:id/edit`} element={<WorkflowRoute view="editor" />} />
          <Route path={`${PATHS.workflows}/:id/runs`} element={<WorkflowRoute view="history" />} />
          <Route path="team/bookings" element={<TeamBookingsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="bookings/:id" element={<BookingDetailPage />} />
          <Route path="conferences" element={<ConferencesPage />} />
          <Route path="calendars" element={<CalendarsPage />} />
          <Route path="connected-apps" element={<ConnectedAppsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path={PATHS.sso} element={<SsoSetupRoute />}>
            {/* The shared setup page selects the pane and keeps the team inventory across routes. */}
            <Route path={PATHS.ssoDomainSettings} element={null} />
          </Route>
          <Route path="teams/new" element={<CreateTeamPage />} />
          <Route path="*" element={<AppNotFoundPage />} />
        </Route>
      </Route>
    </Route>
    {/* Public pages, outside the session: they never ask who is signed in. */}
    <Route path="/book/:token?" element={<OneTimeBookingPage />} />
    <Route path="/embed/book/:token" element={<OneTimeBookingPage />} />
    <Route path="/embed/team/:teamSlug/:slug" element={<EmbeddedTeamBookingPage />} />
    <Route path="/embed/:handle/:slug" element={<EmbeddedBookingPage />} />
    <Route path="/poll" element={<MeetingPollPage entry="public" />} />
    <Route path="/poll/voter" element={<MeetingPollPage entry="voter" />} />
    <Route path="/poll/recover" element={<MeetingPollPage entry="recover" />} />
    <Route path="/poll/reminder-opt-out" element={<MeetingPollPage entry="optOut" />} />
    <Route path="/booking" element={<ManageBookingPage />} />
    <Route
      path="/team/:teamSlug/:slug/waitlist/:waitlistToken/:suggestedStart/:previewExpiresAt"
      element={<TeamBookingPage />}
    />
    <Route
      path="/:handle/:slug/waitlist/:waitlistToken/:suggestedStart/:previewExpiresAt"
      element={<BookingPage />}
    />
    <Route path="/team/:teamSlug/:slug" element={<TeamBookingPage />} />
    <Route path="/:handle" element={<HostPage />} />
    <Route path="/:handle/:slug" element={<BookingPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </>,
)

function SsoSetupRoute() {
  const { ssoOidcEnabled, ssoSamlEnabled } = useOutletContext<AppShellContext>()
  const isDomains = useMatch(PATHS.ssoDomainSettings) !== null
  if (ssoOidcEnabled === undefined || ssoSamlEnabled === undefined) return <PageSkeleton />
  if (!ssoOidcEnabled && !(isDomains && ssoSamlEnabled)) return <AppNotFoundPage />
  return <SsoSetupPage />
}

function WorkflowRoute({ view = 'list' }: { view?: 'list' | 'editor' | 'history' }) {
  const { workflowsEnabled, followUpHostNotesEnabled } = useOutletContext<{
    workflowsEnabled: boolean | undefined
    followUpHostNotesEnabled: boolean
  }>()
  if (workflowsEnabled === undefined) return <PageSkeleton />
  if (!workflowsEnabled) return <AppNotFoundPage />
  if (view === 'editor')
    return <WorkflowEditorPage followUpHostNotesEnabled={followUpHostNotesEnabled} />
  if (view === 'history') return <WorkflowRunHistoryPage />
  return <WorkflowsPage />
}

const routingFormRoutes = createRoutesFromElements(
  <>
    <Route path="/route/:handle/:slug" element={<RoutingFormPage />} />
    <Route path="/route/team/:teamSlug/:slug" element={<RoutingFormPage />} />
  </>,
)

type RoutingContinuation = { routeToken: string | null }

export function isRoutingContinuationPath(pathname: string): boolean {
  // Decode each segment without mistaking an encoded slash for a path separator.
  try {
    const segments = pathname.replace(/\/+$/, '').split('/').map(decodeURIComponent)
    return (
      segments.length === 3 &&
      segments[1]?.toLowerCase() === 'route' &&
      segments[2]?.toLowerCase() === 'continue'
    )
  } catch {
    return false
  }
}

function continuationParams(pathname: string, hash: string): URLSearchParams | undefined {
  if (!hash || !isRoutingContinuationPath(pathname)) return
  const params = new URLSearchParams(hash.slice(1))
  return params.has('token') ? params : undefined
}

function takeRoutingContinuation(): RoutingContinuation | undefined {
  const { pathname, search, hash } = window.location
  const params = continuationParams(pathname, hash)
  if (!params) return
  window.history.replaceState(window.history.state, '', pathname + search)
  return { routeToken: params.get('token') || null }
}

export function createAppRouter() {
  // Clear the capability before the router snapshots the initial address or renders a page.
  const continuation = takeRoutingContinuation()
  return createBrowserRouter([{ path: '*', element: <App continuation={continuation} /> }])
}

function RoutingFormGate({
  fallback,
  continuation,
}: {
  fallback: ReactNode
  continuation?: RoutingContinuation | undefined
}) {
  const [enabled, setEnabled] = useState<boolean>()
  const form = useRoutes(routingFormRoutes)
  useEffect(() => {
    const controller = new AbortController()
    api.GET('/api/v1/instance', { signal: controller.signal, cache: 'no-store' }).then(
      ({ data }) => {
        if (!controller.signal.aborted) setEnabled(data?.routingFormsEnabled === true)
      },
      () => {
        if (!controller.signal.aborted) setEnabled(false)
      },
    )
    return () => controller.abort()
  }, [])
  if (enabled === undefined) return <RouteLoadingStatus memoryOnly={!!continuation} />
  if (!enabled) return fallback
  return continuation ? <RoutingContinuationPage routeToken={continuation.routeToken} /> : form
}

function RouteLoadingStatus({ memoryOnly = false }: { memoryOnly?: boolean }) {
  return memoryOnly ? (
    <MemoryLanguage>
      <LoadingStatus />
    </MemoryLanguage>
  ) : (
    <LoadingStatus />
  )
}

function LoadingStatus() {
  const { t } = useI18n()
  const { pathname, search } = useLocation()
  const language = pathname.startsWith('/embed/') ? embedQueryLanguage(search) : undefined
  return (
    <div className="page-status" role="status" lang={language}>
      {language ? translate(language, 'Loading…') : t('Loading…')}
    </div>
  )
}

function PageDescription() {
  const { t } = useI18n()
  useEffect(() => {
    const description = t('Scheduling page powered by Hourmere — pick a time that works.')
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]'])
      document.querySelector(selector)?.setAttribute('content', description)
  }, [t])
  return null
}

/**
 * The web app: one client of the public API (/api/v1 and Better Auth's /api/auth), with no
 * endpoints of its own. The router comes from the caller (a browser data router in
 * main.tsx, MemoryRouter in most component tests).
 *
 * Signed-in pages live under /app (paths.ts); the root is for public pages such as booking
 * pages (/{handle}/{slug}). The old top-level addresses (/api-keys, /settings, …) are not
 * kept: they are free for public pages.
 */
export function App({ continuation }: { continuation?: RoutingContinuation | undefined }) {
  const { pathname } = useLocation()
  useAdminPwa(pathname)
  const admin = matchRoutes(appRoutes, pathname)?.some(
    ({ route }) => route.handle?.surface === 'admin',
  )
  return (
    <InterfaceScope surface={admin ? 'admin' : 'public'}>
      <AppRoutes initialContinuation={continuation} />
    </InterfaceScope>
  )
}

function AppRoutes({
  initialContinuation,
}: {
  initialContinuation: RoutingContinuation | undefined
}) {
  const location = useLocation()
  const [visit, setVisit] = useState(
    () => initialContinuation && { location, continuation: initialContinuation },
  )
  const continuation = visit?.location === location ? visit.continuation : undefined
  const incomingContinuation =
    !continuation && !!continuationParams(location.pathname, location.hash)
  const privateVisit = !!continuation || incomingContinuation
  // Opening a fresh link while already on this address can be a fragment-only navigation.
  useLayoutEffect(() => {
    if (visit?.location === location) return
    const next = incomingContinuation ? takeRoutingContinuation() : undefined
    if (next || visit) setVisit(next && { location, continuation: next })
  }, [visit, location, incomingContinuation])
  const navigate = useNavigate()
  const currentLocation = useRef(location)
  currentLocation.current = location
  const token = useId()
  const [background, setBackground] = useState<Location | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const active =
    !!background &&
    location.state?.bookingPanel === token &&
    /^\/app\/bookings\/[^/]+$/.test(location.pathname)
  const wasActive = useRef(false)
  useEffect(() => {
    if (wasActive.current && !active) opener.current?.focus({ preventScroll: true })
    wasActive.current = active
  }, [active])
  const routes = useRoutes(appRoutes, active ? background : location)
  // Each opened or stepped detail gets its own id. The detail replaces its own entry to
  // remember its space (keeping this state), which changes the location key but must not
  // turn a step the user already asked for into a stale one.
  const entries = useRef(0)
  const panelState = () => ({ bookingPanel: token, bookingPanelEntry: ++entries.current })
  const panel = {
    location,
    active,
    open(id: string, trigger: HTMLElement) {
      opener.current = trigger
      if (!active) setBackground(location)
      navigate(bookingPath(id), { replace: active, state: panelState() })
    },
    step(id: string) {
      const current = currentLocation.current.state
      if (
        current?.bookingPanel !== token ||
        current?.bookingPanelEntry !== location.state?.bookingPanelEntry
      )
        return
      navigate(bookingPath(id), { replace: true, state: panelState() })
    },
    close() {
      navigate(-1)
    },
  }
  const { pathname } = location

  return (
    <>
      {privateVisit ? (
        <MemoryLanguage>
          <PageDescription />
        </MemoryLanguage>
      ) : (
        <PageDescription />
      )}
      <RouteErrorBoundary>
        <Suspense
          fallback={
            pathname === '/' || pathname === '/app' || pathname.startsWith('/app/') ? (
              <AdminLoading />
            ) : (
              <RouteLoadingStatus memoryOnly={privateVisit} />
            )
          }
        >
          <BookingPanelContext value={panel}>
            {incomingContinuation ? (
              <RouteLoadingStatus memoryOnly />
            ) : continuation ? (
              <RoutingFormGate key={location.key} fallback={routes} continuation={continuation} />
            ) : matchRoutes(routingFormRoutes, pathname) ? (
              <RoutingFormGate key={pathname} fallback={routes} />
            ) : (
              routes
            )}
          </BookingPanelContext>
        </Suspense>
      </RouteErrorBoundary>
    </>
  )
}
