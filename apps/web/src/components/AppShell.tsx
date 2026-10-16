import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { errorMessage } from '../api/errors.ts'
import { useMe, useSession } from '../session.tsx'
import { Logo } from './Logo.tsx'

export const NAV_ITEMS = [
  { to: '/event-types', label: 'Event types' },
  { to: '/availability', label: 'Availability' },
  { to: '/bookings', label: 'Bookings' },
  { to: '/api-keys', label: 'API keys' },
  { to: '/settings', label: 'Settings' },
] as const

/** The frame around signed-in pages: header, navigation and the page itself. */
export function AppShell() {
  const me = useMe()
  const { signOut, notice, setNotice } = useSession()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const main = useRef<HTMLElement>(null)
  const nav = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  const shownPath = useRef(pathname)

  // After navigating, start keyboard and screen reader users at the new page's content,
  // as a full page load would. Not on the first page: focus starts at the top then.
  useEffect(() => {
    // On narrow screens the navigation scrolls sideways; keep the current page's link in view.
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    })
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    main.current?.focus()
    // A notice is about the page it was shown on.
    setNotice(null)
  }, [pathname, setNotice])

  async function handleSignOut() {
    setSignOutError(null)
    try {
      await signOut()
    } catch (err) {
      setSignOutError(`Could not sign out. ${errorMessage(err)}`)
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Hourmere home">
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
          {notice && (
            <div className="alert alert-info notice">
              <p role="alert">{notice}</p>
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
