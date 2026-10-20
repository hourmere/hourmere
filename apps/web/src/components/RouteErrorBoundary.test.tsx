import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import * as browser from '../browser.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { RouteErrorBoundary } from './RouteErrorBoundary.tsx'

function Broken(): never {
  throw new Error('Private route error details')
}

describe('route error recovery', () => {
  it.each([
    [
      'en',
      'Something went wrong',
      'Reload',
      'Go to Hourmere',
      'Something went wrong with this attempt. Please try again.',
    ],
    ['zh-CN', '出错了', '重新加载', '前往 Hourmere', '此次尝试出现问题。请重试。'],
  ] as const)(
    'shows localized recovery and document language in %s',
    (locale, title, label, home, explanation) => {
      chooseLanguage(locale)
      document.documentElement.lang = 'wrong'
      const reload = vi.spyOn(browser, 'reloadPage').mockImplementation(() => {})
      render(
        <MemoryRouter>
          <RouteErrorBoundary>
            <Broken />
          </RouteErrorBoundary>
        </MemoryRouter>,
        { onCaughtError: vi.fn() },
      )
      const alert = screen.getByRole('alert')
      expect(document.documentElement.lang).toBe(locale)
      expect(alert.querySelector('.logo img')).not.toBeNull()
      expect(screen.getByText(explanation).tagName).toBe('P')
      expect(screen.getByRole('link', { name: home }).getAttribute('href')).toBe('/app')
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
      expect(document.body.textContent).not.toContain('Private route error details')
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(reload).toHaveBeenCalledOnce()
    },
  )

  it('uses the embedded route language when its lazy chunk fails', () => {
    chooseLanguage('en')
    document.documentElement.lang = 'en'
    render(
      <MemoryRouter initialEntries={['/embed/ada/intro?language=zh-CN']}>
        <RouteErrorBoundary>
          <Broken />
        </RouteErrorBoundary>
      </MemoryRouter>,
      { onCaughtError: vi.fn() },
    )
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(screen.getByRole('heading', { name: '出错了' })).toBeDefined()
  })

  it('recovers after navigating away from the failed route', () => {
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Link to="/working">Leave failed route</Link>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/broken" element={<Broken />} />
            <Route path="/working" element={<h1>Working route</h1>} />
          </Routes>
        </RouteErrorBoundary>
      </MemoryRouter>,
      { onCaughtError: vi.fn() },
    )
    expect(screen.getByRole('alert')).toBeDefined()
    fireEvent.click(screen.getByRole('link', { name: 'Leave failed route' }))
    expect(screen.getByRole('heading', { name: 'Working route' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('preserves an existing route subtree during normal navigation', () => {
    function Draft() {
      const [value, setValue] = useState('')
      return <input aria-label="Draft" value={value} onChange={(e) => setValue(e.target.value)} />
    }
    render(
      <MemoryRouter>
        <Link to="/another">Navigate</Link>
        <RouteErrorBoundary>
          <Draft />
        </RouteErrorBoundary>
      </MemoryRouter>,
    )
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft' })
    fireEvent.change(input, { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByRole('link', { name: 'Navigate' }))
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input)
    expect(input.value).toBe('Keep my draft')
  })
})
