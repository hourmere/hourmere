import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import type { Booking } from '../../api/resources.ts'
import { AppShell, BookingsPage, RequireSession, SessionLayout } from '../../lazy-pages.tsx'
import { fakeApi, json, later, profile, type Routes, signedIn } from '../../test/fake-api.tsx'
import { booking } from '../../test/fixtures.ts'
import { slotsAnswer } from '../../test/public-fixtures.ts'
import { resolveLazy } from '../../test/resolve-lazy.ts'

const first = booking({ title: 'First appointment', questions: [] })
const second = booking({
  id: 'b0000000-0000-7000-8000-000000000002',
  title: 'Second appointment',
  questions: [],
})
const third = booking({
  id: 'b0000000-0000-7000-8000-000000000003',
  title: 'Third appointment',
  questions: [],
})
const listRoute = 'GET /api/v1/bookings'
const address = () => screen.getByTestId('panel-location').textContent
let navigate: ReturnType<typeof useNavigate>
let current: ReturnType<typeof useLocation>
function History() {
  navigate = useNavigate()
  current = useLocation()
  return <output data-testid="panel-location">{current.pathname + current.search}</output>
}
function open(path = '/app/bookings') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <History />
    </MemoryRouter>,
  )
}
function server(routes: Routes = {}, records: Booking[] = [first, second]) {
  return fakeApi({
    ...signedIn,
    ...profile(),
    [listRoute]: () => json(200, { data: records, nextCursor: null }),
    ...Object.fromEntries(
      [first, second, third].map((record) => [
        `GET /api/v1/bookings/${record.id}`,
        () => json(200, record),
      ]),
    ),
    ...routes,
  })
}
function viewport(width: number) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width') ? width <= 767 : width >= 768,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}
beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, BookingsPage))
beforeEach(() => viewport(1200))
const close = () => screen.getByRole('button', { name: 'Close details' })
const next = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Next booking' })
const previous = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Previous booking' })

