import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../App.tsx'
import type { Schemas } from '../../api/client.ts'
import { AppShell, RequireSession, SessionLayout, TeamBookingsPage } from '../../lazy-pages.tsx'
import { fakeApi, json, later, ME, profile, type Routes, signedInAs } from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'
import { teamBookingPanelApi } from '../../test/team-booking-panel-api.ts'

beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, TeamBookingsPage))

const TEAM: Schemas['Me'] = {
  ...ME,
  organization: { ...ME.organization, personal: false, name: 'Research team' },
}
const first: Schemas['TeamAdminBooking'] = {
  id: 'b0000000-0000-7000-8000-000000000001',
  status: 'confirmed',
  isRescheduled: false,
  start: '2020-01-01T09:00:00.000Z',
  end: '2020-01-01T09:30:00.000Z',
  cancelledAt: null,
  canManageNoShow: true,
  eventType: {
    id: 'e0000000-0000-7000-8000-000000000001',
    title: 'First team meeting',
    publicBookingPath: null,
  },
  hosts: [{ userId: ME.user.id, name: 'Ada', timeZone: 'UTC', isCurrentMember: true }],
  attendees: [
    {
      id: '00000000-0000-7000-8000-0000000000a1',
      name: 'Grace',
      email: 'grace@example.com',
      timeZone: 'UTC',
      isBooker: true,
      noShowMarkedAt: null,
      noShowMarkedBy: null,
    },
  ],
}
const second = {
  ...first,
  id: 'b0000000-0000-7000-8000-000000000002',
  eventType: { ...first.eventType, title: 'Second team meeting' },
}
const listRoute = 'GET /api/v1/team/bookings'
let navigate: ReturnType<typeof useNavigate>
function History() {
  navigate = useNavigate()
  const location = useLocation()
  return <output data-testid="team-panel-location">{location.pathname + location.search}</output>
}
function open(path = '/app/team/bookings?tab=past') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <History />
    </MemoryRouter>,
  )
}
function server(routes: Routes = {}) {
  return fakeApi(
    teamBookingPanelApi({
      ...signedInAs(TEAM),
      ...profile(),
      [listRoute]: () => json(200, { data: [first, second], nextCursor: null }),
      ...routes,
    }),
  )
}
beforeEach(() => {
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})
const detail = () => within(screen.getByRole('region', { name: 'Team booking details' }))

