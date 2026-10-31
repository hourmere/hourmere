import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from './api/client.ts'
import { chooseLanguage } from './i18n/store.ts'
import { SessionProvider, useSession } from './session.tsx'
import {
  emptyAccount,
  emptyTeamLists,
  fakeApi,
  instance,
  json,
  later,
  ME,
  organizations,
  profile,
  renderApp,
  signedIn,
  signedOut,
} from './test/fake-api.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const location = () => screen.getByTestId('location').textContent
const EXPIRED = 'Your session ended. Please sign in again.'
const TEAM_ID = '00000000-0000-7000-8000-0000000000c3'

describe('the session gate', () => {
  it('sends visitors who are not signed in to sign-in, remembering the page', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/app/api-keys?tab=new')
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fapi-keys%3Ftab%3Dnew')
    // A first visit, not a session that ended.
    expect(screen.queryByText(EXPIRED)).toBeNull()
  })

  it('does not remember the start page', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/')
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe('/sign-in')
  })

  it('does not remember the default page either', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/app')
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe('/sign-in')
  })

  it('shows signed-in people the app with its navigation', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/event-types')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Event types',
      'Availability',
      'Bookings',
      'Booking activity',
      'Conference accounts',
      'Calendars',
      'API keys',
      'Connected apps',
      'Settings',
    ])
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '/app/event-types',
      '/app/availability',
      '/app/bookings',
      '/app/analytics',
      '/app/conferences',
      '/app/calendars',
      '/app/api-keys',
      '/app/connected-apps',
      '/app/settings',
    ])
    expect(screen.getByRole('link', { name: 'Event types' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByText(ME.user.email)).toBeDefined()
  })

  it('starts keyboard navigation at the skip link on the first page', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/app/event-types')
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to content' }))
  })

  it.each([
    ['beyond the right edge', 350, 450, 150],
    ['beyond the left edge', 50, 150, -50],
    ['already visible', 150, 250, 0],
  ])('keeps the active navigation link visible when it is %s', async (_, start, end, expected) => {
    // Simulate a narrow, horizontally scrolling list. Rectangles move as it scrolls,
    // so repeated effects cannot move a link which is already visible.
    const rect = (left: number, right: number) => ({
      left,
      right,
      top: 10,
      bottom: 50,
      width: right - left,
      height: 40,
      x: left,
      y: 10,
      toJSON: () => ({}),
    })
    const original = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('nav ul')) return rect(100, 300)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return rect(start - offset, end - offset)
      }
      return original.call(this)
    })
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('nav ul') ? 200 : 0
    })
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/app/event-types')
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    const list = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('list')
    // The heading can appear before AppShell's passive navigation effect runs.
    await waitFor(() => expect(list.scrollLeft).toBe(expected))
    expect(document.activeElement).toBe(document.body)
  })

  it('moves between pages with the navigation', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/app/event-types')
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/settings')
    await waitFor(() => expect(document.activeElement?.id).toBe('main'))
  })

  it('offers a retry when the server cannot be reached', async () => {
    let up = false
    fakeApi({
      ...profile(),
      'GET /api/v1/me': () => {
        if (!up) throw new TypeError('Failed to fetch')
        return json(200, ME)
      },
      ...profile(),
    })
    renderApp('/app/settings')
    expect((await screen.findByRole('alert')).textContent).toMatch(/can't reach hourmere/i)
    up = true
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
  })

  it('goes to sign-in, without a page to return to, after signing out', async () => {
    const api = fakeApi({
      ...signedIn,
      ...instance(),
      ...profile(),
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    renderApp('/app/settings')
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
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await userEvent.type(screen.getByLabelText('Name'), 'Agent')
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to Hourmere' })).toBeDefined()
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fapi-keys')
    expect(screen.getByText(EXPIRED).getAttribute('role')).toBe('status')
  })

  it('checks the session again when the window regains focus', async () => {
    let me: Schemas['Me'] = ME
    const api = fakeApi({
      ...emptyTeamLists,
      ...profile(),
      'GET /api/v1/me': () => json(200, me),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM_ID, userId: ME.user.id, role: 'owner' }),
      ...instance(),
      ...profile(),
    })
    renderApp('/app/settings')
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
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fsettings')
    expect(screen.getByText(EXPIRED)).toBeDefined()
    expect(api.to('GET /api/v1/me').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the page when a background check cannot reach the server', async () => {
    let up = true
    fakeApi({
      ...profile(),
      'GET /api/v1/me': () => {
        if (!up) throw new TypeError('Failed to fetch')
        return json(200, ME)
      },
      ...profile(),
    })
    renderApp('/app/settings')
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
      ...profile(),
      'GET /api/v1/me': () => {
        if (!pending) return json(200, ME)
        // The server answers this check only after the sign-out has gone through.
        return new Promise<Response>((resolve) => {
          answer = resolve
        })
      },
      ...instance(),
      ...profile(),
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    renderApp('/app/settings')
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
      ...profile(),
      'GET /api/v1/me': () =>
        signedInElsewhere ? json(200, ME) : json(401, { error: 'unauthorized' }),
      ...instance(),
      ...emptyAccount,
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

const TEAM_ME = {
  ...ME,
  organization: { ...ME.organization, id: TEAM_ID, name: 'Acme', personal: false },
}

function Consumer({ dirty = false }: { dirty?: boolean }) {
  const { state, reload, confirmReload, refresh, accept, signOut } = useSession()
  useUnsavedChanges(dirty)
  return (
    <>
      <output data-testid="session-context">
        {state.status === 'signed-in' ? state.me.organization.id : state.status}
      </output>
      <button type="button" onClick={() => void refresh()}>
        Refresh session
      </button>
      <button type="button" onClick={() => void refresh({ fresh: true })}>
        Refresh fresh session
      </button>
      <button type="button" onClick={() => accept(TEAM_ME)}>
        Accept confirmed team
      </button>
      <button type="button" onClick={() => accept(ME)}>
        Accept original team
      </button>
      <button type="button" onClick={reload}>
        Reload session
      </button>
      <button type="button" onClick={confirmReload}>
        Confirm reload
      </button>
      <button type="button" onClick={() => void signOut().catch(() => {})}>
        End session
      </button>
    </>
  )
}

describe('fresh session reads and confirmed organization handoffs', () => {
  async function open(dirty = false) {
    const view = render(
      <SessionProvider>
        <Consumer dirty={dirty} />
      </SessionProvider>,
    )
    await screen.findByText(ME.organization.id)
    return view
  }

  it.each(['focus', 'visibilitychange'] as const)(
    'follows a declined team silently on %s once the draft is clean',
    async (event) => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      let active = ME
      const api = fakeApi({
        ...signedIn,
        'GET /api/v1/me': () => json(200, active),
      })
      const view = await open(true)
      active = TEAM_ME
      const read = () =>
        act(async () => (event === 'focus' ? window : document).dispatchEvent(new Event(event)))
      await read()
      await read()
      expect(api.to('GET /api/v1/me')).toHaveLength(3)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('session-context').textContent).toBe(ME.organization.id)

      view.rerender(
        <SessionProvider>
          <Consumer dirty={false} />
        </SessionProvider>,
      )
      await read()
      expect(api.to('GET /api/v1/me')).toHaveLength(4)
      expect(screen.getByTestId('session-context').textContent).toBe(TEAM_ID)
      expect(confirm).toHaveBeenCalledTimes(1)
    },
  )

  it('forgets a declined Reload when a pending session read finds the draft clean', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const pending = later()
    let reads = 0
    fakeApi({
      ...signedIn,
      'GET /api/v1/me': () => (++reads === 1 ? json(200, ME) : pending.response),
    })
    const view = await open(true)
    await userEvent.click(screen.getByRole('button', { name: 'Confirm reload' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(reads).toBe(2))
    view.rerender(
      <SessionProvider>
        <Consumer dirty={false} />
      </SessionProvider>,
    )
    await pending.answer(json(200, TEAM_ME))
    expect(screen.getByTestId('session-context').textContent).toBe(TEAM_ID)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it.each(['Reload session', 'Accept original team', 'End session'])(
    'clears a declined context on %s',
    async (action) => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      let active = ME
      let unavailable = false
      fakeApi({
        ...signedIn,
        'GET /api/v1/me': () =>
          unavailable ? json(503, { error: 'unavailable' }) : json(200, active),
        // Even a failed sign-out invalidates old session reads and refusals.
        'POST /api/auth/sign-out': () => json(503, { code: 'UNAVAILABLE' }),
      })
      await open(true)
      active = TEAM_ME
      await act(async () => window.dispatchEvent(new Event('focus')))
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('session-context').textContent).toBe(ME.organization.id)
      unavailable = action === 'Reload session'
      await userEvent.click(screen.getByRole('button', { name: action }))
      if (unavailable) await screen.findByText('error')
      unavailable = false
      // Return to the original context after a failed reload without hiding a stale
      // refusal behind an intermediate /me result.
      if (action === 'Reload session') {
        active = ME
        await userEvent.click(screen.getByRole('button', { name: 'Reload session' }))
        await screen.findByText(ME.organization.id)
        active = TEAM_ME
      }
      await act(async () => window.dispatchEvent(new Event('focus')))
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('session-context').textContent).toBe(ME.organization.id)
    },
  )

  it('coalesces with the fresh read after a superseded background read finishes', async () => {
    const background = later()
    const fresh = later()
    let reads = 0
    fakeApi({
      ...signedIn,
      'GET /api/v1/me': () =>
        ++reads === 1 ? json(200, ME) : reads === 2 ? background.response : fresh.response,
    })
    await open()
    act(() => screen.getByRole('button', { name: 'Refresh session' }).click())
    await waitFor(() => expect(reads).toBe(2))
    act(() => screen.getByRole('button', { name: 'Refresh fresh session' }).click())
    await waitFor(() => expect(reads).toBe(3))
    await background.answer(json(200, TEAM_ME))
    expect(screen.getByTestId('session-context').textContent).toBe(ME.organization.id)

    // Settling the cancelled request must not remove the newer in-flight check.
    await userEvent.click(screen.getByRole('button', { name: 'Refresh session' }))
    expect(reads).toBe(3)
    await fresh.answer(json(200, TEAM_ME))
    expect(screen.getByTestId('session-context').textContent).toBe(TEAM_ID)
  })

  it('keeps a confirmed handoff when an earlier fresh read answers, then permits a new check', async () => {
    const fresh = later()
    let reads = 0
    fakeApi({
      ...signedIn,
      'GET /api/v1/me': () => (++reads === 2 ? fresh.response : json(200, ME)),
    })
    await open()
    act(() => screen.getByRole('button', { name: 'Refresh fresh session' }).click())
    await waitFor(() => expect(reads).toBe(2))
    act(() => screen.getByRole('button', { name: 'Accept confirmed team' }).click())
    expect(screen.getByTestId('session-context').textContent).toBe(TEAM_ID)
    await fresh.answer(json(200, ME))
    expect(screen.getByTestId('session-context').textContent).toBe(TEAM_ID)

    await userEvent.click(screen.getByRole('button', { name: 'Refresh session' }))
    await waitFor(() => expect(reads).toBe(3))
    await waitFor(() =>
      expect(screen.getByTestId('session-context').textContent).toBe(ME.organization.id),
    )
  })
})

describe('when the account or organization changes elsewhere', () => {
  const SECRET = 'hm_AdasSecretShownOnlyOnce0123456789abcdefghijklmnopqrstuvwxyzABCDEF'
  const GRACE: Schemas['Me'] = {
    user: { id: '00000000-0000-7000-8000-0000000000d1', name: 'Grace', email: 'grace@example.com' },
    personalOrganizationId: '00000000-0000-7000-8000-0000000000d2',
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
      ...profile(),
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
    renderApp('/app/api-keys')
    await screen.findByRole('cell', { name: 'hm_Ada…' })
    await userEvent.type(screen.getByLabelText('Name'), 'Ada agent')
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(document.body.innerHTML).toContain(SECRET)
    return api
  }

  const TEAM = { id: TEAM_ID, name: 'Acme', slug: 'acme', personal: false }
  const TEAM_ME = { ...ME, organization: TEAM }

  async function chooseSpace(name: string) {
    await userEvent.click(screen.getByRole('button', { name: /^Switch space/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(name) }))
  }

  function switchableKeys({
    start = ME,
    personal = ME,
    switchResponse,
    confirmedMe,
  }: {
    start?: Schemas['Me']
    personal?: Schemas['Me']
    switchResponse?: () => Response | Promise<Response>
    confirmedMe?: Schemas['Me']
  } = {}) {
    const active = { current: start }
    const api = fakeApi({
      ...emptyTeamLists,
      ...profile(),
      'GET /api/v1/me': () => json(200, active.current),
      'GET /api/auth/organization/list': () => json(200, [personal.organization, TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          organizationId: active.current.organization.id,
          userId: active.current.user.id,
          role: 'member',
        }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/organization/set-active': ({ body }) => {
        if (switchResponse) return switchResponse()
        active.current =
          confirmedMe ??
          ((body as { organizationId: string | null }).organizationId === null ? personal : TEAM_ME)
        return json(200, active.current.organization.personal ? null : TEAM)
      },
    })
    return { api, active }
  }

  const nothingOf = (text: string) => {
    expect(document.body.innerHTML).not.toContain(text)
    for (const field of document.querySelectorAll('input')) expect(field.value).not.toContain(text)
  }

  it('keeps a single Personal entry after switching from a team and back', async () => {
    const personal = {
      ...ME,
      organization: { ...ME.organization, name: 'Renamed private workspace' },
    }
    const { api } = switchableKeys({ start: TEAM_ME, personal })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')

    async function expectChoices(inPersonal: boolean) {
      const trigger = screen.getByRole('button', { name: /^Switch space/ })
      await userEvent.click(trigger)
      const menu = screen.getByRole('menu')
      await within(menu).findByRole('menuitemradio', { name: /^Acme/ })
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
      const choices = within(menu).getAllByRole('menuitemradio', { name: /^Personal/ })
      expect(choices).toHaveLength(1)
      expect(choices[0]?.getAttribute('aria-checked')).toBe(String(inPersonal))
      expect(within(menu).queryByText(personal.organization.name)).toBeNull()
      await userEvent.keyboard('{Escape}')
    }

    await expectChoices(false)
    await chooseSpace('Personal')
    await screen.findByRole('button', { name: /^Switch space Personal/ })
    await expectChoices(true)
    await chooseSpace('Acme')
    await screen.findByRole('button', { name: /^Switch space Acme/ })
    await expectChoices(false)
    expect(api.to('POST /api/auth/organization/set-active').map((call) => call.body)).toEqual([
      { organizationId: null },
      { organizationId: TEAM_ID },
    ])
  })

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

  it('remounts the page when deliberately switching personal → team → personal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { api } = switchableKeys()
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const personalInput = screen.getByLabelText('Name')
    await userEvent.type(personalInput, 'Personal draft')

    await chooseSpace('Acme')
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
        'The key will act in Acme.',
      ),
    )
    expect(personalInput.isConnected).toBe(false)
    const teamInput = screen.getByLabelText<HTMLInputElement>('Name')
    expect(teamInput.value).toBe('')
    await userEvent.type(teamInput, 'Team draft')

    await chooseSpace('Personal')
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
        'The key will act in Ada, your personal organization.',
      ),
    )
    expect(teamInput.isConnected).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('')
    expect(api.to('POST /api/auth/organization/set-active').map((call) => call.body)).toEqual([
      { organizationId: TEAM_ID },
      { organizationId: null },
    ])
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(3)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('sends no switch request when the unsaved-changes confirmation is cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { api } = switchableKeys()
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await userEvent.type(screen.getByLabelText('Name'), 'Keep my draft')
    await chooseSpace('Acme')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Keep my draft')
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Personal')
    expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
      'The key will act in Ada, your personal organization.',
    )
  })

  it('switches by keyboard and returns focus to the remounted trigger', async () => {
    const { api } = switchableKeys()
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const trigger = screen.getByRole('button', { name: /^Switch space/ })
    trigger.focus()
    await userEvent.keyboard('{Enter}{ArrowDown}{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Acme'),
    )
    expect(trigger.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Switch space/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(api.to('POST /api/auth/organization/set-active').map((call) => call.body)).toEqual([
      { organizationId: TEAM_ID },
    ])
  })

  it.each([
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a rejected request', () => json(400, { code: 'BAD_REQUEST' })],
    ['a removed membership', () => json(403, { code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' })],
  ])('keeps the original space and usable draft after %s', async (_, switchResponse) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { api } = switchableKeys({ switchResponse })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const input = screen.getByLabelText<HTMLInputElement>('Name')
    await userEvent.type(input, 'Draft')
    await chooseSpace('Acme')
    expect(input.isConnected).toBe(true)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not switch spaces. You are still in Personal. Please try again.',
    )
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Personal')
    expect(input.isConnected).toBe(true)
    await userEvent.type(input, ' still usable')
    expect(input.value).toBe('Draft still usable')
    expect(screen.getByRole('button', { name: 'Create key' }).hasAttribute('disabled')).toBe(false)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    expect(api.to('GET /api/v1/me')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /^Switch space/ }))
    expect(
      screen.getByRole('menuitemradio', { name: /Personal/ }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: /Acme/ }).getAttribute('aria-checked')).toBe(
      'false',
    )
  })

  it('translates a failed switch while keeping the original space in Chinese', async () => {
    chooseLanguage('zh-CN')
    switchableKeys({ switchResponse: () => json(403, { code: 'FORBIDDEN' }) })
    renderApp('/app/api-keys')
    await userEvent.click(await screen.findByRole('button', { name: /^切换空间/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Acme/ }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      '无法切换空间。你仍位于个人空间。请重试。',
    )
    expect(screen.getByRole('button', { name: /^切换空间/ }).textContent).toContain('个人空间')
  })

  it('discards old session and page reads after a deliberate space switch', async () => {
    const oldMe = later()
    const oldKeys = later()
    let active = ME
    let meReads = 0
    let keyReads = 0
    const api = fakeApi({
      ...profile(),
      'GET /api/v1/me': () => (++meReads === 2 ? oldMe.response : json(200, active)),
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM_ID, userId: ME.user.id, role: 'admin' }),
      'GET /api/auth/api-key/list': () =>
        ++keyReads === 1 ? oldKeys.response : json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/organization/set-active': () => {
        active = TEAM_ME
        return json(200, TEAM)
      },
    })
    renderApp('/app/api-keys')
    await screen.findByRole('region', { name: 'Create a key' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(meReads).toBe(2))
    await chooseSpace('Acme')
    await screen.findByText('You have no API keys yet.')
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
        'The key will act in Acme.',
      ),
    )
    await oldMe.answer(json(200, ME))
    await oldKeys.answer(
      json(200, { apiKeys: [{ ...ADA_KEY, name: 'Old personal key' }], total: 1 }),
    )
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Acme')
    expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
      'The key will act in Acme.',
    )
    expect(screen.queryByText('Old personal key')).toBeNull()
    expect(screen.queryByRole('cell', { name: 'hm_Ada…' })).toBeNull()
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(2)
  })

  it.each(['dismissal', 'navigation', 'a successful switch'])(
    'clears a failed-switch banner after %s',
    async (action) => {
      let fail = true
      const { active } = switchableKeys({
        switchResponse: () => {
          if (fail) return json(403, { code: 'FORBIDDEN' })
          active.current = TEAM_ME
          return json(200, TEAM)
        },
      })
      renderApp('/app/api-keys')
      await screen.findByText('You have no API keys yet.')
      await chooseSpace('Acme')
      await screen.findByRole('alert')
      if (action === 'dismissal') {
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      } else if (action === 'navigation') {
        await userEvent.click(screen.getByRole('link', { name: 'Settings' }))
        await screen.findByRole('heading', { name: 'Settings', level: 1 })
      } else {
        fail = false
        await chooseSpace('Acme')
        await waitFor(() =>
          expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain(
            'Acme',
          ),
        )
      }
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it('defers background refresh while a deliberate switch is awaiting confirmation', async () => {
    const confirmation = later()
    let meReads = 0
    fakeApi({
      ...profile(),
      'GET /api/v1/me': () => (++meReads === 1 ? json(200, ME) : confirmation.response),
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM.id, userId: ME.user.id, role: 'member' }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/organization/set-active': () => json(200, TEAM),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await chooseSpace('Acme')
    await waitFor(() => expect(meReads).toBe(2))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(meReads).toBe(2)
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Personal')
    await confirmation.answer(json(200, TEAM_ME))
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Acme')
    expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
      'The key will act in Acme.',
    )
  })

  it.each([
    ['with request cancellation', true],
    ['when request cancellation is unavailable', false],
  ])('invalidates a refresh already in flight before switching %s', async (_, cancellable) => {
    const background = later()
    const confirmation = later()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValue(false)
    let meReads = 0
    const api = fakeApi({
      ...profile(),
      'GET /api/v1/me': () =>
        ++meReads === 1
          ? json(200, ME)
          : meReads === 2
            ? background.response
            : confirmation.response,
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM_ID, userId: ME.user.id, role: 'member' }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/organization/set-active': () => json(200, TEAM),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const input = screen.getByLabelText<HTMLInputElement>('Name')
    await userEvent.type(input, 'Original draft')
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(meReads).toBe(2))
    const refreshRequest = vi.mocked(fetch).mock.calls.findLast(([request]) => {
      return request instanceof Request && new URL(request.url).pathname === '/api/v1/me'
    })?.[0]
    if (!(refreshRequest instanceof Request)) throw new Error('Expected a background /me request')

    await userEvent.click(screen.getByRole('button', { name: /^Switch space/ }))
    const teamOption = await screen.findByRole('menuitemradio', { name: /Acme/ })
    // Exercise the epoch independently when a request adapter cannot cancel its read.
    if (!cancellable) vi.spyOn(AbortController.prototype, 'abort').mockImplementationOnce(() => {})
    await userEvent.click(teamOption)
    await waitFor(() => expect(meReads).toBe(3))
    expect(refreshRequest.signal.aborted).toBe(cancellable)

    // The server has switched, but only the deliberate confirmation may apply that answer.
    await background.answer(json(200, TEAM_ME))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('Original draft')
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Personal')
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(1)

    await confirmation.answer(json(200, TEAM_ME))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(input.isConnected).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('')
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Acme')
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(2)
  })

  it.each([
    ['an unavailable confirmation', () => json(503, { error: 'unavailable' })],
    ['a failed confirmation request', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['another target', () => json(200, ME)],
    ['another caller', () => json(200, { ...TEAM_ME, user: GRACE.user })],
  ])('reconciles a committed switch after %s without a focus event', async (_, answer) => {
    const reconciliation = later()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    let meReads = 0
    const api = fakeApi({
      ...profile(),
      'GET /api/v1/me': () =>
        ++meReads === 1 ? json(200, ME) : meReads === 2 ? answer() : reconciliation.response,
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM_ID, userId: ME.user.id, role: 'member' }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/organization/set-active': () => json(200, TEAM),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const input = screen.getByLabelText<HTMLInputElement>('Name')
    await userEvent.type(input, 'Original draft')
    await chooseSpace('Acme')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not confirm the switch. Checking your current space…',
    )
    await waitFor(() => expect(meReads).toBe(3))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(input.isConnected).toBe(true)
    await reconciliation.answer(json(200, TEAM_ME))
    await waitFor(() => expect(input.isConnected).toBe(false))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Acme')
    expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
      'The key will act in Acme.',
    )
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(2)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(1)
  })

  it('keeps the original draft when reconciliation is declined after a committed switch', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValue(false)
    let meReads = 0
    const api = fakeApi({
      ...profile(),
      'GET /api/v1/me': () => json(++meReads === 2 ? 503 : 200, meReads === 1 ? ME : TEAM_ME),
      'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM]),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/organization/set-active': () => json(200, TEAM),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const input = screen.getByLabelText<HTMLInputElement>('Name')
    await userEvent.type(input, 'Keep this draft')
    await chooseSpace('Acme')
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2))
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('Keep this draft')
    expect(screen.getByRole('button', { name: /^Switch space/ }).textContent).toContain('Personal')
    expect(screen.getByRole('alert').textContent).toContain('Could not confirm the switch.')

    await act(async () => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(meReads).toBe(4))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(input.isConnected).toBe(true)
    await userEvent.type(input, ' still usable')
    expect(input.value).toBe('Keep this draft still usable')
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(1)
  })

  it.each(['en', 'zh-CN'] as const)(
    'shows uncertainty if reconciliation fails and keeps explicit writes bound to the displayed space in %s',
    async (language) => {
      chooseLanguage(language)
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      let meReads = 0
      const api = fakeApi({
        ...profile(),
        'GET /api/v1/me': () =>
          ++meReads === 1 ? json(200, ME) : json(503, { error: 'unavailable' }),
        'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM]),
        'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
        'POST /api/auth/organization/set-active': () => json(200, TEAM),
        'POST /api/auth/api-key/create': () => json(400, { code: 'BAD_REQUEST' }),
      })
      renderApp('/app/api-keys')
      const name = language === 'en' ? 'Name' : '名称'
      const trigger = new RegExp(language === 'en' ? '^Switch space' : '^切换空间')
      const input = await screen.findByLabelText<HTMLInputElement>(name)
      await userEvent.type(input, 'Personal draft')
      await userEvent.click(screen.getByRole('button', { name: trigger }))
      await userEvent.click(await screen.findByRole('menuitemradio', { name: /Acme/ }))
      const uncertainty =
        language === 'en'
          ? 'Could not confirm the switch. Checking your current space…'
          : '无法确认切换结果。正在检查你当前所在的空间…'
      expect((await screen.findByRole('alert')).textContent).toBe(uncertainty)
      await waitFor(() => expect(meReads).toBe(3))
      expect(input.isConnected).toBe(true)
      expect(input.value).toBe('Personal draft')
      expect(screen.getByRole('button', { name: trigger }).textContent).toContain(
        language === 'en' ? 'Personal' : '个人空间',
      )
      expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(1)
      await userEvent.click(
        screen.getByRole('button', {
          name: language === 'en' ? 'Create key' : '创建密钥',
        }),
      )
      await waitFor(() => expect(api.to('POST /api/auth/api-key/create')).toHaveLength(1))
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toMatchObject({
        metadata: { organizationId: ME.organization.id },
      })
      expect(screen.getByText(uncertainty)).toBeDefined()
      expect(input.isConnected).toBe(true)
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'explains a team-to-personal fallback in %s and clears it on a deliberate team switch',
    async (language) => {
      chooseLanguage(language)
      const { active } = switchableKeys({ start: TEAM_ME })
      renderApp('/app/api-keys')
      const triggerName = language === 'en' ? 'Switch space' : '切换空间'
      const notice =
        language === 'en'
          ? 'You are now in your personal space. Your team access or active space changed.'
          : '你现在位于个人空间。你的团队访问权限或当前空间已更改。'
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: new RegExp(`^${triggerName}`) }).textContent,
        ).toContain('Acme'),
      )
      active.current = ME
      act(() => window.dispatchEvent(new Event('focus')))
      expect((await screen.findByText(notice)).getAttribute('role')).toBe('status')
      expect(
        screen.getByRole('button', { name: new RegExp(`^${triggerName}`) }).textContent,
      ).toContain(language === 'en' ? 'Personal' : '个人空间')
      act(() => window.dispatchEvent(new Event('focus')))
      await screen.findByText(notice)
      await userEvent.click(
        screen.getByRole('link', { name: language === 'en' ? 'Settings' : '设置' }),
      )
      await screen.findByRole('heading', {
        name: language === 'en' ? 'Settings' : '设置',
        level: 1,
      })
      expect(screen.getByText(notice)).toBeDefined()
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${triggerName}`) }))
      await userEvent.click(await screen.findByRole('menuitemradio', { name: /Acme/ }))
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: new RegExp(`^${triggerName}`) }).textContent,
        ).toContain('Acme'),
      )
      expect(screen.queryByText(notice)).toBeNull()
    },
  )
})
