import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  fakeApi,
  instance,
  json,
  ME,
  organizations,
  renderApp,
  signedIn,
  signedOut,
} from './test/fake-api.tsx'

const location = () => screen.getByTestId('location').textContent

describe('the session gate', () => {
  it('sends visitors who are not signed in to sign-in, remembering the page', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/api-keys?tab=new')
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in?next=%2Fapi-keys%3Ftab%3Dnew')
  })

  it('does not remember the start page', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/')
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe('/sign-in')
  })

  it('shows signed-in people the app with its navigation', async () => {
    fakeApi(signedIn)
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(location()).toBe('/event-types')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Event types', 'Availability', 'Bookings', 'API keys', 'Settings'])
    expect(screen.getByRole('link', { name: 'Event types' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByText(ME.user.email)).toBeDefined()
  })

  it('moves between pages with the navigation', async () => {
    fakeApi(signedIn)
    renderApp('/event-types')
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
    expect(location()).toBe('/settings')
    expect(document.activeElement?.id).toBe('main')
  })

  it('offers a retry when the server cannot be reached', async () => {
    let up = false
    fakeApi({
      'GET /api/v1/me': () => {
        if (!up) throw new TypeError('Failed to fetch')
        return json(200, ME)
      },
    })
    renderApp('/settings')
    expect((await screen.findByRole('alert')).textContent).toMatch(/can't reach hourmere/i)
    up = true
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
  })

  it('goes to sign-in, without a page to return to, after signing out', async () => {
    const api = fakeApi({
      ...signedIn,
      ...instance(),
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    renderApp('/settings')
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in')
    expect(api.to('POST /api/auth/sign-out')).toHaveLength(1)
  })

  it('returns to sign-in, remembering the page, when the session lapses', async () => {
    let keys = 0
    fakeApi({
      ...signedIn,
      ...instance(),
      ...organizations(),
      'GET /api/auth/api-key/list': () =>
        keys++ === 0 ? json(200, { apiKeys: [], total: 0 }) : json(401, { code: 'UNAUTHORIZED' }),
      'POST /api/auth/api-key/create': () => json(401, { code: 'UNAUTHORIZED' }),
    })
    renderApp('/api-keys')
    await screen.findByText('You have no API keys yet.')
    await userEvent.type(screen.getByLabelText('Name'), 'Agent')
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in?next=%2Fapi-keys')
  })
})
