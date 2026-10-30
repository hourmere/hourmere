import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { fakeApi, json, later, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { schedule } from '../test/fixtures.ts'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
beforeEach(() => vi.mocked(goTo).mockClear())

const calendar: Schemas['CalendarConnection']['calendars'][number] = {
  id: 'c0000000-0000-7000-8000-000000000001',
  name: 'Work calendar',
  timeZone: null,
  isPrimary: false,
  checkConflicts: true,
  accessRole: 'owner',
  lastSyncedAt: '2026-10-16T12:00:00Z',
  syncError: null,
}
const connection: Schemas['CalendarConnection'] = {
  id: 'a0000000-0000-7000-8000-000000000001',
  provider: 'google',
  accountEmail: 'original@example.test',
  status: 'active',
  syncAuthorized: true,
  lastError: null,
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  calendars: [calendar],
}
const list = (data = [connection], destinationCalendarId: string | null = null) => ({
  'GET /api/v1/calendar-connections': () =>
    json(200, {
      data,
      googleEnabled: true,
      microsoftEnabled: true,
      destinationCalendarId,
    }),
})
const authorization = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=synthetic',
}
async function account(email = connection.accountEmail as string) {
  return (await screen.findByRole('heading', { name: email })).closest('article') as HTMLElement
}
async function reviewRecovery(
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
  label: string | RegExp,
  provider: 'google' | 'microsoft',
  requests: ReturnType<typeof fakeApi>,
) {
  const entry = within(card).getByRole('link', { name: label })
  const targetId =
    provider === 'google' ? 'calendar-connection-options' : 'microsoft-calendar-connection-options'
  expect(entry.getAttribute('href')).toBe(`#${targetId}`)
  await user.click(entry)
  for (const provider of ['google', 'microsoft'])
    expect(requests.to(`POST /api/v1/calendar-connections/${provider}/authorize`)).toHaveLength(0)
  expect(goTo).not.toHaveBeenCalled()
  const section = document.getElementById(targetId) as HTMLElement
  const authorize = within(section).getByRole('button', { name: label })
  const permissions = document.getElementById(
    authorize.getAttribute('aria-describedby') ?? '',
  ) as HTMLElement
  expect(permissions).not.toBeNull()
  expect(section.contains(permissions)).toBe(true)
  expect(permissions.compareDocumentPosition(authorize) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  )
  expect(section.textContent).toContain('original@example.test')
  return authorize
}

