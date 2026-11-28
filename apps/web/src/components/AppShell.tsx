import { type MouseEvent, Suspense, useEffect, useRef, useState } from 'react'
import { Link, matchPath, NavLink, Outlet, useLocation, useOutletContext } from 'react-router'
import { errorMessage } from '../api/errors.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { AppNotFoundPage } from '../pages/NotFound.tsx'
import { PATHS } from '../paths.ts'
import { useMe, useSession } from '../session.tsx'
import { TeamManagementProvider, useTeamManagementAccess } from '../team-management.tsx'
import { leavesPage, useConfirmLeave } from '../unsaved-changes.tsx'
import { AccountMenu } from './AccountMenu.tsx'
import { JoinedTeamNotice } from './JoinedTeamNotice.tsx'
import { LegalLinks, useInstance } from './LegalLinks.tsx'
import { Logo } from './Logo.tsx'
import { PageSkeleton } from './PageSkeleton.tsx'
import { ShellIcon, type ShellIconName } from './ShellIcon.tsx'
import { SpaceSwitcher } from './SpaceSwitcher.tsx'
import { useShellDisclosure } from './use-shell-disclosure.ts'

const PRIMARY_NAV = [
  { to: PATHS.eventTypes, label: 'Event types', icon: 'event' },
  { to: PATHS.availability, label: 'Availability', icon: 'clock' },
  { to: PATHS.bookings, label: 'Bookings', icon: 'booking' },
  { to: PATHS.meetingPolls, label: 'Meeting polls', icon: 'poll' },
  { to: PATHS.workflows, label: 'Workflows', icon: 'workflow' },
  { to: PATHS.teamBookings, label: 'Team bookings', icon: 'team' },
  { to: PATHS.analytics, label: 'Booking activity', icon: 'activity' },
  { to: PATHS.auditLog, label: 'Audit log', icon: 'audit' },
  { to: PATHS.settings, label: 'Settings', icon: 'settings' },
] as const

const INTEGRATION_NAV = [
  { to: PATHS.conferences, label: 'Conference accounts', icon: 'camera' },
  { to: PATHS.calendars, label: 'Calendars', icon: 'calendar' },
  { to: PATHS.apiKeys, label: 'API keys', icon: 'key' },
  { to: PATHS.connectedApps, label: 'Connected apps', icon: 'plug' },
] as const

const ROUTING_FORM_NAV = {
  to: PATHS.routingForms,
  label: 'Routing forms',
  icon: 'routing',
} as const

const WIDE_PAGES: readonly string[] = [...PRIMARY_NAV, ...INTEGRATION_NAV]
  .map(({ to }) => to)
  .filter((to) => to !== PATHS.settings && to !== PATHS.workflows)

export type AppShellContext = {
  workflowsEnabled: boolean | undefined
  routingFormsEnabled: boolean | undefined
  followUpHostNotesEnabled: boolean
  ssoOidcEnabled: boolean | undefined
  ssoSamlEnabled: boolean | undefined
  /**
   * The setting is off, but the server still reports stored SSO state for this session:
   * the read, recovery and trust-reducing views stay available. Undefined while loading.
   */
  ssoStored: boolean | undefined
  showSsoSettings: boolean
  scimResourcesEnabled: boolean
  teamOwnershipTransferEnabled: boolean
}

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

function ShellNavLink({
  to,
  label,
  icon,
  onClick,
}: {
  to: string
  label: string
  icon: ShellIconName
  onClick?: () => void
}) {
  return (
    <li>
      <NavLink to={to} onClick={onClick}>
        <ShellIcon name={icon} />
        <span>{label}</span>
      </NavLink>
    </li>
  )
}

