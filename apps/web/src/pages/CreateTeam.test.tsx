import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import type { CreatedOrganization } from '../api/auth.ts'
import type { Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
} from '../test/fake-api.tsx'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../unsaved-changes.tsx'

const team: CreatedOrganization = {
  id: '00000000-0000-7000-8000-000000000010',
  name: 'Research team',
  slug: 'Research-Team',
  logo: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  members: [
    {
      id: '00000000-0000-7000-8000-000000000011',
      organizationId: '00000000-0000-7000-8000-000000000010',
      userId: ME.user.id,
      role: 'owner',
      createdAt: '2026-10-01T09:00:00.000Z',
    },
  ],
}
const teamMe: Schemas['Me'] = {
  ...ME,
  organization: {
    id: team.id,
    name: team.name,
    slug: team.slug,
    personal: false,
  },
}
const nameInput = () => document.getElementById('teamName') as HTMLInputElement
const slugInput = () => document.getElementById('teamSlug') as HTMLInputElement
const submit = () => screen.getByRole('button', { name: /^(Create team|创建团队)$/ })
const createButton = () => screen.queryByRole('button', { name: /^(Create team|创建团队)$/ })
const checkStatus = () => screen.getByRole('button', { name: /^(Check team status|检查团队状态)$/ })
const leaving = () => {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function server(overrides: Routes = {}, role = 'owner') {
  const state = { me: ME }
  const api = fakeApi({
    ...profile(PROFILE),
    'GET /api/v1/me': () => json(200, state.me),
    'GET /api/auth/organization/list': () => json(200, [ME.organization, team]),
    'POST /api/auth/organization/create': () => json(200, team),
    'POST /api/auth/organization/set-active': () => {
      state.me = teamMe
      return json(200, team)
    },
    'GET /api/auth/organization/get-active-member': () => json(200, { ...team.members[0], role }),
    'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    ...overrides,
  })
  return { api, state }
}

async function fill(name = team.name, slug = team.slug) {
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: /^(Create team|创建团队)$/, level: 1 })
  await user.type(nameInput(), name)
  await user.type(slugInput(), slug)
  return user
}

function RecoveryLocation() {
  const location = useLocation()
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="location-state">{JSON.stringify(location.state ?? null)}</output>
    </>
  )
}

function renderRecovery(state: unknown = null) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/app/teams/new', state }]}>
      <App />
      <RecoveryLocation />
    </MemoryRouter>,
  )
}

