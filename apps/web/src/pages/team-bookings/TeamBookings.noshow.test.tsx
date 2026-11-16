import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { AppShell, RequireSession, SessionLayout, TeamBookingsPage } from '../../lazy-pages.tsx'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'
import { teamBookingPanelApi } from '../../test/team-booking-panel-api.ts'

beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, TeamBookingsPage))

const PAGE = '/app/team/bookings'
const LIST = 'GET /api/v1/team/bookings'
const BOOKING_ID = 'b0000000-0000-7000-8000-000000000001'
const GRACE = '00000000-0000-7000-8000-0000000000a1'
const NO_SHOW = `PATCH /api/v1/bookings/${BOOKING_ID}/attendees/${GRACE}/no-show`
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}
const BOOKING: Schemas['TeamAdminBooking'] = {
  id: BOOKING_ID,
  status: 'confirmed',
  isRescheduled: false,
  start: '2020-01-01T09:00:00.000Z',
  end: '2020-01-01T09:30:00.000Z',
  cancelledAt: null,
  canManageNoShow: true,
  eventType: {
    id: 'e0000000-0000-7000-8000-000000000001',
    title: 'Team discovery call',
    publicBookingPath: null,
  },
  hosts: [
    {
      userId: 'a0000000-0000-7000-8000-000000000001',
      name: 'Historical host',
      timeZone: 'Europe/London',
      isCurrentMember: true,
    },
  ],
  attendees: [
    {
      id: GRACE,
      name: 'Grace Hopper',
      email: 'grace@example.com',
      timeZone: 'America/New_York',
      isBooker: true,
      noShowMarkedAt: null,
      noShowMarkedBy: null,
    },
  ],
}
function server(routes: Routes) {
  return fakeApi(
    teamBookingPanelApi({
      ...signedInAs(TEAM),
      ...profile(),
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM.organization]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          id: 'membership-1',
          organizationId: TEAM.organization.id,
          userId: TEAM.user.id,
          role: 'admin',
          createdAt: '2026-10-01T09:00:00.000Z',
        }),
      [LIST]: () => json(200, { data: [BOOKING], nextCursor: null }),
      ...routes,
    }),
  )
}
const echo: Routes[string] = ({ body }) =>
  json(200, {
    attendeeId: GRACE,
    noShowMarkedAt: (body as { noShow: boolean }).noShow ? '2020-01-01T09:05:00.000Z' : null,
    noShowMarkedBy: TEAM.user.id,
  })
async function row() {
  const button = await screen.findByRole('button', { name: 'Team discovery call' })
  const tr = button.closest('tr')
  if (!tr) throw new Error('Missing row')
  return within(tr)
}
const detail = () => within(screen.getByRole('region', { name: 'Team booking details' }))

