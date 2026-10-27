import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../App.tsx'
import type { OrganizationMember } from '../api/auth.ts'
import { PATHS } from '../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'

const TEAM_ME = {
  ...ME,
  organization: {
    ...ME.organization,
    name: `A long team name ${'没有空格的团队名称'.repeat(24)}`,
    slug: 'example-team',
    personal: false,
  },
}
const MEMBER: OrganizationMember = {
  id: 'membership-1',
  organizationId: TEAM_ME.organization.id,
  userId: TEAM_ME.user.id,
  role: 'admin',
  createdAt: '2026-10-27T10:00:00.000Z',
}

function renderSettingsWithState(state: unknown, path: string = PATHS.settings) {
  let latestState = state
  let latestUrl = path
  const { pathname, search, hash } = new URL(path, window.location.origin)
  function StateProbe() {
    const location = useLocation()
    const navigate = useNavigate()
    latestState = location.state
    latestUrl = location.pathname + location.search + location.hash
    return (
      <button type="button" onClick={() => navigate(-1)}>
        Test previous page
      </button>
    )
  }
  return {
    ...render(
      <MemoryRouter
        initialEntries={[`${PATHS.settings}?previous=1`, { pathname, search, hash, state }]}
        initialIndex={1}
      >
        <App />
        <StateProbe />
      </MemoryRouter>,
    ),
    state: () => latestState,
    url: () => latestUrl,
  }
}

