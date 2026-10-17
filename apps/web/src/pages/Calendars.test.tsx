import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { fakeApi, json, profile, renderApp, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
const connection: Schemas['CalendarConnection'] = {
  id: 'a0000000-0000-7000-8000-000000000001',
  provider: 'google',
  accountEmail: 'calendar@example.com',
  status: 'active',
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  calendars: [
    { id: 'c0000000-0000-7000-8000-000000000001', name: 'Work calendar', isPrimary: true },
  ],
}
const list = (data = [connection], googleEnabled = true) => ({
  'GET /api/v1/calendar-connections': () => json(200, { data, googleEnabled }),
})
const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=fake-state'

describe('the calendars page', () => {
  it('lists calendars and explains the current permissions before connecting', async () => {
    const user = userEvent.setup()
    const requests = fakeApi({
      ...signedIn,
      ...list(),
      'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
    })
    renderApp('/app/calendars')
    expect(await screen.findByText('Work calendar (primary)')).toBeDefined()
    expect(screen.getByText(/separate from signing in/).textContent).toContain(
      'does not allow Hourmere to read or change your events',
    )
    await user.click(screen.getByRole('button', { name: 'Connect Google Calendar' }))
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({})
  })

  it('shows a disabled instance without hiding existing connections', async () => {
    fakeApi({ ...signedIn, ...list([connection], false) })
    renderApp('/app/calendars')
    expect(await screen.findByText(/not configured on this Hourmere instance/)).toBeDefined()
    expect(screen.getByText('Work calendar (primary)')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Connect Google Calendar' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect calendar@example.com' })).toBeDefined()
  })

  it('turns callback results into fixed messages and removes the result from the URL', async () => {
    fakeApi({ ...signedIn, ...list([]) })
    renderApp('/app/calendars?connection=denied')
    expect(await screen.findByText(/cancelled authorization/)).toBeDefined()
    await vi.waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
    )
  })

  it('does not render arbitrary callback text', async () => {
    fakeApi({ ...signedIn, ...list([]) })
    renderApp('/app/calendars?connection=private-untrusted-provider-error')
    await screen.findByText('No Google accounts connected yet.')
    expect(document.body.textContent).not.toContain('private-untrusted-provider-error')
  })

  it('asks before disconnecting and refreshes the list after deletion', async () => {
    const user = userEvent.setup()
    let connected = true
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/calendar-connections': () =>
        json(200, { data: connected ? [connection] : [], googleEnabled: true }),
      [`DELETE /api/v1/calendar-connections/${connection.id}`]: () => {
        connected = false
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Disconnect calendar@example.com' }))
    const confirm = screen.getByRole('group', { name: /Disconnect calendar@example.com\?/ })
    expect(requests.to(`DELETE /api/v1/calendar-connections/${connection.id}`)).toHaveLength(0)
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect account' }))
    expect(await screen.findByText('No Google accounts connected yet.')).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Connected accounts' }))
    expect(
      screen.getByText(/Stored credentials and local calendar data were deleted/),
    ).toBeDefined()
  })

  it('reports a denied refresh and asks for reconnection', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...list(),
      [`POST /api/v1/calendar-connections/${connection.id}/refresh`]: () =>
        json(409, {
          error: 'google_calendar_needs_reauth',
          message: 'Reconnect Google Calendar to restore access.',
        }),
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Refresh calendar list' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Reconnect Google Calendar')
  })

  it('does not follow a late authorization response after the person leaves', async () => {
    const user = userEvent.setup()
    let finish: (response: Response) => void = () => {}
    vi.mocked(goTo).mockClear()
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list(),
      'POST /api/v1/calendar-connections/google/authorize': () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    await act(async () => {
      finish(json(200, { authorizationUrl }))
      await Promise.resolve()
    })
    expect(goTo).not.toHaveBeenCalled()
  })
})
