import { act, render, screen, within } from '@testing-library/react'
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

it.each([
  { provider: 'google', action: 'connect' },
  { provider: 'microsoft', action: 'connect' },
  { provider: 'google', action: 'reconnect' },
  { provider: 'microsoft', action: 'reconnect' },
  { provider: 'google', action: 'enable' },
  { provider: 'google', action: 'restore' },
] as const)(
  'cancels $provider $action navigation as soon as a route transition starts, even before unmount',
  async ({ provider, action }) => {
    const name = provider === 'google' ? 'Google' : 'Microsoft'
    const user = userEvent.setup()
    let finish: (response: Response) => void = () => {}
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data:
            action === 'connect'
              ? []
              : [
                  {
                    id: 'a0000000-0000-7000-8000-000000000001',
                    provider,
                    accountEmail: 'calendar@example.test',
                    status: action === 'reconnect' ? 'needs_reauth' : 'active',
                    syncAuthorized: action !== 'enable',
                    lastError: action === 'restore' ? 'permissions_missing' : null,
                    calendars: [],
                  },
                ],
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
      if (action === 'connect') {
        await user.click(await screen.findByRole('button', { name: `Connect ${name} Calendar` }))
      } else {
        const account = (
          await screen.findByRole('heading', { name: 'calendar@example.test' })
        ).closest('article') as HTMLElement
        const label =
          action === 'enable'
            ? 'Enable calendar synchronization'
            : action === 'restore'
              ? 'Restore calendar permissions'
              : `Reconnect ${name} Calendar`
        const link = within(account).getByRole('link', { name: label })
        expect(link.getAttribute('href')).toBe(
          provider === 'microsoft'
            ? '#microsoft-calendar-connection-options'
            : '#calendar-connection-options',
        )
        await user.click(link)
        expect(requests.to(`POST /api/v1/calendar-connections/${provider}/authorize`)).toHaveLength(
          0,
        )
        expect(goTo).not.toHaveBeenCalled()
        const consent = screen.getByRole('region', { name: `Connect ${name} Calendar` })
        const button = within(consent).getByRole('button', { name: label })
        const disclosure = document.getElementById(button.getAttribute('aria-describedby') ?? '')
        expect(disclosure).not.toBeNull()
        expect(disclosure?.textContent).toContain(
          provider === 'google'
            ? 'Google will ask for your email, calendar list and event access'
            : 'Microsoft will ask for your account identity, continuing access and permission to read basic calendar details',
        )
        expect(
          (disclosure?.compareDocumentPosition(button) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
        await user.click(button)
      }
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
