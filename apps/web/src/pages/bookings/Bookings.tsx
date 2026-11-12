import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { isReadOnlyBooking } from '../../api/booking-policy.ts'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import { type Booking, loadProfile } from '../../api/resources.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { EmptyState } from '../../components/EmptyState.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { zoned } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { BOOKING } from '../../limits.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import { useMe } from '../../session.tsx'
import { BookingExport } from './BookingExport.tsx'
import { bookingTitle, hostZone } from './booking-format.ts'

type Tab = 'upcoming' | 'past' | 'cancelled'

/** Bookings per page. */
export const PAGE_SIZE = 25
/** How long typing pauses before the search runs. */
export const SEARCH_DELAY_MS = 300

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'upcoming', label: 'Upcoming' },
  { tab: 'past', label: 'Past' },
  { tab: 'cancelled', label: 'Cancelled' },
]

/**
 * The search a text asks for, as the API takes it: control characters (a pasted tab) become
 * spaces, then it is trimmed and cut to the bound without splitting a surrogate pair.
 */
export function searchText(text: string): string {
  let bounded = text
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, BOOKING.searchMaxLength)
  const last = bounded.charCodeAt(bounded.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1)
  return bounded.trimEnd()
}

/** The list's address: the tab (Upcoming by default) and the search, which every tab keeps. */
function listPath(tab: Tab, search: string): string {
  const params = new URLSearchParams()
  if (tab !== 'upcoming') params.set('tab', tab)
  if (search) params.set('q', search)
  const query = params.toString()
  return query ? `${PATHS.bookings}?${query}` : PATHS.bookings
}

