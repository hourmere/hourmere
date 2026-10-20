import { useCallback } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { literal } from '../i18n/translate.ts'
import { codeOf, failureMessage, getHost } from './api.ts'
import { locationLabel } from './BookingDetails.tsx'
import { collapseBlankLines } from './description.ts'
import { PublicLayout, PublicNotFound, PublicStatus } from './PublicLayout.tsx'
import { normalizedHandle, useRequest } from './paths.ts'
import { formatDuration } from './time.ts'

/** /{handle}: the host and the event types people can book with them. */
export function HostPage() {
  const raw = useParams().handle ?? ''
  const handle = normalizedHandle(raw)
  if (handle === undefined) return <PublicNotFound />
  // Handles are lowercase: /Ada becomes /ada.
  if (handle !== raw) return <Navigate to={`/${handle}`} replace />
  return <HostPageContent handle={handle} />
}

function HostPageContent({ handle }: { handle: string }) {
  const { t, ui, locale: displayLocale } = useI18n()

  const load = useCallback((signal: AbortSignal) => getHost(handle, signal), [handle])
  const [state, reload] = useRequest(load)
  usePageTitle(state.status === 'ready' ? literal(state.data.host.name) : 'Booking')

  if (state.status === 'loading') {
    return (
      <PublicLayout>
        <PublicStatus>{t('Loading…')}</PublicStatus>
      </PublicLayout>
    )
  }
  if (state.status === 'error') {
    if (codeOf(state.error) === 'host_not_found') return <PublicNotFound />
    return (
      <PublicLayout>
        <div className="card public-card">
          <p role="alert">{ui(failureMessage(state.error))}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </PublicLayout>
    )
  }
  const { host, eventTypes } = state.data
  return (
    <PublicLayout>
      <header className="host-header">
        <h1>{host.name}</h1>
        {eventTypes.length > 0 && (
          <p className="muted">{t('Pick an event to see available times.')}</p>
        )}
      </header>
      {eventTypes.length ? (
        <ul className="event-list">
          {eventTypes.map((et) => (
            <li key={et.slug}>
              <Link className="event-card" to={`/${handle}/${et.slug}`}>
                <span className="event-card-title">{et.title}</span>
                <span className="event-card-meta">
                  {formatDuration(et.durationMinutes, displayLocale)}
                  {et.location && ` · ${ui(locationLabel(et.location.kind))}`}
                </span>
                {et.description && (
                  <span className="event-card-description">
                    {collapseBlankLines(et.description)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          <p>
            {host.name} {t('has no events you can book right now.')}
          </p>
        </div>
      )}
    </PublicLayout>
  )
}
