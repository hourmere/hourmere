import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ListedOrganizationMember } from '../api/auth.ts'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { type Routes as ApiRoutes, fakeApi, json, later } from '../test/fake-api.tsx'
import { UnsavedChangesProvider } from '../unsaved-changes.tsx'
import { TeamMembers } from './TeamMembers.tsx'

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const OTHER_TEAM_ID = '00000000-0000-7000-8000-000000000020'
const SELF_ID = '00000000-0000-7000-8000-000000000001'
const MEMBERS_ROUTE = 'GET /api/auth/organization/list-members'
const READINESS_ROUTE = `GET /api/v1/teams/${TEAM_ID}/member-readiness`
const OTHER_READINESS_ROUTE = `GET /api/v1/teams/${OTHER_TEAM_ID}/member-readiness`
const MEMBER_ROLE = 'member'
const EVALUATED_AT = '2026-10-30T12:00:00.000Z'

function member(number: number, name = `Joined person ${number}`): ListedOrganizationMember {
  const userId = `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`
  return {
    id: `00000000-0000-7000-8000-${String(number + 100).padStart(12, '0')}`,
    organizationId: TEAM_ID,
    userId,
    role: number === 1 ? 'owner' : 'member',
    createdAt: EVALUATED_AT,
    user: { id: userId, name },
  }
}

const self = member(1, 'Current member')
const peer = member(2, 'Other member')

type Health = {
  defaultSchedule:
    | 'satisfied'
    | 'not_applicable'
    | 'configuration_blocker'
    | 'dependency_unavailable'
    | 'not_checked'
    | 'check_failed'
  selectedCalendars:
    | 'satisfied'
    | 'not_applicable'
    | 'configuration_blocker'
    | 'dependency_unavailable'
    | 'not_checked'
    | 'check_failed'
  conferenceAccounts: 'connected' | 'attention_required' | 'not_connected' | 'check_failed'
}

function check(target = self, health: Partial<Health> = {}) {
  return {
    memberId: target.id,
    displayName: target.user.name,
    summary: 'checks_passed',
    completeness: 'complete',
    evaluatedAt: EVALUATED_AT,
    reasonCodes: [],
    fixKinds: [],
    health: {
      defaultSchedule: 'satisfied',
      selectedCalendars: 'not_applicable',
      conferenceAccounts: 'not_connected',
      ...health,
    },
  }
}

function page(members = [check(self), check(peer)], organizationId = TEAM_ID) {
  return { organizationId, members }
}

function server(overrides: ApiRoutes = {}, members = [self, peer]) {
  return fakeApi({
    [MEMBERS_ROUTE]: () => json(200, { members, total: members.length }),
    [READINESS_ROUTE]: () => json(200, page(members.map((item) => check(item)))),
    'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
    ...overrides,
  })
}

function contents({
  organizationId = TEAM_ID,
  currentUserId = SELF_ID,
  role = 'owner',
  onReload = () => {},
}: {
  organizationId?: string
  currentUserId?: string
  role?: string | null
  onReload?: () => void
} = {}) {
  return (
    <MemoryRouter>
      <UnsavedChangesProvider>
        <InterfaceScope surface="admin">
          <TeamMembers
            organizationId={organizationId}
            currentUserId={currentUserId}
            role={role}
            onReload={onReload}
          />
        </InterfaceScope>
      </UnsavedChangesProvider>
    </MemoryRouter>
  )
}

function row(name: string) {
  const element = screen.getByText(name, { selector: 'li .user-content' }).closest('li')
  if (!element) throw new Error('Expected a joined member row')
  return element
}

function selectedIds(path: string) {
  return new URL(path, window.location.origin).searchParams.get('memberIds')?.split(',')
}

function expectOnlySummaryRequests(api: ReturnType<typeof fakeApi>) {
  expect(api.to('GET /api/v1/readiness/self')).toHaveLength(0)
  expect(api.to(`GET /api/v1/teams/${TEAM_ID}/readiness`)).toHaveLength(0)
  for (const path of ['/schedules', '/calendar-connections', '/conference-connections']) {
    expect(api.calls.some((call) => call.path.startsWith(`/api/v1${path}`))).toBe(false)
  }
}

