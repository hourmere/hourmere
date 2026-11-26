import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS } from '../paths.ts'
import {
  emptyTeamLists,
  fakeApi,
  type Handler,
  json,
  ME,
  PROFILE,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'

const UPDATE = 'POST /api/auth/organization/update'
const MEMBERSHIP = 'GET /api/auth/organization/get-active-member'
const TEAM = {
  id: '00000000-0000-7000-8000-000000000010',
  name: '团队 Café + 100%',
  slug: 'Research-Team',
  personal: false,
}
const MEMBER = {
  id: 'membership-1',
  organizationId: TEAM.id,
  userId: ME.user.id,
  role: 'owner',
  createdAt: '2026-10-27T10:00:00.000Z',
}
const LINK_WARNING =
  'Changing the public address changes this team’s public booking links. Links using the old address will no longer reach this team. Replace shared links and embeds after saving.'
const STALE_DETAILS =
  'Team details changed since you opened this page. Reload team details before saving again.'
const nameInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Team name' })
const addressInput = () =>
  screen.getByRole<HTMLInputElement>('textbox', { name: 'Team public address' })
const save = () => screen.getByRole('button', { name: 'Save team details' })

function settings(role: string, update?: Handler) {
  const state = { organization: TEAM }
  const api = fakeApi({
    ...signedInAs({ ...ME, organization: TEAM }),
    ...emptyTeamLists,
    ...profile(PROFILE),
    'GET /api/v1/me': () => json(200, { ...ME, organization: state.organization }),
    'GET /api/auth/organization/list': () => json(200, [ME.organization, state.organization]),
    [MEMBERSHIP]: () => json(200, { ...MEMBER, role }),
    ...(update && { [UPDATE]: update }),
  })
  renderApp(PATHS.settings)
  return { api, state }
}

async function editAddress(user: ReturnType<typeof userEvent.setup>, address: string) {
  const input = await screen.findByRole('textbox', { name: 'Team public address' })
  await user.clear(input)
  await user.type(input, address)
}

describe('editing team details in Settings', () => {
  it('allows an owner to rename a team without submitting its unchanged address', async () => {
    const user = userEvent.setup()
    const renamed = { ...TEAM, name: 'New team name' }
    const { api, state } = settings('owner', () => {
      state.organization = renamed
      return json(200, renamed)
    })
    const account = await screen.findByRole('region', { name: 'Account' })
    const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Team name' })
    expect(name.value).toBe(TEAM.name)
    expect(addressInput().value).toBe(TEAM.slug)
    await user.clear(name)
    await user.type(name, renamed.name)
    expect(screen.queryByText(LINK_WARNING)).toBeNull()
    await user.click(save())

    await within(account).findByText(renamed.name)
    const calls = api.to(UPDATE)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.body).toEqual({ organizationId: TEAM.id, data: { name: renamed.name } })
    expect(call?.headers.get('x-expected-organization-id')).toBe(TEAM.id)
    expect(call?.headers.get('x-expected-team-name')).toBe(encodeURIComponent(TEAM.name))
    expect(call?.headers.get('x-expected-team-slug')).toBe(encodeURIComponent(TEAM.slug))
    expect(addressInput().value).toBe(TEAM.slug)
  })

  it('shows the link impact before an admin saves a case-sensitive address change', async () => {
    const user = userEvent.setup()
    const updated = { ...TEAM, slug: 'research-team' }
    const { api, state } = settings('admin', () => {
      state.organization = updated
      return json(200, updated)
    })
    await editAddress(user, updated.slug)
    expect(screen.getByText(LINK_WARNING)).toBeDefined()
    expect(api.to(UPDATE)).toHaveLength(0)
    await user.click(save())
    await waitFor(() => expect(screen.queryByText(LINK_WARNING)).toBeNull())
    expect(api.to(UPDATE).map((call) => call.body)).toEqual([
      { organizationId: TEAM.id, data: { slug: updated.slug } },
    ])
    expect(addressInput().value).toBe(updated.slug)
  })

  it('puts a duplicate address error on the editable address field', async () => {
    const user = userEvent.setup()
    const { api } = settings('owner', () => json(400, { code: 'ORGANIZATION_SLUG_ALREADY_TAKEN' }))
    await editAddress(user, 'taken-address')
    await user.click(save())
    await waitFor(() => expect(addressInput().getAttribute('aria-invalid')).toBe('true'))
    const description = addressInput()
      .getAttribute('aria-describedby')
      ?.split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ')
    expect(description).toContain('This team address is already in use. Choose another one.')
    expect(addressInput().value).toBe('taken-address')
    expect(nameInput().value).toBe(TEAM.name)
    expect(api.to(UPDATE)).toHaveLength(1)
  })

  it('explains a stale submission and reloads the latest values only when requested', async () => {
    const user = userEvent.setup()
    const changedElsewhere = { ...TEAM, name: 'Name from another tab', slug: 'new-address' }
    const { api, state } = settings('owner', () => json(409, { code: 'TEAM_SETTINGS_CHANGED' }))
    await editAddress(user, 'my-draft-address')
    state.organization = changedElsewhere
    fireEvent(window, new Event('focus'))
    await within(screen.getByRole('region', { name: 'Account' })).findByText(changedElsewhere.name)
    expect(nameInput().value).toBe(TEAM.name)
    expect(addressInput().value).toBe('my-draft-address')
    await user.click(save())

    expect((await screen.findByText(STALE_DETAILS)).closest('[role="alert"]')).not.toBeNull()
    expect(addressInput().value).toBe('my-draft-address')
    const calls = api.to(UPDATE)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.get('x-expected-team-name')).toBe(encodeURIComponent(TEAM.name))
    expect(calls[0]?.headers.get('x-expected-team-slug')).toBe(encodeURIComponent(TEAM.slug))

    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const reload = screen.getByRole('button', { name: 'Reload team details' })
    await user.click(reload)
    expect(confirmation).toHaveBeenCalledOnce()
    expect(addressInput().value).toBe('my-draft-address')
    confirmation.mockReturnValue(true)
    await user.click(reload)
    await waitFor(() => expect(nameInput().value).toBe(changedElsewhere.name))
    expect(addressInput().value).toBe(changedElsewhere.slug)
    expect(screen.queryByText(STALE_DETAILS)).toBeNull()
    expect(api.to(UPDATE)).toHaveLength(1)
  })

  it('uses the existing context recovery when the active space changed', async () => {
    const user = userEvent.setup()
    const { api } = settings('owner', () => json(409, { code: 'ORGANIZATION_CONTEXT_CHANGED' }))
    await editAddress(user, 'new-address')
    await user.click(save())

    await screen.findByText('Your team context changed. Reload before making changes.')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
    expect(addressInput().value).toBe('new-address')
    expect(api.to(UPDATE)).toHaveLength(1)
  })

  it.each([
    ['member', 'Member'],
    ['owner,unknown', 'Owner, unknown'],
  ])('does not offer team details editing to role %s', async (role, label) => {
    const { api } = settings(role)
    const account = await screen.findByRole('region', { name: 'Account' })
    await within(account).findByText(label)
    expect(screen.queryByRole('button', { name: 'Save team details' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Team public address' })).toBeNull()
    expect(api.to(UPDATE)).toHaveLength(0)
  })

  it('reuses reserved address validation and explains link changes in Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    const { api } = settings('owner')
    const address = await screen.findByRole('textbox', { name: '团队公开地址' })
    expect(screen.getByRole('textbox', { name: '团队名称' })).toBeDefined()
    await user.clear(address)
    await user.type(address, 'new-address')
    expect(
      screen.getByText(
        '更改公开地址会改变此团队的公开预约链接。使用旧地址的链接将不再指向此团队。保存后请更新已分享的链接和嵌入内容。',
      ),
    ).toBeDefined()
    expect(screen.queryByText(LINK_WARNING)).toBeNull()
    await user.clear(address)
    await user.type(address, 'Admin')
    await user.click(screen.getByRole('button', { name: '保存团队资料' }))
    await waitFor(() => expect(address.getAttribute('aria-invalid')).toBe('true'))
    expect(api.to(UPDATE)).toHaveLength(0)
  })
})