describe('team context in account settings', () => {
  it('offers team creation from a personal organization without reading a team role', async () => {
    const api = fakeApi({ ...signedInAs(ME), ...profile(PROFILE) })
    renderApp(PATHS.settings)
    const account = await screen.findByRole('region', { name: 'Account' })
    const link = within(account).getByRole('link', { name: 'Create team' })
    expect(link.getAttribute('href')).toBe(PATHS.newTeam)
    link.focus()
    expect(document.activeElement).toBe(link)
    expect(within(account).queryByText('Your role')).toBeNull()
    expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(0)
  })

  it.each([
    ['owner', 'Owner', '所有者'],
    ['admin', 'Admin', '管理员'],
    ['member', 'Member', '成员'],
    ['admin,member', 'Admin, Member', '管理员, 成员'],
    ['custom-role', 'custom-role', 'custom-role'],
    ['__proto__', '__proto__', '__proto__'],
  ])(
    'always shows the full team name and actual %s role in both languages',
    async (role, en, zh) => {
      const user = userEvent.setup()
      fakeApi({
        ...signedInAs(TEAM_ME),
        ...profile(PROFILE),
        'GET /api/auth/organization/get-active-member': () => json(200, { ...MEMBER, role }),
      })
      renderApp(PATHS.settings)
      const account = await screen.findByRole('region', { name: 'Account' })
      expect(await within(account).findByText(en)).toBeDefined()
      const name = within(account).getByText(TEAM_ME.organization.name)
      expect(name.classList.contains('user-content')).toBe(true)
      expect(name.textContent).toBe(TEAM_ME.organization.name)
      expect(within(account).getByText('Your role')).toBeDefined()
      await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
      expect(within(account).getByText(zh)).toBeDefined()
      expect(within(account).getByText('你的角色')).toBeDefined()
      expect(within(account).getByText(TEAM_ME.organization.name)).toBeDefined()
      expect(within(account).getByRole('link', { name: '创建团队' })).toBeDefined()
    },
  )

  it('shows loading and a retryable failure without claiming an owner role', async () => {
    const user = userEvent.setup()
    const member = later()
    let reads = 0
    const api = fakeApi({
      ...signedInAs(TEAM_ME),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () =>
        ++reads === 1 ? member.response : json(200, MEMBER),
    })
    renderApp(PATHS.settings)
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(within(account).getByText('Loading your team role…').getAttribute('role')).toBe('status')
    expect(within(account).getByText(TEAM_ME.organization.name)).toBeDefined()
    await member.answer(json(503, { code: 'INTERNAL_SERVER_ERROR' }))
    expect(within(account).getByRole('alert').textContent).toBe('Could not load your team role.')
    expect(within(account).queryByText('Owner')).toBeNull()
    const retry = within(account).getByRole('button', { name: 'Try again' })
    retry.focus()
    await user.keyboard('{Enter}')
    expect(await within(account).findByText('Admin')).toBeDefined()
    expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(2)
  })

  it.each([{ organizationId: 'another-organization' }, { userId: 'another-user' }, { role: '' }])(
    'rejects stale or incomplete membership context: %j',
    async (changed) => {
      fakeApi({
        ...signedInAs(TEAM_ME),
        ...profile(PROFILE),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { ...MEMBER, role: 'owner', ...changed }),
      })
      renderApp(PATHS.settings)
      const account = await screen.findByRole('region', { name: 'Account' })
      expect((await within(account).findByRole('alert')).textContent).toBe(
        'Could not load your team role.',
      )
      expect(within(account).queryByText('Owner')).toBeNull()
      expect(within(account).getByText(TEAM_ME.organization.name)).toBeDefined()
    },
  )

  it('keeps the confirmed created-team role visible while loading and after a failed read', async () => {
    const user = userEvent.setup()
    const member = later()
    fakeApi({
      ...signedInAs(TEAM_ME),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () => member.response,
    })
    const view = renderSettingsWithState(
      { createdMember: { ...MEMBER, role: 'owner' }, returnTo: 'account' },
      `${PATHS.settings}?tab=account#account-heading`,
    )
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(within(account).getByText('Owner')).toBeDefined()
    expect(within(account).getByText('Last confirmed role')).toBeDefined()
    expect(within(account).getByText('Loading your team role…')).toBeDefined()
    await waitFor(() => expect(view.state()).toEqual({ returnTo: 'account' }))
    expect(view.url()).toBe(`${PATHS.settings}?tab=account#account-heading`)
    await member.answer(json(503, { code: 'INTERNAL_SERVER_ERROR' }))
    expect(within(account).getByRole('alert').textContent).toBe('Could not load your team role.')
    expect(within(account).getByText('Owner')).toBeDefined()
    expect(within(account).getByText(TEAM_ME.organization.name)).toBeDefined()
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(within(account).getByText('所有者')).toBeDefined()
    expect(within(account).getByText('上次确认的角色')).toBeDefined()
    expect(within(account).getByRole('button', { name: '重试' })).toBeDefined()
  })

  it('replaces the creation fallback with the fresh server role', async () => {
    const member = later()
    fakeApi({
      ...signedInAs(TEAM_ME),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () => member.response,
    })
    renderSettingsWithState({ createdMember: { ...MEMBER, role: 'owner' } })
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(within(account).getByText('Owner')).toBeDefined()
    await member.answer(json(200, MEMBER))
    expect(within(account).getByText('Admin')).toBeDefined()
    expect(within(account).queryByText('Owner')).toBeNull()
    expect(within(account).queryByText('Last confirmed role')).toBeNull()
  })

  it('consumes the creation fallback so a reload fetches current membership without replaying it', async () => {
    const api = fakeApi({
      ...signedInAs(TEAM_ME),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () =>
        json(503, { code: 'INTERNAL_SERVER_ERROR' }),
    })
    const first = renderSettingsWithState({ createdMember: { ...MEMBER, role: 'owner' } })
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(await within(account).findByText('Owner')).toBeDefined()
    await waitFor(() => expect(first.state()).toBeNull())
    const consumedState = first.state()
    first.unmount()
    renderSettingsWithState(consumedState)
    const reloadedAccount = await screen.findByRole('region', { name: 'Account' })
    await within(reloadedAccount).findByRole('alert')
    expect(within(reloadedAccount).queryByText('Owner')).toBeNull()
    expect(within(reloadedAccount).queryByText('Last confirmed role')).toBeNull()
    expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(2)
  })

  it('consumes route state by replacing the creation destination in history', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedInAs(TEAM_ME),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () => json(200, MEMBER),
    })
    const view = renderSettingsWithState({ createdMember: { ...MEMBER, role: 'owner' } })
    await screen.findByRole('region', { name: 'Account' })
    await waitFor(() => expect(view.state()).toBeNull())
    await user.click(screen.getByRole('button', { name: 'Test previous page' }))
    await waitFor(() => expect(view.url()).toBe(`${PATHS.settings}?previous=1`))
  })

  it.each([
    { organizationId: 'another-organization' },
    { userId: 'another-user' },
    { role: '' },
    { role: '   ' },
    { role: 42 },
  ])('never uses a mismatched or invalid creation fallback: %j', async (changed) => {
    fakeApi({
      ...signedInAs(TEAM_ME),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () =>
        json(503, { code: 'INTERNAL_SERVER_ERROR' }),
    })
    const view = renderSettingsWithState({
      createdMember: { ...MEMBER, role: 'owner', ...changed },
    })
    const account = await screen.findByRole('region', { name: 'Account' })
    await within(account).findByRole('alert')
    expect(within(account).queryByText('Owner')).toBeNull()
    expect(within(account).queryByText('Last confirmed role')).toBeNull()
    await waitFor(() => expect(view.state()).toBeNull())
  })
})
