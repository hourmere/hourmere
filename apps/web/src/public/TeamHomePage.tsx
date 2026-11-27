import { useCallback } from 'react'
import { Link, useParams } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { formatDuration } from '../i18n/duration.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { literal } from '../i18n/translate.ts'
import { publicTeamEventPath, publicTeamHomePath } from '../paths.ts'
import { failureMessage, getTeamHome, PublicRequestError } from './api.ts'
import { locationLabel } from './BookingDetails.tsx'
import { collapseBlankLines } from './description.ts'
import { FocusHeading, PublicLayout, PublicStatus } from './PublicLayout.tsx'
import { teamSlug, useRequest } from './paths.ts'

const unavailableTitle = 'This team page is unavailable.'
const errorTitle = 'Couldn’t load this team page.'

function TeamHomeUnavailable() {
  const { t } = useI18n()
  usePageTitle(unavailableTitle)
  return (
    <div className="card public-card">
      <FocusHeading preserveFocus>{t(unavailableTitle)}</FocusHeading>
    </div>
  )
}

export function TeamHomePage() {
  const slug = teamSlug(useParams().teamSlug ?? '')
  return (
    <PublicLayout>
      {slug ? <TeamHomeContent key={slug} slug={slug} /> : <TeamHomeUnavailable />}
    </PublicLayout>
  )
}

function TeamHomeContent({ slug }: { slug: string }) {
  const { t, ui, locale } = useI18n()
  const load = useCallback((signal: AbortSignal) => getTeamHome(slug, signal), [slug])
  const [state, reload] = useRequest(load)
  const error = state.status === 'error' ? state.error : undefined
  const unavailable = error instanceof PublicRequestError && error.status === 404
  const title =
    state.status === 'ready'
      ? literal(state.data.team.name)
      : state.status === 'loading'
        ? 'Loading…'
        : unavailable
          ? unavailableTitle
          : errorTitle
  usePageTitle(title)

  if (state.status === 'loading') return <PublicStatus>{t('Loading…')}</PublicStatus>
  if (state.status === 'error') {
    if (unavailable) {
      return (
        <div className="card public-card">
          <FocusHeading preserveFocus>{t(unavailableTitle)}</FocusHeading>
        </div>
      )
    }
    return (
      <div className="card public-card">
        <FocusHeading preserveFocus>{t(errorTitle)}</FocusHeading>
        {error instanceof PublicRequestError && error.status === 429 && (
          <p>{ui(failureMessage(error))}</p>
        )}
        <button type="button" className="button" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  }

  const { team, eventTypes } = state.data
  const address = `${window.location.origin}${publicTeamHomePath(team.slug)}`
  return (
    <>
      <div className="host-header">
        <FocusHeading preserveFocus>
          <bdi>{team.name}</bdi>
        </FocusHeading>
        <p className="muted">
          <bdi dir="ltr">{address}</bdi>
        </p>
      </div>
      {eventTypes.length > 0 ? (
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics when list-style is none.
        <ul className="event-list" role="list">
          {eventTypes.map((event) => (
            <li key={event.slug}>
              <Link className="event-card" to={publicTeamEventPath(team.slug, event.slug)}>
                <span className="event-card-title">
                  <bdi>{event.title}</bdi>
                </span>
                <span className="event-card-meta">
                  {formatDuration(event.durationMinutes, locale)}
                  {event.location && ` · ${ui(locationLabel(event.location.kind))}`}
                </span>
                {event.description && (
                  <span className="event-card-description" dir="auto">
                    {collapseBlankLines(event.description)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          <p>{t('This team has no public events right now.')}</p>
        </div>
      )}
    </>
  )
}