export function BookingsPage() {
  const { t, ui } = useI18n()

  usePageTitle('Bookings')
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab: Tab = requested === 'past' || requested === 'cancelled' ? requested : 'upcoming'
  // The server trims and bounds the search as well; an over-long address only sends the bound.
  const search = searchText(params.get('q') ?? '')
  const [profile, reloadProfile] = useLoad(loadProfile)
  const searchInput = useRef<HTMLInputElement>(null)
  const [announcement, setAnnouncement] = useState<UiText>('')
  const applySearch = useCallback(
    (next: string) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current)
          if (next) updated.set('q', next)
          else updated.delete('q')
          return updated
        },
        { replace: true },
      ),
    [setParams],
  )
  // Each new search is announced afresh, even when its count matches the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the list changes
  useEffect(() => setAnnouncement(''), [tab, search])
  const announce = useCallback(
    (count: number, more: boolean) => {
      if (!search) return
      setAnnouncement(
        count === 0
          ? 'No bookings match your search.'
          : more
            ? msg('Matching bookings shown: {0}. More are available.', { '0': count })
            : msg('Matching bookings: {0}.', { '0': count }),
      )
    },
    [search],
  )

  return (
    <>
      <PageHeader title={t('Bookings')} lede={t('Review and manage the meetings you host.')} />
      <nav className="tabs bookings-tabs" aria-label={t('Bookings')}>
        <ul>
          {TABS.map((t) => (
            <li key={t.tab}>
              <Link
                to={listPath(t.tab, search)}
                aria-current={t.tab === tab ? 'page' : undefined}
                className="tab"
              >
                {ui(t.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <BookingSearch value={search} onSearch={applySearch} inputRef={searchInput} />
      <p className="visually-hidden" role="status">
        {ui(announcement)}
      </p>
      {profile.status === 'loading' && <PageSkeleton label="Loading bookings…" />}
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
        // A new list (and a new "now") for each tab and search.
        <BookingList
          key={`${tab}:${search}`}
          tab={tab}
          search={search}
          onLoaded={announce}
          onClearSearch={() => {
            // The empty state and its button go away; continue in the search box.
            searchInput.current?.focus()
            applySearch('')
          }}
          {...hostZone(profile.data)}
        />
      )}
    </>
  )
}

/**
 * The search box: it searches after a pause in typing (never mid-composition in an input
 * method), at once on Enter, and Escape clears it. `value` is the search in effect; the box
 * follows it only when it changes elsewhere (back, forward, Clear search, another link).
 */
function BookingSearch({
  value,
  onSearch,
  inputRef,
}: {
  value: string
  onSearch: (search: string) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const { t } = useI18n()
  const id = useId()
  const [text, setText] = useState(value)
  const [composing, setComposing] = useState(false)
  // The last search this box asked for: the address catches up with it after a moment, while
  // typing goes on, so only a different value comes from elsewhere.
  const submitted = useRef(value)
  const submit = useCallback(
    (next: string) => {
      submitted.current = next
      onSearch(next)
    },
    [onSearch],
  )

  useEffect(() => {
    if (value === submitted.current) return
    submitted.current = value
    setText(value)
  }, [value])
  useEffect(() => {
    if (composing) return
    const next = searchText(text)
    if (next === submitted.current) return
    const timer = setTimeout(() => submit(next), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, composing, submit])

  return (
    <search className="bookings-search">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit(searchText(text))
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-q`}>{t('Search bookings')}</label>
          <p className="hint" id={`${id}-hint`}>
            {t('Invitee name or email, or event type.')}
          </p>
          <input
            id={`${id}-q`}
            type="search"
            name="q"
            aria-describedby={`${id}-hint`}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={BOOKING.searchMaxLength}
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false)
              setText(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !text || event.nativeEvent.isComposing) return
              event.preventDefault()
              setText('')
              submit('')
            }}
          />
        </div>
      </form>
    </search>
  )
}

interface ListState {
  bookings: Booking[]
  nextCursor: string | null
}

/** The API filters of a tab: Upcoming and Past split at the end time; Cancelled by status. */
function tabFilters(tab: Tab, now: string) {
  if (tab === 'cancelled') return { status: 'cancelled' as const, order: 'desc' as const }
  return tab === 'upcoming'
    ? { endAfter: now, order: 'asc' as const }
    : { endTo: now, order: 'desc' as const }
}

function BookingList({
  tab,
  search,
  timeZone,
  fromProfile,
  onLoaded,
  onClearSearch,
}: {
  tab: Tab
  search: string
  timeZone: string
  fromProfile: boolean
  onLoaded: (count: number, more: boolean) => void
  onClearSearch: () => void
}) {
  const { t, ui, formatLocale: displayLocale } = useI18n()
  const me = useMe()

  // Every page of a list uses the same moment, as the API's cursors require the same filters.
  const [now] = useState(() => new Date().toISOString())
  const filters = tabFilters(tab, now)
  const query = { ...filters, ...(search ? { q: search } : {}) }
  const load = useCallback(
    async (signal: AbortSignal): Promise<ListState> => {
      const page = await unwrap(
        api.GET('/api/v1/bookings', {
          params: {
            query: {
              ...tabFilters(tab, now),
              ...(search ? { q: search } : {}),
              limit: PAGE_SIZE,
            },
          },
          signal,
        }),
      )
      return { bookings: page.data, nextCursor: page.nextCursor }
    },
    [tab, now, search],
  )
  const [first, reload] = useLoad(load)
  useEffect(() => {
    if (first.status === 'ready') onLoaded(first.data.bookings.length, !!first.data.nextCursor)
  }, [first, onLoaded])
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

  if (first.status === 'loading') return <PageSkeleton label="Loading bookings…" />
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
              ...query,
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

  // One sentence per language around the link, so Chinese keeps its punctuation unspaced.
  const share = t('Share the links of your {0} so people can book you.').split('{0}')
  // Both zone notes are whole templates, so the zh colon and brackets match between them.
  const zone = format.timeZone.replaceAll('_', ' ')
  const browserZoneNote = t('Times are in {zone}, this browser’s time zone. {0}.', { zone }).split(
    '{0}',
  )
  return (
    <section aria-labelledby="list-heading">
      <h2 id="list-heading" className="visually-hidden">
        {tab === 'upcoming'
          ? t('Upcoming bookings')
          : tab === 'past'
            ? t('Past bookings')
            : t('Cancelled bookings')}
      </h2>
      <p className="muted zone-note">
        {filters.order === 'desc' ? t('Newest first. ') : ''}
        {fromProfile ? (
          t('Times are in {zone}, your time zone.', { zone })
        ) : (
          <>
            {browserZoneNote[0]}
            <Link to={PATHS.settings}>{t('Set your time zone')}</Link>
            {browserZoneNote[1]}
          </>
        )}
      </p>
      {me.organization.personal &&
        // The CSV export has no search, so it would include bookings the search leaves out.
        (search ? (
          <p className="hint">{t('Clear the search to export bookings as CSV.')}</p>
        ) : (
          <BookingExport
            filters={filters}
            timeZone={timeZone}
            expectedOrganizationId={me.organization.id}
          />
        ))}
      {shown.bookings.length === 0 ? (
        search ? (
          <EmptyState
            title={t('No bookings match your search.')}
            action={
              <button type="button" className="button button-small" onClick={onClearSearch}>
                {t('Clear search')}
              </button>
            }
          >
            <p>{t('Try another name, email address or event type.')}</p>
          </EmptyState>
        ) : (
          <EmptyState
            title={
              tab === 'upcoming'
                ? t('No upcoming bookings.')
                : tab === 'past'
                  ? t('No past bookings yet.')
                  : t('No cancelled bookings.')
            }
            action={
              tab === 'upcoming' && (
                <p>
                  {share[0]}
                  <Link to={PATHS.eventTypes}>{t('event types')}</Link>
                  {share[1]}
                </p>
              )
            }
          />
        )
      ) : (
        <div className="table-container">
          <table className="table table-bookings">
            <thead>
              <tr>
                <th scope="col" className="fit">
                  {t('When')}
                </th>
                <th scope="col">{t('Event')}</th>
                <th scope="col">{t('Invitee')}</th>
                <th scope="col" className="fit nowrap">
                  {t('Status')}
                </th>
              </tr>
            </thead>
            <tbody ref={list}>
              {shown.bookings.map((b) => {
                const invitee = b.attendees.find((a) => a.isBooker) ?? b.attendees[0]
                const guests = b.attendees.length - 1
                return (
                  <tr key={b.id}>
                    <td data-label={t('When')} className="fit booking-when">
                      <div className="table-value">
                        <time dateTime={b.start}>
                          <span className="nowrap">{format.date(b.start)}</span>{' '}
                          <span className="nowrap">{format.timeRange(b.start, b.end)}</span>
                        </time>
                      </div>
                    </td>
                    <th scope="row" data-label={t('Event')} className="user-content">
                      <Link to={bookingPath(b.id)} data-booking={b.id}>
                        {ui(bookingTitle(b))}
                      </Link>
                    </th>
                    <td data-label={t('Invitee')} className="user-content">
                      <div className="table-value">
                        {invitee ? (
                          <>
                            {invitee.name}
                            <br />
                            <span className="muted">
                              <BreakableText>{invitee.email}</BreakableText>
                            </span>
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
                      </div>
                    </td>
                    <td data-label={t('Status')} className="fit">
                      <div className="table-value">
                        {isReadOnlyBooking(b) && <span className="badge">{t('Imported')}</span>}
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
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
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
