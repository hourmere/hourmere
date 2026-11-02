import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import type { Me } from '../../session.tsx'
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
import { BOOKING_ID, booking } from '../../test/fixtures.ts'

const team: Me = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-0000000000b1',
    name: 'Meeting team',
    slug: 'meeting-team',
    personal: false,
  },
}
const otherTeam: Me = {
  ...ME,
  organization: {
    ...team.organization,
    id: '00000000-0000-7000-8000-0000000000b2',
    name: 'Other team',
    slug: 'other-team',
  },
}
const detail = `/app/bookings/${BOOKING_ID}`
const emailLink = `${detail}?organizationId=${team.organization.id}`
const coHosts = [{ name: 'Berta Berlin' }, { name: 'Theo Tokyo' }]

function server(initial: Me, extra: Routes = {}, member = true) {
  let active = initial
  const api = fakeApi({
    ...signedInAs(initial),
    ...profile(),
    'GET /api/v1/me': () => json(200, active),
    'GET /api/auth/organization/list': () =>
      json(200, member ? [team.organization, otherTeam.organization] : [otherTeam.organization]),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { organizationId: active.organization.id, userId: ME.user.id, role: 'member' }),
    'POST /api/auth/organization/set-active': ({ body }) => {
      const target = (body as { organizationId: string | null }).organizationId
      active = target === null ? ME : target === team.organization.id ? team : otherTeam
      return json(200, active.organization.personal ? null : active.organization)
    },
    [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
      active.organization.id === team.organization.id
        ? json(200, booking({ eventTypeId: null, coHosts }))
        : json(404, { error: 'booking_not_found' }),
    ...extra,
  })
  return { ...api, active: () => active, switchServer: (me: Me) => (active = me) }
}

