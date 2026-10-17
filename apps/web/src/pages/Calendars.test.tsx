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
  syncAuthorized: false,
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  calendars: [
    {
      id: 'c0000000-0000-7000-8000-000000000001',
      name: 'Work calendar',
      isPrimary: true,
      checkConflicts: false,
      accessRole: 'owner',
      lastSyncedAt: null,
      syncError: null,
    },
  ],
}
const list = (data = [connection], googleEnabled = true, microsoftEnabled = false) => ({
  'GET /api/v1/calendar-connections': () =>
    json(200, { data, googleEnabled, microsoftEnabled, destinationCalendarId: null }),
})
const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=fake-state'

describe('the calendars page', () => {
  it('connects Microsoft separately and exposes only its available calendar-list actions', async () => {
    const user = userEvent.setup()
    const microsoft: Schemas['CalendarConnection'] = {
      ...connection,
      id: 'b0000000-0000-7000-8000-000000000001',
      provider: 'microsoft',
      accountEmail: 'outlook@example.com',
    }
    const microsoftUrl =
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=fake-microsoft-state'
    const requests = fakeApi({
      ...signedIn,
      ...list([microsoft], false, true),
      'POST /api/v1/calendar-connections/microsoft/authorize': () =>
        json(200, { authorizationUrl: microsoftUrl }),
    })
    renderApp('/app/calendars')
    const article = (await screen.findByRole('heading', { name: 'outlook@example.com' })).closest(
      'article',
    ) as HTMLElement
    expect(within(article).getByText(/lists calendars only/)).toBeDefined()
    expect(
      within(article).queryByRole('button', { name: 'Enable calendar synchronization' }),
    ).toBeNull()
    expect(within(article).queryByRole('checkbox')).toBeNull()
    expect(within(article).queryByRole('button', { name: /Write new bookings/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect Microsoft Calendar' }))
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(microsoftUrl))
    expect(requests.to('POST /api/v1/calendar-connections/microsoft/authorize')[0]?.body).toEqual(
      {},
    )
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
  })

  it.each([
    'https://attacker.example/authorize',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://login.microsoftonline.com/other/oauth2/v2.0/authorize',
  ])('refuses an unexpected Microsoft authorization URL: %s', async (authorizationUrl) => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...list([], false, true),
      'POST /api/v1/calendar-connections/microsoft/authorize': () =>
        json(200, { authorizationUrl }),
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Connect Microsoft Calendar' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not connect Microsoft Calendar.',
    )
    expect(goTo).not.toHaveBeenCalled()
  })

  it('names a successful Microsoft callback without rendering arbitrary provider text', async () => {
    fakeApi({ ...signedIn, ...list([]) })
    renderApp('/app/calendars?connection=connected&provider=microsoft')
    expect(
      await screen.findByText('Microsoft Calendar connected. Your calendar list is ready.'),
    ).toBeDefined()
    await vi.waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
    )
  })
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
      'event read access and permission to',
    )
    await user.click(screen.getByRole('button', { name: 'Connect Google Calendar' }))
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
      access: 'sync',
    })
  })

  it('shows a disabled instance without hiding existing connections', async () => {
    fakeApi({ ...signedIn, ...list([connection], false) })
    renderApp('/app/calendars')
    expect(
      await screen.findByText(/Google Calendar is not configured on this Hourmere instance/),
    ).toBeDefined()
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
    await screen.findByText('No calendar accounts connected yet.')
    expect(document.body.textContent).not.toContain('private-untrusted-provider-error')
  })

  it('asks before disconnecting and refreshes the list after deletion', async () => {
    const user = userEvent.setup()
    let connected = true
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data: connected ? [connection] : [],
          googleEnabled: true,
          microsoftEnabled: false,
        }),
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
    expect(await screen.findByText('No calendar accounts connected yet.')).toBeDefined()
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

  it('selects conflict calendars, synchronizes and saves an owned booking destination', async () => {
    const user = userEvent.setup()
    let enabled = false,
      synced = false,
      destination: string | null = null
    const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          googleEnabled: true,
          microsoftEnabled: false,
          destinationCalendarId: destination,
          data: [
            {
              ...connection,
              syncAuthorized: true,
              calendars: [
                {
                  ...calendar,
                  checkConflicts: enabled,
                  lastSyncedAt: synced ? '2026-10-16T12:00:00Z' : null,
                },
              ],
            },
          ],
        }),
      [`PATCH /api/v1/calendars/${calendar.id}`]: () => {
        enabled = true
        return new Response(null, { status: 204 })
      },
      [`POST /api/v1/calendars/${calendar.id}/sync`]: () => {
        synced = true
        return new Response(null, { status: 204 })
      },
      'PUT /api/v1/calendar-destination': () => {
        destination = calendar.id
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/calendars')
    await user.click(
      await screen.findByRole('checkbox', { name: 'Check conflicts in Work calendar' }),
    )
    expect(await screen.findByText(/Waiting for the first synchronization/)).toBeDefined()
    expect(requests.to(`PATCH /api/v1/calendars/${calendar.id}`)[0]?.body).toEqual({
      checkConflicts: true,
    })
    await user.click(screen.getByRole('button', { name: 'Sync Work calendar now' }))
    expect(await screen.findByText(/Last synchronized:/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Write new bookings to Work calendar' }))
    expect(
      await screen.findByRole('button', { name: 'Stop writing bookings to Work calendar' }),
    ).toBeDefined()
    expect(requests.to('PUT /api/v1/calendar-destination')[0]?.body).toEqual({
      calendarId: calendar.id,
    })
  })
  it('keeps a failed conflict selection unchecked and reports the server reason', async () => {
    const user = userEvent.setup()
    const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    fakeApi({
      ...signedIn,
      ...list([{ ...connection, syncAuthorized: true }]),
      [`PATCH /api/v1/calendars/${calendar.id}`]: () =>
        json(409, {
          error: 'google_calendar_permissions_missing',
          message: 'Reconnect before enabling busy times.',
        }),
    })
    renderApp('/app/calendars')
    await user.click(
      await screen.findByRole('checkbox', { name: 'Check conflicts in Work calendar' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Reconnect before enabling busy times.',
    )
    await vi.waitFor(() =>
      expect(
        (
          screen.getByRole('checkbox', {
            name: 'Check conflicts in Work calendar',
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    )
  })

  it.each(['needs_reauth', 'revoked'] as const)(
    'allows local conflict deselection after access becomes %s',
    async (status) => {
      const user = userEvent.setup()
      let selected = true
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: false,
            microsoftEnabled: false,
            destinationCalendarId: null,
            data: [
              {
                ...connection,
                status,
                syncAuthorized: false,
                calendars: [{ ...calendar, checkConflicts: selected }],
              },
            ],
          }),
        [`PATCH /api/v1/calendars/${calendar.id}`]: () => {
          selected = false
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      const checkbox = (await screen.findByRole('checkbox', {
        name: 'Check conflicts in Work calendar',
      })) as HTMLInputElement
      expect(checkbox.matches(':disabled')).toBe(false)
      await user.click(checkbox)
      await vi.waitFor(() =>
        expect(
          screen.queryByRole('checkbox', { name: 'Check conflicts in Work calendar' }),
        ).toBeNull(),
      )
      expect(selected).toBe(false)
    },
  )

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
