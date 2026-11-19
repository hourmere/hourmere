import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fakeApi, json, later, profile, renderApp, signedIn } from '../test/fake-api.tsx'

const id = 'a0000000-0000-7000-8000-000000000001'
const calendarId = 'c0000000-0000-7000-8000-000000000001'
const choices = [
  { key: 'work', displayName: 'Work', color: null, canWrite: true },
  { key: 'shared', displayName: 'Shared', color: null, canWrite: false },
]
const connection = {
  id,
  provider: 'caldav',
  accountEmail: null,
  status: 'active',
  syncAuthorized: true,
  createdAt: '2026-11-16T10:00:00Z',
  updatedAt: '2026-11-16T10:00:00Z',
  calendars: [
    {
      id: calendarId,
      name: 'Work',
      timeZone: null,
      isPrimary: false,
      accessRole: 'writer',
      checkConflicts: true,
      lastSyncedAt: null,
      syncError: null,
      available: true,
    },
  ],
}
const list = (data: unknown[] = []) =>
  json(200, {
    data,
    googleEnabled: false,
    microsoftEnabled: false,
    caldavEnabled: true,
    destinationCalendarId: null,
  })
async function fill() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('CalDAV username'), 'synthetic-user')
  await user.type(screen.getByLabelText('CalDAV app password'), 'synthetic-app-password')
  return user
}

