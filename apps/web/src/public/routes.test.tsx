// Public booking pages share the root with the app's own pages. These tests keep the two
// apart: the app's paths keep working, public pages never touch the session, and every
// top-level path of the app is reserved so no handle can take it.
import { isReservedName } from '@hourmere/core/reserved'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from '../components/AppShell.tsx'
import { fakeApi, json, organizations, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { EVENT, eventRoutes } from '../test/public-fixtures.ts'

describe('routing between the app and the public pages', () => {
  it.each(NAV_ITEMS)('keeps the app page $to', async ({ to: path, label }) => {
    fakeApi({
      ...signedIn,
      ...organizations(),
      ...profile(),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
      'GET /api/v1/calendar-connections': () => json(200, { googleEnabled: false, data: [] }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
    })
    renderApp(path)
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeDefined()
    expect(await screen.findByRole('heading', { name: label, level: 1 })).toBeDefined()
    expect(screen.getByTestId('location').textContent).toBe(path)
  })

  it('serves booking pages without asking who is signed in', async () => {
    // No GET /api/v1/me here: a request the test did not script fails it.
    fakeApi({
      'GET /api/v1/public/ada': () =>
        json(200, {
          handle: 'ada',
          host: { name: 'Ada Lovelace', timeZone: 'UTC' },
          eventTypes: [],
        }),
      ...eventRoutes(EVENT, []),
    })
    renderApp('/ada')
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeDefined()
    renderApp('/ada/intro')
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
    renderApp('/booking')
    expect(await screen.findByRole('heading', { name: 'Open your booking link' })).toBeDefined()
  })

  it('shows the app’s not-found page for deeper paths', async () => {
    fakeApi({})
    renderApp('/ada/intro/extra')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
  })

  it('reserves every top-level path of the app, so no handle can shadow one', () => {
    const topLevel = [
      ...NAV_ITEMS.map((item) => item.to),
      '/sign-in',
      '/booking',
      '/app',
      '/api',
      '/assets',
      '/mcp',
      '/team',
    ].map((path) => path.split('/')[1] as string)
    for (const segment of topLevel) expect(isReservedName(segment), segment).toBe(true)
  })
})
