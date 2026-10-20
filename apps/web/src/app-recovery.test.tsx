import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { chooseLanguage } from './i18n/store.ts'

vi.mock('./lazy-pages.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lazy-pages.tsx')>()
  const { lazy } = await import('react')
  return {
    ...actual,
    BookingPage: lazy(() => Promise.reject(new Error('Stale route chunk'))),
    EmbeddedBookingPage: lazy(() => Promise.reject(new Error('Stale embed chunk'))),
    EmbeddedTeamBookingPage: lazy(() => Promise.reject(new Error('Stale team embed chunk'))),
  }
})

const html = readFileSync('apps/web/index.html', 'utf8')

describe('application recovery and sharing metadata', () => {
  it.each([
    ['en', 'Something went wrong', 'Reload'],
    ['zh-CN', '出错了', '重新加载'],
  ] as const)('catches a failed public lazy route in %s', async (locale, title, label) => {
    chooseLanguage(locale)
    render(
      <MemoryRouter initialEntries={['/ada/meeting']}>
        <App />
      </MemoryRouter>,
      { onCaughtError: vi.fn() },
    )
    expect(await screen.findByRole('heading', { name: title })).toBeDefined()
    expect(screen.getByRole('button', { name: label })).toBeDefined()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('includes generic search and social sharing metadata in the app document', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const description = 'Book a time to meet with Hourmere, the open-source scheduling app.'
    for (const [selector, content] of [
      ['meta[name="description"]', description],
      ['meta[property="og:title"]', 'Hourmere'],
      ['meta[property="og:description"]', description],
      ['meta[property="og:type"]', 'website'],
      ['meta[property="og:site_name"]', 'Hourmere'],
      ['meta[name="twitter:card"]', 'summary'],
    ] as const)
      expect(doc.querySelector(selector)?.getAttribute('content')).toBe(content)
  })

  it.each(['/embed/ada/meeting', '/embed/team/alpha/meeting'])(
    'keeps the Chinese query language when the lazy %s chunk fails',
    async (path) => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
      chooseLanguage('en')
      render(
        <MemoryRouter initialEntries={[`${path}?language=zh-CN`]}>
          <App />
        </MemoryRouter>,
        { onCaughtError: vi.fn() },
      )
      expect(await screen.findByRole('heading', { name: '出错了' })).toBeDefined()
      expect(screen.getByRole('button', { name: '重新加载' })).toBeDefined()
      expect(localStorage.getItem('hourmere-language')).toBe('en')
    },
  )

  it.each(['language=fr', 'language=zh-CN&language=en', 'language=zh-CN&language=zh-CN'])(
    'ignores invalid or duplicate embed language queries: %s',
    async (query) => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
      chooseLanguage('en')
      render(
        <MemoryRouter initialEntries={[`/embed/ada/meeting?${query}`]}>
          <App />
        </MemoryRouter>,
        { onCaughtError: vi.fn() },
      )
      expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined()
    },
  )

  it('falls back to the existing Chinese preference for an unsupported embed language', async () => {
    chooseLanguage('zh-CN')
    render(
      <MemoryRouter initialEntries={['/embed/ada/meeting?language=fr']}>
        <App />
      </MemoryRouter>,
      { onCaughtError: vi.fn() },
    )
    expect(await screen.findByRole('heading', { name: '出错了' })).toBeDefined()
  })

  it('ignores embed query language on an ordinary public route', async () => {
    chooseLanguage('en')
    render(
      <MemoryRouter initialEntries={['/ada/meeting?language=zh-CN']}>
        <App />
      </MemoryRouter>,
      { onCaughtError: vi.fn() },
    )
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined()
  })

  it('localizes the generic description when the app uses Chinese', () => {
    const metas = ['description', 'og:description'].map((name) => {
      const meta = document.createElement('meta')
      meta.setAttribute(name.startsWith('og:') ? 'property' : 'name', name)
      document.head.append(meta)
      return meta
    })
    try {
      chooseLanguage('zh-CN')
      render(
        <MemoryRouter initialEntries={['/not/a/real/route']}>
          <App />
        </MemoryRouter>,
      )
      for (const meta of metas)
        expect(meta.getAttribute('content')).toBe('使用开源预约应用 Hourmere，轻松预约会面时间。')
    } finally {
      for (const meta of metas) meta.remove()
    }
  })
})
