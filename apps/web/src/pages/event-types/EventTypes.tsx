import { isPublicTeamSlug } from '@hourmere/core/reserved'
import { Link } from 'react-router'
import {
  type EventType,
  loadEventTypes,
  loadProfile,
  loadSchedules,
  type Profile,
} from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { EmptyState } from '../../components/EmptyState.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useFlash } from '../../flash.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { formatMinutes } from '../../i18n/duration.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import {
  eventTypePath,
  PATHS,
  publicPageUrl,
  publicTeamPageUrl,
  TEAM_LINK_SLUG_HINT,
} from '../../paths.ts'
import { type Me, useMe } from '../../session.tsx'

async function loadPage(signal: AbortSignal) {
  const [eventTypes, profile, schedules] = await Promise.all([
    loadEventTypes(signal),
    loadProfile(signal),
    loadSchedules(signal),
  ])
  return { eventTypes, profile, hasSchedule: schedules.length > 0 }
}

export function EventTypesPage() {
  const { t, uiText } = useI18n()

  usePageTitle('Event types')
  const me = useMe()
  const [state, reload] = useLoad(loadPage)
  const message = useFlash()

  return (
    <>
      <PageHeader
        title={t('Event types')}
        lede={t('The kinds of meetings people can book with you, each with its own link.')}
      >
        <Link to={PATHS.newEventType} className="button button-primary">
          {t('New event type')}
        </Link>
      </PageHeader>
      <p className="flash" role="status">
        {uiText(message)}
      </p>

      {state.status === 'loading' && <PageSkeleton label="Loading event types…" />}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load your event types.')} {uiText(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <SetupHints me={me} profile={state.data.profile} hasSchedule={state.data.hasSchedule} />
          {state.data.eventTypes.length === 0 ? (
            <EmptyState
              title={t('You have no event types yet. Create one to start taking bookings.')}
              action={
                <Link to={PATHS.newEventType} className="button">
                  {t('Create your first event type')}
                </Link>
              }
            />
          ) : (
            <EventTypeTable
              eventTypes={state.data.eventTypes}
              me={me}
              profile={state.data.profile}
            />
          )}
        </>
      )}
    </>
  )
}

/** What is missing before anyone can book: a handle (for links) and a schedule (for times). */
function SetupHints({
  me,
  profile,
  hasSchedule,
}: {
  me: Me
  profile: Profile | null
  hasSchedule: boolean
}) {
  const { t } = useI18n()

  const handleHint = t('{0} to get booking links.').split('{0}')
  const scheduleHint = t('{0}, so there are times to book.').split('{0}')
  const needsHandle = me.organization.personal && !profile
  if (!needsHandle && hasSchedule) return null
  return (
    <div className="alert alert-info">
      <ul className="plain-list">
        {needsHandle && (
          <li>
            {handleHint[0]}
            <Link to={PATHS.settings}>{t('Choose your handle')}</Link>
            {handleHint[1]}
          </li>
        )}
        {!hasSchedule && (
          <li>
            {scheduleHint[0]}
            <Link to={PATHS.newSchedule}>{t('Set your weekly hours')}</Link>
            {scheduleHint[1]}
          </li>
        )}
      </ul>
    </div>
  )
}

function EventTypeTable({
  eventTypes,
  me,
  profile,
}: {
  eventTypes: EventType[]
  me: Me
  profile: Profile | null
}) {
  const { t, locale: displayLocale } = useI18n()

  return (
    <div className="table-container">
      <table className="table table-event-types">
        <thead>
          <tr>
            <th scope="col">{t('Title')}</th>
            <th scope="col" className="fit nowrap">
              {t('Duration')}
            </th>
            <th scope="col">{t('Booking link')}</th>
            <th scope="col" className="fit nowrap">
              {t('Status')}
            </th>
            <th scope="col" className="fit">
              <span className="visually-hidden">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {eventTypes.map((e) => {
            const url =
              e.ownerUserId === null &&
              !me.organization.personal &&
              ((e.schedulingType === 'individual' && e.hosts.length === 1) ||
                (e.schedulingType === 'collective' && e.hosts.length >= 2 && e.hosts.length <= 8) ||
                (e.schedulingType === 'round_robin' &&
                  e.roundRobinActive &&
                  e.hosts.length >= 1 &&
                  e.hosts.length <= 8)) &&
              isPublicTeamSlug(me.organization.slug)
                ? publicTeamPageUrl(me.organization.slug, e.slug)
                : profile && e.ownerUserId === me.user.id
                  ? publicPageUrl(profile.handle, e.slug)
                  : null
            const pathname = url ? new URL(url).pathname : ''
            return (
              <tr key={e.id} className={!e.isActive ? 'event-type-inactive' : undefined}>
                <th scope="row" data-label={t('Title')} className="user-content">
                  <Link to={eventTypePath(e.id)}>{e.title}</Link>
                </th>
                <td data-label={t('Duration')} className="fit nowrap">
                  <div className="table-value">
                    {formatMinutes(e.durationMinutes, displayLocale)}
                  </div>
                </td>
                <td data-label={t('Booking link')} className="link-cell user-content">
                  <div className="table-value">
                    {url ? (
                      <span className="booking-link">
                        <a
                          href={url}
                          title={url}
                          target="_blank"
                          rel="noreferrer"
                          className="mono booking-link-path"
                        >
                          <span className="booking-link-handle">
                            {pathname.slice(0, pathname.lastIndexOf('/'))}
                          </span>
                          <span className="booking-link-slug">/{encodeURIComponent(e.slug)}</span>
                          <span className="visually-hidden"> {t('(opens in a new tab)')}</span>
                        </a>
                        <CopyButton
                          text={url}
                          label={t('Copy link')}
                          accessibleLabel={t('Copy link for {0}', { '0': e.title })}
                        />
                      </span>
                    ) : (
                      <span className="muted">
                        {e.ownerUserId === null
                          ? e.schedulingType !== 'round_robin' &&
                            !isPublicTeamSlug(me.organization.slug)
                            ? TEAM_LINK_SLUG_HINT
                            : t('No public booking link')
                          : `/${e.slug}`}
                      </span>
                    )}
                  </div>
                </td>
                <td data-label={t('Status')} className="fit">
                  <div className="table-value">
                    {e.isHidden && <span className="badge">{t('Unlisted')}</span>}
                    {e.schedulingType === 'round_robin' && !e.roundRobinActive ? (
                      <span className="badge">{t('Needs activation')}</span>
                    ) : e.isActive ? (
                      <span className="badge badge-success">{t('Active')}</span>
                    ) : (
                      <span className="badge">{t('Inactive')}</span>
                    )}
                  </div>
                </td>
                <td className="actions">
                  <Link
                    to={eventTypePath(e.id)}
                    className="button button-small"
                    aria-label={t('Edit {0}', { '0': e.title })}
                  >
                    {t('Edit')}
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
