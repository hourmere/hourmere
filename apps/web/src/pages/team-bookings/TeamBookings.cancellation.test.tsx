import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import * as formatting from '../../format.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import styles from '../../styles.css?raw'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import bookingStyles from './team-bookings.css?raw'

const PAGE = '/app/team/bookings'
const LIST = 'GET /api/v1/team/bookings'
const FIRST_ID = 'b0000000-0000-7000-8000-000000000001'
const LATER_ID = 'b0000000-0000-7000-8000-000000000002'
const FOLLOWING_ID = 'b0000000-0000-7000-8000-000000000003'
const cancelRoute = (id = FIRST_ID) => `POST /api/v1/team/bookings/${id}/cancel`
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}

function booking(id = FIRST_ID, title = 'Team discovery call'): Schemas['TeamAdminBooking'] {
  return {
    id,
    status: 'confirmed',
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T09:30:00.000Z',
    cancelledAt: null,
    eventType: { id: 'e0000000-0000-7000-8000-000000000001', title },
    hosts: [{ userId: ME.user.id, name: 'Historical host' }],
    attendees: [
      {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        timeZone: 'America/New_York',
        isBooker: true,
      },
    ],
  }
}

function server(overrides: Routes = {}) {
  return fakeApi({
    ...signedInAs(TEAM),
    ...profile(),
    'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM.organization]),
    [LIST]: () => json(200, { data: [booking()], nextCursor: null }),
    ...overrides,
  })
}

async function cancelFromDetail(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
  await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
}

function expectUsefulListFocus() {
  const active = document.activeElement
  const list = screen.getByRole('region', { name: 'Team bookings' })
  const buttons = within(list).queryAllByRole('button')
  const headings = within(list).queryAllByRole('heading', { name: 'Team bookings' })
  expect(active).not.toBe(document.body)
  expect(active?.isConnected).toBe(true)
  expect(active?.classList.contains('visually-hidden')).toBe(false)
  expect(active?.closest('[hidden]')).toBeNull()
  expect([
    ...buttons.filter((button) => button.hasAttribute('data-booking')),
    ...headings,
  ]).toContain(active)
}

