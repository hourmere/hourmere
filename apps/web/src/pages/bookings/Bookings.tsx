import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import { type Booking, loadProfile } from '../../api/resources.ts'
import { zoned } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import { hostZone } from './booking-format.ts'

type Tab = 'upcoming' | 'past'

/** Bookings per page. */
export const PAGE_SIZE = 25

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'upcoming', label: 'Upcoming' },
  { tab: 'past', label: 'Past' },
]

export function BookingsPage() {
  usePageTitle('Bookings')
  const [params] = useSearchParams()
  const tab: Tab = params.get('tab') === 'past' ? 'past' : 'upcoming'
  const [profile, reloadProfile] = useLoad(loadProfile)

  return (
    <>
      <h1>Bookings</h1>
      <nav className="tabs" aria-label="Bookings">
        <ul>
          {TABS.map((t) => (
            <li key={t.tab}>
              <Link
                to={t.tab === 'upcoming' ? PATHS.bookings : `${PATHS.bookings}?tab=${t.tab}`}
                aria-current={t.tab === tab ? 'page' : undefined}
                className="tab"
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {profile.status === 'loading' && <p role="status">Loading bookings…</p>}
      {profile.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>Could not load your bookings. {profile.message}</p>
          <button type="button" className="button button-small" onClick={reloadProfile}>
            Try again
          </button>
        </div>
      )}
      {profile.status === 'ready' && (
        // A new list (and a new "now") for each tab.
        <BookingList key={tab} tab={tab} {...hostZone(profile.data)} />
      )}
    </>
  )
}

interface ListState {
  bookings: Booking[]
  nextCursor: string | null
}

function BookingList({
  tab,
  timeZone,
  fromProfile,
}: {
  tab: Tab
  timeZone: string
  fromProfile: boolean
}) {
  // Every page of a list uses the same moment, as the API's cursors require the same filters.
  const [now] = useState(() => new Date().toISOString())
  const range = tab === 'upcoming' ? { from: now } : { to: now }
  const load = useCallback(
    async (signal: AbortSignal): Promise<ListState> => {
      const page = await unwrap(
        api.GET('/api/v1/bookings', {
          params: {
            query: { ...(tab === 'upcoming' ? { from: now } : { to: now }), limit: PAGE_SIZE },
          },
          signal,
        }),
      )
      return { bookings: page.data, nextCursor: page.nextCursor }
    },
    [tab, now],
  )
  const [first, reload] = useLoad(load)
  const [more, setMore] = useState<ListState | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [focusId, setFocusId] = useState<string | null>(null)
  const list = useRef<HTMLTableSectionElement>(null)
  const format = zoned(timeZone)

  useEffect(() => {
    if (!focusId) return
    list.current?.querySelector<HTMLElement>(`[data-booking="${focusId}"]`)?.focus()
    setFocusId(null)
  }, [focusId])

  if (first.status === 'loading') return <p role="status">Loading bookings…</p>
  if (first.status === 'error') {
    return (
      <div className="alert alert-error" role="alert">
        <p>Could not load your bookings. {first.message}</p>
        <button type="button" className="button button-small" onClick={reload}>
          Try again
        </button>
      </div>
    )
  }

  const shown = more ?? first.data
  async function loadMore() {
    if (!shown.nextCursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await unwrap(
        api.GET('/api/v1/bookings', {
          params: { query: { ...range, limit: PAGE_SIZE, cursor: shown.nextCursor } },
        }),
      )
      const bookings = [...shown.bookings, ...page.data]
      setMore({ bookings, nextCursor: page.nextCursor })
      setStatus(`Showing ${bookings.length} bookings.`)
      // Continue from the first new booking.
      if (page.data[0]) setFocusId(page.data[0].id)
    } catch (err) {
      setMoreError(`Could not load more bookings. ${errorMessage(err)}`)
    }
    setLoadingMore(false)
  }

  return (
    <section aria-labelledby="list-heading">
      <h2 id="list-heading" className="visually-hidden">
        {tab === 'upcoming' ? 'Upcoming bookings' : 'Past bookings'}
      </h2>
      <p className="muted zone-note">
        {tab === 'past' ? 'Oldest first. ' : ''}Times are in {format.timeZone.replaceAll('_', ' ')}
        {fromProfile ? (
          ', your time zone.'
        ) : (
          <>
            , this browser’s time zone. <Link to={PATHS.settings}>Set your time zone</Link>.
          </>
        )}
      </p>
      {shown.bookings.length === 0 ? (
        <div className="empty">
          {tab === 'upcoming' ? (
            <>
              <p>No upcoming bookings.</p>
              <p className="muted">
                Share the links of your <Link to={PATHS.eventTypes}>event types</Link> so people can
                book you.
              </p>
            </>
          ) : (
            <p>No past bookings yet.</p>
          )}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Event</th>
              <th scope="col">Invitee</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody ref={list}>
            {shown.bookings.map((b) => {
              const invitee = b.attendees.find((a) => a.isBooker) ?? b.attendees[0]
              const guests = b.attendees.length - 1
              return (
                <tr key={b.id}>
                  <td data-label="When">
                    <time dateTime={b.start}>
                      <span className="nowrap">{format.date(b.start)}</span>{' '}
                      <span className="nowrap">{format.timeRange(b.start, b.end)}</span>
                    </time>
                  </td>
                  <th scope="row" data-label="Event">
                    <Link to={bookingPath(b.id)} data-booking={b.id}>
                      {b.title}
                    </Link>
                  </th>
                  <td data-label="Invitee">
                    {invitee ? (
                      <>
                        {invitee.name}
                        <br />
                        <span className="muted">{invitee.email}</span>
                        {guests > 0 && (
                          <span className="muted">
                            {' '}
                            + {guests} {guests === 1 ? 'guest' : 'guests'}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">Unknown</span>
                    )}
                  </td>
                  <td data-label="Status">
                    {b.status === 'cancelled' ? (
                      <span className="badge badge-danger">Cancelled</span>
                    ) : (
                      <span className="badge badge-success">Confirmed</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="visually-hidden" role="status">
        {status}
      </p>
      {moreError && (
        <p className="alert alert-error" role="alert">
          {moreError}
        </p>
      )}
      {shown.nextCursor && (
        <div className="load-more">
          <button type="button" className="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show more bookings'}
          </button>
        </div>
      )}
    </section>
  )
}
