import { Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import {
  ApiKeysPage,
  AppShell,
  AvailabilityPage,
  BookingDetailPage,
  BookingPage,
  BookingsPage,
  CalendarsPage,
  EventTypeEditorPage,
  EventTypesPage,
  HostPage,
  ManageBookingPage,
  RequireSession,
  ScheduleEditorPage,
  SessionLayout,
  SettingsPage,
  SignInPage,
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
  return (
    <Suspense
      fallback={
        <div className="page-status" role="status">
          Loading…
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<Navigate to={PATHS.home} replace />} />
        <Route element={<SessionLayout />}>
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
              <Route path="bookings/:id" element={<BookingDetailPage />} />
              <Route path="calendars" element={<CalendarsPage />} />
              <Route path="api-keys" element={<ApiKeysPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<AppNotFoundPage />} />
            </Route>
          </Route>
        </Route>
        {/* Public pages, outside the session: they never ask who is signed in. */}
        <Route path="/booking" element={<ManageBookingPage />} />
        <Route path="/:handle" element={<HostPage />} />
        <Route path="/:handle/:slug" element={<BookingPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  )
}
