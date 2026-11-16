import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { AppShell, RequireSession, SessionLayout, TeamBookingsPage } from '../../lazy-pages.tsx'
import {
  fakeApi,
  json,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'

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
  return fakeApi({
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
  })
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
const flash = () =>
  screen.getAllByRole('status').find((element) => element.classList.contains('flash'))

describe('team bookings list no-show controls', () => {
  it('keeps a row change and the open details in step both ways', async () => {
    const api = server({ [NO_SHOW]: echo })
    renderApp(PAGE)
    const user = userEvent.setup()
    const cells = await row()
    await user.click(cells.getByRole('button', { name: 'Team discovery call' }))

    await user.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    expect(
      await detail().findByRole('button', { name: 'Clear no-show for Grace Hopper' }),
    ).toBeTruthy()
    expect(detail().getByText('No-show')).toBeTruthy()
    expect(cells.getByText('No-show')).toBeTruthy()
    expect(flash()?.textContent).toBe('No-show mark updated.')

    await user.click(detail().getByRole('button', { name: 'Clear no-show for Grace Hopper' }))
    expect(
      await cells.findByRole('button', { name: 'Mark Grace Hopper as a no-show' }),
    ).toBeTruthy()
    expect(cells.queryByText('No-show')).toBeNull()
    expect(detail().queryByText('No-show')).toBeNull()

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
