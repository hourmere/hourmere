import './team-bookings.css'
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { EmptyState } from '../../components/EmptyState.tsx'
import { Field } from '../../components/forms.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { browserTimeZone, zoned } from '../../format.ts'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { BOOKING } from '../../limits.ts'
import { PATHS } from '../../paths.ts'
import { useMe, useSession } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { isMultiLineText } from '../../text.ts'
import { useConfirmLeave, useUnsavedChanges } from '../../unsaved-changes.tsx'

type Booking = Schemas['TeamAdminBooking']
type BookingPage = Schemas['TeamAdminBookingPage']
type Tab = 'upcoming' | 'past' | 'all'
type Query = {
  from?: string
  to?: string
  endAfter?: string
  endTo?: string
  status?: 'confirmed' | 'cancelled'
  order: 'asc' | 'desc'
  limit: number
}
const PAGE_SIZE = 25
const TIME_FILTERS = [
  { name: 'from', label: 'Starts at or after' },
  { name: 'to', label: 'Starts before' },
  { name: 'endAfter', label: 'Ends after' },
  { name: 'endTo', label: 'Ends at or before' },
] as const

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.status === 403 &&
    error.code === 'team_management_access_denied'
  )
}

export function TeamBookingsPage() {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  // The open form keeps its conflict and draft; later visits must reload before reading.
  const [openingContextError] = useState(access.contextError)
  const [expectedOrganizationId] = useState(me.organization.id)
  const [revoked, setRevoked] = useState(false)
  const confirmedAccess = useRef(false)
  useEffect(() => {
    if (access.status === 'ready' && access.role) confirmedAccess.current = true
  }, [access])
  const accessRevoked =
    revoked || (confirmedAccess.current && access.status === 'ready' && !access.role)
  const revoke = access.revoke
  const onRevoked = useCallback(() => {
    setRevoked(true)
    revoke()
  }, [revoke])
  usePageTitle('Team bookings')

  return (
    <div className="team-bookings-page">
      <PageHeader
        title={t('Team bookings')}
        lede={t(
          'Owners and admins can view this team’s bookings and cancel bookings before they start.',
        )}
      />
      <dl className="details team-bookings-context">
        <dt>{t('Team')}</dt>
        <dd className="user-content">
          {me.organization.personal ? t('Personal') : me.organization.name}
        </dd>
        <dt>{t('Your role')}</dt>
        <dd>
          {accessRevoked
            ? t('Access revoked')
            : access.status === 'ready'
              ? access.role === 'owner'
                ? t('Owner')
                : access.role === 'admin'
                  ? t('Admin')
                  : t('Not available')
              : access.status === 'loading'
                ? t('Loading your team role…')
                : t('Could not load your team role.')}
        </dd>
      </dl>
      {openingContextError ? (
        <OrganizationContextConflict error={openingContextError} />
      ) : accessRevoked ? (
        <Unavailable revoked />
      ) : access.status === 'loading' ? (
        <PageSkeleton label="Loading your team role…" />
      ) : access.status === 'error' ? (
        <div className="alert alert-error" role="alert">
          <p>{t('Could not load your team role.')}</p>
          <button type="button" className="button button-small" onClick={access.reload}>
            {t('Try again')}
          </button>
        </div>
      ) : !access.role ? (
        <Unavailable />
      ) : (
        <TeamBookingLists expectedOrganizationId={expectedOrganizationId} onRevoked={onRevoked} />
      )}
    </div>
  )
}

function Unavailable({ revoked = false }: { revoked?: boolean }) {
  const { t } = useI18n()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (revoked) heading.current?.focus()
  }, [revoked])
  return (
    <section className="panel" aria-labelledby="team-bookings-unavailable">
      <h2 id="team-bookings-unavailable" ref={heading} tabIndex={-1}>
        {revoked
          ? t('Team bookings access is no longer available.')
          : t('Team bookings are not available in this space.')}
      </h2>
      <p>
        {revoked
          ? t('Your team access may have changed. Return to your bookings or choose another space.')
          : t('Choose a team where you are an owner or admin to view its bookings.')}
      </p>
      <Link className="button" to={PATHS.bookings}>
        {t('Go to your bookings')}
      </Link>
    </section>
  )
}

