import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ListedOrganizationMember } from '../api/auth.ts'
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
import { UnsavedChangesProvider } from '../unsaved-changes.tsx'
import { TeamMembers } from './TeamMembers.tsx'

const TEAM_ID = '00000000-0000-7000-8000-000000000010'
const OTHER_TEAM_ID = '00000000-0000-7000-8000-000000000020'
const SELF_ID = '00000000-0000-7000-8000-000000000001'
const ROLE_ROUTE = 'POST /api/auth/organization/update-member-role'

function member(number: number, name: string, role: string): ListedOrganizationMember {
  const userId = `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`
  return {
    id: `00000000-0000-7000-8000-${String(number + 100).padStart(12, '0')}`,
    organizationId: TEAM_ID,
    userId,
    role,
    createdAt: '2026-10-27T10:00:00.000Z',
    user: { id: userId, name },
  }
}

const self = member(1, 'Current owner', 'owner')
const owner = member(2, 'Other owner', 'owner')
const admin = member(3, 'Team admin', 'admin')
const ordinaryMember = member(4, 'Team member', 'member')

function teamServer(routes: Routes = {}, members = [self, owner, admin, ordinaryMember]) {
  return fakeApi({
    'GET /api/auth/organization/list-members': () => json(200, { members, total: members.length }),
    'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
    [`GET /api/v1/teams/${TEAM_ID}/member-readiness`]: () =>
      json(200, { organizationId: TEAM_ID, members: [] }),
    [`GET /api/v1/teams/${OTHER_TEAM_ID}/member-readiness`]: () =>
      json(200, { organizationId: OTHER_TEAM_ID, members: [] }),
    ...routes,
  })
}

function contents({
  role = 'owner',
  organizationId = TEAM_ID,
  onReload = () => {},
}: {
  role?: string | null
  organizationId?: string
  onReload?: () => void
} = {}) {
  return (
    <MemoryRouter>
      <UnsavedChangesProvider>
        <InterfaceScope surface="admin">
          <TeamMembers
            organizationId={organizationId}
            currentUserId={SELF_ID}
            role={role}
            onReload={onReload}
          />
        </InterfaceScope>
      </UnsavedChangesProvider>
    </MemoryRouter>
  )
}

function memberRow(name: string) {
  const row = screen.getByText(name, { selector: 'li .user-content' }).closest('li')
  if (!row) throw new Error('Expected a joined member row')
  return within(row)
}

async function openRole(user: ReturnType<typeof userEvent.setup>, name = 'Team member') {
  await user.click(await screen.findByRole('button', { name: `Make admin: ${name}` }))
  await screen.findByRole('heading', { name: 'Change team role' })
}

function noSuccess() {
  expect(screen.queryByText(/is now (Admin|Member)\./)).toBeNull()
}

