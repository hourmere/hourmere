import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
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
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { UnsavedChangesProvider } from '../../unsaved-changes.tsx'
import { TeamMembers } from '../TeamMembers.tsx'
import { emptyDraft } from './event-type-form.ts'
import { ReadOnlyHosts } from './ReadOnlyHosts.tsx'

const TEAM = { ...ME, organization: { ...ME.organization, personal: false } }
const PEER_ID = '00000000-0000-7000-8000-000000000009'
const MEMBER_ID = '00000000-0000-7000-8000-000000000101'
const MEMBER_ROLE = 'member'
const MEMBERSHIP = 'GET /api/auth/organization/get-active-member'
const READINESS = `GET /api/v1/teams/${TEAM.organization.id}/member-readiness`
const ITEM = eventType({ ownerUserId: null, hosts: [{ userId: ME.user.id }] })

function server(role = 'member', item = ITEM, overrides: Routes = {}) {
  return fakeApi({
    ...signedInAs(TEAM),
    ...profile(),
    [MEMBERSHIP]: () =>
      json(200, {
        id: MEMBER_ID,
        organizationId: TEAM.organization.id,
        userId: ME.user.id,
        role,
        createdAt: '2026-10-30T12:00:00Z',
      }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, item),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: ME.user.id, name: 'Ada', memberId: MEMBER_ID }], nextAfter: null }),
    [READINESS]: () =>
      json(200, {
        organizationId: TEAM.organization.id,
        members: [
          {
            memberId: MEMBER_ID,
            health: {
              defaultSchedule: 'configuration_blocker',
              selectedCalendars: 'not_applicable',
              conferenceAccounts: 'not_connected',
            },
          },
        ],
      }),
    [`GET /api/v1/teams/${TEAM.organization.id}/readiness`]: () =>
      json(200, {
        organizationId: TEAM.organization.id,
        members: { data: [], nextCursor: null },
        eventTypes: { data: [], nextCursor: null },
      }),
    ...overrides,
  })
}

