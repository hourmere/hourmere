import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'

const PAGE = '/app/team/bookings'
const LIST = 'GET /api/v1/team/bookings'
const BOOKING_ID = 'b0000000-0000-7000-8000-000000000001'
const CANCEL = `POST /api/v1/team/bookings/${BOOKING_ID}/cancel`
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}
const OTHER_TEAM: Schemas['Me'] = {
  ...TEAM,
  organization: {
    ...TEAM.organization,
    id: '00000000-0000-7000-8000-000000000020',
    name: 'Another team',
    slug: 'another-team',
  },
}

type TeamBooking = Schemas['TeamAdminBooking']
function teamBooking(overrides: Partial<TeamBooking> = {}): TeamBooking {
  return {
    id: BOOKING_ID,
    status: 'confirmed',
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T09:30:00.000Z',
    cancelledAt: null,
    eventType: { id: 'e0000000-0000-7000-8000-000000000001', title: 'Team discovery call' },
    hosts: [{ userId: 'a0000000-0000-7000-8000-000000000001', name: 'Historical host' }],
    attendees: [
      {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        timeZone: 'America/New_York',
        isBooker: true,
      },
      {
        name: 'Alan Turing',
        email: 'alan@example.com',
        timeZone: 'Europe/London',
        isBooker: false,
      },
    ],
    ...overrides,
  }
}
function member(me = TEAM, role = 'owner') {
  return {
    id: 'membership-1',
    organizationId: me.organization.id,
    userId: me.user.id,
    role,
    createdAt: '2026-10-01T09:00:00.000Z',
  }
}
function server(overrides: Routes = {}, role = 'owner', me = TEAM) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/auth/organization/list': () =>
      json(200, [ME.organization, TEAM.organization, OTHER_TEAM.organization]),
    'GET /api/auth/organization/get-active-member': () => json(200, member(me, role)),
    [LIST]: () => json(200, { data: [teamBooking()], nextCursor: null }),
    [CANCEL]: () => json(200, { cancelled: true }),
    ...overrides,
  })
}
const query = (path: string) =>
  Object.fromEntries(new URL(path, 'http://example.test').searchParams)
const detail = () => screen.getByRole('region', { name: 'Team booking details' })
const titleButton = (title = 'Team discovery call') => screen.getByRole('button', { name: title })
async function openDetail(user = userEvent.setup()) {
  await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
  return user
}
async function confirmCancellation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
  await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
}

