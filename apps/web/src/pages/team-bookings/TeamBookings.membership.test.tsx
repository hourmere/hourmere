import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'

const PAGE = '/app/team/bookings'
const MEMBER = 'GET /api/auth/organization/get-active-member'
const LIST = 'GET /api/v1/team/bookings'
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}
const BOOKING: Schemas['TeamAdminBooking'] = {
  id: 'b0000000-0000-7000-8000-000000000001',
  status: 'confirmed',
  start: '2030-03-04T09:00:00.000Z',
  end: '2030-03-04T09:30:00.000Z',
  cancelledAt: null,
  eventType: {
    id: 'e0000000-0000-7000-8000-000000000001',
    title: 'Team discovery call',
    publicBookingPath: null,
  },
  hosts: [
    {
      userId: 'a0000000-0000-7000-8000-000000000001',
      name: 'Host',
      timeZone: 'Europe/London',
      isCurrentMember: true,
    },
  ],
  attendees: [{ name: 'Grace', email: 'grace@example.com', timeZone: 'UTC', isBooker: true }],
}
const member = (role = 'owner') => ({
  id: 'membership-1',
  organizationId: TEAM.organization.id,
  userId: TEAM.user.id,
  role,
  createdAt: '2026-10-01T09:00:00.000Z',
})
function server(overrides: Routes = {}) {
  return fakeApi({
    ...signedInAs(TEAM),
    ...profile(),
    'GET /api/v1/me': () => json(200, { ...TEAM }),
    'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM.organization]),
    [MEMBER]: () => json(200, member()),
    [LIST]: () => json(200, { data: [BOOKING], nextCursor: null }),
    ...overrides,
  })
}
async function openDraft() {
  renderApp(PAGE)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Team discovery call' }))
  await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
  await user.type(screen.getByLabelText(/Reason/), 'Draft reason')
  return {
    user,
    detail: screen.getByRole('region', { name: 'Team booking details' }),
    draft: screen.getByDisplayValue('Draft reason'),
    list: screen.getByRole('table'),
  }
}
function expectDraftKept(opened: Awaited<ReturnType<typeof openDraft>>) {
  expect(screen.getByRole('table')).toBe(opened.list)
  expect(screen.getByRole('region', { name: 'Team booking details' })).toBe(opened.detail)
  expect(screen.getByDisplayValue('Draft reason')).toBe(opened.draft)
  expect(screen.getByRole('link', { name: 'Team bookings' })).toBeDefined()
  expect(screen.queryByText('Could not load your team role.', { selector: 'p' })).toBeNull()
}

