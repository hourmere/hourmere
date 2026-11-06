import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  renderApp,
  signedIn,
} from '../../test/fake-api.tsx'
import { booking } from '../../test/public-fixtures.ts'

const original = booking()
const path = `/api/v1/bookings/${original.id}/request-reschedule`
function fixture(overrides = {}, value = original, locale = 'en') {
  return fakeApi({
    ...signedIn,
    ...profile({ ...PROFILE, locale }),
    [`GET /api/v1/bookings/${original.id}`]: () => json(200, value),
    [`GET /api/v1/event-types/${original.eventTypeId}`]: () =>
      json(404, { error: 'event_type_not_found' }),
    [`POST ${path}`]: () =>
      json(200, {
        ...original,
        pendingReschedule: {
          id: '01900000-0000-7000-8000-0000000000b2',
          note: 'Please choose another time.',
          expiresAt: original.start,
        },
      }),
    ...overrides,
  })
}
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T04:30:00Z')))

describe('host request reschedule', () => {
  it('sends the optional note with an idempotency key and opening organization, preserving the booking', async () => {
    const api = fixture()
    const user = userEvent.setup()
    renderApp(`/app/bookings/${original.id}`)
    await user.click(await screen.findByRole('button', { name: 'Request reschedule' }))
    await user.type(
      screen.getByRole('textbox', { name: /Note to the invitee/ }),
      'Please choose another time.',
    )
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    await screen.findByText('Waiting for the invitee to choose a new time.')
    const call = api.to(`POST ${path}`)[0]
    expect(call?.body).toEqual({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      note: 'Please choose another time.',
    })
    expect(call?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeDefined()
    expect(screen.getByTestId('location').textContent).toBe(`/app/bookings/${original.id}`)
  })

  it('blocks duplicate clicks and replays the same payload after an uncertain response', async () => {
    const pending = later()
    let attempts = 0
    const api = fixture({
      [`POST ${path}`]: () => (++attempts === 1 ? pending.response : json(200, original)),
    })
    const user = userEvent.setup()
    renderApp(`/app/bookings/${original.id}`)
    await user.click(await screen.findByRole('button', { name: 'Request reschedule' }))
    await user.type(screen.getByRole('textbox', { name: /Note to the invitee/ }), 'Please move.')
    const send = screen.getByRole('button', { name: 'Send request' })
    act(() => {
      fireEvent.click(send)
      fireEvent.click(send)
    })
    await waitFor(() => expect(api.to(`POST ${path}`)).toHaveLength(1))
    await pending.answer(json(500, { error: 'internal_error' }))
    await user.click(await screen.findByRole('button', { name: 'Retry the same request' }))
    await waitFor(() => expect(api.to(`POST ${path}`)).toHaveLength(2))
    expect(api.to(`POST ${path}`)[1]?.body).toEqual(api.to(`POST ${path}`)[0]?.body)
  })

  it.each([
    ['cancelled', booking({ status: 'cancelled' })],
    ['past', booking({ start: '2026-10-31T14:00:00Z' })],
    ['imported', booking({ source: 'import', managementPolicy: 'local_only_read_only' })],
  ])('does not offer requests for %s bookings', async (_, value) => {
    fixture({}, value)
    renderApp(`/app/bookings/${original.id}`)
    await screen.findByRole('heading', { name: /Intro call/ })
    expect(screen.queryByRole('button', { name: 'Request reschedule' })).toBeNull()
  })

  it('explains why group seats cannot request a new time without offering the action', async () => {
    const api = fixture({}, booking({ isGroupSeat: true }))
    renderApp(`/app/bookings/${original.id}`)
    await screen.findByText('Group-seat bookings do not support reschedule requests.')
    expect(screen.queryByRole('button', { name: 'Request reschedule' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Note to the invitee/ })).toBeNull()
    expect(api.to(`POST ${path}`)).toHaveLength(0)
  })

  it('translates the action and note form into Chinese', async () => {
    fixture({}, original, 'zh-CN')
    const user = userEvent.setup()
    renderApp(`/app/bookings/${original.id}`)
    await user.click(await screen.findByRole('button', { name: '请求改期' }))
    expect(screen.getByRole('textbox', { name: /给受邀人的留言/ })).toBeDefined()
    expect(screen.getByRole('button', { name: '发送请求' })).toBeDefined()
  })

  it('refuses an overlong note without sending', async () => {
    const api = fixture()
    const user = userEvent.setup()
    renderApp(`/app/bookings/${original.id}`)
    await user.click(await screen.findByRole('button', { name: 'Request reschedule' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Note to the invitee/ }), {
      target: { value: 'x'.repeat(2001) },
    })
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    await screen.findByText('Use at most 2000 characters for your note.')
    expect(api.to(`POST ${path}`)).toHaveLength(0)
  })
})
