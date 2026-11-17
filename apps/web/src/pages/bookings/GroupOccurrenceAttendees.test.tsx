import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n/admin.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json } from '../../test/fake-api.tsx'
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
    'shows full sessions, cancelled seats, answers and no-shows in %s',
    async (language) => {
      chooseLanguage(language)
      const api = fakeApi({ [`GET ${route}/attendees`]: () => json(200, occurrence) })
      render(<GroupOccurrenceAttendees occurrenceId="session" expectedOrganizationId="org" />)
      expect(await screen.findByText('alice@example.com')).not.toBeNull()
      expect(screen.getByText('Gardening')).not.toBeNull()
      expect(screen.getByText('carol@example.com')).not.toBeNull()
      expect(screen.getByText(language === 'en' ? 'Cancelled' : '已取消')).not.toBeNull()
      expect(
        screen.getByText(language === 'en' ? 'No-show' : '未出席', { exact: false }),
      ).not.toBeNull()
      expect(
        screen.getByText(language === 'en' ? '2 of 2 seats booked' : '已预约 2 / 2 个席位'),
      ).not.toBeNull()
      expect(api.calls[0]?.headers.get('X-Expected-Organization-Id')).toBe('org')
    },
  )
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
    expect(screen.queryByText('No attendees in this session.')).toBeNull()
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