// This is an integration boundary: requests outside the list DTO and cancel route are
// deliberately unscripted. fakeApi fails the test if a personal detail route is fetched.
describe('team bookings access and context', () => {
  it.each(['owner', 'admin', 'member, admin'])(
    'shows %s the team context, scope, bookings and navigation entry',
    async (role) => {
      const api = server({}, role)
      renderApp(PAGE)
      await screen.findByRole('button', { name: 'Team discovery call' })
      const main = within(screen.getByRole('main'))
      expect(main.getByRole('heading', { name: 'Team bookings', level: 1 })).toBeDefined()
      expect(main.getByText(TEAM.organization.name)).toBeDefined()
      expect(main.getByText(role === 'owner' ? 'Owner' : 'Admin')).toBeDefined()
      expect(main.getByText(/view this team’s bookings/)).toBeDefined()
      const navigation = within(screen.getByRole('navigation', { name: 'Main' }))
      expect(navigation.getByRole('link', { name: 'Team bookings' }).getAttribute('href')).toBe(
        PAGE,
      )
      expect(
        navigation.getByRole('link', { name: 'Team bookings' }).getAttribute('aria-current'),
      ).toBe('page')
      expect(navigation.getByRole('link', { name: 'Bookings' }).getAttribute('href')).toBe(
        '/app/bookings',
      )
      expect(api.to(LIST)).toHaveLength(1)
    },
  )

  it.each([
    ['member', TEAM],
    ['owner', ME],
    ['superadmin', TEAM],
    ['owner,unknown', TEAM],
    ['ownerish', TEAM],
    ['admin-extra', TEAM],
  ] as const)('denies %s in %j without requesting team data', async (role, me) => {
    const api = server({}, role, me)
    renderApp(PAGE)
    await screen.findByRole('heading', { name: 'Team bookings are not available in this space.' })
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Bookings' }).getAttribute('href')).toBe(
      '/app/bookings',
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(api.to(LIST)).toHaveLength(0)
    expect(api.to(CANCEL)).toHaveLength(0)
  })

  it('does not fetch bookings before membership is confirmed', async () => {
    const pending = later()
    const api = server({
      'GET /api/auth/organization/get-active-member': async () => (await pending.response).clone(),
    })
    renderApp(PAGE)
    await screen.findAllByText('Loading your team role…')
    expect(api.to(LIST)).toHaveLength(0)
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    await pending.answer(json(200, member(TEAM, 'member')))
    await screen.findByRole('heading', { name: 'Team bookings are not available in this space.' })
    expect(api.to(LIST)).toHaveLength(0)
  })

  it.each(['organizationId', 'userId'] as const)(
    'denies a membership with a different %s',
    async (field) => {
      const api = server({
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { ...member(), [field]: OTHER_TEAM.organization.id }),
      })
      renderApp(PAGE)
      await screen.findByRole('heading', { name: 'Team bookings are not available in this space.' })
      expect(api.to(LIST)).toHaveLength(0)
      expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    },
  )

  it.each(['api_key', 'oauth'] as const)(
    'denies a %s principal without requesting membership or team bookings',
    async (kind) => {
      const me: Schemas['Me'] = { ...TEAM, principal: { kind, apiKeyId: null } }
      const api = server({}, 'owner', me)
      renderApp(PAGE)
      await screen.findByRole('heading', { name: 'Team bookings are not available in this space.' })
      expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
      expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(0)
      expect(api.to(LIST)).toHaveLength(0)
    },
  )

  it('clears the previous team when switching to personal space', async () => {
    const user = userEvent.setup()
    let active = TEAM
    const api = server({
      'GET /api/v1/me': () => json(200, active),
      'GET /api/auth/organization/get-active-member': () => json(200, member(active)),
      'POST /api/auth/organization/set-active': () => {
        active = ME
        return json(200, null)
      },
    })
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'Team discovery call' })
    await user.click(screen.getByRole('button', { name: /Switch space/ }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Personal' }))
    await screen.findByRole('heading', { name: 'Team bookings are not available in this space.' })
    expect(screen.queryByText('Team discovery call')).toBeNull()
    expect(screen.queryByText('Grace Hopper')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(1)
  })

  it('starts the list and detail over after a background switch to another team', async () => {
    const user = userEvent.setup()
    let active = TEAM
    const api = server({
      'GET /api/v1/me': () => json(200, active),
      'GET /api/auth/organization/get-active-member': () => json(200, member(active)),
      [LIST]: () =>
        json(200, {
          data: [
            teamBooking({
              eventType: {
                id: 'e0000000-0000-7000-8000-000000000001',
                title: active === TEAM ? 'Team discovery call' : 'New team meeting',
              },
            }),
          ],
          nextCursor: null,
        }),
    })
    renderApp(PAGE)
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: 'Close details' }))
    await user.click(screen.getByText('Filter bookings', { selector: 'summary' }))
    await user.selectOptions(screen.getByLabelText('Status'), 'cancelled')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(query(api.to(LIST).at(-1)?.path ?? '').status).toBe('cancelled'))
    active = OTHER_TEAM
    await act(async () => fireEvent.focus(window))
    await screen.findByRole('button', { name: 'New team meeting' })
    expect(screen.queryByText('Team discovery call')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(3)
    await user.click(titleButton('New team meeting'))
    await confirmCancellation(user)
    await screen.findByText('The booking is cancelled.')
    expect(api.to(CANCEL)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      OTHER_TEAM.organization.id,
    )
  })

  it('ignores an old pending next page after a team switch', async () => {
    const user = userEvent.setup()
    const pending = later()
    let active = TEAM
    const api = server({
      'GET /api/v1/me': () => json(200, active),
      'GET /api/auth/organization/get-active-member': () => json(200, member(active)),
      [LIST]: ({ path }) => {
        if (query(path).cursor) return pending.response
        return json(200, {
          data: [
            teamBooking({
              eventType: {
                id: 'e0000000-0000-7000-8000-000000000001',
                title: active === TEAM ? 'Team discovery call' : 'New team meeting',
              },
            }),
          ],
          nextCursor: active === TEAM ? 'old-team-next' : null,
        })
      },
    })
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'Team discovery call' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    active = OTHER_TEAM
    await act(async () => fireEvent.focus(window))
    await screen.findByRole('button', { name: 'New team meeting' })
    await pending.answer(
      json(200, {
        data: [
          teamBooking({
            id: 'b0000000-0000-7000-8000-000000000002',
            eventType: {
              id: 'e0000000-0000-7000-8000-000000000002',
              title: 'Late old team meeting',
            },
          }),
        ],
        nextCursor: null,
      }),
    )
    expect(screen.queryByText('Late old team meeting')).toBeNull()
    expect(screen.queryByText('Team discovery call')).toBeNull()
    expect(titleButton('New team meeting')).toBeDefined()
    expect(api.to(LIST)).toHaveLength(3)
  })
})

