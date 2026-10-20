import { type ReactNode, useLayoutEffect, useRef } from 'react'

/** Reserve the actual wrapped bar height when the browser scrolls keyboard focus into view. */
export function StickyFormActions({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = bar.current
    if (!element) return
    const root = document.documentElement
    const previous = root.style.getPropertyValue('--sticky-actions-height')
    const measure = () => {
      root.style.setProperty(
        '--sticky-actions-height',
        `${element.getBoundingClientRect().height}px`,
      )
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      if (previous) root.style.setProperty('--sticky-actions-height', previous)
      else root.style.removeProperty('--sticky-actions-height')
    }
  }, [])
  return (
    <div className="form-actions sticky-form-actions" ref={bar}>
      {children}
    </div>
  )
}
