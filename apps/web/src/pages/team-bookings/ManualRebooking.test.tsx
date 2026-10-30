import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { admin } from '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { registerCatalog } from '../../i18n/translate.ts'
import { fakeApi } from '../../test/fake-api.tsx'
import { ManualRebooking } from './ManualRebooking.tsx'

registerCatalog(admin)

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const EVENT_ID = 'e0000000-0000-7000-8000-000000000001'
const PUBLIC_PATH = '/team/Research-Team/intro-call'
const session = vi.hoisted(() => ({
  me: {
    organization: {
      id: '00000000-0000-7000-8000-000000000010',
      slug: 'Research-Team',
      personal: false,
    },
  },
}))
vi.mock('../../session.tsx', () => ({ useMe: () => session.me }))

function booking(
  overrides: Partial<Schemas['TeamAdminBooking']> = {},
): Schemas['TeamAdminBooking'] {
  return {
    id: 'b0000000-0000-7000-8000-000000000001',
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T09:30:00.000Z',
    status: 'confirmed',
    cancelledAt: null,
    eventType: { id: EVENT_ID, title: 'Team discovery call', publicBookingPath: PUBLIC_PATH },
    hosts: [
      {
        userId: 'a0000000-0000-7000-8000-000000000001',
        name: 'Departed host',
        timeZone: 'Europe/London',
        isCurrentMember: false,
      },
    ],
    attendees: [],
    ...overrides,
  }
}

function panel(value = booking(), expectedOrganizationId = TEAM_ID) {
  return render(
    <ManualRebooking booking={value} expectedOrganizationId={expectedOrganizationId} />,
    {
      wrapper: ({ children }) => <InterfaceScope surface="admin">{children}</InterfaceScope>,
    },
  )
}

beforeEach(() => {
  session.me.organization = { id: TEAM_ID, slug: 'Research-Team', personal: false }
})

describe('manual team booking replacement', () => {
  it.each([
    {
      locale: 'en',
      heading: 'Book again with another host',
      left: 'A host has left the team, so this booking cannot be rescheduled. Hourmere does not automatically assign another host.',
      steps: [
        'An admin cancels this booking here before it starts.',
        'Then ask the guest to book again from the event’s public booking page.',
      ],
      link: 'Open public booking page',
    },
    {
      locale: 'zh-CN',
      heading: '重新预约其他主持人',
      left: '一位主持人已离开团队，因此此预约无法改期。Hourmere 不会自动指派其他主持人。',
      steps: ['管理员在预约开始前，在此页面取消预约。', '然后请访客从活动的公开预约页面重新预约。'],
      link: '打开公开预约页面',
    },
  ] as const)(
    'shows departed-host guidance and the DTO public path without a lookup in $locale',
    (copy) => {
      chooseLanguage(copy.locale)
      const api = fakeApi({})
      panel()
      expect(screen.getByRole('heading', { name: copy.heading })).toBeDefined()
      expect(screen.getByText(copy.left)).toBeDefined()
      const steps = screen.getAllByRole('listitem')
      expect(steps.map((step) => step.textContent)).toEqual(copy.steps)
      expect(steps[0]?.parentElement?.tagName).toBe('OL')
      expect(screen.getByRole('link', { name: copy.link }).getAttribute('href')).toBe(PUBLIC_PATH)
      expect(screen.queryByRole('button')).toBeNull()
      expect(api.calls).toEqual([])
    },
  )

  it.each([true, null] as const)(
    'hides rebooking steps when membership is %s',
    (isCurrentMember) => {
      const value = booking()
      value.hosts = value.hosts.map((host) => ({ ...host, isCurrentMember }))
      panel(value)
      expect(screen.queryByRole('heading', { name: 'Book again with another host' })).toBeNull()
      expect(screen.queryByRole('list')).toBeNull()
      expect(screen.queryByRole('link')).toBeNull()
    },
  )

  it('hides rebooking steps when there are no saved hosts', () => {
    panel(booking({ hosts: [] }))
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows rebooking when one of several saved hosts has left', () => {
    const value = booking()
    value.hosts.unshift({
      userId: 'a0000000-0000-7000-8000-000000000002',
      name: 'Current host',
      timeZone: 'Asia/Shanghai',
      isCurrentMember: true,
    })
    panel(value)
    expect(screen.getByRole('heading', { name: 'Book again with another host' })).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows the completed cancellation step for an already cancelled booking', () => {
    panel(booking({ status: 'cancelled', cancelledAt: '2026-10-29T09:00:00.000Z' }))
    expect(screen.getAllByRole('listitem')[0]?.textContent).toBe(
      'This booking is already cancelled. Continue with the next step.',
    )
  })

  it('directs a started booking to wait or coordinate offline', () => {
    panel(booking({ start: '2020-03-04T09:00:00.000Z' }))
    expect(screen.getAllByRole('listitem')[0]?.textContent).toBe(
      'This booking has already started. Wait until it ends or coordinate with the hosts offline.',
    )
  })

  it.each([
    null,
    { id: EVENT_ID, title: null, publicBookingPath: null },
    { id: EVENT_ID, title: 'Disabled event', publicBookingPath: null },
  ])('explains an unbookable event for association %j', (event) => {
    const api = fakeApi({})
    panel(booking({ eventType: event }))
    expect(screen.getByText('The event is no longer bookable.')).toBeDefined()
    expect(
      screen.getByText(
        'Ask an admin to repair and reactivate the event, or create a new event, before the guest books again.',
      ),
    ).toBeDefined()
    expect(screen.queryByRole('link')).toBeNull()
    expect(api.calls).toEqual([])
  })

  it('uses the replacement booking’s path after its event changes', () => {
    const view = panel()
    const eventType = {
      id: EVENT_ID,
      title: 'Another event',
      publicBookingPath: '/team/Research-Team/another',
    }
    view.rerender(
      <ManualRebooking booking={booking({ eventType })} expectedOrganizationId={TEAM_ID} />,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe(eventType.publicBookingPath)
  })

  it.each([
    { id: '00000000-0000-7000-8000-000000000020', slug: 'Other-Team', personal: false },
    { id: TEAM_ID, slug: 'Research-Team', personal: true },
  ])('suppresses the old team path after context drifts to %j', (organization) => {
    const value = booking()
    const view = panel(value)
    expect(screen.getByRole('link').getAttribute('href')).toBe(PUBLIC_PATH)
    session.me.organization = organization
    view.rerender(<ManualRebooking booking={value} expectedOrganizationId={TEAM_ID} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(
      'Your team context changed. Reload before making changes.',
    )
  })
})
