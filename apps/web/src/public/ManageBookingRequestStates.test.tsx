// What the invitee page says when a host's request to choose another time can no longer be
// answered: from the request email's own link, and after a stale tab tries to answer it.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { managed, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'

const env = vi.hoisted(() => ({ now: Date.parse('2026-11-01T04:30:00Z') }))
vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => env.now,
}))
beforeEach(() => {
  env.now = Date.parse('2026-11-01T04:30:00Z')
})

const REQUEST = '01900000-0000-7000-8000-0000000000c1'
const NEWER = '01900000-0000-7000-8000-0000000000c2'
const COPY = {
  en: {
    expired:
      'This request to choose a new time has expired. Your booking stays at its original time.',
    replaced: 'Your host has sent a newer request to choose a new time, which replaces this one.',
    rescheduled: 'This booking has already been moved to a new time, so this request is closed.',
    pending:
      'Your host has asked you to choose a new time. The original booking stays in place until you reschedule or cancel.',
    cancelled: 'This booking was already cancelled.',
    started: 'This meeting has already started, so it can’t be changed.',
    generic: 'This request has expired or changed. Reload your booking to choose what to do next.',
  },
  'zh-CN': {
    expired: '此改期请求已过期。你的预约仍保持原定时间。',
    replaced: '主持人已发送新的改期请求，取代了此请求。',
    rescheduled: '此预约已改到新的时间，因此此请求已关闭。',
    pending: '主持人请你选择新时间。在你改期或取消前，原预约仍然有效。',
    generic: '此请求已过期或发生变更。请重新加载预约，再选择下一步操作。',
  },
} as const
const CLOSED = ['expired', 'replaced', 'rescheduled'] as const

type Managed = Schemas['ManagedBooking']
const pending = (id = REQUEST) => ({ id, expiresAt: '2026-11-02T14:00:00.000Z', note: null })
const fromLink = (state: NonNullable<Managed['rescheduleRequest']>['state'], id = REQUEST) => ({
  rescheduleRequest: { id, state },
})
const moved = (): Managed =>
  managed({
    id: '01900000-0000-7000-8000-0000000000b2',
    start: '2026-11-03T15:00:00.000Z',
    end: '2026-11-03T15:30:00.000Z',
    rescheduledFromId: '01900000-0000-7000-8000-0000000000b1',
  })

/** One booking behind TOKEN; `after` is what a reload shows once an answer was refused. */
function server(initial: Managed, after?: () => Managed) {
  let refused = false
  const changed = () => {
    refused = true
    return json(409, {
      error: 'reschedule_request_changed',
      message: 'This reschedule request has already been resolved or replaced',
    })
  }
  return fakeApi({
    'GET /api/v1/bookings/manage': () => json(200, refused && after ? after() : initial),
    'GET /api/v1/bookings/manage/slots': slotsAnswer([
      '2026-11-03T15:00:00Z',
      '2026-11-03T16:00:00Z',
    ]),
    'POST /api/v1/bookings/manage/reschedule': changed,
    'POST /api/v1/bookings/manage/cancel': changed,
  })
}

async function pickAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
  await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
  await user.click(screen.getByRole('button', { name: '10:00 AM' }))
  await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
}