// These are public-facing health statements. The snapshot must never assert a slot exists.
function expectNoBookingPromise(element: HTMLElement) {
  expect(element.textContent).not.toMatch(
    /ready to (?:take|accept) bookings|can be booked|available (?:now|for bookings)|guaranteed|可立即预约|保证可预约|可供预约|现在有空/i,
  )
}

describe('team member readiness privacy and batching', () => {
  it.each(['owner', 'admin', 'member, admin'])(
    'shows coarse member health in one page request for %s',
    async (role) => {
      const api = server({
        [READINESS_ROUTE]: () =>
          json(
            200,
            page([
              check(self),
              check(peer, {
                defaultSchedule: 'configuration_blocker',
                selectedCalendars: 'dependency_unavailable',
                conferenceAccounts: 'attention_required',
              }),
            ]),
          ),
      })
      render(contents({ role }))
      await screen.findByText('No default schedule')
      expect(selectedIds(api.to(READINESS_ROUTE)[0]?.path ?? '')).toEqual([self.id, peer.id])
      expect(api.to(READINESS_ROUTE)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM_ID)
      expect(api.to(READINESS_ROUTE)).toHaveLength(1)
      expect(
        within(row(peer.user.name)).getByRole('region', { name: 'Member readiness' }),
      ).toBeDefined()
      expect(
        within(row(peer.user.name)).getByText('Selected calendars need attention'),
      ).toBeDefined()
      expect(
        within(row(peer.user.name)).getByText('Conference accounts need attention'),
      ).toBeDefined()
      expect(
        within(row(peer.user.name))
          .getByRole('link', { name: 'View hosted team events' })
          .getAttribute('href'),
      ).toBe(`/app/event-types?hostUserId=${peer.userId}`)
      expectOnlySummaryRequests(api)
      expectNoBookingPromise(screen.getByRole('region', { name: 'Team members' }))
    },
  )

  it('keeps another member neutral for an ordinary member without reading private self details', async () => {
    const api = server({ [READINESS_ROUTE]: () => json(200, page([check(self)])) })
    render(contents({ role: 'member' }))
    await screen.findAllByText('Default schedule set')
    expect(
      within(row(peer.user.name)).getByText(
        'Only team owners and admins can view other members’ readiness.',
      ),
    ).toBeDefined()
    expect(within(row(peer.user.name)).queryByText('No default schedule')).toBeNull()
    expect(within(row(peer.user.name)).queryByRole('link')).toBeNull()
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
    expectOnlySummaryRequests(api)
  })

  it.each(['owner', 'admin', 'member'])(
    'ignores private response fields instead of rendering them for %s',
    async (role) => {
      const privateData = {
        calendarTitle: 'Private calendar marker',
        accountEmail: 'private-calendar-account@example.test',
        scheduleName: 'Private weekly schedule marker',
        details: {
          calendars: [
            {
              name: 'Private calendar marker',
              accountEmail: 'private-calendar-account@example.test',
            },
          ],
          schedules: [{ name: 'Private weekly schedule marker' }],
        },
        events: [{ title: 'Private event marker', description: 'Private description marker' }],
        busyMap: 'Private busy map marker',
      }
      const api = server({
        [READINESS_ROUTE]: () =>
          json(
            200,
            page([
              check(self),
              ...(role === 'member'
                ? []
                : [
                    {
                      ...check(peer),
                      ...privateData,
                      health: { ...check(peer).health, ...privateData },
                    },
                  ]),
            ]),
          ),
      })
      render(contents({ role }))
      await screen.findAllByText('Default schedule set')
      const members = screen.getByRole('region', { name: 'Team members' })
      for (const marker of [
        privateData.calendarTitle,
        privateData.accountEmail,
        privateData.scheduleName,
        privateData.events[0]?.title ?? '',
        privateData.events[0]?.description ?? '',
        privateData.busyMap,
      ]) {
        expect(members.innerHTML).not.toContain(marker)
      }
      expect(api.to(READINESS_ROUTE)).toHaveLength(1)
      expectOnlySummaryRequests(api)
    },
  )

  it('reads exactly the displayed membership IDs once per members page', async () => {
    const user = userEvent.setup()
    const people = Array.from({ length: 21 }, (_, index) => member(index + 1))
    const api = server({
      [MEMBERS_ROUTE]: ({ path }) => {
        const offset = Number(new URL(path, window.location.origin).searchParams.get('offset'))
        return json(200, { members: people.slice(offset, offset + 20), total: people.length })
      },
      [READINESS_ROUTE]: ({ path }) =>
        json(
          200,
          page(
            people
              .filter((person) => selectedIds(path)?.includes(person.id))
              .map((person) => check(person)),
          ),
        ),
    })
    render(contents())
    await screen.findAllByText('Default schedule set')
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
    expect(selectedIds(api.to(READINESS_ROUTE)[0]?.path ?? '')).toEqual(
      people.slice(0, 20).map((person) => person.id),
    )
    await user.click(screen.getByRole('button', { name: 'Next members page' }))
    await screen.findByText('Joined person 21')
    await waitFor(() => expect(api.to(READINESS_ROUTE)).toHaveLength(2))
    expect(selectedIds(api.to(READINESS_ROUTE)[1]?.path ?? '')).toEqual([people[20]?.id])
    expect(screen.queryByText('Joined person 1')).toBeNull()
    expectOnlySummaryRequests(api)
  })

  it('does not fetch readiness before joined members or the current role is available', async () => {
    const response = later()
    const api = server({ [MEMBERS_ROUTE]: () => response.response })
    const view = render(contents({ role: null }))
    expect(api.to(READINESS_ROUTE)).toHaveLength(0)
    await response.answer(json(200, { members: [self, peer], total: 2 }))
    expect(api.to(READINESS_ROUTE)).toHaveLength(0)
    view.rerender(contents({ role: 'owner' }))
    await screen.findAllByText('Default schedule set')
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
  })

  it('does not infer successful configuration for a missing member summary', async () => {
    server({ [READINESS_ROUTE]: () => json(200, page([check(self)])) })
    render(contents())
    await screen.findAllByText('Default schedule set')
    const other = within(row(peer.user.name))
    expect(other.queryByText('Default schedule set')).toBeNull()
    expect(other.queryByText('No default schedule')).toBeNull()
    expect(
      other.queryByText('No external conflict calendar required for basic bookings'),
    ).toBeNull()
  })
})

