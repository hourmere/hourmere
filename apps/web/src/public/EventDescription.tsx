import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/runtime.tsx'
import { collapseBlankLines } from './description.ts'

/** Keep the calendar near the event on narrow pages without losing the full description. */
export function EventDescription({ children }: { children: string }) {
  const { t } = useI18n()
  const id = useId()
  const text = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const [clamped, setClamped] = useState(false)
  // Before paint, so a clamped description never flashes its blank lines first.
  useLayoutEffect(() => {
    const element = text.current
    if (!element) return
    const measure = () => {
      // The clamp comes from container-driven CSS (none from 900px), not from this state,
      // so reading it back cannot loop.
      const clamp = getComputedStyle(element).getPropertyValue('-webkit-line-clamp')
      setClamped(clamp !== '' && clamp !== 'none')
      if (!expanded) setOverflows(element.scrollHeight > element.clientHeight)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [expanded])
  return (
    <div className="event-description-disclosure">
      <p
        id={id}
        ref={text}
        className={`event-description${expanded ? '' : ' event-description-collapsed'}`}
      >
        {/* Blank lines are the host's paragraph breaks: drop them only while clamped. */}
        {clamped && !expanded ? collapseBlankLines(children) : children}
      </p>
      {overflows && (
        <button
          type="button"
          className="button button-small description-toggle"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('Show less') : t('Show more')}
        </button>
      )}
    </div>
  )
}
