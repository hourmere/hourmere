import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, type Location, UNSAFE_DataRouterContext } from 'react-router'
import { useI18n } from '../../i18n/runtime.tsx'
import { useConfirmLeave } from '../../unsaved-changes.tsx'
import './booking-panel.css'

export interface BookingPanelNavigation {
  location: Location
  active: boolean
  open: (id: string, trigger: HTMLElement) => void
  step: (id: string) => void
  close: () => void
}
export const BookingPanelContext = createContext<BookingPanelNavigation | null>(null)
export const useBookingPanel = () => useContext(BookingPanelContext)
const TitleContext = createContext<((title: string) => void) | null>(null)
export function useBookingPanelTitle(title: string) {
  const setTitle = useContext(TitleContext)
  useEffect(() => {
    setTitle?.(title)
  }, [setTitle, title])
}
/** The data router already confirms POP navigation; declarative routers need the local guard. */
export function useCloseBookingPanel() {
  const panel = useBookingPanel()
  const dataRouter = useContext(UNSAFE_DataRouterContext)
  const confirmLeave = useConfirmLeave()
  return () => {
    if (dataRouter || confirmLeave()) panel?.close()
  }
}

/** Returning from embedded detail restores its list, including filters and scroll. */
export function BookingListReturnLink({ to, children }: { to: string; children: ReactNode }) {
  const panel = useBookingPanel()
  const close = useCloseBookingPanel()
  return panel?.active ? (
    <button type="button" className="button button-small" onClick={close}>
      {children}
    </button>
  ) : (
    <Link to={to}>{children}</Link>
  )
}

/** The overlay is modal on desktop; the retained list stays inaccessible until close. */
export function BookingPanel({
  name,
  previous,
  next,
  children,
}: {
  name: string
  previous?: () => void | Promise<void>
  next?: () => void | Promise<void>
  children: ReactNode
}) {
  const navigation = useBookingPanel()
  const { t } = useI18n()
  const confirmLeave = useConfirmLeave()
  const closePanel = useCloseBookingPanel()
  const [title, setTitle] = useState<{ path: string; name: string } | null>(null)
  const path = navigation?.location.pathname ?? ''
  const announceTitle = useCallback((name: string) => setTitle({ path, name }), [path])
  const accessibleName = title?.path === path ? title.name : name
  const close = useRef<HTMLButtonElement>(null)
  const region = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 767px)').matches ?? false,
  )
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 767px)')
    if (!media) return
    const change = () => setNarrow(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => close.current?.focus({ preventScroll: true }), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: reapply hiding when list/detail rendering adds siblings
  useEffect(() => {
    if (!region.current) return
    if (!region.current.contains(document.activeElement))
      close.current?.focus({ preventScroll: true })
    const hidden: { element: HTMLElement; inert: boolean; aria: string | null }[] = []
    let current: HTMLElement = region.current
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || !(sibling instanceof HTMLElement)) continue
        hidden.push({
          element: sibling,
          inert: sibling.inert,
          aria: sibling.getAttribute('aria-hidden'),
        })
        sibling.inert = true
        sibling.setAttribute('aria-hidden', 'true')
      }
      current = current.parentElement
      if (current === document.body) break
    }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      for (const { element, inert, aria } of hidden) {
        element.inert = inert
        if (aria === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', aria)
      }
      document.body.style.overflow = overflow
    }
  }, [narrow, children])
  async function move(action: () => void | Promise<void>) {
    if (busy || !confirmLeave()) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      ref={region}
      {...(narrow ? { role: 'region' } : { role: 'dialog', 'aria-modal': true })}
      aria-label={accessibleName}
      className={`booking-detail-panel${narrow ? ' booking-detail-full-page' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Tab' && !narrow && !event.defaultPrevented) {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href], button, input, select, textarea, summary, [tabindex]',
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(':disabled') &&
              !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
              getComputedStyle(element).display !== 'none' &&
              getComputedStyle(element).visibility !== 'hidden',
          )
          const first = controls[0]
          const last = controls.at(-1)
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              !controls.includes(document.activeElement as HTMLElement))
          ) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
          return
        event.preventDefault()
        closePanel()
      }}
    >
      <div className="booking-detail-toolbar">
        <button
          ref={close}
          type="button"
          className="button"
          onClick={() => {
            closePanel()
          }}
        >
          {t('Close details')}
        </button>
        <button
          type="button"
          className="button"
          aria-disabled={!previous || busy}
          onClick={() => {
            if (previous && !busy) void move(previous)
          }}
        >
          {t('Previous booking')}
        </button>
        <button
          type="button"
          className="button"
          aria-disabled={!next || busy}
          onClick={() => {
            if (next && !busy) void move(next)
          }}
        >
          {t('Next booking')}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {accessibleName}
      </p>
      <TitleContext value={announceTitle}>{children}</TitleContext>
    </section>
  )
}
