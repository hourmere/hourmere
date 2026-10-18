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
  usePageTitle('Event types')
  const me = useMe()
  const [state, reload] = useLoad(loadPage)
  const message = useFlash()

  return (
    <>
      <div className="page-header">
        <h1>Event types</h1>
        <Link to={PATHS.newEventType} className="button button-primary">
          New event type
        </Link>
      </div>
      <p className="lede">
        The kinds of meetings people can book with you, each with its own link.
      </p>
      <p className="flash" role="status">
        {message}
      </p>

      {state.status === 'loading' && <p role="status">Loading event types…</p>}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>Could not load your event types. {state.message}</p>
          <button type="button" className="button button-small" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <SetupHints me={me} profile={state.data.profile} hasSchedule={state.data.hasSchedule} />
          {state.data.eventTypes.length === 0 ? (
            <div className="empty">
              <p>You have no event types yet. Create one to start taking bookings.</p>
              <p>
                <Link to={PATHS.newEventType}>Create your first event type</Link>
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
  const needsHandle = me.organization.personal && !profile
  if (!needsHandle && hasSchedule) return null
  return (
    <div className="alert alert-info">
      <ul className="plain-list">
        {needsHandle && (
          <li>
            <Link to={PATHS.settings}>Choose your handle</Link> to get booking links.
          </li>
        )}
        {!hasSchedule && (
          <li>
            <Link to={PATHS.newSchedule}>Set your weekly hours</Link>, so there are times to book.
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
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">Duration</th>
          <th scope="col">Booking link</th>
          <th scope="col">Status</th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {eventTypes.map((e) => {
          const url =
            e.ownerUserId === null &&
            !me.organization.personal &&
            ((e.schedulingType === 'individual' && e.hosts.length === 1) ||
              (e.schedulingType === 'collective' && e.hosts.length >= 2 && e.hosts.length <= 8)) &&
            isPublicTeamSlug(me.organization.slug)
              ? publicTeamPageUrl(me.organization.slug, e.slug)
              : profile && e.ownerUserId === me.user.id
                ? publicPageUrl(profile.handle, e.slug)
                : null
          return (
            <tr key={e.id}>
              <th scope="row" data-label="Title">
                <Link to={eventTypePath(e.id)}>{e.title}</Link>
              </th>
              <td data-label="Duration">{formatMinutes(e.durationMinutes)}</td>
              <td data-label="Booking link" className="link-cell">
                {url ? (
                  <span className="booking-link">
                    <a href={url} target="_blank" rel="noreferrer" className="mono">
                      {url.replace(/^https?:\/\//, '')}
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                    <CopyButton
                      text={url}
                      label="Copy link"
                      accessibleLabel={`Copy link for ${e.title}`}
                    />
                  </span>
                ) : (
                  <span className="muted">
                    {e.ownerUserId === null
                      ? e.schedulingType !== 'round_robin' &&
                        !isPublicTeamSlug(me.organization.slug)
                        ? TEAM_LINK_SLUG_HINT
                        : 'No public booking link'
                      : `/${e.slug}`}
                  </span>
                )}
              </td>
              <td data-label="Status">
                {e.isHidden && <span className="badge">Unlisted</span>}
                {e.isActive ? (
                  <span className="badge badge-success">Active</span>
                ) : (
                  <span className="badge">Inactive</span>
                )}
              </td>
              <td className="actions">
                <Link
                  to={eventTypePath(e.id)}
                  className="button button-small"
                  aria-label={`Edit ${e.title}`}
                >
                  Edit
                </Link>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
