import { type ReactNode, useEffect, useRef } from 'react'
import { BookingPage } from './BookingPage.tsx'
import { EmbeddedContext, embedMessageContext } from './embed-context.ts'

function EmbedFrame({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = embedMessageContext(),
      element = root.current
    if (!target || !element) return
    const size = () =>
      window.parent.postMessage(
        {
          type: 'hourmere:resize',
          id: target.id,
          height: Math.min(2000, Math.max(240, Math.ceil(element.getBoundingClientRect().height))),
        },
        target.origin,
      )
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(size) : undefined
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        window.parent.postMessage({ type: 'hourmere:close', id: target.id }, target.origin)
      }
    }
    window.addEventListener('keydown', onEscape)
    observer?.observe(element)
    window.addEventListener('resize', size)
    size()
    return () => {
      window.removeEventListener('keydown', onEscape)
      observer?.disconnect()
      window.removeEventListener('resize', size)
    }
  }, [])
  return (
    <EmbeddedContext.Provider value={true}>
      <div ref={root} className="embed-content">
        {children}
      </div>
    </EmbeddedContext.Provider>
  )
}
export function EmbeddedBookingPage() {
  return (
    <EmbedFrame>
      <BookingPage />
    </EmbedFrame>
  )
}
export function EmbeddedTeamBookingPage() {
  return (
    <EmbedFrame>
      <BookingPage team />
    </EmbedFrame>
  )
}