describe('team bookings list no-show controls', () => {
  it('keeps a row change and the open details in step both ways', async () => {
    const pending = later()
    const api = server({
      [NO_SHOW]: (call) =>
        (call.body as { noShow: boolean }).noShow ? pending.response : echo(call),
    })
    renderApp(PAGE)
    const user = userEvent.setup()
    const cells = await row()
    await user.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    await user.click(cells.getByRole('button', { name: 'Team discovery call' }))
    await pending.answer(
      json(200, {
        attendeeId: GRACE,
        noShowMarkedAt: '2020-01-01T09:05:00.000Z',
        noShowMarkedBy: TEAM.user.id,
      }),
    )
    expect(
      await detail().findByRole('button', { name: 'Clear no-show for Grace Hopper' }),
    ).toBeTruthy()
    expect(detail().getByText('No-show')).toBeTruthy()
    expect(cells.getByText('No-show')).toBeTruthy()
    expect(
      cells.getByRole('button', { name: 'Clear no-show for Grace Hopper', hidden: true }),
    ).toBeTruthy()

    await user.click(detail().getByRole('button', { name: 'Clear no-show for Grace Hopper' }))
    expect(
      await cells.findByRole('button', { name: 'Mark Grace Hopper as a no-show', hidden: true }),
    ).toBeTruthy()
    expect(cells.queryByText('No-show')).toBeNull()
    expect(detail().queryByText('No-show')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close details' }))
    expect(
      screen.getAllByRole('status').find((element) => element.classList.contains('flash'))
        ?.textContent,
    ).toBe('No-show mark updated.')

    expect(api.to(NO_SHOW).map((call) => call.body)).toEqual([{ noShow: true }, { noShow: false }])
    expect(api.to(NO_SHOW).map((call) => call.headers.get('x-expected-organization-id'))).toEqual([
      TEAM.organization.id,
      TEAM.organization.id,
    ])
  })

  it('takes a row context conflict to the page recovery and disables actions', async () => {
    const api = server({ [NO_SHOW]: () => json(409, { error: 'organization_context_changed' }) })
    renderApp(PAGE)
    const user = userEvent.setup()
    const cells = await row()
    await user.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    expect(
      await screen.findByText('Your team context changed. Reload before making changes.'),
    ).toBeTruthy()
    const button = cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await user.click(cells.getByRole('button', { name: 'Team discovery call' }))
    const inDetail = detail().getByRole('button', { name: 'Mark Grace Hopper as a no-show' })
    expect((inDetail as HTMLButtonElement).disabled).toBe(true)
    expect(api.to(NO_SHOW)).toHaveLength(1)
  })

  it('shows revoked access when a row update is refused for team access', async () => {
    server({ [NO_SHOW]: () => json(403, { error: 'team_management_access_denied' }) })
    renderApp(PAGE)
    const cells = await row()
    await userEvent.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    expect(
      await screen.findByRole('heading', { name: 'Team bookings access is no longer available.' }),
    ).toBeTruthy()
  })
})

it('keeps row and details synchronized when a pending next page arrives after marking', async () => {
  const pending = later()
  server({
    [LIST]: ({ path }) =>
      new URL(path, 'http://test').searchParams.has('cursor')
        ? pending.response
        : json(200, { data: [BOOKING], nextCursor: 'next-page' }),
    [NO_SHOW]: echo,
  })
  renderApp(PAGE)
  const cells = await row()
  await userEvent.click(screen.getByRole('button', { name: 'Show more bookings' }))
  await userEvent.click(cells.getByRole('button', { name: 'Team discovery call' }))
  await userEvent.click(detail().getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
  await detail().findByRole('button', { name: 'Clear no-show for Grace Hopper' })
  await pending.answer(json(200, { data: [], nextCursor: null }))
  expect(cells.getByText('No-show')).toBeTruthy()
  expect(
    cells.getByRole('button', { name: 'Clear no-show for Grace Hopper', hidden: true }),
  ).toBeTruthy()
  expect(detail().getByText('No-show')).toBeTruthy()
})

it('preserves two row marks whose responses arrive in the same render batch', async () => {
  const second = {
    ...BOOKING,
    id: 'b0000000-0000-7000-8000-000000000002',
    eventType: { ...BOOKING.eventType, title: 'Second call' },
  }
  let resolveFirst!: (value: Response) => void
  let resolveSecond!: (value: Response) => void
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirst = resolve
  })
  const secondResponse = new Promise<Response>((resolve) => {
    resolveSecond = resolve
  })
  server({
    [LIST]: () => json(200, { data: [BOOKING, second], nextCursor: null }),
    [NO_SHOW]: () => firstResponse,
    [`PATCH /api/v1/bookings/${second.id}/attendees/${GRACE}/no-show`]: () => secondResponse,
  })
  renderApp(PAGE)
  const firstRow = await row()
  const secondElement = (await screen.findByRole('button', { name: 'Second call' })).closest('tr')
  if (!secondElement) throw new Error('Missing second row')
  const secondRow = within(secondElement)
  await userEvent.click(firstRow.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
  await userEvent.click(secondRow.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
  await act(async () => {
    const result = {
      attendeeId: GRACE,
      noShowMarkedAt: '2020-01-01T09:05:00.000Z',
      noShowMarkedBy: TEAM.user.id,
    }
    resolveFirst(json(200, result))
    resolveSecond(json(200, result))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(firstRow.getByText('No-show')).toBeTruthy()
  expect(secondRow.getByText('No-show')).toBeTruthy()
})

it('shares one pending write lock between a row and its details', async () => {
  const pending = later()
  const api = server({ [NO_SHOW]: () => pending.response })
  renderApp(PAGE)
  const cells = await row()
  await userEvent.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
  await userEvent.click(cells.getByRole('button', { name: 'Team discovery call' }))
  const detailButton = detail().getByRole('button', { name: 'Mark Grace Hopper as a no-show' })
  expect((detailButton as HTMLButtonElement).disabled).toBe(true)
  await userEvent.click(detailButton)
  expect(api.to(NO_SHOW)).toHaveLength(1)
  await pending.answer(
    json(200, {
      attendeeId: GRACE,
      noShowMarkedAt: '2020-01-01T09:05:00.000Z',
      noShowMarkedBy: TEAM.user.id,
    }),
  )
  expect(
    (detail().getByRole('button', { name: 'Clear no-show for Grace Hopper' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
  expect(cells.getByText('No-show')).toBeTruthy()
})

it('applies a late detail mark after closing details and refreshing through another cancellation', async () => {
  const pending = later()
  const future = {
    ...BOOKING,
    id: 'b0000000-0000-7000-8000-000000000002',
    start: '2999-01-01T09:00:00Z',
    end: '2999-01-01T09:30:00Z',
    eventType: { ...BOOKING.eventType, title: 'Future call' },
  }
  let cancelled = false
  server({
    [LIST]: () =>
      json(200, {
        data: [
          BOOKING,
          {
            ...future,
            status: cancelled ? 'cancelled' : 'confirmed',
            eventType: {
              ...future.eventType,
              title: cancelled ? 'Refreshed future call' : 'Future call',
            },
          },
        ],
        nextCursor: null,
      }),
    [NO_SHOW]: () => pending.response,
    [`POST /api/v1/team/bookings/${future.id}/cancel`]: () => {
      cancelled = true
      return json(200, { ...future, status: 'cancelled' })
    },
  })
  renderApp(PAGE)
  const cells = await row()
  await userEvent.click(cells.getByRole('button', { name: 'Team discovery call' }))
  await userEvent.click(detail().getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
  await userEvent.click(screen.getByRole('button', { name: 'Close details' }))
  await userEvent.click(screen.getByRole('button', { name: 'Future call' }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel booking…' }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
  await screen.findByText('The booking is cancelled.')
  // The panel preserves existing rows during refresh; row() alone can still return
  // the old snapshot. Wait for data unique to the completed refresh before the mark.
  await screen.findByRole('button', { name: 'Refreshed future call' })
  await pending.answer(
    json(200, {
      attendeeId: GRACE,
      noShowMarkedAt: '2020-01-01T09:05:00Z',
      noShowMarkedBy: TEAM.user.id,
    }),
  )
  const refreshed = await row()
  expect(refreshed.getByText('No-show')).toBeTruthy()
  expect(refreshed.getByRole('button', { name: 'Clear no-show for Grace Hopper' })).toBeTruthy()
})
