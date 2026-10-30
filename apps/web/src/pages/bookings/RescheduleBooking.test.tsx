import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { browserLocale } from '../../test/browser-locale.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedIn,
} from '../../test/fake-api.tsx'
import { booking, slotsAnswer } from '../../test/public-fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const original = booking()
const successor = booking({
  id: '01900000-0000-7000-8000-0000000000b2',
  rescheduledFromId: original.id,
  start: '2026-11-03T16:00:00.000Z',
  end: '2026-11-03T16:30:00.000Z',
})
const detail = `/app/bookings/${original.id}`
const slotsPath = `/api/v1/bookings/${original.id}/slots`
const movePath = `/api/v1/bookings/${original.id}/reschedule`

function hostApi(more: Routes = {}, initial: Schemas['Booking'] = original) {
  return fakeApi({
    ...signedIn,
    ...profile(),
    [`GET /api/v1/bookings/${original.id}`]: () => json(200, initial),
    [`GET /api/v1/bookings/${successor.id}`]: () => json(200, successor),
    [`GET /api/v1/event-types/${original.eventTypeId}`]: () =>
      json(404, { error: 'event_type_not_found' }),
    [`GET ${slotsPath}`]: slotsAnswer([
      original.start,
      '2026-11-03T15:00:00Z',
      '2026-11-03T16:00:00Z',
    ]),
    [`POST ${movePath}`]: () => json(200, { booking: successor, manageToken: null }),
    'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    ...more,
  })
}

async function chooseNewTime(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
  await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
  await user.click(screen.getByRole('button', { name: '5:00 PM' }))
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T04:30:00Z'))
})

