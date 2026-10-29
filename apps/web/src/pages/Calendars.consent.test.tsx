import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { goTo } from '../browser.ts'
import { fakeApi, json, later, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))

describe.each([false, true])(
  'Google Calendar pre-consent with connected account=%s',
  (connected) => {
    it.each([
      {
        locale: 'en',
        heading: 'Connect Google Calendar',
        permissions: /Google will ask for your email/,
        singleCopy: 'create one private copy of each new booking',
        destination: 'Changing this destination affects new bookings',
        existingCopies:
          'existing booking copies continue to be updated or cancelled on their original calendar',
        disconnect: /Disconnect deletes/,
        retainedEvents: 'leaves existing event copies in Google Calendar',
        retainedGrant: 'does not revoke your Google grant',
        revoke: 'Google Account connections',
        punctuation: '.',
      },
      {
        locale: 'zh-CN',
        heading: '连接 Google 日历',
        permissions: /Google 将请求你的邮箱/,
        singleCopy: '为每个新预约创建一份私有副本',
        destination: '更改写入目标只影响新预约',
        existingCopies: '现有预约的副本仍会在原日历中更新或取消',
        disconnect: /“断开连接”可删除/,
        retainedEvents: '保留 Google 日历中的现有事件副本',
        retainedGrant: '不会撤销 Google 授权',
        revoke: 'Google 账号连接',
        punctuation: '。',
      },
    ])('explains destination changes and local disconnect in $locale', async (copy) => {
      fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale: copy.locale }),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            data: connected
              ? [
                  {
                    id: 'a0000000-0000-7000-8000-000000000001',
                    provider: 'google',
                    accountEmail: 'calendar@example.test',
                    status: 'active',
                    syncAuthorized: true,
                    calendars: [],
                  },
                ]
              : [],
            googleEnabled: true,
            microsoftEnabled: false,
            destinationCalendarId: null,
          }),
      })
      renderApp('/app/calendars')
      const section = await screen.findByRole('region', { name: copy.heading })
      const permissions = within(section).getByText(copy.permissions)
      for (const detail of [copy.singleCopy, copy.destination, copy.existingCopies])
        expect(permissions.textContent).toContain(detail)

      const disconnect = within(section).getByText(
        (_, node) => node?.tagName === 'P' && copy.disconnect.test(node.textContent ?? ''),
      )
      expect(disconnect.querySelectorAll('.cjk-quote')).toHaveLength(
        copy.locale === 'zh-CN' ? 2 : 0,
      )
      expect(disconnect.textContent).toContain(copy.retainedEvents)
      expect(disconnect.textContent).toContain(copy.retainedGrant)
      const revoke = within(disconnect).getByRole('link', { name: copy.revoke })
      expect(revoke.getAttribute('href')).toBe('https://myaccount.google.com/connections')
      expect(disconnect.textContent?.trim().endsWith(copy.revoke + copy.punctuation)).toBe(true)
      if (copy.locale === 'zh-CN') {
        expect(permissions.textContent).not.toMatch(/[.,:;!?]/)
        expect(disconnect.textContent).not.toMatch(/[.,:;!?]/)
      }
      const connect = within(section).getByRole('button', { name: copy.heading })
      expect(
        document
          .getElementById(connect.getAttribute('aria-describedby') ?? '')
          ?.contains(permissions),
      ).toBe(true)
    })
  },
)

describe.each([
  {
    action: 'Reconnect Google Calendar',
    status: 'needs_reauth',
    syncAuthorized: true,
    lastError: null,
  },
  {
    action: 'Enable calendar synchronization',
    status: 'active',
    syncAuthorized: false,
    lastError: null,
  },
  {
    action: 'Restore calendar permissions',
    status: 'active',
    syncAuthorized: true,
    lastError: 'permissions_missing',
  },
] as const)('Google account recovery consent for $action', (account) => {
  it.each(['loading', 'error'] as const)(
    'waits for privacy discovery during %s and describes the complete grant before authorizing',
    async (initial) => {
      const user = userEvent.setup()
      const instance = later()
      let discoveryFailed = initial === 'error'
      vi.mocked(goTo).mockClear()
      const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic'
      const requests = fakeApi({
        ...signedIn,
        'GET /api/v1/instance': async () =>
          discoveryFailed
            ? json(503, { error: 'service_unavailable' })
            : (await instance.response).clone(),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            data: [
              {
                id: 'a0000000-0000-7000-8000-000000000001',
                provider: 'google',
                accountEmail: 'calendar@example.test',
                status: account.status,
                syncAuthorized: account.syncAuthorized,
                lastError: account.lastError,
                calendars: [],
              },
            ],
            googleEnabled: true,
            microsoftEnabled: false,
            destinationCalendarId: null,
          }),
        'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
      })
      renderApp('/app/calendars')
      const card = (await screen.findByRole('heading', { name: 'calendar@example.test' })).closest(
        'article',
      ) as HTMLElement
      const link = within(card).getByRole('link', { name: account.action })
      expect(link.getAttribute('href')).toBe('#calendar-connection-options')
      await user.click(link)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(goTo).not.toHaveBeenCalled()
      const consent = screen.getByRole('region', { name: 'Connect Google Calendar' })
      const button = within(consent).getByRole('button', { name: account.action })
      const permissions = document.getElementById(button.getAttribute('aria-describedby') ?? '')
      expect(permissions).not.toBeNull()
      expect(
        (permissions?.compareDocumentPosition(button) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(button.matches(':disabled')).toBe(true)
      await user.click(button)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(goTo).not.toHaveBeenCalled()

      if (initial === 'error') {
        await screen.findByText(
          'Could not load privacy information. Try again before connecting Google Calendar.',
        )
        expect(button.matches(':disabled')).toBe(true)
        await user.click(button)
        expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
        expect(goTo).not.toHaveBeenCalled()
        discoveryFailed = false
        await user.click(screen.getByRole('button', { name: 'Try again' }))
        expect(button.matches(':disabled')).toBe(true)
        await user.click(button)
        expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      }

      await instance.answer(
        json(200, {
          signIn: { email: true, google: false, microsoft: false },
          privacyPolicyUrl: 'https://operator.example/privacy',
        }),
      )
      for (const disclosure of [
        'Google will ask for your email, calendar list and event access',
        'create one private copy of each new booking',
        'existing booking copies continue to be updated or cancelled on their original calendar',
        'Busy-time synchronization stores times and event IDs, not event titles or descriptions',
        'does not revoke your Google grant',
      ])
        expect(permissions?.textContent).toContain(disclosure)
      expect(
        within(permissions as HTMLElement)
          .getByRole('link', { name: 'Privacy policy' })
          .getAttribute('href'),
      ).toBe('https://operator.example/privacy')
      expect(button.matches(':disabled')).toBe(false)
      await user.click(button)
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
        access: 'sync',
      })
    },
  )
})