const copy = {
  en: {
    ready: 'Default schedule set',
    missing: 'No default schedule',
    loading: 'Checking member configuration…',
    error: 'Could not check member configuration.',
    retry: 'Retry checks',
    reload: 'Reload team',
    denied: 'Your permission or team membership changed. Reload to check before trying again.',
    scheduleLink: 'Configure default schedule',
    calendarsLink: 'Configure calendars',
    conferenceLink: 'Review conference accounts',
    reuse: 'Your default schedule is reused in every team you belong to.',
    optionalCalendar: 'No external conflict calendar required for basic bookings',
    safety:
      'Configuration checks do not guarantee available times. Check the booking page for current availability.',
  },
  'zh-CN': {
    ready: '已设置默认时间表',
    missing: '未设置默认时间表',
    loading: '正在检查成员配置…',
    error: '无法检查成员配置。',
    retry: '重试检查',
    reload: '重新加载团队',
    denied: '你的权限或团队成员关系已变更。请重新加载并核实后再试。',
    scheduleLink: '配置默认时间表',
    calendarsLink: '配置日历',
    conferenceLink: '检查会议账户',
    reuse: '你加入的所有团队共用你的个人默认时间表。',
    optionalCalendar: '基本预约无需外部冲突检查日历',
    safety: '配置检查不保证有可约时段。当前可约时间以预约页为准。',
  },
} as const

