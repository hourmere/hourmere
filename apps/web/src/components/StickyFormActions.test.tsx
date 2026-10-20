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

it('drops stickiness above a quarter of the viewport and restores it after either dimension changes', () => {
  let height = 142
  let resize: ResizeObserverCallback = () => {}
  vi.stubGlobal('innerHeight', 568)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ height }) as DOMRect,
  )
  render(
    <StickyFormActions>
      <button type="submit">Save changes</button>
      <p role="status">Unsaved changes</p>
    </StickyFormActions>,
  )
  const bar = screen.getByRole('button').parentElement
  expect(bar?.getAttribute('data-sticky')).toBe('true')
  height = 143
  act(() => resize([], {} as ResizeObserver))
  expect(bar?.getAttribute('data-sticky')).toBe('false')
  height = 90
  act(() => resize([], {} as ResizeObserver))
  expect(bar?.getAttribute('data-sticky')).toBe('true')
  vi.stubGlobal('innerHeight', 320)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(bar?.getAttribute('data-sticky')).toBe('false')
  vi.stubGlobal('innerHeight', 568)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(bar?.getAttribute('data-sticky')).toBe('true')
})

it('scrolls the whole focused field clear after native focus scrolling, and leaves visible fields alone', () => {
  let height = 90
  let frame: FrameRequestCallback = () => {}
  const cancel = vi.fn()
  vi.stubGlobal('innerHeight', 568)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('sticky-form-actions')) {
      return { top: 568 - height, bottom: 568, height } as DOMRect
    }
    return this.id === 'description'
      ? ({ top: 414, bottom: 525, height: 111 } as DOMRect)
      : ({ top: 100, bottom: 211, height: 111 } as DOMRect)
  })
  const { unmount } = render(
    <form>
      <textarea id="description" aria-label="Description" />
      <input aria-label="Visible field" />
      <StickyFormActions>
        <button type="submit">Save changes</button>
        <p role="status">Unsaved changes</p>
      </StickyFormActions>
    </form>,
  )
  act(() => screen.getByLabelText('Description').focus())
  expect(scroll).not.toHaveBeenCalled()
  act(() => frame(0))
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 59, behavior: 'instant' })
  scroll.mockClear()
  act(() => screen.getByLabelText('Visible field').focus())
  act(() => frame(0))
  expect(scroll).not.toHaveBeenCalled()
  act(() => screen.getByRole('button').focus())
  act(() => frame(0))
  expect(scroll).not.toHaveBeenCalled()
  height = 163
  act(() => window.dispatchEvent(new Event('resize')))
  act(() => screen.getByLabelText('Description').focus())
  act(() => frame(0))
  expect(scroll).not.toHaveBeenCalled()
  unmount()
  expect(cancel).toHaveBeenCalledWith(1)
})