describe('team booking cancellation refusals', () => {
  it('removes the page and navigation when an access-denied response confirms demotion', async () => {
    let cancelled = false
    const api = server({
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          id: 'membership-1',
          organizationId: TEAM.organization.id,
          userId: TEAM.user.id,
          role: cancelled ? 'member' : 'owner',
          createdAt: '2026-10-01T09:00:00.000Z',
        }),
      [cancelRoute()]: () => {
        cancelled = true
        return json(403, { error: 'team_management_access_denied' })
      },
    })
    const user = userEvent.setup()
    renderApp(PAGE)
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    await cancelFromDetail(user)
    await screen.findByRole('heading', { name: 'Team bookings access is no longer available.' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Go to your bookings' }).getAttribute('href')).toBe(
      '/app/bookings',
    )
    expect(api.to(cancelRoute())).toHaveLength(1)
  })

  it.each([
    {
      locale: 'en',
      nav: 'Team bookings',
      detail: 'Team booking details',
      openCancel: 'Cancel booking…',
      submitCancel: 'Cancel booking',
      reason: /Reason/,
      unavailable:
        'This booking can no longer be cancelled. It may have started or become unavailable.',
      revoked: 'Team bookings access is no longer available.',
    },
    {
      locale: 'zh-CN',
      nav: '团队预约',
      detail: '团队预约详情',
      openCancel: '取消预约…',
      submitCancel: '取消预约',
      reason: /原因/,
      unavailable: '此预约已无法取消，可能已开始或已不可用。',
      revoked: '团队预约访问权限已失效。',
    },
  ] as const)(
    'keeps the page and draft when a masked cancellation refusal retains the role in $locale',
    async (copy) => {
      chooseLanguage(copy.locale)
      let refused = false
      const api = server({
        ...profile({ ...PROFILE, locale: copy.locale }),
        [LIST]: () =>
          json(200, {
            data: [
              booking(FIRST_ID, refused ? 'Updated unavailable meeting' : 'Team discovery call'),
            ],
            nextCursor: null,
          }),
        [cancelRoute()]: () => {
          refused = true
          return json(403, { error: 'team_management_access_denied' })
        },
      })
      const user = userEvent.setup()
      renderApp(PAGE)
      await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
      await user.click(screen.getByRole('button', { name: copy.openCancel }))
      await user.type(screen.getByLabelText(copy.reason), 'Keep this explanation')
      const roleChecksBeforeCancellation = api.to(
        'GET /api/auth/organization/get-active-member',
      ).length
      await user.click(screen.getByRole('button', { name: copy.submitCancel }))
      await screen.findByText(copy.unavailable)
      expect(screen.getByRole('link', { name: copy.nav })).toBeDefined()
      expect(screen.queryByText(copy.revoked)).toBeNull()
      expect(screen.getByDisplayValue('Keep this explanation')).toBeDefined()
      await screen.findByRole('button', { name: 'Updated unavailable meeting' })
      const panel = screen.getByRole('region', { name: copy.detail })
      expect(await within(panel).findByText('Updated unavailable meeting')).toBeDefined()
      expect(api.to('GET /api/auth/organization/get-active-member').length).toBeGreaterThan(
        roleChecksBeforeCancellation,
      )
      expect(api.to(LIST).length).toBeGreaterThan(1)
      expect(api.to(cancelRoute())).toHaveLength(1)
    },
  )

  it.each([
    {
      locale: 'en',
      nav: 'Team bookings',
      detail: 'Team booking details',
      openCancel: 'Cancel booking…',
      submitCancel: 'Cancel booking',
      started:
        'This booking has already started, so it can no longer be cancelled. Wait until it ends or coordinate with the hosts offline.',
      confirmed: 'Confirmed',
      notSet: 'Not set',
      owner: 'Owner',
      success: 'The booking is cancelled.',
      revoked: 'Team bookings access is no longer available.',
    },
    {
      locale: 'zh-CN',
      nav: '团队预约',
      detail: '团队预约详情',
      openCancel: '取消预约…',
      submitCancel: '取消预约',
      started: '此预约已经开始，无法再取消。请等待预约结束，或与主持人线下协调。',
      confirmed: '已确认',
      notSet: '未设置',
      owner: '所有者',
      success: '预约已取消。',
      revoked: '团队预约访问权限已失效。',
    },
  ] as const)(
    'refreshes a booking that started during confirmation after the real masked refusal in $locale',
    async (copy) => {
      chooseLanguage(copy.locale)
      let started = false
      const current = booking()
      const api = server({
        ...profile({ ...PROFILE, locale: copy.locale }),
        [LIST]: () =>
          json(200, {
            data: [
              started
                ? {
                    ...current,
                    start: '2020-03-04T09:00:00.000Z',
                    end: '2020-03-04T09:30:00.000Z',
                  }
                : current,
            ],
            nextCursor: null,
          }),
        [cancelRoute()]: () => {
          started = true
          return json(403, { error: 'team_management_access_denied' })
        },
      })
      const user = userEvent.setup()
      renderApp(PAGE)
      await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
      await user.click(screen.getByRole('button', { name: copy.openCancel }))
      await user.click(screen.getByRole('button', { name: copy.submitCancel }))
      await screen.findByText(copy.started)
      expect(screen.getByRole('link', { name: copy.nav })).toBeDefined()
      expect(within(screen.getByRole('main')).getByText(copy.owner)).toBeDefined()
      expect(screen.queryByText(copy.revoked)).toBeNull()
      const panel = within(screen.getByRole('region', { name: copy.detail }))
      const definitions = panel.getAllByRole('definition')
      expect(definitions[3]?.querySelector('time')?.dateTime).toBe('2020-03-04T09:00:00.000Z')
      expect(definitions[4]?.textContent).toBe(copy.confirmed)
      expect(definitions[5]?.textContent).toBe(copy.notSet)
      for (const host of current.hosts) {
        expect(definitions[6]?.textContent).toContain(host.name)
        expect(definitions[6]?.textContent).toContain(host.userId)
      }
      expect(
        screen.getByRole('button', { name: 'Team discovery call' }).closest('tr')?.textContent,
      ).toContain(copy.confirmed)
      expect(screen.queryByText(copy.success)).toBeNull()
      expect(screen.queryByRole('button', { name: copy.openCancel })).toBeNull()
      expect(screen.queryByRole('button', { name: copy.submitCancel })).toBeNull()
      expect(api.to(LIST)).toHaveLength(2)
      expect(api.to(cancelRoute())).toHaveLength(1)
    },
  )

  it('keeps the page, navigation and reason for an unrelated forbidden response', async () => {
    const api = server({ [cancelRoute()]: () => json(403, { error: 'forbidden' }) })
    const user = userEvent.setup()
    renderApp(PAGE)
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'Keep this explanation')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Could not cancel the booking. You don't have permission to do that.",
    )
    expect(screen.getByRole('link', { name: 'Team bookings' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Team discovery call' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Team booking details' })).toBeDefined()
    expect(screen.getByDisplayValue('Keep this explanation')).toBeDefined()
    expect(screen.queryByText('Team bookings access is no longer available.')).toBeNull()
    expect(api.to(cancelRoute())).toHaveLength(1)
  })
})