describe('team role management in settings', () => {
  it('confirms the named member and waits for a bound server response before updating their row', async () => {
    const user = userEvent.setup()
    const response = later()
    const api = teamServer({
      [ROLE_ROUTE]: ({ headers }) =>
        headers.get('X-Expected-Organization-Id') === TEAM_ID
          ? response.response
          : json(409, { code: 'ORGANIZATION_CONTEXT_CHANGED' }),
    })
    render(contents())
    await openRole(user)
    expect(screen.getByText('Change Team member from Member to Admin?')).toBeDefined()
    expect(screen.getByText('They will gain admin permissions.')).toBeDefined()
    expect(screen.getByText(/Admins can.*invit|Admins can.*team events/i)).toBeDefined()
    expect(screen.getByText(/Members can.*own|Members can.*personal/i)).toBeDefined()
    expect(api.to(ROLE_ROUTE)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    expect(api.to(ROLE_ROUTE)[0]?.body).toEqual({
      organizationId: TEAM_ID,
      memberId: ordinaryMember.id,
      role: 'admin',
    })
    expect(api.to(ROLE_ROUTE)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM_ID)
    expect(memberRow('Team member').getByText('Member')).toBeDefined()
    expect(memberRow('Team member').queryByText('Admin')).toBeNull()
    noSuccess()
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: 'Change team role' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Changing role…' }))
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    await response.answer(json(200, { ...ordinaryMember, role: 'admin' }))
    await screen.findByText('Team member is now Admin.')
    expect(memberRow('Team member').getByText('Admin')).toBeDefined()
    expect(memberRow('Team member').queryByText('Member')).toBeNull()
    expect(await screen.findByRole('button', { name: 'Make member: Team member' })).toBeDefined()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Make member: Team member' }),
      ),
    )
    expect(api.to('GET /api/auth/organization/list-members')).toHaveLength(1)
  })

  it('lets an owner demote an admin after explaining the permissions that change', async () => {
    const user = userEvent.setup()
    const api = teamServer({ [ROLE_ROUTE]: () => json(200, { ...admin, role: 'member' }) })
    render(contents())
    await user.click(await screen.findByRole('button', { name: 'Make member: Team admin' }))
    expect(await screen.findByText('Change Team admin from Admin to Member?')).toBeDefined()
    expect(
      screen.getByText('They will lose admin permissions and keep member access.'),
    ).toBeDefined()
    expect(screen.getByText(/Admins can.*invit|Admins can.*team events/i)).toBeDefined()
    expect(screen.getByText(/Members can.*own|Members can.*personal/i)).toBeDefined()
    expect(memberRow('Team admin').getByText('Admin')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    await screen.findByText('Team admin is now Member.')
    expect(memberRow('Team admin').getByText('Member')).toBeDefined()
    expect(memberRow('Team admin').queryByText('Admin')).toBeNull()
    expect(api.to(ROLE_ROUTE)[0]?.body).toEqual({
      organizationId: TEAM_ID,
      memberId: admin.id,
      role: 'member',
    })
  })

  it.each([
    'admin',
    'member',
    null,
    '',
    'owner-assistant',
    'superowner',
    'owner,custom-role',
    'owner,',
    '__proto__',
  ])('offers no role changes to a caller with role %j', async (role) => {
    const api = teamServer()
    render(contents({ role }))
    await screen.findByText('Team member', { selector: 'li .user-content' })
    expect(screen.queryAllByRole('button', { name: /^Make (admin|member):/ })).toHaveLength(0)
    expect(api.to(ROLE_ROUTE)).toHaveLength(0)
  })

  it.each(['owner', 'member, owner', 'admin,owner', 'owner,admin,member'])(
    'protects another owner and the signed-in owner represented as %j',
    async (role) => {
      teamServer({}, [{ ...self, role }, { ...owner, role }, admin, ordinaryMember])
      render(contents())
      await screen.findByRole('button', { name: 'Make admin: Team member' })
      expect(memberRow('Current owner').queryByRole('button', { name: /^Make / })).toBeNull()
      expect(memberRow('Other owner').queryByRole('button', { name: /^Make / })).toBeNull()
      expect(screen.queryByRole('button', { name: /Make owner|Transfer ownership/i })).toBeNull()
    },
  )

  it.each(['custom-role', 'admin,custom-role', 'member,', 'owner-assistant', ''])(
    'fails closed for an unknown or incomplete target role %j',
    async (role) => {
      teamServer({}, [{ ...ordinaryMember, role }])
      render(contents())
      await screen.findByText('Team member', { selector: 'li .user-content' })
      expect(memberRow('Team member').queryByRole('button', { name: /^Make / })).toBeNull()
    },
  )

  it('supports exact known legacy owner tokens and demotes a combined admin role safely', async () => {
    teamServer({}, [self, { ...admin, role: 'member, admin' }, ordinaryMember])
    render(contents({ role: 'member, owner' }))
    expect(await screen.findByRole('button', { name: 'Make member: Team admin' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Make admin: Team member' })).toBeDefined()
  })

  it('states the owner-only launch limit, unavailable transfer and continuing owner requirement', async () => {
    teamServer()
    render(contents())
    await screen.findByRole('button', { name: 'Make admin: Team member' })
    expect(screen.getByText(/Only owners.*admins/i)).toBeDefined()
    expect(screen.getByText(/Ownership transfer is not available/i)).toBeDefined()
    expect(screen.getByText(/at least one owner/i)).toBeDefined()
  })

  it.each(['Escape', 'Cancel'])(
    'moves keyboard focus into confirmation and restores the opener after %s',
    async (method) => {
      const user = userEvent.setup()
      const api = teamServer()
      render(contents())
      const trigger = await screen.findByRole('button', { name: 'Make admin: Team member' })
      trigger.focus()
      await user.keyboard('{Enter}')
      const heading = await screen.findByRole('heading', { name: 'Change team role' })
      await waitFor(() => expect(document.activeElement).toBe(heading))
      if (method === 'Escape') await user.keyboard('{Escape}')
      else await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('heading', { name: 'Change team role' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(trigger))
      expect(memberRow('Team member').getByText('Member')).toBeDefined()
      expect(api.to(ROLE_ROUTE)).toHaveLength(0)
    },
  )

  it.each([
    {
      status: 403,
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: /permission|role|membership/i,
    },
    {
      status: 404,
      code: 'MEMBER_NOT_FOUND',
      message: /no longer.*member|no longer.*team|not found/i,
    },
    {
      status: 409,
      code: 'member_departure_owner_required',
      message: /at least one owner/i,
    },
    { status: 503, code: 'INTERNAL_SERVER_ERROR', message: /wrong.*our side|try again/i },
  ])(
    'shows a $status $code denial and keeps the original role',
    async ({ status, code, message }) => {
      const user = userEvent.setup()
      const api = teamServer({
        [ROLE_ROUTE]: () => json(status, { code, message: 'Untranslated server text' }),
      })
      render(contents())
      await openRole(user)
      await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
      expect((await screen.findByRole('alert')).textContent).toMatch(message)
      expect(screen.queryByText('Untranslated server text')).toBeNull()
      expect(memberRow('Team member').getByText('Member')).toBeDefined()
      expect(memberRow('Team member').queryByText('Admin')).toBeNull()
      noSuccess()
      expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    },
  )

  it('requires explicit reload for organization drift and never retries the stale write', async () => {
    const user = userEvent.setup()
    const reload = vi.fn()
    const api = teamServer({
      [ROLE_ROUTE]: () => json(409, { code: 'ORGANIZATION_CONTEXT_CHANGED' }),
    })
    render(contents({ onReload: reload }))
    await openRole(user)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/team context changed.*reload/i)
    expect(memberRow('Team member').getByText('Member')).toBeDefined()
    noSuccess()
    expect(reload).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Confirm role change' }).hasAttribute('disabled'),
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await openRole(user)
    expect((await screen.findByRole('alert')).textContent).toMatch(/team context changed.*reload/i)
    expect(
      screen.getByRole('button', { name: 'Confirm role change' }).hasAttribute('disabled'),
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Reload team' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
  })

  it('shows revoked owner authority with reload guidance after a server denial', async () => {
    const user = userEvent.setup()
    const reload = vi.fn()
    const api = teamServer({
      [ROLE_ROUTE]: () => json(403, { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }),
    })
    render(contents({ onReload: reload }))
    await openRole(user)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission|role|membership/i)
    expect(screen.getByRole('alert').textContent).toMatch(/reload/i)
    expect(
      screen.getByRole('button', { name: 'Confirm role change' }).hasAttribute('disabled'),
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Reload team' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    expect(memberRow('Team member').getByText('Member')).toBeDefined()
    noSuccess()
  })

  it.each([
    { label: 'malformed JSON', response: () => new Response('not JSON', { status: 200 }) },
    {
      label: 'another member',
      response: () => json(200, { ...admin, role: 'admin' }),
    },
    {
      label: 'the old role',
      response: () => json(200, ordinaryMember),
    },
  ])('requires reload when a successful status contains $label', async ({ response }) => {
    const user = userEvent.setup()
    const reload = vi.fn()
    const api = teamServer({ [ROLE_ROUTE]: response })
    render(contents({ onReload: reload }))
    await openRole(user)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not confirm.*reload/i)
    expect(memberRow('Team member').getByText('Member')).toBeDefined()
    expect(memberRow('Team member').queryByText('Admin')).toBeNull()
    noSuccess()
    expect(
      screen.getByRole('button', { name: 'Confirm role change' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reload team' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
  })

  it('keeps the old role and offers an accurate connection failure without claiming success', async () => {
    const user = userEvent.setup()
    const api = teamServer({
      [ROLE_ROUTE]: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    render(contents())
    await openRole(user)
    await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/can't reach Hourmere/i)
    expect(memberRow('Team member').getByText('Member')).toBeDefined()
    noSuccess()
    expect(api.to(ROLE_ROUTE)).toHaveLength(1)
  })

  it.each(['role', 'organization'] as const)(
    'discards an open confirmation when the current %s changes',
    async (changed) => {
      const user = userEvent.setup()
      const api = teamServer()
      const view = render(contents())
      await openRole(user)
      view.rerender(
        contents(changed === 'role' ? { role: 'admin' } : { organizationId: OTHER_TEAM_ID }),
      )
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Change team role' })).toBeNull(),
      )
      expect(api.to(ROLE_ROUTE)).toHaveLength(0)
      noSuccess()
    },
  )

  it.each(['role', 'organization'] as const)(
    'aborts and ignores a late confirmed response after the current %s changes',
    async (changed) => {
      const user = userEvent.setup()
      const response = later()
      const api = teamServer({
        [ROLE_ROUTE]: () => response.response,
        'GET /api/auth/organization/list-members': ({ path }) => {
          const organizationId = new URL(path, location.origin).searchParams.get('organizationId')
          return json(200, {
            members: [{ ...ordinaryMember, organizationId }],
            total: 1,
          })
        },
      })
      const fetch = globalThis.fetch
      let writeSignal: AbortSignal | null | undefined
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/organization/update-member-role')) writeSignal = init?.signal
        return fetch(input, init)
      })
      const view = render(contents())
      await openRole(user)
      await user.click(screen.getByRole('button', { name: 'Confirm role change' }))
      expect(writeSignal?.aborted).toBe(false)
      view.rerender(
        contents(changed === 'role' ? { role: 'admin' } : { organizationId: OTHER_TEAM_ID }),
      )
      await waitFor(() => expect(writeSignal?.aborted).toBe(true))
      await response.answer(json(200, { ...ordinaryMember, role: 'admin' }))
      expect(screen.queryByRole('heading', { name: 'Change team role' })).toBeNull()
      expect(memberRow('Team member').getByText('Member')).toBeDefined()
      expect(memberRow('Team member').queryByText('Admin')).toBeNull()
      noSuccess()
      expect(api.to(ROLE_ROUTE)).toHaveLength(1)
    },
  )

  it.each([
    { status: 403, code: 'TEAM_MANAGEMENT_ACCESS_DENIED', message: /权限.*成员关系/ },
    {
      status: 409,
      code: 'ORGANIZATION_CONTEXT_CHANGED',
      message: /团队上下文.*改变/,
    },
    { status: 404, code: 'MEMBER_NOT_FOUND', message: /不再是.*成员/ },
    { status: 409, code: 'member_departure_owner_required', message: /保留至少.*所有者/ },
  ])(
    'translates confirmation and the $code response into Simplified Chinese',
    async ({ status, code, message }) => {
      const user = userEvent.setup()
      teamServer({
        ...signedInAs({
          ...ME,
          organization: {
            id: TEAM_ID,
            name: 'Example team',
            slug: 'example-team',
            personal: false,
          },
        }),
        ...profile(PROFILE),
        'GET /api/auth/organization/get-active-member': () => json(200, self),
        [ROLE_ROUTE]: () => json(status, { code }),
      })
      renderApp(PATHS.settings)
      await screen.findByRole('button', { name: 'Make admin: Team member' })
      await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
      await user.click(await screen.findByRole('button', { name: /设为管理员.*Team member/ }))
      expect(screen.getByText(/Team member.*成员.*管理员/)).toBeDefined()
      expect(screen.getByText(/管理员.*邀请|管理员.*团队活动/)).toBeDefined()
      expect(screen.getByText(/成员.*自己|成员.*个人/)).toBeDefined()
      await user.click(screen.getByRole('button', { name: /确认.*角色/ }))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(message)
      expect(alert.textContent).not.toMatch(/permission|membership|role/i)
      expect(memberRow('Team member').getByText('成员')).toBeDefined()
      expect(screen.getByRole('button', { name: /重新加载团队/ })).toBeDefined()
    },
  )
})