function TeamBookingLists({
  expectedOrganizationId,
  onRevoked,
}: {
  expectedOrganizationId: string
  onRevoked: () => void
}) {
  const { t } = useI18n()
  const { reportContextChanged } = useTeamManagementAccess()
  const [params, setParams] = useSearchParams()
  const [conflict, setConflict] = useState<{ error: unknown; params: URLSearchParams } | null>(null)
  const displayedParams = conflict?.params ?? params
  const tab: Tab =
    displayedParams.get('tab') === 'past'
      ? 'past'
      : displayedParams.get('tab') === 'all'
        ? 'all'
        : 'upcoming'
  return (
    <>
      <nav className="tabs" aria-label={t('Team bookings')}>
        <ul>
          {(['upcoming', 'past', 'all'] as const).map((value) => (
            <li key={value}>
              <Link
                to={
                  value === 'upcoming' ? PATHS.teamBookings : `${PATHS.teamBookings}?tab=${value}`
                }
                className="tab"
                aria-current={value === tab ? 'page' : undefined}
                aria-disabled={!!conflict || undefined}
                onClick={(event) => {
                  if (conflict) event.preventDefault()
                }}
              >
                {value === 'upcoming'
                  ? t('Upcoming')
                  : value === 'past'
                    ? t('Past')
                    : t('All bookings')}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <BookingFilters
        key={`filters:${displayedParams.toString()}`}
        params={displayedParams}
        onApply={(next) => {
          if (!conflict) setParams(next)
        }}
        disabled={!!conflict}
      />
      <BookingList
        key={displayedParams.toString()}
        params={displayedParams}
        tab={tab}
        expectedOrganizationId={expectedOrganizationId}
        onRevoked={onRevoked}
        conflict={conflict?.error ?? null}
        onConflict={(error) => {
          reportContextChanged(error)
          setConflict({ error, params: new URLSearchParams(displayedParams) })
        }}
      />
    </>
  )
}

function localDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

function instant(value: string | null): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function BookingFilters({
  params,
  onApply,
  disabled,
}: {
  params: URLSearchParams
  onApply: (params: URLSearchParams) => void
  disabled: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  const confirmLeave = useConfirmLeave()
  const defaultOrder = params.get('tab') === 'past' ? 'desc' : 'asc'

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !confirmLeave()) return
    const fields = new FormData(event.currentTarget)
    const next = new URLSearchParams()
    if (params.has('tab')) next.set('tab', params.get('tab') ?? '')
    for (const { name } of TIME_FILTERS) {
      const value = instant(String(fields.get(name) ?? ''))
      if (value) next.set(name, value)
    }
    const status = fields.get('status')
    if (status === 'confirmed' || status === 'cancelled') next.set('status', status)
    const order = fields.get('order')
    if (order === 'asc' || order === 'desc') next.set('order', order)
    onApply(next)
  }

  return (
    <details className="panel team-bookings-filters">
      <summary>{t('Filter bookings')}</summary>
      <form onSubmit={submit}>
        <p className="hint">
          {t('Filter times use this browser’s time zone: {zone}.', { zone: browserTimeZone() })}
        </p>
        <fieldset className="field-grid team-booking-filter-fields" disabled={disabled}>
          <legend className="visually-hidden">{t('Filter bookings')}</legend>
          {TIME_FILTERS.map(({ name, label }) => (
            <Field key={name} id={`${id}-${name}`} label={t(label)} optional>
              {(props) => (
                <input
                  {...props}
                  name={name}
                  type="datetime-local"
                  defaultValue={localDateTime(params.get(name))}
                />
              )}
            </Field>
          ))}
          <Field id={`${id}-status`} label={t('Status')}>
            {(props) => (
              <select {...props} name="status" defaultValue={params.get('status') ?? ''}>
                <option value="">{t('All statuses')}</option>
                <option value="confirmed">{t('Confirmed')}</option>
                <option value="cancelled">{t('Cancelled')}</option>
              </select>
            )}
          </Field>
          <Field id={`${id}-order`} label={t('Order')}>
            {(props) => (
              <select {...props} name="order" defaultValue={params.get('order') ?? defaultOrder}>
                <option value="asc">{t('Oldest first')}</option>
                <option value="desc">{t('Newest first')}</option>
              </select>
            )}
          </Field>
        </fieldset>
        <p className="hint">
          {t(
            'Upcoming includes meetings in progress. Custom end-time filters replace the tab’s time range.',
          )}
        </p>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={disabled}>
            {t('Apply filters')}
          </button>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => {
              if (confirmLeave())
                onApply(
                  new URLSearchParams(params.has('tab') ? { tab: params.get('tab') ?? '' } : {}),
                )
            }}
          >
            {t('Clear filters')}
          </button>
        </div>
      </form>
    </details>
  )
}

function BookingList({
  params,
  tab,
  expectedOrganizationId,
  onRevoked,
  conflict,
  onConflict,
}: {
  params: URLSearchParams
  tab: Tab
  expectedOrganizationId: string
  onRevoked: () => void
  conflict: unknown
  onConflict: (error: unknown) => void
}) {
  const { t, ui, formatLocale } = useI18n()
  const loadedPages = useRef(1)
  const loadedSnapshot = useRef<BookingPage | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<UiText | null>(null)
  const [query] = useState<Query>(() => {
    const now = new Date().toISOString()
    const endAfter = instant(params.get('endAfter'))
    const endTo = instant(params.get('endTo'))
    const status = params.get('status')
    return {
      from: instant(params.get('from')),
      to: instant(params.get('to')),
      ...(endAfter || endTo
        ? { endAfter, endTo }
        : tab === 'upcoming'
          ? { endAfter: now }
          : tab === 'past'
            ? { endTo: now }
            : {}),
      ...(status === 'confirmed' || status === 'cancelled' ? { status } : {}),
      order:
        params.get('order') === 'desc' || (!params.has('order') && tab === 'past') ? 'desc' : 'asc',
      limit: PAGE_SIZE,
    }
  })
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        let page = await unwrap(api.GET('/api/v1/team/bookings', { params: { query }, signal }))
        for (let depth = 1; depth < loadedPages.current && page.nextCursor; depth += 1) {
          const next = await unwrap(
            api.GET('/api/v1/team/bookings', {
              params: { query: { ...query, cursor: page.nextCursor } },
              signal,
            }),
          )
          page = { data: [...page.data, ...next.data], nextCursor: next.nextCursor }
        }
        if (!signal.aborted) loadedSnapshot.current = page
        return page
      } catch (error) {
        if (!signal.aborted && isAccessDenied(error)) onRevoked()
        else if (!signal.aborted && loadedSnapshot.current) {
          setRefreshError(errorMessage(error))
          return loadedSnapshot.current
        }
        throw error
      } finally {
        if (!signal.aborted) setRefreshing(false)
      }
    },
    [query, onRevoked],
  )
  const [first, reload] = useLoad(load)
  const [more, setMore] = useState<(BookingPage & { source: BookingPage }) | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<UiText | null>(null)
  const [status, setStatus] = useState<UiText>('')
  const [selected, setSelected] = useState<Booking | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const moreController = useRef<AbortController | null>(null)
  const list = useRef<HTMLTableSectionElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const confirmLeave = useConfirmLeave()
  const format = zoned(browserTimeZone(), formatLocale)

  useEffect(() => () => moreController.current?.abort(), [])
  useEffect(() => {
    if (first.status !== 'ready') return
    setSelected((current) =>
      current ? (first.data.data.find((booking) => booking.id === current.id) ?? current) : null,
    )
  }, [first])
  useEffect(() => {
    if (!focusId) return
    list.current?.querySelector<HTMLButtonElement>(`[data-booking="${focusId}"]`)?.focus()
    setFocusId(null)
  }, [focusId])

  function closeDetails() {
    if (!confirmLeave()) return
    setSelected(null)
    setTimeout(() => opener.current?.focus())
  }

  if (first.status === 'loading') return <PageSkeleton label="Loading team bookings…" />
  if (first.status === 'error') {
    return (
      <div className="alert alert-error" role="alert">
        <p>
          {t('Could not load team bookings.')} {ui(first.message)}
        </p>
        <button type="button" className="button button-small" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  }

  const source = first.data
  const shown = more?.source === source ? more : source
  function refreshBookings() {
    moreController.current?.abort()
    setLoadingMore(false)
    setMoreError(null)
    setRefreshError(null)
    setRefreshing(true)
    reload()
  }
  async function loadMore() {
    if (!shown.nextCursor || loadingMore || refreshing || conflict) return
    const controller = new AbortController()
    moreController.current = controller
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await unwrap(
        api.GET('/api/v1/team/bookings', {
          params: { query: { ...query, cursor: shown.nextCursor } },
          signal: controller.signal,
        }),
      )
      if (controller.signal.aborted) return
      const data = [...shown.data, ...page.data]
      loadedPages.current += 1
      loadedSnapshot.current = { data, nextCursor: page.nextCursor }
      setMore({ data, nextCursor: page.nextCursor, source })
      setStatus(msg('Showing {0} bookings.', { '0': data.length }))
      if (page.data[0]) setFocusId(page.data[0].id)
    } catch (error) {
      if (controller.signal.aborted) return
      if (isAccessDenied(error)) onRevoked()
      else setMoreError(msg('Could not load more bookings. {0}', { '0': errorMessage(error) }))
    }
    if (!controller.signal.aborted) setLoadingMore(false)
  }

  return (
    <section className="team-bookings-list" aria-labelledby="team-bookings-list-heading">
      <h2 id="team-bookings-list-heading" className="visually-hidden" ref={heading} tabIndex={-1}>
        {t('Team bookings')}
      </h2>
      <p className="muted zone-note">
        {query.order === 'desc' ? t('Newest first. ') : t('Oldest first. ')}
        {t('Times are in {zone}, this browser’s time zone.', {
          zone: format.timeZone.replaceAll('_', ' '),
        })}
      </p>
      <p className="flash" role="status">
        {ui(status)}
      </p>
      {conflict !== null && <OrganizationContextConflict error={conflict} />}
      {refreshError && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load team bookings.')} {ui(refreshError)}
          </p>
          <button type="button" className="button button-small" onClick={refreshBookings}>
            {t('Try again')}
          </button>
        </div>
      )}
      {shown.data.length === 0 ? (
        <EmptyState title={t('No team bookings match these filters.')}>
          <p>
            {t('Try another time range or clear the filters. New team bookings will appear here.')}
          </p>
        </EmptyState>
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
                <th scope="col" className="fit">
                  {t('Status')}
                </th>
              </tr>
            </thead>
            <tbody ref={list}>
              {shown.data.map((booking) => {
                const invitee =
                  booking.attendees.find((person) => person.isBooker) ?? booking.attendees[0]
                return (
                  <tr key={booking.id}>
                    <td data-label={t('When')} className="fit booking-when">
                      <div className="table-value">
                        <time dateTime={booking.start}>
                          <span className="nowrap">{format.date(booking.start)}</span>{' '}
                          <span className="nowrap">
                            {format.timeRange(booking.start, booking.end)}
                          </span>
                        </time>
                      </div>
                    </td>
                    <th scope="row" data-label={t('Event')} className="user-content">
                      <button
                        type="button"
                        className="team-booking-open"
                        data-booking={booking.id}
                        aria-expanded={selected?.id === booking.id}
                        aria-controls={
                          selected?.id === booking.id ? 'team-booking-details' : undefined
                        }
                        onClick={(event) => {
                          if (!confirmLeave()) return
                          opener.current = event.currentTarget
                          setSelected(booking)
                        }}
                      >
                        {booking.eventType?.title ?? t('Deleted event type')}
                      </button>
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
                            {booking.attendees.length > 1 && (
                              <span className="muted">
                                {t(' + {0} guests', { '0': booking.attendees.length - 1 })}
                              </span>
                            )}
                          </>
                        ) : (
                          t('Unknown')
                        )}
                      </div>
                    </td>
                    <td data-label={t('Status')} className="fit">
                      <div className="table-value">
                        <span
                          className={`badge ${booking.status === 'cancelled' ? 'badge-danger' : 'badge-success'}`}
                        >
                          {booking.status === 'cancelled' ? t('Cancelled') : t('Confirmed')}
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {moreError && (
        <p className="alert alert-error" role="alert">
          {ui(moreError)}
        </p>
      )}
      {shown.nextCursor && (
        <div className="load-more">
          <button
            type="button"
            className="button"
            onClick={loadMore}
            disabled={loadingMore || refreshing || !!conflict}
          >
            {loadingMore ? t('Loading…') : t('Show more bookings')}
          </button>
        </div>
      )}
      {selected && (
        <BookingDetail
          key={selected.id}
          booking={selected}
          expectedOrganizationId={expectedOrganizationId}
          conflict={conflict}
          onConflict={(error) => {
            moreController.current?.abort()
            setLoadingMore(false)
            onConflict(error)
          }}
          onRevoked={onRevoked}
          onRefresh={refreshBookings}
          onClose={closeDetails}
          onCancelled={() => {
            const updated: BookingPage = {
              data:
                query.status === 'confirmed'
                  ? shown.data.filter((booking) => booking.id !== selected.id)
                  : shown.data.map((booking) =>
                      booking.id === selected.id ? { ...booking, status: 'cancelled' } : booking,
                    ),
              nextCursor: shown.nextCursor,
            }
            loadedSnapshot.current = updated
            setMore({ ...updated, source })
            setSelected(null)
            setStatus('The booking is cancelled.')
            refreshBookings()
            setTimeout(() => heading.current?.focus())
          }}
        />
      )}
    </section>
  )
}

function BookingDetail({
  booking,
  expectedOrganizationId,
  conflict,
  onConflict,
  onRevoked,
  onRefresh,
  onClose,
  onCancelled,
}: {
  booking: Booking
  expectedOrganizationId: string
  conflict: unknown
  onConflict: (error: unknown) => void
  onRevoked: () => void
  onRefresh: () => void
  onClose: () => void
  onCancelled: () => void
}) {
  const { t, formatLocale } = useI18n()
  const heading = useRef<HTMLHeadingElement>(null)
  const format = zoned(browserTimeZone(), formatLocale)
  useEffect(() => heading.current?.focus(), [])
  return (
    <section
      id="team-booking-details"
      className="panel team-booking-detail user-content"
      aria-labelledby="team-booking-detail-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <div className="team-booking-detail-header">
        <h2 id="team-booking-detail-heading" tabIndex={-1} ref={heading}>
          {t('Team booking details')}
        </h2>
        <button type="button" className="button button-small" onClick={onClose}>
          {t('Close details')}
        </button>
      </div>
      <dl className="details">
        <dt>{t('Booking ID')}</dt>
        <dd>{booking.id}</dd>
        <dt>{t('Event')}</dt>
        <dd>{booking.eventType?.title ?? t('Deleted event type')}</dd>
        <dt>{t('Event type ID')}</dt>
        <dd>{booking.eventType?.id ?? t('Not set')}</dd>
        <dt>{t('When')}</dt>
        <dd>
          <time dateTime={booking.start}>{format.dateTime(booking.start)}</time>
          {' – '}
          <time dateTime={booking.end}>{format.dateTime(booking.end)}</time>
        </dd>
        <dt>{t('Status')}</dt>
        <dd>{booking.status === 'cancelled' ? t('Cancelled') : t('Confirmed')}</dd>
        <dt>{t('Cancelled')}</dt>
        <dd>
          {booking.cancelledAt ? (
            <time dateTime={booking.cancelledAt}>{format.dateTime(booking.cancelledAt)}</time>
          ) : (
            t('Not set')
          )}
        </dd>
        <dt>{t('Hosts')}</dt>
        <dd>
          {booking.hosts.length ? (
            <ul className="plain-list">
              {booking.hosts.map((host) => (
                <li key={host.userId}>
                  {host.name}
                  <br />
                  <span className="muted">{t('Host ID: {0}', { '0': host.userId })}</span>
                </li>
              ))}
            </ul>
          ) : (
            t('None')
          )}
        </dd>
        <dt>{t('People')}</dt>
        <dd>
          {booking.attendees.length ? (
            <ul className="plain-list">
              {booking.attendees.map((person) => (
                <li key={person.email}>
                  {person.name}
                  {t(' ({detail})', { detail: person.isBooker ? t('Invitee') : t('Guest') })}
                  <br />
                  <a href={`mailto:${person.email}`}>
                    <BreakableText>{person.email}</BreakableText>
                  </a>
                  <br />
                  <span className="muted">
                    {t('Time zone: {zone}', { zone: person.timeZone.replaceAll('_', ' ') })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            t('None')
          )}
        </dd>
      </dl>
      {booking.status === 'confirmed' &&
        (new Date(booking.start).getTime() > Date.now() ? (
          <CancelBooking
            booking={booking}
            expectedOrganizationId={expectedOrganizationId}
            conflict={conflict}
            onConflict={onConflict}
            onRevoked={onRevoked}
            onRefresh={onRefresh}
            onCancelled={onCancelled}
          />
        ) : (
          <p className="hint">
            {t(
              'This booking has already started, so it can no longer be cancelled. Wait until it ends or coordinate with the hosts offline.',
            )}
          </p>
        ))}
    </section>
  )
}

function CancelBooking({
  booking,
  expectedOrganizationId,
  conflict,
  onConflict,
  onRevoked,
  onRefresh,
  onCancelled,
}: {
  booking: Booking
  expectedOrganizationId: string
  conflict: unknown
  onConflict: (error: unknown) => void
  onRevoked: () => void
  onRefresh: () => void
  onCancelled: () => void
}) {
  const { t, ui } = useI18n()
  const { confirmReload } = useSession()
  const { recheck } = useTeamManagementAccess()
  const mounted = useMounted()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<UiText | undefined>()
  const [error, setError] = useState<UiText | null>(null)
  const [busy, setBusy] = useState(false)
  const [alreadyCancelled, setAlreadyCancelled] = useState(false)
  const [started, setStarted] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const reasonInput = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<AbortController | null>(null)
  const formId = useId()
  const reasonId = useId()
  const cancelHeadingId = useId()
  useUnsavedChanges(open && reason.trim() !== '')
  useEffect(() => () => controller.current?.abort(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || conflict || alreadyCancelled || started) return
    setError(null)
    if (new Date(booking.start).getTime() <= Date.now()) {
      setError('This booking has already started, so it can no longer be cancelled.')
      return
    }
    const text = reason.trim()
    if (text.length > BOOKING.cancelReasonMaxLength) {
      setReasonError(
        msg('Use at most {0} characters (now {1}).', {
          '0': BOOKING.cancelReasonMaxLength,
          '1': text.length,
        }),
      )
      reasonInput.current?.focus()
      return
    }
    if (!isMultiLineText(text)) {
      setReasonError('Remove special control characters (tabs and line breaks are fine).')
      reasonInput.current?.focus()
      return
    }
    setReasonError(undefined)
    setBusy(true)
    controller.current = new AbortController()
    try {
      await unwrap(
        api.POST('/api/v1/team/bookings/{id}/cancel', {
          params: {
            path: { id: booking.id },
            header: { 'x-expected-organization-id': expectedOrganizationId },
          },
          body: text ? { reason: text } : {},
          signal: controller.current.signal,
        }),
      )
      if (!mounted.current) return
      setReason('')
      onCancelled()
      return
    } catch (failure) {
      if (!mounted.current) return
      if (isOrganizationContextChanged(failure)) onConflict(failure)
      else if (isAccessDenied(failure)) {
        try {
          const allowed = await recheck(controller.current.signal)
          if (!mounted.current || controller.current.signal.aborted) return
          if (!allowed) onRevoked()
          else {
            setStarted(true)
            setError(
              'This booking can no longer be cancelled. It may have started or become unavailable.',
            )
            onRefresh()
          }
        } catch (error) {
          if (!mounted.current || controller.current.signal.aborted) return
          setError(msg('Could not cancel the booking. {0}', { '0': errorMessage(error) }))
        }
      } else if (failure instanceof RequestError && failure.code === 'booking_in_past') {
        setStarted(true)
        setError('This booking has already started, so it can no longer be cancelled.')
        onRefresh()
      } else if (failure instanceof RequestError && failure.code === 'invalid_reason') {
        setReasonError(
          'Use at most 1000 characters, without control characters other than tabs and line breaks.',
        )
        reasonInput.current?.focus()
      } else if (failure instanceof RequestError && failure.code === 'booking_already_cancelled') {
        setAlreadyCancelled(true)
        setError('This booking was already cancelled. Reload to see the details.')
      } else setError(msg('Could not cancel the booking. {0}', { '0': errorMessage(failure) }))
    }
    if (mounted.current) setBusy(false)
  }

  return (
    <section className="team-booking-cancel" aria-labelledby={cancelHeadingId}>
      <h3 id={cancelHeadingId}>{t('Cancel this booking')}</h3>
      {!open ? (
        <>
          <p>
            {t(
              'The time becomes free again. The invitee can see that it is cancelled, and why if you give a reason, with their booking.',
            )}
          </p>
          <button
            ref={button}
            type="button"
            className="button"
            aria-controls={formId}
            aria-expanded={false}
            disabled={!!conflict}
            onClick={() => {
              setOpen(true)
              setTimeout(() => reasonInput.current?.focus())
            }}
          >
            {t('Cancel booking…')}
          </button>
        </>
      ) : (
        <form id={formId} onSubmit={submit} noValidate className="stack">
          <Field
            id={reasonId}
            label={t('Reason')}
            optional
            error={reasonError}
            hint={t('The invitee can see it. Up to {0} characters.', {
              '0': BOOKING.cancelReasonMaxLength,
            })}
          >
            {(props) => (
              <textarea
                {...props}
                ref={reasonInput}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          {error && (
            <p className="alert alert-error" role="alert">
              {ui(error)}
            </p>
          )}
          {alreadyCancelled && (
            <button type="button" className="button" onClick={confirmReload}>
              {t('Reload')}
            </button>
          )}
          <div className="form-actions">
            <button
              type="submit"
              className="button button-danger"
              disabled={busy || !!conflict || alreadyCancelled || started}
            >
              {busy ? t('Cancelling…') : t('Cancel booking')}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setReason('')
                setReasonError(undefined)
                setError(null)
                setTimeout(() => button.current?.focus())
              }}
            >
              {t('Keep booking')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
