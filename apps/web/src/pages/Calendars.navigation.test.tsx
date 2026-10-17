import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import { goTo } from '../browser.ts'
import { fakeApi, json, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
vi.mock('../lazy-pages.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lazy-pages.tsx')>()
  const { lazy } = await import('react')
  return { ...actual, SettingsPage: lazy(() => new Promise(() => {})) }
})

it.each(['google', 'microsoft'] as const)(
  'cancels %s navigation as soon as a route transition starts, even before unmount',
  async (provider) => {
    const name = provider === 'google' ? 'Google' : 'Microsoft'
    const user = userEvent.setup()
    let finish: (response: Response) => void = () => {}
    fakeApi({
      ...signedIn,
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data: [],
          googleEnabled: true,
          microsoftEnabled: true,
          destinationCalendarId: null,
        }),
      [`POST /api/v1/calendar-connections/${provider}/authorize`]: () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    })
    const initialUrl = window.location.href
    try {
      window.history.replaceState({}, '', '/app/calendars')
      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>,
      )
      await user.click(await screen.findByRole('button', { name: `Connect ${name} Calendar` }))
      await user.click(screen.getByRole('link', { name: 'Settings' }))
      expect(window.location.pathname).toBe('/app/settings')
      // This is the important case: the old page has not unmounted yet.
      expect(screen.getByRole('heading', { name: 'Calendars', level: 1 })).toBeDefined()
      await act(async () => {
        finish(
          json(200, {
            authorizationUrl:
              provider === 'google'
                ? 'https://accounts.google.com/o/oauth2/v2/auth?state=fake-state'
                : 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=fake-state',
          }),
        )
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(goTo).not.toHaveBeenCalled()
    } finally {
      window.history.replaceState({}, '', initialUrl)
    }
  },
)