describe.each(['en', 'zh-CN'] as const)(
  'member readiness recovery and own configuration in %s',
  (language) => {
    it('keeps missing default hours distinct from current free time and an optional external calendar', async () => {
      chooseLanguage(language)
      const api = server({
        [READINESS_ROUTE]: () =>
          json(
            200,
            page([
              {
                ...check(self, { defaultSchedule: 'configuration_blocker' }),
                summary: 'configuration_blocked',
              },
              check(peer),
            ]),
          ),
      })
      render(contents())
      await screen.findByText(copy[language].missing)
      const ownRow = within(row(self.user.name))
      const otherRow = within(row(peer.user.name))
      expect(ownRow.getByText(copy[language].optionalCalendar)).toBeDefined()
      expect(otherRow.getByText(copy[language].ready)).toBeDefined()
      expect(otherRow.getByText(copy[language].optionalCalendar)).toBeDefined()
      expect(screen.getByText(copy[language].safety, { exact: false })).toBeDefined()
      expect(row(self.user.name).textContent).not.toMatch(
        /no (?:free time|availability|available slots)|没有空闲|没有可用时段/i,
      )
      expectNoBookingPromise(row(self.user.name))
      expectNoBookingPromise(row(peer.user.name))
      expectOnlySummaryRequests(api)
    })

    it('offers only the signed-in member keyboard-accessible global configuration links', async () => {
      chooseLanguage(language)
      const user = userEvent.setup()
      server()
      render(contents())
      await screen.findAllByText(copy[language].ready)
      const ownRow = within(row(self.user.name))
      const otherRow = within(row(peer.user.name))
      const links = [
        [copy[language].scheduleLink, '/app/availability'],
        [copy[language].calendarsLink, '/app/calendars'],
        [copy[language].conferenceLink, '/app/conferences'],
      ]
      expect(ownRow.getByText(copy[language].reuse)).toBeDefined()
      expect(otherRow.queryByText(copy[language].reuse)).toBeNull()
      expect(otherRow.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        `/app/event-types?hostUserId=${peer.userId}`,
      ])
      for (const [label, href] of links) {
        const link = ownRow.getByRole('link', { name: label })
        expect(link.getAttribute('href')).toBe(href)
        expect(link.getAttribute('tabindex')).not.toBe('-1')
      }
      const first = ownRow.getByRole('link', { name: copy[language].scheduleLink })
      first.focus()
      expect(document.activeElement).toBe(first)
      await user.tab()
      expect(document.activeElement).toBe(
        ownRow.getByRole('link', { name: copy[language].calendarsLink }),
      )
      await user.tab()
      expect(document.activeElement).toBe(
        ownRow.getByRole('link', { name: copy[language].conferenceLink }),
      )
    })

    it('shows a live loading state without inventing healthy rows', async () => {
      chooseLanguage(language)
      const response = later()
      const api = server({ [READINESS_ROUTE]: () => response.response })
      render(contents())
      const loading = await screen.findByText(copy[language].loading)
      expect(loading.getAttribute('role')).toBe('status')
      expect(screen.queryByText(copy[language].ready)).toBeNull()
      expect(screen.queryByText(copy[language].missing)).toBeNull()
      await response.answer(json(200, page()))
      await screen.findAllByText(copy[language].ready)
      expect(screen.queryByText(copy[language].loading)).toBeNull()
      expect(api.to(READINESS_ROUTE)).toHaveLength(1)
    })

    it('retries a failed summary without reloading members or reading private resources', async () => {
      chooseLanguage(language)
      const user = userEvent.setup()
      let attempts = 0
      const api = server({
        [READINESS_ROUTE]: () =>
          ++attempts === 1 ? json(503, { error: 'internal_error' }) : json(200, page()),
      })
      render(contents())
      await screen.findByText(copy[language].error)
      expect(screen.getByText(self.user.name)).toBeDefined()
      await user.click(screen.getByRole('button', { name: copy[language].retry }))
      await screen.findAllByText(copy[language].ready)
      expect(api.to(READINESS_ROUTE)).toHaveLength(2)
      expect(api.to(MEMBERS_ROUTE)).toHaveLength(1)
      expectOnlySummaryRequests(api)
    })

    it.each([
      { status: 403, error: 'team_management_access_denied', guidance: 'denied' },
      { status: 409, error: 'organization_context_changed', guidance: 'denied' },
    ] as const)(
      'uses existing reload guidance for $status $error',
      async ({ status, error, guidance }) => {
        chooseLanguage(language)
        const user = userEvent.setup()
        const reload = vi.fn()
        const api = server({ [READINESS_ROUTE]: () => json(status, { error }) })
        render(contents({ onReload: reload }))
        await screen.findByText(copy[language][guidance])
        expect(screen.queryByText(copy[language].ready)).toBeNull()
        expect(screen.queryByText(copy[language].error)).toBeNull()
        expect(screen.queryByRole('button', { name: copy[language].retry })).toBeNull()
        await user.click(screen.getByRole('button', { name: copy[language].reload }))
        expect(reload).toHaveBeenCalledTimes(1)
        expect(api.to(READINESS_ROUTE)).toHaveLength(1)
      },
    )
  },
)

