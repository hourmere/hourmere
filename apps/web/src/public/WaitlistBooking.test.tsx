import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { booking, EVENT, eventRoutes, slot, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'
import { parseWaitlistLink } from './waitlist-link.ts'

const capability = `00000000-0000-4000-8000-000000000091.${'w'.repeat(43)}`
const suggested = '2026-11-02T14:00:00.000Z'
const deadline = Date.parse('2026-11-02T12:00:00Z')
const next = '2026-11-02T15:00:00.000Z'
const clock = vi.hoisted(() => ({ now: Date.parse('2026-11-01T12:00:00Z') }))
vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  detectTimeZone: () => 'UTC',
  preferredLocale: () => 'en-US',
  now: () => clock.now,
}))
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  clock.now = Date.parse('2026-11-01T12:00:00Z')
})

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Your name'), 'Grace Hopper')
  await user.type(screen.getByLabelText('Email'), 'grace@example.com')
}

describe('ordinary booking from a waitlist email', () => {
  it.each([false, true])(
    'opens the suggested form and carries attribution only in the POST body (team %s)',
    async (team) => {
      const user = userEvent.setup()
      const page = team ? '/team/alpha/intro' : '/ada/intro'
      const apiPath = team ? '/api/v1/public/teams/alpha/intro' : '/api/v1/public/ada/intro'
      const calls = fakeApi({
        [`GET ${apiPath}`]: () => json(200, EVENT),
        [`GET ${apiPath}/slots`]: slotsAnswer([suggested, next]),
        [`POST ${apiPath}/bookings`]: () => json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp(`${page}/waitlist/${capability}/${encodeURIComponent(suggested)}/${deadline}`)
      await fill(user)
      expect(screen.getByText(/No time is reserved/)).toBeDefined()
      expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('grace@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      const posted = calls.to(`POST ${apiPath}/bookings`)
      expect(posted).toHaveLength(1)
      expect(
        (posted[0]?.body as { waitlistToken?: string } | undefined)?.waitlistToken === capability,
      ).toBe(true)
      expect(calls.calls.every((call) => !call.path.includes(capability))).toBe(true)
      expect(calls.calls.every((call) => !call.path.includes('waitlistToken='))).toBe(true)
    },
  )

  it('refreshes the remaining times after a booking race and keeps the waitlist attribution', async () => {
    const user = userEvent.setup()
    let taken = false
    const calls = fakeApi({
      ...eventRoutes(EVENT, [suggested, next]),
      'GET /api/v1/public/ada/intro/slots': (call) =>
        slotsAnswer(taken ? [next] : [suggested, next])(call),
      'POST /api/v1/public/ada/intro/bookings': () => {
        if (!taken) {
          taken = true
          return json(409, { error: 'slot_taken' })
        }
        return json(201, { booking: booking({ ...slot(next) }), manageToken: TOKEN })
      },
    })
    renderApp(`/ada/intro/waitlist/${capability}/${encodeURIComponent(suggested)}/${deadline}`)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText('Someone else just booked that time. Please pick another one.')
    await user.click(await screen.findByRole('button', { name: /November 2, available/ }))
    await user.click(screen.getByRole('button', { name: '3:00 PM' }))
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Grace Hopper')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(calls.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(2)
    expect(
      calls
        .to('POST /api/v1/public/ada/intro/bookings')
        .every((call) => (call.body as { waitlistToken: string }).waitlistToken === capability),
    ).toBe(true)
  })

  it('shows unavailable and the remaining ordinary slots when a suggestion was taken before opening', async () => {
    fakeApi(eventRoutes(EVENT, [next]))
    renderApp(`/ada/intro/waitlist/${capability}/${encodeURIComponent(suggested)}/${deadline}`)
    await screen.findByText('That time is no longer available. Please pick another one.')
    expect(screen.queryByLabelText('Your name')).toBeNull()
    await screen.findByRole('button', { name: /November 2, available/ })
  })

  it('keeps availability failures neutral instead of presenting them as a taken time', async () => {
    fakeApi({
      ...eventRoutes(EVENT, []),
      'GET /api/v1/public/ada/intro/slots': () => json(503, { error: 'calendar_sync_unavailable' }),
    })
    renderApp(`/ada/intro/waitlist/${capability}/${encodeURIComponent(suggested)}/${deadline}`)
    await waitFor(() =>
      expect(
        screen.queryByText('That time is no longer available. Please pick another one.'),
      ).toBeNull(),
    )
    await screen.findByRole('button', { name: 'Try again' })
    expect(screen.queryByLabelText('Your name')).toBeNull()
  })

  it('ignores malformed optional metadata', () => {
    expect(parseWaitlistLink('bad', suggested, String(deadline))).toBeUndefined()
    expect(parseWaitlistLink(capability, 'not a date', String(deadline))).toBeUndefined()
    expect(parseWaitlistLink(capability, suggested, String(deadline))?.start).toBe(
      '2026-11-02T14:00:00.000Z',
    )
  })
  it.each([Date.parse('2026-11-01T12:00:00Z'), Date.parse('2026-11-01T11:59:59Z')])(
    'expires the suggestion preview at or after %s while ordinary booking remains usable',
    async (expired) => {
      const user = userEvent.setup()
      const api = fakeApi({
        ...eventRoutes(EVENT, [suggested]),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp(`/ada/intro/waitlist/${capability}/${encodeURIComponent(suggested)}/${expired}`)
      await screen.findByText('These suggestions have expired. Check the current available times.')
      expect(screen.queryByLabelText('Your name')).toBeNull()
      await user.click(await screen.findByRole('button', { name: /November 2, available/ }))
      await user.click(screen.getByRole('button', { name: '2:00 PM' }))
      await fill(user)
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      expect(
        (api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body as { waitlistToken?: string })
          ?.waitlistToken === capability,
      ).toBe(true)
    },
  )
  it('does not open a preview when its availability response crosses the deadline', async () => {
    const pending = later()
    let queried = false
    fakeApi({
      ...eventRoutes(EVENT, [suggested]),
      'GET /api/v1/public/ada/intro/slots': (call) => {
        if (queried) return slotsAnswer([suggested])(call)
        queried = true
        return pending.response
      },
    })
    renderApp(`/ada/intro/waitlist/${capability}/${encodeURIComponent(suggested)}/${deadline}`)
    await waitFor(() => expect(queried).toBe(true))
    clock.now = deadline
    await pending.answer(json(200, { data: [slot(suggested)] }))
    await screen.findByText('These suggestions have expired. Check the current available times.')
    expect(screen.queryByLabelText('Your name')).toBeNull()
  })
})
