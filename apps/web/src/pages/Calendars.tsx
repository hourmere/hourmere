import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { goTo } from '../browser.ts'
import { ConfirmAction } from '../components/ConfirmAction.tsx'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { leavesPage } from '../unsaved-changes.tsx'

type Connection = Schemas['CalendarConnection']
const load = (signal: AbortSignal) => unwrap(api.GET('/api/v1/calendar-connections', { signal }))
const outcomes = new Map([
  ['connected', 'Google Calendar connected. Your calendar list is ready.'],
  ['denied', 'Google Calendar was not connected because you cancelled authorization.'],
  ['invalid_state', 'This connection attempt expired or was already used. Start again.'],
  [
    'permissions_missing',
    'Google did not grant the requested access. Connect again and allow the requested permissions.',
  ],
  ['needs_reauth', 'Google did not provide continuing access. Connect again to try again.'],
  ['provider_unavailable', 'Google Calendar could not be reached. Try connecting again shortly.'],
  ['session_required', 'Sign in again, then start a new calendar connection.'],
])

export function CalendarsPage() {
  usePageTitle('Calendars')
  const [state, reload] = useLoad(load)
  const [search, setSearch] = useSearchParams()
  const [notice, setNotice] = useState(() => outcomes.get(search.get('connection') ?? '') ?? null)
  const [error, setError] = useState<string | null>(null)
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

  async function connect(access: 'list' | 'sync' = 'sync') {
    connectionRequest.current?.abort()
    const request = new AbortController()
    connectionRequest.current = request
    const startedAt = window.location.pathname + window.location.search
    setPending('connect')
    setError(null)
    try {
      const { authorizationUrl } = await unwrap(
        api.POST('/api/v1/calendar-connections/google/authorize', {
          body: { access },
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
      if (
        target.origin !== 'https://accounts.google.com' ||
        target.pathname !== '/o/oauth2/v2/auth'
      )
        throw new Error('Invalid authorization endpoint')
      goTo(target.href)
    } catch (err) {
      if (mounted.current && !request.signal.aborted)
        setError(`Could not connect Google Calendar. ${errorMessage(err)}`)
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
          ? 'Google Calendar disconnected. Stored credentials and local calendar data were deleted.'
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
      <h1>Calendars</h1>
      <p>
        Choose calendars whose busy times block bookings, and an owned calendar for new booking
        events. Existing meetings keep their original calendar when you change the destination.
      </p>
      {notice && (
        <div className="alert alert-info">
          <p role="status">{notice}</p>
          <button type="button" className="button button-small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {state.status === 'loading' && <p role="status">Loading calendars…</p>}
      {state.status === 'error' && (
        <div className="alert alert-error">
          <p role="alert">{state.message}</p>
          <button type="button" className="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          {state.data.googleEnabled ? (
            <section className="stack" aria-label="Connect Google Calendar">
              <p>
                Google will ask for your email, calendar list, event read access and permission to
                change events on calendars you own. Busy-time synchronization stores times and event
                IDs, without event titles or descriptions. Connecting is separate from signing in.
              </p>
              <div>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending !== null}
                  onClick={() => connect()}
                >
                  {pending === 'connect' ? 'Opening Google…' : 'Connect Google Calendar'}
                </button>
              </div>
            </section>
          ) : (
            <p className="alert alert-info">
              Google Calendar is not configured on this Hourmere instance. Contact its administrator
              to enable it.
            </p>
          )}
          <section className="stack" aria-label="Connected accounts">
            <h2 ref={accountsHeading} tabIndex={-1}>
              Connected accounts
            </h2>
            {state.data.data.length === 0 && <p>No Google accounts connected yet.</p>}
            {state.data.data.map((connection) => (
              <article className="panel stack" key={connection.id}>
                <h3>{connection.accountEmail ?? 'Google account'}</h3>
                {connection.status !== 'active' && (
                  <p className="alert alert-error">
                    Access has expired or been removed. Connect this Google account again to restore
                    it.
                  </p>
                )}
                {!connection.syncAuthorized && (
                  <div className="stack">
                    <p>
                      This connection has calendar-list access only. Enable synchronization to use
                      busy times and write booking events.
                    </p>
                    <button
                      type="button"
                      className="button"
                      disabled={pending !== null || !state.data.googleEnabled}
                      onClick={() => connect('sync')}
                    >
                      Enable calendar synchronization
                    </button>
                  </div>
                )}
                <ul>
                  {connection.calendars.map((calendar) => (
                    <li key={calendar.id}>
                      {calendar.name}
                      {calendar.isPrimary ? ' (primary)' : ''}
                      {(connection.syncAuthorized ||
                        calendar.checkConflicts ||
                        state.data.destinationCalendarId === calendar.id) && (
                        <fieldset className="form-fieldset" disabled={pending !== null}>
                          <label className="choice">
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
                            Check conflicts in {calendar.name}
                          </label>
                          {calendar.checkConflicts && (
                            <>
                              <p>
                                {calendar.syncError
                                  ? 'Synchronization failed. Booking times stay unavailable until synchronization recovers.'
                                  : calendar.lastSyncedAt
                                    ? `Last synchronized: ${new Date(calendar.lastSyncedAt).toLocaleString()}`
                                    : 'Waiting for the first synchronization. Booking times stay unavailable until it completes.'}
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
                                Sync {calendar.name} now
                              </button>
                            </>
                          )}
                          {(calendar.accessRole === 'owner' ||
                            state.data.destinationCalendarId === calendar.id) && (
                            <button
                              type="button"
                              className="button button-small"
                              disabled={
                                state.data.destinationCalendarId !== calendar.id &&
                                (connection.status !== 'active' ||
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
                                ? `Stop writing bookings to ${calendar.name}`
                                : `Write new bookings to ${calendar.name}`}
                            </button>
                          )}
                        </fieldset>
                      )}
                    </li>
                  ))}
                </ul>
                {!connection.calendars.length && <p>No calendars found in this account.</p>}
                <fieldset className="form-fieldset" disabled={pending !== null}>
                  <div className="form-actions">
                    {state.data.googleEnabled && (
                      <button
                        type="button"
                        className="button"
                        disabled={pending !== null || connection.status !== 'active'}
                        onClick={() => update(connection, false)}
                      >
                        Refresh calendar list
                      </button>
                    )}
                    <ConfirmAction
                      label="Disconnect"
                      accessibleLabel={`Disconnect ${connection.accountEmail ?? 'Google account'}`}
                      prompt={`Disconnect ${connection.accountEmail ?? 'this Google account'}? This deletes stored credentials and local calendar data. You can also remove Hourmere’s access in Google Account settings.`}
                      confirmLabel="Disconnect account"
                      busyLabel="Disconnecting…"
                      failure="Could not disconnect Google Calendar."
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