describe('member configuration refresh and context isolation', () => {
  it.each(['focus', 'visibilitychange'] as const)(
    'refreshes once after configuration when the page receives %s',
    async (event) => {
      let configured = false
      const api = server({
        [READINESS_ROUTE]: () =>
          json(
            200,
            page([
              check(self, { defaultSchedule: configured ? 'satisfied' : 'configuration_blocker' }),
              check(peer),
            ]),
          ),
      })
      render(contents())
      await screen.findByText(copy.en.missing)
      configured = true
      if (event === 'visibilitychange') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        act(() => {
          document.dispatchEvent(new Event(event))
        })
      } else
        act(() => {
          window.dispatchEvent(new Event(event))
        })
      expect(await within(row(self.user.name)).findByText(copy.en.ready)).toBeDefined()
      expect(within(row(self.user.name)).queryByText(copy.en.missing)).toBeNull()
      expect(api.to(READINESS_ROUTE)).toHaveLength(2)
      expect(api.to(MEMBERS_ROUTE)).toHaveLength(1)
    },
  )

  it('coalesces a focus and visibility return into one refreshed page summary', async () => {
    let configured = false
    const api = server({
      [READINESS_ROUTE]: () =>
        json(
          200,
          page([
            check(self, { defaultSchedule: configured ? 'satisfied' : 'configuration_blocker' }),
            check(peer),
          ]),
        ),
    })
    render(contents())
    await screen.findByText(copy.en.missing)
    configured = true
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(await within(row(self.user.name)).findByText(copy.en.ready)).toBeDefined()
    expect(api.to(READINESS_ROUTE)).toHaveLength(2)
    expect(api.to(MEMBERS_ROUTE)).toHaveLength(1)
  })

  it('does not refresh while the document is hidden', async () => {
    const api = server()
    render(contents())
    await screen.findAllByText(copy.en.ready)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
  })

  it('fetches the updated global default after following its configuration link and returning', async () => {
    const user = userEvent.setup()
    let configured = false
    const api = server({
      [READINESS_ROUTE]: () =>
        json(
          200,
          page([
            check(self, { defaultSchedule: configured ? 'satisfied' : 'configuration_blocker' }),
            check(peer),
          ]),
        ),
    })
    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <UnsavedChangesProvider>
          <InterfaceScope surface="admin">
            <Routes>
              <Route
                path="/app/settings"
                element={
                  <TeamMembers
                    organizationId={TEAM_ID}
                    currentUserId={SELF_ID}
                    role={MEMBER_ROLE}
                  />
                }
              />
              <Route
                path="/app/availability"
                element={
                  <Link
                    to="/app/settings"
                    onClick={() => {
                      configured = true
                    }}
                  >
                    Return to members
                  </Link>
                }
              />
            </Routes>
          </InterfaceScope>
        </UnsavedChangesProvider>
      </MemoryRouter>,
    )
    await screen.findByText(copy.en.missing)
    await user.click(screen.getByRole('link', { name: copy.en.scheduleLink }))
    await user.click(screen.getByRole('link', { name: 'Return to members' }))
    await screen.findAllByText(copy.en.ready)
    expect(within(row(self.user.name)).getByText(copy.en.reuse)).toBeDefined()
    expect(api.to(READINESS_ROUTE)).toHaveLength(2)
    expect(api.to(MEMBERS_ROUTE)).toHaveLength(2)
  })

  it('discards a late summary after switching to another team, retaining the global schedule note', async () => {
    const response = later()
    const otherSelf = { ...self, organizationId: OTHER_TEAM_ID }
    const api = server({
      [READINESS_ROUTE]: () => response.response,
      [OTHER_READINESS_ROUTE]: () => json(200, page([check(otherSelf)], OTHER_TEAM_ID)),
      [MEMBERS_ROUTE]: ({ path }) =>
        new URL(path, window.location.origin).searchParams.get('organizationId') === TEAM_ID
          ? json(200, { members: [self, peer], total: 2 })
          : json(200, { members: [otherSelf], total: 1 }),
    })
    const view = render(contents())
    await screen.findByText(copy.en.loading)
    view.rerender(contents({ organizationId: OTHER_TEAM_ID }))
    await screen.findAllByText(copy.en.ready)
    await response.answer(
      json(200, page([check(self, { defaultSchedule: 'configuration_blocker' }), check(peer)])),
    )
    expect(screen.queryByText(copy.en.missing)).toBeNull()
    expect(screen.queryByText(peer.user.name)).toBeNull()
    expect(within(row(self.user.name)).getByText(copy.en.reuse)).toBeDefined()
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
    expect(api.to(OTHER_READINESS_ROUTE)).toHaveLength(1)
    expect(api.to(OTHER_READINESS_ROUTE)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      OTHER_TEAM_ID,
    )
    expect(selectedIds(api.to(OTHER_READINESS_ROUTE)[0]?.path ?? '')).toEqual([otherSelf.id])
  })

  it('rejects a response claiming the wrong team instead of showing its member health', async () => {
    server({ [READINESS_ROUTE]: () => json(200, page([check(self)], OTHER_TEAM_ID)) })
    render(contents())
    await screen.findByText(copy.en.denied)
    expect(screen.queryByText(copy.en.ready)).toBeNull()
    expect(screen.getByRole('button', { name: copy.en.reload })).toBeDefined()
  })
})

