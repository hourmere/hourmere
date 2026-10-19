import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { loadProfile } from '../api/resources.ts'
import { goTo } from '../browser.ts'
import { ConfirmAction } from '../components/ConfirmAction.tsx'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { leavesPage } from '../unsaved-changes.tsx'

type Connection = Schemas['CalendarConnection']
const load = async (signal: AbortSignal) => {
  const [connections, profile] = await Promise.all([
    unwrap(api.GET('/api/v1/calendar-connections', { signal })),
    loadProfile(signal),
  ])
  return { ...connections, hasProfile: profile !== null }
}
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
const noticeFor = (search: URLSearchParams): UiText | null => {
  const code = search.get('connection')
  return code && Object.hasOwn(outcomes, code)
    ? msg(outcomes[code as keyof typeof outcomes], {
        '0': search.get('provider') === 'microsoft' ? 'Microsoft' : 'Google',
      })
    : null
}

export function CalendarsPage() {
  const { t, ui, formatLocale: displayLocale } = useI18n()

  usePageTitle('Calendars')
  const [state, reload] = useLoad(load)
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
          ? 'Busy times synchronized.'
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
      <h1>{t('Calendars')}</h1>
      <p>
        {t(
          'Choose calendars whose busy times block bookings, and an owned calendar for new booking events. Existing meetings keep their original calendar when you change the destination.',
        )}
      </p>
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
      {state.status === 'loading' && <p role="status">{t('Loading calendars…')}</p>}
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
          {!state.data.hasProfile && (
            <p className="alert alert-info" id="calendar-profile-hint">
              {t('Create a profile before choosing where new bookings are written.')}{' '}
              <Link to={`${PATHS.settings}#profile-heading`}>{t('Create profile')}</Link>
            </p>
          )}
          {state.data.googleEnabled ? (
            <section className="stack" aria-label={t('Connect Google Calendar')}>
              <p>
                {t(
                  'Google will ask for your email, calendar list, event read access and permission to change events on calendars you own. Busy-time synchronization stores times and event IDs, without event titles or descriptions. Connecting is separate from signing in.',
                )}
              </p>
              <div>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending !== null}
                  onClick={() => connect()}
                >
                  {pending === 'connect' ? t('Opening Google…') : t('Connect Google Calendar')}
                </button>
              </div>
            </section>
          ) : (
            <p className="alert alert-info">
              {t(
                'Google Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
              )}
            </p>
          )}
          {state.data.microsoftEnabled ? (
            <section className="stack" aria-label={t('Connect Microsoft Calendar')}>
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
            <p className="alert alert-info">
              {t(
                'Microsoft Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
              )}
            </p>
          )}
          <section className="stack" aria-label={t('Connected accounts')}>
            <h2 ref={accountsHeading} tabIndex={-1}>
              {t('Connected accounts')}
            </h2>
            {state.data.data.length === 0 && <p>{t('No calendar accounts connected yet.')}</p>}
            {state.data.data.map((connection) => (
              <article className="panel stack" key={connection.id}>
                <h3>
                  {connection.accountEmail ?? t('{0} account', { '0': providerName(connection) })}
                </h3>
                <p>
                  {providerName(connection)} {t('Calendar')}
                </p>
                {(connection.status !== 'active' ||
                  connection.lastError === 'permissions_missing') && (
                  <p className="alert alert-error" role="alert">
                    {t('Access has expired or been removed. Connect this')}{' '}
                    {providerName(connection)} {t('account again to restore it.')}
                  </p>
                )}
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
                    <button
                      type="button"
                      className="button"
                      disabled={pending !== null || !state.data.googleEnabled}
                      onClick={() => connect('sync')}
                    >
                      {t('Enable calendar synchronization')}
                    </button>
                  </div>
                )}
                <ul className="calendar-list">
                  {connection.calendars.map((calendar) => (
                    <li className="calendar-item" key={calendar.id}>
                      <div id={`calendar-${calendar.id}`}>
                        {calendar.name}
                        {calendar.isPrimary ? t(' (primary)') : ''}
                      </div>
                      {(connection.syncAuthorized ||
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
                                state.data.hasProfile ? undefined : 'calendar-profile-hint'
                              }
                              disabled={
                                !state.data.hasProfile ||
                                (state.data.destinationCalendarId !== calendar.id &&
                                  (connection.status !== 'active' ||
                                    !state.data.googleEnabled ||
                                    !connection.syncAuthorized))
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
                {!connection.calendars.length && <p>{t('No calendars found in this account.')}</p>}
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
            ))}
          </section>
        </>
      )}
    </div>
  )
}
