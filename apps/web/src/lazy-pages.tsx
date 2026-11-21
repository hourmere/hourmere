// The app's pages, each loaded on demand (route-level code splitting): someone opening a
// booking link downloads neither the signed-in app nor its session check, and the signed-in
// app does not download the booking pages. Add new pages here, not as static imports in
// App.tsx, or they end up in the bundle every visitor loads.
import { type ComponentType, lazy } from 'react'
import { Outlet } from 'react-router'

const page = <M,>(load: () => Promise<M>, pick: (module: M) => ComponentType) =>
  lazy(() => load().then((module) => ({ default: pick(module) })))

export const SsoSetupPage = page(
  () => import('./pages/sso/SsoSetup.tsx'),
  (module) => module.SsoSetupPage,
)

// The signed-in app.
/** SessionProvider around the signed-in routes (and sign-in), as a layout route. */
export const SessionLayout = page(
  () => import('./session.tsx'),
  ({ SessionProvider }) =>
    // biome-ignore lint/correctness/noComponentHookFactories: React.lazy caches the component identity returned by this module-level loader.
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
export const RequireRoutingForms = page(
  () => import('./components/AppShell.tsx'),
  (m) => m.RequireRoutingForms,
)
export const SignInPage = page(
  () => import('./pages/SignIn.tsx'),
  (m) => m.SignInPage,
)
export const MailboxProofPage = page(
  () => import('./pages/sso/MailboxProof.tsx'),
  (module) => module.MailboxProofPage,
)
export const AcceptInvitationPage = page(
  () => import('./pages/AcceptInvitation.tsx'),
  (m) => m.AcceptInvitationPage,
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
export const TroubleshootPage = page(
  () => import('./pages/availability/Troubleshoot.tsx'),
  (m) => m.TroubleshootPage,
)
export const ScheduleEditorPage = page(
  () => import('./pages/availability/ScheduleEditor.tsx'),
  (m) => m.ScheduleEditorPage,
)
export const BookingsPage = page(
  () => import('./pages/bookings/Bookings.tsx'),
  (m) => m.BookingsPage,
)
export const MeetingPollsPage = page(
  () => import('./pages/meeting-polls/MeetingPolls.tsx'),
  (m) => m.MeetingPollsPage,
)
export const WorkflowsPage = page(
  () => import('./pages/WorkflowsPage.tsx'),
  (m) => m.default,
)
export const WorkflowEditorPage = lazy(() =>
  import('./pages/workflow-editor/WorkflowEditorPage.tsx').then((m) => ({
    default: m.WorkflowEditorPage,
  })),
)
export const WorkflowRunHistoryPage = page(
  () => import('./pages/WorkflowRunHistoryPage.tsx'),
  (m) => m.default,
)
export const MeetingPollCreatePage = page(
  () => import('./pages/meeting-polls/MeetingPollCreate.tsx'),
  (m) => m.MeetingPollCreatePage,
)
export const HostMeetingPollRoute = page(
  () => import('./pages/meeting-polls/HostMeetingPollRoute.tsx'),
  (m) => m.HostMeetingPollRoute,
)
const routingManager = () => import('./pages/routing-forms/RoutingForms.tsx')
export const RoutingFormsPage = page(routingManager, (m) => m.RoutingFormsPage)
export const NewRoutingFormPage = page(routingManager, (m) => m.NewRoutingFormPage)
export const EditRoutingFormPage = page(routingManager, (m) => m.EditRoutingFormPage)
export const TeamBookingsPage = page(
  () => import('./pages/team-bookings/TeamBookings.tsx'),
  (m) => m.TeamBookingsPage,
)
export const BookingDetailPage = page(
  () => import('./pages/bookings/BookingDetail.tsx'),
  (m) => m.BookingDetailPage,
)
export const SettingsPage = page(
  () => import('./pages/Settings.tsx'),
  (m) => m.SettingsPage,
)
export const CreateTeamPage = page(
  () => import('./pages/CreateTeam.tsx'),
  (m) => m.CreateTeamPage,
)
export const ConferencesPage = page(
  () => import('./pages/Conferences.tsx'),
  (m) => m.ConferencesPage,
)
export const CalendarsPage = page(
  () => import('./pages/Calendars.tsx'),
  (m) => m.CalendarsPage,
)

export const AnalyticsPage = page(
  () => import('./pages/Analytics.tsx'),
  (m) => m.AnalyticsPage,
)
export const AuditLogPage = page(
  () => import('./pages/AuditLog.tsx'),
  (m) => m.AuditLogPage,
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
export const OneTimeBookingPage = page(
  () => import('./public/BookingPage.tsx'),
  (m) => m.OneTimeBookingPage,
)
export const TeamBookingPage = page(
  () => import('./public/BookingPage.tsx'),
  (m) => m.TeamBookingPage,
)
export const ManageBookingPage = page(
  () => import('./public/ManageBookingPage.tsx'),
  (m) => m.ManageBookingPage,
)

export const EmbeddedBookingPage = page(
  () => import('./public/Embed.tsx'),
  (m) => m.EmbeddedBookingPage,
)
export const EmbeddedTeamBookingPage = page(
  () => import('./public/Embed.tsx'),
  (m) => m.EmbeddedTeamBookingPage,
)
export const McpAuthorizePage = page(
  () => import('./pages/McpOAuth.tsx'),
  (m) => m.McpAuthorizePage,
)
export const ConnectedAppsPage = page(
  () => import('./pages/McpOAuth.tsx'),
  (m) => m.ConnectedAppsPage,
)

export const MeetingPollPage = lazy(() =>
  import('./public/MeetingPollPage.tsx').then((module) => ({ default: module.MeetingPollPage })),
)

export const RoutingFormPage = page(
  () => import('./public/RoutingFormPage.tsx'),
  (m) => m.RoutingFormPage,
)

export const RoutingContinuationPage = lazy(() =>
  import('./public/RoutingContinuationPage.tsx').then((module) => ({
    default: module.RoutingContinuationPage,
  })),
)