describe('creating a team', () => {
  it.each(['en', 'zh-CN'] as const)(
    'creates once by keyboard, activates by ID and displays the confirmed name and role in %s',
    async (locale) => {
      chooseLanguage(locale)
      const { api } = server()
      renderApp('/app/teams/new')
      const preview = await screen.findByText((content) =>
        content.startsWith(`${window.location.origin}/team/`),
      )
      expect(preview.textContent).toBe(`${window.location.origin}/team/your-team/event-link`)
      const user = await fill(`  ${team.name}  `)
      expect(nameInput().labels?.[0]?.textContent).toBe(locale === 'en' ? 'Team name' : '团队名称')
      expect(slugInput().labels?.[0]?.textContent).toBe(
        locale === 'en' ? 'Team public address' : '团队公开地址',
      )
      expect(preview.textContent).toBe(`${window.location.origin}/team/${team.slug}/event-link`)
      await user.keyboard('{Enter}')
      await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
      expect(api.to('POST /api/auth/organization/create').map((call) => call.body)).toEqual([
        { name: team.name, slug: team.slug, keepCurrentActiveOrganization: true },
      ])
      expect(api.to('POST /api/auth/organization/set-active').map((call) => call.body)).toEqual([
        { organizationId: team.id },
      ])
      expect(
        api
          .to('POST /api/auth/organization/set-active')[0]
          ?.headers.get('X-Expected-Organization-Id'),
      ).toBe(ME.organization.id)
      const account = await screen.findByRole('region', {
        name: locale === 'en' ? 'Account' : '账号',
      })
      expect(account.textContent).toContain(team.name)
      expect(await screen.findByText(locale === 'en' ? 'Owner' : '所有者')).toBeDefined()
      expect(leaving()).toBe(false)
    },
  )

  it('previews the exact-case team namespace as text without making a personal booking link', async () => {
    server()
    renderApp('/app/teams/new')
    await fill()
    const preview = screen.getByText((content) =>
      content.startsWith(`${window.location.origin}/team/${team.slug}/`),
    )
    expect(preview.closest('a')).toBeNull()
    expect(document.querySelector(`a[href^="/${team.slug}/"]`)).toBeNull()
    expect(preview.textContent).not.toContain('/ada/')
  })

  it('shows the confirmed current role rather than inferring ownership from creation', async () => {
    server({}, 'member')
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(await screen.findByText('Member')).toBeDefined()
    expect(screen.queryByText('Owner')).toBeNull()
  })

  it.each(['', '-bad', 'bad-', 'two words', 'a/b', '你好', 'a'.repeat(65), 'Admin'])(
    'rejects invalid or reserved address %j before posting and focuses it',
    async (slug) => {
      const { api } = server()
      renderApp('/app/teams/new')
      await fill(team.name, 'valid')
      fireEvent.change(slugInput(), { target: { value: slug } })
      fireEvent.submit(screen.getByRole('form', { name: 'Create team' }))
      await screen.findByRole('alert')
      await waitFor(() => expect(document.activeElement).toBe(slugInput()))
      expect(slugInput().getAttribute('aria-invalid')).toBe('true')
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(0)
    },
  )

  it.each(['', '   ', 'a'.repeat(201), 'first\u2028second', 'a\u0000b', 'a\ud800b'])(
    'rejects invalid team name %j before posting',
    async (name) => {
      const { api } = server()
      renderApp('/app/teams/new')
      await fill('valid')
      fireEvent.change(nameInput(), { target: { value: name } })
      fireEvent.submit(screen.getByRole('form', { name: 'Create team' }))
      await screen.findByRole('alert')
      expect(nameInput().getAttribute('aria-invalid')).toBe('true')
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(0)
    },
  )

  it.each(['ORGANIZATION_ALREADY_EXISTS', 'ORGANIZATION_SLUG_RESERVED'])(
    'puts the server address error %s on the address field and focuses it',
    async (code) => {
      const { api } = server({
        'POST /api/auth/organization/create': () => json(400, { code }),
      })
      renderApp('/app/teams/new')
      const user = await fill()
      await user.click(submit())
      const alert = await screen.findByRole('alert')
      expect(within(alert).getByRole('link').getAttribute('href')).toBe('#teamSlug')
      await waitFor(() => expect(document.activeElement).toBe(slugInput()))
      expect(slugInput().value).toBe(team.slug)
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
      expect(leaving()).toBe(true)
    },
  )

  it('locks both drafts through create and confirmation and rejects a double submit', async () => {
    const pending = later()
    const { api } = server({ 'POST /api/auth/organization/create': () => pending.response })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    expect(nameInput().matches(':disabled')).toBe(true)
    expect(slugInput().matches(':disabled')).toBe(true)
    fireEvent.submit(screen.getByRole('form', { name: 'Create team' }))
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    expect(leaving()).toBe(true)
    await pending.answer(json(200, team))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
  })

  it('protects unsaved drafts across app navigation and browser unload', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    server()
    renderApp('/app/teams/new')
    await screen.findByRole('heading', { name: 'Create team', level: 1 })
    expect(leaving()).toBe(false)
    const user = await fill()
    expect(leaving()).toBe(true)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
    expect(nameInput().value).toBe(team.name)
  })

  it('does not switch context or navigate when a create response arrives after leaving', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    const { api } = server({ 'POST /api/auth/organization/create': () => pending.response })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    await pending.answer(json(200, team))
    expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
  })

  it.each([
    ['en', 'organization'],
    ['zh-CN', 'organization'],
    ['en', 'user'],
  ] as const)(
    'keeps the created team recoverable in %s when another tab changed the %s',
    async (locale, mismatch) => {
      chooseLanguage(locale)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const pending = later()
      const otherMe =
        mismatch === 'user'
          ? {
              ...ME,
              user: { ...ME.user, id: '00000000-0000-7000-8000-000000000098' },
            }
          : {
              ...ME,
              organization: {
                ...teamMe.organization,
                id: '00000000-0000-7000-8000-000000000099',
                name: 'Other team',
              },
            }
      const { api, state } = server({
        'POST /api/auth/organization/create': () => pending.response,
      })
      renderApp('/app/teams/new')
      const user = await fill()
      await user.click(submit())
      state.me = otherMe
      await pending.answer(json(200, team))
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
      const reload = await screen.findByRole('button', {
        name: locale === 'en' ? 'Reload' : '重新加载',
      })
      expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
      expect(nameInput().value).toBe(team.name)
      expect(slugInput().value).toBe(team.slug)
      const open = screen.getByRole('button', { name: locale === 'en' ? 'Open team' : '打开团队' })
      expect(open.matches(':disabled')).toBe(true)
      fireEvent.click(open)
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
      await user.click(reload)
      expect(confirm).toHaveBeenCalled()
      expect(nameInput().value).toBe(team.name)
      confirm.mockReturnValue(true)
      await user.click(reload)
      await waitFor(() => expect(nameInput().value).toBe(''))
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    },
  )

  it('discards a late creation after an accepted multi-tab switch', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    const { api, state } = server({
      'POST /api/auth/organization/create': () => pending.response,
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    state.me = teamMe
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(nameInput().value).toBe(''))
    await pending.answer(json(200, team))
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    expect(nameInput().value).toBe('')
    expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
  })
})

