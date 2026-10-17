// The app's pages, each loaded on demand (route-level code splitting): someone opening a
// booking link downloads neither the signed-in app nor its session check, and the signed-in
// app does not download the booking pages. Add new pages here, not as static imports in
// App.tsx, or they end up in the bundle every visitor loads.
import { type ComponentType, lazy } from 'react'
import { Outlet } from 'react-router'

const page = <M,>(load: () => Promise<M>, pick: (module: M) => ComponentType) =>
  lazy(() => load().then((module) => ({ default: pick(module) })))

// The signed-in app.
/** SessionProvider around the signed-in routes (and sign-in), as a layout route. */
export const SessionLayout = page(
  () => import('./session.tsx'),
  ({ SessionProvider }) =>
    function SessionLayout() {
      return (
        <SessionProvider>
          <Outlet />
        </SessionProvider>
      )
    },
)
export const RequireSession = page(
  () => import('./session.tsx'),
  (m) => m.RequireSession,
)
export const AppShell = page(
  () => import('./components/AppShell.tsx'),
  (m) => m.AppShell,
)
export const SignInPage = page(
  () => import('./pages/SignIn.tsx'),
  (m) => m.SignInPage,
)
export const ApiKeysPage = page(
  () => import('./pages/ApiKeys.tsx'),
  (m) => m.ApiKeysPage,
)
export const EventTypesPage = page(
  () => import('./pages/event-types/EventTypes.tsx'),
  (m) => m.EventTypesPage,
)
export const EventTypeEditorPage = page(
  () => import('./pages/event-types/EventTypeEditor.tsx'),
  (m) => m.EventTypeEditorPage,
)
export const AvailabilityPage = page(
  () => import('./pages/availability/Availability.tsx'),
  (m) => m.AvailabilityPage,
)
export const ScheduleEditorPage = page(
  () => import('./pages/availability/ScheduleEditor.tsx'),
  (m) => m.ScheduleEditorPage,
)
export const BookingsPage = page(
  () => import('./pages/bookings/Bookings.tsx'),
  (m) => m.BookingsPage,
)
export const BookingDetailPage = page(
  () => import('./pages/bookings/BookingDetail.tsx'),
  (m) => m.BookingDetailPage,
)
export const SettingsPage = page(
  () => import('./pages/Settings.tsx'),
  (m) => m.SettingsPage,
)
export const CalendarsPage = page(
  () => import('./pages/Calendars.tsx'),
  (m) => m.CalendarsPage,
)

// Public pages: booking pages and the invitee's manage page.
export const HostPage = page(
  () => import('./public/HostPage.tsx'),
  (m) => m.HostPage,
)
export const BookingPage = page(
  () => import('./public/BookingPage.tsx'),
  (m) => m.BookingPage,
)
export const ManageBookingPage = page(
  () => import('./public/ManageBookingPage.tsx'),
  (m) => m.ManageBookingPage,
)
