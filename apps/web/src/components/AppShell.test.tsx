import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy, type ReactNode, Suspense } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { admin } from '../i18n/admin.ts'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { registerCatalog } from '../i18n/translate.ts'
import { fakeApi, json } from '../test/fake-api.tsx'
import { UnsavedChangesProvider } from '../unsaved-changes.tsx'
import { AppShell } from './AppShell.tsx'

registerCatalog(admin)

const session = vi.hoisted(() => ({
  me: {
    user: { id: 'shell-user', name: 'Ada', email: 'shell@example.com' },
    personalOrganizationId: 'personal-space' as string | null,
    organization: { id: 'personal-space', name: 'Ada', slug: 'ada', personal: true },
    principal: { kind: 'session', apiKeyId: null },
  },
  accept: vi.fn(),
}))

vi.mock('../session.tsx', () => ({
  useMe: () => session.me,
  useSession: () => ({
    accept: session.accept,
    beginContextSwitch: () => vi.fn(),
    signOut: vi.fn(),
    notice: null,
    setNotice: vi.fn(),
  }),
}))

beforeEach(() => {
  session.me.organization = { id: 'personal-space', name: 'Ada', slug: 'ada', personal: true }
  session.me.personalOrganizationId = 'personal-space'
  session.me.principal.kind = 'session'
  session.accept.mockClear()
  fakeApi({})
})

function ShellProviders({ children }: { children: ReactNode }) {
  return (
    <InterfaceScope surface="admin">
      <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
    </InterfaceScope>
  )
}

function shell(path = '/app/event-types') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<h1>Page content</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
    { wrapper: ShellProviders },
  )
}

describe('admin shell layout', () => {
  it('offers space switching only to browser sessions', () => {
    session.me.principal.kind = 'api_key'
    const api = fakeApi({})
    shell()
    expect(screen.queryByRole('button', { name: /^Switch space/ })).toBeNull()
    expect(api.to('GET /api/auth/organization/list')).toHaveLength(0)
    expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(0)
  })

  it('keeps navigation and the header mounted while a route chunk suspends', () => {
    const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}))
    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <Suspense fallback={<p>Outer loading</p>}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={<Pending />} />
            </Route>
          </Routes>
        </Suspense>
      </MemoryRouter>,
      { wrapper: ShellProviders },
    )
    expect(screen.queryByRole('banner')).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeNull()
    expect(screen.getByRole('main').querySelector('.page-skeleton')).not.toBeNull()
    expect(screen.queryByText('Outer loading')).toBeNull()
  })

  it.each(['en', 'zh-CN'] as const)('groups the compact topbar controls in %s', (language) => {
    chooseLanguage(language)
    shell()
    const header = screen.getByRole('banner')
    expect(header.className).toBe('topbar')
    const inner = header.firstElementChild
    expect(inner?.className).toBe('topbar-inner')
    expect(inner?.children[0]?.className).toBe('brand')
    expect(inner?.children[1]?.className).toBe('account')
    const select = within(header).getByRole('combobox')
    expect(select.closest('label')?.classList.contains('language-picker-compact')).toBe(true)
    expect(select.getAttribute('aria-label')).toBe(
      language === 'en' ? 'Interface language' : '界面语言',
    )
    expect(
      within(header)
        .getByRole('button', { name: language === 'en' ? 'Sign out' : '退出登录' })
        .classList.contains('button-small'),
    ).toBe(true)
  })

  it.each([
    ['/app/event-types', 'main-content-wide'],
    ['/app/availability', 'main-content-wide'],
    ['/app/bookings', 'main-content-wide'],
    ['/app/analytics', 'main-content-wide'],
    ['/app/conferences', 'main-content-wide'],
    ['/app/calendars', 'main-content-wide'],
    ['/app/api-keys', 'main-content-wide'],
    ['/app/connected-apps', 'main-content-wide'],
    ['/app/settings', 'main-content'],
    ['/app/event-types/new', 'main-content'],
    ['/app/event-types/example', 'main-content'],
    ['/app/availability/example', 'main-content'],
    ['/app/bookings/example', 'main-content'],
  ])('applies the content width for %s', (path, className) => {
    shell(path)
    expect(screen.getByRole('main').className).toBe(className)
  })

  it('shows fades only where more navigation is hidden and updates on resize', () => {
    let width = 200
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('nav ul') ? width : 0
    })
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('nav ul') ? 1000 : 0
    })
    const { unmount } = shell()
    const nav = screen.getByRole('navigation')
    const list = within(nav).getByRole('list')
    expect(list.getAttribute('data-layout-scroll')).toBe('horizontal')
    expect(nav.dataset.scrollStart).toBe('true')
    expect(nav.dataset.scrollEnd).toBe('false')
    list.scrollLeft = 400
    fireEvent.scroll(list)
    expect(nav.dataset.scrollStart).toBe('false')
    expect(nav.dataset.scrollEnd).toBe('false')
    list.scrollLeft = 800
    fireEvent.scroll(list)
    expect(nav.dataset.scrollEnd).toBe('true')
    list.scrollLeft = 0
    width = 1000
    fireEvent(window, new Event('resize'))
    expect(nav.dataset.scrollStart).toBe('true')
    expect(nav.dataset.scrollEnd).toBe('true')
    unmount()
    fireEvent(window, new Event('resize'))
  })

  it('keeps the active item visible when translated navigation changes its width', () => {
    let translated = false
    const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('nav ul')) return rect(0, 200)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return translated ? rect(240 - offset, 340 - offset) : rect(10, 80)
      }
      return rect(0, 0)
    })
    shell()
    const list = within(screen.getByRole('navigation')).getByRole('list')
    expect(list.scrollLeft).toBe(0)
    translated = true
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } })
    expect(list.scrollLeft).toBe(140)
  })

  it('reveals the current item when the sidebar becomes a horizontal strip', () => {
    let width = 1000
    const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('nav ul') ? width : 0
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('nav ul')) return rect(0, width)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return rect(900 - offset, 1000 - offset)
      }
      return rect(0, 0)
    })
    shell('/app/settings')
    const list = within(screen.getByRole('navigation')).getByRole('list')
    expect(list.scrollLeft).toBe(0)
    width = 200
    fireEvent(window, new Event('resize'))
    expect(list.scrollLeft).toBe(800)
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps the selected link clear of the scroll fade inset', () => {
    const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('nav ul')) return rect(0, 200)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return rect(150 - offset, 220 - offset)
      }
      return rect(0, 0)
    })
    shell('/app/settings')
    const list = within(screen.getByRole('navigation')).getByRole('list')
    expect(list.scrollLeft).toBe(20)
    list.style.scrollPaddingInlineStart = '24px'
    list.style.scrollPaddingInlineEnd = '24px'
    fireEvent(window, new Event('resize'))
    expect(list.scrollLeft).toBe(44)
  })
})

