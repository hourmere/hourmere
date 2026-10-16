import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from './api/client.ts'
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
const EXPIRED = 'Your session ended. Please sign in again.'
const TEAM_ID = '00000000-0000-7000-8000-0000000000c3'

describe('the session gate', () => {
  it('sends visitors who are not signed in to sign-in, remembering the page', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/api-keys?tab=new')
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in?next=%2Fapi-keys%3Ftab%3Dnew')
    // A first visit, not a session that ended.
    expect(screen.queryByText(EXPIRED)).toBeNull()
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
    expect(screen.queryByText(EXPIRED)).toBeNull()
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
    expect(screen.getByText(EXPIRED).getAttribute('role')).toBe('status')
  })

  it('checks the session again when the window regains focus', async () => {
    let me: Schemas['Me'] = ME
    const api = fakeApi({
      'GET /api/v1/me': () => json(200, me),
      ...instance(),
    })
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    // The organization on the Settings page (a <dd> after its <dt>).
    const organization = () => screen.getByText('Organization').nextElementSibling?.textContent
    expect(organization()).toBe('Ada (personal)')

    // Switched to a team in another tab.
    me = { ...ME, organization: { ...ME.organization, id: TEAM_ID, name: 'Acme', personal: false } }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() => expect(organization()).toBe('Acme'))

    // Back in a hidden-then-visible tab, the session is gone: sign-in, with a notice.
    me = ME
    fakeApi({ ...signedOut, ...instance() })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in?next=%2Fsettings')
    expect(screen.getByText(EXPIRED)).toBeDefined()
    expect(api.to('GET /api/v1/me').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the page when a background check cannot reach the server', async () => {
    let up = true
    fakeApi({
      'GET /api/v1/me': () => {
        if (!up) throw new TypeError('Failed to fetch')
        return json(200, ME)
      },
    })
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    up = false
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a background check the server answered before signing out', async () => {
    let answer: (res: Response) => void = () => {}
    let pending = false
    const api = fakeApi({
      'GET /api/v1/me': () => {
        if (!pending) return json(200, ME)
        // The server answers this check only after the sign-out has gone through.
        return new Promise<Response>((resolve) => {
          answer = resolve
        })
      },
      ...instance(),
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    pending = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    await act(async () => {
      answer(json(200, ME))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in')
  })

  it('goes into the app when a check after signing out finds a new sign-in', async () => {
    let signedInElsewhere = false
    fakeApi({
      'GET /api/v1/me': () =>
        signedInElsewhere ? json(200, ME) : json(401, { error: 'unauthorized' }),
      ...instance(),
    })
    renderApp('/sign-in')
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    // Signed in from the email link in another tab, then back here.
    signedInElsewhere = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
  })
})

describe('when the account or organization changes elsewhere', () => {
  const SECRET = 'hm_AdasSecretShownOnlyOnce0123456789abcdefghijklmnopqrstuvwxyzABCDEF'
  const GRACE: Schemas['Me'] = {
    user: { id: '00000000-0000-7000-8000-0000000000d1', name: 'Grace', email: 'grace@example.com' },
    organization: {
      id: '00000000-0000-7000-8000-0000000000d2',
      name: 'Grace',
      slug: 'grace',
      personal: true,
    },
    principal: { kind: 'session', apiKeyId: null },
  }
  const ADA_KEY = {
    id: '00000000-0000-7000-8000-0000000000a1',
    name: 'Ada laptop',
    start: 'hm_Ada',
    enabled: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    expiresAt: null,
    lastRequest: null,
    metadata: { organizationId: ME.organization.id },
  }

  /** Ada, who has one key, creates another and is looking at its secret. */
  async function adaLookingAtANewKey(me: { current: Schemas['Me'] }) {
    const api = fakeApi({
      'GET /api/v1/me': () => json(200, me.current),
      'GET /api/auth/organization/list': () =>
        json(
          200,
          me.current.user.id === ME.user.id ? [ME.organization, TEAM] : [GRACE.organization],
        ),
      'GET /api/auth/api-key/list': () =>
        json(
          200,
          me.current.user.id === ME.user.id
            ? { apiKeys: [ADA_KEY], total: 1 }
            : { apiKeys: [], total: 0 },
        ),
      'POST /api/auth/api-key/create': ({ body }) =>
        json(200, {
          ...ADA_KEY,
          id: '00000000-0000-7000-8000-0000000000a2',
          name: (body as { name: string }).name,
          key: SECRET,
        }),
    })
    renderApp('/api-keys')
    await screen.findByRole('cell', { name: 'hm_Ada…' })
    await userEvent.type(screen.getByLabelText('Name'), 'Ada agent')
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(document.body.innerHTML).toContain(SECRET)
    return api
  }

  const TEAM = { id: TEAM_ID, name: 'Acme', slug: 'acme', personal: false }

  const nothingOf = (text: string) => {
    expect(document.body.innerHTML).not.toContain(text)
    for (const field of document.querySelectorAll('input')) expect(field.value).not.toContain(text)
  }

  it("does not show the previous account's keys or secret under another account", async () => {
    const me = { current: ME }
    await adaLookingAtANewKey(me)

    // Ada signed out in another tab and Grace signed in; back here:
    me.current = GRACE
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByText('You have no API keys yet.')).toBeDefined()
    expect(screen.getByText(GRACE.user.email)).toBeDefined()
    nothingOf(SECRET)
    nothingOf('hm_Ada')
    nothingOf(ME.user.email)
    expect(screen.queryByRole('region', { name: /Copy your new key/ })).toBeNull()
  })

  it('starts the keys page over in the new organization', async () => {
    const me = { current: ME }
    const api = await adaLookingAtANewKey(me)
    const lists = api.to('GET /api/auth/api-key/list').length

    me.current = { ...ME, organization: TEAM }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() =>
      expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
        'The key will act in Acme.',
      ),
    )
    nothingOf(SECRET)
    expect(screen.queryByRole('region', { name: /Copy your new key/ })).toBeNull()
    await vi.waitFor(() =>
      expect(api.to('GET /api/auth/api-key/list').length).toBeGreaterThan(lists),
    )
  })
})