// The real router and network boundary exercise the lasting list, not a mocked panel.
describe('booking list detail navigation', () => {
  it.each([true, undefined] as const)(
    'respects the server paid management restriction (%s) in the host panel',
    async (paidManagementUnavailable) => {
      server({
        [`GET /api/v1/bookings/${first.id}`]: () =>
          json(200, {
            ...first,
            start: '2999-01-01T09:00:00Z',
            end: '2999-01-01T09:30:00Z',
            paidManagementUnavailable,
            payment: { status: 'paid', amountMinor: 1200, currency: 'usd', refundStatus: null },
          }),
      })
      open()
      await userEvent.setup().click(await screen.findByRole('link', { name: 'First appointment' }))
      await screen.findByRole('heading', { name: 'First appointment' })
      const panel = within(screen.getByRole('dialog', { name: /First appointment/ }))
      for (const name of ['Cancel booking…', 'Reschedule', 'Request reschedule']) {
        expect(panel.queryByRole('button', { name }) !== null, name).toBe(
          !paidManagementUnavailable,
        )
      }
      expect(
        panel.queryByText(/contact your instance operator about cancellation or refunds/i) !== null,
      ).toBe(Boolean(paidManagementUnavailable))
    },
  )

  it.each([
    '',
    '?tab=past',
    '?tab=cancelled',
    '?q=Grace',
    '?tab=past&q=Grace',
    '?tab=cancelled&q=Grace',
  ])('preserves the mounted list, search, loaded pages and scroll for %s', async (query) => {
    const api = server({
      [listRoute]: ({ path }) =>
        json(
          200,
          new URL(path, 'http://test').searchParams.has('cursor')
            ? { data: [third], nextCursor: null }
            : { data: [first, second], nextCursor: 'page-two' },
        ),
    })
    open(`/app/bookings${query}`)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Show more bookings' }))
    const trigger = await screen.findByRole('link', { name: 'Third appointment' })
    const table = trigger.closest('table') as HTMLTableElement
    const scroller = table.parentElement as HTMLElement
    scroller.scrollTop = 173
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search bookings' })
    const searchValue = search.value
    await user.click(trigger)
    await screen.findByRole('heading', { name: 'Third appointment' })
    expect(address()).toContain(`/app/bookings/${third.id}`)
    expect(table.isConnected).toBe(true)
    await user.click(close())
    await waitFor(() => expect(address()).toBe(`/app/bookings${query}`))
    expect(screen.getByRole('link', { name: 'Third appointment' })).toBe(trigger)
    expect(screen.getByRole('searchbox', { name: 'Search bookings' })).toBe(search)
    expect(search.value).toBe(searchValue)
    expect(scroller.scrollTop).toBe(173)
    expect(api.to(listRoute)).toHaveLength(2)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('steps in list order across pages, keeps control focus and replaces the detail history entry', async () => {
    const api = server({
      [listRoute]: ({ path }) =>
        json(
          200,
          new URL(path, 'http://test').searchParams.has('cursor')
            ? { data: [third], nextCursor: null }
            : { data: [first, second], nextCursor: 'page-two' },
        ),
    })
    open('/app/bookings?tab=past&q=Grace')
    const user = userEvent.setup()
    const trigger = await screen.findByRole('link', { name: 'First appointment' })
    await user.click(trigger)
    await screen.findByRole('heading', { name: 'First appointment' })
    expect(previous().getAttribute('aria-disabled')).toBe('true')
    expect(next().getAttribute('aria-disabled')).toBe('false')
    await user.click(next())
    await screen.findByRole('heading', { name: 'Second appointment' })
    expect(document.activeElement).toBe(next())
    await user.click(next())
    await screen.findByRole('heading', { name: 'Third appointment' })
    expect(next().getAttribute('aria-disabled')).toBe('true')
    expect(api.to(listRoute)).toHaveLength(2)
    const params = new URL(api.to(listRoute)[1]?.path ?? '', 'http://test').searchParams
    expect(params.get('q')).toBe('Grace')
    expect(params.get('order')).toBe('desc')
    expect(params.get('cursor')).toBe('page-two')
    await user.click(previous())
    await screen.findByRole('heading', { name: 'Second appointment' })
    expect(document.activeElement).toBe(previous())
    await act(async () => navigate(-1))
    await waitFor(() => expect(address()).toBe('/app/bookings?tab=past&q=Grace'))
    expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull()
    expect(trigger.isConnected).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('opens a named modal panel, hides the background and restores it with focus on Escape', async () => {
    server()
    open()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('link', { name: 'First appointment' })
    await user.click(trigger)
    await screen.findByRole('heading', { name: 'First appointment' })
    const panel = screen.getByRole('dialog', { name: /First appointment/ })
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.contains(document.activeElement)).toBe(true)
    const background = trigger.closest('[aria-hidden="true"]') as HTMLElement
    expect(background).not.toBeNull()
    expect(background.inert).toBe(true)
    expect(screen.queryByRole('searchbox', { name: 'Search bookings' })).toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /First appointment/ })).toBeNull(),
    )
    expect(document.activeElement).toBe(trigger)
    expect(background.inert).not.toBe(true)
    expect(background.getAttribute('aria-hidden')).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search bookings' })).toBeTruthy()
  })

  it('cycles Tab and Shift+Tab within the desktop panel, including its detail form', async () => {
    server()
    open()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('link', { name: 'First appointment' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    const panel = screen.getByRole('dialog', { name: /First appointment/ })
    const last = within(panel).getByRole('link', { name: 'grace@example.com' })
    last.focus()
    await user.tab()
    expect(document.activeElement).toBe(close())
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(last)
    close().focus()
    await user.tab()
    expect(document.activeElement).toBe(previous())
    await user.tab()
    expect(document.activeElement).toBe(next())
    const reason = within(panel).getByRole('textbox', { name: /Reason/ })
    reason.focus()
    await user.tab()
    expect(document.activeElement).toBe(
      within(panel).getByRole('button', { name: 'Cancel booking' }),
    )
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('renders a direct detail URL as a full page without fetching a default list', async () => {
    const api = server()
    open(`/app/bookings/${second.id}`)
    await screen.findByRole('heading', { name: 'Second appointment' })
    expect(screen.queryByRole('dialog', { name: /Second appointment/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous booking' })).toBeNull()
    expect(api.to(listRoute)).toHaveLength(0)
  })

  it('shows a full screen detail on a phone and still restores the list on Back', async () => {
    viewport(390)
    server()
    open('/app/bookings?tab=past&q=Grace')
    const trigger = await screen.findByRole('link', { name: 'First appointment' })
    document.documentElement.scrollTop = 240
    await userEvent.click(trigger)
    await screen.findByRole('heading', { name: 'First appointment' })
    expect(screen.queryByRole('dialog', { name: /First appointment/ })).toBeNull()
    expect(screen.queryByRole('searchbox', { name: 'Search bookings' })).toBeNull()
    // An in-flow page: the rest of the main content is taken out of view, the page starts at the top.
    expect(trigger.closest('[data-booking-panel-covered]')).not.toBeNull()
    expect(document.body.style.overflow).toBe('')
    expect(document.documentElement.scrollTop).toBe(0)
    await act(async () => navigate(-1))
    await waitFor(() => expect(address()).toBe('/app/bookings?tab=past&q=Grace'))
    expect(await screen.findByRole('link', { name: 'First appointment' })).toBe(trigger)
    expect(trigger.closest('[data-booking-panel-covered]')).toBeNull()
    expect(document.documentElement.scrollTop).toBe(240)
    document.documentElement.scrollTop = 0
  })

  it('reflects a detail cancellation in the existing row without reloading the list', async () => {
    const api = server({
      [`POST /api/v1/bookings/${first.id}/cancel`]: () =>
        json(200, {
          ...first,
          status: 'cancelled',
          cancelledAt: '2026-11-01T12:00:00Z',
        }),
    })
    open()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('link', { name: 'First appointment' })
    const row = trigger.closest('tr') as HTMLTableRowElement
    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await waitFor(() => expect(within(row).getByText('Cancelled')).toBeTruthy())
    expect(api.to(listRoute)).toHaveLength(1)
    await user.click(close())
    expect(within(row).getByText('Cancelled')).toBeTruthy()
  })

  it.each([403, 404])(
    'keeps the list and navigation working after a %s while stepping',
    async (status) => {
      server({
        [`GET /api/v1/bookings/${second.id}`]: () => json(status, { error: 'booking_not_found' }),
        [`GET /api/v1/bookings/${second.id}/organization`]: () =>
          json(404, { error: 'booking_not_found' }),
      })
      open()
      const user = userEvent.setup()
      const trigger = await screen.findByRole('link', { name: 'First appointment' })
      await user.click(trigger)
      await screen.findByRole('heading', { name: 'First appointment' })
      await user.click(next())
      await waitFor(() =>
        expect(
          screen.queryByRole('heading', { name: 'Booking not found' }) ??
            screen.queryByRole('alert'),
        ).not.toBeNull(),
      )
      expect(trigger.isConnected).toBe(true)
      await user.click(previous())
      await screen.findByRole('heading', { name: 'First appointment' })
      await user.click(close())
      expect(address()).toBe('/app/bookings')
    },
  )

  it('does not intercept arrow keys typed into a detail form', async () => {
    server()
    open()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('link', { name: 'First appointment' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    const reason = screen.getByRole('textbox', { name: /Reason/ })
    fireEvent.keyDown(reason, { key: 'ArrowRight' })
    fireEvent.keyDown(reason, { key: 'ArrowLeft' })
    expect(address()).toContain(first.id)
  })
})

it('keeps host no-show changes synchronized with the mounted list row', async () => {
  const attendeeId = '00000000-0000-7000-8000-0000000000a1'
  const record = booking({
    ...first,
    start: '2020-01-01T09:00:00Z',
    end: '2020-01-01T09:30:00Z',
    canManageNoShow: true,
    attendees: [
      { ...first.attendees[0], id: attendeeId, noShowMarkedAt: null, noShowMarkedBy: null },
    ] as Booking['attendees'],
  })
  const api = server(
    {
      [`GET /api/v1/bookings/${first.id}`]: () => json(200, record),
      [`PATCH /api/v1/bookings/${first.id}/attendees/${attendeeId}/no-show`]: () =>
        json(200, { attendeeId, noShowMarkedAt: '2020-01-01T09:05:00Z', noShowMarkedBy: 'host' }),
    },
    [record],
  )
  open('/app/bookings?tab=past')
  const user = userEvent.setup()
  const trigger = await screen.findByRole('link', { name: 'First appointment' })
  const row = within(trigger.closest('tr') as HTMLElement)
  await user.click(trigger)
  const panel = await screen.findByRole('dialog', { name: /First appointment/ })
  await user.click(
    await within(panel).findByRole('button', { name: 'Mark Grace Hopper as a no-show' }),
  )
  await waitFor(() => expect(row.getByText('No-show')).toBeTruthy())
  expect(api.to(listRoute)).toHaveLength(1)
  await user.click(close())
  expect(row.getByRole('button', { name: 'Clear no-show for Grace Hopper' })).toBeTruthy()
})

it('reschedules inside the panel and updates the predecessor row while opening its successor', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T04:30:00Z'))
  const original = booking({ ...first, start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:30:00Z' })
  const successor = booking({
    ...third,
    start: '2026-11-03T16:00:00.000Z',
    end: '2026-11-03T16:30:00.000Z',
    rescheduledFromId: original.id,
  })
  const api = server(
    {
      [`GET /api/v1/bookings/${original.id}`]: () => json(200, original),
      [`GET /api/v1/bookings/${successor.id}`]: () => json(200, successor),
      [`GET /api/v1/bookings/${original.id}/slots`]: slotsAnswer([successor.start]),
      [`POST /api/v1/bookings/${original.id}/reschedule`]: () =>
        json(200, { booking: successor, manageToken: null }),
    },
    [original],
  )
  open()
  const user = userEvent.setup()
  const trigger = await screen.findByRole('link', { name: 'First appointment' })
  const row = within(trigger.closest('tr') as HTMLElement)
  await user.click(trigger)
  await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
  await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
  await user.click(screen.getByRole('button', { name: '5:00 PM' }))
  await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
  await screen.findByRole('heading', { name: 'Third appointment' })
  // The successor is not a list row, so the panel takes its name from the detail once loaded.
  expect(await screen.findByRole('dialog', { name: /Third appointment/ })).toBeTruthy()
  expect(trigger.isConnected).toBe(true)
  expect(row.getByText('Rescheduled')).toBeTruthy()
  expect(api.to(listRoute)).toHaveLength(1)
  await user.click(close())
  expect(address()).toBe('/app/bookings')
  expect(document.activeElement).toBe(trigger)
})

it('opens another row after closing the panel and retains the original list state', async () => {
  const api = server()
  open('/app/bookings?tab=past&q=Grace')
  const user = userEvent.setup()
  const firstTrigger = await screen.findByRole('link', { name: 'First appointment' })
  await user.click(firstTrigger)
  await screen.findByRole('heading', { name: 'First appointment' })
  await user.click(close())
  const secondTrigger = screen.getByRole('link', { name: 'Second appointment' })
  await user.click(secondTrigger)
  await screen.findByRole('heading', { name: 'Second appointment' })
  await act(async () => navigate(-1))
  expect(address()).toBe('/app/bookings?tab=past&q=Grace')
  expect(document.activeElement).toBe(secondTrigger)
  expect(api.to(listRoute)).toHaveLength(1)
})

it('does not reopen a closed detail when a neighbouring page finishes loading', async () => {
  const pending = later()
  server({
    [listRoute]: ({ path }) =>
      new URL(path, 'http://test').searchParams.has('cursor')
        ? pending.response
        : json(200, { data: [first], nextCursor: 'more' }),
  })
  open()
  const user = userEvent.setup()
  const trigger = await screen.findByRole('link', { name: 'First appointment' })
  await user.click(trigger)
  await screen.findByRole('heading', { name: 'First appointment' })
  await user.click(next())
  await user.click(close())
  await pending.answer(json(200, { data: [second], nextCursor: null }))
  expect(address()).toBe('/app/bookings')
  expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('still steps when the open detail refreshes its own history state while the next page loads', async () => {
  const pending = later()
  server({
    [listRoute]: ({ path }) =>
      new URL(path, 'http://test').searchParams.has('cursor')
        ? pending.response
        : json(200, { data: [first], nextCursor: 'more' }),
  })
  open()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'First appointment' }))
  await screen.findByRole('heading', { name: 'First appointment' })
  await user.click(next())
  // Like the detail remembering its space: the same entry is replaced with extended state.
  const { pathname, state } = current
  await act(async () => navigate(pathname, { replace: true, state: { ...state, refreshed: true } }))
  await pending.answer(json(200, { data: [second], nextCursor: null }))
  await screen.findByRole('heading', { name: 'Second appointment' })
  expect(address()).toBe(`/app/bookings/${second.id}`)
})

it('uses the detail breadcrumb to restore the exact filtered list', async () => {
  server()
  open('/app/bookings?tab=cancelled&q=Grace')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'First appointment' }))
  const panel = await screen.findByRole('dialog', { name: /First appointment/ })
  await user.click(await within(panel).findByRole('button', { name: 'Bookings' }))
  expect(address()).toBe('/app/bookings?tab=cancelled&q=Grace')
})

it.each(['Close', 'Back'])(
  'confirms a dirty %s once with the production data router and preserves declined drafts',
  async (action) => {
    server()
    const router = createMemoryRouter([{ path: '*', element: <App /> }], {
      initialEntries: ['/app/bookings?tab=past&q=Grace'],
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RouterProvider router={router} />)
    const user = userEvent.setup()
    const trigger = await screen.findByRole('link', { name: 'First appointment' })
    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'Keep my draft')
    if (action === 'Close') await user.click(close())
    else
      await act(async () => {
        await router.navigate(-1)
      })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('Keep my draft')).toBeTruthy()
    expect(router.state.location.pathname).toContain(first.id)
    confirm.mockClear().mockReturnValue(true)
    if (action === 'Close') await user.click(close())
    else
      await act(async () => {
        await router.navigate(-1)
      })
    expect(confirm).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/app/bookings?tab=past&q=Grace',
      ),
    )
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    router.dispose()
  },
)

it.each(['close', 'next'])(
  'applies a late successful cancellation to the list after %s without reopening its detail',
  async (leave) => {
    const pending = later()
    server({ [`POST /api/v1/bookings/${first.id}/cancel`]: () => pending.response })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    open()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('link', { name: 'First appointment' })
    const row = within(trigger.closest('tr') as HTMLElement)
    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'Cancel this meeting')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await user.click(leave === 'close' ? close() : next())
    if (leave === 'next') await screen.findByRole('heading', { name: 'Second appointment' })
    await pending.answer(
      json(200, { ...first, status: 'cancelled', cancelledAt: '2026-11-01T09:00:00Z' }),
    )
    await waitFor(() => expect(row.getByText('Cancelled')).toBeTruthy())
    expect(address()).toBe(leave === 'close' ? '/app/bookings' : `/app/bookings/${second.id}`)
    expect(screen.queryByRole('heading', { name: 'First appointment' })).toBeNull()
  },
)

it('applies a late successful reschedule to the list after close without opening its successor', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T04:30:00Z'))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const pending = later()
  const original = booking({ ...first, start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:30:00Z' })
  const successor = booking({
    ...third,
    start: '2026-11-03T16:00:00.000Z',
    end: '2026-11-03T16:30:00.000Z',
    rescheduledFromId: original.id,
  })
  const api = server(
    {
      [`GET /api/v1/bookings/${original.id}`]: () => json(200, original),
      [`GET /api/v1/bookings/${original.id}/slots`]: slotsAnswer([successor.start]),
      [`POST /api/v1/bookings/${original.id}/reschedule`]: () => pending.response,
    },
    [original],
  )
  open()
  const user = userEvent.setup()
  const trigger = await screen.findByRole('link', { name: 'First appointment' })
  const row = within(trigger.closest('tr') as HTMLElement)
  await user.click(trigger)
  await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
  await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
  await user.click(screen.getByRole('button', { name: '5:00 PM' }))
  await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
  await user.click(close())
  await pending.answer(json(200, { booking: successor, manageToken: null }))
  await waitFor(() => expect(row.getByText('Rescheduled')).toBeTruthy())
  expect(address()).toBe('/app/bookings')
  expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull()
  expect(api.to(`GET /api/v1/bookings/${successor.id}`)).toHaveLength(0)
})
