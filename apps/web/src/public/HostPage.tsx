import { brandPalette } from '@hourmere/core/brand-contrast'
import { type CSSProperties, useCallback } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { formatDuration } from '../i18n/duration.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { literal } from '../i18n/translate.ts'
import { codeOf, failureMessage, getHost } from './api.ts'
import { locationLabel } from './BookingDetails.tsx'
import { collapseBlankLines } from './description.ts'
import {
  BrandLogo,
  HostAvatar,
  PublicLayout,
  PublicNotFound,
  PublicStatus,
} from './PublicLayout.tsx'
import './HostPage.css'
import { normalizedHandle, useRequest } from './paths.ts'

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
  const { host, eventTypes, branding } = state.data
  return (
    <PublicLayout branding={branding}>
      <header className="host-header">
        <HostAvatar name={host.name} image={host.image} />
        <h1>{host.name}</h1>
        {eventTypes.length > 0 && (
          <p className="muted">{t('Pick an event to see available times.')}</p>
        )}
      </header>
      {eventTypes.length ? (
        <ul className="event-list">
          {eventTypes.map((et) => {
            const palette = brandPalette(et.branding?.primaryColor)
            const style: Record<string, string> = {}
            if (palette) {
              for (const theme of ['light', 'dark'] as const) {
                for (const role of ['link', 'accent', 'focus'] as const) {
                  style[`--event-brand-${theme}-${role}`] = palette[theme][role]
                }
              }
            }
            return (
              <li key={et.slug}>
                <Link
                  className="event-card event-card-own-brand"
                  style={style as CSSProperties}
                  to={`/${handle}/${et.slug}`}
                >
                  {et.branding && <BrandLogo branding={et.branding} />}
                  {et.organizationName && (
                    <span className="event-card-meta">{et.organizationName}</span>
                  )}
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
            )
          })}
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
