import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { useEmbedded } from './embed-context.ts'
import './BookingFormActions.css'

const phone = 'screen and (max-width: 639px)'

/** Keep one native submit control in form order, including when docked on a phone. */
export function BookingFormActions({ active, children }: { active: boolean; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null)
  const embedded = useEmbedded()

  useLayoutEffect(() => {
    if (!active || embedded) return
    const action = bar.current
    const page = action?.closest('.public')
    const media = window.matchMedia?.(phone)
    if (!action || !page || !media) return

    const root = document.documentElement
    const viewport = window.visualViewport
    let frame = 0

    const undock = () => {
      action.removeAttribute('data-docked')
      root.style.removeProperty('--booking-actions-height')
      root.style.removeProperty('--booking-viewport-inset')
    }

    const position = () => {
      const height = viewport?.height ?? window.innerHeight
      // Keep the whole form scrollable when pinch-zoomed or the keyboard leaves very little room.
      if (!media.matches || (viewport && viewport.scale !== 1)) {
        undock()
        return
      }
      action.dataset.docked = ''
      const barHeight = action.getBoundingClientRect().height
      if (barHeight > height / 4) {
        undock()
        return
      }
      const inset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0))
      root.style.setProperty('--booking-viewport-inset', `${inset}px`)
      root.style.setProperty('--booking-actions-height', `${barHeight}px`)
    }

    const revealFocus = () => {
      cancelAnimationFrame(frame)
      // Native focus scrolling does not consistently respect the root's scroll padding.
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement
        if (
          !action.hasAttribute('data-docked') ||
          !(focused instanceof HTMLElement) ||
          !page.contains(focused) ||
          action.contains(focused)
        )
          return
        const field = focused.getBoundingClientRect()
        const overlap = field.bottom - action.getBoundingClientRect().top + 8
        if (field.height > 0 && overlap > 0) window.scrollBy({ top: overlap, behavior: 'instant' })
      })
    }

    const resize = () => {
      position()
      revealFocus()
    }

    resize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
    observer?.observe(action)
    media.addEventListener('change', resize)
    window.addEventListener('resize', resize)
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', position)
    page.addEventListener('focusin', revealFocus)
    return () => {
      observer?.disconnect()
      media.removeEventListener('change', resize)
      window.removeEventListener('resize', resize)
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', position)
      page.removeEventListener('focusin', revealFocus)
      cancelAnimationFrame(frame)
      undock()
    }
  }, [active, embedded])

  return (
    <div className="booking-form-actions" ref={bar}>
      {children}
    </div>
  )
}