function IntegrationNav({ pathname }: { pathname: string }) {
  const { t } = useI18n()
  const menu = useShellDisclosure()
  const current = INTEGRATION_NAV.some(({ to }) => matchPath(to, pathname))

  return (
    <section className="integration-nav" aria-label={t('Integrations')}>
      <p className="integration-heading" aria-hidden="true">
        {t('Integrations')}
      </p>
      <div {...menu.containerProps}>
        <button
          type="button"
          className="integration-toggle"
          aria-current={current && !menu.open ? 'location' : undefined}
          {...menu.triggerProps}
        >
          <ShellIcon name="plug" />
          {t('Integrations')}
          <ShellIcon name="chevron" />
        </button>
        <ul id={menu.panelId} className="integration-links">
          {INTEGRATION_NAV.map((item) => (
            <ShellNavLink
              key={item.to}
              {...item}
              label={t(item.label)}
              onClick={menu.open ? menu.closeAndRestoreFocus : undefined}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

/** The frame around signed-in pages: header, navigation and the page itself. */
export function AppShell() {
  return (
    <TeamManagementProvider>
      <Shell />
    </TeamManagementProvider>
  )
}

/** Use the shell's instance discovery, before mounting anything that can request a form. */
export function RequireRoutingForms() {
  const enabled = useOutletContext<{ routingFormsEnabled?: boolean } | undefined>()
    ?.routingFormsEnabled
  if (enabled === undefined) return <PageSkeleton />
  return enabled === true ? <Outlet /> : <AppNotFoundPage />
}

function Shell() {
  const { locale, t, ui } = useI18n()
  const teamAccess = useTeamManagementAccess()

  const me = useMe()
  // The shell already discovers instance policies. Use the same response for navigation
  // and the route gates so disabled and older instances make no additional request.
  const instance = useInstance()
  const workflowsEnabled =
    instance.status === 'loading'
      ? undefined
      : instance.status === 'ready' && instance.data?.workflowsEnabled === true
  const routingFormsEnabled =
    instance.status === 'loading'
      ? undefined
      : instance.status === 'ready' && instance.data?.routingFormsEnabled === true
  const managesTeam = teamAccess.status === 'ready' && teamAccess.role !== null
  const ssoOidcEnabled =
    instance.status === 'loading'
      ? undefined
      : instance.status === 'ready' && instance.data?.ssoOidcEnabled === true
  const ssoSamlEnabled =
    instance.status === 'loading'
      ? undefined
      : instance.status === 'ready' && instance.data?.ssoSamlEnabled === true
  const ssoStored =
    ssoOidcEnabled === undefined || ssoSamlEnabled === undefined
      ? undefined
      : !ssoOidcEnabled &&
        !ssoSamlEnabled &&
        (me.sso !== undefined || Boolean(me.ssoRecoveryTeams?.length))
  const managesSpace = me.principal.kind === 'session' && (me.organization.personal || managesTeam)
  const showWorkflows = workflowsEnabled === true && managesSpace
  const showRoutingForms = routingFormsEnabled === true && managesSpace
  const showMeetingPolls = me.organization.personal || managesTeam
  const showAuditLog =
    teamAccess.status === 'ready' &&
    teamAccess.roles?.some((role) => role === 'owner' || role === 'admin') === true
  const { signOut, notice, setNotice } = useSession()
  const [signOutError, setSignOutError] = useState<UiText | null>(null)
  const [spaceError, setSpaceError] = useState<UiText | null>(null)
  const [navEdges, setNavEdges] = useState({ start: true, end: true })
  const main = useRef<HTMLElement>(null)
  const primaryList = useRef<HTMLUListElement>(null)
  const location = useLocation()
  const { pathname } = location
  const widePage = WIDE_PAGES.includes(pathname) || matchPath(`${PATHS.eventTypes}/:id`, pathname)
  const shownPath = useRef(pathname)
  const confirmLeave = useConfirmLeave()

  // After navigating, start keyboard and screen reader users at the new page's content,
  // as a full page load would. Not on the first page: focus starts at the top then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: translated navigation widths change with locale
  useEffect(() => {
    // On narrow screens the navigation scrolls sideways; keep the current page's link in view.
    // scrollIntoView also changes the browser's sequential focus starting point, which
    // skips the skip link on the first Tab. Scroll only the navigation list horizontally.
    const list = primaryList.current
    if (list) keepActiveVisible(list)
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    setSpaceError(null)
    main.current?.focus()
  }, [pathname, locale])

  // Fade only the edges that hide more navigation, including after zoom or a locale change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: instance and role discovery can add navigation items after mount
  useEffect(() => {
    const list = primaryList.current
    if (!list) return
    const updateEdges = () => {
      const start = list.scrollLeft <= 1
      const end = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1
      setNavEdges((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      )
    }
    const updateLayout = () => {
      keepActiveVisible(list)
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
  }, [showWorkflows, showRoutingForms, showMeetingPolls, managesTeam, showAuditLog])

  // A notice belongs to one page: drop it once the person is elsewhere, also when it arrives
  // after they left. (Not on the page starting over in place, which is what it explains.)
  useEffect(() => {
    if (notice && notice.path !== null && notice.path !== pathname) setNotice(null)
  }, [notice, pathname, setNotice])
  const shownNotice =
    notice && !notice.joinedTeam && (notice.path === null || notice.path === pathname)
      ? notice.message
      : null

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
          {me.principal.kind === 'session' && (
            <div className="topbar-space">
              <SpaceSwitcher onError={setSpaceError} />
            </div>
          )}
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
        <div className="sidebar">
          <div className="sidebar-inner">
            <nav className="sidenav" aria-label={t('Main')}>
              <div
                className="sidenav-primary"
                data-scroll-start={navEdges.start}
                data-scroll-end={navEdges.end}
              >
                <ul ref={primaryList} data-layout-scroll="horizontal">
                  {(showRoutingForms ? [...PRIMARY_NAV, ROUTING_FORM_NAV] : PRIMARY_NAV)
                    .filter(({ to }) => {
                      if (to === PATHS.teamBookings) return managesTeam
                      if (to === PATHS.meetingPolls) return showMeetingPolls
                      if (to === PATHS.workflows) return showWorkflows
                      if (to === PATHS.auditLog) return showAuditLog
                      return true
                    })
                    .map((item) => (
                      <ShellNavLink key={item.to} {...item} label={t(item.label)} />
                    ))}
                </ul>
              </div>
              <IntegrationNav pathname={pathname} />
            </nav>
            <AccountMenu user={me.user} confirmLeave={confirmLeave} onSignOut={handleSignOut} />
          </div>
        </div>
        <main
          id="main"
          className={widePage ? 'main-content-wide' : 'main-content'}
          ref={main}
          tabIndex={-1}
        >
          <JoinedTeamNotice />
          {shownNotice && (
            <div className="alert alert-info notice">
              <p role={notice?.path === null ? 'status' : 'alert'}>{ui(shownNotice)}</p>
              <button type="button" className="button button-small" onClick={() => setNotice(null)}>
                {t('Dismiss')}
              </button>
            </div>
          )}
          <Suspense fallback={<PageSkeleton />}>
            <Outlet
              context={
                {
                  workflowsEnabled,
                  routingFormsEnabled,
                  followUpHostNotesEnabled:
                    instance.status === 'ready' && instance.data?.followUpHostNotesEnabled === true,
                  ssoOidcEnabled,
                  ssoSamlEnabled,
                  ssoStored,
                  scimResourcesEnabled:
                    instance.status === 'ready' && instance.data?.scimResourcesEnabled === true,
                  teamOwnershipTransferEnabled:
                    instance.status === 'ready' &&
                    instance.data?.teamOwnershipTransferEnabled === true,
                  showSsoSettings:
                    (ssoOidcEnabled === true ||
                      ssoSamlEnabled === true ||
                      (ssoStored === true && me.sso !== undefined)) &&
                    managesTeam &&
                    me.principal.kind === 'session',
                } satisfies AppShellContext
              }
            />
          </Suspense>
        </main>
      </div>
      {instance.status === 'ready' && <LegalLinks {...instance.data} />}
    </div>
  )
}
