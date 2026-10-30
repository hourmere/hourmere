import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ListedOrganizationMember } from '../api/auth.ts'
import type { Schemas } from '../api/client.ts'
import { TeamMemberActions } from '../components/team-members/TeamMemberActions.tsx'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { bookingPath, eventTypePath, PATHS } from '../paths.ts'
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
} from '../test/fake-api.tsx'

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const TEAM_ME: Schemas['Me'] = {
  ...ME,
  organization: { id: TEAM_ID, name: 'Example team', slug: 'example-team', personal: false },
}
const OWNER_ID = '00000000-0000-7000-8000-000000000011'
const ADMIN_ID = '00000000-0000-7000-8000-000000000012'
const MEMBER_ID = '00000000-0000-7000-8000-000000000013'
const OPERATION_ID = '00000000-0000-7000-8000-000000000014'
const LEAVE_ROUTE = `POST /api/v1/teams/${TEAM_ID}/leave`
const handlingRoute = `GET /api/v1/team/member-removals/${OPERATION_ID}`
const impactRoute = (userId: string) => `GET /api/v1/team/members/${userId}/departure-impact`
const removalRoute = (userId: string) => `POST /api/v1/team/members/${userId}/removal`
const EVALUATED_AT = '2026-10-30T10:00:00.000Z'

function member(userId: string, name: string, role: string): ListedOrganizationMember {
  return {
    id: `membership-${userId}`,
    organizationId: TEAM_ID,
    userId,
    role,
    createdAt: '2026-10-27T10:00:00.000Z',
    user: { id: userId, name, email: `${role}@example.com` },
  }
}

const owner = member(OWNER_ID, 'Other owner', 'owner')
const admin = member(ADMIN_ID, 'Team admin', 'admin')
const ordinaryMember = member(MEMBER_ID, 'Team member', 'member')

function eventType(number = 1): Schemas['MemberDepartureImpact']['eventTypes']['data'][number] {
  return {
    id: `00000000-0000-7000-8000-${String(100 + number).padStart(12, '0')}`,
    title: `Team consultation ${number}`,
    slug: `team-consultation-${number}`,
    schedulingType: 'individual',
    isActive: true,
    reason: 'sole_host',
    remainingHostCount: 0,
  }
}

function booking(
  number = 1,
  inProgress = false,
): Schemas['MemberDepartureImpact']['bookings']['data'][number] {
  return {
    id: `00000000-0000-7000-8000-${String(200 + number).padStart(12, '0')}`,
    eventType: { id: eventType().id, title: `Saved meeting ${number}` },
    start: inProgress ? '2026-10-30T09:30:00.000Z' : '2026-11-02T10:00:00.000Z',
    end: inProgress ? '2026-10-30T10:30:00.000Z' : '2026-11-02T10:30:00.000Z',
    status: 'confirmed',
    cancelledAt: null,
    inProgress,
    handling: inProgress ? 'wait_until_end_or_coordinate_offline' : 'coordinate_cancellation',
    hosts: [{ userId: MEMBER_ID, name: 'Saved host' }],
    attendees: [
      {
        name: `Guest ${number}`,
        email: `guest-${number}@example.com`,
        timeZone: 'UTC',
        isBooker: true,
      },
    ],
  }
}

function impact(
  eventTypes: Schemas['MemberDepartureImpact']['eventTypes']['data'] = [],
  bookings: Schemas['MemberDepartureImpact']['bookings']['data'] = [],
): Schemas['MemberDepartureImpact'] {
  return {
    evaluatedAt: EVALUATED_AT,
    eventTypes: { data: eventTypes, nextCursor: null, totalCount: eventTypes.length },
    bookings: { data: bookings, nextCursor: null, totalCount: bookings.length },
  }
}

function handling(
  bookings: Schemas['MemberRemovalHandling']['bookings']['data'] = [],
): Schemas['MemberRemovalHandling'] {
  return {
    id: OPERATION_ID,
    memberUserId: MEMBER_ID,
    reason: 'member_removed',
    removedAt: EVALUATED_AT,
    evaluatedAt: EVALUATED_AT,
    bookings: { data: bookings, nextCursor: null, totalCount: bookings.length },
  }
}

function removed(userId = MEMBER_ID): Schemas['MemberRemoval'] {
  return { operationId: OPERATION_ID, memberUserId: userId, deactivatedEventTypeIds: [] }
}

function teamServer(role = 'member', routes: Routes = {}) {
  const self = member(ME.user.id, 'Ada', role)
  return fakeApi({
    ...signedInAs(TEAM_ME),
    ...profile(PROFILE),
    'GET /api/auth/organization/get-active-member': () => json(200, self),
    'GET /api/auth/organization/list-members': () =>
      json(200, { members: [self, owner, admin, ordinaryMember], total: 4 }),
    'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
    [impactRoute(ME.user.id)]: () => json(200, impact()),
    [impactRoute(MEMBER_ID)]: () => json(200, impact()),
    [impactRoute(ADMIN_ID)]: () => json(200, impact()),
    [handlingRoute]: () => json(200, handling()),
    ...routes,
  })
}