describe('team booking cancellation outcome', () => {
  it.each([
    {
      locale: 'en',
      openCancel: 'Cancel booking…',
      summary: 'Cancel this booking',
      when: 'When',
      hosts: 'Hosts',
      unavailableHostZones: 'Host time zones are not available in this view.',
      zone: 'Your time zone: Asia/Shanghai',
      notificationHeading: 'Cancellation notifications',
      notifications:
        'Cancellation emails go to the invitee and guests below, and saved hosts who are still verified members of this team. Departed hosts are not notified.',
      noReassignment:
        'Hourmere does not automatically assign another host. A replacement requires a new booking.',
    },
    {
      locale: 'zh-CN',
      openCancel: '取消预约…',
      summary: '取消此预约',
      when: '时间',
      hosts: '主持人',
      unavailableHostZones: '此页面无法获取主持人的时区。',
      zone: '你的时区：Asia/Shanghai',
      notificationHeading: '取消通知',
      notifications:
        '取消邮件将发给下列预约访客和来宾，以及仍是本团队成员且邮箱已验证的原主持人。已离队的主持人不会收到通知。',
      noReassignment: 'Hourmere 不会自动指派其他主持人。如需替代安排，必须重新预约。',
    },
  ] as const)(
    'shows the time, saved hosts, recipients and manual replacement policy in $locale',
    async (copy) => {
      chooseLanguage(copy.locale)
      vi.spyOn(formatting, 'browserTimeZone').mockReturnValue('Asia/Shanghai')
      const current = booking()
      current.hosts.push({
        userId: 'a0000000-0000-7000-8000-000000000002',
        name: 'Second saved host',
      })
      current.attendees.push({
        name: 'Alan Turing',
        email: 'alan@example.com',
        timeZone: 'Europe/London',
        isBooker: false,
      })
      const api = server({
        ...profile({ ...PROFILE, locale: copy.locale }),
        [LIST]: () => json(200, { data: [current], nextCursor: null }),
      })
      const user = userEvent.setup()
      renderApp(PAGE)
      await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
      await user.click(screen.getByRole('button', { name: copy.openCancel }))
      const summary = within(screen.getByRole('region', { name: copy.summary }))
      const when = summary.getByText(copy.when, { selector: 'dt' }).nextElementSibling
      expect(when?.querySelector('time')?.dateTime).toBe(current.start)
      expect(when?.textContent).toContain(
        formatting.zoned('Asia/Shanghai', copy.locale).dateTimeRange(current.start, current.end),
      )
      expect(summary.getByText(copy.zone)).toBeDefined()
      const hosts = summary.getByText(copy.hosts, { selector: 'dt' }).nextElementSibling
      for (const host of current.hosts) expect(hosts?.textContent).toContain(host.name)
      expect(hosts?.textContent).toContain(copy.unavailableHostZones)
      const recipients = summary.getByText(copy.notificationHeading, {
        selector: 'dt',
      }).nextElementSibling
      expect(recipients?.textContent).toContain(copy.notifications)
      for (const person of current.attendees) {
        expect(recipients?.textContent).toContain(person.name)
        expect(recipients?.textContent).toContain(person.email)
      }
      expect(summary.getByText(copy.noReassignment)).toBeDefined()
      expect(api.to(cancelRoute())).toHaveLength(0)
    },
  )

  it('names the absence of saved hosts while retaining invitee and guest cancellation recipients', async () => {
    const current = booking()
    current.hosts = []
    current.attendees.push({
      name: 'Alan Turing',
      email: 'alan@example.com',
      timeZone: 'Europe/London',
      isBooker: false,
    })
    const api = server({ [LIST]: () => json(200, { data: [current], nextCursor: null }) })
    const user = userEvent.setup()
    renderApp(PAGE)
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    const summary = within(screen.getByRole('region', { name: 'Cancel this booking' }))
    const hosts = summary.getByText('Hosts', { selector: 'dt' }).nextElementSibling
    expect(hosts?.textContent).toMatch(/^None/)
    expect(hosts?.querySelector('ul')).toBeNull()
    const recipients = summary.getByText('Cancellation notifications', {
      selector: 'dt',
    }).nextElementSibling
    for (const person of current.attendees) {
      expect(recipients?.textContent).toContain(person.name)
      expect(recipients?.textContent).toContain(person.email)
    }
    expect(recipients?.textContent).toContain(
      'Email delivery is not guaranteed. Contact the invitee directly if needed.',
    )
    expect(recipients?.textContent).not.toContain('no cancellation emails can be sent')
    expect(api.to(cancelRoute())).toHaveLength(0)
  })

  it('refreshes the saved row and gives keyboard users a visible focus target after cancellation', async () => {
    let cancelled = false
    const current = booking()
    const api = server({
      [LIST]: () =>
        json(200, {
          data: [
            cancelled
              ? {
                  ...current,
                  status: 'cancelled',
                  cancelledAt: '2029-12-04T09:00:00.000Z',
                  eventType: { ...current.eventType, title: 'Refreshed team meeting' },
                }
              : current,
          ],
          nextCursor: null,
        }),
      [cancelRoute()]: () => {
        cancelled = true
        return json(200, { cancelled: true })
      },
    })
    const sheet = document.createElement('style')
    sheet.textContent = styles + bookingStyles
    document.head.append(sheet)
    try {
      const user = userEvent.setup()
      renderApp(PAGE)
      const opener = await screen.findByRole('button', { name: 'Team discovery call' })
      opener.focus()
      await user.keyboard('{Enter}')
      const openCancel = screen.getByRole('button', { name: 'Cancel booking…' })
      openCancel.focus()
      await user.keyboard('{Enter}')
      const submit = screen.getByRole('button', { name: 'Cancel booking' })
      submit.focus()
      await user.keyboard('{Enter}')
      await screen.findByText('The booking is cancelled.')
      expect(
        screen.getByText('Cancellation notifications are queued. Email delivery is not confirmed.'),
      ).toBeDefined()
      const refreshed = await screen.findByRole('button', { name: 'Refreshed team meeting' })
      expect(refreshed.closest('tr')?.textContent).toContain('Cancelled')
      expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Cancel booking…' })).toBeNull()
      await waitFor(() => {
        expectUsefulListFocus()
        const active = document.activeElement as HTMLElement
        expect(getComputedStyle(active).outline).toContain('solid')
        expect(getComputedStyle(active).outline).not.toContain('none')
      })
      await user.click(refreshed)
      const panel = within(screen.getByRole('region', { name: 'Team booking details' }))
      expect(panel.getByText('Cancelled', { selector: 'dd' })).toBeDefined()
      expect(panel.getAllByRole('definition')[5]?.querySelector('time')?.dateTime).toBe(
        '2029-12-04T09:00:00.000Z',
      )
      expect(api.to(LIST)).toHaveLength(2)
      expect(api.to(cancelRoute())).toHaveLength(1)
    } finally {
      sheet.remove()
    }
  })

  it('keeps the original booking and reason when cancellation fails, then permits a deliberate retry', async () => {
    let attempts = 0
    const api = server({
      [cancelRoute()]: () => {
        attempts += 1
        return attempts === 1
          ? json(500, { error: 'internal_error' })
          : json(200, { cancelled: true })
      },
    })
    const user = userEvent.setup()
    renderApp(PAGE)
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'Keep this explanation')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not cancel the booking.',
    )
    const row = screen.getByRole('button', { name: 'Team discovery call' }).closest('tr')
    expect(row?.textContent).toContain('Confirmed')
    expect(row?.textContent).not.toContain('Cancelled')
    const panel = within(screen.getByRole('region', { name: 'Team booking details' }))
    expect(panel.getByText('Confirmed', { selector: 'dd' })).toBeDefined()
    expect(panel.getAllByRole('definition')[5]?.textContent).toBe('Not set')
    expect(screen.getByDisplayValue('Keep this explanation')).toBeDefined()
    expect(screen.queryByText('The booking is cancelled.')).toBeNull()
    expect(api.to(LIST)).toHaveLength(1)
    const submit = screen.getByRole('button', { name: 'Cancel booking' })
    expect(submit.matches(':disabled')).toBe(false)
    await user.click(submit)
    await screen.findByText('The booking is cancelled.')
    expect(api.to(cancelRoute())).toHaveLength(2)
    expect(api.to(cancelRoute())[1]?.body).toEqual({ reason: 'Keep this explanation' })
  })

  it('sends one request when the confirmation is submitted twice before React can render its busy state', async () => {
    const pending = later()
    const api = server({ [cancelRoute()]: () => pending.response })
    const user = userEvent.setup()
    renderApp(PAGE)
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    const form = screen.getByRole('button', { name: 'Cancel booking' }).closest('form')
    expect(form).not.toBeNull()
    act(() => {
      fireEvent.submit(form as HTMLFormElement)
      fireEvent.submit(form as HTMLFormElement)
    })
    await waitFor(() => expect(api.to(cancelRoute())).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Cancelling…' }).matches(':disabled')).toBe(true)
    await pending.answer(json(200, { cancelled: true }))
    await screen.findByText('The booking is cancelled.')
    expect(api.to(cancelRoute())).toHaveLength(1)
  })

  it.each(['cancelled', 'moved'] as const)(
    'requires reload and shows the server state when an old page targets a booking already %s',
    async (change) => {
      let stale = false
      const original = booking()
      const api = server({
        [LIST]: () =>
          json(200, {
            data: stale
              ? [
                  { ...original, status: 'cancelled', cancelledAt: '2029-12-04T09:00:00.000Z' },
                  ...(change === 'moved' ? [booking(LATER_ID, 'Moved team meeting')] : []),
                ]
              : [original],
            nextCursor: null,
          }),
        [cancelRoute()]: () => {
          stale = true
          return json(409, { error: 'booking_already_cancelled' })
        },
      })
      const user = userEvent.setup()
      renderApp(PAGE)
      await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
      await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
      await user.type(screen.getByLabelText(/Reason/), 'Stale cancellation reason')
      await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
      expect((await screen.findByRole('alert')).textContent).toContain(
        'This booking was already cancelled. Reload to see the details.',
      )
      expect(screen.getByRole('button', { name: 'Cancel booking' }).matches(':disabled')).toBe(true)
      expect(screen.queryByText('The booking is cancelled.')).toBeNull()
      expect(api.to(LIST)).toHaveLength(1)
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      await user.click(screen.getByRole('button', { name: 'Reload' }))
      const title = await screen.findByRole('button', { name: 'Team discovery call' })
      expect(title.closest('tr')?.textContent).toContain('Cancelled')
      if (change === 'moved')
        expect(screen.getByRole('button', { name: 'Moved team meeting' })).toBeDefined()
      await user.click(title)
      expect(
        within(screen.getByRole('region', { name: 'Team booking details' })).getByText(
          'Cancelled',
          { selector: 'dd' },
        ),
      ).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Cancel booking…' })).toBeNull()
      expect(screen.queryByDisplayValue('Stale cancellation reason')).toBeNull()
      expect(api.to(cancelRoute())).toHaveLength(1)
      expect(api.to(cancelRoute())[0]?.headers.get('X-Expected-Organization-Id')).toBe(
        TEAM.organization.id,
      )
    },
  )
})

