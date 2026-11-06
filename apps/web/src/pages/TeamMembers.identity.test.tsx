import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { ListedOrganizationMember } from '../api/auth.ts'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { fakeApi, json } from '../test/fake-api.tsx'
import { UnsavedChangesProvider } from '../unsaved-changes.tsx'
import { TeamMembers } from './TeamMembers.tsx'

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const SELF_ID = '00000000-0000-7000-8000-000000000001'
const PEER_ID = '00000000-0000-7000-8000-000000000002'
const NAME = 'Same display name'
const SELF_EMAIL = 'current.member@example.test'
const PEER_EMAIL = `${'long-local-part'.repeat(12)}@team.example.test`
const MEMBERS = 'GET /api/auth/organization/list-members'
const ROLE = 'POST /api/auth/organization/update-member-role'
const REMOVAL = `POST /api/v1/team/members/${PEER_ID}/removal`

const copy = {
  en: {
    members: 'Team members',
    you: 'You',
    makeAdmin: `Make admin: ${NAME}`,
    roleReview: 'Change team role',
    roleQuestion: `Change ${NAME} from Member to Admin?`,
    remove: `Remove member: ${NAME}`,
    removeReview: 'Remove team member',
    note: 'Configuration checks do not guarantee available times. Check the booking page for current availability.',
  },
  'zh-CN': {
    members: '团队成员',
    you: '你',
    makeAdmin: `设为管理员：${NAME}`,
    roleReview: '更改团队角色',
    roleQuestion: `将 ${NAME} 从成员改为管理员？`,
    remove: `移除成员：${NAME}`,
    removeReview: '移除团队成员',
    note: '配置检查不保证有可约时段。当前可约时间以预约页为准。',
  },
} as const

function member(userId: string, role: string, email?: string): ListedOrganizationMember {
  return {
    id: userId === SELF_ID ? 'membership-self' : 'membership-peer',
    organizationId: TEAM_ID,
    userId,
    role,
    createdAt: '2026-10-30T12:00:00.000Z',
    user: { id: userId, name: NAME, ...(email ? { email } : {}) },
  }
}

function server(role: string, includeEmail = role !== 'member') {
  return fakeApi({
    [MEMBERS]: () =>
      json(200, {
        members: [
          member(SELF_ID, role, includeEmail ? SELF_EMAIL : undefined),
          member(PEER_ID, 'member', includeEmail ? PEER_EMAIL : undefined),
        ],
        total: 2,
      }),
    [`GET /api/v1/teams/${TEAM_ID}/member-readiness`]: () =>
      json(200, { organizationId: TEAM_ID, members: [] }),
    'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
    [`GET /api/v1/team/members/${PEER_ID}/departure-impact`]: () =>
      json(200, {
        evaluatedAt: '2026-10-30T12:00:00.000Z',
        eventTypes: { data: [], totalCount: 0, nextCursor: null },
        bookings: { data: [], totalCount: 0, nextCursor: null },
      }),
  })
}

function contents(role: string, currentUserId: string | null = SELF_ID) {
  return (
    <MemoryRouter>
      <UnsavedChangesProvider>
        <InterfaceScope surface="admin">
          <TeamMembers
            organizationId={TEAM_ID}
            role={role}
            currentUserId={currentUserId ?? undefined}
          />
        </InterfaceScope>
      </UnsavedChangesProvider>
    </MemoryRouter>
  )
}

function memberRows() {
  return screen.getAllByText(NAME, { selector: 'li .user-content' }).map((name) => {
    const row = name.closest('li')
    if (!row) throw new Error('Expected a joined member row')
    return row
  })
}

function expectBreakableEmail(element: HTMLElement, email: string) {
  expect(element.textContent).toBe(email)
  expect(element.classList.contains('user-content')).toBe(true)
  expect(element.querySelector('wbr')).not.toBeNull()
}

