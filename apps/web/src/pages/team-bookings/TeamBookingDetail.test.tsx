import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
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
const HANDOFF_PREVIEW = `GET /api/v1/team/bookings/${ID}/handoff-preview`
const OFFER_ID = 'b0000000-0000-7000-8000-000000000002'
const OFFERS = `/api/v1/team/bookings/${ID}/handoff-offers`
const HANDOFF_CREATE = `POST ${OFFERS}`
const HANDOFF_STATUS = `GET ${OFFERS}/${OFFER_ID}`
const HANDOFF_APPLY = `POST ${OFFERS}/${OFFER_ID}/apply`
const HANDOFF_RESEND = `POST ${OFFERS}/${OFFER_ID}/resend`
const HANDOFF_WITHDRAW = `POST ${OFFERS}/${OFFER_ID}/withdraw`
const REPLACEMENT_ID = 'b0000000-0000-7000-8000-000000000003'
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
    expect(screen.queryByRole('region', { name: 'Booking handoff' })).toBeNull()
    expect(api.to(HANDOFF_PREVIEW)).toHaveLength(0)
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

describe('team booking handoff', () => {
  const preview = {
    candidateName: 'Replacement host name',
    start: BOOKING.start,
    end: BOOKING.end,
    evaluatedAt: '2030-03-01T01:00:00Z',
    availability: 'available',
    locationKind: 'zoom',
  } as const
  const offer = {
    id: OFFER_ID,
    version: 3,
    expiresAt: '2030-03-02T00:00:00Z',
  }
  const bookerId = '00000000-0000-7000-8000-000000000020'
  const guestId = '00000000-0000-7000-8000-000000000021'
  const bookerRecipientId = '00000000-0000-7000-8000-000000000030'
  const guestRecipientId = '00000000-0000-7000-8000-000000000031'
  const handoffBooking = {
    ...BOOKING,
    departureHandoffEnabled: true,
    attendees: [
      { ...BOOKING.attendees[0], id: bookerId },
      {
        id: guestId,
        name: 'Private guest',
        email: 'guest@example.com',
        timeZone: 'UTC',
        isBooker: false,
      },
    ],
  }
  const approved: Schemas['DepartureHandoffProposal'] = {
    ...offer,
    state: 'live',
    recipients: [
      {
        id: bookerRecipientId,
        attendeeIds: [bookerId],
        decision: 'approved',
        delivery: 'sent',
        resendAvailable: false,
      },
      {
        id: guestRecipientId,
        attendeeIds: [guestId],
        decision: 'approved',
        delivery: 'sent',
        resendAvailable: false,
      },
    ],
  }
  const pending: Schemas['DepartureHandoffProposal'] = {
    ...approved,
    recipients: approved.recipients.map((recipient) => ({
      ...recipient,
      decision: 'pending',
      resendAvailable: true,
    })),
  }

  it('requires a fresh approval check after losing the result of a confirm request', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-01T01:00:00Z') })
    try {
      let committed = false
      let mail = { cancellation: 'pending', confirmation: 'pending' }
      let cleanup = 'unresolved'
      const calls = server({
        [GET]: () =>
          json(200, {
            ...BOOKING,
            status: committed ? 'cancelled' : 'confirmed',
            departureHandoffEnabled: true,
          }),
        [HANDOFF_PREVIEW]: () =>
          json(
            200,
            committed
              ? {
                  offer: null,
                  preview: null,
                  receipt: {
                    sourceBookingId: ID,
                    replacementBookingId: REPLACEMENT_ID,
                    conference: 'failed',
                    oldConferenceCleanup: cleanup,
                    mail,
                  },
                }
              : { offer: { ...offer, state: 'ready' }, preview, receipt: null },
          ),
        [HANDOFF_APPLY]: () => {
          committed = true
          return json(503, { error: 'unavailable' })
        },
        [HANDOFF_STATUS]: () => json(200, approved),
      })
      open()
      const user = userEvent.setup()
      const handoff = within(await screen.findByRole('region', { name: 'Booking handoff' }))
      await user.click(handoff.getByRole('button', { name: 'Preview handoff' }))
      await handoff.findByText('All participants have approved.')
      expect(document.activeElement).toBe(handoff.getByRole('region', { name: 'Handoff status' }))
      expect(calls.to(HANDOFF_PREVIEW)[0]?.headers.get('x-expected-organization-id')).toBe(
        TEAM.organization.id,
      )
      const confirm = handoff.getByRole('button', { name: 'Confirm handoff' })
      await user.click(confirm)
      await handoff.findByText(/Could not confirm whether the handoff completed/)
      expect((confirm as HTMLButtonElement).disabled).toBe(true)
      expect(handoff.queryByText('Booking handoff completed.')).toBeNull()
      await user.click(confirm)
      expect(calls.to(HANDOFF_APPLY)).toHaveLength(1)
      expect(calls.to(HANDOFF_APPLY)[0]?.body).toEqual({ version: 3 })
      expect(calls.to(HANDOFF_APPLY)[0]?.headers.get('x-expected-organization-id')).toBe(
        TEAM.organization.id,
      )
      await user.click(handoff.getByRole('button', { name: 'Refresh handoff' }))
      await handoff.findByText('Booking handoff completed.')
      expect(handoff.getByText(/The replacement meeting link could not be verified/)).toBeDefined()
      expect(
        handoff.getByText(
          /Cleanup in the original calendar or meeting account could not be verified/,
        ),
      ).toBeDefined()
      expect(
        handoff.getByRole('link', { name: 'View replacement booking' }).getAttribute('href'),
      ).toBe(`/app/bookings/${REPLACEMENT_ID}`)
      expect(handoff.queryByRole('button', { name: 'Confirm handoff' })).toBeNull()
      expect(handoff.getByText('Attendee cancellation email')).toBeDefined()
      expect(handoff.getByText('Attendee confirmation email')).toBeDefined()
      expect(handoff.getAllByText('Mail server acceptance unconfirmed')).toHaveLength(2)
      mail = { cancellation: 'accepted', confirmation: 'incomplete' }
      cleanup = 'complete'
      await user.click(handoff.getByRole('button', { name: 'Refresh handoff' }))
      await handoff.findByText('Accepted by the mail server')
      expect(handoff.getByText('Email delivery incomplete')).toBeDefined()
      expect(
        handoff.getByText(
          'Cleanup of the tracked entries in the original calendar or meeting account is complete.',
        ),
      ).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks submit when a displayed ready offer expires before the next interaction', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-01T01:00:00Z') })
    try {
      const calls = server({
        [GET]: () => json(200, { ...BOOKING, departureHandoffEnabled: true }),
        [HANDOFF_PREVIEW]: () =>
          json(200, { offer: { ...offer, state: 'ready' }, preview, receipt: null }),
        [HANDOFF_STATUS]: () => json(200, approved),
      })
      open()
      const user = userEvent.setup()
      const handoff = within(await screen.findByRole('region', { name: 'Booking handoff' }))
      await user.click(handoff.getByRole('button', { name: 'Preview handoff' }))
      await handoff.findByText('All participants have approved.')
      const confirm = handoff.getByRole('button', { name: 'Confirm handoff' })
      vi.setSystemTime(new Date(offer.expiresAt))
      await user.click(confirm)
      await handoff.findByText(/Consent has expired/)
      expect((confirm as HTMLButtonElement).disabled).toBe(true)
      expect(handoff.queryByText('The proposed time is available.')).toBeNull()
      expect(calls.to(HANDOFF_APPLY)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates, resends and withdraws proposals with role-only status and a versioned restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-01T01:00:00Z') })
    try {
      let current: Schemas['DepartureHandoffProposal'] | null = null
      let available = false
      const calls = server({
        [GET]: () => json(200, handoffBooking),
        [HANDOFF_PREVIEW]: () =>
          json(200, {
            offer: current && {
              ...current,
              state: current.state === 'live' ? 'pending' : 'closed',
            },
            preview:
              current?.state === 'withdrawn'
                ? null
                : { ...preview, availability: available ? 'available' : 'unavailable' },
            receipt: null,
          }),
        [HANDOFF_CREATE]: () => {
          current = { ...pending, version: current ? current.version + 1 : 1 }
          return json(201, current)
        },
        [HANDOFF_STATUS]: () => json(200, current),
        [HANDOFF_RESEND]: () => json(200, current),
        [HANDOFF_WITHDRAW]: () => {
          if (!current) throw new Error('Expected a live proposal')
          current = { ...current, state: 'withdrawn' }
          return json(200, current)
        },
      })
      open()
      const user = userEvent.setup()
      const region = await screen.findByRole('region', { name: 'Booking handoff' })
      const handoff = within(region)
      const create = () => handoff.queryByRole('button', { name: 'Create proposal' })
      const refresh = () => user.click(handoff.getByRole('button', { name: 'Refresh handoff' }))
      expect(create()).toBeNull()
      await user.click(handoff.getByRole('button', { name: 'Preview handoff' }))
      await handoff.findByText(
        'That time is unavailable for the replacement host. Refresh the preview or use manual rebooking.',
      )
      expect(create()).toBeNull()
      available = true
      await refresh()
      await handoff.findByText('The proposed time is available.')
      expect(handoff.getByText(preview.candidateName)).toBeDefined()
      expect(handoff.getByText('Saved host')).toBeDefined()
      await user.click(handoff.getByRole('button', { name: 'Create proposal' }))
      const status = await handoff.findByRole('region', { name: 'Handoff proposal' })
      expect(within(status).getByText('Version 1')).toBeDefined()
      expect(
        within(status).getByText('Expires at').nextElementSibling?.querySelector('time')?.dateTime,
      ).toBe(offer.expiresAt)
      expect(create()).toBeNull()
      expect(calls.to(HANDOFF_CREATE)[0]?.body).toEqual({ departingUserId: ID })
      const booker = within(status).getByRole('article', { name: 'Booker' })
      const guest = within(status).getByRole('article', { name: 'Guest' })
      expect(within(booker).getByText('Awaiting decision')).toBeDefined()
      expect(within(guest).getByText('Accepted by the mail server')).toBeDefined()
      expect(region.innerHTML).not.toMatch(
        /grace@example\.com|guest@example\.com|Grace|Private guest|0000000000[23][01]/,
      )

      const resend = within(guest).getByRole('button', { name: 'Resend' })
      await user.click(resend)
      const resendDialog = () =>
        within(screen.getByRole('dialog', { name: 'Resend proposal link?' }))
      expect(document.activeElement).toBe(resendDialog().getByRole('button', { name: 'Cancel' }))
      await user.click(resendDialog().getByRole('button', { name: 'Cancel' }))
      expect(document.activeElement).toBe(resend)
      expect(calls.to(HANDOFF_RESEND)).toHaveLength(0)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await user.click(resend)
        await user.click(resendDialog().getByRole('button', { name: 'Resend' }))
        await handoff.findByText('Proposal link queued.')
      }
      const requests = calls.to(HANDOFF_RESEND)
      expect(requests.map((request) => request.body)).toEqual([
        { version: 1, recipientId: guestRecipientId },
        { version: 1, recipientId: guestRecipientId },
      ])
      const keys = requests.map((request) => request.headers.get('Idempotency-Key'))
      expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
      expect(keys[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
      expect(new Set(keys).size).toBe(2)

      await user.click(within(status).getByRole('button', { name: 'Withdraw' }))
      const withdraw = within(screen.getByRole('dialog', { name: 'Withdraw proposal?' }))
      expect(calls.to(HANDOFF_WITHDRAW)).toHaveLength(0)
      await user.click(withdraw.getByRole('button', { name: 'Withdraw' }))
      await handoff.findByText('Withdrawn')
      expect(calls.to(HANDOFF_WITHDRAW)[0]?.body).toEqual({ version: 1 })
      expect(within(status).getAllByText('Resend unavailable')).toHaveLength(2)
      fireEvent.change(handoff.getByLabelText('Start time (optional)'), {
        target: { value: '2030-03-04T10:30' },
      })
      await user.click(handoff.getByRole('button', { name: 'New version' }))
      await handoff.findByText('Version 2')
      expect(calls.to(HANDOFF_CREATE)[1]?.body).toEqual({
        departingUserId: ID,
        start: '2030-03-04T09:30:00.000Z',
        previous: { offerId: OFFER_ID, version: 1 },
      })
      for (const route of [HANDOFF_CREATE, HANDOFF_STATUS, HANDOFF_RESEND, HANDOFF_WITHDRAW]) {
        for (const call of calls.to(route)) {
          expect(call.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
          expect(call.headers.has('authorization')).toBe(false)
        }
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows proposal limits and requires a fresh read after an uncertain result', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-01T01:00:00Z') })
    try {
      let attempts = 0
      let needsRecovery = true
      const calls = server({
        [GET]: () => json(200, handoffBooking),
        [HANDOFF_PREVIEW]: () =>
          attempts === 3 && needsRecovery
            ? json(503, { error: 'unavailable' })
            : json(200, {
                offer: attempts === 3 ? { ...offer, state: 'pending' } : null,
                preview,
                receipt: null,
              }),
        [HANDOFF_CREATE]: () => {
          attempts += 1
          if (attempts === 1) return json(429, { error: 'rate_limited' })
          if (attempts === 2) return json(409, { error: 'handoff_send_limit' })
          return json(201, pending)
        },
        [HANDOFF_STATUS]: () => json(200, pending),
      })
      open()
      const user = userEvent.setup()
      const handoff = within(await screen.findByRole('region', { name: 'Booking handoff' }))
      await user.click(handoff.getByRole('button', { name: 'Preview handoff' }))
      const create = await handoff.findByRole('button', { name: 'Create proposal' })
      const refresh = () => user.click(handoff.getByRole('button', { name: 'Refresh handoff' }))
      for (const [index, message] of [
        'Too many requests. Wait a minute and try again.',
        'The send limit for this booking has been reached.',
        'Could not verify the proposal change. Refresh handoff before trying again.',
      ].entries()) {
        await user.click(create)
        await handoff.findByText(message)
        expect(create.getAttribute('aria-disabled')).toBe('true')
        await user.click(create)
        expect(calls.to(HANDOFF_CREATE)).toHaveLength(index + 1)
        if (index < 2) {
          await refresh()
          await waitFor(() => expect(create.getAttribute('aria-disabled')).toBe('false'))
        }
      }
      needsRecovery = false
      await refresh()
      await handoff.findByText('Version 3')
      expect(handoff.queryByRole('button', { name: 'Create proposal' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
