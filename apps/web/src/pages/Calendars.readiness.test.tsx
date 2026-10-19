import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { goTo } from '../browser.ts'
import { fakeApi, json, later, renderApp, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))

describe('calendar profile and consent readiness together', () => {
  it.each([
    [
      'en',
      'Create profile',
      'Connect Google Calendar',
      'Write new bookings here',
      'Privacy policy',
    ],
    ['zh-CN', '创建个人资料', '连接 Google 日历', '将新预约写入此日历', '隐私政策'],
  ] as const)(
    'keeps the missing-profile hint and pre-consent gate independent in %s',
    async (locale, createLabel, connectLabel, destinationLabel, privacyLabel) => {
      const user = userEvent.setup()
      const instance = later()
      const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic'
      const requests = fakeApi({
        ...signedIn,
        'GET /api/v1/instance': async () => (await instance.response).clone(),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: false,
            destinationCalendarId: null,
            data: [
              {
                id: 'a0000000-0000-7000-8000-000000000001',
                provider: 'google',
                accountEmail: 'host@example.test',
                status: 'active',
                syncAuthorized: true,
                calendars: [
                  {
                    id: 'c0000000-0000-7000-8000-000000000001',
                    name: 'Original calendar',
                    isPrimary: true,
                    checkConflicts: false,
                    accessRole: 'owner',
                    lastSyncedAt: null,
                    syncError: null,
                  },
                ],
              },
            ],
          }),
        'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'host@example.test' })
      if (locale === 'zh-CN')
        await user.selectOptions(
          screen.getByRole('combobox', { name: 'Interface language' }),
          locale,
        )
      expect(screen.queryByRole('link', { name: createLabel })).not.toBeNull()
      const profileLink = screen.getByRole('link', { name: createLabel })
      const destination = screen.getByRole('button', { name: destinationLabel })
      const connect = screen.getByRole('button', { name: connectLabel })
      const permissions = document.getElementById(
        connect.getAttribute('aria-describedby') as string,
      ) as HTMLElement
      expect(permissions).not.toBeNull()
      expect(profileLink.getAttribute('href')).toBe('/app/settings#profile-heading')
      expect(destination.getAttribute('aria-describedby')).toBe(profileLink.parentElement?.id)
      expect(permissions.textContent).toContain('Google Meet')
      expect(destination.matches(':disabled')).toBe(true)
      expect(connect.matches(':disabled')).toBe(true)
      await user.click(connect)
      await user.click(destination)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
      expect(goTo).not.toHaveBeenCalled()

      await instance.answer(
        json(200, {
          signIn: { email: true, google: false, microsoft: false },
          privacyPolicyUrl: 'https://operator.example/privacy',
        }),
      )
      expect(
        within(permissions).getByRole('link', { name: privacyLabel }).getAttribute('href'),
      ).toBe('https://operator.example/privacy')
      expect(connect.matches(':disabled')).toBe(false)
      expect(destination.matches(':disabled')).toBe(true)
      await user.click(connect)
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
    },
  )
})