describe('reconciling an uncertain creation result', () => {
  it.each(['none', 'session', 'list'] as const)(
    'releases a pinned address after a retry collision and a successful check with %s read failure',
    async (failure) => {
      let attempts = 0
      let unavailable = failure !== 'none'
      const { api, state } = server({
        'POST /api/auth/organization/create': () => {
          attempts++
          if (attempts === 1) throw new TypeError('Synthetic lost response')
          return attempts === 2
            ? json(400, { code: 'ORGANIZATION_ALREADY_EXISTS' })
            : json(200, team)
        },
        'GET /api/v1/me': () =>
          attempts === 2 && unavailable && failure === 'session'
            ? json(503, { error: 'internal_error' })
            : json(200, state.me),
        'GET /api/auth/organization/list': () =>
          attempts === 2 && unavailable && failure === 'list'
            ? json(503, { code: 'INTERNAL_SERVER_ERROR' })
            : json(200, [ME.organization]),
      })
      renderApp('/app/teams/new')
      const user = await fill(team.name, 'Taken-Team')
      await user.click(submit())
      await screen.findByText('No team was found at this address. You can try creating it again.')
      expect(slugInput().matches(':disabled')).toBe(true)
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
      await user.click(submit())
      if (failure !== 'none') {
        await screen.findByText(
          'Could not check your teams. Check team status before trying again.',
        )
        expect(slugInput().matches(':disabled')).toBe(true)
        expect(createButton()).toBeNull()
        fireEvent.submit(screen.getByRole('form', { name: 'Create team' }))
        expect(api.to('POST /api/auth/organization/create')).toHaveLength(2)
        unavailable = false
        await user.click(checkStatus())
      }
      await waitFor(() => expect(slugInput().getAttribute('aria-invalid')).toBe('true'))
      const alert = screen.getByRole('alert')
      expect(within(alert).getByRole('link').getAttribute('href')).toBe('#teamSlug')
      expect(alert.textContent).toContain(
        'This team address is already in use. Choose another one.',
      )
      await waitFor(() => expect(document.activeElement).toBe(slugInput()))
      expect(slugInput().matches(':disabled')).toBe(false)
      expect(slugInput().value).toBe('Taken-Team')
      expect(nameInput().value).toBe(team.name)
      expect(leaving()).toBe(true)
      expect(screen.queryByRole('button', { name: 'Open team' })).toBeNull()
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(2)
      await user.clear(slugInput())
      await user.type(slugInput(), team.slug)
      await user.click(submit())
      await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
      expect(api.to('POST /api/auth/organization/create').map((call) => call.body)).toEqual([
        { name: team.name, slug: 'Taken-Team', keepCurrentActiveOrganization: true },
        { name: team.name, slug: 'Taken-Team', keepCurrentActiveOrganization: true },
        { name: team.name, slug: team.slug, keepCurrentActiveOrganization: true },
      ])
    },
  )

  it('treats the current personal organization as an address conflict and allows a corrected team address', async () => {
    let attempts = 0
    const { api } = server({
      'POST /api/auth/organization/create': () =>
        ++attempts === 1 ? json(500, { code: 'INTERNAL_SERVER_ERROR' }) : json(200, team),
    })
    renderApp('/app/teams/new')
    const user = await fill(team.name, ME.organization.slug)
    await user.click(submit())
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(slugInput().getAttribute('aria-invalid')).toBe('true'))
    expect(within(alert).getByRole('link').textContent).toContain(
      'This team address is already in use. Choose another one.',
    )
    await waitFor(() => expect(document.activeElement).toBe(slugInput()))
    expect(slugInput().matches(':disabled')).toBe(false)
    expect(nameInput().value).toBe(team.name)
    expect(screen.queryByRole('button', { name: 'Open team' })).toBeNull()
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    await user.clear(slugInput())
    await user.type(slugInput(), team.slug)
    await user.click(submit())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(api.to('POST /api/auth/organization/create').map((call) => call.body)).toEqual([
      { name: team.name, slug: ME.organization.slug, keepCurrentActiveOrganization: true },
      { name: team.name, slug: team.slug, keepCurrentActiveOrganization: true },
    ])
    expect(await screen.findByText('Owner')).toBeDefined()
  })

  it('restores an editable address conflict when opening a recovered organization confirms it is personal', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { api, state } = server({
      'POST /api/auth/organization/create': () => json(500, { code: 'INTERNAL_SERVER_ERROR' }),
      'POST /api/auth/organization/set-active': () => {
        state.me = ME
        return json(200, ME.organization)
      },
    })
    state.me = teamMe
    renderRecovery()
    const user = await fill(team.name, ME.organization.slug)
    await user.click(submit())
    await user.click(await screen.findByRole('button', { name: 'Open team' }))
    await waitFor(() => expect(slugInput().getAttribute('aria-invalid')).toBe('true'))
    await waitFor(() => expect(document.activeElement).toBe(slugInput()))
    expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
    // The restored form can receive focus before the router commits consuming its state.
    await waitFor(() => expect(screen.getByTestId('location-state').textContent).toBe('null'))
    expect(nameInput().value).toBe(team.name)
    expect(slugInput().value).toBe(ME.organization.slug)
    expect(slugInput().matches(':disabled')).toBe(false)
    expect(nameInput().matches(':disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Open team' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(
      'This team address is already in use. Choose another one.',
    )
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    expect(api.to('POST /api/auth/organization/set-active').map((call) => call.body)).toEqual([
      { organizationId: ME.organization.id },
    ])
    await user.clear(slugInput())
    await user.type(slugInput(), 'Corrected-Team')
    expect(slugInput().value).toBe('Corrected-Team')
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(account.textContent).toContain(ME.organization.name)
    expect(account.textContent).toContain('(personal)')
    expect(account.textContent).not.toContain(team.name)
    await user.click(screen.getByRole('link', { name: 'Create team' }))
    await screen.findByRole('heading', { name: 'Create team', level: 1 })
    expect(nameInput().value).toBe('')
    expect(slugInput().value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
  })

  it.each([
    {},
    { teamAddressConflict: null },
    { teamAddressConflict: 'invalid' },
    {
      teamAddressConflict: {
        name: 123,
        slug: 'ada',
        userId: ME.user.id,
        organizationId: ME.organization.id,
      },
    },
    {
      teamAddressConflict: {
        name: team.name,
        slug: ['ada'],
        userId: ME.user.id,
        organizationId: ME.organization.id,
      },
    },
    {
      teamAddressConflict: {
        name: team.name,
        slug: 'ada',
        userId: 'foreign-user',
        organizationId: ME.organization.id,
      },
    },
    {
      teamAddressConflict: {
        name: team.name,
        slug: 'ada',
        userId: ME.user.id,
        organizationId: 'foreign-organization',
      },
    },
  ])('ignores malformed address-conflict route state (%#)', async (state) => {
    server()
    renderRecovery(state)
    await screen.findByRole('heading', { name: 'Create team', level: 1 })
    expect(nameInput().value).toBe('')
    expect(slugInput().value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(slugInput().matches(':disabled')).toBe(false)
  })

  it('ignores a personal-address conflict marker in a confirmed team context', async () => {
    const { state } = server()
    state.me = teamMe
    renderRecovery({
      teamAddressConflict: {
        name: team.name,
        slug: team.slug,
        userId: ME.user.id,
        organizationId: team.id,
      },
    })
    await screen.findByRole('heading', { name: 'Create team', level: 1 })
    expect(nameInput().value).toBe('')
    expect(slugInput().value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(slugInput().matches(':disabled')).toBe(false)
  })

  it('recovers an already committed team from a refreshed list without a second create', async () => {
    const { api } = server({
      'POST /api/auth/organization/create': () => {
        throw new TypeError('Synthetic lost response')
      },
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await waitFor(() => expect(api.to('GET /api/auth/organization/list')).toHaveLength(1))
    expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
    expect(createButton()).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'Open team' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(api.to('GET /api/v1/me').length).toBeGreaterThan(1)
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    expect(await screen.findByText('Owner')).toBeDefined()
  })

  it('permits only an explicit retry after refreshed session and list prove no matching team', async () => {
    let attempts = 0
    const { api } = server({
      'POST /api/auth/organization/create': () =>
        ++attempts === 1 ? json(500, { code: 'INTERNAL_SERVER_ERROR' }) : json(200, team),
      'GET /api/auth/organization/list': () => json(200, [ME.organization]),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await waitFor(() => expect(api.to('GET /api/auth/organization/list')).toHaveLength(1))
    await waitFor(() => expect(submit().matches(':disabled')).toBe(false))
    expect(api.to('GET /api/v1/me').length).toBeGreaterThan(1)
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    expect(nameInput().value).toBe(team.name)
    expect(leaving()).toBe(true)
    await user.click(submit())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(2)
  })

  it.each(['session', 'list'] as const)(
    'blocks another POST while the %s reconciliation read is unavailable, then checks safely',
    async (failure) => {
      let reads = 0
      let offline = true
      const { api } = server({
        'GET /api/v1/me': () =>
          ++reads > 1 && failure === 'session' && offline
            ? json(503, { error: 'internal_error' })
            : json(200, ME),
        'POST /api/auth/organization/create': () => json(500, { code: 'INTERNAL_SERVER_ERROR' }),
        'GET /api/auth/organization/list': () =>
          failure === 'list' && offline
            ? json(503, { code: 'INTERNAL_SERVER_ERROR' })
            : json(200, [ME.organization]),
      })
      renderApp('/app/teams/new')
      const user = await fill()
      await user.click(submit())
      await screen.findByRole('button', { name: 'Check team status' })
      expect(createButton()).toBeNull()
      expect(nameInput().matches(':disabled')).toBe(true)
      expect(slugInput().matches(':disabled')).toBe(true)
      fireEvent.submit(screen.getByRole('form', { name: 'Create team' }))
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
      offline = false
      await user.click(checkStatus())
      await waitFor(() => expect(submit().matches(':disabled')).toBe(false))
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    },
  )

  it('reconciles a failed post-create /me confirmation instead of posting again', async () => {
    let reads = 0
    const { api, state } = server({
      'GET /api/v1/me': () =>
        ++reads === 2 ? json(503, { error: 'internal_error' }) : json(200, state.me),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await waitFor(() => expect(api.to('GET /api/auth/organization/list')).toHaveLength(1))
    await user.click(await screen.findByRole('button', { name: 'Open team' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
  })

  it('uses exact-case addresses when deciding whether a team already exists', async () => {
    const { api } = server({
      'POST /api/auth/organization/create': () => json(500, { code: 'INTERNAL_SERVER_ERROR' }),
      'GET /api/auth/organization/list': () =>
        json(200, [{ ...team, slug: team.slug.toLowerCase() }]),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await screen.findByText('No team was found at this address. You can try creating it again.')
    expect(submit().matches(':disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Open team' })).toBeNull()
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
  })

  it('pins the address across a stale empty list and collision instead of creating a different team', async () => {
    let attempts = 0
    let lists = 0
    const { api } = server({
      'POST /api/auth/organization/create': () =>
        ++attempts === 1
          ? json(500, { code: 'INTERNAL_SERVER_ERROR' })
          : json(400, { code: 'ORGANIZATION_ALREADY_EXISTS' }),
      'GET /api/auth/organization/list': () =>
        json(200, ++lists === 1 ? [ME.organization] : [ME.organization, team]),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await screen.findByText('No team was found at this address. You can try creating it again.')
    expect(nameInput().matches(':disabled')).toBe(false)
    expect(slugInput().matches(':disabled')).toBe(true)
    await user.clear(nameInput())
    await user.type(nameInput(), 'Revised name')
    // A stale scripted change must not bypass the pinned identity used by the request.
    fireEvent.change(slugInput(), { target: { value: 'Different-Team' } })
    await user.click(submit())
    const open = await screen.findByRole('button', { name: 'Open team' })
    await waitFor(() => expect(open.matches(':disabled')).toBe(false))
    expect(api.to('POST /api/auth/organization/create').map((call) => call.body)).toEqual([
      { name: team.name, slug: team.slug, keepCurrentActiveOrganization: true },
      { name: 'Revised name', slug: team.slug, keepCurrentActiveOrganization: true },
    ])
    expect(api.to('GET /api/auth/organization/list')).toHaveLength(2)
    expect(createButton()).toBeNull()
    expect(screen.getByText(team.name)).toBeDefined()
    await user.click(open)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(2)
  })

  it.each(['activation', 'confirmation'] as const)(
    'retries opening only after %s fails for a team already created',
    async (failure) => {
      let switches = 0
      let reads = 0
      const { api, state } = server({
        'POST /api/auth/organization/set-active': () => {
          switches++
          if (failure === 'activation' && switches === 1)
            return json(503, { code: 'INTERNAL_SERVER_ERROR' })
          state.me = teamMe
          return json(200, team)
        },
        'GET /api/v1/me': () =>
          ++reads === 3 && failure === 'confirmation'
            ? json(503, { error: 'internal_error' })
            : json(200, state.me),
      })
      renderApp('/app/teams/new')
      const user = await fill()
      await user.click(submit())
      const open = await screen.findByRole('button', { name: 'Open team' })
      await waitFor(() => expect(open.matches(':disabled')).toBe(false))
      expect(createButton()).toBeNull()
      expect(nameInput().matches(':disabled')).toBe(true)
      expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
      expect(screen.getByText(team.name)).toBeDefined()
      expect(screen.getByText('Owner')).toBeDefined()
      await user.click(open)
      await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/settings'))
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(
        failure === 'confirmation' ? 1 : 2,
      )
    },
  )

  it('does not leave the chosen page when a delayed activation completes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    const { api } = server({
      'POST /api/auth/organization/set-active': () => pending.response,
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await waitFor(() => expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1))
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    await pending.answer(json(200, team))
    expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
    expect(api.to('GET /api/v1/me')).toHaveLength(2)
  })

  it('refuses a retry activation after another tab switched to a different team', async () => {
    const { api, state } = server({
      'POST /api/auth/organization/set-active': () => json(503, { code: 'INTERNAL_SERVER_ERROR' }),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    const open = await screen.findByRole('button', { name: 'Open team' })
    await waitFor(() => expect(open.matches(':disabled')).toBe(false))
    state.me = {
      ...teamMe,
      organization: { ...teamMe.organization, id: '00000000-0000-7000-8000-000000000099' },
    }
    await user.click(open)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    await screen.findByRole('button', { name: 'Reload' })
    expect(open.matches(':disabled')).toBe(true)
    expect(nameInput().value).toBe(team.name)
    expect(slugInput().value).toBe(team.slug)
  })

  it('keeps the created team when activation refuses a switch conflict', async () => {
    const { api } = server({
      'POST /api/auth/organization/set-active': () =>
        json(409, { code: 'ORGANIZATION_CONTEXT_CHANGED' }),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await screen.findByRole('button', { name: 'Reload' })
    expect(nameInput().value).toBe(team.name)
    expect(slugInput().value).toBe(team.slug)
    expect(screen.getByRole('button', { name: 'Open team' }).matches(':disabled')).toBe(true)
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
  })

  it.each(['organization', 'user'] as const)(
    'keeps creation blocked when the activation confirmation identifies another %s',
    async (mismatch) => {
      let reads = 0
      const { api } = server({
        'GET /api/v1/me': () => {
          if (++reads < 3) return json(200, ME)
          return json(
            200,
            mismatch === 'organization'
              ? ME
              : { ...teamMe, user: { ...ME.user, id: 'another-user' } },
          )
        },
      })
      renderApp('/app/teams/new')
      const user = await fill()
      await user.click(submit())
      const open = await screen.findByRole('button', { name: 'Open team' })
      await screen.findByRole('button', { name: 'Reload' })
      expect(open.matches(':disabled')).toBe(true)
      expect(createButton()).toBeNull()
      expect(screen.getByTestId('location').textContent).toBe('/app/teams/new')
      expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    },
  )

  it.each(['organizationId', 'userId'] as const)(
    'does not show the role of a returned member with a foreign %s',
    async (field) => {
      server({
        'POST /api/auth/organization/create': () =>
          json(200, {
            ...team,
            members: [{ ...team.members[0], [field]: 'foreign-identity' }],
          }),
        'POST /api/auth/organization/set-active': () =>
          json(503, { code: 'INTERNAL_SERVER_ERROR' }),
      })
      renderApp('/app/teams/new')
      const user = await fill()
      await user.click(submit())
      const open = await screen.findByRole('button', { name: 'Open team' })
      await waitFor(() => expect(open.matches(':disabled')).toBe(false))
      expect(screen.getByText(team.name)).toBeDefined()
      expect(screen.queryByText('Owner')).toBeNull()
      expect(createButton()).toBeNull()
    },
  )

  it('ignores a late activation confirmation after the person leaves', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    let reads = 0
    const { api } = server({
      'GET /api/v1/me': () => (++reads === 3 ? pending.response : json(200, ME)),
    })
    renderApp('/app/teams/new')
    const user = await fill()
    await user.click(submit())
    await waitFor(() => expect(reads).toBe(3))
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    await pending.answer(json(200, teamMe))
    expect(screen.getByTestId('location').textContent).toBe('/app/bookings')
    expect(api.to('POST /api/auth/organization/create')).toHaveLength(1)
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(account.textContent).toContain(ME.organization.name)
    expect(account.textContent).not.toContain(team.name)
  })
})