describe('team bookings membership refresh', () => {
  it('keeps the list, detail, draft and navigation on focus without rechecking unchanged identity', async () => {
    let failMember = false
    const api = server({
      [MEMBER]: () => (failMember ? json(500, { code: 'INTERNAL_ERROR' }) : json(200, member())),
    })
    const opened = await openDraft()
    expect(api.to(MEMBER)).toHaveLength(1)
    failMember = true

    await act(async () => fireEvent.focus(window))

    expect(api.to('GET /api/v1/me')).toHaveLength(2)
    expect(api.to(MEMBER)).toHaveLength(1)
    expect(api.to(LIST)).toHaveLength(1)
    expectDraftKept(opened)
  })

  it('keeps the list, detail, draft and navigation when opening the switcher fails to recheck the role', async () => {
    const recheck = later()
    let checking = false
    const api = server({
      [MEMBER]: async () => (checking ? (await recheck.response).clone() : json(200, member())),
    })
    const opened = await openDraft()
    checking = true

    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))
    expect(api.to(MEMBER)).toHaveLength(2)
    expectDraftKept(opened)
    await recheck.answer(json(500, { code: 'INTERNAL_ERROR' }))

    expectDraftKept(opened)
    expect(api.to(LIST)).toHaveLength(1)
    await opened.user.keyboard('{Escape}')
    await act(async () => fireEvent.focus(window))
    expectDraftKept(opened)
    expect(api.to(MEMBER)).toHaveLength(2)
    await opened.user.click(screen.getByRole('button', { name: 'Keep booking' }))
    expect(screen.getByRole('region', { name: 'Team booking details' })).toBe(opened.detail)
  })

  it.each(['network', 'timeout', 'rate-limit'] as const)(
    'keeps the cancellation draft when the membership recheck has a %s failure',
    async (failure) => {
      let checking = false
      const api = server({
        [MEMBER]: () => {
          if (checking) {
            if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError')
            if (failure === 'rate-limit') return json(429, { code: 'RATE_LIMITED' })
            throw new TypeError('Failed to fetch')
          }
          return json(200, member())
        },
      })
      const opened = await openDraft()
      checking = true

      await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))

      expect(api.to(MEMBER)).toHaveLength(2)
      expectDraftKept(opened)
      expect(api.to(LIST)).toHaveLength(1)
    },
  )

  it('leaves the page with a revoked message when a recheck confirms demotion', async () => {
    const recheck = later()
    let checking = false
    const api = server({
      [MEMBER]: async () =>
        checking ? (await recheck.response).clone() : json(200, member('admin')),
    })
    const opened = await openDraft()
    checking = true
    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))
    expectDraftKept(opened)

    await recheck.answer(json(200, member('member')))

    const revoked = await screen.findByRole('heading', {
      name: 'Team bookings access is no longer available.',
    })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(screen.queryByDisplayValue('Draft reason')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(within(screen.getByRole('main')).getByText('Access revoked')).toBeDefined()
    expect(document.activeElement).toBe(revoked)
    expect(api.to(MEMBER)).toHaveLength(2)
    expect(api.to(LIST)).toHaveLength(1)
  })

  it.each([
    [400, 'MEMBER_NOT_FOUND'],
    [403, 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION'],
    [403, 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION'],
    [404, undefined],
  ] as const)(
    'leaves the page when membership removal is confirmed by %s %s',
    async (status, code) => {
      let removed = false
      const api = server({
        [MEMBER]: () => (removed ? json(status, { code }) : json(200, member('admin'))),
      })
      const opened = await openDraft()
      removed = true

      await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))

      await screen.findByRole('heading', { name: 'Team bookings access is no longer available.' })
      expect(screen.queryByRole('table')).toBeNull()
      expect(screen.queryByDisplayValue('Draft reason')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
      expect(api.to(MEMBER)).toHaveLength(2)
      expect(api.to(LIST)).toHaveLength(1)
    },
  )

  it('does not restore a stale role from an aborted check after demotion', async () => {
    const staleCheck = later()
    const demotionCheck = later()
    let checks = 0
    const api = server({
      [MEMBER]: async () => {
        checks++
        if (checks === 1) return json(200, member('admin'))
        if (checks === 2) return (await staleCheck.response).clone()
        if (checks === 3) return (await demotionCheck.response).clone()
        return json(500, { code: 'INTERNAL_ERROR' })
      },
    })
    const opened = await openDraft()
    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))
    await opened.user.keyboard('{Escape}')
    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))
    await demotionCheck.answer(json(200, member('member')))
    await screen.findByRole('heading', { name: 'Team bookings access is no longer available.' })

    await staleCheck.answer(json(200, member('admin')))
    await opened.user.keyboard('{Escape}')
    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))

    expect(api.to(MEMBER)).toHaveLength(4)
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(1)
  })

  it('does not restore an older switcher role after a cancellation recheck confirms demotion', async () => {
    const switcherCheck = later()
    let checks = 0
    const cancel = `POST /api/v1/team/bookings/${BOOKING.id}/cancel`
    const api = server({
      [MEMBER]: async () => {
        checks++
        if (checks === 1) return json(200, member('admin'))
        if (checks === 2) return (await switcherCheck.response).clone()
        return json(200, member('member'))
      },
      [cancel]: () => json(403, { error: 'team_management_access_denied' }),
    })
    const opened = await openDraft()
    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))
    await opened.user.keyboard('{Escape}')

    await opened.user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    const revoked = await screen.findByRole('heading', {
      name: 'Team bookings access is no longer available.',
    })
    expect(api.to(MEMBER)).toHaveLength(3)
    await switcherCheck.answer(json(200, member('admin')))

    expect(
      screen.getByRole('heading', { name: 'Team bookings access is no longer available.' }),
    ).toBe(revoked)
    expect(screen.queryByRole('link', { name: 'Team bookings' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Team booking details' })).toBeNull()
    expect(api.to(cancel)).toHaveLength(1)
    expect(api.to(LIST)).toHaveLength(1)
  })

  it('keeps the newer admin role when an older switcher check returns owner', async () => {
    const switcherCheck = later()
    let checks = 0
    const cancel = `POST /api/v1/team/bookings/${BOOKING.id}/cancel`
    const api = server({
      [MEMBER]: async () => {
        checks++
        if (checks === 1) return json(200, member('owner'))
        if (checks === 2) return (await switcherCheck.response).clone()
        return json(200, member('admin'))
      },
      [cancel]: () => json(403, { error: 'team_management_access_denied' }),
    })
    const opened = await openDraft()
    const main = within(screen.getByRole('main'))
    expect(main.getByText('Owner')).toBeDefined()
    await opened.user.click(screen.getByRole('button', { name: /Switch space/ }))
    await opened.user.keyboard('{Escape}')

    await opened.user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await main.findByText(
      'This booking can no longer be cancelled. It may have started or become unavailable.',
    )
    expect(main.getByText('Admin')).toBeDefined()
    expect(api.to(MEMBER)).toHaveLength(3)
    await switcherCheck.answer(json(200, member('owner')))

    expect(main.getByText('Admin')).toBeDefined()
    expect(main.queryByText('Owner')).toBeNull()
    expect(screen.getByRole('link', { name: 'Team bookings' })).toBeDefined()
    expect(screen.getByRole('table')).toBeDefined()
    expect(
      screen.queryByRole('heading', { name: 'Team bookings access is no longer available.' }),
    ).toBeNull()
    expect(api.to(cancel)).toHaveLength(1)
    expect(api.to(MEMBER)).toHaveLength(3)
  })
})