async function openLeave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Leave team' }))
  await screen.findByRole('heading', { name: 'Review leaving this team' })
}

async function openRemoval(user: ReturnType<typeof userEvent.setup>, name = 'Team member') {
  await user.click(await screen.findByRole('button', { name: `Remove member: ${name}` }))
  await screen.findByRole('heading', { name: 'Remove team member' })
}

function eventManagementLink(title: string) {
  const item = screen.getByText(title).closest('li')
  if (!item) throw new Error('Expected event type list item')
  return within(item).getByRole('link', { name: 'Manage event type' })
}

function impactItem(title: string) {
  const item = screen.getByText(title).closest('li')
  if (!item) throw new Error('Expected impact list item')
  return within(item)
}

function hostedBooking(number = 1, inProgress = false) {
  return { ...booking(number, inProgress), hosts: [{ userId: ME.user.id, name: 'Ada' }] }
}

function expectBookingLink(number: number, offered: boolean) {
  const links = impactItem(`Saved meeting ${number}`).queryAllByRole('link')
  expect(links.some((link) => link.getAttribute('href') === bookingPath(booking(number).id))).toBe(
    offered,
  )
}

function expectNoRemovalSuccess() {
  expect(screen.queryByText('Member removed. Access was revoked immediately.')).toBeNull()
}

const blockedHandling = {
  eventTypes: 'ask_admin_to_replace_or_remove_host',
  futureBookings: 'coordinate_cancellation',
  inProgressBookings: 'wait_until_end_or_coordinate_offline',
}

