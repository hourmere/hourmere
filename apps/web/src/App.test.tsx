import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { chooseLanguage } from './i18n/store.ts'

vi.mock('./lazy-pages.tsx', async (importOriginal) => {
  const pages = await importOriginal<typeof import('./lazy-pages.tsx')>()
  const pending = new Promise<never>(() => {})
  const LoadingPage = () => {
    throw pending
  }
  return Object.fromEntries(Object.keys(pages).map((key) => [key, LoadingPage]))
})

describe('route loading language', () => {
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
