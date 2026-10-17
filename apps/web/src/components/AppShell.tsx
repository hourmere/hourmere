import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { errorMessage } from '../api/errors.ts'
import { PATHS } from '../paths.ts'
import { useMe, useSession } from '../session.tsx'
import { leavesPage, UnsavedChangesProvider, useConfirmLeave } from '../unsaved-changes.tsx'
import { Logo } from './Logo.tsx'

export const NAV_ITEMS = [
  { to: PATHS.eventTypes, label: 'Event types' },
  { to: PATHS.availability, label: 'Availability' },
  { to: PATHS.bookings, label: 'Bookings' },
  { to: PATHS.calendars, label: 'Calendars' },
  { to: PATHS.apiKeys, label: 'API keys' },
  { to: PATHS.connectedApps, label: 'Connected apps' },
  { to: PATHS.settings, label: 'Settings' },
] as const

/** The frame around signed-in pages: header, navigation and the page itself. */
export function AppShell() {
  return (
    <UnsavedChangesProvider>
      <Shell />
    </UnsavedChangesProvider>
  )
}

function Shell() {
  const me = useMe()
  const { signOut, notice, setNotice } = useSession()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const main = useRef<HTMLElement>(null)
  const nav = useRef<HTMLElement>(null)
  const location = useLocation()
  const { pathname } = location
  const shownPath = useRef(pathname)
  const confirmLeave = useConfirmLeave()

  // After navigating, start keyboard and screen reader users at the new page's content,
  // as a full page load would. Not on the first page: focus starts at the top then.
  useEffect(() => {
    // On narrow screens the navigation scrolls sideways; keep the current page's link in view.
    // scrollIntoView also changes the browser's sequential focus starting point, which
    // skips the skip link on the first Tab. Scroll only the navigation list horizontally.
    const list = nav.current?.querySelector('ul')
    const selected = list?.querySelector('[aria-current="page"]')
    if (list && selected) {
      const left = list.getBoundingClientRect().left + list.clientLeft
      const right = left + list.clientWidth
      const item = selected.getBoundingClientRect()
      if (item.left < left) list.scrollLeft += item.left - left
      else if (item.right > right) list.scrollLeft += item.right - right
    }
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    main.current?.focus()
  }, [pathname])

  // A notice belongs to one page: drop it once the person is elsewhere, also when it arrives
  // after they left. (Not on the page starting over in place, which is what it explains.)
  useEffect(() => {
    if (notice && notice.path !== pathname) setNotice(null)
  }, [notice, pathname, setNotice])
  const shownNotice = notice?.path === pathname ? notice.message : null

  // A link that leaves a page with unsaved changes asks first (see unsaved-changes.tsx).
  // Capturing: this runs before the link's own handler, which then sees the click cancelled.
  function guardLinks(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest?.('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || !leavesPage(event, anchor, location)) return
    if (!confirmLeave()) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  async function handleSignOut() {
    if (!confirmLeave()) return
    setSignOutError(null)
    try {
      await signOut()
    } catch (err) {
      setSignOutError(`Could not sign out. ${errorMessage(err)}`)
    }
  }

  return (
    <div className="shell" onClickCapture={guardLinks}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to={PATHS.home} className="brand" aria-label="Hourmere home">
          <Logo />
        </Link>
        <div className="account">
          <span className="account-email" title={me.user.email}>
            {me.user.email}
          </span>
          <button type="button" className="button button-small" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>
      {signOutError && (
        <p className="alert alert-error shell-alert" role="alert">
          {signOutError}
        </p>
      )}
      <div className="layout">
        <nav className="sidenav" aria-label="Main" ref={nav}>
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" ref={main} tabIndex={-1}>
          {shownNotice && (
            <div className="alert alert-info notice">
              <p role="alert">{shownNotice}</p>
              <button type="button" className="button button-small" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}
