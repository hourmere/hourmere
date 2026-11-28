// Public booking pages share the root with the app's own pages. These tests keep the two
// apart: the app's paths keep working, public pages never touch the session, and every
// top-level path of the app is reserved so no handle can take it.
import { isClaimReservedHandle, isReservedName } from '@hourmere/core/reserved'
import { render, screen, waitFor } from '@testing-library/react'
import { RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../App.tsx'
import {
  fakeApi,
  json,
  later,
  organizations,
  profile,
  renderApp,
  signedIn,
} from '../test/fake-api.tsx'
import { EVENT, eventRoutes, slotsAnswer } from '../test/public-fixtures.ts'

const appPages = [
  ['/app/event-types', 'Event types'],
  ['/app/availability', 'Availability'],
  ['/app/bookings', 'Bookings'],
  ['/app/meeting-polls', 'Meeting polls'],
  ['/app/workflows', 'Workflows'],
  ['/app/team/bookings', 'Team bookings'],
  ['/app/analytics', 'Booking activity'],
  ['/app/conferences', 'Conference accounts'],
  ['/app/calendars', 'Calendars'],
  ['/app/api-keys', 'API keys'],
  ['/app/connected-apps', 'Connected apps'],
  ['/app/audit-log', 'Audit log'],
  ['/app/settings', 'Settings'],
  ['/app/routing-forms', 'Routing forms'],
] as const

describe('routing between the app and the public pages', () => {
  it.each(appPages)('keeps the app page %s', async (path, label) => {
    fakeApi({
      ...signedIn,
      ...organizations(),
      ...profile(),
      'GET /api/v1/mcp-oauth/connections': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
      'GET /api/v1/meeting-polls': () => json(200, { data: [], nextAfter: null }),
      'GET /api/v1/analytics/bookings': () =>
        json(200, {
          startDate: '2026-10-01',
          endDate: '2026-10-01',
          timeZone: 'UTC',
          totals: { created: 0, rescheduled: 0, cancelled: 0 },
          data: [],
        }),
      'GET /api/v1/conference-connections': () =>
        json(200, { data: [], zoomEnabled: false, maximumConnections: 5, pendingAttempts: 0 }),
      'GET /api/v1/calendar-connections': () => json(200, { googleEnabled: false, data: [] }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'GET /api/v1/audit-events': () => json(200, { data: [], nextCursor: null }),
      'GET /api/v1/audit-log/settings': () =>
        json(200, {
          retention: 'instance',
          retentionDays: null,
          instanceRetentionDays: null,
          effectiveRetentionDays: null,
          canChangeRetention: true,
        }),
      ...(path === '/app/workflows' && {
        'GET /api/v1/instance': () => json(200, { workflowsEnabled: true }),
        'GET /api/v1/workflows': () => json(200, { data: [], nextCursor: null }),
      }),
      ...(path === '/app/routing-forms' && {
        'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
        'GET /api/v1/routing-forms': () => json(200, { data: [], nextAfter: null }),
      }),
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
      ...appPages.map(([path]) => path),
      '/sign-in',
      '/booking',
      '/app',
      '/api',
      '/assets',
      '/mcp',
      '/oauth',
      '/team',
    ].map((path) => path.split('/')[1] as string)
    for (const segment of topLevel) expect(isReservedName(segment), segment).toBe(true)
    expect(isClaimReservedHandle('route')).toBe(true)
    expect(isReservedName('route')).toBe(false)
  })

  it.each(['verify', 'remove'])(
    'keeps the existing waitlist handle and %s event page',
    async (slug) => {
      const event = { ...EVENT, handle: 'waitlist', slug }
      fakeApi(eventRoutes(event, []))
      renderApp(`/waitlist/${slug}`)
      expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
      expect(screen.getByTestId('location').textContent).toBe(`/waitlist/${slug}`)
    },
  )
})

const formPaths = [
  ['/route/ada/intro', '/api/v1/public/-/routing/ada/intro'],
  ['/route/team/alpha/intro', '/api/v1/public/-/routing/teams/alpha/intro'],
] as const

it.each(formPaths)(
  'falls through to the existing public router while disabled at %s',
  async (path, endpoint) => {
    const api = fakeApi({
      'GET /api/v1/instance': () => json(200, { routingFormsEnabled: false }),
      [`GET ${endpoint}`]: () =>
        json(200, { versionId: 'form-version', title: 'Unexpected form', questions: [] }),
    })
    renderApp(path)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
    expect(api.calls.map(({ path }) => path)).toEqual(['/api/v1/instance'])
    expect(screen.getByTestId('location').textContent).toBe(path)
  },
)

it.each(formPaths)('only mounts the form once the instance enables %s', async (path, endpoint) => {
  const capability = later()
  const api = fakeApi({
    'GET /api/v1/instance': () => capability.response,
    [`GET ${endpoint}`]: () =>
      json(200, { versionId: 'form-version', title: 'Find the right meeting', questions: [] }),
  })
  renderApp(path)
  expect((await screen.findByText('Loading…')).getAttribute('role')).toBe('status')
  expect(api.to(`GET ${endpoint}`)).toHaveLength(0)
  await capability.answer(json(200, { routingFormsEnabled: true }))
  expect(await screen.findByRole('form', { name: 'Find the right meeting' })).toBeDefined()
  expect(api.to(`GET ${endpoint}`)).toHaveLength(1)
})

it('uses the ordinary public page when instance discovery fails', async () => {
  const api = fakeApi({ 'GET /api/v1/instance': () => json(503, { error: 'unreachable' }) })
  renderApp('/route/ada/intro')
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
  expect(api.calls.map(({ path }) => path)).toEqual(['/api/v1/instance'])
})

describe('routing continuation handoff in the browser', () => {
  let router: ReturnType<typeof createAppRouter> | undefined
  const fixtureLink = '/route/continue#token=fixture%2Dcapability'
  const resolve = 'POST /api/v1/routing-continuations/resolve'

  function open(path: string) {
    window.history.replaceState(null, '', path)
    router = createAppRouter()
    expect(window.location.hash).toBe('')
    expect(router.state.location.hash).toBe('')
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('fixture')
    return render(<RouterProvider router={router} />)
  }

  afterEach(() => {
    router?.dispose()
    router = undefined
    window.history.replaceState(null, '', '/')
  })

  it('clears the fragment before discovery, then uses ordinary booking resolution when off', async () => {
    const event = { ...EVENT, handle: 'route', slug: 'continue' }
    const api = fakeApi({
      ...eventRoutes(event, []),
      'GET /api/v1/instance': () => {
        expect(window.location.hash).toBe('')
        return json(200, { routingFormsEnabled: false })
      },
      [resolve]: () => json(404, { error: 'routing_forms_disabled' }),
    })
    open(fixtureLink)
    await waitFor(() => {
      expect(api.to(resolve)).toHaveLength(0)
      expect(api.to('GET /api/v1/public/route/continue')).toHaveLength(1)
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
    expect(api.calls.every(({ method }) => method === 'GET')).toBe(true)
    expect(JSON.stringify(api.calls)).not.toContain('fixture-capability')
    expect(window.location.pathname).toBe('/route/continue')
  })

  it('waits for enablement before sending the decoded token in a POST body', async () => {
    const capability = later()
    const storageRead = vi.spyOn(Storage.prototype, 'getItem')
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    const api = fakeApi({
      'GET /api/v1/instance': () => {
        expect(window.location.hash).toBe('')
        return capability.response
      },
      [resolve]: () => json(404, { error: 'routing_unavailable' }),
    })
    open(fixtureLink)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(api.to(resolve)).toHaveLength(0)
    await capability.answer(json(200, { routingFormsEnabled: true }))
    await waitFor(() => expect(api.to(resolve)).toHaveLength(1))
    expect(api.to(resolve)[0]).toMatchObject({
      path: '/api/v1/routing-continuations/resolve',
      body: { routeToken: 'fixture-capability' },
    })
    expect(window.location.href).not.toContain('fixture')
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('fixture')
    window.dispatchEvent(new Event('pagehide'))
    // The data router reads its own view-transition metadata (pathname only).
    expect(storageRead.mock.calls.filter(([key]) => key !== 'remix-router-transitions')).toEqual([])
    expect(storageWrite).not.toHaveBeenCalled()
  })

  it('requires the original link to resume after reopening a tab that visited while off', async () => {
    const event = { ...EVENT, handle: 'route', slug: 'continue' }
    let routingFormsEnabled = false
    const api = fakeApi({
      ...eventRoutes(event, []),
      'GET /api/v1/instance': () => json(200, { routingFormsEnabled }),
      [resolve]: () => json(404, { error: 'routing_unavailable' }),
    })
    const disabled = open(fixtureLink)
    await screen.findByRole('heading', { level: 1, name: 'Intro call' })
    const clearedLink = window.location.pathname + window.location.hash
    disabled.unmount()
    router?.dispose()

    routingFormsEnabled = true
    const reopened = open(clearedLink)
    await screen.findByRole('heading', { level: 1, name: 'Intro call' })
    expect(api.to(resolve)).toHaveLength(0)
    reopened.unmount()
    router?.dispose()

    open(fixtureLink)
    await waitFor(() =>
      expect(api.to(resolve)[0]?.body).toEqual({ routeToken: 'fixture-capability' }),
    )
  })

  it('clears a fresh fragment-only link opened on the same page', async () => {
    const event = { ...EVENT, handle: 'route', slug: 'continue' }
    const api = fakeApi({
      ...eventRoutes(event, []),
      'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
      [resolve]: () => {
        expect(window.location.hash).toBe('')
        return json(404, { error: 'routing_unavailable' })
      },
    })
    open('/route/continue')
    await screen.findByRole('heading', { name: 'Intro call', level: 1 })
    window.location.hash = '#token=fixture%2Dfresh'
    await waitFor(() => expect(api.to(resolve)[0]?.body).toEqual({ routeToken: 'fixture-fresh' }))
    expect(window.location.hash).toBe('')
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('fixture')
  })
})

it.each(['/route/legacy-event', '/route/continue', '/team/route/legacy-event'])(
  'keeps ordinary booking resolution at %s even when forms are enabled',
  async (path) => {
    const team = path.startsWith('/team/')
    const slug = path.endsWith('/continue') ? 'continue' : 'legacy-event'
    const endpoint = `/api/v1/public/${team ? 'teams/' : ''}route/${slug}`
    const event = {
      ...EVENT,
      handle: 'route',
      slug,
      ...(team && { team: { name: 'Route team', slug: 'route' } }),
    }
    const api = fakeApi({
      'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
      [`GET ${endpoint}`]: () => json(200, event),
      [`GET ${endpoint}/slots`]: slotsAnswer([]),
    })
    renderApp(path)
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
    expect(api.calls.some((call) => call.path.includes('/-/routing/'))).toBe(false)
  },
)

it.each(['/poll/legacy-event', '/team/poll/legacy-event'])(
  'preserves existing booking page %s beside the explicit poll routes',
  async (path) => {
    const team = path.startsWith('/team/')
    const endpoint = team
      ? '/api/v1/public/teams/poll/legacy-event'
      : '/api/v1/public/poll/legacy-event'
    const event = {
      ...EVENT,
      handle: 'poll',
      slug: 'legacy-event',
      ...(team && { team: { name: 'Poll team', slug: 'poll' } }),
    }
    const api = fakeApi({
      [`GET ${endpoint}`]: () => json(200, event),
      [`GET ${endpoint}/slots`]: slotsAnswer([]),
    })
    renderApp(path)
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
    expect(screen.getByTestId('location').textContent).toBe(path)
    expect(api.calls.some((call) => call.path.includes('/meeting-polls/'))).toBe(false)
    expect(api.calls.some((call) => /\/me$|\/api\/auth/.test(call.path))).toBe(false)
  },
)

it('keeps the existing booking-handoffs handle usable with the handoff page under booking', async () => {
  const event = { ...EVENT, handle: 'booking-handoffs', slug: 'offer' }
  const api = fakeApi(eventRoutes(event))
  renderApp('/booking-handoffs/offer')
  expect(await screen.findByRole('heading', { level: 1, name: event.title })).toBeDefined()
  expect(api.to('GET /api/v1/public/booking-handoffs/offer')).toHaveLength(1)
  expect(api.to('POST /api/v1/booking-handoffs/offer')).toHaveLength(0)
})
