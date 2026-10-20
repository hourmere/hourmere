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
import { useFlash } from '../../flash.ts'
import { formatMinutes } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
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
  const { t, ui } = useI18n()

  usePageTitle('Event types')
  const me = useMe()
  const [state, reload] = useLoad(loadPage)
  const message = useFlash()

  return (
    <>
      <div className="page-header">
        <h1>{t('Event types')}</h1>
        <Link to={PATHS.newEventType} className="button button-primary">
          {t('New event type')}
        </Link>
      </div>
      <p className="lede">
        {t('The kinds of meetings people can book with you, each with its own link.')}
      </p>
      <p className="flash" role="status">
        {ui(message)}
      </p>

      {state.status === 'loading' && <p role="status">{t('Loading event types…')}</p>}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load your event types.')} {ui(state.message)}
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
            <div className="empty">
              <p>{t('You have no event types yet. Create one to start taking bookings.')}</p>
              <p>
                <Link to={PATHS.newEventType}>{t('Create your first event type')}</Link>
              </p>
            </div>
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

  const needsHandle = me.organization.personal && !profile
  if (!needsHandle && hasSchedule) return null
  return (
    <div className="alert alert-info">
      <ul className="plain-list">
        {needsHandle && (
          <li>
            <Link to={PATHS.settings}>{t('Choose your handle')}</Link> {t('to get booking links.')}
          </li>
        )}
        {!hasSchedule && (
          <li>
            <Link to={PATHS.newSchedule}>{t('Set your weekly hours')}</Link>
            {t(', so there are times to book.')}
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
            <th scope="col" className="nowrap">
              {t('Duration')}
            </th>
            <th scope="col">{t('Booking link')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col">
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
            return (
              <tr key={e.id}>
                <th scope="row" data-label={t('Title')}>
                  <Link to={eventTypePath(e.id)}>{e.title}</Link>
                </th>
                <td data-label={t('Duration')} className="nowrap">
                  <div className="table-value">
                    {formatMinutes(e.durationMinutes, displayLocale)}
                  </div>
                </td>
                <td data-label={t('Booking link')} className="link-cell">
                  <div className="table-value">
                    {url ? (
                      <span className="booking-link">
                        <a href={url} target="_blank" rel="noreferrer" className="mono">
                          {url.replace(/^https?:\/\//, '')}
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
                <td data-label={t('Status')}>
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
