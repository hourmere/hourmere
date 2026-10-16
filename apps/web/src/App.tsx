import { Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import {
  ApiKeysPage,
  AppShell,
  AvailabilityPage,
  BookingPage,
  BookingsPage,
  EventTypesPage,
  HostPage,
  ManageBookingPage,
  RequireSession,
  SessionLayout,
  SettingsPage,
  SignInPage,
} from './lazy-pages.tsx'
import { NotFoundPage } from './pages/NotFound.tsx'

/**
 * The web app: one client of the public API (/api/v1 and Better Auth's /api/auth), with no
 * endpoints of its own. The router comes from the caller (BrowserRouter in main.tsx,
 * MemoryRouter in tests).
 *
 * Public booking pages live at the root (/{handle}, /{handle}/{slug}) beside the app's own
 * pages: the app's paths win (static segments rank above dynamic ones), and no handle can take
 * one of them (@hourmere/core's RESERVED_NAMES lists every top-level path).
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
        <Route element={<SessionLayout />}>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route element={<RequireSession />}>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/event-types" replace />} />
              <Route path="event-types" element={<EventTypesPage />} />
              <Route path="availability" element={<AvailabilityPage />} />
              <Route path="bookings" element={<BookingsPage />} />
              <Route path="api-keys" element={<ApiKeysPage />} />
              <Route path="settings" element={<SettingsPage />} />
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
