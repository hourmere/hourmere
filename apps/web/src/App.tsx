import { Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { RouteErrorBoundary } from './components/RouteErrorBoundary.tsx'
import { useI18n } from './i18n/runtime.tsx'
import {
  AnalyticsPage,
  ApiKeysPage,
  AppShell,
  AvailabilityPage,
  BookingDetailPage,
  BookingPage,
  BookingsPage,
  CalendarsPage,
  ConferencesPage,
  ConnectedAppsPage,
  EmbeddedBookingPage,
  EmbeddedTeamBookingPage,
  EventTypeEditorPage,
  EventTypesPage,
  HostPage,
  ManageBookingPage,
  McpAuthorizePage,
  RequireSession,
  ScheduleEditorPage,
  SessionLayout,
  SettingsPage,
  SignInPage,
  TeamBookingPage,
} from './lazy-pages.tsx'
import { AppNotFoundPage, NotFoundPage } from './pages/NotFound.tsx'
import { PATHS } from './paths.ts'

/**
 * The web app: one client of the public API (/api/v1 and Better Auth's /api/auth), with no
 * endpoints of its own. The router comes from the caller (BrowserRouter in main.tsx,
 * MemoryRouter in tests).
 *
 * Signed-in pages live under /app (paths.ts); the root is for public pages such as booking
 * pages (/{handle}/{slug}). The old top-level addresses (/api-keys, /settings, …) are not
 * kept: they are free for public pages.
 */
export function App() {
  const { t } = useI18n()
  useEffect(() => {
    const description = t('Book a time to meet with Hourmere, the open-source scheduling app.')
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]'])
      document.querySelector(selector)?.setAttribute('content', description)
  }, [t])

  return (
    <RouteErrorBoundary>
      <Suspense
        fallback={
          <div className="page-status" role="status">
            {t('Loading…')}
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<Navigate to={PATHS.home} replace />} />
          <Route element={<SessionLayout />}>
            <Route path="/oauth/authorize" element={<McpAuthorizePage />} />
            <Route path="/oauth/consent" element={<McpAuthorizePage />} />
            <Route path="/sign-in" element={<SignInPage />} />
            <Route path="/app" element={<RequireSession />}>
              <Route element={<AppShell />}>
                <Route index element={<Navigate to={PATHS.eventTypes} replace />} />
                <Route path="event-types" element={<EventTypesPage />} />
                <Route path="event-types/new" element={<EventTypeEditorPage />} />
                <Route path="event-types/:id" element={<EventTypeEditorPage />} />
                <Route path="availability" element={<AvailabilityPage />} />
                <Route path="availability/new" element={<ScheduleEditorPage />} />
                <Route path="availability/:id" element={<ScheduleEditorPage />} />
                <Route path="bookings" element={<BookingsPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="bookings/:id" element={<BookingDetailPage />} />
                <Route path="conferences" element={<ConferencesPage />} />
                <Route path="calendars" element={<CalendarsPage />} />
                <Route path="connected-apps" element={<ConnectedAppsPage />} />
                <Route path="api-keys" element={<ApiKeysPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<AppNotFoundPage />} />
              </Route>
            </Route>
          </Route>
          {/* Public pages, outside the session: they never ask who is signed in. */}
          <Route path="/embed/team/:teamSlug/:slug" element={<EmbeddedTeamBookingPage />} />
          <Route path="/embed/:handle/:slug" element={<EmbeddedBookingPage />} />
          <Route path="/booking" element={<ManageBookingPage />} />
          <Route path="/team/:teamSlug/:slug" element={<TeamBookingPage />} />
          <Route path="/:handle" element={<HostPage />} />
          <Route path="/:handle/:slug" element={<BookingPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  )
}
