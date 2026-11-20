// The signed-in app lives under /app; the root is for public pages.
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  emptyAccount,
  fakeApi,
  instance,
  json,
  later,
  renderApp,
  signedIn,
  signedOut,
} from './test/fake-api.tsx'

const location = () => screen.getByTestId('location').textContent

describe('the app under /app', () => {
  it.each(['/', '/app', '/app/'])('opens the event types from %s', async (path) => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp(path)
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/event-types')
  })

  it.each(['/event-types', '/availability', '/bookings', '/api-keys', '/settings'])(
    'does not keep the old address %s, even when signed in',
    async (path) => {
      const api = fakeApi({
        ...signedIn,
        [`GET /api/v1/public${path}`]: () => json(404, { error: 'host_not_found' }),
      })
      renderApp(path)
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
      expect(location()).toBe(path)
      // The public frame, not the app's: no navigation, no session needed.
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
      expect(api.to('GET /api/v1/me')).toHaveLength(0)
    },
  )

  it('shows old addresses as not found without asking anyone to sign in', async () => {
    const api = fakeApi({
      'GET /api/v1/public/api-keys': () => json(404, { error: 'host_not_found' }),
    })
    renderApp('/api-keys')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
    expect(location()).toBe('/api-keys')
    expect(api.to('GET /api/v1/me')).toHaveLength(0)
  })

  it('shows an unknown page under /app inside the app', async () => {
    fakeApi({ ...signedIn })
    renderApp('/app/nothing-here')
    expect(await screen.findByRole('heading', { name: 'Page not found', level: 1 })).toBeDefined()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    // The audit log link joins once the personal owner's role is confirmed.
    await waitFor(() => expect(within(nav).getAllByRole('link')).toHaveLength(11))
    expect(within(nav).getByRole('link', { name: 'Meeting polls' }).getAttribute('href')).toBe(
      '/app/meeting-polls',
    )
    expect(
      within(nav).getByRole('link', { name: 'Conference accounts' }).getAttribute('href'),
    ).toBe('/app/conferences')
    expect(within(nav).getByRole('link', { name: 'Calendars' }).getAttribute('href')).toBe(
      '/app/calendars',
    )
  })

  it('sends visitors to sign in from any page under /app, remembering it', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/app/bookings?tab=past')
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fbookings%3Ftab%3Dpast')
  })
})

describe('workflow discovery in the app shell', () => {
  const termsUrl = 'https://example.test/terms'

  it.each([false, undefined])('keeps workflows hidden when discovery returns %s', async (flag) => {
    const api = fakeApi({
      ...signedIn,
      ...emptyAccount,
      'GET /api/v1/instance': () => json(200, { termsUrl, workflowsEnabled: flag }),
    })
    renderApp('/app/event-types')

    await screen.findByRole('link', { name: 'Terms of service' })
    const nav = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(nav.queryByRole('link', { name: 'Workflows' })).toBeNull()
    expect(api.to('GET /api/v1/instance')).toHaveLength(1)
    expect(api.to('GET /api/v1/workflows')).toHaveLength(0)
  })

  describe.each(['/workflows', '/workflows/00000000-0000-4000-8000-000000000001/runs'])(
    'direct access to %s',
    (path) => {
      it.each([false, undefined])(
        'keeps the page hidden when discovery returns %s',
        async (flag) => {
          const discovery = later()
          const api = fakeApi({
            ...signedIn,
            'GET /api/v1/instance': () => discovery.response,
          })
          renderApp(`/app${path}`)

          await screen.findByRole('status', { name: 'Loading…' })
          expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull()
          expect(api.to(`GET /api/v1${path}`)).toHaveLength(0)
          await discovery.answer(json(200, { termsUrl, workflowsEnabled: flag }))

          await screen.findByRole('heading', { name: 'Page not found', level: 1 })
          expect(screen.getByRole('link', { name: 'Terms of service' }).getAttribute('href')).toBe(
            termsUrl,
          )
          expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull()
          expect(api.to('GET /api/v1/instance')).toHaveLength(1)
          expect(api.to(`GET /api/v1${path}`)).toHaveLength(0)
        },
      )
    },
  )

  it('adds workflow navigation after affirmative discovery using the policy request', async () => {
    const api = fakeApi({
      ...signedIn,
      ...emptyAccount,
      'GET /api/v1/instance': () => json(200, { termsUrl, workflowsEnabled: true }),
    })
    renderApp('/app/event-types')

    expect((await screen.findByRole('link', { name: 'Workflows' })).getAttribute('href')).toBe(
      '/app/workflows',
    )
    expect(screen.getByRole('link', { name: 'Terms of service' }).getAttribute('href')).toBe(
      termsUrl,
    )
    expect(api.to('GET /api/v1/instance')).toHaveLength(1)
    expect(api.to('GET /api/v1/workflows')).toHaveLength(0)
  })
})