describe('the space selector in the admin frame', () => {
  const TEAM = {
    id: 'team-space',
    name: 'A very long team name that must remain available to every reader',
    slug: 'long-team',
    logo: null,
    createdAt: '2026-10-01T09:00:00.000Z',
  }

  it.each([
    ['en', false, 'Personal'],
    ['en', true, 'Personal'],
    ['zh-CN', false, '个人空间'],
    ['zh-CN', true, '个人空间'],
  ] as const)(
    'deduplicates Personal from the server marker on a cold %s start (personal: %s)',
    async (language, personal, label) => {
      chooseLanguage(language)
      const storedPersonal = {
        id: 'personal-space',
        name: 'Renamed private workspace',
        slug: 'renamed-workspace',
      }
      const sameNameTeam = { id: 'second-team', name: session.me.user.name, slug: 'ada-team' }
      session.me.organization = personal
        ? { ...storedPersonal, personal: true }
        : { ...TEAM, personal: false }
      fakeApi({
        'GET /api/auth/organization/list': () => json(200, [storedPersonal, TEAM, sameNameTeam]),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, {
            organizationId: TEAM.id,
            userId: session.me.user.id,
            role: 'member',
          }),
      })
      shell()
      await userEvent.click(screen.getByRole('button', { name: /^(Switch space|切换空间)/ }))
      const menu = screen.getByRole('menu')
      await within(menu).findByRole('menuitemradio', { name: new RegExp(TEAM.name) })
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3)
      const personalOption = within(menu).getAllByRole('menuitemradio', {
        name: new RegExp(`^${label}`),
      })
      expect(personalOption).toHaveLength(1)
      expect(personalOption[0]?.getAttribute('aria-checked')).toBe(String(personal))
      expect(within(menu).queryByText(storedPersonal.name)).toBeNull()
      expect(within(menu).getByRole('menuitemradio', { name: sameNameTeam.name })).toBeDefined()
    },
  )

  it('keeps Personal and team choices usable when the personal marker is null', async () => {
    session.me.personalOrganizationId = null
    session.me.organization = { ...TEAM, personal: false }
    fakeApi({ 'GET /api/auth/organization/list': () => json(200, [TEAM]) })
    shell()
    await userEvent.click(screen.getByRole('button', { name: /^Switch space/ }))
    const menu = screen.getByRole('menu')
    await within(menu).findByRole('menuitemradio', { name: new RegExp(TEAM.name) })
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
    expect(within(menu).getByRole('menuitemradio', { name: 'Personal' })).toBeDefined()
  })

  it.each([
    ['owner', 'Owner'],
    ['admin', 'Admin'],
    ['member', 'Member'],
  ])('shows the current team and its %s role in words', async (role, label) => {
    session.me.organization = { ...TEAM, personal: false }
    fakeApi({
      'GET /api/auth/organization/list': () => json(200, [TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          organizationId: TEAM.id,
          userId: session.me.user.id,
          role,
        }),
    })
    shell()
    const trigger = screen.getByRole('button', { name: /^Switch space/ })
    expect(trigger.textContent).toContain(TEAM.name)
    expect(await within(trigger).findByText(label)).toBeDefined()
    await userEvent.click(trigger)
    const selected = screen.getByRole('menuitemradio', { name: new RegExp(TEAM.name) })
    expect(selected.getAttribute('aria-checked')).toBe('true')
    expect(selected.querySelector(`[title="${TEAM.name}"]`)).not.toBeNull()
  })

  it.each([
    ['another organization', 'another-team', 'shell-user'],
    ['another user', TEAM.id, 'another-user'],
  ])('does not borrow the owner role from %s', async (_, organizationId, userId) => {
    session.me.organization = { ...TEAM, personal: false }
    fakeApi({
      'GET /api/auth/organization/list': () => json(200, [TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId, userId, role: 'owner' }),
    })
    shell()
    const trigger = screen.getByRole('button', { name: /^Switch space/ })
    expect(await within(trigger).findByText('Role unavailable')).toBeDefined()
    expect(within(trigger).queryByText('Owner')).toBeNull()
  })

  it.each([
    ['superowner', 'Role unavailable'],
    ['ownerish,member', 'Role unavailable'],
    ['member,admin', 'Member, Admin'],
    ['admin,owner', 'Admin, Owner'],
  ])('interprets %s as exact role words', async (role, label) => {
    session.me.organization = { ...TEAM, personal: false }
    fakeApi({
      'GET /api/auth/organization/list': () => json(200, [TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM.id, userId: session.me.user.id, role }),
    })
    shell()
    const trigger = screen.getByRole('button', { name: /^Switch space/ })
    expect(await within(trigger).findByText(label)).toBeDefined()
  })

  it('refreshes a changed role when the space menu reopens', async () => {
    session.me.organization = { ...TEAM, personal: false }
    let role = 'admin'
    fakeApi({
      'GET /api/auth/organization/list': () => json(200, [TEAM]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM.id, userId: session.me.user.id, role }),
    })
    shell()
    const trigger = screen.getByRole('button', { name: /^Switch space/ })
    expect(await within(trigger).findByText('Admin')).toBeDefined()
    role = 'member'
    await userEvent.click(trigger)
    expect(await within(trigger).findByText('Member')).toBeDefined()
    expect(within(trigger).queryByText('Admin')).toBeNull()
  })

  it('supports keyboard opening, menu navigation and Escape returning focus to the trigger', async () => {
    fakeApi({ 'GET /api/auth/organization/list': () => json(200, [TEAM]) })
    shell()
    const trigger = screen.getByRole('button', { name: /^Switch space/ })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    const menu = screen.getByRole('menu', { name: 'Spaces' })
    const options = within(menu).getAllByRole('menuitemradio')
    expect(options).toHaveLength(2)
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(options[0])
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(options[1])
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(options[0])
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(options[1])
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    ['en', 'Switch space', 'Spaces', 'Personal', 'Owner'],
    ['zh-CN', '切换空间', '空间', '个人空间', '所有者'],
  ] as const)('translates the selector in %s', async (language, label, menu, personal, owner) => {
    chooseLanguage(language)
    shell()
    const trigger = screen.getByRole('button', { name: new RegExp(`^${label}`) })
    expect(trigger.textContent).toContain(personal)
    expect(await within(trigger).findByText(owner)).toBeDefined()
    expect(
      screen.getByRole('button', { name: new RegExp(`^${label}.*${personal}.*${owner}`) }),
    ).toBe(trigger)
    await userEvent.click(trigger)
    const choices = within(screen.getByRole('menu', { name: menu })).getAllByRole('menuitemradio')
    expect(choices[0]?.textContent).toContain(personal)
    expect(choices[0]?.getAttribute('aria-checked')).toBe('true')
  })
})
