import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookingDetailPage } from '../pages/bookings/BookingDetail.tsx'
import { RequireSession, SessionProvider } from '../session.tsx'
import { fakeApi, json, profile, signedIn } from '../test/fake-api.tsx'
import { managed, TOKEN } from '../test/public-fixtures.ts'
import { ManageBookingPage } from './ManageBookingPage.tsx'

const providers = [
  ['google_meet', 'https://meet.google.com/abc-defg-hij', 'Join Google Meet'],
  ['zoom', 'https://us02web.zoom.us/j/81234567890', 'Join Zoom meeting'],
] as const
type Provider = (typeof providers)[number][0]

const pending = (provider: Provider) =>
  managed({
    eventTypeId: null,
    start: '2030-11-02T14:00:00.000Z',
    end: '2030-11-02T14:30:00.000Z',
    location: { kind: provider, autoCreate: true },
    conference: { provider, status: 'pending', errorCode: null },
  })
const replaced = (provider: Provider) => ({
  ...pending(provider),
  status: 'cancelled' as const,
  cancelledAt: '2030-11-01T04:31:00.000Z',
  conference: undefined,
})
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
async function openManage() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/booking#token=${TOKEN}`]}>
        <ManageBookingPage />
      </MemoryRouter>,
    )
  })
}
afterEach(() => vi.useRealTimers())

