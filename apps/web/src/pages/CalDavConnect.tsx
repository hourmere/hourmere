import { useEffect, useRef, useState } from 'react'
import { api, unwrap } from '../api/client.ts'
import { useI18n } from '../i18n/runtime.tsx'

interface CalendarChoice {
  key: string
  displayName: string
  color: string | null
  canWrite: boolean
}

/** Credentials live only in this form until save/cancel; provider errors are never rendered. */
export function CalDavConnect({
  connectionId,
  profileState,
  onClose,
  onSaved,
}: {
  connectionId?: string
  profileState: 'ready' | 'missing' | 'unknown'
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const [provider, setProvider] = useState('icloud')
  const [serverUrl, setServerUrl] = useState('https://caldav.icloud.com/')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [calendars, setCalendars] = useState<CalendarChoice[] | null>(null)
  const [conflicts, setConflicts] = useState<string[]>([])
  const [destination, setDestination] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
    return () => {
      request.current?.abort()
    }
  }, [])
  function close() {
    request.current?.abort()
    setPassword('')
    setUsername('')
    onClose()
  }
  async function submit() {
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setFailed(false)
    try {
      const credentials = {
        serverUrl,
        username,
        password,
        ...(connectionId ? { connectionId } : {}),
      }
      if (calendars) {
        await unwrap(
          api.POST('/api/v1/calendar-connections/caldav', {
            body: {
              ...credentials,
              calendarKeys: calendars.map((calendar) => calendar.key),
              conflictCalendarKeys: conflicts,
              destinationCalendarKey: destination || null,
            },
            signal: controller.signal,
          }),
        )
        if (controller.signal.aborted) return
        setPassword('')
        setUsername('')
        onSaved()
      } else {
        const result = await unwrap(
          api.POST('/api/v1/calendar-connections/caldav/discover', {
            body: credentials,
            signal: controller.signal,
          }),
        )
        if (controller.signal.aborted) return
        setCalendars(result.calendars)
        heading.current?.focus()
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  return (
    <section className="panel stack" aria-labelledby="caldav-form-heading">
      <h3 id="caldav-form-heading" tabIndex={-1} ref={heading}>
        {connectionId ? t('Reconnect CalDAV') : t('Connect CalDAV')}
      </h3>
      <p>
        {t(
          'CalDAV stores encrypted credentials and calendar metadata. Busy-time synchronization stores times, not event titles or attendees. Booking copies contain meeting details but do not send calendar invitations.',
        )}
      </p>
      <p>
        {t(
          'Disconnect stops synchronization and booking updates, deletes stored credentials and local calendar data, and leaves existing events on the server. Revoke the app password with your provider separately.',
        )}
      </p>
      {failed && (
        <p role="alert" className="alert alert-error">
          {t(
            'CalDAV could not complete this request. Check your server, app password and calendar permissions, then try again. Your saved connection has not been replaced by failed discovery.',
          )}
        </p>
      )}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <fieldset className="form-fieldset stack" disabled={pending}>
          {!calendars ? (
            <>
              <label className="field">
                <span>{t('CalDAV provider')}</span>
                <select
                  value={provider}
                  onChange={(event) => {
                    const value = event.target.value
                    setProvider(value)
                    setServerUrl(
                      value === 'icloud'
                        ? 'https://caldav.icloud.com/'
                        : value === 'fastmail'
                          ? 'https://caldav.fastmail.com/'
                          : '',
                    )
                  }}
                >
                  <option value="icloud">iCloud</option>
                  <option value="nextcloud">Nextcloud</option>
                  <option value="fastmail">Fastmail</option>
                  <option value="generic">{t('Other CalDAV server')}</option>
                </select>
              </label>
              {provider === 'icloud' && (
                <p>
                  {t(
                    'Use your Apple Account login and an app-specific password with two-factor authentication enabled. Never enter your primary Apple Account password. iCloud shard origins may need exact operator approval; real-account compatibility has not been verified.',
                  )}
                </p>
              )}
              {provider === 'nextcloud' && (
                <p>
                  {t(
                    'Use your Nextcloud DAV URL, including any installation prefix, ending in /remote.php/dav/. Use a dedicated app password. Private servers need operator configuration and verified HTTPS.',
                  )}
                </p>
              )}
              {provider === 'fastmail' && (
                <p>
                  {t(
                    'Use your full Fastmail username and an app password with calendar access. Basic plans do not support CalDAV.',
                  )}
                </p>
              )}
              <label className="field">
                <span>{t('CalDAV server URL')}</span>
                <input
                  type="url"
                  required
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  autoComplete="off"
                  placeholder="https://calendar.example.com/remote.php/dav/"
                />
              </label>
              <label className="field">
                <span>{t('CalDAV username')}</span>
                <input
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>{t('CalDAV app password')}</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </>
          ) : (
            <>
              <p>
                {t(
                  'Choose calendars to check for conflicts and optionally one writable calendar for new bookings. Existing bookings keep their original destination.',
                )}
              </p>
              {calendars.length === 0 && (
                <p>{t('No event calendars were found. Check the account and server URL.')}</p>
              )}
              {calendars.map((calendar) => (
                <label className="checkbox" key={calendar.key}>
                  <input
                    type="checkbox"
                    checked={conflicts.includes(calendar.key)}
                    onChange={(event) =>
                      setConflicts(
                        event.target.checked
                          ? [...conflicts, calendar.key]
                          : conflicts.filter((key) => key !== calendar.key),
                      )
                    }
                  />
                  {t('Check {0} for conflicts', { '0': calendar.displayName })}
                </label>
              ))}
              <label className="field">
                <span>{t('CalDAV booking destination')}</span>
                <select
                  disabled={profileState !== 'ready'}
                  aria-describedby={profileState !== 'ready' ? 'caldav-profile-hint' : undefined}
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                >
                  <option value="">{t('Do not write new bookings')}</option>
                  {calendars
                    .filter((calendar) => calendar.canWrite)
                    .map((calendar) => (
                      <option key={calendar.key} value={calendar.key}>
                        {calendar.displayName}
                      </option>
                    ))}
                </select>
              </label>
              {profileState !== 'ready' && (
                <p id="caldav-profile-hint">
                  {profileState === 'unknown'
                    ? t(
                        'Could not load your profile. Try again before choosing where new bookings are written.',
                      )
                    : t('Create a profile before choosing where new bookings are written.')}
                </p>
              )}
              <button
                type="button"
                className="button"
                onClick={() => {
                  setCalendars(null)
                  setConflicts([])
                  setDestination('')
                  setFailed(false)
                }}
              >
                {t('Edit CalDAV credentials')}
              </button>
            </>
          )}
          <div className="form-actions">
            <button type="submit" className="button button-primary">
              {pending
                ? t('Connecting CalDAV…')
                : calendars
                  ? t('Save CalDAV connection')
                  : t('Discover calendars')}
            </button>
          </div>
        </fieldset>
        <div>
          <button type="button" className="button" onClick={close}>
            {t('Cancel')}
          </button>
        </div>
        {pending && <p role="status">{t('Connecting CalDAV…')}</p>}
      </form>
    </section>
  )
}
