// The signed-in app lives under /app; the root is for public pages.
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  emptyAccount,
  fakeApi,
  instance,
  json,
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
    expect(within(nav).getAllByRole('link')).toHaveLength(7)
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
