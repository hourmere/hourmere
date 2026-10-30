import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { admin } from '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { registerCatalog } from '../../i18n/translate.ts'
import { fakeApi, json, later, type Routes } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { EVENT } from '../../test/public-fixtures.ts'
import { ManualRebooking } from './ManualRebooking.tsx'

registerCatalog(admin)

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const EVENT_ID = 'e0000000-0000-7000-8000-000000000001'
const EVENT_ROUTE = `GET /api/v1/event-types/${EVENT_ID}`
const PUBLIC_ROUTE = 'GET /api/v1/public/teams/Research-Team/intro-call'
const session = vi.hoisted(() => ({
  me: {
    organization: {
      id: '00000000-0000-7000-8000-000000000010',
      slug: 'Research-Team',
      personal: false,
    },
  },
}))
vi.mock('../../session.tsx', () => ({ useMe: () => session.me }))

const UNAVAILABLE =
  'The public booking page is unavailable. Ask an admin to repair and reactivate the event, or create a new event, before the guest books again.'
const PAGE_FAILURE = 'Could not confirm whether the public booking page is available. Try again.'

function booking(
  overrides: Partial<Schemas['TeamAdminBooking']> = {},
): Schemas['TeamAdminBooking'] {
  return {
    id: 'b0000000-0000-7000-8000-000000000001',
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T09:30:00.000Z',
    status: 'confirmed',
    cancelledAt: null,
    eventType: { id: EVENT_ID, title: 'Team discovery call' },
    hosts: [{ userId: 'a0000000-0000-7000-8000-000000000001', name: 'Departed host' }],
    attendees: [],
    ...overrides,
  }
}

const publicPage = () => ({
  ...EVENT,
  handle: 'Research-Team',
  slug: 'intro-call',
  team: { name: 'Research team', slug: 'Research-Team' },
})

function server(overrides: Routes = {}) {
  return fakeApi({
    [EVENT_ROUTE]: () => json(200, eventType({ organizationId: TEAM_ID, ownerUserId: null })),
    [PUBLIC_ROUTE]: () => json(200, publicPage()),
    ...overrides,
  })
}

function panel(value = booking(), expectedOrganizationId = TEAM_ID) {
  return render(
    <ManualRebooking booking={value} expectedOrganizationId={expectedOrganizationId} />,
    {
      wrapper: ({ children }) => <InterfaceScope surface="admin">{children}</InterfaceScope>,
    },
  )
}

beforeEach(() => {
  session.me.organization = { id: TEAM_ID, slug: 'Research-Team', personal: false }
})

