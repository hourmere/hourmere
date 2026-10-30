import { type MouseEvent, Suspense, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { errorMessage } from '../api/errors.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { useMe, useSession } from '../session.tsx'
import { TeamManagementProvider, useTeamManagementAccess } from '../team-management.tsx'
import { leavesPage, useConfirmLeave } from '../unsaved-changes.tsx'
import { InstanceLegalLinks } from './LegalLinks.tsx'
import { Logo } from './Logo.tsx'
import { PageSkeleton } from './PageSkeleton.tsx'
import { SpaceSwitcher } from './SpaceSwitcher.tsx'

export const NAV_ITEMS = [
  { to: PATHS.eventTypes, label: 'Event types' },
  { to: PATHS.availability, label: 'Availability' },
  { to: PATHS.bookings, label: 'Bookings' },
  { to: PATHS.teamBookings, label: 'Team bookings' },
  { to: PATHS.analytics, label: 'Booking activity' },
  { to: PATHS.conferences, label: 'Conference accounts' },
  { to: PATHS.calendars, label: 'Calendars' },
  { to: PATHS.apiKeys, label: 'API keys' },
  { to: PATHS.connectedApps, label: 'Connected apps' },
  { to: PATHS.settings, label: 'Settings' },
] as const

const WIDE_PAGES: readonly string[] = NAV_ITEMS.map(({ to }) => to).filter(
  (to) => to !== PATHS.settings,
)

function keepActiveVisible(list: HTMLUListElement) {
  const selected = list.querySelector('[aria-current="page"]')
  if (!selected) return
  const style = getComputedStyle(list)
  const edge = list.getBoundingClientRect().left + list.clientLeft
  const left = edge + (Number.parseFloat(style.scrollPaddingInlineStart) || 0)
  const right = edge + list.clientWidth - (Number.parseFloat(style.scrollPaddingInlineEnd) || 0)
  const item = selected.getBoundingClientRect()
  if (item.left < left) list.scrollLeft += item.left - left
  else if (item.right > right) list.scrollLeft += item.right - right
}

/** The frame around signed-in pages: header, navigation and the page itself. */
export function AppShell() {
  return (
    <TeamManagementProvider>
      <Shell />
    </TeamManagementProvider>
  )
}

function Shell() {
  const { locale, t, ui } = useI18n()
  const teamAccess = useTeamManagementAccess()

  const me = useMe()
  const { signOut, notice, setNotice } = useSession()
  const [signOutError, setSignOutError] = useState<UiText | null>(null)
  const [spaceError, setSpaceError] = useState<UiText | null>(null)
  const [navEdges, setNavEdges] = useState({ start: true, end: true })
  const main = useRef<HTMLElement>(null)
  const nav = useRef<HTMLElement>(null)
  const location = useLocation()
  const { pathname } = location
  const shownPath = useRef(pathname)
  const confirmLeave = useConfirmLeave()

  // After navigating, start keyboard and screen reader users at the new page's content,
  // as a full page load would. Not on the first page: focus starts at the top then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: translated navigation widths change with locale
  useEffect(() => {
    // On narrow screens the navigation scrolls sideways; keep the current page's link in view.
    // scrollIntoView also changes the browser's sequential focus starting point, which
    // skips the skip link on the first Tab. Scroll only the navigation list horizontally.
    const list = nav.current?.querySelector('ul')
    if (list) keepActiveVisible(list)
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    setSpaceError(null)
    main.current?.focus()
  }, [pathname, locale])

  // Fade only the edges that hide more navigation, including after zoom or a locale change.
  useEffect(() => {
    const list = nav.current?.querySelector('ul')
    if (!list) return
    function updateEdges() {
      if (!list) return
      const start = list.scrollLeft <= 1
      const end = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1
      setNavEdges((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      )
    }
    function updateLayout() {
      if (list) keepActiveVisible(list)
      updateEdges()
    }
    updateLayout()
    list.addEventListener('scroll', updateEdges, { passive: true })
    window.addEventListener('resize', updateLayout)
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateLayout)
    observer?.observe(list)
    for (const item of list.children) observer?.observe(item)
    return () => {
      list.removeEventListener('scroll', updateEdges)
      window.removeEventListener('resize', updateLayout)
      observer?.disconnect()
    }
  }, [])

  // A notice belongs to one page: drop it once the person is elsewhere, also when it arrives
  // after they left. (Not on the page starting over in place, which is what it explains.)
  useEffect(() => {
    if (notice && notice.path !== null && notice.path !== pathname) setNotice(null)
  }, [notice, pathname, setNotice])
  const shownNotice =
    notice && (notice.path === null || notice.path === pathname) ? notice.message : null

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
      setSignOutError(msg('Could not sign out. {0}', { '0': errorMessage(err) }))
    }
  }

  return (
    <div className="shell" onClickCapture={guardLinks}>
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to={PATHS.home} className="brand" aria-label={t('Hourmere home')}>
            <Logo />
          </Link>
          <div className="account">
            <LanguageSwitcher compact />
            <span className="account-email" title={me.user.email}>
              {me.user.email}
            </span>
            <button type="button" className="button button-small" onClick={handleSignOut}>
              {t('Sign out')}
            </button>
            {me.principal.kind === 'session' && <SpaceSwitcher onError={setSpaceError} />}
          </div>
        </div>
      </header>
      {signOutError && (
        <p className="alert alert-error shell-alert" role="alert">
          {ui(signOutError)}
        </p>
      )}
      {spaceError && (
        <div className="alert alert-error shell-alert notice">
          <p role="alert">{ui(spaceError)}</p>
          <button type="button" className="button button-small" onClick={() => setSpaceError(null)}>
            {t('Dismiss')}
          </button>
        </div>
      )}
      <div className="layout">
        <nav
          className="sidenav"
          aria-label={t('Main')}
          ref={nav}
          data-scroll-start={navEdges.start}
          data-scroll-end={navEdges.end}
        >
          <ul data-layout-scroll="horizontal">
            {NAV_ITEMS.filter(
              (item) =>
                item.to !== PATHS.teamBookings ||
                (teamAccess.status === 'ready' && teamAccess.role !== null),
            ).map((item) => (
              <li key={item.to}>
                <NavLink to={item.to}>{ui(item.label)}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main
          id="main"
          className={WIDE_PAGES.includes(pathname) ? 'main-content-wide' : 'main-content'}
          ref={main}
          tabIndex={-1}
        >
          {shownNotice && (
            <div className="alert alert-info notice">
              <p role={notice?.path === null ? 'status' : 'alert'}>{ui(shownNotice)}</p>
              <button type="button" className="button button-small" onClick={() => setNotice(null)}>
                {t('Dismiss')}
              </button>
            </div>
          )}
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <InstanceLegalLinks />
    </div>
  )
}
