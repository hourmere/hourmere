import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

/** Reserve the actual wrapped bar height when the browser scrolls keyboard focus into view. */
export function StickyFormActions({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null)
  const [withinBudget, setWithinBudget] = useState(true)
  useLayoutEffect(() => {
    const element = bar.current
    if (!element) return
    const root = document.documentElement
    const previous = root.style.getPropertyValue('--sticky-actions-height')
    const form = element.closest('form')
    let sticky = true
    let frame = 0
    // Native keyboard focus scrolling does not consistently respect scroll-padding.
    // Measure after it runs so the whole focused field clears the bottom bar.
    const revealFocus = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement
        if (
          !sticky ||
          window.innerHeight <= 500 ||
          !(focused instanceof HTMLElement) ||
          !form?.contains(focused) ||
          element.contains(focused)
        )
          return
        const gap = Number.parseFloat(getComputedStyle(element).paddingBottom) || 12
        const bottom = Math.min(window.innerHeight, element.getBoundingClientRect().top) - gap
        const field = focused.getBoundingClientRect()
        const overlap = field.bottom - bottom
        if (field.height > 0 && overlap > 0) window.scrollBy({ top: overlap, behavior: 'instant' })
      })
    }
    const measure = () => {
      const height = element.getBoundingClientRect().height
      root.style.setProperty('--sticky-actions-height', `${height}px`)
      sticky = height <= window.innerHeight * 0.25
      setWithinBudget(sticky)
      revealFocus()
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    form?.addEventListener('focusin', revealFocus)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      form?.removeEventListener('focusin', revealFocus)
      cancelAnimationFrame(frame)
      if (previous) root.style.setProperty('--sticky-actions-height', previous)
      else root.style.removeProperty('--sticky-actions-height')
    }
  }, [])
  return (
    <div className="form-actions sticky-form-actions" data-sticky={withinBudget} ref={bar}>
      {children}
    </div>
  )
}
