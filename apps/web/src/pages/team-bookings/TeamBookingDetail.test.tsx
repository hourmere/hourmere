import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { loadProfile } from '../../api/resources.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { RequireSession, SessionProvider } from '../../session.tsx'
import { TeamManagementProvider } from '../../team-management.tsx'
import {
  type Routes as ApiRoutes,
  fakeApi,
  json,
  ME,
  profile,
  signedInAs,
} from '../../test/fake-api.tsx'
import { hostZone } from '../bookings/booking-format.ts'
import { TeamBookingDetailPage } from './TeamBookingDetail.tsx'

const ID = 'b0000000-0000-7000-8000-000000000001'
const GET = `GET /api/v1/team/bookings/${ID}`
const CANCEL = `POST /api/v1/team/bookings/${ID}/cancel`
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: { ...ME.organization, personal: false, name: 'Research team' },
}
const BOOKING: Schemas['TeamAdminBooking'] = {
  id: ID,
  status: 'confirmed',
  isRescheduled: false,
  start: '2030-03-04T09:00:00.000Z',
  end: '2030-03-04T09:30:00.000Z',
  cancelledAt: null,
  eventType: {
    id: 'e0000000-0000-7000-8000-000000000001',
    title: 'Research consultation',
    publicBookingPath: null,
  },
  hosts: [{ userId: ID, name: 'Saved host', timeZone: 'UTC', isCurrentMember: true }],
  attendees: [{ name: 'Grace', email: 'grace@example.com', timeZone: 'UTC', isBooker: true }],
}

function server(overrides: ApiRoutes = {}) {
  return fakeApi({
    ...signedInAs(TEAM),
    ...profile(),
    [GET]: () => json(200, BOOKING),
    ...overrides,
  })
}

function open() {
  return render(
    <MemoryRouter initialEntries={[`/app/bookings/${ID}`]}>
      <InterfaceScope surface="admin">
        <SessionProvider>
          <Routes>
            <Route element={<RequireSession />}>
              <Route
                path="/app/bookings/:id"
                element={
                  <TeamManagementProvider>
                    <TeamBookingDetailPage id={ID} />
                  </TeamManagementProvider>
                }
              />
            </Route>
          </Routes>
        </SessionProvider>
      </InterfaceScope>
    </MemoryRouter>,
  )
}

describe('team admin booking detail', () => {
  it('lets team administrators mark an attendee after the scheduled start', async () => {
    const route = `PATCH /api/v1/bookings/${ID}/attendees/${ID}/no-show`
    const api = server({
      [GET]: () =>
        json(200, {
          ...BOOKING,
          start: '2020-01-01T00:00:00Z',
          canManageNoShow: true,
          attendees: [{ ...BOOKING.attendees[0], id: ID }],
        }),
      [route]: () =>
        json(200, {
          attendeeId: ID,
          noShowMarkedAt: '2020-01-01T00:01:00Z',
          noShowMarkedBy: ME.user.id,
        }),
    })
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Mark Grace as a no-show' }))
    expect(screen.getByRole('button', { name: 'Clear no-show for Grace' })).toBeDefined()
    expect(api.to(route)[0]?.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
  })

  it('loads only the minimal admin detail with the opening team protection', async () => {
    const api = server()
    open()
    const detail = await screen.findByRole('region', { name: 'Team booking details' })
    expect(within(detail).getByText('Research consultation')).toBeDefined()
    expect(within(detail).getByText('Saved host')).toBeDefined()
    expect(within(detail).getByRole('link', { name: 'grace@example.com' })).toBeDefined()
    expect(api.to(GET)).toHaveLength(1)
    expect(api.to(GET)[0]?.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
    expect(screen.queryByRole('button', { name: /Reschedule/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(api.calls.some((call) => call.path.startsWith('/api/v1/bookings/'))).toBe(false)
  })

  it.each([400, 403, 404])('shows uniform missing detail after a %s response', async (status) => {
    const api = server({ [GET]: () => json(status, { error: 'booking_not_found' }) })
    open()
    await screen.findByRole('heading', { name: 'Booking not found' })
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('shows context recovery before rendering a stale team booking', async () => {
    server({ [GET]: () => json(409, { error: 'organization_context_changed' }) })
    open()
    await screen.findByText('Your team context changed. Reload before making changes.')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
    expect(screen.queryByText('Research consultation')).toBeNull()
  })

  it('keeps a failed read retryable without presenting missing configuration', async () => {
    let attempts = 0
    server({
      [GET]: () => (++attempts === 1 ? json(500, { error: 'internal_error' }) : json(200, BOOKING)),
    })
    open()
    await screen.findByRole('alert')
    expect(screen.queryByRole('heading', { name: 'Booking not found' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Research consultation')
  })

  it('cancels through the team action and refreshes only the limited projection', async () => {
    let current = BOOKING
    const api = server({
      [GET]: () => json(200, current),
      [CANCEL]: () => {
        current = { ...BOOKING, status: 'cancelled', cancelledAt: '2026-11-01T12:00:00.000Z' }
        return json(200, { cancelled: true })
      },
    })
    open()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await waitFor(() => expect(api.to(GET)).toHaveLength(2))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel booking…' })).toBeNull(),
    )
    expect(api.to(CANCEL)[0]?.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
  })

  function sourceCopy(change?: [string, string]) {
    const source = readFileSync('apps/web/src/pages/team-bookings/TeamBookingDetail.tsx', 'utf8')
    const start = source.indexOf('async function loadTeamBookingDetail(')
    let copied = source.slice(start, source.indexOf('/** Email deep links', start))
    if (change) {
      expect(copied).toContain(change[0])
      copied = copied.replace(...change)
    }
    const bindings = {
      api,
      unwrap,
      loadProfile,
      hostZone,
      isOrganizationContextChanged,
      RequestError,
    }
    return new Function(
      ...Object.keys(bindings),
      `${stripTypeScriptTypes(copied)}; return loadTeamBookingDetail`,
    )(...Object.values(bindings)) as (
      id: string,
      expectedOrganizationId: string,
      signal: AbortSignal,
    ) => Promise<{ kind: string }>
  }

  async function verifyExpectedTeam(load: ReturnType<typeof sourceCopy>) {
    const calls = server()
    expect((await load(ID, TEAM.organization.id, new AbortController().signal)).kind).toBe(
      'booking',
    )
    expect(calls.to(GET)[0]?.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
  }

  it('detects missing detail context protection in a source copy with a real assertion failure', async () => {
    await verifyExpectedTeam(sourceCopy())
    const mutant = sourceCopy([
      "header: { 'x-expected-organization-id': expectedOrganizationId },",
      '',
    ])
    await expect(verifyExpectedTeam(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
