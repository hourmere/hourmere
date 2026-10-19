import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookingDetailPage } from '../pages/bookings/BookingDetail.tsx'
import { fakeApi, json, profile } from '../test/fake-api.tsx'
import { managed, TOKEN } from '../test/public-fixtures.ts'
import { UnsavedChangesProvider } from '../unsaved-changes.tsx'
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
  it('shows an initially replaced booking without a meeting notice, actions or polling', async () => {
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
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(1)
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
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
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
      ...profile(),
      [route]: () => json(200, old),
    })
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/app/bookings/${old.id}`]}>
          <UnsavedChangesProvider>
            <Routes>
              <Route path="/app/bookings/:id" element={<BookingDetailPage />} />
            </Routes>
          </UnsavedChangesProvider>
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
