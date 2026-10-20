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
    ['en', 'Something went wrong', 'Reload'],
    ['zh-CN', '出错了', '重新加载'],
  ] as const)('shows a localized recovery action in %s', (locale, title, label) => {
    chooseLanguage(locale)
    const reload = vi.spyOn(browser, 'reloadPage').mockImplementation(() => {})
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <Broken />
        </RouteErrorBoundary>
      </MemoryRouter>,
      { onCaughtError: vi.fn() },
    )
    expect(screen.getByRole('alert').textContent).toBe(title + label)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
    expect(document.body.textContent).not.toContain('Private route error details')
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(reload).toHaveBeenCalledOnce()
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
