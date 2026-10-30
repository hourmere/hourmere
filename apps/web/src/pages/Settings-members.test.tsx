import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../App.tsx'
import type { OrganizationMember } from '../api/auth.ts'
import type { Schemas } from '../api/client.ts'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { PATHS } from '../paths.ts'
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
import { TeamMembers } from './TeamMembers.tsx'

const TEAM_ME: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Example team',
    slug: 'example-team',
    personal: false,
  },
}
const ACTIVE_MEMBER: OrganizationMember = {
  id: 'membership-1',
  organizationId: TEAM_ME.organization.id,
  userId: TEAM_ME.user.id,
  role: 'member',
  createdAt: '2026-10-27T10:00:00.000Z',
}

function listedMember(number: number, role = 'member') {
  const userId = `user-${number}`
  return {
    ...ACTIVE_MEMBER,
    id: `membership-${number}`,
    userId,
    role,
    user: { id: userId, name: `Joined person ${number}`, email: `person-${number}@example.com` },
  }
}

function invitation(
  number: number,
  state: Schemas['TeamInvitationSummary']['delivery']['state'] = 'queued',
  status: Schemas['TeamInvitationSummary']['status'] = 'pending',
): Schemas['TeamInvitationSummary'] {
  return {
    id: `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`,
    status,
    createdAt: '2026-10-27T10:00:00.000Z',
    expiresAt: '2026-11-10T10:00:00.000Z',
    resendAllowed: false,
    delivery: { state, attempts: 1, lastAttemptAt: null, lastErrorCode: null },
  }
}

function teamServer(role = 'member', routes: Routes = {}) {
  return fakeApi({
    ...signedInAs(TEAM_ME),
    ...profile(PROFILE),
    'GET /api/auth/organization/get-active-member': () => json(200, { ...ACTIVE_MEMBER, role }),
    'GET /api/auth/organization/list-members': () =>
      json(200, { members: [listedMember(1, 'owner'), listedMember(2, 'admin')], total: 2 }),
    'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
    ...routes,
  })
}

function renderWithCreatedOwner() {
  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: PATHS.settings, state: { createdMember: { ...ACTIVE_MEMBER, role: 'owner' } } },
      ]}
    >
      <App />
    </MemoryRouter>,
  )
}

