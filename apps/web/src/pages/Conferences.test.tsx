import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { fakeApi, json, later, renderApp, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
const account: Schemas['ConferenceConnection'] = {
  id: 'a0000000-0000-7000-8000-000000000001',
  provider: 'zoom',
  mode: 'identity',
  accountEmail: 'zoom@example.com',
  displayName: 'Settings',
  status: 'active',
  lastError: null,
  createdAt: '2026-10-17T10:00:00Z',
  updatedAt: '2026-10-17T10:00:00Z',
}
const list = (data = [account], zoomEnabled = true) => ({
  data: data.filter((connection) => connection.status !== 'disconnected'),
  zoomEnabled,
  zoomMeetingsEnabled: false,
  pendingAttempts: 0,
  maximumConnections: 5,
})
const authUrl = 'https://zoom.us/oauth/authorize?state=synthetic-state'
describe('separate conference accounts page', () => {
  it('keeps identity literal in both languages, preserves the mounted UI and consumes only known callback outcomes', async () => {
    const user = userEvent.setup()
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () => json(200, list()),
    })
    renderApp('/app/conferences?zoom=connected')
    const heading = await screen.findByRole('heading', { name: 'Settings', level: 2 })
    expect(screen.getByText('Zoom account connected.').getAttribute('role')).toBe('status')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(await screen.findByRole('heading', { name: '会议账号', level: 1 })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Settings', level: 2 })).toBe(heading)
    expect(screen.getByText('Zoom 账号已连接。').getAttribute('role')).toBe('status')
    expect(screen.getByText('zoom@example.com')).toBeDefined()
    expect(requests.to('GET /api/v1/conference-connections')).toHaveLength(1)
    expect(requests.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
  })
  it('shows disabled, pending and capacity states truthfully without provider actions', async () => {
    const user = userEvent.setup()
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () =>
        json(200, { ...list([], false), pendingAttempts: 1 }),
    })
    renderApp('/app/conferences?zoom=synthetic-private-provider-message')
    const button = await screen.findByRole('button', { name: 'Connect Zoom' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/authorization attempt is pending/)).toBeDefined()
    expect(screen.queryByText('synthetic-private-provider-message')).toBeNull()
    await user.click(button)
    expect(requests.to('POST /api/v1/conference-connections/zoom/authorize')).toHaveLength(0)
  })
  it('authorizes independently with an empty body and reconnects the expected ID', async () => {
    const user = userEvent.setup(),
      requests = fakeApi({
        ...signedIn,
        'GET /api/v1/conference-connections': () => json(200, list()),
        'POST /api/v1/conference-connections/zoom/authorize': () =>
          json(200, { authorizationUrl: authUrl }),
        [`POST /api/v1/conference-connections/${account.id}/reconnect`]: () =>
          json(200, { authorizationUrl: authUrl }),
      })
    renderApp('/app/conferences')
    await user.click(await screen.findByRole('button', { name: 'Connect Zoom' }))
    expect(goTo).toHaveBeenCalledWith(authUrl)
    await user.click(screen.getByRole('button', { name: 'Reconnect Zoom' }))
    expect(requests.to('POST /api/v1/conference-connections/zoom/authorize')[0]?.body).toEqual({})
    expect(
      requests.to(`POST /api/v1/conference-connections/${account.id}/reconnect`)[0]?.body,
    ).toEqual({})
  })
  it.each([
    'https://untrusted.invalid/oauth/authorize',
    'https://zoom.us/not-authorize',
    'https://user:secret@zoom.us/oauth/authorize',
    'https://zoom.us/oauth/authorize#fragment',
  ])('refuses unexpected authorization endpoint %s', async (authorizationUrl) => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () => json(200, list([])),
      'POST /api/v1/conference-connections/zoom/authorize': () => json(200, { authorizationUrl }),
    })
    renderApp('/app/conferences')
    await user.click(await screen.findByRole('button', { name: 'Connect Zoom' }))
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach Hourmere")
    expect(goTo).not.toHaveBeenCalled()
  })
  it('offers meeting access as a distinct explicit choice and upgrades only the selected identity', async () => {
    const user = userEvent.setup(),
      requests = fakeApi({
        ...signedIn,
        'GET /api/v1/conference-connections': () =>
          json(200, { ...list(), zoomMeetingsEnabled: true }),
        'POST /api/v1/conference-connections/zoom/authorize-meetings': () =>
          json(200, { authorizationUrl: authUrl }),
        [`POST /api/v1/conference-connections/${account.id}/authorize-meetings`]: () =>
          json(200, { authorizationUrl: authUrl }),
      })
    renderApp('/app/conferences?zoom=mode_conflict')
    const heading = await screen.findByRole('heading', { name: 'Settings', level: 2 })
    expect(
      screen
        .getByText(
          'Identity-only authorization cannot replace meeting permissions. Reconnect this Zoom account with its existing meeting permissions.',
        )
        .getAttribute('role'),
    ).toBe('status')
    const article = heading.closest('article') as HTMLElement
    await user.click(within(article).getByRole('button', { name: 'Authorize Zoom meetings' }))
    expect(
      requests.to(`POST /api/v1/conference-connections/${account.id}/authorize-meetings`)[0]?.body,
    ).toEqual({})
    expect(requests.to('POST /api/v1/conference-connections/zoom/authorize')).toHaveLength(0)
    await user.click(
      screen.getAllByRole('button', { name: 'Authorize Zoom meetings' })[0] as HTMLElement,
    )
    expect(
      requests.to('POST /api/v1/conference-connections/zoom/authorize-meetings')[0]?.body,
    ).toEqual({})
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(screen.getByRole('heading', { name: 'Settings', level: 2 })).toBe(heading)
    expect(screen.getByText('仅身份访问')).toBeDefined()
    expect(screen.getAllByRole('button', { name: '授权 Zoom 会议' })).toHaveLength(2)
  })
  it('shows saved stronger mode even when new authorization is disabled, without an automatic grant', async () => {
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () =>
        json(200, list([{ ...account, mode: 'meetings' }])),
    })
    renderApp('/app/conferences')
    expect(await screen.findByText('Meeting permissions')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Authorize Zoom meetings' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reconnect Zoom' }).hasAttribute('disabled')).toBe(
      false,
    )
    expect(requests.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
  it('does not navigate after leaving while authorization is pending', async () => {
    const user = userEvent.setup(),
      response = later()
    fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () => json(200, list([])),
      'POST /api/v1/conference-connections/zoom/authorize': () => response.response,
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data: [],
          googleEnabled: false,
          microsoftEnabled: false,
          destinationCalendarId: null,
        }),
    })
    renderApp('/app/conferences')
    await user.click(await screen.findByRole('button', { name: 'Connect Zoom' }))
    await user.click(screen.getByRole('link', { name: 'Calendars' }))
    await response.answer(json(200, { authorizationUrl: authUrl }))
    await screen.findByRole('heading', { name: 'Calendars', level: 1 })
    expect(goTo).not.toHaveBeenCalled()
  })
  it('rerenders known refresh errors in the chosen language and reloads the fail-closed status', async () => {
    const user = userEvent.setup()
    let current = account
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () => json(200, list([current])),
      [`POST /api/v1/conference-connections/${account.id}/refresh`]: () => {
        current = { ...account, status: 'refreshing' }
        return json(409, { error: 'zoom_refresh_incomplete', message: 'synthetic provider prose' })
      },
    })
    renderApp('/app/conferences')
    await user.click(await screen.findByRole('button', { name: 'Refresh Zoom account' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This Zoom refresh could not be confirmed.',
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(screen.getByRole('alert').textContent).toContain('无法确认此次 Zoom 刷新结果')
    expect(await screen.findByText('正在刷新连接')).toBeDefined()
    expect(screen.getByRole('button', { name: '刷新 Zoom 账号' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(
      requests.to(`POST /api/v1/conference-connections/${account.id}/refresh`)[0]?.body,
    ).toEqual({})
    expect(screen.queryByText('synthetic provider prose')).toBeNull()
  })
  it('explains an in-progress refresh in both languages and prevents another attempt after reloading', async () => {
    const user = userEvent.setup()
    let current = account
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () => json(200, list([current])),
      [`POST /api/v1/conference-connections/${account.id}/refresh`]: () => {
        current = { ...account, status: 'refreshing' }
        return json(409, { error: 'zoom_refresh_in_progress', message: 'synthetic provider prose' })
      },
    })
    renderApp('/app/conferences')
    await user.click(await screen.findByRole('button', { name: 'Refresh Zoom account' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This Zoom account is already being refreshed. Wait for it to finish, then reload.',
    )
    await screen.findByText('Refreshing connection')
    const refresh = screen.getByRole('button', { name: 'Refresh Zoom account' })
    expect(refresh.hasAttribute('disabled')).toBe(true)
    await user.click(refresh)
    expect(requests.to(`POST /api/v1/conference-connections/${account.id}/refresh`)).toHaveLength(1)
    expect(requests.to('GET /api/v1/conference-connections')).toHaveLength(2)
    expect(screen.queryByText('synthetic provider prose')).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(screen.getByRole('alert').textContent).toBe(
      '此 Zoom 账号正在刷新。请等待刷新完成后重新加载页面。',
    )
    expect(screen.getByText('正在刷新连接')).toBeDefined()
    expect(screen.getByRole('button', { name: '刷新 Zoom 账号' }).hasAttribute('disabled')).toBe(
      true,
    )
  })
  it('requires a focused in-place disconnect confirmation and removes the disconnected identity from the active list', async () => {
    const user = userEvent.setup()
    let current = account
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/conference-connections': () => json(200, list([current])),
      [`DELETE /api/v1/conference-connections/${account.id}`]: () => {
        current = { ...account, status: 'disconnected' }
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/conferences')
    await user.click(await screen.findByRole('button', { name: 'Disconnect Zoom' }))
    const group = screen.getByRole('group')
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(requests.to(`DELETE /api/v1/conference-connections/${account.id}`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Disconnect Zoom' }))
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Disconnect Zoom' }),
    )
    expect(await screen.findByText('No Zoom accounts connected.')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Settings', level: 2 })).toBeNull()
    expect(requests.to(`DELETE /api/v1/conference-connections/${account.id}`)[0]?.body).toEqual({})
  })
})
