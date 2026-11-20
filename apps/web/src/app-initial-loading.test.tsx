import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'

vi.mock('./lazy-pages.tsx', () => {
  const pending = new Promise(() => {})
  const Pending = () => {
    throw pending
  }
  const names = [
    'AcceptInvitationPage',
    'AnalyticsPage',
    'ApiKeysPage',
    'AppShell',
    'AuditLogPage',
    'AvailabilityPage',
    'BookingDetailPage',
    'BookingPage',
    'BookingsPage',
    'CalendarsPage',
    'ConferencesPage',
    'ConnectedAppsPage',
    'CreateTeamPage',
    'EmbeddedBookingPage',
    'EmbeddedTeamBookingPage',
    'EventTypeEditorPage',
    'EventTypesPage',
    'HostMeetingPollRoute',
    'HostPage',
    'ManageBookingPage',
    'McpAuthorizePage',
    'MeetingPollPage',
    'MeetingPollsPage',
    'OneTimeBookingPage',
    'RequireSession',
    'RoutingFormPage',
    'ScheduleEditorPage',
    'SessionLayout',
    'SettingsPage',
    'SignInPage',
    'TeamBookingPage',
    'TeamBookingsPage',
    'TroubleshootPage',
  ]
  return Object.fromEntries(names.map((name) => [name, Pending]))
})

describe('before route chunks are available', () => {
  it.each([
    '/app',
    '/app/settings',
    '/app/team/bookings',
    '/app/meeting-polls',
    '/app/meeting-polls/poll-id',
    '/',
  ])('shows the admin shell immediately at %s', async (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.queryByRole('banner')).not.toBeNull())
    expect(screen.getByRole('main').querySelector('.page-skeleton')).not.toBeNull()
    expect(document.querySelector('.skeleton-nav')).not.toBeNull()
  })

  it.each([
    '/ada',
    '/book/pAtH_0123456789abcdefghijklmnopqrstuvwxyzAB',
    '/poll',
    '/poll/voter',
    '/poll/recover',
    '/poll/reminder-opt-out',
  ])('keeps public loading independent of the admin shell at %s', (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByRole('status').className).toBe('page-status')
  })
})
