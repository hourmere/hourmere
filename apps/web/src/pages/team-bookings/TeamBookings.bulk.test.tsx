import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

const PAGE = '/app/team/bookings'
const LIST = 'GET /api/v1/team/bookings'
const RECEIPT = 'b0000000-0000-7000-8000-000000000000'
const PREVIEW = 'POST /api/v1/team/bookings/bulk-cancellations/preview'
const CONFIRM = `POST /api/v1/team/bookings/bulk-cancellations/${RECEIPT}/confirm`
const STATUS = `GET /api/v1/team/bookings/bulk-cancellations/${RECEIPT}`
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}

beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, TeamBookingsPage))
afterEach(() => sessionStorage.clear())

function booking(
  number: number,
  status: 'confirmed' | 'cancelled' = 'confirmed',
): Schemas['TeamAdminBooking'] {
  const id = `b0000000-0000-7000-8000-${String(number).padStart(12, '0')}`
  return {
    id,
    status,
    isRescheduled: false,
    start: '2099-07-01T09:00:00.000Z',
    end: '2099-07-01T09:30:00.000Z',
    cancelledAt: null,
    eventType: { id, title: `Research meeting ${number}`, publicBookingPath: null },
    hosts: [],
    attendees: [],
  }
}

function fixture(overrides: Routes = {}) {
  return fakeApi(
    teamBookingPanelApi({
      ...signedInAs(TEAM),
      ...profile(),
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM.organization]),
      [LIST]: () => page([booking(1), booking(2)]),
      ...overrides,
    }),
  )
}

function page(
  data: Schemas['TeamAdminBooking'][],
  token = 'page-1',
  nextCursor: string | null = null,
) {
  return json(200, { data, nextCursor, bulkPageToken: token, bulkPageExpiresAt: expiresAt })
}

function preview(...items: Schemas['BulkCancellationPreview']['items']) {
  return json(200, { confirmationId: RECEIPT, expiresAt, items })
}

const button = (name: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole('button', { name })
const checkbox = (number: number) =>
  screen.getByRole('checkbox', { name: new RegExp(`Select booking: Research meeting ${number},`) })
async function enterSelection() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Select bookings to cancel' }))
  return user
}

function completed() {
  const response: Schemas['BulkCancellationStatus'] = {
    id: RECEIPT,
    state: 'completed',
    counts: {
      pending: 0,
      cancelled: 1,
      already_cancelled: 0,
      booking_started: 0,
      booking_not_supported: 1,
      booking_unavailable: 0,
      booking_host_departed: 0,
      authorization_lost: 0,
      processing_failed: 0,
    },
    items: [
      { bookingId: booking(1).id, code: 'cancelled' },
      { bookingId: booking(2).id, code: 'booking_not_supported' },
    ],
  }
  return json(200, response)
}