describe.each(['en', 'zh-CN'] as const)('team member identities in %s', (locale) => {
  it.each(['owner', 'admin'])(
    'shows returned emails below duplicate names and marks only the signed-in %s',
    async (role) => {
      chooseLanguage(locale)
      const api = server(role)
      render(contents(role))
      await screen.findByText(SELF_EMAIL)
      const [self, peer] = memberRows()
      if (!self || !peer) throw new Error('Expected both members')
      expect(memberRows()).toHaveLength(2)
      expect(within(self).getByText(copy[locale].you).classList.contains('badge')).toBe(true)
      expect(within(peer).queryByText(copy[locale].you)).toBeNull()
      for (const [row, email] of [
        [self, SELF_EMAIL],
        [peer, PEER_EMAIL],
      ] as const) {
        const name = within(row).getByText(NAME)
        const address = within(row).getByText(email)
        expectBreakableEmail(address, email)
        expect(address.tagName).toBe('DIV')
        expect(address.previousElementSibling).toBe(name.parentElement)
      }
      expect(api.to(MEMBERS)).toHaveLength(1)
    },
  )

  it('keeps the ordinary-member public summary without requesting missing emails', async () => {
    chooseLanguage(locale)
    const api = server('member')
    render(contents('member'))
    await screen.findAllByText(NAME)
    const [self, peer] = memberRows()
    if (!self || !peer) throw new Error('Expected both members')
    expect(within(self).getByText(copy[locale].you)).toBeDefined()
    expect(within(peer).queryByText(copy[locale].you)).toBeNull()
    expect(self.textContent).not.toContain('@')
    expect(peer.textContent).not.toContain('@')
    expect(within(self).queryByRole('button')).toBeNull()
    expect(within(peer).queryByRole('button')).toBeNull()
    expect(
      api.calls.every((call) =>
        [MEMBERS.split(' ')[1], `/api/v1/teams/${TEAM_ID}/member-readiness`].some(
          (path) => call.path.split('?')[0] === path,
        ),
      ),
    ).toBe(true)
    expect(api.to(MEMBERS)).toHaveLength(1)
  })

  it('does not show unexpected email fields to an ordinary member', async () => {
    chooseLanguage(locale)
    server('member', true)
    render(contents('member'))
    await screen.findAllByText(NAME)
    expect(screen.queryByText(SELF_EMAIL)).toBeNull()
    expect(screen.queryByText(PEER_EMAIL)).toBeNull()
  })

  it('identifies the selected same-name member by email in the role-change confirmation', async () => {
    chooseLanguage(locale)
    const user = userEvent.setup()
    const api = server('owner')
    render(contents('owner'))
    await user.click(await screen.findByRole('button', { name: copy[locale].makeAdmin }))
    const review = screen.getByRole('region', { name: copy[locale].roleReview })
    expect(within(review).getByText(copy[locale].roleQuestion)).toBeDefined()
    expectBreakableEmail(within(review).getByText(PEER_EMAIL), PEER_EMAIL)
    expect(within(review).queryByText(SELF_EMAIL)).toBeNull()
    expect(api.to(ROLE)).toHaveLength(0)
  })

  it.each(['owner', 'admin'])(
    'identifies the selected same-name member by email in the %s removal confirmation',
    async (role) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      const api = server(role)
      render(contents(role))
      await user.click(await screen.findByRole('button', { name: copy[locale].remove }))
      const review = screen.getByRole('region', { name: copy[locale].removeReview })
      expect(within(review).getByText(NAME)).toBeDefined()
      expectBreakableEmail(within(review).getByText(PEER_EMAIL), PEER_EMAIL)
      expect(within(review).queryByText(SELF_EMAIL)).toBeNull()
      expect(api.to(REMOVAL)).toHaveLength(0)
    },
  )

  it('keeps the readiness note outside member rows and action columns', () => {
    chooseLanguage(locale)
    server('member')
    render(contents('member'))
    const section = screen.getByRole('region', { name: copy[locale].members })
    const note = within(section).getByText(
      (text, element) => element?.tagName === 'P' && text.includes(copy[locale].note),
    )
    expect(note.tagName).toBe('P')
    expect(note.classList.contains('hint')).toBe(true)
    expect(note.parentElement).toBe(section)
    expect(note.closest('.card-item, .card-actions, li')).toBeNull()
  })
})

it.each(['role', 'remove'] as const)(
  'omits an unavailable email from the %s confirmation',
  async (action) => {
    const user = userEvent.setup()
    server('owner', false)
    render(contents('owner'))
    await user.click(
      await screen.findByRole('button', {
        name: action === 'role' ? copy.en.makeAdmin : copy.en.remove,
      }),
    )
    for (const row of memberRows()) {
      expect(row.querySelector('.hint.user-content')).toBeNull()
    }
    const review = screen.getByRole('region', {
      name: action === 'role' ? copy.en.roleReview : copy.en.removeReview,
    })
    expect(review.querySelectorAll('p.user-content')).toHaveLength(1)
    expect(review.textContent).not.toContain('@')
    expect(review.textContent).not.toContain('undefined')
  },
)

it('does not mark a member as You before the signed-in identity is known', async () => {
  server('owner')
  render(contents('owner', null))
  await screen.findByText(SELF_EMAIL)
  expect(screen.queryAllByText(copy.en.you)).toHaveLength(0)
})