describe('CalDAV calendar connection', () => {
  it('discovers with a masked password, explicitly selects conflicts and one writable destination, then clears the form', async () => {
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list(),
      'POST /api/v1/calendar-connections/caldav/discover': () => json(200, { calendars: choices }),
      'POST /api/v1/calendar-connections/caldav': () => json(200, { id }),
    })
    renderApp('/app/calendars')
    await userEvent.click(await screen.findByRole('button', { name: 'Connect CalDAV' }))
    const user = await fill()
    expect((screen.getByLabelText('CalDAV app password') as HTMLInputElement).type).toBe('password')
    expect(screen.getByText(/Never enter your primary Apple Account password/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    const work = await screen.findByRole('checkbox', { name: 'Check Work for conflicts' })
    expect((work as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('CalDAV booking destination') as HTMLSelectElement).value).toBe(
      '',
    )
    expect(screen.queryByRole('option', { name: 'Shared' })).toBeNull()
    await user.click(work)
    await user.selectOptions(screen.getByLabelText('CalDAV booking destination'), 'work')
    await user.click(screen.getByRole('button', { name: 'Save CalDAV connection' }))
    await screen.findByText('CalDAV connection saved. Selected calendars are synchronizing.')
    expect(api.to('POST /api/v1/calendar-connections/caldav')[0]?.body).toEqual({
      serverUrl: 'https://caldav.icloud.com/',
      username: 'synthetic-user',
      password: 'synthetic-app-password',
      calendarKeys: ['work', 'shared'],
      conflictCalendarKeys: ['work'],
      destinationCalendarKey: 'work',
    })
    expect(screen.queryByLabelText('CalDAV app password')).toBeNull()
    expect(document.body.textContent).not.toContain('synthetic-app-password')
    expect(localStorage.getItem('synthetic-app-password')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect CalDAV' }))
    expect((screen.getByLabelText('CalDAV app password') as HTMLInputElement).value).toBe('')
  })

  it('shows provider presets, lets the user edit after discovery, and clears credentials on cancel', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list(),
      'POST /api/v1/calendar-connections/caldav/discover': () => json(200, { calendars: choices }),
    })
    renderApp('/app/calendars')
    await userEvent.click(await screen.findByRole('button', { name: 'Connect CalDAV' }))
    const user = await fill()
    await user.selectOptions(screen.getByLabelText('CalDAV provider'), 'fastmail')
    expect((screen.getByLabelText('CalDAV server URL') as HTMLInputElement).value).toBe(
      'https://caldav.fastmail.com/',
    )
    expect(screen.getByText(/Basic plans do not support CalDAV/)).toBeDefined()
    await user.selectOptions(screen.getByLabelText('CalDAV provider'), 'nextcloud')
    expect(screen.getByText(/installation prefix/)).toBeDefined()
    await user.type(
      screen.getByLabelText('CalDAV server URL'),
      'https://dav.example.com/remote.php/dav/',
    )
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    await user.click(await screen.findByRole('button', { name: 'Edit CalDAV credentials' }))
    expect((screen.getByLabelText('CalDAV server URL') as HTMLInputElement).value).toBe(
      'https://dav.example.com/remote.php/dav/',
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Connect CalDAV' }))
    expect((screen.getByLabelText('CalDAV username') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('CalDAV app password') as HTMLInputElement).value).toBe('')
  })

  it('cancels pending discovery and ignores a late response without restoring credentials', async () => {
    const response = later()
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list(),
      'POST /api/v1/calendar-connections/caldav/discover': () => response.response,
    })
    renderApp('/app/calendars')
    await userEvent.click(await screen.findByRole('button', { name: 'Connect CalDAV' }))
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => response.answer(json(200, { calendars: choices })))
    expect(screen.queryByLabelText('CalDAV app password')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Check Work for conflicts' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect CalDAV' }))
    expect((screen.getByLabelText('CalDAV app password') as HTMLInputElement).value).toBe('')
  })

  it('renders a fixed discovery error without echoing provider errors or credentials and allows retry', async () => {
    let failed = true
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list(),
      'POST /api/v1/calendar-connections/caldav/discover': () =>
        failed
          ? json(400, {
              error: 'caldav_needs_reauth',
              message: 'synthetic-app-password raw-provider-body',
            })
          : json(200, { calendars: choices }),
    })
    renderApp('/app/calendars')
    await userEvent.click(await screen.findByRole('button', { name: 'Connect CalDAV' }))
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Check your server, app password and calendar permissions',
    )
    expect(document.body.textContent).not.toContain('raw-provider-body')
    expect(document.body.textContent).not.toContain('synthetic-app-password')
    failed = false
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    await screen.findByRole('checkbox', { name: 'Check Work for conflicts' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reconnects the existing identity without prefilling credentials and reports failed saves safely', async () => {
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list([{ ...connection, status: 'needs_reauth' }]),
      'POST /api/v1/calendar-connections/caldav/discover': () => json(200, { calendars: choices }),
      'POST /api/v1/calendar-connections/caldav': () =>
        json(503, { message: 'private-provider-body' }),
    })
    renderApp('/app/calendars')
    await screen.findByText('Needs attention')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect CalDAV' }))
    expect((screen.getByLabelText('CalDAV username') as HTMLInputElement).value).toBe('')
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    await user.click(await screen.findByRole('button', { name: 'Save CalDAV connection' }))
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('private-provider-body')
    expect(api.to('POST /api/v1/calendar-connections/caldav/discover')[0]?.body).toMatchObject({
      connectionId: id,
    })
    expect(api.to('POST /api/v1/calendar-connections/caldav')[0]?.body).toMatchObject({
      connectionId: id,
    })
    expect(screen.getByRole('button', { name: 'Save CalDAV connection' })).toBeDefined()
  })

  it('supports conflict and write selection for writable CalDAV calendars and confirms disconnect retention', async () => {
    let data = [connection]
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list(data),
      [`PATCH /api/v1/calendars/${calendarId}`]: () => json(200, {}),
      'PUT /api/v1/calendar-destination': () => json(200, {}),
      [`DELETE /api/v1/calendar-connections/${id}`]: () => {
        data = []
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/calendars')
    await screen.findByRole('heading', { name: 'CalDAV account' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Write new bookings here' }))
    await waitFor(() => expect(api.to('PUT /api/v1/calendar-destination')).toHaveLength(1))
    await user.click(screen.getByRole('checkbox', { name: 'Check this calendar for conflicts' }))
    await waitFor(() => expect(api.to(`PATCH /api/v1/calendars/${calendarId}`)).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Disconnect CalDAV account' }))
    expect(screen.getByText(/leaves existing events on the server/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Disconnect account' }))
    await screen.findByText(
      'CalDAV Calendar disconnected. Stored credentials and local calendar data were deleted.',
    )
    expect(screen.queryByRole('heading', { name: 'CalDAV account' })).toBeNull()
  })

  it('uses neutral sync status and disables unavailable calendars without claiming empty availability', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () =>
        list([
          {
            ...connection,
            calendars: [{ ...connection.calendars[0], checkConflicts: false, available: false }],
          },
        ]),
    })
    renderApp('/app/calendars')
    const heading = await screen.findByRole('heading', { name: 'CalDAV account' })
    const account = within(heading.closest('article') as HTMLElement)
    expect((account.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect(
      (account.getByRole('button', { name: 'Write new bookings here' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('keeps unknown profile readiness neutral and allows discovery without offering a booking destination', async () => {
    fakeApi({
      ...signedIn,
      'GET /api/v1/profile': () => json(503, { error: 'unavailable' }),
      'GET /api/v1/calendar-connections': () => list(),
      'POST /api/v1/calendar-connections/caldav/discover': () => json(200, { calendars: choices }),
    })
    renderApp('/app/calendars')
    await userEvent.click(await screen.findByRole('button', { name: 'Connect CalDAV' }))
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Discover calendars' }))
    const destination = await screen.findByLabelText('CalDAV booking destination')
    expect((destination as HTMLSelectElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'Could not load your profile. Try again before choosing where new bookings are written.',
      ),
    ).toBeDefined()
    expect(
      screen.queryByText('Create a profile before choosing where new bookings are written.'),
    ).toBeNull()
  })

  it('renders the connection flow and errors in Chinese', async () => {
    localStorage.setItem('hourmere-language', 'zh-CN')
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () => list(),
      'POST /api/v1/calendar-connections/caldav/discover': () => json(403, { error: 'forbidden' }),
    })
    renderApp('/app/calendars')
    await userEvent.click(await screen.findByRole('button', { name: '连接 CalDAV' }))
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('CalDAV 用户名'), 'synthetic-user')
    await user.type(screen.getByLabelText('CalDAV 应用专用密码'), 'synthetic-password')
    await user.click(screen.getByRole('button', { name: '发现日历' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      '请检查服务器、应用专用密码和日历权限后重试',
    )
  })
})