describe('team bulk cancellation', () => {
  it('does not offer selection without a page proof', async () => {
    const api = fixture({ [LIST]: () => json(200, { data: [booking(1)], nextCursor: null }) })
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'Research meeting 1' })
    expect(screen.queryByRole('button', { name: 'Select bookings to cancel' })).toBeNull()
    const list = api.to(LIST)[0]
    expect(list?.path).toContain('bulkSelection=true')
    expect(list?.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
  })

  it('limits selection to 25, drops an abandoned preview and binds Show more to the next proof', async () => {
    const pending = later()
    const first = Array.from({ length: 26 }, (_, index) => booking(index + 1))
    const second = [booking(27), booking(28, 'cancelled')]
    const api = fixture({
      [LIST]: ({ path }) =>
        path.includes('cursor=next') ? page(second, 'page-2') : page(first, 'page-1', 'next'),
      [PREVIEW]: ({ body }) => {
        if (JSON.stringify(body).includes('page-1')) return pending.response
        return preview({ bookingId: booking(27).id, code: 'eligible' })
      },
    })
    renderApp(PAGE)
    const user = await enterSelection()
    expect(screen.queryByRole('button', { name: 'Select this page' })).toBeNull()
    for (let index = 1; index <= 25; index++) fireEvent.click(checkbox(index))
    expect((checkbox(26) as HTMLInputElement).disabled).toBe(true)
    await user.click(button('Review cancellation'))
    expect((button('Loading…') as HTMLButtonElement).disabled).toBe(true)
    await user.click(button('Show more bookings'))
    await screen.findByRole('checkbox', { name: /Select booking: Research meeting 27,/ })
    expect(within(screen.getByRole('table')).getAllByRole('checkbox')).toEqual([checkbox(27)])
    expect(screen.getByText('0 selected on this page (maximum 25).')).toBeDefined()
    await pending.answer(preview({ bookingId: booking(1).id, code: 'eligible' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(button('Select this page'))
    const review = button('Review cancellation')
    await user.click(review)
    const dialog = await screen.findByRole('dialog', { name: 'Review bulk cancellation' })
    expect(within(dialog).getByText('1 selected. 1 eligible to cancel.')).toBeDefined()
    expect(dialog.querySelector('h2')).toBe(document.activeElement)
    expect(api.to(PREVIEW).map(({ body }) => body)).toEqual([
      { pageToken: 'page-1', bookingIds: first.slice(0, 25).map(({ id }) => id) },
      { pageToken: 'page-2', bookingIds: [booking(27).id] },
    ])
    await user.click(button('Close', dialog))
    await waitFor(() => expect(document.activeElement).toBe(review))
    expect(api.to(CONFIRM)).toHaveLength(0)
  })

  it('discards a late preview when filters change and clears selection on refresh', async () => {
    const pending = later()
    const api = fixture({ [PREVIEW]: () => pending.response })
    renderApp(PAGE)
    const user = await enterSelection()
    await user.click(checkbox(1))
    await user.click(button('Review cancellation'))
    await user.click(screen.getByRole('link', { name: 'All bookings' }))
    await screen.findByRole('button', { name: 'Select bookings to cancel' })
    await pending.answer(preview({ bookingId: booking(1).id, code: 'eligible' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(button('Select bookings to cancel'))
    await user.click(checkbox(1))
    expect((checkbox(1) as HTMLInputElement).checked).toBe(true)
    await user.click(button('Refresh bookings'))
    await waitFor(() => expect(api.to(LIST)).toHaveLength(3))
    expect((checkbox(1) as HTMLInputElement).checked).toBe(false)
    expect((button('Review cancellation') as HTMLButtonElement).disabled).toBe(true)
  })

  it('abandons a pending preview when opening booking details', async () => {
    const pending = later()
    fixture({
      [PREVIEW]: () => pending.response,
      [`GET /api/v1/team/bookings/${booking(1).id}`]: () => json(200, booking(1)),
    })
    renderApp(PAGE)
    const user = await enterSelection()
    await user.click(checkbox(1))
    await user.click(button('Review cancellation'))
    await user.click(button('Research meeting 1'))
    await screen.findByRole('region', { name: 'Team booking details' })
    await pending.answer(preview({ bookingId: booking(1).id, code: 'eligible' }))
    await user.click(button('Close details'))
    expect(screen.queryByRole('dialog', { name: 'Review bulk cancellation' })).toBeNull()
    expect((checkbox(1) as HTMLInputElement).checked).toBe(false)
  })

  it('shows exclusions and disables confirmation when all selected items are skipped', async () => {
    const api = fixture({
      [PREVIEW]: () => preview({ bookingId: booking(1).id, code: 'booking_not_supported' }),
    })
    renderApp(PAGE)
    const user = await enterSelection()
    await user.click(checkbox(1))
    await user.click(button('Review cancellation'))
    const dialog = await screen.findByRole('dialog', { name: 'Review bulk cancellation' })
    const review = within(dialog)
    expect(review.getByText('Research team')).toBeDefined()
    expect(review.getByText('Europe/Berlin')).toBeDefined()
    expect(review.getByText('Filters applied')).toBeDefined()
    expect(review.getByText('Upcoming')).toBeDefined()
    expect(review.getByText('Oldest first')).toBeDefined()
    expect(review.getByText('1 selected. 0 eligible to cancel.')).toBeDefined()
    expect(
      review.getByText('Unsupported booking (including paid or imported bookings)'),
    ).toBeDefined()
    const submit = button('Cancel 0 bookings', dialog) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await user.click(submit)
    expect(api.to(CONFIRM)).toHaveLength(0)
  })

  it('replays only the submitted receipt after a lost response and keeps the partial result through refresh', async () => {
    let attempts = 0
    const api = fixture({
      [PREVIEW]: () =>
        preview(
          { bookingId: booking(1).id, code: 'eligible' },
          { bookingId: booking(2).id, code: 'booking_not_supported' },
        ),
      [CONFIRM]: () => {
        attempts++
        if (attempts === 1) throw new TypeError('Failed to fetch')
        return json(202, { id: RECEIPT, state: 'queued' })
      },
      [STATUS]: () =>
        attempts < 2 ? json(404, { error: 'bulk_cancellation_not_found' }) : completed(),
    })
    renderApp(PAGE)
    const user = await enterSelection()
    await user.click(button('Select this page'))
    await user.click(button('Review cancellation'))
    const review = await screen.findByRole('dialog', { name: 'Review bulk cancellation' })
    expect(api.to(CONFIRM)).toHaveLength(0)
    await user.click(button('Cancel 1 booking', review))
    const status = await screen.findByRole('dialog', { name: 'Bulk cancellation status' })
    expect(status.querySelector('h2')).toBe(document.activeElement)
    const retry = await within(status).findByRole('button', { name: 'Retry submission' })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    await user.click(retry)
    expect(await within(status).findByText('Bulk cancellation completed')).toBeDefined()
    expect(within(status).getByRole('status').textContent).toContain(
      '1 cancelled, 0 pending, 1 skipped or failed.',
    )
    expect(
      within(status).getByText('Unsupported booking (including paid or imported bookings)'),
    ).toBeDefined()
    expect(api.to(PREVIEW)).toHaveLength(1)
    expect(api.to(CONFIRM)).toHaveLength(2)
    for (const call of api.to(CONFIRM)) {
      expect(call.body).toBeUndefined()
      expect(call.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
    }
    const stored = sessionStorage.getItem(
      `hourmere:team-bulk-cancellation:${TEAM.user.id}:${TEAM.organization.id}`,
    )
    expect(stored && JSON.parse(stored)).toEqual({ id: RECEIPT, expiresAt })
    await waitFor(() => expect(api.to(LIST)).toHaveLength(2))
    await user.click(button('Close', status))
    await user.click(button('View bulk cancellation'))
    expect(
      within(screen.getByRole('dialog')).getByText('Bulk cancellation completed'),
    ).toBeDefined()
  })

  it('does not retry when the server refuses a receipt issued to a different session', async () => {
    const api = fixture({
      [PREVIEW]: () => preview({ bookingId: booking(1).id, code: 'eligible' }),
      [CONFIRM]: () => json(404, { error: 'bulk_cancellation_not_found' }),
      [STATUS]: () => json(200, { id: RECEIPT, expiresAt, state: 'awaiting_confirmation' }),
    })
    renderApp(PAGE)
    const user = await enterSelection()
    await user.click(checkbox(1))
    await user.click(button('Review cancellation'))
    await user.click(button('Cancel 1 booking', await screen.findByRole('dialog')))
    const status = within(await screen.findByRole('dialog', { name: 'Bulk cancellation status' }))
    expect(
      await status.findByText(
        'Submission could not be confirmed. This page will keep checking its status.',
      ),
    ).toBeDefined()
    expect(status.queryByRole('button', { name: 'Retry submission' })).toBeNull()
    expect(api.to(CONFIRM)).toHaveLength(1)
  })

  it('restores only status after a reload and never resubmits a saved receipt', async () => {
    sessionStorage.setItem(
      `hourmere:team-bulk-cancellation:${TEAM.user.id}:${TEAM.organization.id}`,
      JSON.stringify({ id: RECEIPT, expiresAt }),
    )
    const api = fixture({
      [STATUS]: () => json(200, { id: RECEIPT, expiresAt, state: 'awaiting_confirmation' }),
    })
    renderApp(PAGE)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View bulk cancellation' }))
    await waitFor(() => expect(api.to(STATUS)).toHaveLength(1))
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: 'Retry submission' }),
    ).toBeNull()
    expect(api.to(CONFIRM)).toHaveLength(0)
  })

  it('removes controls and restores focus to access guidance when permission is revoked', async () => {
    const pending = later()
    const api = fixture({ [PREVIEW]: () => pending.response })
    renderApp(PAGE)
    const user = await enterSelection()
    await user.click(checkbox(1))
    await user.click(button('Review cancellation'))
    await pending.answer(json(403, { error: 'team_management_access_denied' }))
    const guidance = await screen.findByRole('heading', {
      name: 'Team bookings access is no longer available.',
    })
    expect(document.activeElement).toBe(guidance)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.to(CONFIRM)).toHaveLength(0)
  })
})
