import { fireEvent, render, screen, within } from '@testing-library/react'
import { lazy, Suspense } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { AppShell } from './AppShell.tsx'

vi.mock('../session.tsx', () => ({
  useMe: () => ({ user: { email: 'shell@example.com' } }),
  useSession: () => ({ signOut: vi.fn(), notice: null, setNotice: vi.fn() }),
}))

function shell(path = '/app/event-types') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<h1>Page content</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('admin shell layout', () => {
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
    expect(within(header).getByRole('button').classList.contains('button-small')).toBe(true)
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