describe('manual team booking replacement', () => {
  it('shows conditional departed-host guidance and ordered steps before looking up a page', () => {
    const api = server()
    panel()
    expect(screen.getByRole('heading', { name: 'Book again with another host' })).toBeDefined()
    expect(
      screen.getByText(
        'If a host has left the team, this booking cannot be rescheduled. Hourmere does not automatically assign another host.',
      ),
    ).toBeDefined()
    const steps = screen.getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual([
      'An admin cancels this booking here before it starts.',
      'Then ask the guest to book again from the event’s public booking page.',
    ])
    expect(steps[0]?.parentElement?.tagName).toBe('OL')
    expect(screen.getByRole('button', { name: 'Find public booking page' })).toBeDefined()
    expect(api.calls).toEqual([])
  })

  it('shows the completed cancellation step for an already cancelled booking', () => {
    server()
    panel(booking({ status: 'cancelled', cancelledAt: '2026-10-29T09:00:00.000Z' }))
    expect(screen.getAllByRole('listitem')[0]?.textContent).toBe(
      'This booking is already cancelled. Continue with the next step.',
    )
  })

  it('directs a started booking to wait or coordinate offline', () => {
    server()
    panel(booking({ start: '2020-03-04T09:00:00.000Z' }))
    expect(screen.getAllByRole('listitem')[0]?.textContent).toBe(
      'This booking has already started. Wait until it ends or coordinate with the hosts offline.',
    )
    expect(screen.queryByText('An admin cancels this booking here before it starts.')).toBeNull()
  })

  it.each([null, { id: EVENT_ID, title: null }])(
    'explains rebooking recovery when the event association is %j',
    (event) => {
      const api = server()
      panel(booking({ eventType: event }))
      expect(screen.getByText(UNAVAILABLE)).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Find public booking page' })).toBeNull()
      expect(api.calls).toEqual([])
    },
  )

  it('verifies the team event and public page before offering its case-preserving safe link', async () => {
    const api = server()
    const user = userEvent.setup()
    panel()
    await user.click(screen.getByRole('button', { name: 'Find public booking page' }))
    const link = await screen.findByRole('link', { name: 'Open public booking page' })
    expect(link.getAttribute('href')).toBe(
      `${window.location.origin}/team/Research-Team/intro-call`,
    )
    expect(api.to(EVENT_ROUTE)).toHaveLength(1)
    expect(api.to(PUBLIC_ROUTE)).toHaveLength(1)
    expect(api.calls).toHaveLength(2)
  })

  it.each([
    { organizationId: '00000000-0000-7000-8000-000000000020' },
    { ownerUserId: '00000000-0000-7000-8000-000000000001' },
    { id: 'e0000000-0000-7000-8000-000000000002' },
    { isActive: false },
  ])('refuses unsuitable event metadata %j before a public request', async (override) => {
    const api = server({
      [EVENT_ROUTE]: () =>
        json(200, eventType({ organizationId: TEAM_ID, ownerUserId: null, ...override })),
    })
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
    await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).not.toBeNull())
    expect(screen.queryByRole('link')).toBeNull()
    expect(api.to(PUBLIC_ROUTE)).toHaveLength(0)
  })

  it.each([EVENT_ROUTE, PUBLIC_ROUTE])(
    'explains an absent public page after %s returns 404',
    async (route) => {
      server({ [route]: () => json(404, { error: 'event_type_not_found' }) })
      panel()
      await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
      await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).not.toBeNull())
      expect(screen.queryByRole('link')).toBeNull()
    },
  )

  it('allows retry after an unconfirmed lookup without declaring the event deleted', async () => {
    let unavailable = true
    const api = server({
      [PUBLIC_ROUTE]: () =>
        unavailable ? json(500, { error: 'internal_error' }) : json(200, publicPage()),
    })
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
    await screen.findByText(PAGE_FAILURE)
    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    unavailable = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('link', { name: 'Open public booking page' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.to(PUBLIC_ROUTE)).toHaveLength(2)
  })

  it('suppresses a second page lookup while the first is pending', async () => {
    const pending = later()
    const api = server({ [EVENT_ROUTE]: () => pending.response })
    panel()
    const button = screen.getByRole('button', { name: 'Find public booking page' })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    await waitFor(() => expect(api.to(EVENT_ROUTE)).toHaveLength(1))
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await pending.answer(json(200, eventType({ organizationId: TEAM_ID, ownerUserId: null })))
    await screen.findByRole('link', { name: 'Open public booking page' })
    expect(api.to(PUBLIC_ROUTE)).toHaveLength(1)
  })

  it('does not continue a lookup after the detail is closed', async () => {
    const pending = later()
    const api = server({ [EVENT_ROUTE]: () => pending.response })
    const view = panel()
    await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
    await waitFor(() => expect(api.to(EVENT_ROUTE)).toHaveLength(1))
    view.unmount()
    await pending.answer(json(200, eventType({ organizationId: TEAM_ID, ownerUserId: null })))
    expect(api.to(PUBLIC_ROUTE)).toHaveLength(0)
  })

  it('does not retain a previous booking’s public page when its event changes', async () => {
    server()
    const view = panel()
    await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
    await screen.findByRole('link', { name: 'Open public booking page' })
    view.rerender(
      <ManualRebooking
        booking={booking({
          eventType: {
            id: 'e0000000-0000-7000-8000-000000000002',
            title: 'Another event',
          },
        })}
        expectedOrganizationId={TEAM_ID}
      />,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button', { name: 'Find public booking page' })).toBeDefined()
  })

  it('discards a late answer when the current team changes', async () => {
    const pending = later()
    const api = server({ [PUBLIC_ROUTE]: () => pending.response })
    const value = booking()
    const view = panel(value)
    await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
    await waitFor(() => expect(api.to(PUBLIC_ROUTE)).toHaveLength(1))
    session.me.organization = {
      id: '00000000-0000-7000-8000-000000000020',
      slug: 'Other-Team',
      personal: false,
    }
    view.rerender(<ManualRebooking booking={value} expectedOrganizationId={TEAM_ID} />)
    await pending.answer(json(200, publicPage()))
    expect(screen.queryByRole('link')).toBeNull()
    expect(
      screen.queryByText('Your team context changed. Reload before making changes.'),
    ).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([{ handle: 'Other-Team' }, { slug: 'other-event' }, { team: undefined }])(
    'rejects a mismatched public-page response %j',
    async (override) => {
      server({ [PUBLIC_ROUTE]: () => json(200, { ...publicPage(), ...override }) })
      panel()
      await userEvent.click(screen.getByRole('button', { name: 'Find public booking page' }))
      await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).not.toBeNull())
      expect(screen.queryByRole('link')).toBeNull()
    },
  )

  it.each([true, false])(
    'retains keyboard focus on the lookup button after availability is %s',
    async (available) => {
      server({
        [PUBLIC_ROUTE]: () =>
          available ? json(200, publicPage()) : json(404, { error: 'event_type_not_found' }),
      })
      const user = userEvent.setup()
      panel()
      await user.tab()
      const button = screen.getByRole('button', { name: 'Find public booking page' })
      expect(document.activeElement).toBe(button)
      await user.keyboard('{Enter}')
      await waitFor(() => {
        expect(button.textContent).toBe('Check public booking page again')
      })
      expect(document.activeElement).toBe(button)
      expect(button.isConnected).toBe(true)
      const result = screen.getByRole('status')
      expect(result.textContent).toBe(available ? 'Open public booking page' : UNAVAILABLE)
    },
  )
})