describe('cancelling a team booking loaded on a later page', () => {
  it.each([
    { confirmedOnly: false, failRefresh: false },
    { confirmedOnly: true, failRefresh: false },
    { confirmedOnly: false, failRefresh: true },
    { confirmedOnly: true, failRefresh: true },
  ])(
    'preserves loaded rows and useful focus with confirmed filter $confirmedOnly and failed refresh $failRefresh',
    async ({ confirmedOnly, failRefresh }) => {
      let cancelled = false
      let refreshUnavailable = failRefresh
      const later = booking(LATER_ID, 'Later page meeting')
      const api = server({
        [LIST]: ({ path }) => {
          if (cancelled && refreshUnavailable) return json(500, { error: 'internal_error' })
          const cursor = new URL(path, 'http://example.test').searchParams.get('cursor')
          if (!cursor)
            return json(200, {
              data: [booking(FIRST_ID, 'First page meeting')],
              nextCursor: 'page-two',
            })
          return json(200, {
            data: [
              ...(!cancelled
                ? [later]
                : confirmedOnly
                  ? []
                  : [
                      {
                        ...later,
                        status: 'cancelled',
                        cancelledAt: '2029-12-04T09:00:00.000Z',
                      },
                    ]),
              booking(FOLLOWING_ID, 'Following page meeting'),
            ],
            nextCursor: null,
          })
        },
        [cancelRoute(LATER_ID)]: () => {
          cancelled = true
          return json(200, { cancelled: true })
        },
      })
      const user = userEvent.setup()
      renderApp(confirmedOnly ? `${PAGE}?status=confirmed` : PAGE)
      await screen.findByRole('button', { name: 'First page meeting' })
      await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
      await user.click(await screen.findByRole('button', { name: 'Later page meeting' }))
      await cancelFromDetail(user)
      await screen.findByText('The booking is cancelled.')
      function expectRowsAfterCancellation() {
        expect(screen.getByRole('button', { name: 'First page meeting' })).toBeDefined()
        expect(screen.getByRole('button', { name: 'Following page meeting' })).toBeDefined()
        if (confirmedOnly) {
          expect(screen.queryByRole('button', { name: 'Later page meeting' })).toBeNull()
        } else {
          expect(
            screen.getByRole('button', { name: 'Later page meeting' }).closest('tr')?.textContent,
          ).toContain('Cancelled')
        }
      }
      await waitFor(() => {
        expectRowsAfterCancellation()
        expectUsefulListFocus()
      })
      if (failRefresh) {
        expect(await screen.findByRole('alert')).toBeDefined()
        expectRowsAfterCancellation()
        expectUsefulListFocus()
        refreshUnavailable = false
        await user.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => {
          expectRowsAfterCancellation()
          expect(screen.queryByRole('alert')).toBeNull()
        })
      }
      expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull()
      expect(api.to(cancelRoute(LATER_ID))).toHaveLength(1)
    },
  )
})