describe('team bookings list and DTO details', () => {
  it('uses the server tab ranges and default order for upcoming, past and all bookings', async () => {
    const api = server()
    const user = userEvent.setup()
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'Team discovery call' })
    expect(query(api.to(LIST)[0]?.path ?? '')).toMatchObject({ order: 'asc', limit: '25' })
    expect(query(api.to(LIST)[0]?.path ?? '').endAfter).toBeDefined()
    await user.click(screen.getByRole('link', { name: 'Past' }))
    await waitFor(() => expect(api.to(LIST)).toHaveLength(2))
    expect(query(api.to(LIST)[1]?.path ?? '')).toMatchObject({ order: 'desc', limit: '25' })
    expect(query(api.to(LIST)[1]?.path ?? '').endTo).toBeDefined()
    expect(query(api.to(LIST)[1]?.path ?? '')).not.toHaveProperty('endAfter')
    await user.click(screen.getByRole('link', { name: 'All bookings' }))
    await waitFor(() => expect(api.to(LIST)).toHaveLength(3))
    expect(query(api.to(LIST)[2]?.path ?? '')).toEqual({ order: 'asc', limit: '25' })
  })

  it('sends all server time filters and clears them explicitly', async () => {
    const api = server()
    const user = userEvent.setup()
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'Team discovery call' })
    await user.click(screen.getByText('Filter bookings', { selector: 'summary' }))
    const values: Record<string, [string, string]> = {
      from: ['Starts at or after', '2030-03-01T00:00'],
      to: ['Starts before', '2030-04-01T00:00'],
      endAfter: ['Ends after', '2030-03-01T01:00'],
      endTo: ['Ends at or before', '2030-04-01T01:00'],
    }
    for (const [label, value] of Object.values(values)) {
      fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } })
    }
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(api.to(LIST)).toHaveLength(2))
    expect(query(api.to(LIST)[1]?.path ?? '')).toEqual({
      order: 'asc',
      limit: '25',
      ...Object.fromEntries(
        Object.entries(values).map(([name, [, value]]) => [name, new Date(value).toISOString()]),
      ),
    })
    await user.click(screen.getByText('Filter bookings', { selector: 'summary' }))
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(api.to(LIST)).toHaveLength(3))
    const cleared = query(api.to(LIST)[2]?.path ?? '')
    expect(cleared).not.toHaveProperty('from')
    expect(cleared).not.toHaveProperty('to')
    expect(cleared).not.toHaveProperty('endTo')
    expect(cleared.endAfter).toBeDefined()
    expect(cleared.endAfter).not.toBe(new Date('2030-03-01T01:00').toISOString())
  })

  it('pages with exactly the same filters and order, preserving server order', async () => {
    const user = userEvent.setup()
    const api = server({
      [LIST]: ({ path }) =>
        json(200, {
          data: [
            teamBooking({
              id: query(path).cursor ? 'b0000000-0000-7000-8000-000000000002' : BOOKING_ID,
              eventType: {
                id: 'e0000000-0000-7000-8000-000000000001',
                title: query(path).cursor ? 'Second server row' : 'First server row',
              },
            }),
          ],
          nextCursor: query(path).cursor ? null : 'page-two',
        }),
    })
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'First server row' })
    await user.click(screen.getByText('Filter bookings', { selector: 'summary' }))
    await user.selectOptions(screen.getByLabelText('Status'), 'confirmed')
    await user.selectOptions(screen.getByLabelText('Order'), 'desc')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(query(api.to(LIST).at(-1)?.path ?? '').status).toBe('confirmed'))
    const first = query(api.to(LIST).at(-1)?.path ?? '')
    expect(first).toMatchObject({ order: 'desc', status: 'confirmed' })
    expect(first.cursor).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByRole('button', { name: 'Second server row' })
    expect(query(api.to(LIST).at(-1)?.path ?? '')).toEqual({ ...first, cursor: 'page-two' })
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['First server row', 'Second server row'])
    expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull()
  })

  it('retries a failed next page without losing rows or changing its cursor', async () => {
    const pending = later()
    let pages = 0
    const api = server({
      [LIST]: ({ path }) => {
        if (!query(path).cursor) return json(200, { data: [teamBooking()], nextCursor: 'page-two' })
        if (++pages === 1) return pending.response
        return json(200, { data: [], nextCursor: null })
      },
    })
    renderApp(PAGE)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Team discovery call' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    expect(titleButton()).toBeDefined()
    await pending.answer(json(500, { error: 'internal_error' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load more bookings.',
    )
    expect(titleButton()).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull(),
    )
    const calls = api.to(LIST)
    expect(calls).toHaveLength(3)
    expect(query(calls[2]?.path ?? '')).toEqual(query(calls[1]?.path ?? ''))
    expect(titleButton()).toBeDefined()
  })

  it('removes already-shown rows when the next page reports revoked access', async () => {
    const api = server({
      [LIST]: ({ path }) =>
        query(path).cursor
          ? json(403, { error: 'team_management_access_denied' })
          : json(200, { data: [teamBooking()], nextCursor: 'page-two' }),
    })
    renderApp(PAGE)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Team discovery call' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByText('Team bookings access is no longer available.')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(screen.queryByText('Grace Hopper')).toBeNull()
    expect(api.to(LIST)).toHaveLength(2)
  })

  it('renders exactly the team DTO detail fields and never asks personal endpoints', async () => {
    const poison = 'private-field-must-stay-out'
    const dto = teamBooking()
    const api = server({
      [LIST]: () =>
        json(200, {
          data: [
            {
              ...dto,
              title: poison,
              answers: { question: poison },
              location: { type: 'custom', value: poison },
              source: poison,
              conference: { status: 'ready', joinUrl: `https://example.test/${poison}` },
              calendarCopy: { status: poison },
              manageToken: poison,
              cancelReason: poison,
              hosts: dto.hosts.map((host) => ({ ...host, email: poison, calendarId: poison })),
              attendees: dto.attendees.map((attendee) => ({ ...attendee, answers: poison })),
            },
          ],
          nextCursor: null,
        }),
    })
    renderApp(PAGE)
    await openDetail()
    const panel = within(detail())
    expect(panel.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Booking ID',
      'Event',
      'Event type ID',
      'When',
      'Status',
      'Cancelled',
      'Hosts',
      'People',
    ])
    const values = panel.getAllByRole('definition')
    expect(values).toHaveLength(8)
    expect(values[0]?.textContent).toBe(dto.id)
    expect(values[1]?.textContent).toBe(dto.eventType?.title)
    expect(values[2]?.textContent).toBe(dto.eventType?.id)
    expect([...(values[3]?.querySelectorAll('time') ?? [])].map((time) => time.dateTime)).toEqual([
      dto.start,
      dto.end,
    ])
    expect(values[4]?.textContent).toBe('Confirmed')
    expect(values[5]?.textContent).toBe('Not set')
    expect(values[6]?.textContent).toContain('Historical host')
    expect(values[6]?.textContent).toContain(dto.hosts[0]?.userId)
    expect(values[7]?.textContent).toContain('Grace Hopper')
    expect(values[7]?.textContent).toContain('grace@example.com')
    expect(values[7]?.textContent).toContain('America/New York')
    expect(values[7]?.textContent).toContain('Invitee')
    expect(values[7]?.textContent).toContain('Alan Turing')
    expect(values[7]?.textContent).toContain('Guest')
    expect(document.body.textContent).not.toContain(poison)
    expect(document.querySelector(`a[href*="${poison}"]`)).toBeNull()
    expect(
      api.calls.filter(
        (call) =>
          call.path.startsWith('/api/v1/bookings') || call.path.startsWith('/api/v1/event-types'),
      ),
    ).toHaveLength(0)
    expect(api.to(LIST)).toHaveLength(1)
  })

  it('opens and closes the detail with a keyboard and returns focus to its row', async () => {
    const user = userEvent.setup()
    server()
    renderApp(PAGE)
    const opener = await screen.findByRole('button', { name: 'Team discovery call' })
    opener.focus()
    await user.keyboard('{Enter}')
    const heading = await screen.findByRole('heading', { name: 'Team booking details' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    const close = screen.getByRole('button', { name: 'Close details' })
    close.focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('shows a deleted event and cancelled timestamp without inventing fields or actions', async () => {
    const dto = teamBooking({
      status: 'cancelled',
      eventType: null,
      cancelledAt: '2029-12-04T09:00:00.000Z',
    })
    server({ [LIST]: () => json(200, { data: [dto], nextCursor: null }) })
    renderApp(PAGE)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Deleted event type' }))
    expect(within(detail()).getByText('Booking ID')).toBeDefined()
    expect(within(detail()).getAllByRole('definition')[2]?.textContent).toBe('Not set')
    expect(within(detail()).getAllByRole('definition')[5]?.querySelector('time')?.dateTime).toBe(
      dto.cancelledAt,
    )
    expect(screen.queryByRole('button', { name: 'Cancel booking…' })).toBeNull()
    expect(screen.queryByRole('link', { name: /reschedule/i })).toBeNull()
  })
})

describe('team booking cancellation', () => {
  it('uses the confirmation pattern and binds the write to the page organization', async () => {
    const api = server()
    renderApp(PAGE)
    const user = await openDetail()
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    const reason = screen.getByLabelText(/Reason/)
    await waitFor(() => expect(document.activeElement).toBe(reason))
    await user.click(screen.getByRole('button', { name: 'Keep booking' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel booking…' })),
    )
    expect(api.to(CANCEL)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'Schedule changed')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByText('The booking is cancelled.')
    expect(api.to(CANCEL)).toHaveLength(1)
    expect(api.to(CANCEL)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM.organization.id)
    expect(api.to(CANCEL)[0]?.body).toEqual({ reason: 'Schedule changed' })
    expect(screen.queryByRole('button', { name: 'Cancel booking…' })).toBeNull()
  })

  it('offers reload on context drift and never replays the write against a new team', async () => {
    let active = TEAM
    const api = server({
      'GET /api/v1/me': () => json(200, active),
      'GET /api/auth/organization/get-active-member': () => json(200, member(active)),
      [CANCEL]: () => json(409, { error: 'organization_context_changed' }),
      [LIST]: () =>
        json(200, {
          data: active === TEAM ? [teamBooking()] : [],
          nextCursor: active === TEAM ? 'original-team-page' : null,
        }),
    })
    renderApp(PAGE)
    const user = await openDetail()
    await user.click(screen.getByText('Filter bookings', { selector: 'summary' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'Original team reason')
    active = OTHER_TEAM
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your team context changed. Reload before making changes.',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel booking' }).disabled).toBe(
      true,
    )
    expect(api.to(CANCEL)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM.organization.id)
    expect(api.to(CANCEL)).toHaveLength(1)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const readsBeforeReload = api.to(LIST).length
    for (const name of ['Show more bookings', 'Apply filters', 'Clear filters']) {
      const control = screen.getByRole('button', { name })
      expect(control.matches(':disabled')).toBe(true)
      await user.click(control)
    }
    const past = screen.getByRole('link', { name: 'Past' })
    expect(past.getAttribute('aria-disabled')).toBe('true')
    await user.click(past)
    expect(screen.getByTestId('location').textContent).toBe(PAGE)
    expect(api.to(LIST)).toHaveLength(readsBeforeReload)
    expect(api.to(CANCEL)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('main')).getByText(OTHER_TEAM.organization.name),
      ).toBeDefined(),
    )
    expect(screen.queryByText('Team discovery call')).toBeNull()
    expect(screen.queryByDisplayValue('Original team reason')).toBeNull()
    expect(api.to(CANCEL)).toHaveLength(1)
  })

  it('keeps context-conflict recovery when leaving and reopening team bookings', async () => {
    let actualTeam = TEAM
    const api = server({
      'GET /api/v1/me': () => json(200, actualTeam),
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
      [LIST]: () =>
        json(200, {
          data: [
            teamBooking({
              eventType: {
                id: 'e0000000-0000-7000-8000-000000000001',
                title: actualTeam === TEAM ? 'Team discovery call' : 'Another team private meeting',
              },
            }),
          ],
          nextCursor: null,
        }),
      [CANCEL]: () => json(409, { error: 'organization_context_changed' }),
    })
    renderApp(PAGE)
    const user = await openDetail()
    actualTeam = OTHER_TEAM
    await confirmCancellation(user)
    await screen.findByRole('button', { name: 'Reload' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByRole('heading', { name: 'Bookings', level: 1 })
    await user.click(screen.getByRole('link', { name: 'Team bookings' }))
    await screen.findByRole('heading', { name: 'Team bookings', level: 1 })
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain(
      'Your team context changed. Reload before making changes.',
    )
    expect(within(screen.getByRole('main')).getByText(TEAM.organization.name)).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('Another team private meeting')).toBeNull()
    expect(api.to(LIST)).toHaveLength(1)
    expect(api.to(CANCEL)).toHaveLength(1)
  })

  it('discards a pending next page when cancellation refreshes the current booking', async () => {
    const pending = later()
    let cancelled = false
    const current = teamBooking()
    const api = server({
      [LIST]: ({ path }) =>
        query(path).cursor
          ? pending.response
          : json(200, {
              data: [
                cancelled
                  ? { ...current, status: 'cancelled', cancelledAt: '2029-12-04T09:00:00.000Z' }
                  : current,
              ],
              nextCursor: cancelled ? null : 'page-two',
            }),
      [CANCEL]: () => {
        cancelled = true
        return json(200, { cancelled: true })
      },
    })
    renderApp(PAGE)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Team discovery call' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await openDetail(user)
    await confirmCancellation(user)
    await waitFor(() => expect(titleButton().closest('tr')?.textContent).toContain('Cancelled'))
    await pending.answer(
      json(200, {
        data: [
          teamBooking({
            id: 'b0000000-0000-7000-8000-000000000002',
            eventType: { id: 'e0000000-0000-7000-8000-000000000002', title: 'Stale next page row' },
          }),
        ],
        nextCursor: null,
      }),
    )
    expect(screen.queryByText('Stale next page row')).toBeNull()
    expect(titleButton().closest('tr')?.textContent).toContain('Cancelled')
    expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(3)
  })

  it('rechecks the start time before submitting an already-open cancellation form', async () => {
    const api = server()
    renderApp(PAGE)
    const user = await openDetail()
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    vi.spyOn(Date, 'now').mockReturnValue(new Date(teamBooking().start).getTime() + 1000)
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByText(/This booking has already started, so it can no longer be cancelled/)
    expect(api.to(CANCEL)).toHaveLength(0)
    expect(screen.getByRole('link', { name: 'Team bookings' })).toBeDefined()
    expect(screen.queryByText('Team bookings access is no longer available.')).toBeNull()
  })

  it('clears booking data and provides a way out when cancellation returns 403', async () => {
    let role = 'owner'
    const api = server({
      'GET /api/auth/organization/get-active-member': () => json(200, member(TEAM, role)),
      [CANCEL]: () => {
        role = 'member'
        return json(403, { error: 'team_management_access_denied' })
      },
    })
    renderApp(PAGE)
    const user = await openDetail()
    await confirmCancellation(user)
    await screen.findByText('Team bookings access is no longer available.')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(screen.queryByText('Grace Hopper')).toBeNull()
    expect(screen.getByRole('link', { name: 'Go to your bookings' }).getAttribute('href')).toBe(
      '/app/bookings',
    )
    expect(api.to(CANCEL)).toHaveLength(1)
  })
})

describe('team bookings states and translations', () => {
  it('shows loading, a failed request and a working retry', async () => {
    const pending = later()
    let reads = 0
    const api = server({
      [LIST]: () =>
        ++reads === 1 ? pending.response : json(200, { data: [teamBooking()], nextCursor: null }),
    })
    renderApp(PAGE)
    expect(await screen.findByText('Loading team bookings…')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
    await pending.answer(json(500, { error: 'internal_error' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load team bookings.',
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('button', { name: 'Team discovery call' })
    expect(api.to(LIST)).toHaveLength(2)
  })

  it('shows a revoked state on a 403 list response, including unverified identities', async () => {
    const api = server({ [LIST]: () => json(403, { error: 'team_management_access_denied' }) })
    renderApp(PAGE)
    await screen.findByText('Team bookings access is no longer available.')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('Grace Hopper')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Go to your bookings' }).getAttribute('href')).toBe(
      '/app/bookings',
    )
    expect(api.to(LIST)).toHaveLength(1)
  })

  it('translates loading, failure, detail, cancellation conflict and revoked recovery into Chinese', async () => {
    chooseLanguage('zh-CN')
    const pending = later()
    let reads = 0
    const api = server({
      ...profile({ ...PROFILE, locale: 'zh-CN' }),
      [LIST]: () => {
        reads += 1
        if (reads === 1) return pending.response
        return reads === 2
          ? json(200, { data: [teamBooking()], nextCursor: null })
          : json(403, { error: 'team_management_access_denied' })
      },
      [CANCEL]: () => json(409, { error: 'organization_context_changed' }),
    })
    renderApp(PAGE)
    await screen.findByRole('status', { name: '正在加载团队预约…' })
    await pending.answer(json(500, { error: 'internal_error' }))
    expect((await screen.findByRole('alert')).textContent).toContain('无法加载团队预约。')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    const panel = within(screen.getByRole('region', { name: '团队预约详情' }))
    expect(panel.getAllByRole('term').map((term) => term.textContent)).toEqual([
      '预约ID',
      '活动',
      '活动类型ID',
      '时间',
      '状态',
      '已取消',
      '主持人',
      '人员',
    ])
    expect(panel.getByRole('button', { name: '关闭详情' })).toBeDefined()
    await user.click(panel.getByRole('button', { name: '取消预约…' }))
    await user.type(screen.getByLabelText(/原因/), '团队安排变化')
    expect(screen.getByRole('button', { name: '保留预约' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '取消预约' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      '你的团队上下文已改变。请重新加载后再进行修改。',
    )
    expect(api.to(CANCEL)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM.organization.id)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByRole('heading', { name: '团队预约访问权限已失效。' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('Team discovery call')).toBeNull()
    expect(screen.queryByRole('link', { name: '团队预约' })).toBeNull()
    expect(screen.getByRole('link', { name: '前往本人的预约' }).getAttribute('href')).toBe(
      '/app/bookings',
    )
    expect(api.to(CANCEL)).toHaveLength(1)
  })

  it.each([
    ['en', 'Team bookings', 'No team bookings match these filters.'],
    ['zh-CN', '团队预约', '没有符合筛选条件的团队预约。'],
  ] as const)('translates the page and empty state in %s', async (locale, heading, empty) => {
    chooseLanguage(locale)
    server({
      ...profile({ ...PROFILE, locale }),
      [LIST]: () => json(200, { data: [], nextCursor: null }),
    })
    renderApp(PAGE)
    expect(await screen.findByText(empty)).toBeDefined()
    expect(screen.getByRole('heading', { name: heading, level: 1 })).toBeDefined()
    expect(screen.getByRole('link', { name: heading })).toBeDefined()
  })
})