describe('team booking panel', () => {
  it('hides cancellation for a confirmed paid booking with unavailable management', async () => {
    const paid = {
      ...first,
      start: '2999-01-01T09:00:00Z',
      end: '2999-01-01T09:30:00Z',
      paidManagementUnavailable: true,
    }
    server({ [listRoute]: () => json(200, { data: [paid], nextCursor: null }) })
    open('/app/team/bookings')
    await userEvent.setup().click(await screen.findByRole('button', { name: 'First team meeting' }))
    await screen.findByRole('region', { name: 'Team booking details' })
    expect(detail().queryByRole('button', { name: 'Cancel booking…' })).toBeNull()
    expect(
      detail().getByText(/contact your instance operator about cancellation or refunds/i),
    ).toBeTruthy()
  })

  it('keeps the team list mounted and navigates its next page with a single history entry', async () => {
    const api = server({
      [listRoute]: ({ path }) =>
        json(
          200,
          new URL(path, 'http://test').searchParams.has('cursor')
            ? { data: [second], nextCursor: null }
            : { data: [first], nextCursor: 'team-next' },
        ),
    })
    open()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'First team meeting' })
    const table = trigger.closest('table') as HTMLTableElement
    await user.click(trigger)
    expect(await screen.findByRole('dialog', { name: /First team meeting/ })).toBeTruthy()
    expect(table.isConnected).toBe(true)
    expect(
      screen
        .getByRole<HTMLButtonElement>('button', { name: 'Previous booking' })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Next booking' }))
    await waitFor(() => expect(detail().getByText('Second team meeting')).toBeTruthy())
    expect(
      screen
        .getByRole<HTMLButtonElement>('button', { name: 'Next booking' })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    expect(api.to(listRoute)).toHaveLength(2)
    expect(
      new URL(api.to(listRoute)[1]?.path ?? '', 'http://test').searchParams.get('cursor'),
    ).toBe('team-next')
    await user.click(screen.getByRole('button', { name: 'Previous booking' }))
    await waitFor(() => expect(detail().getByText('First team meeting')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous booking' }))
    await act(async () => navigate(-1))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull(),
    )
    expect(screen.getByTestId('team-panel-location').textContent).toBe(
      '/app/team/bookings?tab=past',
    )
    expect(screen.getByRole('button', { name: 'First team meeting' })).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('button', { name: 'Second team meeting' })).toBeTruthy()
  })

  it('keeps the no-show mark synchronized between panel and mounted row', async () => {
    const route = `PATCH /api/v1/bookings/${first.id}/attendees/${first.attendees[0]?.id}/no-show`
    server({
      [route]: () =>
        json(200, {
          attendeeId: first.attendees[0]?.id,
          noShowMarkedAt: '2020-01-01T09:05:00Z',
          noShowMarkedBy: TEAM.user.id,
        }),
    })
    open()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'First team meeting' })
    const row = within(trigger.closest('tr') as HTMLElement)
    await user.click(trigger)
    const panel = within(await screen.findByRole('region', { name: 'Team booking details' }))
    await user.click(panel.getByRole('button', { name: 'Mark Grace as a no-show' }))
    await waitFor(() => expect(row.getByText('No-show')).toBeTruthy())
    expect(detail().getByRole('button', { name: 'Clear no-show for Grace' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Close details' }))
    expect(row.getByRole('button', { name: 'Clear no-show for Grace' })).toBeTruthy()
    expect(document.activeElement).toBe(trigger)
  })
})

it.each([403, 404])(
  'keeps the team list usable after detail read returns %s while stepping',
  async (status) => {
    server({
      [`GET /api/v1/team/bookings/${second.id}`]: () =>
        json(status, { error: 'booking_not_found' }),
    })
    open()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'First team meeting' })
    await user.click(trigger)
    await screen.findByRole('region', { name: 'Team booking details' })
    await user.click(screen.getByRole('button', { name: 'Next booking' }))
    await screen.findByRole('heading', { name: 'Booking not found' })
    expect(trigger.isConnected).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Previous booking' }))
    await screen.findByRole('region', { name: 'Team booking details' })
    await user.click(screen.getByRole('button', { name: 'Close details' }))
    expect(document.activeElement).toBe(trigger)
  },
)

it('finishes team cancellation with a reason without prompting to discard an already saved draft', async () => {
  const future = { ...first, start: '2999-01-01T09:00:00Z', end: '2999-01-01T09:30:00Z' }
  let cancelled = false
  const api = server({
    [listRoute]: () => json(200, { data: cancelled ? [] : [future], nextCursor: null }),
    [`POST /api/v1/team/bookings/${first.id}/cancel`]: () => {
      cancelled = true
      return json(200, { cancelled: true })
    },
  })
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: ['/app/team/bookings'],
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<RouterProvider router={router} />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'First team meeting' }))
  await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
  await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'Meeting no longer needed')
  await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/app/team/bookings'))
  expect(confirm).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull())
  expect(api.to(`POST /api/v1/team/bookings/${first.id}/cancel`)[0]?.body).toEqual({
    reason: 'Meeting no longer needed',
  })
  router.dispose()
})

it('keeps a later team detail open when an earlier cancellation finishes', async () => {
  const pending = later()
  let cancelled = false
  const future = { ...first, start: '2999-01-01T09:00:00Z', end: '2999-01-01T09:30:00Z' }
  server({
    [listRoute]: () =>
      json(200, {
        data: [{ ...future, status: cancelled ? 'cancelled' : 'confirmed' }, second],
        nextCursor: null,
      }),
    [`POST /api/v1/team/bookings/${first.id}/cancel`]: () => pending.response,
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  open('/app/team/bookings?tab=all')
  const user = userEvent.setup()
  const trigger = await screen.findByRole('button', { name: 'First team meeting' })
  await user.click(trigger)
  await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
  await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
  await user.click(screen.getByRole('button', { name: 'Next booking' }))
  await waitFor(() => expect(detail().getByText('Second team meeting')).toBeTruthy())
  cancelled = true
  await pending.answer(json(200, { cancelled: true }))
  await waitFor(() => {
    expect(within(trigger.closest('tr') as HTMLElement).getByText('Cancelled')).toBeTruthy()
  })
  expect(detail().getByText('Second team meeting')).toBeTruthy()
  expect(screen.getByTestId('team-panel-location').textContent).toBe(`/app/bookings/${second.id}`)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next booking' }))
})