describe('joined team members and pending invitations in settings', () => {
  it('does not request either team list in a personal space', async () => {
    const api = fakeApi({ ...signedInAs(ME), ...profile(PROFILE) })
    renderApp(PATHS.settings)
    await screen.findByRole('region', { name: 'Account' })
    expect(screen.queryByRole('region', { name: 'Team members' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Pending invitations' })).toBeNull()
    expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(0)
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
  })

  it.each(['owner', 'admin'])(
    'shows joined members and separate pending invitations for a current %s',
    async (role) => {
      const api = teamServer(role, {
        'GET /api/auth/organization/list-members': () =>
          json(200, {
            members: [listedMember(1, 'owner'), listedMember(2, 'admin'), listedMember(3)],
            total: 3,
          }),
        'GET /api/v1/team/invitations': () =>
          json(200, { data: [invitation(1), invitation(2, 'smtp_accepted')], nextCursor: null }),
      })
      renderApp(PATHS.settings)
      const members = await screen.findByRole('region', { name: 'Team members' })
      expect(await within(members).findByText('Joined person 1')).toBeDefined()
      expect(within(members).getByText('Joined person 2')).toBeDefined()
      expect(within(members).getByText('Joined person 3')).toBeDefined()
      for (const label of ['Owner', 'Admin', 'Member']) {
        expect(within(members).getByText(label)).toBeDefined()
      }
      expect(within(members).getByText('3 joined members')).toBeDefined()
      expect(within(members).queryByText('5 joined members')).toBeNull()
      const manage = within(members).getByRole('link', { name: 'Manage team events' })
      expect(manage.getAttribute('href')).toBe(PATHS.eventTypes)
      const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
      expect(await within(invitations).findByText('Invitation 1')).toBeDefined()
      expect(within(invitations).getByText('Invitation 2')).toBeDefined()
      expect(within(invitations).getAllByText('Pending')).toHaveLength(2)
      expect(within(invitations).getByText('Submitted')).toBeDefined()
      expect(within(invitations).getByText('Accepted by the mail server')).toBeDefined()
      expect(members.contains(invitations)).toBe(false)
      expect(members.textContent).not.toContain('@example.com')
      expect(invitations.textContent).not.toMatch(/delivered/i)
      expect(api.to('GET /api/v1/team/invitations')).toHaveLength(1)
      expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
      expect(api.to('GET /api/auth/organization/list-invitations')).toHaveLength(0)
    },
  )

  it('lets a member read names and roles without requesting administrator invitation data', async () => {
    const api = teamServer('member')
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    expect(await within(members).findByText('Joined person 1')).toBeDefined()
    expect(within(members).getByText('2 joined members')).toBeDefined()
    expect(within(members).queryByRole('link', { name: 'Manage team events' })).toBeNull()
    expect(members.textContent).not.toContain('@example.com')
    expect(screen.queryByRole('region', { name: 'Pending invitations' })).toBeNull()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
  })

  it.each([
    'superadmin',
    'owner-assistant',
    'member,administrator',
    'custom-role',
    '__proto__',
    'admin,custom-role',
    'owner,',
  ])('does not grant invitation access by matching a role substring: %s', async (role) => {
    const api = teamServer(role)
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    await within(members).findByText('Joined person 1')
    expect(within(members).queryByRole('link', { name: 'Manage team events' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Pending invitations' })).toBeNull()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
  })

  it('recognizes an exact administrator token in the current multiple-role value', async () => {
    const api = teamServer('member, admin')
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByText('No pending invitations on this page.')
    expect(screen.getByRole('link', { name: 'Manage team events' })).toBeDefined()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(1)
  })

  it('never uses a displayed creation fallback as permission to read invitations', async () => {
    const membership = later()
    const api = teamServer('member', {
      'GET /api/auth/organization/get-active-member': () =>
        membership.response.then((response) => response.clone()),
    })
    renderWithCreatedOwner()
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(within(account).getByText('Owner')).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Pending invitations' })).toBeNull()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
    await membership.answer(json(200, ACTIVE_MEMBER))
    await within(account).findByText('Member')
    expect(screen.queryByRole('region', { name: 'Pending invitations' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Manage team events' })).toBeNull()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
  })

  it.each([{ organizationId: 'another-team' }, { userId: 'another-user' }, { role: '' }])(
    'does not read invitations for a stale or incomplete current membership: %j',
    async (changed) => {
      const api = teamServer('owner', {
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { ...ACTIVE_MEMBER, role: 'owner', ...changed }),
      })
      renderApp(PATHS.settings)
      const account = await screen.findByRole('region', { name: 'Account' })
      await within(account).findByRole('alert')
      expect(screen.queryByRole('region', { name: 'Pending invitations' })).toBeNull()
      expect(screen.queryByRole('link', { name: 'Manage team events' })).toBeNull()
      expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
    },
  )

  it('shows a loading state before member names and the joined count are known', async () => {
    const response = later()
    teamServer('member', {
      'GET /api/auth/organization/list-members': () => response.response,
    })
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    expect(within(members).getByText('Loading team members…').getAttribute('role')).toBe('status')
    expect(within(members).queryByText('0 joined members')).toBeNull()
    await response.answer(json(200, { members: [listedMember(1)], total: 1 }))
    expect(await within(members).findByText('Joined person 1')).toBeDefined()
    expect(within(members).queryByText('Loading team members…')).toBeNull()
  })

  it('preserves an empty member response without inventing the signed-in user or a host', async () => {
    const api = teamServer('admin', {
      'GET /api/auth/organization/list-members': () => json(200, { members: [], total: 0 }),
      'GET /api/v1/team/invitations': () =>
        json(200, { data: [invitation(1), invitation(2)], nextCursor: null }),
    })
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    expect(await within(members).findByText('No team members found.')).toBeDefined()
    expect(within(members).getByText('0 joined members')).toBeDefined()
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByText('Invitation 2')
    expect(within(members).getByText('0 joined members')).toBeDefined()
    expect(within(members).queryByText(ME.user.name)).toBeNull()
    expect(within(members).queryByText('2 joined members')).toBeNull()
    expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
  })

  it('pages joined members with a stable organization, limit and ordering', async () => {
    const user = userEvent.setup()
    const api = teamServer('member', {
      'GET /api/auth/organization/list-members': ({ path }) => {
        const offset = new URL(path, window.location.origin).searchParams.get('offset')
        return json(200, {
          members:
            offset === '20'
              ? [listedMember(21)]
              : Array.from({ length: 20 }, (_, index) => listedMember(index + 1)),
          total: 21,
        })
      },
    })
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    await within(members).findByText('Joined person 20')
    expect(within(members).getByText('21 joined members')).toBeDefined()
    expect(within(members).queryByRole('button', { name: 'Previous members page' })).toBeNull()
    await user.click(within(members).getByRole('button', { name: 'Next members page' }))
    await within(members).findByText('Joined person 21')
    expect(within(members).queryByText('Joined person 1')).toBeNull()
    expect(within(members).getByText('21 joined members')).toBeDefined()
    expect(within(members).queryByRole('button', { name: 'Next members page' })).toBeNull()
    await user.click(within(members).getByRole('button', { name: 'Previous members page' }))
    await within(members).findByText('Joined person 1')
    expect(within(members).queryByText('Joined person 21')).toBeNull()
    const queries = api
      .to('GET /api/auth/organization/list-members')
      .map(({ path }) => Object.fromEntries(new URL(path, window.location.origin).searchParams))
    expect(queries).toEqual(
      ['0', '20', '0'].map((offset) => ({
        organizationId: TEAM_ME.organization.id,
        limit: '20',
        offset,
        sortBy: 'id',
        sortDirection: 'asc',
      })),
    )
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(0)
  })

  it.each(['network', 'server'])(
    'recovers the joined list after a %s failure without losing the invitations section',
    async (failure) => {
      const user = userEvent.setup()
      let fail = true
      const api = teamServer('owner', {
        'GET /api/auth/organization/list-members': () => {
          if (!fail) return json(200, { members: [listedMember(1)], total: 1 })
          if (failure === 'network') throw new TypeError('Failed to fetch')
          return json(503, { code: 'INTERNAL_SERVER_ERROR' })
        },
      })
      renderApp(PATHS.settings)
      const members = await screen.findByRole('region', { name: 'Team members' })
      await within(members).findByRole('alert')
      expect(within(members).queryByText('No team members found.')).toBeNull()
      const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
      await within(invitations).findByText('No pending invitations on this page.')
      fail = false
      await user.click(within(members).getByRole('button', { name: 'Try again' }))
      await within(members).findByText('Joined person 1')
      expect(within(members).queryByRole('alert')).toBeNull()
      expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(2)
      expect(api.to('GET /api/v1/team/invitations')).toHaveLength(1)
    },
  )

  it('shows member-list permission denial separately from an empty result', async () => {
    teamServer('member', {
      'GET /api/auth/organization/list-members': () =>
        json(403, { code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' }),
    })
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    expect((await within(members).findByRole('alert')).textContent).toMatch(/permission|access/i)
    expect(within(members).queryByText('No team members found.')).toBeNull()
    expect(within(members).queryByText('0 joined members')).toBeNull()
  })

  it('shows invitation loading without claiming that no invitations exist', async () => {
    const response = later()
    teamServer('admin', {
      'GET /api/v1/team/invitations': () => response.response,
    })
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    expect(within(invitations).getByText('Loading pending invitations…').getAttribute('role')).toBe(
      'status',
    )
    expect(within(invitations).queryByText('No pending invitations on this page.')).toBeNull()
    await response.answer(json(200, { data: [invitation(1)], nextCursor: null }))
    expect(await within(invitations).findByText('Invitation 1')).toBeDefined()
    expect(within(invitations).queryByText('Loading pending invitations…')).toBeNull()
  })

  it('describes every mail submission state without claiming delivery', async () => {
    const states = ['queued', 'sending', 'smtp_accepted', 'failed', 'skipped', 'unknown'] as const
    teamServer('owner', {
      'GET /api/v1/team/invitations': () =>
        json(200, {
          data: states.map((state, index) => invitation(index + 1, state)),
          nextCursor: null,
        }),
    })
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByText('Submission status unknown')
    for (const label of [
      'Submitted',
      'Submitting to the mail server',
      'Accepted by the mail server',
      'Submission failed',
      'Submission skipped',
    ]) {
      expect(within(invitations).getByText(label)).toBeDefined()
    }
    expect(within(invitations).getAllByText('Pending')).toHaveLength(6)
    expect(invitations.textContent).not.toMatch(/delivered/i)
  })

  it('keeps cursor paging available when a page has no pending invitations', async () => {
    const user = userEvent.setup()
    const cursor = invitation(5).id
    const api = teamServer('admin', {
      'GET /api/v1/team/invitations': ({ path }) => {
        const query = new URL(path, window.location.origin).searchParams
        return json(
          200,
          query.has('cursor')
            ? { data: [invitation(6)], nextCursor: null }
            : {
                data: (['accepted', 'canceled', 'rejected', 'expired', 'unknown'] as const).map(
                  (status, index) => invitation(index + 1, 'smtp_accepted', status),
                ),
                nextCursor: cursor,
              },
        )
      },
    })
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByText('No pending invitations on this page.')
    expect(within(invitations).queryByText('Pending')).toBeNull()
    expect(
      within(invitations).queryByRole('button', { name: 'Previous invitations page' }),
    ).toBeNull()
    await user.click(within(invitations).getByRole('button', { name: 'Next invitations page' }))
    await within(invitations).findByText('Pending')
    expect(within(invitations).queryByText('No pending invitations on this page.')).toBeNull()
    expect(within(invitations).queryByRole('button', { name: 'Next invitations page' })).toBeNull()
    await user.click(within(invitations).getByRole('button', { name: 'Previous invitations page' }))
    await within(invitations).findByText('No pending invitations on this page.')
    expect(
      api
        .to('GET /api/v1/team/invitations')
        .map(({ path }) => Object.fromEntries(new URL(path, window.location.origin).searchParams)),
    ).toEqual([{ limit: '20' }, { limit: '20', cursor }, { limit: '20' }])
  })

  it('recovers an invitation network failure while retaining joined members and their count', async () => {
    const user = userEvent.setup()
    let fail = true
    const api = teamServer('admin', {
      'GET /api/v1/team/invitations': () => {
        if (fail) throw new TypeError('Failed to fetch')
        return json(200, { data: [invitation(1)], nextCursor: null })
      },
    })
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    await within(members).findByText('2 joined members')
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByRole('alert')
    expect(within(invitations).queryByText('No pending invitations on this page.')).toBeNull()
    fail = false
    await user.click(within(invitations).getByRole('button', { name: 'Try again' }))
    await within(invitations).findByText('Invitation 1')
    expect(within(invitations).queryByRole('alert')).toBeNull()
    expect(within(members).getByText('2 joined members')).toBeDefined()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(2)
    expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(1)
  })

  it('shows invitation permission denial without treating it as an empty invitation list', async () => {
    teamServer('owner', {
      'GET /api/v1/team/invitations': () => json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    expect((await within(invitations).findByRole('alert')).textContent).toMatch(
      /permission|access/i,
    )
    expect(within(invitations).queryByText('No pending invitations on this page.')).toBeNull()
    const members = screen.getByRole('region', { name: 'Team members' })
    await within(members).findByText('2 joined members')
  })

  it('retries a failed members page at the same offset and can return to the first page', async () => {
    const user = userEvent.setup()
    let fail = true
    const api = teamServer('member', {
      'GET /api/auth/organization/list-members': ({ path }) => {
        const offset = new URL(path, window.location.origin).searchParams.get('offset')
        if (offset === '20') {
          return fail
            ? json(503, { code: 'INTERNAL_SERVER_ERROR' })
            : json(200, { members: [listedMember(21)], total: 21 })
        }
        return json(200, { members: [listedMember(1)], total: 21 })
      },
    })
    renderApp(PATHS.settings)
    const members = await screen.findByRole('region', { name: 'Team members' })
    await within(members).findByText('Joined person 1')
    await user.click(within(members).getByRole('button', { name: 'Next members page' }))
    await within(members).findByRole('alert')
    expect(within(members).queryByText('No team members found.')).toBeNull()
    fail = false
    await user.click(within(members).getByRole('button', { name: 'Try again' }))
    await within(members).findByText('Joined person 21')
    await user.click(within(members).getByRole('button', { name: 'Previous members page' }))
    await within(members).findByText('Joined person 1')
    expect(
      api
        .to('GET /api/auth/organization/list-members')
        .map(({ path }) => new URL(path, window.location.origin).searchParams.get('offset')),
    ).toEqual(['0', '20', '20', '0'])
  })

  it('retries a failed invitation page with the same cursor', async () => {
    const user = userEvent.setup()
    const cursor = invitation(1).id
    let fail = true
    const api = teamServer('admin', {
      'GET /api/v1/team/invitations': ({ path }) => {
        const query = new URL(path, window.location.origin).searchParams
        if (query.has('cursor')) {
          return fail
            ? json(503, { error: 'internal_error' })
            : json(200, { data: [invitation(2, 'smtp_accepted')], nextCursor: null })
        }
        return json(200, { data: [invitation(1)], nextCursor: cursor })
      },
    })
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByText('Submitted')
    await user.click(within(invitations).getByRole('button', { name: 'Next invitations page' }))
    await within(invitations).findByRole('alert')
    expect(within(invitations).queryByText('No pending invitations on this page.')).toBeNull()
    fail = false
    await user.click(within(invitations).getByRole('button', { name: 'Try again' }))
    await within(invitations).findByText('Accepted by the mail server')
    expect(
      api
        .to('GET /api/v1/team/invitations')
        .map(({ path }) => new URL(path, window.location.origin).searchParams.get('cursor')),
    ).toEqual([null, cursor, cursor])
    expect(screen.getByText('2 joined members')).toBeDefined()
  })

  it('localizes both sections and mail submission wording in Simplified Chinese', async () => {
    const user = userEvent.setup()
    const api = teamServer('admin', {
      'GET /api/v1/team/invitations': () =>
        json(200, { data: [invitation(1), invitation(2, 'smtp_accepted')], nextCursor: null }),
    })
    renderApp(PATHS.settings)
    await screen.findByText('Accepted by the mail server')
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    const members = screen.getByRole('region', { name: '团队成员' })
    expect(within(members).getByText('2 位已加入的成员')).toBeDefined()
    expect(within(members).getByText('所有者')).toBeDefined()
    expect(within(members).getByText('管理员')).toBeDefined()
    expect(within(members).getByRole('link', { name: '管理团队活动' })).toBeDefined()
    expect(within(members).getByText('待接受的邀请不计入成员或主持人。')).toBeDefined()
    const invitations = screen.getByRole('region', { name: '待接受的邀请' })
    expect(within(invitations).getAllByText('待接受')).toHaveLength(2)
    expect(within(invitations).getByText('已提交')).toBeDefined()
    expect(within(invitations).getByText('邮件服务器已接受')).toBeDefined()
    expect(
      within(invitations).getByText('邮件服务器接受邮件并不代表邮件已到达收件箱。'),
    ).toBeDefined()
    expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(1)
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(1)
  })

  it('keeps pending invitations out of the host choices reached from team management', async () => {
    const user = userEvent.setup()
    const api = teamServer('owner', {
      'GET /api/v1/team/invitations': () =>
        json(200, { data: [invitation(1), invitation(2)], nextCursor: null }),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-type-hosts': () =>
        json(200, {
          data: [
            { id: 'user-1', name: 'Joined person 1' },
            { id: 'user-2', name: 'Joined person 2' },
          ],
          nextAfter: null,
        }),
    })
    renderApp(PATHS.settings)
    await screen.findByText('Invitation 2')
    expect(screen.getByText('2 joined members')).toBeDefined()
    await user.click(screen.getByRole('link', { name: 'Manage team events' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    await user.click(screen.getByRole('link', { name: 'New event type' }))
    const hosts = await screen.findByRole('region', { name: 'Hosts' })
    await within(hosts).findByRole('checkbox', { name: 'Joined person 1' })
    expect(within(hosts).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(hosts).getByRole('checkbox', { name: 'Joined person 2' })).toBeDefined()
    expect(within(hosts).queryByText(/Invitation/)).toBeNull()
    expect(api.to('GET /api/v1/team/invitations')).toHaveLength(1)
    expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(1)
  })

  it('discards a late member page after its organization context has changed', async () => {
    const oldPage = later()
    const otherOrganizationId = '00000000-0000-7000-8000-000000000011'
    fakeApi({
      'GET /api/auth/organization/list-members': ({ path }) => {
        const organizationId = new URL(path, window.location.origin).searchParams.get(
          'organizationId',
        )
        return organizationId === TEAM_ME.organization.id
          ? oldPage.response
          : json(200, {
              members: [{ ...listedMember(2), organizationId: otherOrganizationId }],
              total: 1,
            })
      },
    })
    const contents = (organizationId: string) => (
      <MemoryRouter>
        <InterfaceScope surface="admin">
          <TeamMembers organizationId={organizationId} role={ACTIVE_MEMBER.role} />
        </InterfaceScope>
      </MemoryRouter>
    )
    const view = render(contents(TEAM_ME.organization.id))
    const members = screen.getByRole('region', { name: 'Team members' })
    expect(within(members).getByText('Loading team members…')).toBeDefined()
    view.rerender(contents(otherOrganizationId))
    await within(members).findByText('Joined person 2')
    await oldPage.answer(json(200, { members: [listedMember(1)], total: 99 }))
    expect(within(members).getByText('Joined person 2')).toBeDefined()
    expect(within(members).queryByText('Joined person 1')).toBeNull()
    expect(within(members).queryByText('99 joined members')).toBeNull()
    expect(within(members).queryByText('Loading team members…')).toBeNull()
  })

  it('binds the first invitation page and retries to the displayed team after a session switch', async () => {
    const user = userEvent.setup()
    const api = teamServer('admin', {
      'GET /api/v1/team/invitations': ({ headers }) =>
        headers.get('X-Expected-Organization-Id') === TEAM_ME.organization.id
          ? json(403, { error: 'team_management_access_denied' })
          : json(200, { data: [invitation(1, 'smtp_accepted')], nextCursor: null }),
    })
    renderApp(PATHS.settings)
    const invitations = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(invitations).findByRole('alert')
    expect(within(invitations).queryByText('Invitation 1')).toBeNull()
    await user.click(within(invitations).getByRole('button', { name: 'Try again' }))
    await within(invitations).findByRole('alert')
    expect(within(invitations).queryByText('Invitation 1')).toBeNull()
    expect(
      api
        .to('GET /api/v1/team/invitations')
        .map(({ headers }) => headers.get('X-Expected-Organization-Id')),
    ).toEqual([TEAM_ME.organization.id, TEAM_ME.organization.id])
    expect(screen.getByText('2 joined members')).toBeDefined()
  })
})