describe('team member leave actions', () => {
  it('previews impact before confirming leave, waits for the server, and refreshes into personal space', async () => {
    const user = userEvent.setup()
    const preview = later()
    const departure = later()
    let left = false
    const api = teamServer('member', {
      [impactRoute(ME.user.id)]: () => preview.response,
      [LEAVE_ROUTE]: async () => {
        const response = await departure.response
        left = true
        return response
      },
      'GET /api/v1/me': () => json(200, left ? ME : TEAM_ME),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    expect(screen.getByText('Loading departure impact…')).toBeDefined()
    expect(api.to(LEAVE_ROUTE)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Leave this team' })).toBeNull()
    await preview.answer(json(200, impact()))
    await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
    expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
    expect(screen.queryByText('You left the team. Reload to open your personal space.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: 'Review leaving this team' })).toBeDefined()
    expect(api.to(LEAVE_ROUTE)[0]).toMatchObject({ body: {} })
    expect(api.to(LEAVE_ROUTE)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM_ID)
    expect(api.to('GET /api/v1/me')).toHaveLength(1)
    expect(screen.queryByText(/You are now in your personal space/)).toBeNull()
    expect(screen.queryByText('You left the team. Reload to open your personal space.')).toBeNull()
    expect(screen.getByRole('region', { name: 'Team members' })).toBeDefined()
    await departure.answer(json(200, { organizationId: ME.personalOrganizationId }))
    await screen.findByText(
      'You are now in your personal space. Your team access or active space changed.',
    )
    expect(screen.queryByRole('region', { name: 'Team members' })).toBeNull()
    expect(api.to('GET /api/v1/me')).toHaveLength(2)
  })

  it.each(['Close details', 'Escape'])(
    'keeps confirmed leave and reload available after %s closes a failed personal-space refresh',
    async (method) => {
      const user = userEvent.setup()
      let left = false
      let failRefresh = true
      const api = teamServer('member', {
        [LEAVE_ROUTE]: () => {
          left = true
          return json(200, { organizationId: ME.personalOrganizationId })
        },
        'GET /api/v1/me': () =>
          !left
            ? json(200, TEAM_ME)
            : failRefresh
              ? json(503, { error: 'internal_error' })
              : json(200, ME),
      })
      renderApp(PATHS.settings)
      await openLeave(user)
      await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
      await screen.findByText('You left the team. Reload to open your personal space.')
      expect(screen.queryByRole('button', { name: 'Leave this team' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Reload team' })).toBeDefined()
      expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
      expect(api.to('GET /api/v1/me')).toHaveLength(2)
      expect(screen.queryByText(/You are now in your personal space/)).toBeNull()
      if (method === 'Escape') await user.keyboard('{Escape}')
      else await user.click(screen.getByRole('button', { name: 'Close details' }))
      expect(screen.queryByRole('heading', { name: 'Review leaving this team' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Leave team' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Leave this team' })).toBeNull()
      expect(
        screen.getByText('You left the team. Reload to open your personal space.'),
      ).toBeDefined()
      expect(screen.getByRole('button', { name: 'Reload team' })).toBeDefined()
      expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
      failRefresh = false
      await user.click(screen.getByRole('button', { name: 'Reload team' }))
      await screen.findByText(
        'You are now in your personal space. Your team access or active space changed.',
      )
      expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
      expect(api.to('GET /api/v1/me')).toHaveLength(3)
    },
  )

  it('uses the write refusal impact, showing each event, future booking and in-progress handling path', async () => {
    const user = userEvent.setup()
    const concreteImpact = impact([eventType()], [booking(), booking(2, true)])
    const api = teamServer('owner', {
      [LEAVE_ROUTE]: () =>
        json(409, {
          error: 'member_departure_blocked',
          message: 'Handle the listed team dependencies before leaving.',
          impact: concreteImpact,
          handling: blockedHandling,
        }),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/before.*leav|cannot.*leav/i)
    expect(await screen.findByText(eventType().title)).toBeDefined()
    expect(screen.getByText('Saved meeting 1')).toBeDefined()
    expect(screen.getByText('Saved meeting 2')).toBeDefined()
    expect(screen.getByText('Replace or remove yourself as a host before leaving.')).toBeDefined()
    expect(screen.queryByText(/replace or remove this member/i)).toBeNull()
    expect(screen.getByText(/coordinate.*cancellation/i)).toBeDefined()
    expect(screen.getByText(/wait.*end.*offline/i)).toBeDefined()
    expect(eventManagementLink(eventType().title).getAttribute('href')).toBe(
      eventTypePath(eventType().id),
    )
    expect(
      screen.getAllByRole('link').some((link) => link.getAttribute('href') === PATHS.teamBookings),
    ).toBe(true)
    expect(screen.getByRole('region', { name: 'Team members' })).toBeDefined()
    expect(api.to('GET /api/v1/me')).toHaveLength(1)
  })

  it('explains to an ordinary member which administrator help is required without offering management links', async () => {
    const user = userEvent.setup()
    teamServer('member', {
      [impactRoute(ME.user.id)]: () => json(200, impact([eventType()], [booking()])),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await screen.findByText(eventType().title)
    expect(
      screen.getByText('Ask a team owner or admin to replace or remove you as a host.'),
    ).toBeDefined()
    expect(
      screen.getByText('Only team owners and admins can change team event types.'),
    ).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Manage event type' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Review team bookings' })).toBeNull()
  })

  it.each(['preview', 'blocked'])(
    'links an ordinary member to their own future hosted booking in the %s impact',
    async (response) => {
      const user = userEvent.setup()
      const dependencies = impact([], [hostedBooking(), hostedBooking(2, true)])
      teamServer('member', {
        [impactRoute(ME.user.id)]: () =>
          json(200, response === 'preview' ? dependencies : impact()),
        [LEAVE_ROUTE]: () =>
          json(409, {
            error: 'member_departure_blocked',
            impact: dependencies,
            handling: blockedHandling,
          }),
      })
      renderApp(PATHS.settings)
      await openLeave(user)
      if (response === 'blocked')
        await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
      await screen.findByText('Saved meeting 1')
      expectBookingLink(1, true)
      expectBookingLink(2, false)
      expect(screen.queryByRole('link', { name: 'Review team bookings' })).toBeNull()
      expect(
        screen.getByText(
          'You can cancel your own hosted bookings before they start. Ask a team owner or admin for help with other team bookings.',
        ),
      ).toBeDefined()
      expect(screen.queryByText('Team owners and admins can handle team bookings.')).toBeNull()
    },
  )

  it.each(['owner', 'admin', 'member'])(
    'explains every event dependency in the second person when a %s leaves',
    async (role) => {
      const user = userEvent.setup()
      const sole = eventType()
      const pool = {
        ...eventType(2),
        schedulingType: 'round_robin' as const,
        reason: 'round_robin_pool_member' as const,
        remainingHostCount: 2,
      }
      const collective = {
        ...eventType(3),
        schedulingType: 'collective' as const,
        reason: 'collective_required_host' as const,
        remainingHostCount: 1,
      }
      teamServer(role, {
        [impactRoute(ME.user.id)]: () => json(200, impact([sole, pool, collective])),
      })
      renderApp(PATHS.settings)
      await openLeave(user)
      await screen.findByText(collective.title)
      expect(
        impactItem(sole.title).getByText('You are the sole host for this event type.'),
      ).toBeDefined()
      expect(
        impactItem(pool.title).getByText('You are in the round-robin host pool.'),
      ).toBeDefined()
      expect(
        impactItem(pool.title).getByText('2 other current verified team hosts remain.'),
      ).toBeDefined()
      expect(
        impactItem(collective.title).getByText(
          'You are a required host for this collective event type.',
        ),
      ).toBeDefined()
      expect(screen.queryByText(/replace or remove this member/i)).toBeNull()
      if (role === 'member') {
        expect(screen.queryByRole('link', { name: 'Manage event type' })).toBeNull()
        expect(
          screen.getByText('Only team owners and admins can change team event types.'),
        ).toBeDefined()
      } else {
        expect(
          screen.getByText('Replace or remove yourself as a host before leaving.'),
        ).toBeDefined()
        for (const event of [sole, pool, collective])
          expect(eventManagementLink(event.title).getAttribute('href')).toBe(
            eventTypePath(event.id),
          )
      }
    },
  )

  it('uses self-leave permission wording and reload guidance for a forbidden departure', async () => {
    const user = userEvent.setup()
    const api = teamServer('member', {
      [LEAVE_ROUTE]: () => json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Your permission or team membership changed. Reload to check before trying again.',
    )
    expect(alert.textContent).not.toMatch(/this member/i)
    expect(within(alert).getByRole('button', { name: 'Reload team' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Leave this team' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
  })

  it('shows the last-owner refusal and never reports departure', async () => {
    const user = userEvent.setup()
    const api = teamServer('owner', {
      [LEAVE_ROUTE]: () =>
        json(409, {
          error: 'member_departure_owner_required',
          message: 'The team must retain at least one owner.',
          handling: {
            owner: 'another_owner_is_needed_before_you_can_leave',
            nextStep: 'add_another_owner_first',
          },
        }),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/another owner|retain.*owner/i)
    expect(screen.queryByText(/You are now in your personal space/)).toBeNull()
    expect(screen.getByRole('region', { name: 'Team members' })).toBeDefined()
    expect(api.to('GET /api/v1/me')).toHaveLength(1)
  })

  it.each([403, 503])('keeps the current team when leave receives HTTP %s', async (status) => {
    const user = userEvent.setup()
    const api = teamServer('member', {
      [LEAVE_ROUTE]: () =>
        json(status, {
          error: status === 403 ? 'team_management_access_denied' : 'internal_error',
        }),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('region', { name: 'Team members' })).toBeDefined()
    expect(screen.queryByText(/You are now in your personal space/)).toBeNull()
    expect(api.to('GET /api/v1/me')).toHaveLength(1)
  })
})

describe('team member removal actions', () => {
  it('offers managers their own future host links alongside team booking handling, before and after removal', async () => {
    const user = userEvent.setup()
    const bookings = [hostedBooking(), booking(2), hostedBooking(3, true)]
    teamServer('owner', {
      [impactRoute(MEMBER_ID)]: () => json(200, impact([], bookings)),
      [removalRoute(MEMBER_ID)]: () => json(200, removed()),
      [handlingRoute]: () => json(200, handling(bookings)),
    })
    renderApp(PATHS.settings)
    await openRemoval(user)
    await screen.findByText('Saved meeting 1')
    expectBookingLink(1, true)
    expectBookingLink(2, false)
    expectBookingLink(3, false)
    expect(screen.getByRole('link', { name: 'Review team bookings' }).getAttribute('href')).toBe(
      PATHS.teamBookings,
    )
    await user.click(screen.getByRole('button', { name: 'Remove member' }))
    await screen.findByRole('heading', { name: 'Handling list' })
    await screen.findByText('Saved meeting 1')
    expectBookingLink(1, true)
    expectBookingLink(2, false)
    expectBookingLink(3, false)
    expect(screen.getByRole('link', { name: 'Review team bookings' }).getAttribute('href')).toBe(
      PATHS.teamBookings,
    )
  })

  it.each([
    ['owner', 'member', MEMBER_ID, 'Team member'],
    ['owner', 'admin', ADMIN_ID, 'Team admin'],
    ['admin', 'member', MEMBER_ID, 'Team member'],
  ])(
    'lets an %s remove a %s after confirmation and shows the handling list',
    async (actorRole, _targetRole, userId, name) => {
      const user = userEvent.setup()
      let wasRemoved = false
      const api = teamServer(actorRole, {
        [impactRoute(userId)]: () =>
          json(200, impact([eventType()], [booking(), booking(2, true)])),
        [removalRoute(userId)]: () => {
          wasRemoved = true
          return json(200, { ...removed(userId), deactivatedEventTypeIds: [eventType().id] })
        },
        [handlingRoute]: () =>
          json(200, { ...handling([booking(), booking(2, true)]), memberUserId: userId }),
        'GET /api/auth/organization/list-members': () =>
          json(200, {
            members: [member(ME.user.id, 'Ada', actorRole), owner, admin, ordinaryMember].filter(
              (item) => !wasRemoved || item.userId !== userId,
            ),
            total: wasRemoved ? 3 : 4,
          }),
      })
      renderApp(PATHS.settings)
      await openRemoval(user, name)
      await screen.findByText(eventType().title)
      expect(eventManagementLink(eventType().title).getAttribute('href')).toBe(
        eventTypePath(eventType().id),
      )
      expect(screen.getByText(/access.*revoked immediately/i)).toBeDefined()
      expect(screen.getByText(/future bookings.*handling|bookings.*still.*handling/i)).toBeDefined()
      expect(screen.getByText('2 future or in-progress bookings')).toBeDefined()
      expect(api.to(removalRoute(userId))).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: 'Remove member' }))
      await screen.findByText('Member removed. Access was revoked immediately.')
      await screen.findByRole('heading', { name: 'Handling list' })
      await screen.findByText('Saved meeting 1')
      expect(screen.getByText('Saved meeting 2')).toBeDefined()
      expect(api.to(removalRoute(userId))).toHaveLength(1)
      expect(api.to(removalRoute(userId))[0]?.body).toEqual({ teamId: TEAM_ID })
      expect(api.to(removalRoute(userId))[0]?.headers.get('X-Expected-Organization-Id')).toBe(
        TEAM_ID,
      )
      expect(api.to(handlingRoute)[0]?.path).toContain(`teamId=${TEAM_ID}`)
      const members = screen.getByRole('region', { name: 'Team members' })
      await within(members).findByText('3 joined members')
      expect(within(members).queryByText(name, { selector: 'span' })).toBeNull()
    },
  )

  it.each(['owner', 'admin', 'member', 'custom-admin', 'OWNER'])(
    'offers removal only for exact permitted roles when the actor is %s',
    async (role) => {
      teamServer(role)
      renderApp(PATHS.settings)
      await screen.findByText('Team member', { selector: 'span' })
      await screen.findByRole('button', { name: 'Leave team' })
      expect(screen.queryByRole('button', { name: 'Remove member: Other owner' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove member: Ada' })).toBeNull()
      expect(Boolean(screen.queryByRole('button', { name: 'Remove member: Team admin' }))).toBe(
        role === 'owner',
      )
      expect(Boolean(screen.queryByRole('button', { name: 'Remove member: Team member' }))).toBe(
        ['owner', 'admin'].includes(role),
      )
    },
  )

  it('treats an owner token in a composite target role as an owner and never offers remove', async () => {
    teamServer('owner', {
      'GET /api/auth/organization/list-members': () =>
        json(200, { members: [{ ...ordinaryMember, role: 'member, owner' }], total: 1 }),
    })
    renderApp(PATHS.settings)
    await screen.findByText('Team member', { selector: 'span' })
    expect(screen.queryByRole('button', { name: 'Remove member: Team member' })).toBeNull()
  })

  it('shows a server denial for a crafted stale-permission removal without reporting success', async () => {
    const user = userEvent.setup()
    const api = teamServer('owner', {
      [removalRoute(ADMIN_ID)]: () => json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(PATHS.settings)
    await openRemoval(user, 'Team admin')
    await user.click(await screen.findByRole('button', { name: 'Remove member' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission|access|no longer/i)
    expectNoRemovalSuccess()
    expect(screen.getByRole('region', { name: 'Team members' }).textContent).toContain('Team admin')
    expect(api.to(handlingRoute)).toHaveLength(0)
  })

  it.each([admin, owner])(
    'shows the server refusal for a crafted admin removal of an $role',
    async (target) => {
      const user = userEvent.setup()
      const onRemoved = vi.fn()
      const actorRole = 'admin'
      const api = fakeApi({
        [impactRoute(target.userId)]: () => json(200, impact()),
        [removalRoute(target.userId)]: () => json(403, { error: 'team_management_access_denied' }),
      })
      render(
        <MemoryRouter>
          <InterfaceScope surface="admin">
            <TeamMemberActions
              organizationId={TEAM_ID}
              currentUserId={ME.user.id}
              role={actorRole}
              selectedMember={target}
              onClose={() => {}}
              onRemoved={onRemoved}
              onLeft={() => {}}
              onReload={() => {}}
            />
          </InterfaceScope>
        </MemoryRouter>,
      )
      await user.click(await screen.findByRole('button', { name: 'Remove member' }))
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /permission|membership changed/i,
      )
      expectNoRemovalSuccess()
      expect(onRemoved).not.toHaveBeenCalled()
      expect(api.to(removalRoute(target.userId))).toHaveLength(1)
      expect(
        api.to(removalRoute(target.userId))[0]?.headers.get('X-Expected-Organization-Id'),
      ).toBe(TEAM_ID)
    },
  )

  it.each([403, 503])(
    'keeps the member and avoids false success on removal HTTP %s, including a target already gone',
    async (status) => {
      const user = userEvent.setup()
      const api = teamServer('owner', {
        [removalRoute(MEMBER_ID)]: () =>
          json(status, {
            error: status === 403 ? 'team_management_access_denied' : 'internal_error',
          }),
      })
      renderApp(PATHS.settings)
      await openRemoval(user)
      await user.click(await screen.findByRole('button', { name: 'Remove member' }))
      await screen.findByRole('alert')
      expectNoRemovalSuccess()
      expect(screen.getByRole('region', { name: 'Team members' }).textContent).toContain(
        'Team member',
      )
      expect(api.to(handlingRoute)).toHaveLength(0)
      expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(1)
    },
  )

  it('does not remove the row or announce success while the removal is still in flight', async () => {
    const user = userEvent.setup()
    const response = later()
    const api = teamServer('owner', { [removalRoute(MEMBER_ID)]: () => response.response })
    renderApp(PATHS.settings)
    await openRemoval(user)
    await user.click(await screen.findByRole('button', { name: 'Remove member' }))
    expect(api.to(removalRoute(MEMBER_ID))).toHaveLength(1)
    expectNoRemovalSuccess()
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: 'Remove team member' })).toBeDefined()
    const otherTarget = screen.getByRole('button', { name: 'Remove member: Team admin' })
    expect(otherTarget.hasAttribute('disabled')).toBe(true)
    await user.click(otherTarget)
    expect(
      within(screen.getByRole('region', { name: 'Remove team member' })).getByText('Team member'),
    ).toBeDefined()
    expect(api.to(impactRoute(ADMIN_ID))).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Team members' }).textContent).toContain(
      'Team member',
    )
    expect(api.to(handlingRoute)).toHaveLength(0)
    await response.answer(json(200, removed()))
    await screen.findByText('Member removed. Access was revoked immediately.')
  })

  it('keeps confirmed removal separate from a failed handling fetch and retries only the read', async () => {
    const user = userEvent.setup()
    let fail = true
    const api = teamServer('admin', {
      [removalRoute(MEMBER_ID)]: () => json(200, removed()),
      [handlingRoute]: () =>
        fail ? json(503, { error: 'internal_error' }) : json(200, handling([booking()])),
    })
    renderApp(PATHS.settings)
    await openRemoval(user)
    await user.click(await screen.findByRole('button', { name: 'Remove member' }))
    await screen.findByText('Member removed. Access was revoked immediately.')
    await screen.findByText('Could not load the handling list. The member is still removed.')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry handling list' }))
    await screen.findByText('Saved meeting 1')
    expect(api.to(removalRoute(MEMBER_ID))).toHaveLength(1)
    expect(api.to(handlingRoute)).toHaveLength(2)
  })
})

describe('member action recovery and accessibility', () => {
  it.each(['eventTypes', 'bookings'] as const)(
    'keeps the leave block alongside a failed %s page and only retries the read',
    async (kind) => {
      const user = userEvent.setup()
      let failPage = true
      const blocked = impact([eventType()], [hostedBooking()])
      blocked[kind].nextCursor = 'impact-next'
      blocked[kind].totalCount = 2
      const api = teamServer('owner', {
        [impactRoute(ME.user.id)]: ({ path }) => {
          if (!new URL(path, window.location.origin).searchParams.has(`${kind}Cursor`))
            return json(200, impact())
          return failPage
            ? json(503, { error: 'internal_error' })
            : json(200, impact([eventType(2)], [hostedBooking(2)]))
        },
        [LEAVE_ROUTE]: () =>
          json(409, {
            error: 'member_departure_blocked',
            impact: blocked,
            handling: blockedHandling,
          }),
      })
      renderApp(PATHS.settings)
      await openLeave(user)
      await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
      const reason = 'You cannot leave while team events or bookings still need handling.'
      await screen.findByText(reason)
      const pageButton = () =>
        screen.getByRole('button', {
          name: kind === 'eventTypes' ? 'More event types' : 'More bookings',
        })
      await user.click(pageButton())
      const readError = 'Something went wrong on our side. Try again in a moment.'
      await screen.findByText(readError)
      const alerts = screen.getAllByRole('alert')
      expect(alerts).toHaveLength(2)
      expect(alerts.some((alert) => alert.textContent?.includes(reason))).toBe(true)
      expect(alerts.some((alert) => alert.textContent?.includes(readError))).toBe(true)
      expect(screen.getByText(eventType().title)).toBeDefined()
      expect(screen.getByText('Saved meeting 1')).toBeDefined()
      failPage = false
      await user.click(pageButton())
      await screen.findByText(kind === 'eventTypes' ? eventType(2).title : 'Saved meeting 2')
      expect(screen.queryByText(readError)).toBeNull()
      expect(screen.getByRole('alert').textContent).toContain(reason)
      expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
      const reads = api.to(impactRoute(ME.user.id))
      expect(reads).toHaveLength(3)
      expect(
        reads
          .slice(1)
          .map(({ path }) =>
            new URL(path, window.location.origin).searchParams.get(`${kind}Cursor`),
          ),
      ).toEqual(['impact-next', 'impact-next'])
    },
  )

  it.each(['eventTypes', 'bookings'] as const)(
    'preserves the server leave block while paging %s and after the page arrives',
    async (kind) => {
      const user = userEvent.setup()
      const page = later()
      const blocked = impact([eventType()], [hostedBooking()])
      blocked[kind].nextCursor = 'impact-next'
      blocked[kind].totalCount = 2
      const api = teamServer('owner', {
        [impactRoute(ME.user.id)]: ({ path }) =>
          new URL(path, window.location.origin).searchParams.has(`${kind}Cursor`)
            ? page.response
            : json(200, impact()),
        [LEAVE_ROUTE]: () =>
          json(409, {
            error: 'member_departure_blocked',
            impact: blocked,
            handling: blockedHandling,
          }),
      })
      renderApp(PATHS.settings)
      await openLeave(user)
      await user.click(await screen.findByRole('button', { name: 'Leave this team' }))
      const reason = 'You cannot leave while team events or bookings still need handling.'
      await screen.findByText(reason)
      await user.click(
        screen.getByRole('button', {
          name: kind === 'eventTypes' ? 'More event types' : 'More bookings',
        }),
      )
      expect(screen.getByRole('alert').textContent).toContain(reason)
      expect(
        screen.getByText(
          'Disabled event types still need their host assignments repaired before you can leave.',
        ),
      ).toBeDefined()
      await page.answer(json(200, impact([eventType(2)], [hostedBooking(2)])))
      await screen.findByText(kind === 'eventTypes' ? eventType(2).title : 'Saved meeting 2')
      expect(screen.getByRole('alert').textContent).toContain(reason)
      expect(screen.getByText(eventType().title)).toBeDefined()
      expect(screen.getByText('Saved meeting 1')).toBeDefined()
      expect(api.to(LEAVE_ROUTE)).toHaveLength(1)
      expect(api.to(impactRoute(ME.user.id))).toHaveLength(2)
    },
  )

  it.each(['leave', 'remove'])(
    'requires a team reload after a 409 %s context conflict',
    async (action) => {
      const user = userEvent.setup()
      let contextChanged = false
      const route = action === 'leave' ? LEAVE_ROUTE : removalRoute(MEMBER_ID)
      const pagedImpact = impact([eventType()], [booking()])
      pagedImpact.eventTypes.nextCursor = 'event-next'
      pagedImpact.bookings.nextCursor = 'booking-next'
      const previewRoute = impactRoute(action === 'leave' ? ME.user.id : MEMBER_ID)
      const api = teamServer('owner', {
        [previewRoute]: () => json(200, pagedImpact),
        [route]: () => {
          contextChanged = true
          return json(409, { error: 'organization_context_changed' })
        },
        'GET /api/v1/me': () => json(200, contextChanged ? ME : TEAM_ME),
      })
      renderApp(PATHS.settings)
      if (action === 'leave') await openLeave(user)
      else await openRemoval(user)
      await user.click(
        await screen.findByRole('button', {
          name: action === 'leave' ? 'Leave this team' : 'Remove member',
        }),
      )
      expect((await screen.findByRole('alert')).textContent).toMatch(/context changed|reload/i)
      expectNoRemovalSuccess()
      expect(screen.queryByText(/You are now in your personal space/)).toBeNull()
      expect(api.to('GET /api/v1/me')).toHaveLength(1)
      const moreEvents = screen.getByRole('button', { name: 'More event types' })
      const moreBookings = screen.getByRole('button', { name: 'More bookings' })
      expect(moreEvents.hasAttribute('disabled')).toBe(true)
      expect(moreBookings.hasAttribute('disabled')).toBe(true)
      await user.click(moreEvents)
      await user.click(moreBookings)
      expect(api.to(previewRoute)).toHaveLength(1)
      expect(screen.getByRole('alert').textContent).toMatch(/context changed|reload/i)
      expect(
        screen
          .getByRole('button', { name: action === 'leave' ? 'Leave this team' : 'Remove member' })
          .hasAttribute('disabled'),
      ).toBe(true)
      await user.click(screen.getByRole('button', { name: 'Reload team' }))
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Team members' })).toBeNull())
      expect(api.to(route)).toHaveLength(1)
      expect(api.to('GET /api/v1/me')).toHaveLength(2)
    },
  )

  it('moves keyboard focus to the review and returns it to the leave trigger on Escape', async () => {
    const user = userEvent.setup()
    teamServer()
    renderApp(PATHS.settings)
    const trigger = await screen.findByRole('button', { name: 'Leave team' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const heading = await screen.findByRole('heading', { name: 'Review leaving this team' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('heading', { name: 'Review leaving this team' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['Escape', 'Cancel'])(
    'returns focus to the removal opener after %s closes the review',
    async (method) => {
      const user = userEvent.setup()
      teamServer('owner')
      renderApp(PATHS.settings)
      const trigger = await screen.findByRole('button', { name: 'Remove member: Team member' })
      trigger.focus()
      await user.keyboard('{Enter}')
      const heading = await screen.findByRole('heading', { name: 'Remove team member' })
      await waitFor(() => expect(document.activeElement).toBe(heading))
      if (method === 'Escape') await user.keyboard('{Escape}')
      else await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('heading', { name: 'Remove team member' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(trigger))
      expect(trigger.hasAttribute('disabled')).toBe(false)
    },
  )

  it('ignores a late preview after cancelling, and fetches a fresh preview on reopening', async () => {
    const user = userEvent.setup()
    const oldPreview = later()
    let requests = 0
    const api = teamServer('member', {
      [impactRoute(ME.user.id)]: () =>
        ++requests === 1 ? oldPreview.response : json(200, impact()),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await oldPreview.answer(json(200, impact([eventType()])))
    expect(screen.queryByText(eventType().title)).toBeNull()
    await openLeave(user)
    await screen.findByRole('button', { name: 'Leave this team' })
    expect(screen.queryByText(eventType().title)).toBeNull()
    expect(api.to(impactRoute(ME.user.id))).toHaveLength(2)
    expect(api.to(LEAVE_ROUTE)).toHaveLength(0)
  })

  it('ignores a late preview after the active session falls back to a different space', async () => {
    const user = userEvent.setup()
    const oldPreview = later()
    let changed = false
    const api = teamServer('member', {
      [impactRoute(ME.user.id)]: () => oldPreview.response,
      'GET /api/v1/me': () => json(200, changed ? ME : TEAM_ME),
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    changed = true
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Team members' })).toBeNull())
    await oldPreview.answer(json(200, impact([eventType()], [booking()])))
    expect(screen.queryByRole('heading', { name: 'Review leaving this team' })).toBeNull()
    expect(screen.queryByText(eventType().title)).toBeNull()
    expect(api.to(LEAVE_ROUTE)).toHaveLength(0)
  })

  it('ignores a late confirmed removal after the page unmounts', async () => {
    const user = userEvent.setup()
    const response = later()
    const api = teamServer('owner', { [removalRoute(MEMBER_ID)]: () => response.response })
    const view = renderApp(PATHS.settings)
    await openRemoval(user)
    await user.click(await screen.findByRole('button', { name: 'Remove member' }))
    view.unmount()
    await response.answer(json(200, removed()))
    expect(api.to(handlingRoute)).toHaveLength(0)
    expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(1)
  })

  it('paginates event and booking impact independently without discarding the other list', async () => {
    const user = userEvent.setup()
    const first = impact([eventType()], [booking()])
    first.eventTypes.nextCursor = 'event-next'
    first.eventTypes.totalCount = 2
    first.bookings.nextCursor = 'booking-next'
    first.bookings.totalCount = 2
    const api = teamServer('owner', {
      [impactRoute(ME.user.id)]: ({ path }) => {
        const query = new URL(path, window.location.origin).searchParams
        if (query.has('eventTypesCursor')) {
          const page = impact([eventType(2)], [booking()])
          page.eventTypes.totalCount = 2
          page.bookings = first.bookings
          return json(200, page)
        }
        if (query.has('bookingsCursor')) {
          const page = impact([eventType()], [booking(2)])
          page.eventTypes = first.eventTypes
          page.bookings.totalCount = 2
          return json(200, page)
        }
        return json(200, first)
      },
    })
    renderApp(PATHS.settings)
    await openLeave(user)
    await screen.findByText('Saved meeting 1')
    await user.click(screen.getByRole('button', { name: 'More event types' }))
    await screen.findByText(eventType(2).title)
    expect(screen.getByText('Saved meeting 1')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'More bookings' }))
    await screen.findByText('Saved meeting 2')
    expect(eventManagementLink(eventType(2).title).getAttribute('href')).toBe(
      eventTypePath(eventType(2).id),
    )
    const queries = api
      .to(impactRoute(ME.user.id))
      .map(({ path }) => new URL(path, window.location.origin).searchParams)
    expect(queries.map((query) => query.get('teamId'))).toEqual([TEAM_ID, TEAM_ID, TEAM_ID])
    expect(queries[1]?.get('eventTypesCursor')).toBe('event-next')
    expect(queries[1]?.get('bookingsCursor')).toBeNull()
    expect(queries[2]?.get('bookingsCursor')).toBe('booking-next')
    expect(queries[2]?.get('eventTypesCursor')).toBeNull()
  })

  it('keeps a removal handling cursor and operation bound through a failed page and retry', async () => {
    const user = userEvent.setup()
    let fail = true
    const first = handling([booking()])
    first.bookings.nextCursor = 'handling-next'
    first.bookings.totalCount = 2
    const api = teamServer('owner', {
      [removalRoute(MEMBER_ID)]: () => json(200, removed()),
      [handlingRoute]: ({ path }) => {
        const cursor = new URL(path, window.location.origin).searchParams.get('cursor')
        if (!cursor) return json(200, first)
        return fail ? json(503, { error: 'internal_error' }) : json(200, handling([booking(2)]))
      },
    })
    renderApp(PATHS.settings)
    await openRemoval(user)
    await user.click(await screen.findByRole('button', { name: 'Remove member' }))
    await screen.findByText('Saved meeting 1')
    await user.click(screen.getByRole('button', { name: 'More bookings' }))
    await screen.findByRole('button', { name: 'Retry handling list' })
    expect(screen.getByText('Member removed. Access was revoked immediately.')).toBeDefined()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry handling list' }))
    await screen.findByText('Saved meeting 2')
    const queries = api
      .to(handlingRoute)
      .map(({ path }) => new URL(path, window.location.origin).searchParams)
    expect(queries.map((query) => query.get('teamId'))).toEqual([TEAM_ID, TEAM_ID, TEAM_ID])
    expect(queries.map((query) => query.get('cursor'))).toEqual([
      null,
      'handling-next',
      'handling-next',
    ])
    expect(api.to(removalRoute(MEMBER_ID))).toHaveLength(1)
  })

  it('localizes leave review and concrete handling instructions into Simplified Chinese', async () => {
    const user = userEvent.setup()
    teamServer('member', {
      [impactRoute(ME.user.id)]: () =>
        json(200, impact([eventType()], [booking(), booking(2, true)])),
    })
    renderApp(PATHS.settings)
    await screen.findByRole('button', { name: 'Leave team' })
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    await user.click(screen.getByRole('button', { name: '退出团队' }))
    await screen.findByText(eventType().title)
    expect(screen.queryByRole('heading', { name: 'Review leaving this team' })).toBeNull()
    expect(screen.getByRole('heading', { name: /退出/ })).toBeDefined()
    expect(screen.getByText(/管理员.*主持人|管理员.*主持/)).toBeDefined()
    expect(screen.getByText('请与主持人及参与者协调取消预约。')).toBeDefined()
    expect(screen.getByText(/等待.*结束|结束.*线下/)).toBeDefined()
  })
})
