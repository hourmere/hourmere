import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'

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
      started: 'This booking has already started, so it can no longer be cancelled.',
      revoked: 'Team bookings access is no longer available.',
    },
    {
      locale: 'zh-CN',
      nav: '团队预约',
      detail: '团队预约详情',
      openCancel: '取消预约…',
      submitCancel: '取消预约',
      started: '此预约已开始，无法取消。',
      revoked: '团队预约访问权限已失效。',
    },
  ] as const)('keeps access and refreshes a started booking in $locale', async (copy) => {
    chooseLanguage(copy.locale)
    let started = false
    const api = server({
      ...profile({ ...PROFILE, locale: copy.locale }),
      [LIST]: () =>
        json(200, {
          data: [booking(FIRST_ID, started ? 'Updated started meeting' : 'Team discovery call')],
          nextCursor: null,
        }),
      [cancelRoute()]: () => {
        started = true
        return json(403, { error: 'booking_in_past' })
      },
    })
    const user = userEvent.setup()
    renderApp(PAGE)
    await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
    await user.click(screen.getByRole('button', { name: copy.openCancel }))
    await user.click(screen.getByRole('button', { name: copy.submitCancel }))
    await screen.findByText(copy.started)
    expect(screen.getByRole('link', { name: copy.nav })).toBeDefined()
    expect(screen.queryByText(copy.revoked)).toBeNull()
    await screen.findByRole('button', { name: 'Updated started meeting' })
    const panel = screen.getByRole('region', { name: copy.detail })
    expect(await within(panel).findByText('Updated started meeting')).toBeDefined()
    expect(screen.getByRole('button', { name: copy.submitCancel }).matches(':disabled')).toBe(true)
    expect(api.to(LIST).length).toBeGreaterThan(1)
    expect(api.to(cancelRoute())).toHaveLength(1)
  })

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
