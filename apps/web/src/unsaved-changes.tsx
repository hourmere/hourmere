// Keeps people from losing a half-filled form: while a page has unsaved changes, leaving it
// asks first. The app uses React Router's declarative mode, which has no navigation
// blocker (useBlocker needs a data router), so the guard covers the ways out of a page that
// the app controls or the browser can ask about:
//
// - links inside the app's frame (navigation, back links, the logo): AppShell asks on click,
//   before React Router navigates;
// - signing out: AppShell asks before ending the session;
// - reloading, closing the tab or typing another address: the browser's own prompt
//   (beforeunload).
//
// The browser's back and forward buttons are not covered: declarative mode cannot stop
// them without patching the router's history.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useI18n } from './i18n/runtime.tsx'

export const LEAVE_WITH_UNSAVED_CHANGES =
  'You have unsaved changes. Leave this page and discard them?'

interface UnsavedChanges {
  /** Records whether the source `key` has unsaved changes (false forgets it). */
  set: (key: symbol, dirty: boolean) => void
  /** True when nothing is unsaved, or the person agreed to discard it. */
  confirmLeave: () => boolean
}

const UnsavedChangesContext = createContext<UnsavedChanges | null>(null)

/** Tracks which parts of the current page have unsaved changes. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const dirty = useRef(new Set<symbol>())

  const set = useCallback((key: symbol, isDirty: boolean) => {
    if (isDirty) dirty.current.add(key)
    else dirty.current.delete(key)
  }, [])

  const confirmLeave = useCallback(() => {
    if (dirty.current.size === 0) return true
    // Registrations stay until their page unmounts: leaving can still fail (a sign-out the
    // server refuses), and the page, still there, must keep asking.
    return window.confirm(t(LEAVE_WITH_UNSAVED_CHANGES))
  }, [t])

  const value = useMemo(() => ({ set, confirmLeave }), [set, confirmLeave])
  return <UnsavedChangesContext value={value}>{children}</UnsavedChangesContext>
}

function useUnsavedChangesContext(): UnsavedChanges {
  const context = useContext(UnsavedChangesContext)
  if (!context) throw new Error('needs an <UnsavedChangesProvider> (AppShell has one)')
  return context
}

/**
 * Marks the calling page as having unsaved changes while `dirty` is true: links in the app
 * then ask before leaving, and so does the browser on reload or close.
 */
export function useUnsavedChanges(dirty: boolean) {
  const { set } = useUnsavedChangesContext()
  const key = useRef(Symbol('unsaved changes')).current

  useEffect(() => {
    set(key, dirty)
    return () => set(key, false)
  }, [set, key, dirty])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers show the prompt only when returnValue is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}

/** Asks before leaving when something is unsaved; true when it is fine to leave. */
export function useConfirmLeave(): () => boolean {
  return useUnsavedChangesContext().confirmLeave
}

/**
 * Whether a click on `anchor` would take the app from `current` (the router's location) to
 * another page, and so should ask first: a plain left click on a link to another path of
 * this site, opening in this tab. Hash links on the same page, new-tab clicks, downloads and
 * other sites are left alone.
 */
export function leavesPage(
  event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  anchor: HTMLAnchorElement,
  current: { pathname: string; search: string },
): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false
  }
  const target = anchor.getAttribute('target')
  if ((target && target !== '_self') || anchor.hasAttribute('download')) return false
  const href = anchor.getAttribute('href')
  if (href === null) return false
  const here = new URL(current.pathname + current.search, window.location.origin)
  const url = new URL(href, here)
  if (url.origin !== here.origin) return false
  return url.pathname !== here.pathname || url.search !== here.search
}