describe.each(providers)('%s booking snapshot adoption', (provider, join, joinLabel) => {
  it('rechecks an initially replaced booking once, without a meeting notice, actions or polling', async () => {
    vi.useFakeTimers()
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, replaced(provider)),
    })
    await openManage()
    expect(screen.getByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    expect(screen.getByText(/the new booking has its own link/)).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Meeting link' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
    expect(screen.queryByRole('button', { name: /meeting link|cleanup/i })).toBeNull()
    expect(screen.queryByRole('link', { name: joinLabel })).toBeNull()
    await advance(60_000)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
  })

  it('replaces pending conference state when a poll finds the old booking replaced', async () => {
    vi.useFakeTimers()
    let reads = 0
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(200, reads++ === 0 ? pending(provider) : replaced(provider)),
    })
    await openManage()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect(screen.getByRole('heading', { name: 'Cancel this booking?' })).toBeDefined()
    await advance(2500)
    expect(screen.getByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    expect(screen.getByText(/the new booking has its own link/)).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Meeting link' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
    expect(screen.queryByRole('link', { name: joinLabel })).toBeNull()
    await advance(60_000)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(3)
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it.each(['initial read', 'conference poll'] as const)(
    'follows a cancelled predecessor immediately after an %s with only one extra read',
    async (transition) => {
      vi.useFakeTimers()
      const next = {
        ...replaced(provider),
        id: '01900000-0000-7000-8000-0000000000b2',
        start: '2030-11-03T15:00:00.000Z',
        end: '2030-11-03T15:30:00.000Z',
        status: 'confirmed' as const,
        cancelledAt: null,
        rescheduledFromId: pending(provider).id,
        eventType: { title: 'Moved call', durationMinutes: 30 },
        hosts: [{ name: 'Updated host name' }],
      }
      const responses = [
        ...(transition === 'conference poll' ? [pending(provider)] : []),
        replaced(provider),
        next,
      ]
      let reads = 0
      const api = fakeApi({
        'GET /api/v1/bookings/manage': () =>
          json(200, responses[Math.min(reads++, responses.length - 1)]),
      })
      await openManage()
      if (transition === 'conference poll') {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
        await advance(2500)
      }
      expect(screen.getByRole('heading', { name: 'Your booking' })).toBeDefined()
      expect(screen.getByText('Moved call')).toBeDefined()
      expect(screen.getByText('Updated host name')).toBeDefined()
      expect(document.querySelector('time')?.dateTime).toBe(next.start)
      expect(screen.queryByRole('heading', { name: 'Cancel this booking?' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Reschedule' })).toBeDefined()
      await advance(60_000)
      const calls = api.to('GET /api/v1/bookings/manage')
      expect(calls).toHaveLength(responses.length)
      expect(calls.every((call) => call.headers.get('x-manage-token') === TOKEN)).toBe(true)
      expect(calls.every((call) => !call.path.includes(TOKEN))).toBe(true)
      expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
    },
  )

  it('does not follow another cancelled successor recursively', async () => {
    vi.useFakeTimers()
    const next = {
      ...replaced(provider),
      id: '01900000-0000-7000-8000-0000000000b2',
      rescheduledFromId: pending(provider).id,
      eventType: { title: 'Cancelled successor', durationMinutes: 30 },
    }
    let reads = 0
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, reads++ === 0 ? replaced(provider) : next),
    })
    await openManage()
    expect(screen.getByText('Cancelled successor')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    await advance(60_000)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
  })

  it('keeps the cancelled snapshot when the one successor read fails', async () => {
    vi.useFakeTimers()
    let reads = 0
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () => {
        if (reads++ === 0) return json(200, replaced(provider))
        throw new TypeError('Failed to fetch')
      },
    })
    await openManage()
    expect(screen.getByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Your booking could not be loaded' })).toBeNull()
    await advance(60_000)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
  })

  it('does not replace a newer cancellation with a slow successor read', async () => {
    vi.useFakeTimers()
    const next = {
      ...pending(provider),
      id: '01900000-0000-7000-8000-0000000000b2',
      rescheduledFromId: pending(provider).id,
    }
    let answer: (response: Response) => void = () => {}
    let reads = 0
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () => {
        reads++
        if (reads < 3) return json(200, reads === 1 ? pending(provider) : replaced(provider))
        return new Promise<Response>((resolve) => {
          answer = resolve
        })
      },
      'POST /api/v1/bookings/manage/cancel': () =>
        json(200, {
          ...next,
          status: 'cancelled',
          conference: { provider, status: 'ready', errorCode: null },
        }),
    })
    await openManage()
    await advance(2500)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
    })
    expect(screen.getByText('Your booking is cancelled.')).toBeDefined()
    await act(async () => answer(json(200, next)))
    expect(screen.getByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    expect(screen.getByText('Your booking is cancelled.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
    await advance(60_000)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(3)
    expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(1)
  })

  it.each(['confirmed', 'cancelled'] as const)(
    'adopts a successor resolved by the same capability, including a %s successor',
    async (status) => {
      vi.useFakeTimers()
      const next = {
        ...pending(provider),
        id: '01900000-0000-7000-8000-0000000000b2',
        start: '2030-11-03T15:00:00.000Z',
        end: '2030-11-03T15:30:00.000Z',
        status,
        cancelledAt: status === 'cancelled' ? '2030-11-01T04:32:00.000Z' : null,
        rescheduledFromId: pending(provider).id,
        eventType: { title: 'Moved call', durationMinutes: 30 },
        hosts: [{ name: 'Updated host name' }],
      }
      const settled = {
        ...next,
        location: {
          kind: provider,
          autoCreate: true,
          ...(status === 'confirmed' && { url: join }),
        },
        conference: { provider, status: 'ready' as const, errorCode: null },
      }
      const responses = [pending(provider), next, settled]
      let reads = 0
      const api = fakeApi({
        'GET /api/v1/bookings/manage': () => json(200, responses[Math.min(reads++, 2)]),
      })
      await openManage()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
      await advance(2500)
      expect(
        screen.getByRole('heading', {
          name: status === 'cancelled' ? 'Cancelled booking' : 'Your booking',
        }),
      ).toBeDefined()
      expect(screen.getByText('Moved call')).toBeDefined()
      expect(screen.getByText('Updated host name')).toBeDefined()
      expect(document.querySelector('time')?.dateTime).toBe(next.start)
      expect(screen.queryByRole('heading', { name: 'Cancel this booking?' })).toBeNull()
      expect(screen.queryByRole('link', { name: joinLabel })).toBeNull()
      expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
      await advance(2500)
      if (status === 'confirmed')
        expect(screen.getByRole('link', { name: joinLabel }).getAttribute('href')).toBe(join)
      else {
        expect(screen.queryByRole('link', { name: joinLabel })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
        expect(screen.getByText(/has been cancelled|calendar copy is cancelled/)).toBeDefined()
      }
      await advance(60_000)
      const calls = api.to('GET /api/v1/bookings/manage')
      expect(calls).toHaveLength(3)
      expect(calls.every((call) => call.headers.get('x-manage-token') === TOKEN)).toBe(true)
      expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
    },
  )

  it('shows the host an initially replaced booking without conference polling or writes', async () => {
    vi.useFakeTimers()
    const old = replaced(provider)
    const route = `GET /api/v1/bookings/${old.id}`
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      [route]: () => json(200, old),
    })
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/app/bookings/${old.id}`]}>
          <SessionProvider>
            <Routes>
              <Route element={<RequireSession />}>
                <Route path="/app/bookings/:id" element={<BookingDetailPage />} />
              </Route>
            </Routes>
          </SessionProvider>
        </MemoryRouter>,
      )
    })
    expect(
      screen.getByRole('heading', { name: /Intro call with Grace Hopper.*Cancelled/ }),
    ).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Meeting link' })).toBeNull()
    expect(screen.queryByRole('button', { name: /retry|cancel booking|reschedule/i })).toBeNull()
    expect(screen.queryByRole('link', { name: joinLabel })).toBeNull()
    await advance(60_000)
    expect(api.to(route)).toHaveLength(1)
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
  })
})
