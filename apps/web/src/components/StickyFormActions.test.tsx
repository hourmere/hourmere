import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { StickyFormActions } from './StickyFormActions.tsx'

it('reserves the measured bar height through wrapping and restores scroll clearance on leave', () => {
  let height = 72
  let resize: ResizeObserverCallback = () => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe = observe
      disconnect = disconnect
    },
  )
  const rect = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('sticky-form-actions')
      ? { ...rect.call(this), height }
      : rect.call(this)
  })
  const root = document.documentElement
  const { unmount } = render(
    <StickyFormActions>
      <button type="submit">Save changes</button>
      <a href="/app">Back</a>
    </StickyFormActions>,
  )
  const bar = screen.getByRole('button').parentElement
  expect(observe).toHaveBeenCalledWith(bar)
  expect(root.style.getPropertyValue('--sticky-actions-height')).toBe('72px')
  height = 148
  act(() => resize([], {} as ResizeObserver))
  expect(root.style.getPropertyValue('--sticky-actions-height')).toBe('148px')
  height = 176
  act(() => window.dispatchEvent(new Event('resize')))
  expect(root.style.getPropertyValue('--sticky-actions-height')).toBe('176px')
  unmount()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(root.style.getPropertyValue('--sticky-actions-height')).toBe('')
  act(() => window.dispatchEvent(new Event('resize')))
  expect(root.style.getPropertyValue('--sticky-actions-height')).toBe('')
})
