import { type ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react'
import {
  createRoutesFromElements,
  type Location,
  matchRoutes,
  Navigate,
  Route,
  useLocation,
  useNavigate,
  useRoutes,
} from 'react-router'
import { api } from './api/client.ts'
import { AdminLoading } from './components/AdminLoading.tsx'
import { RouteErrorBoundary } from './components/RouteErrorBoundary.tsx'
import { embedQueryLanguage } from './embed/language.ts'
import { InterfaceScope, useI18n } from './i18n/runtime.tsx'
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
  MeetingPollPage,
  MeetingPollsPage,
  OneTimeBookingPage,
  RequireSession,
  RoutingFormPage,
  ScheduleEditorPage,
  SessionLayout,
  SettingsPage,
  SignInPage,
  TeamBookingPage,
  TeamBookingsPage,
  TroubleshootPage,
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
          <Route path="meeting-polls/:id" element={<HostMeetingPollRoute />} />
          <Route path="team/bookings" element={<TeamBookingsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="bookings/:id" element={<BookingDetailPage />} />
          <Route path="conferences" element={<ConferencesPage />} />
          <Route path="calendars" element={<CalendarsPage />} />
          <Route path="connected-apps" element={<ConnectedAppsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          <Route path="settings" element={<SettingsPage />} />
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

const routingFormRoutes = createRoutesFromElements(
  <>
    <Route path="/route/:handle/:slug" element={<RoutingFormPage />} />
    <Route path="/route/team/:teamSlug/:slug" element={<RoutingFormPage />} />
  </>,
)

function RoutingFormGate({ fallback }: { fallback: ReactNode }) {
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
  if (enabled === undefined) return <RouteLoadingStatus />
  return enabled ? form : fallback
}

function RouteLoadingStatus() {
  const { t } = useI18n()
  const { pathname, search } = useLocation()
  const language = pathname.startsWith('/embed/') ? embedQueryLanguage(search) : undefined
  return (
    <div className="page-status" role="status" lang={language}>
      {language ? translate(language, 'Loading…') : t('Loading…')}
    </div>
  )
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
export function App() {
  const { pathname } = useLocation()
  useAdminPwa(pathname)
  const admin = matchRoutes(appRoutes, pathname)?.some(
    ({ route }) => route.handle?.surface === 'admin',
  )
  return (
    <InterfaceScope surface={admin ? 'admin' : 'public'}>
      <AppRoutes />
    </InterfaceScope>
  )
}

function AppRoutes() {
  const location = useLocation()
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
  const { t } = useI18n()
  const { pathname } = useLocation()
  useEffect(() => {
    const description = t('Scheduling page powered by Hourmere — pick a time that works.')
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]'])
      document.querySelector(selector)?.setAttribute('content', description)
  }, [t])

  return (
    <RouteErrorBoundary>
      <Suspense
        fallback={
          pathname === '/' || pathname === '/app' || pathname.startsWith('/app/') ? (
            <AdminLoading />
          ) : (
            <RouteLoadingStatus />
          )
        }
      >
        <BookingPanelContext value={panel}>
          {matchRoutes(routingFormRoutes, pathname) ? (
            <RoutingFormGate key={pathname} fallback={routes} />
          ) : (
            routes
          )}
        </BookingPanelContext>
      </Suspense>
    </RouteErrorBoundary>
  )
}
