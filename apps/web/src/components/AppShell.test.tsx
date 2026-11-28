import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy, type ReactNode, Suspense } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { admin } from '../i18n/catalogues/zh-CN/admin.ts'
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

function primaryList() {
  const nav = screen.getByRole('navigation')
  const list = nav.querySelector<HTMLUListElement>('[data-layout-scroll="horizontal"]')
  if (!list) throw new Error('The main navigation needs a horizontal list')
  return list
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

  it.each([
    ['en', 'Main', 'Integrations', 'Event types', 'Calendars'],
    ['zh-CN', '主导航', '集成', '活动类型', '日历'],
  ] as const)(
    'keeps everyday links in the horizontal strip and groups integrations in %s',
    (language, main, integrations, eventTypes, calendars) => {
      chooseLanguage(language)
      shell('/app/calendars')
      const nav = screen.getByRole('navigation', { name: main })
      const group = within(nav).getByRole('region', { name: integrations })
      const primary = within(primaryList())
      expect(primary.getByRole('link', { name: eventTypes })).toBeDefined()
      expect(primary.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(
        expect.arrayContaining([
          '/app/event-types',
          '/app/availability',
          '/app/bookings',
          '/app/analytics',
        ]),
      )
      expect(
        within(group).getByRole('link', { name: calendars }).getAttribute('aria-current'),
      ).toBe('page')
      expect(
        within(group)
          .getAllByRole('link')
          .map((link) => link.getAttribute('href')),
      ).toEqual(['/app/conferences', '/app/calendars', '/app/api-keys', '/app/connected-apps'])
      expect(primary.queryByRole('link', { name: calendars })).toBeNull()
      for (const link of within(nav).getAllByRole('link')) {
        expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
      }
    },
  )

  it('exposes the current integration in the compact navigation disclosure', async () => {
    const user = userEvent.setup()
    shell('/app/api-keys')
    const group = screen.getByRole('region', { name: 'Integrations' })
    const trigger = within(group).getByRole('button', { name: 'Integrations' })
    expect(trigger.getAttribute('aria-current')).toBe('location')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-current')).toBeNull()
    const links = within(group).getByRole('list')
    expect(links.id).toBe(trigger.getAttribute('aria-controls'))
    await user.tab()
    expect(document.activeElement).toBe(
      within(links).getByRole('link', { name: 'Conference accounts' }),
    )
    await user.keyboard('{Escape}')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it.each([
    ['en', 'Account menu', 'Hourmere home', 'Switch space', 'Interface language', 'Sign out'],
    ['zh-CN', '账户菜单', 'Hourmere 主页', '切换空间', '界面语言', '退出登录'],
  ] as const)(
    'opens the %s account menu by keyboard and restores focus on Escape',
    async (language, account, home, switchSpace, languagePicker, signOut) => {
      chooseLanguage(language)
      const user = userEvent.setup()
      shell()
      const header = within(screen.getByRole('banner'))
      expect(header.getByRole('link', { name: home })).toBeDefined()
      expect(header.getByRole('button', { name: new RegExp(`^${switchSpace}`) })).toBeDefined()
      expect(header.queryByRole('combobox')).toBeNull()
      expect(header.queryByRole('button', { name: signOut })).toBeNull()
      expect(header.queryByText(session.me.user.email)).toBeNull()
      const trigger = screen.getByRole('button', { name: account })
      expect(within(trigger).getByText('A').getAttribute('aria-hidden')).toBe('true')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByRole('combobox', { name: languagePicker })).toBeNull()
      expect(screen.queryByRole('button', { name: signOut })).toBeNull()
      trigger.focus()
      await user.keyboard('{Enter}')
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      const panel = screen.getByRole('region', { name: account })
      expect(panel.id).toBe(trigger.getAttribute('aria-controls'))
      expect(within(panel).getByText(session.me.user.email)).toBeDefined()
      const select = within(panel).getByRole('combobox', { name: languagePicker })
      await user.tab()
      expect(document.activeElement).toBe(select)
      await user.tab()
      expect(document.activeElement).toBe(within(panel).getByRole('button', { name: signOut }))
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('region', { name: account })).toBeNull()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(trigger)
    },
  )

  it('closes the account menu when clicked again or on pointer and focus outside', async () => {
    const user = userEvent.setup()
    shell()
    const trigger = screen.getByRole('button', { name: 'Account menu' })
    await user.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await user.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)

    await user.click(trigger)
    await user.click(screen.getByRole('heading', { name: 'Page content' }))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await user.click(trigger)
    const link = within(primaryList()).getByRole('link', { name: 'Bookings' })
    fireEvent.focusIn(link)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    ['/app/event-types', 'main-content-wide'],
    ['/app/availability', 'main-content-wide'],
    ['/app/bookings', 'main-content-wide'],
    ['/app/meeting-polls', 'main-content-wide'],
    ['/app/team/bookings', 'main-content-wide'],
    ['/app/analytics', 'main-content-wide'],
    ['/app/conferences', 'main-content-wide'],
    ['/app/calendars', 'main-content-wide'],
    ['/app/api-keys', 'main-content-wide'],
    ['/app/connected-apps', 'main-content-wide'],
    ['/app/audit-log', 'main-content-wide'],
    ['/app/settings', 'main-content'],
    ['/app/event-types/new', 'main-content-wide'],
    ['/app/event-types/example', 'main-content-wide'],
    ['/app/availability/example', 'main-content'],
    ['/app/bookings/example', 'main-content'],
  ])('applies the content width for %s', (path, className) => {
    shell(path)
    expect(screen.getByRole('main').className).toBe(className)
  })

  it('shows fades only where more navigation is hidden and updates on resize', () => {
    let width = 200
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('[data-layout-scroll="horizontal"]') ? width : 0
    })
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('[data-layout-scroll="horizontal"]') ? 1000 : 0
    })
    const { unmount } = shell()
    const list = primaryList()
    const strip = list.closest<HTMLElement>('.sidenav-primary')
    expect(strip?.dataset.scrollStart).toBe('true')
    expect(strip?.dataset.scrollEnd).toBe('false')
    list.scrollLeft = 400
    fireEvent.scroll(list)
    expect(strip?.dataset.scrollStart).toBe('false')
    expect(strip?.dataset.scrollEnd).toBe('false')
    list.scrollLeft = 800
    fireEvent.scroll(list)
    expect(strip?.dataset.scrollEnd).toBe('true')
    list.scrollLeft = 0
    width = 1000
    fireEvent(window, new Event('resize'))
    expect(strip?.dataset.scrollStart).toBe('true')
    expect(strip?.dataset.scrollEnd).toBe('true')
    unmount()
    fireEvent(window, new Event('resize'))
  })

  it('keeps the active item visible when translated navigation changes its width', async () => {
    let translated = false
    const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('[data-layout-scroll="horizontal"]')) return rect(0, 200)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return translated ? rect(240 - offset, 340 - offset) : rect(10, 80)
      }
      return rect(0, 0)
    })
    shell()
    const list = primaryList()
    expect(list.scrollLeft).toBe(0)
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    translated = true
    fireEvent.change(screen.getByRole('combobox', { name: 'Interface language' }), {
      target: { value: 'zh-CN' },
    })
    expect(list.scrollLeft).toBe(140)
  })

  it('reveals the current item when the sidebar becomes a horizontal strip', () => {
    let width = 1000
    const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('[data-layout-scroll="horizontal"]') ? width : 0
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('[data-layout-scroll="horizontal"]')) return rect(0, width)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return rect(900 - offset, 1000 - offset)
      }
      return rect(0, 0)
    })
    shell('/app/settings')
    const list = primaryList()
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
      if (this.matches('[data-layout-scroll="horizontal"]')) return rect(0, 200)
      if (this.matches('nav a[aria-current="page"]')) {
        const offset = this.closest('ul')?.scrollLeft ?? 0
        return rect(150 - offset, 220 - offset)
      }
      return rect(0, 0)
    })
    shell('/app/settings')
    const list = primaryList()
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
    ['en', 'Switch space', 'Owner', 'Current space'],
    ['zh-CN', '切换空间', '所有者', '当前空间'],
  ] as const)(
    'keeps the team name between the %s switcher labels',
    async (locale, action, role, current) => {
      chooseLanguage(locale)
      const team = { ...TEAM, name: 'שלום (Research) [42]' }
      session.me.organization = { ...team, personal: false }
      fakeApi({
        'GET /api/auth/organization/list': () => json(200, [team]),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { organizationId: team.id, userId: session.me.user.id, role: 'owner' }),
      })
      const user = userEvent.setup()
      shell()
      const trigger = await screen.findByRole('button', {
        name: `${action} ${team.name} ${role}`,
      })
      const name = within(trigger).getByText(team.name)
      expect(name.dir).toBe('auto')
      expect(name.nextElementSibling?.textContent).toBe(role)

      await user.click(trigger)
      const choice = await screen.findByRole('menuitemradio', {
        name: `${team.name} ${current}`,
      })
      expect(within(choice).getByText(team.name).dir).toBe('auto')
      expect(choice.getAttribute('aria-checked')).toBe('true')
      await user.keyboard('{Escape}')
      expect(document.activeElement).toBe(trigger)
    },
  )

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
