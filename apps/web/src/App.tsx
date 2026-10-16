import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell.tsx'
import { ApiKeysPage } from './pages/ApiKeys.tsx'
import { NotFoundPage } from './pages/NotFound.tsx'
import {
  AvailabilityPage,
  BookingsPage,
  EventTypesPage,
  SettingsPage,
} from './pages/Placeholders.tsx'
import { SignInPage } from './pages/SignIn.tsx'
import { RequireSession, SessionProvider } from './session.tsx'

/**
 * The web app: one client of the public API (/api/v1 and Better Auth's /api/auth), with no
 * endpoints of its own. The router comes from the caller (BrowserRouter in main.tsx,
 * MemoryRouter in tests).
 */
export function App() {
  return (
    <SessionProvider>
      <Routes>
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
        {/* Public pages (booking pages, invitee links) go here, outside the session gate. */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SessionProvider>
  )
}
