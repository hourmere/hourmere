import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { goTo } from '../browser.ts'
import { ConfirmAction } from '../components/ConfirmAction.tsx'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'

type Connection = Schemas['CalendarConnection']
const load = (signal: AbortSignal) => unwrap(api.GET('/api/v1/calendar-connections', { signal }))
const outcomes = new Map([
  ['connected', 'Google Calendar connected. Your calendar list is ready.'],
  ['denied', 'Google Calendar was not connected because you cancelled authorization.'],
  ['invalid_state', 'This connection attempt expired or was already used. Start again.'],
  [
    'permissions_missing',
    'Google did not grant the requested access. Connect again and allow the calendar list.',
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

  useEffect(() => {
    if (search.has('connection')) setSearch({}, { replace: true })
  }, [search, setSearch])

  async function connect() {
    setPending('connect')
    setError(null)
    try {
      const { authorizationUrl } = await unwrap(
        api.POST('/api/v1/calendar-connections/google/authorize', { body: {} }),
      )
      if (!mounted.current) return
      const target = new URL(authorizationUrl)
      if (
        target.origin !== 'https://accounts.google.com' ||
        target.pathname !== '/o/oauth2/v2/auth'
      )
        throw new Error('Invalid authorization endpoint')
      goTo(target.href)
    } catch (err) {
      if (mounted.current) setError(`Could not connect Google Calendar. ${errorMessage(err)}`)
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
        Connect a Google account to see its calendars. Calendar events and busy times are not synced
        yet.
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
                Google will ask to share your account email and calendar list. Connecting is
                separate from signing in and does not allow Hourmere to read or change your events.
              </p>
              <div>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending !== null}
                  onClick={connect}
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
                <ul>
                  {connection.calendars.map((calendar) => (
                    <li key={calendar.id}>
                      {calendar.name}
                      {calendar.isPrimary ? ' (primary)' : ''}
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
