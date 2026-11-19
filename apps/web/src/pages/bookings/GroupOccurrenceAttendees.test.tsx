import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n/admin.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, later } from '../../test/fake-api.tsx'
import { GroupOccurrenceAttendees } from './GroupOccurrenceAttendees.tsx'

const route = '/api/v1/group-occurrences/session'
const occurrence = {
  id: 'session',
  eventTypeId: 'event',
  title: 'Workshop',
  start: '2099-01-01T10:00:00Z',
  end: '2099-01-01T11:00:00Z',
  capacity: 2,
  activeSeats: 2,
  state: 'open',
  pagination: { limit: 25, offset: 0, hasMore: false },
  attendees: [
    {
      bookingId: 'one',
      id: 'person-one',
      name: 'Alice',
      email: 'alice@example.com',
      responses: { topic: 'Gardening' },
      status: 'confirmed',
      noShowMarkedAt: null,
      noShowMarkedBy: null,
    },
    {
      bookingId: 'two',
      id: 'person-two',
      name: 'Bob',
      email: 'bob@example.com',
      responses: {},
      status: 'confirmed',
      noShowMarkedAt: '2026-01-01T10:00:00Z',
      noShowMarkedBy: 'host',
    },
    {
      bookingId: 'three',
      id: 'person-three',
      name: 'Carol',
      email: 'carol@example.com',
      responses: {},
      status: 'cancelled',
      noShowMarkedAt: null,
      noShowMarkedBy: null,
    },
  ],
}
describe('private occurrence attendee panel', () => {
  it.each(['en', 'zh-CN'] as const)(
    'defaults to active seats and filters cancelled seats in %s',
    async (language) => {
      chooseLanguage(language)
      const api = fakeApi({
        [`GET ${route}/attendees`]: ({ path }) => {
          const status = new URL(path, 'http://localhost').searchParams.get('status')
          return json(200, {
            ...occurrence,
            attendees: occurrence.attendees.filter((person) =>
              status === 'cancelled'
                ? person.status === 'cancelled'
                : person.status === 'confirmed',
            ),
          })
        },
      })
      render(<GroupOccurrenceAttendees occurrenceId="session" expectedOrganizationId="org" />)
      expect(await screen.findByText('alice@example.com')).not.toBeNull()
      expect(screen.getByText('Gardening')).not.toBeNull()
      expect(screen.queryByText('carol@example.com')).toBeNull()
      expect(
        screen.getByText(language === 'en' ? 'No-show' : '未出席', { exact: false }),
      ).not.toBeNull()
      expect(
        screen.getByText(language === 'en' ? '2 of 2 seats booked' : '已预约 2 / 2 个席位'),
      ).not.toBeNull()
      expect(api.calls[0]?.headers.get('X-Expected-Organization-Id')).toBe('org')
      expect(api.calls[0]?.path).toContain('status=active&limit=25&offset=0')
      await userEvent
        .setup()
        .selectOptions(
          screen.getByRole('combobox', { name: language === 'en' ? 'Seat status' : '席位状态' }),
          'cancelled',
        )
      expect(await screen.findByText('carol@example.com')).not.toBeNull()
      expect(screen.queryByText('alice@example.com')).toBeNull()
      expect(screen.getByText(language === 'en' ? 'Cancelled' : '已取消')).not.toBeNull()
    },
  )
  it.each(['en', 'zh-CN'] as const)(
    'pages the bounded list and resets the page when filtering in %s',
    async (language) => {
      chooseLanguage(language)
      const api = fakeApi({
        [`GET ${route}/attendees`]: ({ path }) => {
          const query = new URL(path, 'http://localhost').searchParams
          const offset = Number(query.get('offset'))
          return json(200, {
            ...occurrence,
            attendees: [occurrence.attendees[offset === 0 ? 0 : 1]],
            pagination: { limit: 25, offset, hasMore: offset === 0 },
          })
        },
      })
      render(<GroupOccurrenceAttendees occurrenceId="session" expectedOrganizationId="org" />)
      await screen.findByText('alice@example.com')
      const user = userEvent.setup()
      const previous = language === 'en' ? 'Previous page' : '上一页'
      const next = language === 'en' ? 'Next page' : '下一页'
      expect(screen.getByRole('button', { name: previous }).hasAttribute('disabled')).toBe(true)
      await user.click(screen.getByRole('button', { name: next }))
      await screen.findByText('bob@example.com')
      expect(screen.queryByText('alice@example.com')).toBeNull()
      expect(api.calls.at(-1)?.path).toContain('offset=25')
      expect(screen.getByRole('button', { name: next }).hasAttribute('disabled')).toBe(true)
      await user.click(screen.getByRole('button', { name: previous }))
      await screen.findByText('alice@example.com')
      await user.click(screen.getByRole('button', { name: next }))
      await screen.findByText('bob@example.com')
      await user.selectOptions(screen.getByRole('combobox'), 'all')
      await screen.findByText('alice@example.com')
      expect(api.calls.at(-1)?.path).toContain('status=all&limit=25&offset=0')
      expect(screen.getByRole('button', { name: previous }).hasAttribute('disabled')).toBe(true)
    },
  )
  it('hides the old page while a new page is pending and does not call a refusal empty', async () => {
    const pending = later()
    fakeApi({
      [`GET ${route}/attendees`]: ({ path }) =>
        path.includes('offset=25')
          ? pending.response
          : json(200, { ...occurrence, pagination: { limit: 25, offset: 0, hasMore: true } }),
    })
    render(<GroupOccurrenceAttendees occurrenceId="session" expectedOrganizationId="org" />)
    await screen.findByText('alice@example.com')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Loading attendees…')
    expect(screen.queryByText('alice@example.com')).toBeNull()
    await pending.answer(json(403, { error: 'forbidden' }))
    await screen.findByText('Could not load the attendee list.')
    expect(screen.queryByText('No seats match this filter on this page.')).toBeNull()
  })
  it('shows a neutral empty result for the requested filter', async () => {
    fakeApi({ [`GET ${route}/attendees`]: () => json(200, { ...occurrence, attendees: [] }) })
    render(<GroupOccurrenceAttendees occurrenceId="session" expectedOrganizationId="org" />)
    await screen.findByText('No seats match this filter on this page.')
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true)
  })
  it('clears prior attendees if a refresh is denied', async () => {
    let denied = false
    fakeApi({
      [`GET ${route}/attendees`]: () =>
        denied ? json(404, { error: 'group_occurrence_not_found' }) : json(200, occurrence),
    })
    render(<GroupOccurrenceAttendees occurrenceId="session" expectedOrganizationId="org" />)
    await screen.findByText('alice@example.com')
    denied = true
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText('Could not load the attendee list.')
    expect(screen.queryByText('alice@example.com')).toBeNull()
    expect(screen.queryByText('No seats match this filter on this page.')).toBeNull()
  })
  it('requires whole-session confirmation and pins the organization for cancellation', async () => {
    const onCancelled = vi.fn()
    let cancelled = false
    const api = fakeApi({
      [`GET ${route}/attendees`]: () =>
        json(200, { ...occurrence, state: cancelled ? 'host_cancelled' : 'open' }),
      [`POST ${route}/cancel`]: () => {
        cancelled = true
        return json(200, { id: 'session', cancelledSeatCount: 2 })
      },
    })
    render(
      <GroupOccurrenceAttendees
        occurrenceId="session"
        expectedOrganizationId="org"
        onCancelled={onCancelled}
      />,
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Cancel whole session…' }))
    expect(api.to(`POST ${route}/cancel`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Cancel whole session' }))
    expect(await screen.findByText('alice@example.com')).not.toBeNull()
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(api.to(`POST ${route}/cancel`)[0]?.headers.get('X-Expected-Organization-Id')).toBe('org')
  })
})
