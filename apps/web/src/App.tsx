import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell.tsx'
import { ApiKeysPage } from './pages/ApiKeys.tsx'
import { AvailabilityPage } from './pages/availability/Availability.tsx'
import { ScheduleEditorPage } from './pages/availability/ScheduleEditor.tsx'
import { BookingDetailPage } from './pages/bookings/BookingDetail.tsx'
import { BookingsPage } from './pages/bookings/Bookings.tsx'
import { EventTypeEditorPage } from './pages/event-types/EventTypeEditor.tsx'
import { EventTypesPage } from './pages/event-types/EventTypes.tsx'
import { AppNotFoundPage, NotFoundPage } from './pages/NotFound.tsx'
import { SettingsPage } from './pages/Settings.tsx'
import { SignInPage } from './pages/SignIn.tsx'
import { PATHS } from './paths.ts'
import { RequireSession, SessionProvider } from './session.tsx'

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
    <SessionProvider>
      <Routes>
        <Route path="/" element={<Navigate to={PATHS.home} replace />} />
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
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<AppNotFoundPage />} />
          </Route>
        </Route>
        {/* Public pages (booking pages, invitee links) go here, outside the session gate. */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SessionProvider>
  )
}