describe('host booking mail links', () => {
  it.each([
    ['personal space', ME],
    ['another team', otherTeam],
  ] as const)('switches from %s to the booking team before loading it', async (_name, initial) => {
    const api = server(initial)
    renderApp(emailLink)
    const people = await screen.findByRole('region', { name: 'People' })
    expect(within(people).getByText(/Berta Berlin/)).toBeDefined()
    expect(api.active().organization.id).toBe(team.organization.id)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    const change = api.to('POST /api/auth/organization/set-active')[0]
    expect(change?.body).toEqual({ organizationId: team.organization.id })
    expect(change?.headers.get('X-Expected-Organization-Id')).toBe(initial.organization.id)
    expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(1)
    expect(screen.getByTestId('location').textContent).toBe(detail)
    expect(screen.queryByRole('heading', { name: 'Booking not found' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Switch space Meeting team/ })).toBeDefined()
  })

  it('does not repeat the handoff when already in the linked space', async () => {
    const api = server(team)
    renderApp(emailLink)
    await screen.findByRole('region', { name: 'People' })
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    expect(screen.getByTestId('location').textContent).toBe(detail)
  })

  it('opens a personal booking link from a team through the personal context', async () => {
    const api = server(team, {
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(200, booking({ eventTypeId: null })),
    })
    renderApp(`${detail}?organizationId=${ME.personalOrganizationId}`)
    await screen.findByRole('region', { name: 'People' })
    expect(api.to('POST /api/auth/organization/set-active')[0]?.body).toEqual({
      organizationId: null,
    })
    expect(api.active().organization.id).toBe(ME.personalOrganizationId)
  })

  it('keeps the same missing response for a non-member without switching or reading bookings', async () => {
    const api = server(otherTeam, {}, false)
    renderApp(emailLink)
    await screen.findByRole('heading', { name: 'Booking not found' })
    expect(
      screen.getByText('This booking does not exist, or it is not one of yours.'),
    ).toBeDefined()
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(0)
    expect(api.active().organization.id).toBe(otherTeam.organization.id)
    expect(screen.queryByText('Berta Berlin')).toBeNull()
  })

  it('keeps the same missing response for a team member who does not host the booking', async () => {
    const api = server(ME, {
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(404, { error: 'booking_not_found' }),
    })
    renderApp(emailLink)
    await screen.findByRole('heading', { name: 'Booking not found' })
    expect(
      screen.getByText('This booking does not exist, or it is not one of yours.'),
    ).toBeDefined()
    expect(api.active().organization.id).toBe(team.organization.id)
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull()
  })

  it('does not switch after the link page has been left while memberships load', async () => {
    const memberships = later()
    const api = server(ME, {
      'GET /api/auth/organization/list': () => memberships.response,
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    })
    renderApp(emailLink)
    await waitFor(() => expect(api.to('GET /api/auth/organization/list').length).toBeGreaterThan(0))
    await userEvent.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    await memberships.answer(json(200, [team.organization]))
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    expect(api.active().organization.id).toBe(ME.organization.id)
  })

  it('does not load booking details before the selected context is confirmed', async () => {
    const switched = later()
    const api = server(ME, { 'POST /api/auth/organization/set-active': () => switched.response })
    renderApp(emailLink)
    await waitFor(() => expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1))
    expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(0)
    await switched.answer(json(403, { code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' }))
    await screen.findByRole('heading', { name: 'Booking not found' })
    expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(0)
  })

  it.each([200, 500])(
    'reconciles a possibly committed switch after leaving during the POST, with response %s',
    async (status) => {
      const pending = later()
      const api = server(ME, {
        'POST /api/auth/organization/set-active': () => pending.response,
        'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
      })
      // Model the browser aborting a fetch while the server may still finish its write.
      const scriptedFetch = globalThis.fetch
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = input instanceof Request ? input.signal : init?.signal
        if (String(input) !== '/api/auth/organization/set-active' || !signal)
          return scriptedFetch(input, init)
        return new Promise<Response>((resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', abort, { once: true })
          void scriptedFetch(input, init).then(
            (response) => {
              signal.removeEventListener('abort', abort)
              resolve(response)
            },
            (error: unknown) => {
              signal.removeEventListener('abort', abort)
              reject(error)
            },
          )
        })
      })
      renderApp(emailLink)
      await waitFor(() => expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1))
      await userEvent.click(screen.getByRole('link', { name: 'Bookings' }))
      await screen.findByText('No upcoming bookings.')
      api.switchServer(team)
      await pending.answer(json(status, status === 200 ? team.organization : { error: 'unknown' }))
      await screen.findByRole('button', { name: /^Switch space Meeting team/ })
      expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
      expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(0)
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    },
  )

  it('reconciles a committed switch after leaving during confirmation', async () => {
    const confirmation = later()
    let reads = 0
    const api = server(ME, {
      'GET /api/v1/me': () => (++reads === 2 ? confirmation.response : json(200, api.active())),
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    })
    renderApp(emailLink)
    await waitFor(() => expect(reads).toBe(2))
    await userEvent.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    await confirmation.answer(json(200, team))
    await screen.findByRole('button', { name: /^Switch space Meeting team/ })
    expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
    expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(0)
  })

  it('keeps a newer deliberate space switch when a previous link handoff finishes late', async () => {
    const pending = later()
    let switches = 0
    const api = server(ME, {
      'POST /api/auth/organization/set-active': ({ body }) => {
        const target = (body as { organizationId: string }).organizationId
        api.switchServer(target === team.organization.id ? team : otherTeam)
        return ++switches === 1 ? pending.response : json(200, api.active().organization)
      },
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    })
    renderApp(emailLink)
    await waitFor(() => expect(switches).toBe(1))
    await userEvent.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    await userEvent.click(screen.getByRole('button', { name: /^Switch space/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /^Other team/ }))
    await screen.findByRole('button', { name: /^Switch space Other team/ })
    await pending.answer(json(200, team.organization))
    expect(screen.getByRole('button', { name: /^Switch space Other team/ })).toBeDefined()
    expect(api.active().organization.id).toBe(otherTeam.organization.id)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(2)
    expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
  })

  it('keeps details hidden when the server does not confirm the selected space', async () => {
    const api = server(ME, {
      'POST /api/auth/organization/set-active': () => json(200, team.organization),
    })
    renderApp(emailLink)
    await screen.findByRole('alert')
    expect(screen.getByText(/Could not load the booking/)).toBeDefined()
    expect(api.to(`GET /api/v1/bookings/${BOOKING_ID}`)).toHaveLength(0)
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(3))
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull()
  })
})

describe('host booking co-hosts', () => {
  it.each([
    ['en', 'People', 'Co-hosts'],
    ['zh-CN', '人员', '共同主持人'],
  ] as const)('shows the other booked hosts by name only in %s', async (locale, heading, label) => {
    chooseLanguage(locale)
    server(team)
    renderApp(detail)
    const people = await screen.findByRole('region', { name: heading })
    const term = within(people).getByText(label, { selector: 'dt' })
    expect(term.nextElementSibling?.textContent).toContain('Berta Berlin')
    expect(term.nextElementSibling?.textContent).toContain('Theo Tokyo')
    expect(term.nextElementSibling?.querySelector('a')).toBeNull()
    expect(within(people).getAllByRole('link')).toHaveLength(1)
  })

  it('keeps co-host names after a cancellation response omits host metadata', async () => {
    server(team, {
      [`POST /api/v1/bookings/${BOOKING_ID}/cancel`]: () =>
        json(200, booking({ eventTypeId: null, status: 'cancelled' })),
    })
    renderApp(detail)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByText('The booking is cancelled.')
    const people = screen.getByRole('region', { name: 'People' })
    expect(within(people).getByText(/Berta Berlin/)).toBeDefined()
  })

  it('omits the co-host row for single-host and round-robin bookings', async () => {
    server(team, {
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
        json(200, booking({ eventTypeId: null, assignedHost: { name: 'Ada', timeZone: 'UTC' } })),
    })
    renderApp(detail)
    const people = await screen.findByRole('region', { name: 'People' })
    expect(
      within(people)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['Invitee', 'Guests'])
  })
})