describe('host rescheduling in the booking detail', () => {
  it.each(['Pick another time', 'conflict'])(
    'restores the browsed month and day after returning through %s',
    async (back) => {
      const user = userEvent.setup()
      const starts = ['2026-11-03T15:00:00Z', '2026-12-08T15:00:00Z', '2026-12-08T16:00:00Z']
      let taken = false
      const api = hostApi({
        [`GET ${slotsPath}`]: (call) =>
          slotsAnswer(taken ? starts.filter((start) => start !== starts[1]) : starts)(call),
        [`POST ${movePath}`]: () => {
          taken = true
          return json(409, { error: 'slot_taken' })
        },
      })
      renderApp(detail)
      await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
      await screen.findByRole('button', { name: 'Tuesday, November 3, available' })
      await user.click(screen.getByRole('button', { name: 'Next month' }))
      await screen.findByRole('button', { name: 'Tuesday, December 8, available' })
      await user.click(screen.getByRole('button', { name: /Time zone/ }))
      await user.type(screen.getByRole('combobox', { name: 'Search time zones' }), 'UTC')
      await user.click(screen.getByRole('option', { name: /^UTC/ }))
      await user.click(
        await screen.findByRole('button', { name: 'Tuesday, December 8, available' }),
      )
      await user.click(screen.getByRole('button', { name: '3:00 PM' }))
      await user.click(
        screen.getByRole('button', { name: back === 'conflict' ? 'Confirm new time' : back }),
      )

      const heading = await screen.findByRole('heading', { name: 'Pick a new time' })
      await waitFor(() => expect(document.activeElement).toBe(heading))
      const restored = await screen.findByRole('button', { name: 'Tuesday, December 8, available' })
      expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
      expect(restored.closest('td')?.getAttribute('aria-selected')).toBe('true')
      expect(screen.getByRole('button', { name: /Time zone/ }).textContent).toContain('UTC')
      expect(screen.queryByRole('button', { name: 'Confirm new time' })).toBeNull()
      expect(api.to(`GET ${slotsPath}`)).toHaveLength(3)
      expect(api.to(`POST ${movePath}`)).toHaveLength(back === 'conflict' ? 1 : 0)
      expect(
        within(screen.getByRole('list', { name: /^Times on/ }))
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(back === 'conflict' ? ['4:00 PM'] : ['3:00 PM', '4:00 PM'])
      await user.click(screen.getByRole('button', { name: '4:00 PM' }))
      expect(screen.getByRole('button', { name: 'Confirm new time' })).toBeDefined()
      expect(screen.getByText('UTC')).toBeDefined()
      expect(api.to(`POST ${movePath}`)).toHaveLength(back === 'conflict' ? 1 : 0)
    },
  )

  it.each(['Pick another time', 'conflict', 'reopen'])(
    'rechecks the current time when returning through %s',
    async (back) => {
      const user = userEvent.setup()
      hostApi(
        {
          [`GET ${slotsPath}`]: slotsAnswer([
            '2026-11-03T15:00:00Z',
            '2026-12-08T15:00:00Z',
            '2026-12-09T15:00:00Z',
          ]),
          [`POST ${movePath}`]: () => json(409, { error: 'slot_taken' }),
        },
        booking({ start: '2027-01-15T14:00:00Z', end: '2027-01-15T14:30:00Z' }),
      )
      renderApp(detail)
      await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
      await screen.findByRole('button', { name: 'Tuesday, November 3, available' })
      await user.click(screen.getByRole('button', { name: 'Next month' }))
      await user.click(
        await screen.findByRole('button', { name: 'Tuesday, December 8, available' }),
      )
      await user.click(
        screen.getByRole('button', { name: back === 'reopen' ? 'Keep booking' : '4:00 PM' }),
      )
      vi.mocked(Date.now).mockReturnValue(Date.parse('2026-12-08T15:05:00Z'))
      await user.click(
        screen.getByRole('button', {
          name: back === 'conflict' ? 'Confirm new time' : back === 'reopen' ? 'Reschedule' : back,
        }),
      )
      const expired = await screen.findByRole('button', {
        name: 'Tuesday, December 8, no times available',
      })
      expect(expired.getAttribute('aria-disabled')).toBe('true')
      await waitFor(() => {
        expect(expired.closest('td')?.getAttribute('aria-selected')).toBe('false')
        expect(screen.queryByRole('list', { name: /^Times on/ })).toBeNull()
      })
      expect(
        await screen.findByRole('button', { name: 'Wednesday, December 9, available' }),
      ).toBeDefined()
    },
  )

  it('uses the account Chinese locale for both reschedule summary ranges', async () => {
    browserLocale('en-US')
    const user = userEvent.setup()
    hostApi({ ...profile({ ...PROFILE, locale: 'zh-CN' }) })
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: '改期' }))
    await user.click(await screen.findByRole('button', { name: '11月3日星期二，可预约' }))
    await user.click(screen.getByRole('button', { name: '17:00' }))
    const section = screen.getByRole('region', { name: '为此预约改期' })
    const summary = section.querySelector('dl')
    const values = [...(summary?.querySelectorAll('dd') ?? [])].map((node) => node.textContent)
    expect(values[0]).toBe('2026年11月2日 15:00–2026年11月2日 15:30')
    expect(values[1]).toBe('2026年11月3日 17:00–2026年11月3日 17:30')
  })

  it('uses the shared slot picker and public host APIs, then opens the successor without an invitee token', async () => {
    const user = userEvent.setup()
    const api = hostApi()
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await screen.findByRole('button', { name: 'Tuesday, November 3, available' })
    expect(
      screen
        .getByRole('button', { name: 'Monday, November 2, no times available' })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '5:00 PM' }))
    expect(screen.getByText('Europe/Berlin')).toBeDefined()
    expect(api.to(`POST ${movePath}`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(`/app/bookings/${successor.id}`),
    )
    await screen.findByText('The booking is moved to the new time.')
    expect(api.to(`POST ${movePath}`)).toHaveLength(1)
    expect(api.to(`POST ${movePath}`)[0]?.body).toEqual({ start: successor.start })
    expect(api.to(`GET ${slotsPath}`).length).toBeGreaterThan(0)
    expect(
      api.calls.every(
        (call) =>
          call.path.startsWith('/api/v1/') ||
          (call.method === 'GET' && call.path === '/api/auth/organization/list'),
      ),
    ).toBe(true)
    expect(api.calls.every((call) => !call.headers.has('x-manage-token'))).toBe(true)
    expect(screen.queryByRole('link', { name: /manage|private link/i })).toBeNull()
  })

  it.each([
    ['cancelled', booking({ status: 'cancelled' })],
    ['already started', booking({ start: '2026-10-31T14:00:00Z', end: '2026-10-31T14:30:00Z' })],
  ])('does not offer to move a booking that is %s', async (_, value) => {
    const api = hostApi({}, value)
    renderApp(detail)
    await screen.findByRole('heading', { name: /Intro call with Grace Hopper/ })
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
    expect(api.to(`GET ${slotsPath}`)).toHaveLength(0)
  })

  it('shows loading and lets a slot-read error be retried without sending a mutation', async () => {
    const user = userEvent.setup()
    const delayed = later()
    let reads = 0
    const api = hostApi({
      [`GET ${slotsPath}`]: (call) =>
        ++reads === 1 ? delayed.response : slotsAnswer([successor.start])(call),
    })
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await screen.findByText('Loading available times…')
    await delayed.answer(json(500, { error: 'internal_error' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('button', { name: 'Tuesday, November 3, available' })
    expect(api.to(`GET ${slotsPath}`)).toHaveLength(2)
    expect(api.to(`POST ${movePath}`)).toHaveLength(0)
  })

  it('refreshes available times when the selected slot was taken', async () => {
    const user = userEvent.setup()
    let taken = false
    const api = hostApi({
      [`GET ${slotsPath}`]: (call) =>
        slotsAnswer(taken ? ['2026-11-03T15:00:00Z'] : ['2026-11-03T15:00:00Z', successor.start])(
          call,
        ),
      [`POST ${movePath}`]: () => {
        taken = true
        return json(409, { error: 'slot_taken' })
      },
    })
    renderApp(detail)
    await chooseNewTime(user)
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    await screen.findByText('Someone else just booked that time. Please pick another one.')
    await waitFor(() => expect(api.to(`GET ${slotsPath}`)).toHaveLength(2))
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    expect(
      within(screen.getByRole('list', { name: /^Times on/ })).getAllByRole('button'),
    ).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '5:00 PM' })).toBeNull()
    expect(api.to(`POST ${movePath}`)).toHaveLength(1)
  })

  it('keeps a lengthened event available across split request boundaries', async () => {
    const user = userEvent.setup()
    let crossing: string | undefined
    const api = hostApi({
      [`GET ${slotsPath}`]: (call) => {
        const query = new URL(call.path, 'http://localhost').searchParams
        const start = Date.parse(query.get('start') ?? '')
        const end = Date.parse(query.get('end') ?? '')
        // The stored booking lasts 30 minutes, but the event type now lasts two hours.
        // Pick a slot that neither half contains with the old 30-minute overlap.
        crossing ??= new Date(
          start + Math.floor((end - start) / 2 / 60_000) * 60_000 - 60 * 60_000,
        ).toISOString()
        return end - start > 16 * 86_400_000
          ? json(400, { error: 'range_too_long' })
          : slotsAnswer([crossing], 120)(call)
      },
    })
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /, available$/ })).toHaveLength(1),
    )
    await user.click(screen.getByRole('button', { name: /, available$/ }))
    expect(
      within(screen.getByRole('list', { name: /^Times on/ })).getAllByRole('button'),
    ).toHaveLength(1)
    expect(api.to(`GET ${slotsPath}`).length).toBeGreaterThan(2)
    expect(api.to(`POST ${movePath}`)).toHaveLength(0)
  })

  it('keeps a lengthened event available when its end crosses the month request edge', async () => {
    const user = userEvent.setup()
    hostApi({ [`GET ${slotsPath}`]: slotsAnswer(['2026-11-30T22:00:00Z'], 1440) })
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await waitFor(() =>
      expect(
        screen.queryAllByRole('button', { name: 'Monday, November 30, available' }),
      ).toHaveLength(1),
    )
    await user.click(screen.getByRole('button', { name: 'Monday, November 30, available' }))
    expect(screen.getByRole('button', { name: '11:00 PM' })).toBeDefined()
  })

  it('sends only one move while its answer is pending', async () => {
    const user = userEvent.setup()
    const delayed = later()
    const api = hostApi({ [`POST ${movePath}`]: () => delayed.response })
    renderApp(detail)
    await chooseNewTime(user)
    const confirm = screen.getByRole('button', { name: 'Confirm new time' })
    act(() => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })
    await screen.findByRole('button', { name: 'Moving…' })
    expect(
      (screen.getByRole('button', { name: 'Pick another time' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await waitFor(() => expect(api.to(`POST ${movePath}`)).toHaveLength(1))
    await delayed.answer(json(200, { booking: successor, manageToken: null }))
    await screen.findByText('The booking is moved to the new time.')
  })

  it.each(['network', 'server'] as const)(
    'does not repeat or offer a replay after an uncertain %s answer',
    async (kind) => {
      const user = userEvent.setup()
      const api = hostApi({
        [`POST ${movePath}`]: () => {
          if (kind === 'network') throw new TypeError('Failed to fetch')
          return json(500, { error: 'internal_error' })
        },
      })
      renderApp(detail)
      await chooseNewTime(user)
      await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
      await screen.findByText(/The response was lost. The booking may have moved/)
      expect(screen.queryByRole('button', { name: 'Confirm new time' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Keep booking' })).toBeNull()
      expect(api.to(`POST ${movePath}`)).toHaveLength(1)
      expect(screen.getByRole('link', { name: 'Back to bookings' }).getAttribute('href')).toBe(
        '/app/bookings',
      )
    },
  )

  it.each([
    ['booking_cancelled', 'This booking was already cancelled.'],
    ['booking_in_past', 'This meeting has already started, so it can’t be changed.'],
  ])('stops a stale form when the server reports %s', async (code, message) => {
    const user = userEvent.setup()
    const api = hostApi({ [`POST ${movePath}`]: () => json(409, { error: code }) })
    renderApp(detail)
    await chooseNewTime(user)
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    await screen.findByText(message)
    expect(screen.queryByRole('button', { name: 'Confirm new time' })).toBeNull()
    expect(api.to(`POST ${movePath}`)).toHaveLength(1)
  })

  it('ignores a late move answer after the host leaves the detail page', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const delayed = later()
    hostApi({ [`POST ${movePath}`]: () => delayed.response })
    renderApp(detail)
    await chooseNewTime(user)
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    await user.click(screen.getAllByRole('link', { name: 'Bookings' })[0] as HTMLElement)
    await screen.findByText('No upcoming bookings.')
    await delayed.answer(json(200, { booking: successor, manageToken: null }))
    expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
    expect(screen.queryByText('The booking is moved to the new time.')).toBeNull()
  })

  it('keeps the selected time, opening organization and unsaved guard when another tab switches teams', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    let active = ME
    const api = hostApi({
      'GET /api/v1/me': () => json(200, active),
      [`POST ${movePath}`]: () => json(409, { error: 'organization_context_changed' }),
    })
    renderApp(detail)
    await chooseNewTime(user)
    active = {
      ...ME,
      organization: {
        ...ME.organization,
        id: '00000000-0000-7000-8000-000000000003',
        personal: false,
      },
    }
    await act(async () => fireEvent.focus(window))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES))
    expect(screen.getByRole('button', { name: 'Confirm new time' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain(
      'Your team context changed. Reload before making changes.',
    )
    expect(api.to(`POST ${movePath}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      ME.organization.id,
    )
    expect(api.to(`POST ${movePath}`)[0]?.body).toEqual({ start: '2026-11-03T16:00:00.000Z' })
    expect(screen.queryByRole('button', { name: 'Confirm new time' })).not.toBeNull()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm new time' }).disabled,
    ).toBe(true)
    expect(screen.getByText('To').nextElementSibling?.textContent).toContain('5:00 PM')
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(api.to('GET /api/v1/me')).toHaveLength(2)
    expect(screen.getByText('To').nextElementSibling?.textContent).toContain('5:00 PM')
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await screen.findByRole('button', { name: 'Reschedule' })
    expect(api.to(`POST ${movePath}`)).toHaveLength(1)
  })

  it('discards a late move response after focus refresh remounts the changed team', async () => {
    const user = userEvent.setup()
    const delayed = later()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let active = ME
    const api = hostApi({
      'GET /api/v1/me': () => json(200, active),
      [`POST ${movePath}`]: () => delayed.response,
    })
    renderApp(detail)
    await chooseNewTime(user)
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    active = {
      ...ME,
      organization: {
        ...ME.organization,
        id: '00000000-0000-7000-8000-000000000003',
        personal: false,
      },
    }
    await act(async () => fireEvent.focus(window))
    await screen.findByRole('button', { name: 'Reschedule' })
    await delayed.answer(json(200, { booking: successor, manageToken: null }))
    expect(screen.getByTestId('location').textContent).toBe(detail)
    expect(screen.queryByText('The booking is moved to the new time.')).toBeNull()
    expect(api.to(`GET /api/v1/bookings/${successor.id}`)).toHaveLength(0)
  })
})