describe('calendar recovery actions', () => {
  it.each(
    (['google', 'microsoft'] as const).flatMap((provider) =>
      (['needs_reauth', 'revoked'] as const).map((status) => ({ provider, status })),
    ),
  )(
    'reconnects a $status $provider account through that provider',
    async ({ provider, status }) => {
      const user = userEvent.setup()
      const name = provider === 'google' ? 'Google' : 'Microsoft'
      const requests = fakeApi({
        ...signedIn,
        ...profile(),
        ...list([{ ...connection, provider, status, syncAuthorized: provider === 'google' }]),
        [`POST /api/v1/calendar-connections/${provider}/authorize`]: () =>
          json(200, { authorizationUrl: authorization[provider] }),
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(within(card).getByText(`${name} Calendar`)).toBeDefined()
      if (provider === 'google')
        expect(within(card).getByRole('button', { name: 'Sync now' }).matches(':disabled')).toBe(
          true,
        )
      expect(card.textContent).toContain(
        `Choose original@example.test on the ${name} authorization page. Connecting a different account will not restore this one.`,
      )
      const reconnect = await reviewRecovery(
        user,
        card,
        `Reconnect ${name} Calendar`,
        provider,
        requests,
      )
      const permissions = document.getElementById(reconnect.getAttribute('aria-describedby') ?? '')
      expect(permissions?.textContent).toContain(
        provider === 'google'
          ? 'Google will ask for your email'
          : 'Microsoft will ask for your account identity',
      )
      await user.click(reconnect)
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization[provider]))
      expect(
        requests.to(`POST /api/v1/calendar-connections/${provider}/authorize`)[0]?.body,
      ).toEqual(provider === 'google' ? { access: 'sync' } : {})
      expect(
        requests.to(
          `POST /api/v1/calendar-connections/${provider === 'google' ? 'microsoft' : 'google'}/authorize`,
        ),
      ).toHaveLength(0)
      expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(0)
    },
  )

  it.each(['google', 'microsoft'] as const)(
    'keeps a failed %s reconnect on the account page with provider-specific feedback',
    async (provider) => {
      const user = userEvent.setup()
      const name = provider === 'google' ? 'Google' : 'Microsoft'
      const requests = fakeApi({
        ...signedIn,
        ...profile(),
        ...list([{ ...connection, provider, status: 'needs_reauth' }]),
        [`POST /api/v1/calendar-connections/${provider}/authorize`]: () =>
          json(503, { error: `${provider}_calendar_provider_unavailable` }),
      })
      renderApp('/app/calendars')
      const card = await account()
      await user.click(
        await reviewRecovery(user, card, `Reconnect ${name} Calendar`, provider, requests),
      )
      expect(
        await screen.findByText(
          `Could not connect ${name} Calendar. ${name} Calendar could not be reached. Try again shortly.`,
        ),
      ).toBeDefined()
      expect(within(card).getByText('Reconnect required')).toBeDefined()
      expect(goTo).not.toHaveBeenCalled()
    },
  )

  it('re-grants synchronization access for a list-only Google account instead of retrying sync', async () => {
    const user = userEvent.setup()
    const requests = fakeApi({
      ...signedIn,
      ...profile(),
      ...list([
        {
          ...connection,
          syncAuthorized: false,
          calendars: [{ ...calendar, checkConflicts: false, lastSyncedAt: null }],
        },
      ]),
      'POST /api/v1/calendar-connections/google/authorize': () =>
        json(200, { authorizationUrl: authorization.google }),
    })
    renderApp('/app/calendars')
    const card = await account()
    expect(within(card).queryByRole('button', { name: 'Retry synchronization' })).toBeNull()
    expect(within(card).queryByRole('link', { name: 'Reconnect Google Calendar' })).toBeNull()
    await user.click(
      await reviewRecovery(user, card, 'Enable calendar synchronization', 'google', requests),
    )
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization.google))
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
      access: 'sync',
    })
    expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(0)
  })

  it.each([
    {
      status: 'active',
      lastError: 'permissions_missing',
      syncAuthorized: true,
      syncError: 'permissions_missing',
      label: 'Enable calendar synchronization',
    },
    {
      status: 'needs_reauth',
      lastError: null,
      syncAuthorized: true,
      syncError: 'needs_reauth',
      label: 'Reconnect Google Calendar',
    },
    {
      status: 'active',
      lastError: 'needs_reauth',
      syncAuthorized: true,
      syncError: 'needs_reauth',
      label: 'Reconnect Google Calendar',
    },
    {
      status: 'active',
      lastError: null,
      syncAuthorized: false,
      syncError: 'permissions_missing',
      label: 'Enable calendar synchronization',
    },
  ] as const)(
    'requires authorization for status $status, lastError $lastError and syncAuthorized $syncAuthorized',
    async ({ status, lastError, syncAuthorized, syncError, label }) => {
      const user = userEvent.setup()
      const requests = fakeApi({
        ...signedIn,
        ...profile(),
        ...list([
          {
            ...connection,
            status,
            lastError,
            syncAuthorized,
            calendars: [{ ...calendar, syncError }],
          },
        ]),
        'POST /api/v1/calendar-connections/google/authorize': () =>
          json(200, { authorizationUrl: authorization.google }),
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(
        within(card).getByRole('button', { name: 'Retry synchronization' }).matches(':disabled'),
      ).toBe(true)
      await user.click(await reviewRecovery(user, card, label, 'google', requests))
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization.google))
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
        access: 'sync',
      })
      expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(0)
    },
  )

  it.each(
    [
      {
        locale: 'en',
        connected: 'Connected',
        retry: 'Retry synchronization',
        success: 'Latest synchronization of selected conflict calendars succeeded.',
      },
      {
        locale: 'zh-CN',
        connected: '已连接',
        retry: '重试同步',
        success: '所选冲突检查日历的最近一次同步已成功。',
      },
    ].flatMap((messages) =>
      (['needs_reauth', 'permissions_missing'] as const).map((syncError) => ({
        ...messages,
        syncError,
      })),
    ),
  )(
    'keeps a reconnected account with stale $syncError retryable in $locale',
    async ({ locale, connected, retry, success, syncError }) => {
      const user = userEvent.setup()
      let failed = true
      const requests = fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale }),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: true,
            destinationCalendarId: null,
            data: [
              {
                ...connection,
                status: 'active',
                lastError: null,
                syncAuthorized: true,
                calendars: [{ ...calendar, syncError: failed ? syncError : null }],
              },
            ],
          }),
        [`POST /api/v1/calendars/${calendar.id}/sync`]: () => {
          failed = false
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(within(card).getByText(connected)).toBeDefined()
      const retryButton = within(card).getByRole('button', { name: retry })
      expect(retryButton.matches(':disabled')).toBe(false)
      expect(within(card).queryByRole('link')).toBeNull()
      await user.click(retryButton)
      await screen.findByText(success)
      expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(1)
      expect(requests.to('GET /api/v1/calendar-connections').length).toBeGreaterThan(1)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(goTo).not.toHaveBeenCalled()
    },
  )

  it.each([null, 'permissions_missing'] as const)(
    'reviews sticky calendar permissions without claiming failed booking writes when syncError is %s',
    async (syncError) => {
      const user = userEvent.setup()
      const requests = fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [
            {
              ...connection,
              lastError: 'permissions_missing',
              calendars: [{ ...calendar, syncError }],
            },
          ],
          calendar.id,
        ),
        'POST /api/v1/calendar-connections/google/authorize': () =>
          json(200, { authorizationUrl: authorization.google }),
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(
        within(card).getByText(
          syncError
            ? 'Synchronization needs attention. Review the failed calendars below.'
            : 'Latest synchronization of selected conflict calendars succeeded.',
        ),
      ).toBeDefined()
      expect(within(card).getByRole('alert').textContent).toBe(
        'Calendar permissions need attention. Busy-time synchronization is reported separately below.',
      )
      expect(within(card).getByText('Calendar permissions need review')).toBeDefined()
      expect(within(card).getByText('Selected for new bookings — review permissions')).toBeDefined()
      expect(card.textContent).not.toContain('Paused until you reconnect')
      expect(card.textContent).not.toContain('Booking writes need permission')
      expect(within(card).queryByText('Unavailable for new bookings')).toBeNull()
      expect(within(card).queryByText('Selected for new bookings — unavailable')).toBeNull()
      expect(
        within(card).getByRole('link', { name: 'Choose another booking calendar' }),
      ).toBeDefined()
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
      await user.click(
        await reviewRecovery(
          user,
          card,
          syncError ? 'Enable calendar synchronization' : 'Restore calendar permissions',
          'google',
          requests,
        ),
      )
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization.google))
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
        access: 'sync',
      })
      expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(0)
    },
  )

  it.each(['provider_unavailable', 'unrecognized_safe_error'])(
    'retries a selected calendar synchronization for %s and reloads its actual result',
    async (syncError) => {
      const user = userEvent.setup()
      let failed = true
      const requests = fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: true,
            destinationCalendarId: null,
            data: [
              { ...connection, calendars: [{ ...calendar, syncError: failed ? syncError : null }] },
            ],
          }),
        [`POST /api/v1/calendars/${calendar.id}/sync`]: () => {
          failed = false
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(
        within(card).queryByRole('link', { name: /Reconnect|Enable calendar synchronization/ }),
      ).toBeNull()
      await user.click(within(card).getByRole('button', { name: 'Retry synchronization' }))
      await screen.findByText('Latest synchronization of selected conflict calendars succeeded.')
      expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(1)
      expect(requests.to('GET /api/v1/calendar-connections').length).toBeGreaterThan(1)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
    },
  )

  it.each(['google', 'microsoft'] as const)(
    'refreshes the %s calendar list after a provider failure without requesting authorization',
    async (provider) => {
      const user = userEvent.setup()
      let failed = true
      const requests = fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: true,
            destinationCalendarId: null,
            data: [
              {
                ...connection,
                provider,
                lastError: failed ? 'provider_unavailable' : null,
                syncAuthorized: provider === 'google',
                calendars: [],
              },
            ],
          }),
        [`POST /api/v1/calendar-connections/${connection.id}/refresh`]: () => {
          failed = false
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(within(card).getByRole('alert').textContent).toContain(
        'Try refreshing the calendar list',
      )
      await user.click(within(card).getByRole('button', { name: 'Refresh calendar list' }))
      await screen.findByText('Calendar list refreshed.')
      await vi.waitFor(() => expect(within(card).queryByRole('alert')).toBeNull())
      expect(
        requests.to(`POST /api/v1/calendar-connections/${connection.id}/refresh`),
      ).toHaveLength(1)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(requests.to('POST /api/v1/calendar-connections/microsoft/authorize')).toHaveLength(0)
    },
  )

  it.each([null, '2020-01-01T12:00:00Z'])(
    'uses only the returned not-ready or success fact when lastSyncedAt is %s',
    async (lastSyncedAt) => {
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list([{ ...connection, calendars: [{ ...calendar, lastSyncedAt }] }]),
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(
        within(card).getByText(
          lastSyncedAt
            ? 'Latest synchronization of selected conflict calendars succeeded.'
            : 'Synchronization is not ready for selected calendars yet.',
        ),
      ).toBeDefined()
      expect(within(card).getByRole('button', { name: 'Sync now' }).matches(':disabled')).toBe(
        false,
      )
      expect(within(card).queryByRole('button', { name: 'Retry synchronization' })).toBeNull()
      expect(
        within(card).queryByRole('link', {
          name: /Reconnect|Restore calendar|Enable calendar synchronization/,
        }),
      ).toBeNull()
      expect(within(card).queryByRole('alert')).toBeNull()
    },
  )

  it('leaves a healthy Microsoft account with its list-only disclosure and no recovery action', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list([{ ...connection, provider: 'microsoft', syncAuthorized: false }]),
    })
    renderApp('/app/calendars')
    const card = await account()
    expect(within(card).getByText('Not available — calendar list only.')).toBeDefined()
    expect(
      within(card).getByText(
        'This connection lists calendars only. Busy-time synchronization and booking writes are not yet available.',
      ),
    ).toBeDefined()
    expect(within(card).queryByRole('alert')).toBeNull()
    expect(
      within(card).queryByRole('button', {
        name: /Retry synchronization|Sync now/,
      }),
    ).toBeNull()
    expect(
      within(card).queryByRole('link', {
        name: /Reconnect|Restore calendar|Enable calendar synchronization/,
      }),
    ).toBeNull()
  })

  it.each([
    {
      provider: 'microsoft',
      status: 'revoked',
      lastError: null,
      syncError: null,
      label: /重新连接\s*Microsoft\s*日历/,
      summary: '暂不支持，仅可查看日历列表。',
    },
    {
      provider: 'google',
      status: 'active',
      lastError: 'permissions_missing',
      syncError: null,
      label: '恢复日历权限',
      summary: '所选冲突检查日历的最近一次同步已成功。',
    },
    {
      provider: 'google',
      status: 'active',
      lastError: 'permissions_missing',
      syncError: 'permissions_missing',
      label: '启用日历同步',
      summary: '同步需要处理，请查看下方同步失败的日历。',
    },
  ] as const)(
    'localizes the $provider recovery action and its independent sync result in Chinese',
    async ({ provider, status, lastError, syncError, label, summary }) => {
      const user = userEvent.setup()
      const requests = fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale: 'zh-CN' }),
        ...list(
          [
            {
              ...connection,
              provider,
              status,
              lastError,
              syncAuthorized: provider === 'google',
              calendars: [{ ...calendar, syncError }],
            },
          ],
          provider === 'google' ? calendar.id : null,
        ),
        [`POST /api/v1/calendar-connections/${provider}/authorize`]: () =>
          json(200, { authorizationUrl: authorization[provider] }),
      })
      renderApp('/app/calendars')
      const card = await account()
      expect(within(card).getByText(summary)).toBeDefined()
      expect(card.textContent).toContain('original@example.test')
      if (lastError === 'permissions_missing') {
        expect(within(card).getByText('需要授权')).toBeDefined()
        expect(within(card).getByText('日历权限需要复核')).toBeDefined()
        expect(within(card).getByText('已选为新预约写入目标，请复核权限')).toBeDefined()
        expect(within(card).queryByText('暂不能写入新预约')).toBeNull()
        expect(card.textContent).not.toContain('已暂停，请重新连接此账号。')
      }
      if (syncError === 'permissions_missing')
        expect(within(card).getByRole('button', { name: '重试同步' }).matches(':disabled')).toBe(
          true,
        )
      await user.click(await reviewRecovery(user, card, label, provider, requests))
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization[provider]))
      expect(
        requests.to(`POST /api/v1/calendar-connections/${provider}/authorize`)[0]?.body,
      ).toEqual(provider === 'google' ? { access: 'sync' } : {})
    },
  )

  it('points an unavailable write destination to another owned calendar without changing it automatically', async () => {
    const user = userEvent.setup()
    const alternative = {
      ...calendar,
      id: 'c0000000-0000-7000-8000-000000000002',
      name: 'Owned calendar',
    }
    const requests = fakeApi({
      ...signedIn,
      ...profile(),
      ...list(
        [{ ...connection, calendars: [{ ...calendar, accessRole: 'reader' }, alternative] }],
        calendar.id,
      ),
      'PUT /api/v1/calendar-destination': () => new Response(null, { status: 204 }),
    })
    renderApp('/app/calendars')
    const card = await account()
    const choose = within(card).getByRole('link', { name: 'Choose another booking calendar' })
    expect(choose.getAttribute('href')).toBe('#booking-calendar-options')
    expect(document.getElementById('booking-calendar-options')?.contains(card)).toBe(true)
    expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
    const item = within(card)
      .getByRole('heading', { name: alternative.name })
      .closest('li') as HTMLElement
    await user.click(within(item).getByRole('button', { name: 'Write new bookings here' }))
    await vi.waitFor(() => expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(1))
    expect(requests.to('PUT /api/v1/calendar-destination')[0]?.body).toEqual({
      calendarId: alternative.id,
    })
  })

  it('offers availability time-zone review beside the existing destination mismatch explanation', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list(
        [{ ...connection, calendars: [{ ...calendar, timeZone: 'America/Los_Angeles' }] }],
        calendar.id,
      ),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    })
    renderApp('/app/calendars')
    const card = await account()
    const review = within(card).getByRole('link', { name: 'Review availability time zone' })
    expect(review.getAttribute('href')).toBe('/app/availability')
    expect(review.parentElement?.textContent).toContain('Bookings land at the same moment')
    expect(within(card).queryByRole('alert')).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Retry synchronization' })).toBeNull()
  })

  it.each(['google', 'microsoft'] as const)(
    'uses returned account status after a successful %s callback that connected another account',
    async (provider) => {
      const name = provider === 'google' ? 'Google' : 'Microsoft'
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list([
          { ...connection, provider, status: 'needs_reauth' },
          {
            ...connection,
            provider,
            id: 'a0000000-0000-7000-8000-000000000002',
            accountEmail: 'different@example.test',
            calendars: [],
          },
        ]),
      })
      renderApp(`/app/calendars?connection=connected&provider=${provider}`)
      const original = await account()
      const different = await account('different@example.test')
      expect(within(original).getByText('Reconnect required')).toBeDefined()
      expect(
        within(original).getByRole('link', { name: `Reconnect ${name} Calendar` }),
      ).toBeDefined()
      expect(within(different).getByText('Connected')).toBeDefined()
      const notice = within(screen.getByRole('main')).getByRole('status')
      expect(notice.textContent).toContain(
        `${name} Calendar connected. Your calendar list is ready.`,
      )
      expect(notice.textContent).toContain(
        'Review the account status below to confirm which account connected.',
      )
      await vi.waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
      )
    },
  )

  it('gates the final Google recovery action on the permission disclosure loading successfully', async () => {
    const user = userEvent.setup()
    const instance = later()
    const requests = fakeApi({
      ...signedIn,
      ...profile(),
      ...list([{ ...connection, status: 'needs_reauth' }]),
      'GET /api/v1/instance': async () => (await instance.response).clone(),
      'POST /api/v1/calendar-connections/google/authorize': () =>
        json(200, { authorizationUrl: authorization.google }),
    })
    renderApp('/app/calendars')
    const card = await account()
    const reconnect = await reviewRecovery(
      user,
      card,
      'Reconnect Google Calendar',
      'google',
      requests,
    )
    expect(reconnect.matches(':disabled')).toBe(true)
    await user.click(reconnect)
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
    await instance.answer(
      json(200, {
        signIn: { email: true, google: false, microsoft: false },
        privacyPolicyUrl: 'https://operator.example/privacy',
      }),
    )
    expect(reconnect.matches(':disabled')).toBe(false)
    const permissions = document.getElementById(
      reconnect.getAttribute('aria-describedby') ?? '',
    ) as HTMLElement
    expect(
      within(permissions).getByRole('link', { name: 'Privacy policy' }).getAttribute('href'),
    ).toBe('https://operator.example/privacy')
    await user.click(reconnect)
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization.google))
  })
})
