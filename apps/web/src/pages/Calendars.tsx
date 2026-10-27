import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { loadProfile, loadSchedules } from '../api/resources.ts'
import { goTo } from '../browser.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { ConfirmAction } from '../components/ConfirmAction.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { zoneName } from '../public/time.ts'
import { leavesPage } from '../unsaved-changes.tsx'

type Connection = Schemas['CalendarConnection']
const load = async (signal: AbortSignal) => {
  const [connections, profile] = await Promise.all([
    unwrap(api.GET('/api/v1/calendar-connections', { signal })),
    loadProfile(signal).catch((err: unknown) => {
      if (signal.aborted) throw err
      return undefined
    }),
  ])
  const schedules = connections.data.some(
    (connection) =>
      connection.provider === 'google' &&
      connection.calendars.some((calendar) => calendar.timeZone),
  )
    ? await loadSchedules(signal).catch((err: unknown) => {
        if (signal.aborted) throw err
        return []
      })
    : []
  return {
    ...connections,
    defaultScheduleZone: schedules.find((schedule) => schedule.isDefault)?.timeZone,
    hasProfile: profile !== null && profile !== undefined,
    profileUnavailable: profile === undefined,
  }
}
const loadInstance = (signal: AbortSignal) => unwrap(api.GET('/api/v1/instance', { signal }))
const outcomes = {
  connected: '{0} Calendar connected. Your calendar list is ready.',
  denied: '{0} Calendar was not connected because you cancelled authorization.',
  invalid_state: 'This connection attempt expired or was already used. Start again.',
  permissions_missing:
    '{0} did not grant the requested access. Connect again and allow the requested permissions.',
  needs_reauth: '{0} did not provide continuing access. Connect again to try again.',
  provider_unavailable: '{0} Calendar could not be reached. Try connecting again shortly.',
  session_required: 'Sign in again, then start a new calendar connection.',
} as const
const providerName = (connection: Connection) =>
  connection.provider === 'microsoft' ? 'Microsoft' : 'Google'
const needsReconnect = (connection: Connection) =>
  connection.status !== 'active' || connection.lastError === 'permissions_missing'
const syncSummary = (connection: Connection, googleEnabled: boolean): UiText => {
  if (connection.provider === 'microsoft') return 'Not available — calendar list only.'
  if (!connection.syncAuthorized) return 'Not enabled — calendar list only.'
  if (connection.status !== 'active') return 'Paused until you reconnect this account.'
  if (!googleEnabled) return 'Unavailable on this instance.'
  const selected = connection.calendars.filter((calendar) => calendar.checkConflicts)
  if (selected.some((calendar) => calendar.syncError))
    return 'Synchronization needs attention. Review the failed calendars below.'
  if (selected.some((calendar) => !calendar.lastSyncedAt))
    return 'Waiting for the first synchronization on selected calendars.'
  if (!selected.length) return 'No calendars selected for conflict checks.'
  return 'Latest synchronization of selected conflict calendars succeeded.'
}
const noticeFor = (search: URLSearchParams): UiText | null => {
  const code = search.get('connection')
  return code && Object.hasOwn(outcomes, code)
    ? msg(outcomes[code as keyof typeof outcomes], {
        '0': search.get('provider') === 'microsoft' ? 'Microsoft' : 'Google',
      })
    : null
}

