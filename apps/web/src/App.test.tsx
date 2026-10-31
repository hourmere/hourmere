import { render, screen } from '@testing-library/react'
import { isValidElement } from 'react'
import { MemoryRouter, type RouteObject } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App, appRoutes } from './App.tsx'
import { chooseLanguage } from './i18n/store.ts'
import { SessionLayout } from './lazy-pages.tsx'

vi.mock('./lazy-pages.tsx', async (importOriginal) => {
  const pages = await importOriginal<typeof import('./lazy-pages.tsx')>()
  const pending = new Promise<never>(() => {})
  const LoadingPage = () => {
    throw pending
  }
  return Object.fromEntries(Object.keys(pages).map((key) => [key, () => <LoadingPage />]))
})

function routePaths(routes: RouteObject[], parent = ''): string[] {
  return routes.flatMap((route) => {
    const path = (
      route.path?.startsWith('/') ? route.path : `${parent}/${route.path ?? ''}`
    ).replace(/\/+/g, '/')
    const example = path.replace(/:\w+/g, 'sample').replaceAll('*', 'unknown').replace(/\/+$/g, '')
    return [example || '/', ...routePaths(route.children ?? [], path)]
  })
}
const sessionRoute = appRoutes.find(
  ({ element, handle }) =>
    isValidElement(element) && element.type === SessionLayout && handle?.surface === 'admin',
)

describe('route loading language', () => {
  it('finds the admin session subtree in the rendered route definitions', () => {
    expect(sessionRoute?.children?.length).toBeGreaterThan(0)
  })

  it.each(['/', ...new Set(routePaths(sessionRoute?.children ?? []))])(
    'uses the admin surface throughout the session subtree while %s loads',
    (path) => {
      chooseLanguage('de')
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      )
      expect(screen.getByRole('status').textContent).toBe('正在加载…')
      expect(localStorage.getItem('hourmere-language')).toBe('de')
    },
  )

  it('keeps admin languages while the session-gated invitation route loads', () => {
    const recipientRoute = appRoutes.find(
      ({ element, children }) =>
        isValidElement(element) &&
        element.type === SessionLayout &&
        children?.some(({ path }) => path === '/app/join'),
    )
    expect(recipientRoute).toBeDefined()
    expect(recipientRoute?.handle?.surface).toBe('admin')
    chooseLanguage('de')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
    render(
      <MemoryRouter initialEntries={['/app/join']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status').textContent).toBe('正在加载…')
    expect(screen.getByLabelText<HTMLSelectElement>('界面语言').value).toBe('zh-CN')
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('界面语言').options].map(({ value }) => value),
    ).toEqual(['en', 'zh-CN'])
    expect(localStorage.getItem('hourmere-language')).toBe('de')
  })

  it('inherits the admin surface for a new session route outside existing URL groups', () => {
    const children = sessionRoute?.children
    if (!children) throw new Error('The session route must have children')
    const futureRoute = { path: '/account/setup', element: <p>Account setup</p> }
    children.push(futureRoute)
    try {
      chooseLanguage('de')
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
      render(
        <MemoryRouter initialEntries={[futureRoute.path]}>
          <App />
        </MemoryRouter>,
      )
      expect(screen.getByRole('status').textContent).toBe('正在加载…')
    } finally {
      children.splice(children.indexOf(futureRoute), 1)
    }
  })

  it.each(['/embed/ada/intro', '/embed/team/Alpha/intro'])(
    'uses the iframe query language before %s has loaded',
    (path) => {
      chooseLanguage('en')
      render(
        <MemoryRouter initialEntries={[`${path}?language=zh-CN`]}>
          <App />
        </MemoryRouter>,
      )
      expect(screen.getByRole('status').textContent).toBe('正在加载…')
      expect(screen.getByRole('status').lang).toBe('zh-CN')
      expect(localStorage.getItem('hourmere-language')).toBe('en')
    },
  )

  it.each(['', '?language=zh', '?language=__proto__', '?language=zh-CN&language=en'])(
    'keeps the normal preference for absent or invalid iframe language %s',
    (query) => {
      chooseLanguage('en')
      render(
        <MemoryRouter initialEntries={[`/embed/ada/intro${query}`]}>
          <App />
        </MemoryRouter>,
      )
      expect(screen.getByRole('status').textContent).toBe('Loading…')
      expect(screen.getByRole('status').hasAttribute('lang')).toBe(false)
    },
  )

  it('ignores the embed-only query language on ordinary booking routes', () => {
    chooseLanguage('en')
    render(
      <MemoryRouter initialEntries={['/ada/intro?language=zh-CN']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })
})