describe('member health observations', () => {
  it.each([
    {
      language: 'en',
      health: {
        defaultSchedule: 'satisfied',
        selectedCalendars: 'satisfied',
        conferenceAccounts: 'connected',
      },
      labels: [
        'Default schedule set',
        'Selected calendar checks passed',
        'Conference account connected',
      ],
    },
    {
      language: 'zh-CN',
      health: {
        defaultSchedule: 'satisfied',
        selectedCalendars: 'satisfied',
        conferenceAccounts: 'connected',
      },
      labels: ['已设置默认时间表', '所选日历检查通过', '已连接会议账户'],
    },
    {
      language: 'en',
      health: {
        defaultSchedule: 'not_checked',
        selectedCalendars: 'not_checked',
        conferenceAccounts: 'check_failed',
      },
      labels: [
        'Default schedule not checked',
        'Selected calendars not checked',
        'Conference account check failed',
      ],
    },
    {
      language: 'zh-CN',
      health: {
        defaultSchedule: 'check_failed',
        selectedCalendars: 'check_failed',
        conferenceAccounts: 'attention_required',
      },
      labels: ['默认时间表检查失败', '所选日历检查失败', '会议账户需要处理'],
    },
  ] as const)(
    'renders only the observed health axes in $language: $labels',
    async ({ language, health, labels }) => {
      chooseLanguage(language)
      server({ [READINESS_ROUTE]: () => json(200, page([check(self, health)])) })
      render(contents({ role: 'member' }))
      await screen.findByText(self.user.name)
      const own = within(row(self.user.name))
      for (const label of labels) expect(await own.findByText(label)).toBeDefined()
      expectNoBookingPromise(row(self.user.name))
    },
  )

  it('ignores a superseded refresh response even within the same team', async () => {
    const first = later()
    let requests = 0
    const api = server({
      [READINESS_ROUTE]: () => (++requests === 1 ? first.response : json(200, page())),
    })
    render(contents())
    await screen.findByText(copy.en.loading)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await screen.findAllByText(copy.en.ready)
    await first.answer(json(200, page([check(self, { defaultSchedule: 'configuration_blocker' })])))
    expect(within(row(self.user.name)).getByText(copy.en.ready)).toBeDefined()
    expect(screen.queryByText(copy.en.missing)).toBeNull()
    expect(api.to(READINESS_ROUTE)).toHaveLength(2)
  })

  it('clears peer health while checking a downgraded member role', async () => {
    const downgraded = later()
    let requests = 0
    const api = server({
      [READINESS_ROUTE]: () => (++requests === 1 ? json(200, page()) : downgraded.response),
    })
    const view = render(contents())
    await screen.findAllByText(copy.en.ready)
    expect(within(row(peer.user.name)).getByText(copy.en.ready)).toBeDefined()
    view.rerender(contents({ role: 'member' }))
    expect(within(row(peer.user.name)).queryByText(copy.en.ready)).toBeNull()
    await downgraded.answer(json(200, page([check(self)])))
    expect(
      within(row(peer.user.name)).getByText(
        'Only team owners and admins can view other members’ readiness.',
      ),
    ).toBeDefined()
    expect(within(row(peer.user.name)).queryByText(copy.en.ready)).toBeNull()
    expect(api.to(READINESS_ROUTE)).toHaveLength(2)
  })
})

