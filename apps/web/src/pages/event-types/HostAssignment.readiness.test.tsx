import '../../i18n/admin.ts'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { MemberHealth } from '../../components/team-members/member-readiness.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, later, type Routes } from '../../test/fake-api.tsx'
import { type EventTypeDraft, emptyDraft } from './event-type-form.ts'
import { HostAssignment } from './HostAssignment.tsx'

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const SELF = {
  id: '00000000-0000-7000-8000-000000000001',
  memberId: '00000000-0000-7000-8000-000000000101',
  name: 'Current host',
}
const PEER = {
  id: '00000000-0000-7000-8000-000000000002',
  memberId: '00000000-0000-7000-8000-000000000102',
  name: 'Other host',
}
const DIRECTORY = 'GET /api/v1/event-type-hosts'
const READINESS = `GET /api/v1/teams/${TEAM_ID}/member-readiness`
const ASK_MEMBER =
  'Ask this member to review their personal working hours and calendars. Only they can change their private schedule.'

function check(host = PEER, health: Partial<MemberHealth> = {}) {
  return {
    memberId: host.memberId,
    displayName: host.name,
    summary: 'configuration_blocked',
    completeness: 'complete',
    evaluatedAt: '2026-10-30T12:00:00.000Z',
    reasonCodes: [],
    fixKinds: [],
    health: {
      defaultSchedule: 'configuration_blocker',
      selectedCalendars: 'dependency_unavailable',
      conferenceAccounts: 'attention_required',
      ...health,
    },
  }
}

function server(overrides: Routes = {}) {
  return fakeApi({
    [DIRECTORY]: () => json(200, { data: [SELF, PEER], nextAfter: null }),
    [READINESS]: () => json(200, { organizationId: TEAM_ID, members: [check(SELF), check(PEER)] }),
    ...overrides,
  })
}

function Editor({
  initial = {},
  role = 'admin',
}: {
  initial?: Partial<EventTypeDraft>
  role?: string | null
}) {
  const [draft, setDraft] = useState({ ...emptyDraft(), hostUserIds: [PEER.id], ...initial })
  return (
    <MemoryRouter>
      <InterfaceScope surface="admin">
        <HostAssignment
          organizationId={TEAM_ID}
          currentUserId={SELF.id}
          role={role}
          draft={draft}
          set={(name, value) => setDraft((previous) => ({ ...previous, [name]: value }))}
        />
        <output aria-label="Selected host IDs">{draft.hostUserIds.join(',')}</output>
      </InterfaceScope>
    </MemoryRouter>
  )
}

function row(name: string) {
  const label = screen.getByLabelText(name).closest('label')
  if (!label?.parentElement) throw new Error('Expected host directory row')
  return label.parentElement
}