describe('team host setup navigation', () => {
  it.each(['en', 'zh-CN'] as const)(
    'keeps an ordinary host read-only with own setup links in %s',
    async (language) => {
      chooseLanguage(language)
      const calls = server()
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByText(language === 'en' ? 'No default schedule' : '未设置默认时间表')
      const hosts = screen.getByRole('region', { name: language === 'en' ? 'Hosts' : '主持人' })
      expect(
        within(hosts).queryByText(
          language === 'en' ? 'You are a selected host.' : '你是已选主持人。',
        ),
      ).not.toBeNull()
      expect(within(hosts).queryByRole('checkbox')).toBeNull()
      expect(within(hosts).queryByRole('combobox')).toBeNull()
      expect(screen.queryByLabelText(language === 'en' ? 'Scheduling' : '排期方式')).toBeNull()
      expect(
        within(hosts)
          .getByRole('link', {
            name: language === 'en' ? 'Configure default schedule' : '配置默认时间表',
          })
          .getAttribute('href'),
      ).toBe('/app/availability')
      expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
      expect(calls.to(READINESS)[0]?.path).toContain(`memberIds=${MEMBER_ID}`)
      expect(calls.calls.some((call) => call.method === 'PATCH')).toBe(false)
    },
  )

  it.each(['owner', 'admin'])(
    'waits for the %s role before presenting host access',
    async (role) => {
      const membership = later()
      const calls = server(role, ITEM, {
        [MEMBERSHIP]: () => membership.response.then((response) => response.clone()),
      })
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
      const hosts = screen.getByRole('region', { name: 'Hosts' })
      expect(within(hosts).queryByRole('status')?.textContent).toBe('Loading your team role…')
      expect(
        screen.queryByText('Only team owners and admins can change host assignments.'),
      ).toBeNull()
      expect(screen.queryByLabelText('Scheduling')).toBeNull()
      expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(0)

      await membership.answer(
        json(200, {
          id: MEMBER_ID,
          organizationId: TEAM.organization.id,
          userId: ME.user.id,
          role,
        }),
      )
      await screen.findByRole('checkbox', { name: 'Ada' })
      expect(screen.queryByText('Loading your team role…')).toBeNull()
      expect(
        screen.queryByText('Only team owners and admins can change host assignments.'),
      ).toBeNull()
      expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(1)
    },
  )

  it.each(['owner', 'admin'])(
    'retries a failed %s role check without presenting read-only host access',
    async (role) => {
      const user = userEvent.setup()
      let fail = true
      const calls = server(role, ITEM, {
        [MEMBERSHIP]: () =>
          fail
            ? json(503, { error: 'unavailable' })
            : json(200, {
                id: MEMBER_ID,
                organizationId: TEAM.organization.id,
                userId: ME.user.id,
                role,
              }),
      })
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const hosts = await screen.findByRole('region', { name: 'Hosts' })
      await waitFor(() =>
        expect(within(hosts).queryByText('Could not load your team role.')).not.toBeNull(),
      )
      expect(
        screen.queryByText('Only team owners and admins can change host assignments.'),
      ).toBeNull()
      expect(screen.queryByLabelText('Scheduling')).toBeNull()
      expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
      const failedAttempts = calls.to(MEMBERSHIP).length

      fail = false
      await user.click(within(hosts).getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Ada' })).not.toBeNull())
      expect(screen.queryByText('Could not load your team role.')).toBeNull()
      expect(
        screen.queryByText('Only team owners and admins can change host assignments.'),
      ).toBeNull()
      expect(calls.to(MEMBERSHIP)).toHaveLength(failedAttempts + 1)
      expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(1)
    },
  )

  it('hides round-robin assignment and activation controls for a member', async () => {
    const calls = server('member', eventType({ ...ITEM, schedulingType: 'round_robin' }))
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByText('No default schedule')
    expect(screen.queryByRole('button', { name: 'Activate round robin' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use hosts’ default availability' })).toBeNull()
    expect(screen.queryByLabelText('Scheduling')).toBeNull()
    expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
  })

  it('keeps other hosts private for an ordinary member who is not selected', async () => {
    const calls = server('member', eventType({ ...ITEM, hosts: [{ userId: PEER_ID }] }))
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByText('Only team owners and admins can change host assignments.')
    const hosts = screen.getByRole('region', { name: 'Hosts' })
    expect(within(hosts).queryByRole('link')).toBeNull()
    expect(calls.to(READINESS)).toHaveLength(0)
    expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
  })

  it('shows a failure and retries an ordinary host’s readiness check', async () => {
    const user = userEvent.setup()
    let fail = true
    server('member', ITEM, {
      [READINESS]: () =>
        fail
          ? json(503, { error: 'internal_error' })
          : json(200, { organizationId: TEAM.organization.id, members: [] }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByText('Could not check member configuration.')
    expect(screen.queryByText('No default schedule')).toBeNull()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry checks' }))
    await screen.findByText('Configuration not checked')
    expect(screen.queryByText('Could not check member configuration.')).toBeNull()
  })

  it('shows a failure and retries a failed own membership lookup', async () => {
    const user = userEvent.setup()
    let fail = true
    server('member', ITEM, {
      [MEMBERSHIP]: () =>
        fail
          ? json(503, { error: 'unavailable' })
          : json(200, {
              id: MEMBER_ID,
              organizationId: TEAM.organization.id,
              userId: ME.user.id,
              role: 'member',
            }),
    })
    render(
      <MemoryRouter>
        <InterfaceScope surface="admin">
          <ReadOnlyHosts
            draft={{ ...emptyDraft(), hostUserIds: [ME.user.id] }}
            me={TEAM}
            role={MEMBER_ROLE}
            onReload={() => {}}
          />
        </InterfaceScope>
      </MemoryRouter>,
    )
    await screen.findByText('Could not check member configuration.')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry checks' }))
    await screen.findByText('No default schedule')
  })

  it('requires reloading after an ordinary host’s readiness permission changes', async () => {
    server('member', ITEM, {
      [READINESS]: () => json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByText(
      'Your permission or team membership changed. Reload to check before trying again.',
    )
    expect(screen.getByRole('button', { name: 'Reload team' })).toBeDefined()
    expect(screen.queryByText('No default schedule')).toBeNull()
  })

  it.each([{ userId: PEER_ID }, { organizationId: PEER_ID }])(
    'rejects a mismatched own membership before checking readiness: %j',
    async (changed) => {
      const calls = server('member', ITEM, {
        [MEMBERSHIP]: () =>
          json(200, {
            id: MEMBER_ID,
            organizationId: TEAM.organization.id,
            userId: ME.user.id,
            role: 'member',
            ...changed,
          }),
      })
      render(
        <MemoryRouter>
          <InterfaceScope surface="admin">
            <ReadOnlyHosts
              draft={{ ...emptyDraft(), hostUserIds: [ME.user.id] }}
              me={TEAM}
              role={MEMBER_ROLE}
              onReload={() => {}}
            />
          </InterfaceScope>
        </MemoryRouter>,
      )
      await screen.findByText('Could not check member configuration.')
      expect(calls.to(READINESS)).toHaveLength(0)
      expect(screen.queryByText('No default schedule')).toBeNull()
    },
  )

  it.each([0, 1, 2])(
    'requires exactly one individual host when saving (%i selected)',
    async (count) => {
      const user = userEvent.setup()
      const item = eventType({
        ...ITEM,
        hosts: [ME.user.id, PEER_ID].slice(0, count).map((userId) => ({ userId })),
      })
      const calls = server('admin', item, {
        [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, item),
      })
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByLabelText('Scheduling')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      if (count === 1) {
        await screen.findByText('Saved.')
        expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
      } else {
        expect(screen.getAllByText('Choose exactly one required host.').length).toBeGreaterThan(0)
        expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
      }
    },
  )

  it.each(['owner', 'admin'])(
    'offers guidance instead of another host’s private schedule for %s',
    async (role) => {
      const calls = server(role, eventType({ ...ITEM, hosts: [{ userId: PEER_ID }] }))
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByLabelText('Scheduling')
      expect(screen.queryByLabelText('Schedule', { exact: true })).toBeNull()
      expect(
        screen.getByText(
          'Ask this member to review their personal working hours and calendars. Only they can change their private schedule.',
        ),
      ).toBeDefined()
      expect(screen.getByRole('link', { name: 'Review member setup' }).getAttribute('href')).toBe(
        '/app/settings#team-members',
      )
      expect(calls.to('GET /api/v1/schedules')).toHaveLength(1)
      expect(calls.calls.some((call) => /schedules.*(?:userId|owner)/.test(call.path))).toBe(false)
    },
  )

  it('updates individual working hours guidance as hosts are chosen and removed', async () => {
    const user = userEvent.setup()
    const calls = server('admin', eventType({ ...ITEM, hosts: [] }), {
      'GET /api/v1/event-type-hosts': () =>
        json(200, {
          data: [
            { id: ME.user.id, name: 'Ada', memberId: MEMBER_ID },
            { id: PEER_ID, name: 'Grace', memberId: 'peer-member' },
          ],
          nextAfter: null,
        }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const grace = await screen.findByRole('checkbox', { name: 'Grace' })
    const rules = screen.getByRole('region', { name: 'When people can book' })
    const chooseHost = 'Choose exactly one required host.'
    const askMember =
      'Ask this member to review their personal working hours and calendars. Only they can change their private schedule.'
    expect(within(rules).queryByText(chooseHost)).not.toBeNull()
    expect(within(rules).queryByText(askMember)).toBeNull()
    expect(within(rules).queryByRole('link', { name: 'Review member setup' })).toBeNull()
    expect(screen.queryByLabelText('Schedule', { exact: true })).toBeNull()

    await user.click(grace)
    expect(within(rules).getByText(askMember)).toBeDefined()
    expect(within(rules).queryByText(chooseHost)).toBeNull()
    expect(screen.queryByLabelText('Schedule', { exact: true })).toBeNull()
    await user.click(grace)
    expect(within(rules).queryByText(chooseHost)).not.toBeNull()
    expect(within(rules).queryByText(askMember)).toBeNull()
    expect(screen.queryByLabelText('Schedule', { exact: true })).toBeNull()

    await user.click(screen.getByRole('checkbox', { name: 'Ada' }))
    expect(screen.getByLabelText('Schedule', { exact: true })).toBeDefined()
    expect(within(rules).queryByText(chooseHost)).toBeNull()
    expect(within(rules).queryByText(askMember)).toBeNull()
    expect(calls.to('GET /api/v1/schedules')).toHaveLength(1)
    expect(calls.calls.some((call) => /schedules.*(?:userId|owner)/.test(call.path))).toBe(false)
  })

  it('filters single, collective and dormant round-robin candidates and restores the list', async () => {
    const user = userEvent.setup()
    const hosted = (
      id: string,
      title: string,
      schedulingType: 'individual' | 'collective' | 'round_robin',
    ) => eventType({ ...ITEM, id, title, schedulingType, hosts: [{ userId: PEER_ID }] })
    fakeApi({
      ...signedInAs(TEAM),
      ...profile(),
      [MEMBERSHIP]: () =>
        json(200, {
          id: MEMBER_ID,
          organizationId: TEAM.organization.id,
          userId: ME.user.id,
          role: 'member',
        }),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () =>
        json(200, {
          data: [
            ITEM,
            hosted('single', 'Peer single', 'individual'),
            hosted('collective', 'Peer collective', 'collective'),
            hosted('pool', 'Peer candidate', 'round_robin'),
            eventType({ title: 'Personal', hosts: [{ userId: PEER_ID }] }),
          ],
        }),
    })
    renderApp(`/app/event-types?hostUserId=${PEER_ID}`)
    await screen.findByRole('rowheader', { name: 'Peer candidate' })
    expect(screen.getAllByRole('rowheader')).toHaveLength(3)
    expect(screen.queryByRole('rowheader', { name: 'Intro call' })).toBeNull()
    expect(screen.queryByRole('rowheader', { name: 'Personal' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Show all event types' }))
    await screen.findByRole('rowheader', { name: 'Intro call' })
    expect(screen.getAllByRole('rowheader')).toHaveLength(5)
  })

  it('ignores the team host filter in a personal space', async () => {
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () => json(200, { data: [eventType()] }),
      'GET /api/v1/readiness/self': () => json(403, { error: 'readiness_access_denied' }),
    })
    renderApp(`/app/event-types?hostUserId=${PEER_ID}`)
    await screen.findByRole('rowheader', { name: 'Intro call' })
    expect(screen.queryByRole('link', { name: 'Show all event types' })).toBeNull()
  })

  it.each(['owner', 'admin', 'member'])(
    'shows per-member hosted-event entry only to managers: %s',
    async (role) => {
      const member = {
        id: MEMBER_ID,
        userId: PEER_ID,
        organizationId: TEAM.organization.id,
        role: 'member',
        createdAt: '2026-10-30T12:00:00Z',
        user: { id: PEER_ID, name: 'Grace' },
      }
      fakeApi({
        'GET /api/auth/organization/list-members': () => json(200, { members: [member], total: 1 }),
        [READINESS]: () => json(200, { organizationId: TEAM.organization.id, members: [] }),
        'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
      })
      render(
        <MemoryRouter>
          <UnsavedChangesProvider>
            <InterfaceScope surface="admin">
              <TeamMembers
                organizationId={TEAM.organization.id}
                currentUserId={ME.user.id}
                role={role}
              />
            </InterfaceScope>
          </UnsavedChangesProvider>
        </MemoryRouter>,
      )
      await screen.findByText('Grace')
      await waitFor(() => expect(screen.queryByText('Checking member configuration…')).toBeNull())
      const link = screen.queryByRole('link', { name: 'View hosted team events' })
      if (role === 'member') expect(link).toBeNull()
      else expect(link?.getAttribute('href')).toBe(`/app/event-types?hostUserId=${PEER_ID}`)
    },
  )
})