describe('member readiness defensive boundaries and partial retry', () => {
  it('keeps peer configuration neutral if an ordinary member receives an unexpected peer summary', async () => {
    const api = server({
      [READINESS_ROUTE]: () =>
        json(
          200,
          page([
            check(self),
            check(peer, {
              defaultSchedule: 'configuration_blocker',
              selectedCalendars: 'dependency_unavailable',
              conferenceAccounts: 'attention_required',
            }),
          ]),
        ),
    })
    render(contents({ role: 'member' }))
    await screen.findByText(copy.en.ready)
    const other = within(row(peer.user.name))
    expect(
      other.getByText('Only team owners and admins can view other members’ readiness.'),
    ).toBeDefined()
    expect(other.queryByText(copy.en.missing)).toBeNull()
    expect(other.queryByText('Selected calendars need attention')).toBeNull()
    expect(other.queryByText('Conference accounts need attention')).toBeNull()
    expect(row(peer.user.name).querySelector('.member-readiness-health')).toBeNull()
    expect(other.queryByRole('link')).toBeNull()
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
    expectOnlySummaryRequests(api)
  })

  it.each([
    { health: { defaultSchedule: 'check_failed' }, label: 'Default schedule check failed' },
    { health: { defaultSchedule: 'not_checked' }, label: 'Default schedule not checked' },
    { health: { selectedCalendars: 'check_failed' }, label: 'Selected calendar check failed' },
    { health: { selectedCalendars: 'not_checked' }, label: 'Selected calendars not checked' },
    { health: { conferenceAccounts: 'check_failed' }, label: 'Conference account check failed' },
  ] as const)(
    'retries a successful summary containing $label without refetching the members',
    async ({ health, label }) => {
      const user = userEvent.setup()
      let requests = 0
      const api = server({
        [READINESS_ROUTE]: () =>
          json(200, page([check(self, ++requests === 1 ? health : {}), check(peer)])),
      })
      render(contents())
      await screen.findByText(self.user.name)
      expect(await within(row(self.user.name)).findByText(label)).toBeDefined()
      expect(screen.queryByText(copy.en.error)).toBeNull()
      await user.click(screen.getByRole('button', { name: copy.en.retry }))
      expect(await within(row(self.user.name)).findByText(copy.en.ready)).toBeDefined()
      expect(within(row(self.user.name)).queryByText(label)).toBeNull()
      expect(screen.queryByRole('button', { name: copy.en.retry })).toBeNull()
      expect(api.to(READINESS_ROUTE)).toHaveLength(2)
      expect(api.to(MEMBERS_ROUTE)).toHaveLength(1)
      expectOnlySummaryRequests(api)
    },
  )
})