describe('selected team host member setup', () => {
  it.each(['owner', 'admin', 'member, admin'])(
    'shows coarse peer reasons and member guidance for %s without private settings',
    async (role) => {
      const privateValue = 'Private member calendar name'
      const api = server({
        [READINESS]: () =>
          json(200, {
            organizationId: TEAM_ID,
            members: [
              {
                ...check(),
                details: { schedules: [{ id: 'private-schedule-id', name: privateValue }] },
              },
            ],
          }),
      })
      render(<Editor role={role} />)
      const other = within(await screen.findByLabelText(PEER.name).then(() => row(PEER.name)))
      await other.findByText('No default schedule')
      expect(other.getByText('Selected calendars need attention')).toBeDefined()
      expect(other.getByText('Conference accounts need attention')).toBeDefined()
      expect(other.getByText(ASK_MEMBER)).toBeDefined()
      expect(other.getByRole('link', { name: 'Review member setup' }).getAttribute('href')).toBe(
        '/app/settings#team-members',
      )
      expect(other.queryAllByRole('link')).toHaveLength(1)
      expect(row(PEER.name).innerHTML).not.toContain(privateValue)
      expect(row(PEER.name).innerHTML).not.toContain('private-schedule-id')
      expect(within(row(SELF.name)).queryByRole('region', { name: 'Member readiness' })).toBeNull()
      expect(api.to(READINESS)).toHaveLength(1)
      const request = api.to(READINESS)[0]
      expect(new URL(request?.path ?? '', location.origin).searchParams.get('memberIds')).toBe(
        PEER.memberId,
      )
      expect(request?.headers.get('x-expected-organization-id')).toBe(TEAM_ID)
      expect(api.calls.every((call) => call.path.startsWith('/api/v1/'))).toBe(true)
      for (const resource of ['schedules', 'calendar-connections', 'conference-connections'])
        expect(api.to(`GET /api/v1/${resource}`)).toHaveLength(0)
    },
  )

  it('offers only the caller’s own schedule, calendar and conference repair links on their row', async () => {
    server()
    render(<Editor initial={{ hostUserIds: [SELF.id] }} />)
    await screen.findByText('No default schedule')
    const own = within(row(SELF.name))
    expect(own.getByRole('link', { name: 'Configure default schedule' }).getAttribute('href')).toBe(
      '/app/availability',
    )
    expect(own.getByRole('link', { name: 'Configure calendars' }).getAttribute('href')).toBe(
      '/app/calendars',
    )
    expect(own.getByRole('link', { name: 'Review conference accounts' }).getAttribute('href')).toBe(
      '/app/conferences',
    )
    expect(own.queryByText(ASK_MEMBER)).toBeNull()
    expect(own.queryByRole('link', { name: 'Review member setup' })).toBeNull()
    expect(within(row(PEER.name)).queryByRole('link')).toBeNull()
  })

  it('keeps missing external connections optional instead of reporting a booking blocker', async () => {
    server({
      [READINESS]: () =>
        json(200, {
          organizationId: TEAM_ID,
          members: [
            check(PEER, {
              defaultSchedule: 'satisfied',
              selectedCalendars: 'not_applicable',
              conferenceAccounts: 'not_connected',
            }),
          ],
        }),
    })
    render(<Editor />)
    await screen.findByText('Default schedule set')
    const other = within(row(PEER.name))
    expect(
      other.getByText('No external conflict calendar required for basic bookings'),
    ).toBeDefined()
    expect(
      other.getByText('No conference account connected; basic bookings do not require one'),
    ).toBeDefined()
    expect(other.queryByText('No default schedule')).toBeNull()
    expect(
      screen.getByText('An external calendar is optional for basic bookings.', { exact: false }),
    ).toBeDefined()
    expect(screen.getByRole('region', { name: 'Hosts' }).textContent).not.toMatch(
      /ready to (?:take|accept) bookings|can be booked|guaranteed/i,
    )
  })

  it.each([null, 'member', 'adminish', 'admin,unknown'])(
    'does not fetch or expose a peer summary for unresolved or non-manager role %s',
    async (role) => {
      const api = server()
      render(<Editor role={role} />)
      await screen.findByLabelText(PEER.name)
      expect(api.to(READINESS)).toHaveLength(0)
      expect(screen.queryByText('No default schedule')).toBeNull()
      expect(screen.queryByRole('link')).toBeNull()
    },
  )

  it('removes an earlier host observation immediately when the selected host changes', async () => {
    const user = userEvent.setup()
    const pending = later()
    let requests = 0
    const api = server({
      [READINESS]: () =>
        ++requests === 1
          ? pending.response
          : json(200, { organizationId: TEAM_ID, members: [check(SELF)] }),
    })
    render(<Editor />)
    await screen.findByLabelText(SELF.name)
    await waitFor(() => expect(api.to(READINESS)).toHaveLength(1))
    await user.click(screen.getByLabelText(SELF.name))
    await within(row(SELF.name)).findByText('No default schedule')
    await pending.answer(json(200, { organizationId: TEAM_ID, members: [check(PEER)] }))
    expect(within(row(PEER.name)).queryByText('No default schedule')).toBeNull()
    expect(within(row(PEER.name)).queryByRole('link')).toBeNull()
    expect(screen.getByLabelText('Selected host IDs').textContent).toBe(SELF.id)
  })

  it('retries failed member checks without changing hosts or reloading the directory', async () => {
    const user = userEvent.setup()
    let checks = 0
    const api = server({
      [READINESS]: () =>
        ++checks === 1
          ? json(503, { error: 'internal_error' })
          : json(200, { organizationId: TEAM_ID, members: [check()] }),
    })
    render(<Editor />)
    await screen.findByText('Could not check member configuration.')
    expect(screen.queryByText('No default schedule')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry checks' }))
    await screen.findByText('No default schedule')
    expect(api.to(DIRECTORY)).toHaveLength(1)
    expect(api.to(READINESS)).toHaveLength(2)
    expect(screen.getByLabelText('Selected host IDs').textContent).toBe(PEER.id)
  })

  it('clears cached directory pages on a full retry and preserves the saved departed host selection', async () => {
    const user = userEvent.setup()
    let requests = 0
    server({
      [DIRECTORY]: () => {
        requests += 1
        if (requests === 1) return json(200, { data: [PEER], nextAfter: PEER.id })
        if (requests === 2) return json(503, { error: 'internal_error' })
        return json(200, { data: [SELF], nextAfter: null })
      },
    })
    render(<Editor />)
    await screen.findByLabelText(PEER.name)
    await user.click(screen.getByRole('button', { name: 'Load more members' }))
    await screen.findByText(/Could not load team members\./)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByLabelText(SELF.name)
    expect(screen.queryByLabelText(PEER.name)).toBeNull()
    expect(screen.getByLabelText('Selected host IDs').textContent).toBe(PEER.id)
    expect(screen.getByRole('button', { name: 'Remove selected host 1' })).toBeDefined()
  })

  it.each(['collective', 'round_robin'] as const)(
    'explicitly limits automatic Zoom to one host in the %s editor',
    async (schedulingType) => {
      server()
      render(<Editor initial={{ schedulingType, locationKind: 'zoom' }} />)
      await screen.findByLabelText(PEER.name)
      expect(
        screen.getByText('Automatic Zoom supports individual meetings with exactly one host.'),
      ).toBeDefined()
      expect(screen.queryByText(/creates the Meet link/)).toBeNull()
    },
  )

  it('keeps Google Meet organizer eligibility guidance for collective and round-robin hosts', async () => {
    const user = userEvent.setup()
    server()
    render(
      <Editor
        initial={{
          schedulingType: 'collective',
          locationKind: 'google_meet',
          autoCreateMeet: true,
        }}
      />,
    )
    await screen.findByLabelText(PEER.name)
    const organizer = screen.getByLabelText('Meeting organizer')
    expect(within(organizer).getByRole('option', { name: PEER.name })).toBeDefined()
    expect(within(organizer).queryByRole('option', { name: SELF.name })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Scheduling'), 'round_robin')
    expect(screen.queryByLabelText('Meeting organizer')).toBeNull()
    expect(
      screen.getByText(
        'The assigned available host creates the Meet link. Only pool members with an eligible Google calendar can receive new bookings.',
      ),
    ).toBeDefined()
  })

  it('uses the same Chinese coarse reasons and member setup destination', async () => {
    chooseLanguage('zh-CN')
    server()
    render(<Editor />)
    await screen.findByText('未设置默认时间表')
    expect(screen.getByRole('link', { name: '查看成员设置' }).getAttribute('href')).toBe(
      '/app/settings#team-members',
    )
    expect(
      screen.getByText('请该成员检查个人工作时间和日历。只有成员本人可以修改其私人时间表。'),
    ).toBeDefined()
  })
})