describe('closed reschedule requests on the invitee page', () => {
  describe.each(['en', 'zh-CN'] as const)('from the request email link in %s', (language) => {
    it.each(CLOSED)('explains a %s request instead of opening the picker', async (state) => {
      localStorage.setItem('hourmere-language', language)
      server({
        ...managed(state === 'replaced' ? { pendingReschedule: pending(NEWER) } : {}),
        ...fromLink(state),
      })
      renderApp(`/booking#token=${TOKEN}&action=reschedule`)
      expect(await screen.findByText(COPY[language][state])).toBeDefined()
      for (const other of CLOSED.filter((s) => s !== state))
        expect(screen.queryByText(COPY[language][other])).toBeNull()
      expect(screen.queryByText(COPY[language].generic)).toBeNull()
      // The page stays on the booking; an open newer request is still offered.
      expect(screen.queryByRole('heading', { name: /Pick a new time|选择新时间/ })).toBeNull()
      expect(screen.queryByText(COPY[language].pending) !== null).toBe(state === 'replaced')
    })
  })

  it('opens the picker as before while the link’s request is pending', async () => {
    server({ ...managed({ pendingReschedule: pending() }), ...fromLink('pending') })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect(await screen.findByRole('heading', { name: 'Pick a new time' })).toBeDefined()
    for (const state of CLOSED) expect(screen.queryByText(COPY.en[state])).toBeNull()
  })

  it('lets the cancelled booking and the started meeting speak for an expired link', async () => {
    server({
      ...managed({ status: 'cancelled', cancelledAt: '2026-11-01T04:00:00.000Z' }),
      ...fromLink('cancelled'),
    })
    const cancelled = renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect(
      await screen.findByText('This booking is cancelled, so it can’t be changed.'),
    ).toBeDefined()
    for (const state of CLOSED) expect(screen.queryByText(COPY.en[state])).toBeNull()
    cancelled.unmount()

    env.now = Date.parse('2026-11-02T14:05:00Z')
    server({ ...managed(), ...fromLink('expired') })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect(await screen.findByText(COPY.en.started)).toBeDefined()
    expect(screen.queryByText(COPY.en.expired)).toBeNull()
  })

  it.each([
    ['expired', () => managed()],
    ['replaced', () => managed({ pendingReschedule: pending(NEWER) })],
    ['rescheduled', moved],
    ['cancelled', () => managed({ status: 'cancelled', cancelledAt: '2026-11-01T04:31:00.000Z' })],
    [
      'started',
      () => {
        env.now = Date.parse('2026-11-02T14:05:00Z')
        return managed()
      },
    ],
  ] as const)('explains a stale pick refused because the request was %s', async (state, after) => {
    const user = userEvent.setup()
    const api = server(managed({ pendingReschedule: pending() }), after)
    renderApp(`/booking#token=${TOKEN}`)
    await pickAndConfirm(user)
    expect(await screen.findByText(COPY.en[state])).toBeDefined()
    expect(screen.queryByText(COPY.en.generic)).toBeNull()
    expect(api.to('POST /api/v1/bookings/manage/reschedule')).toHaveLength(1)
    expect(api.to('POST /api/v1/bookings/manage/reschedule')[0]?.body).toMatchObject({
      rescheduleRequestId: REQUEST,
    })
    // One reload; a cancelled snapshot is resolved once more for a raced successor.
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(state === 'cancelled' ? 3 : 2)
  })

  it('prefers the link’s own request state, and explains a stale cancellation in Chinese', async () => {
    const user = userEvent.setup()
    // No newer request is open any more, but the link reports its request was replaced.
    server({ ...managed({ pendingReschedule: pending() }), ...fromLink('pending') }, () => ({
      ...managed(),
      ...fromLink('replaced'),
    }))
    renderApp(`/booking#token=${TOKEN}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect(await screen.findByText(COPY.en.replaced)).toBeDefined()
    expect(screen.queryByText(COPY.en.expired)).toBeNull()
    await selectPublicLanguage(user, 'zh-CN')
    expect(await screen.findByText(COPY['zh-CN'].replaced)).toBeDefined()
    expect(screen.queryByText(COPY['zh-CN'].generic)).toBeNull()
  })

  it('drops the closed request notice once the invitee moves the booking here', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(200, {
          ...managed({ pendingReschedule: pending(NEWER) }),
          ...fromLink('replaced'),
        }),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
      'POST /api/v1/bookings/manage/reschedule': () =>
        json(200, { booking: moved(), manageToken: null }),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect(await screen.findByText(COPY.en.replaced)).toBeDefined()
    await pickAndConfirm(user)
    expect(await screen.findByText('Your booking is moved to the new time.')).toBeDefined()
    await waitFor(() => expect(screen.queryByText(COPY.en.replaced)).toBeNull())
    expect(api.to('POST /api/v1/bookings/manage/reschedule')[0]?.body).toMatchObject({
      rescheduleRequestId: NEWER,
    })
  })
})
