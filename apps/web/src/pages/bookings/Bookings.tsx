import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import { type Booking, loadProfile } from '../../api/resources.ts'
import { zoned } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
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
  const { t, ui } = useI18n()

  usePageTitle('Bookings')
  const [params] = useSearchParams()
  const tab: Tab = params.get('tab') === 'past' ? 'past' : 'upcoming'
  const [profile, reloadProfile] = useLoad(loadProfile)

  return (
    <>
      <h1>{t('Bookings')}</h1>
      <nav className="tabs" aria-label={t('Bookings')}>
        <ul>
          {TABS.map((t) => (
            <li key={t.tab}>
              <Link
                to={t.tab === 'upcoming' ? PATHS.bookings : `${PATHS.bookings}?tab=${t.tab}`}
                aria-current={t.tab === tab ? 'page' : undefined}
                className="tab"
              >
                {ui(t.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {profile.status === 'loading' && <p role="status">{t('Loading bookings…')}</p>}
      {profile.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load your bookings.')} {ui(profile.message)}
          </p>
          <button type="button" className="button button-small" onClick={reloadProfile}>
            {t('Try again')}
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
  const { t, ui, formatLocale: displayLocale } = useI18n()

  // Every page of a list uses the same moment, as the API's cursors require the same filters.
  const [now] = useState(() => new Date().toISOString())
  const range = tab === 'upcoming' ? { endAfter: now } : { endTo: now }
  const load = useCallback(
    async (signal: AbortSignal): Promise<ListState> => {
      const page = await unwrap(
        api.GET('/api/v1/bookings', {
          params: {
            query: {
              ...(tab === 'upcoming' ? { endAfter: now } : { endTo: now }),
              order: tab === 'past' ? 'desc' : 'asc',
              limit: PAGE_SIZE,
            },
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
  const [moreError, setMoreError] = useState<UiText | null>(null)
  const [status, setStatus] = useState<UiText>('')
  const [focusId, setFocusId] = useState<string | null>(null)
  const list = useRef<HTMLTableSectionElement>(null)
  const format = zoned(timeZone, displayLocale)

  useEffect(() => {
    if (!focusId) return
    list.current?.querySelector<HTMLElement>(`[data-booking="${focusId}"]`)?.focus()
    setFocusId(null)
  }, [focusId])

  if (first.status === 'loading') return <p role="status">{t('Loading bookings…')}</p>
  if (first.status === 'error') {
    return (
      <div className="alert alert-error" role="alert">
        <p>
          {t('Could not load your bookings.')} {ui(first.message)}
        </p>
        <button type="button" className="button button-small" onClick={reload}>
          {t('Try again')}
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
          params: {
            query: {
              ...range,
              order: tab === 'past' ? 'desc' : 'asc',
              limit: PAGE_SIZE,
              cursor: shown.nextCursor,
            },
          },
        }),
      )
      const bookings = [...shown.bookings, ...page.data]
      setMore({ bookings, nextCursor: page.nextCursor })
      setStatus(msg('Showing {0} bookings.', { '0': bookings.length }))
      // Continue from the first new booking.
      if (page.data[0]) setFocusId(page.data[0].id)
    } catch (err) {
      setMoreError(msg('Could not load more bookings. {0}', { '0': errorMessage(err) }))
    }
    setLoadingMore(false)
  }

  return (
    <section aria-labelledby="list-heading">
      <h2 id="list-heading" className="visually-hidden">
        {tab === 'upcoming' ? t('Upcoming bookings') : t('Past bookings')}
      </h2>
      <p className="muted zone-note">
        {tab === 'past' ? t('Newest first. ') : ''}
        {t('Times are in')} {format.timeZone.replaceAll('_', ' ')}
        {fromProfile ? (
          t(', your time zone.')
        ) : (
          <>
            {t(', this browser’s time zone.')}{' '}
            <Link to={PATHS.settings}>{t('Set your time zone')}</Link>.
          </>
        )}
      </p>
      {shown.bookings.length === 0 ? (
        <div className="empty">
          {tab === 'upcoming' ? (
            <>
              <p>{t('No upcoming bookings.')}</p>
              <p className="muted">
                {t('Share the links of your')} <Link to={PATHS.eventTypes}>{t('event types')}</Link>{' '}
                {t('so people can book you.')}
              </p>
            </>
          ) : (
            <p>{t('No past bookings yet.')}</p>
          )}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('When')}</th>
              <th scope="col">{t('Event')}</th>
              <th scope="col">{t('Invitee')}</th>
              <th scope="col">{t('Status')}</th>
            </tr>
          </thead>
          <tbody ref={list}>
            {shown.bookings.map((b) => {
              const invitee = b.attendees.find((a) => a.isBooker) ?? b.attendees[0]
              const guests = b.attendees.length - 1
              return (
                <tr key={b.id}>
                  <td data-label={t('When')}>
                    <time dateTime={b.start}>
                      <span className="nowrap">{format.date(b.start)}</span>{' '}
                      <span className="nowrap">{format.timeRange(b.start, b.end)}</span>
                    </time>
                  </td>
                  <th scope="row" data-label={t('Event')}>
                    <Link to={bookingPath(b.id)} data-booking={b.id}>
                      {b.title}
                    </Link>
                  </th>
                  <td data-label={t('Invitee')}>
                    {invitee ? (
                      <>
                        {invitee.name}
                        <br />
                        <span className="muted">{invitee.email}</span>
                        {guests > 0 && (
                          <span className="muted">
                            {' '}
                            + {guests} {guests === 1 ? t('guest') : t('guests')}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">{t('Unknown')}</span>
                    )}
                  </td>
                  <td data-label={t('Status')}>
                    {b.status === 'cancelled' && b.rescheduledToId ? (
                      <>
                        <span className="badge">{t('Rescheduled')}</span>
                        <br />
                        <Link to={bookingPath(b.rescheduledToId)}>
                          {t('View rescheduled booking')}
                        </Link>
                      </>
                    ) : b.status === 'cancelled' ? (
                      <span className="badge badge-danger">{t('Cancelled')}</span>
                    ) : (
                      <span className="badge badge-success">{t('Confirmed')}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="visually-hidden" role="status">
        {ui(status)}
      </p>
      {moreError && (
        <p className="alert alert-error" role="alert">
          {ui(moreError)}
        </p>
      )}
      {shown.nextCursor && (
        <div className="load-more">
          <button type="button" className="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? t('Loading…') : t('Show more bookings')}
          </button>
        </div>
      )}
    </section>
  )
}