export function CalendarsPage() {
  const { t, text, ui, formatLocale: displayLocale } = useI18n()

  usePageTitle('Calendars')
  const [state, reload] = useLoad(load)
  const [instance, reloadInstance] = useLoad(loadInstance)
  const [search, setSearch] = useSearchParams()
  const [notice, setNotice] = useState(() => noticeFor(search))
  const [error, setError] = useState<UiText | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const mounted = useMounted()
  const accountsHeading = useRef<HTMLHeadingElement>(null)
  const connectionRequest = useRef<AbortController | null>(null)
  const location = useLocation()
  const currentLocation = useRef(location)
  currentLocation.current = location

  useEffect(() => {
    const cancel = () => connectionRequest.current?.abort()
    const clicked = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (anchor instanceof HTMLAnchorElement && leavesPage(event, anchor, currentLocation.current))
        cancel()
    }
    // A suspended lazy route can keep this page mounted after navigation starts. Cancel
    // at the user's navigation intent, rather than waiting for React's eventual unmount.
    document.addEventListener('click', clicked, true)
    window.addEventListener('popstate', cancel)
    window.addEventListener('beforeunload', cancel)
    return () => {
      cancel()
      document.removeEventListener('click', clicked, true)
      window.removeEventListener('popstate', cancel)
      window.removeEventListener('beforeunload', cancel)
    }
  }, [])

  useEffect(() => {
    if (search.has('connection')) setSearch({}, { replace: true })
  }, [search, setSearch])

  async function connect(
    access: 'list' | 'sync' = 'sync',
    provider: 'google' | 'microsoft' = 'google',
  ) {
    connectionRequest.current?.abort()
    const request = new AbortController()
    connectionRequest.current = request
    const startedAt = window.location.pathname + window.location.search
    setPending(provider === 'google' ? 'connect' : 'connect-microsoft')
    setError(null)
    try {
      const { authorizationUrl } = await unwrap(
        provider === 'google'
          ? api.POST('/api/v1/calendar-connections/google/authorize', {
              body: { access },
              signal: request.signal,
            })
          : api.POST('/api/v1/calendar-connections/microsoft/authorize', {
              body: {},
              signal: request.signal,
            }),
      )
      if (
        !mounted.current ||
        request.signal.aborted ||
        window.location.pathname + window.location.search !== startedAt
      )
        return
      const target = new URL(authorizationUrl)
      const valid =
        provider === 'google'
          ? target.origin === 'https://accounts.google.com' &&
            target.pathname === '/o/oauth2/v2/auth'
          : target.origin === 'https://login.microsoftonline.com' &&
            target.pathname === '/common/oauth2/v2.0/authorize'
      if (!valid || target.username || target.password || target.hash)
        throw new Error('Invalid authorization endpoint')
      goTo(target.href)
    } catch (err) {
      if (mounted.current && !request.signal.aborted)
        setError(
          msg('Could not connect {0} Calendar. {1}', {
            '0': provider === 'google' ? 'Google' : 'Microsoft',
            '1': errorMessage(err),
          }),
        )
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  async function calendarAction(
    id: string,
    action: 'toggle' | 'sync' | 'destination',
    selected = false,
  ) {
    setPending(id)
    setError(null)
    try {
      if (action === 'toggle')
        await unwrap(
          api.PATCH('/api/v1/calendars/{id}', {
            params: { path: { id } },
            body: { checkConflicts: selected },
          }),
        )
      else if (action === 'sync')
        await unwrap(
          api.POST('/api/v1/calendars/{id}/sync', { params: { path: { id } }, body: {} }),
        )
      else
        await unwrap(
          api.PUT('/api/v1/calendar-destination', { body: { calendarId: selected ? null : id } }),
        )
      if (!mounted.current) return
      setNotice(
        action === 'sync'
          ? 'Busy times synchronized for this calendar.'
          : action === 'toggle'
            ? 'Conflict calendar selection saved.'
            : 'Booking calendar saved. New bookings use this destination; existing meetings keep theirs.',
      )
      reload()
    } catch (err) {
      if (mounted.current) {
        setError(errorMessage(err))
        reload()
      }
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  async function update(connection: Connection, disconnect: boolean) {
    setPending(connection.id)
    setError(null)
    try {
      if (disconnect)
        await unwrap(
          api.DELETE('/api/v1/calendar-connections/{id}', {
            params: { path: { id: connection.id } },
          }),
        )
      else
        await unwrap(
          api.POST('/api/v1/calendar-connections/{id}/refresh', {
            params: { path: { id: connection.id } },
            body: {},
          }),
        )
      if (!mounted.current) return
      setNotice(
        disconnect
          ? msg(
              '{0} Calendar disconnected. Stored credentials and local calendar data were deleted.',
              { '0': providerName(connection) },
            )
          : 'Calendar list refreshed.',
      )
      if (disconnect) accountsHeading.current?.focus()
      reload()
    } catch (err) {
      if (mounted.current) {
        setError(errorMessage(err))
        reload()
      }
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  return (
    <div className="page stack">
      <PageHeader
        title={t('Calendars')}
        lede={t(
          'Choose calendars whose busy times block bookings, and an owned calendar for new booking events. Existing meetings keep their original calendar when you change the destination.',
        )}
      />
      {notice && (
        <div className="alert alert-info">
          <p role="status">{ui(notice)}</p>
          <button type="button" className="button button-small" onClick={() => setNotice(null)}>
            {t('Dismiss')}
          </button>
        </div>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {ui(error)}
        </p>
      )}
      {state.status === 'loading' && <PageSkeleton label="Loading calendars…" />}
      {state.status === 'error' && (
        <div className="alert alert-error">
          <p role="alert">{ui(state.message)}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          {state.data.data.length > 0 && state.data.profileUnavailable && (
            <div className="alert alert-info" id="calendar-profile-hint">
              <p>
                {t(
                  'Could not load your profile. Try again before choosing where new bookings are written.',
                )}
              </p>
              <button type="button" className="button button-small" onClick={reload}>
                {t('Try again')}
              </button>
            </div>
          )}
          {state.data.data.length > 0 &&
            !state.data.hasProfile &&
            !state.data.profileUnavailable && (
              <p className="alert alert-info" id="calendar-profile-hint">
                {t('Create a profile before choosing where new bookings are written.')}{' '}
                <Link to={`${PATHS.settings}#profile-heading`}>{t('Create profile')}</Link>
              </p>
            )}
          <section className="stack" aria-label={t('Connected accounts')}>
            <h2 ref={accountsHeading} tabIndex={-1}>
              {t('Connected accounts')}
            </h2>
            {state.data.data.length === 0 && (
              <EmptyState
                title={t('No calendar accounts connected yet.')}
                action={
                  <>
                    <Link className="button button-primary" to={PATHS.eventTypes}>
                      {t('Set up event types')}
                    </Link>
                    {(state.data.googleEnabled || state.data.microsoftEnabled) && (
                      <a className="button" href="#calendar-connection-options">
                        {t('Review calendar connection options')}
                      </a>
                    )}
                  </>
                }
              >
                <p>
                  {t(
                    'Connecting a calendar is optional. Basic booking works without one. Set up an event type to start taking bookings.',
                  )}
                </p>
              </EmptyState>
            )}
            {state.data.data.map((connection) => {
              const reconnect = needsReconnect(connection)
              const syncCapable = connection.provider === 'google' && connection.syncAuthorized
              const conflictCount = connection.calendars.filter(
                (calendar) => calendar.checkConflicts,
              ).length
              const destination = connection.calendars.find(
                (calendar) => calendar.id === state.data.destinationCalendarId,
              )
              const destinationAvailable =
                destination &&
                syncCapable &&
                !reconnect &&
                state.data.googleEnabled &&
                destination.accessRole === 'owner'
              return (
                <article className="panel stack calendar-account" key={connection.id}>
                  <header className="calendar-account-heading">
                    <div>
                      <h3>
                        {connection.accountEmail ? (
                          <BreakableText>{connection.accountEmail}</BreakableText>
                        ) : (
                          t('{0} account', { '0': providerName(connection) })
                        )}
                      </h3>
                      <p>
                        {providerName(connection)} {t('Calendar')}
                      </p>
                    </div>
                    <span className={`badge${reconnect ? ' badge-danger' : ''}`}>
                      {reconnect ? t('Reconnect required') : t('Connected')}
                    </span>
                  </header>
                  {reconnect && (
                    <div className="alert alert-error">
                      <p role="alert">
                        {t('Access has expired or been removed. Connect this')}{' '}
                        {providerName(connection)} {t('account again to restore it.')}
                      </p>
                      <a
                        href={
                          connection.provider === 'microsoft'
                            ? '#microsoft-calendar-connection-options'
                            : '#calendar-connection-options'
                        }
                      >
                        {t('Review calendar connection options')}
                      </a>
                    </div>
                  )}
                  {connection.lastError === 'provider_unavailable' && (
                    <p className="alert alert-error" role="alert">
                      {t(
                        'The calendar provider could not be reached. Try refreshing the calendar list again.',
                      )}
                    </p>
                  )}
                  <dl className="calendar-account-summary">
                    <div>
                      <dt>{t('Busy-time sync')}</dt>
                      <dd>{ui(syncSummary(connection, state.data.googleEnabled))}</dd>
                    </div>
                    <div>
                      <dt>{t('Conflict checks')}</dt>
                      <dd>
                        {syncCapable
                          ? t('{0} selected', { '0': conflictCount })
                          : t('Not available')}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('New bookings')}</dt>
                      <dd>
                        {destination ? (
                          <>
                            {destination.name}
                            {!destinationAvailable && (
                              <span className="calendar-unavailable">
                                {t('Unavailable for new bookings')}
                              </span>
                            )}
                          </>
                        ) : (
                          t('Not written to this account')
                        )}
                      </dd>
                    </div>
                  </dl>
                  {connection.provider === 'microsoft' && (
                    <p>
                      {t(
                        'This connection lists calendars only. Busy-time synchronization and booking writes are not yet available.',
                      )}
                    </p>
                  )}
                  {connection.provider === 'google' && !connection.syncAuthorized && (
                    <div className="stack">
                      <p>
                        {t(
                          'This connection has calendar-list access only. Enable synchronization to use busy times and write booking events.',
                        )}
                      </p>
                      <a href="#calendar-connection-options">
                        {t('Review synchronization permissions')}
                      </a>
                    </div>
                  )}
                  <ul className="calendar-list">
                    {connection.calendars.map((calendar) => (
                      <li className="calendar-item" key={calendar.id}>
                        <h4 id={`calendar-${calendar.id}`}>
                          {calendar.name}
                          {calendar.isPrimary ? t(' (primary)') : ''}
                        </h4>
                        <dl className="calendar-purpose">
                          <div>
                            <dt>{t('Conflict checks')}</dt>
                            <dd>
                              {calendar.checkConflicts
                                ? t('Selected for conflict checks')
                                : t('Not used for conflict checks')}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('New bookings')}</dt>
                            <dd>
                              {state.data.destinationCalendarId === calendar.id
                                ? destinationAvailable
                                  ? t('Selected for new bookings')
                                  : t('Selected for new bookings — unavailable')
                                : t('Not a booking destination')}
                            </dd>
                          </div>
                        </dl>
                        {connection.provider === 'google' &&
                          calendar.accessRole === 'owner' &&
                          state.data.destinationCalendarId === calendar.id &&
                          calendar.timeZone &&
                          state.data.defaultScheduleZone &&
                          zoneName(calendar.timeZone) !==
                            zoneName(state.data.defaultScheduleZone) && (
                            <p className="alert alert-info">
                              {t(
                                'This Google calendar uses {calendarZone}; your availability uses {scheduleZone}. Bookings land at the same moment; Google Calendar usually shows them in {calendarZone} time.',
                                {
                                  calendarZone: zoneName(calendar.timeZone),
                                  scheduleZone: zoneName(state.data.defaultScheduleZone),
                                },
                              )}
                            </p>
                          )}
                        {connection.provider === 'google' &&
                          (connection.syncAuthorized ||
                            calendar.checkConflicts ||
                            state.data.destinationCalendarId === calendar.id) && (
                            <fieldset
                              className="form-fieldset calendar-controls"
                              aria-labelledby={`calendar-${calendar.id}`}
                              disabled={pending !== null}
                            >
                              <label className="checkbox">
                                <input
                                  type="checkbox"
                                  checked={calendar.checkConflicts}
                                  disabled={
                                    pending !== null ||
                                    (!calendar.checkConflicts &&
                                      (calendar.accessRole === 'freeBusyReader' ||
                                        connection.status !== 'active' ||
                                        !state.data.googleEnabled ||
                                        !connection.syncAuthorized))
                                  }
                                  onChange={(event) =>
                                    calendarAction(calendar.id, 'toggle', event.target.checked)
                                  }
                                />
                                {t('Check this calendar for conflicts')}
                              </label>
                              {calendar.checkConflicts && (
                                <>
                                  <p>
                                    {calendar.syncError
                                      ? t(
                                          'Synchronization failed. Booking times stay unavailable until synchronization recovers.',
                                        )
                                      : calendar.lastSyncedAt
                                        ? t('Last synchronized: {0}', {
                                            '0': new Date(calendar.lastSyncedAt).toLocaleString(
                                              displayLocale,
                                              { calendar: 'gregory' },
                                            ),
                                          })
                                        : t(
                                            'Waiting for the first synchronization. Booking times stay unavailable until it completes.',
                                          )}
                                  </p>
                                  <button
                                    type="button"
                                    className="button button-small"
                                    disabled={
                                      connection.status !== 'active' ||
                                      !state.data.googleEnabled ||
                                      !connection.syncAuthorized
                                    }
                                    onClick={() => calendarAction(calendar.id, 'sync')}
                                  >
                                    {t('Sync now')}
                                  </button>
                                </>
                              )}
                              {(calendar.accessRole === 'owner' ||
                                state.data.destinationCalendarId === calendar.id) && (
                                <button
                                  type="button"
                                  className="button button-small"
                                  aria-describedby={
                                    state.data.hasProfile ||
                                    state.data.destinationCalendarId === calendar.id
                                      ? undefined
                                      : 'calendar-profile-hint'
                                  }
                                  disabled={
                                    state.data.destinationCalendarId !== calendar.id &&
                                    (!state.data.hasProfile ||
                                      connection.status !== 'active' ||
                                      !state.data.googleEnabled ||
                                      !connection.syncAuthorized)
                                  }
                                  onClick={() =>
                                    calendarAction(
                                      calendar.id,
                                      'destination',
                                      state.data.destinationCalendarId === calendar.id,
                                    )
                                  }
                                >
                                  {state.data.destinationCalendarId === calendar.id
                                    ? t('Stop writing bookings here')
                                    : t('Write new bookings here')}
                                </button>
                              )}
                            </fieldset>
                          )}
                      </li>
                    ))}
                  </ul>
                  {!connection.calendars.length && (
                    <p>{t('No calendars found in this account.')}</p>
                  )}
                  <fieldset className="form-fieldset" disabled={pending !== null}>
                    <div className="form-actions">
                      {(connection.provider === 'google'
                        ? state.data.googleEnabled
                        : state.data.microsoftEnabled) && (
                        <button
                          type="button"
                          className="button"
                          disabled={pending !== null || connection.status !== 'active'}
                          onClick={() => update(connection, false)}
                        >
                          {t('Refresh calendar list')}
                        </button>
                      )}
                      <ConfirmAction
                        label={t('Disconnect')}
                        accessibleLabel={t('Disconnect {0}', {
                          '0': connection.accountEmail ?? `${providerName(connection)} account`,
                        })}
                        prompt={t(
                          'Disconnect {0}? This deletes stored credentials and local calendar data. You can also remove Hourmere’s access in {1} account settings.',
                          {
                            '0':
                              connection.accountEmail ?? `this ${providerName(connection)} account`,
                            '1': providerName(connection),
                          },
                        )}
                        confirmLabel={t('Disconnect account')}
                        busyLabel={t('Disconnecting…')}
                        failure={t('Could not disconnect {0} Calendar.', {
                          '0': providerName(connection),
                        })}
                        onConfirm={() => update(connection, true)}
                      />
                    </div>
                  </fieldset>
                </article>
              )
            })}
          </section>
          <h2>{t('Calendar connection options')}</h2>
          {state.data.googleEnabled ? (
            <section
              id="calendar-connection-options"
              tabIndex={-1}
              className="stack"
              aria-label={t('Connect Google Calendar')}
            >
              <div id="google-calendar-permissions" className="stack">
                <p>
                  {t(
                    'Google will ask for your email, calendar list and event access: to check busy times on selected calendars, and to create one private copy of each new booking on the calendar you own and select. Changing this destination affects new bookings; existing booking copies continue to be updated or cancelled on their original calendar. Automatic Google Meet adds a link only when you enable it. Busy-time synchronization stores times and event IDs, not event titles or descriptions. Connecting is optional and separate from signing in.',
                  )}
                </p>
                <p>
                  {text(
                    'Disconnect deletes stored credentials and local calendar data, but leaves existing event copies in Google Calendar and does not revoke your Google grant. You can revoke access in your Google Account:',
                  )}{' '}
                  <a
                    href="https://myaccount.google.com/connections"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('Google Account connections')}
                  </a>
                  {t('.')}
                </p>
                {instance.status === 'ready' && instance.data.privacyPolicyUrl && (
                  <p>
                    <a
                      href={instance.data.privacyPolicyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('Privacy policy')}
                    </a>
                  </p>
                )}
                {instance.status === 'error' && (
                  <div className="alert alert-error">
                    <p role="alert">
                      {t(
                        'Could not load privacy information. Try again before connecting Google Calendar.',
                      )}
                    </p>
                    <button type="button" className="button" onClick={reloadInstance}>
                      {t('Try again')}
                    </button>
                  </div>
                )}
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="button button-primary"
                  aria-describedby="google-calendar-permissions"
                  disabled={pending !== null || instance.status !== 'ready'}
                  onClick={() => connect()}
                >
                  {pending === 'connect' ? t('Opening Google…') : t('Connect Google Calendar')}
                </button>
                {state.data.data.some(
                  (connection) => connection.provider === 'google' && !connection.syncAuthorized,
                ) && (
                  <button
                    type="button"
                    className="button"
                    aria-describedby={
                      state.data.googleEnabled ? 'google-calendar-permissions' : undefined
                    }
                    disabled={
                      pending !== null || !state.data.googleEnabled || instance.status !== 'ready'
                    }
                    onClick={() => connect('sync')}
                  >
                    {t('Enable calendar synchronization')}
                  </button>
                )}
              </div>
            </section>
          ) : (
            <p id="calendar-connection-options" tabIndex={-1} className="alert alert-info">
              {t(
                'Google Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
              )}
            </p>
          )}
          {state.data.microsoftEnabled ? (
            <section
              id="microsoft-calendar-connection-options"
              tabIndex={-1}
              className="stack"
              aria-label={t('Connect Microsoft Calendar')}
            >
              <p>
                {t(
                  'Microsoft will ask for your account identity, continuing access and permission to read basic calendar details. This connection lists your calendars; busy-time synchronization and booking event writes are not yet available. Connecting is separate from signing in.',
                )}
              </p>
              <div>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending !== null}
                  onClick={() => connect('list', 'microsoft')}
                >
                  {pending === 'connect-microsoft'
                    ? t('Opening Microsoft…')
                    : t('Connect Microsoft Calendar')}
                </button>
              </div>
            </section>
          ) : (
            <p
              id="microsoft-calendar-connection-options"
              tabIndex={-1}
              className="alert alert-info"
            >
              {t(
                'Microsoft Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}
