import { GroupOccurrenceAttendees } from '../bookings/GroupOccurrenceAttendees.tsx'
import {
  NoShowAttendees,
  type NoShowChange,
  NoShowRowControls,
  withNoShowChange,
} from '../bookings/NoShowAttendees.tsx'
import './team-bookings.css'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { loadProfile } from '../../api/resources.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { EmptyState } from '../../components/EmptyState.tsx'
import { Field } from '../../components/forms.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { isKnownTimeZone, zoned } from '../../format.ts'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { type MessageKey, msg, type UiText } from '../../i18n/translate.ts'
import { BOOKING } from '../../limits.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import { offsetAt, wallTime } from '../../public/time.ts'
import { useMe, useSession } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { isMultiLineText } from '../../text.ts'
import { useConfirmLeave, useUnsavedChanges } from '../../unsaved-changes.tsx'
import { BookingExport } from '../bookings/BookingExport.tsx'
import { BookingPanel, useBookingPanel, useBookingPanelTitle } from '../bookings/BookingPanel.tsx'
import { hostZone } from '../bookings/booking-format.ts'
import { ManualRebooking } from './ManualRebooking.tsx'
import {
  BulkCancellationCounts,
  BulkCancellationDialog,
  bulkResultTitle,
} from './TeamBookingBulkCancellation.tsx'
import { TeamBookingDetailPage } from './TeamBookingDetail.tsx'
import { MAX_BULK_SELECTION, useBulkBookingSelection } from './useBulkBookingSelection.ts'
import { useBulkCancellationReceipt } from './useBulkCancellationReceipt.ts'

type Booking = Schemas['TeamAdminBooking']
type BookingPage = Schemas['TeamAdminBookingPage']
type LoadedBookingPages = BookingPage & { activePage: BookingPage }
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
          {me.organization.personal ? t('Personal') : <bdi>{me.organization.name}</bdi>}
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
  const { t, ui } = useI18n()
  const [profile, reload] = useLoad(loadProfile)
  if (profile.status === 'loading') return <PageSkeleton label="Loading team bookings…" />
  if (profile.status === 'error') {
    return (
      <div className="alert alert-error" role="alert">
        <p>
          {t('Could not load team bookings.')} {ui(profile.message)}
        </p>
        <button type="button" className="button button-small" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  }
  return (
    <TeamBookingContent
      expectedOrganizationId={expectedOrganizationId}
      onRevoked={onRevoked}
      {...hostZone(profile.data)}
    />
  )
}

function TimeZoneNote({ timeZone, fromProfile }: { timeZone: string; fromProfile: boolean }) {
  const { t } = useI18n()
  const zone = timeZone.replaceAll('_', ' ')
  if (fromProfile) return t('Times are in {zone}, your time zone.', { zone })
  const note = t('Times are in {zone}, this browser’s time zone. {0}.', { zone }).split('{0}')
  return (
    <>
      {note[0]}
      <Link to={PATHS.settings}>{t('Set your time zone')}</Link>
      {note[1]}
    </>
  )
}

function TeamBookingContent({
  expectedOrganizationId,
  onRevoked,
  timeZone,
  fromProfile,
}: {
  expectedOrganizationId: string
  onRevoked: () => void
  timeZone: string
  fromProfile: boolean
}) {
  const { t } = useI18n()
  const { reportContextChanged } = useTeamManagementAccess()
  const [params, setParams] = useSearchParams()
  const [conflict, setConflict] = useState<{ error: unknown; params: URLSearchParams } | null>(null)
  const displayedParams = conflict?.params ?? params
  const onConflict = useCallback(
    (error: unknown) => {
      reportContextChanged(error)
      setConflict((current) => current ?? { error, params: new URLSearchParams(params) })
    },
    [params, reportContextChanged],
  )
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
        timeZone={timeZone}
        fromProfile={fromProfile}
      />
      <BookingList
        key={displayedParams.toString()}
        params={displayedParams}
        tab={tab}
        timeZone={timeZone}
        fromProfile={fromProfile}
        expectedOrganizationId={expectedOrganizationId}
        onRevoked={onRevoked}
        conflict={conflict?.error ?? null}
        onConflict={onConflict}
      />
    </>
  )
}

function localDateTime(value: string | null, timeZone: string): string {
  if (!value) return ''
  const ms = new Date(value).getTime()
  if (!Number.isFinite(ms)) return ''
  const { year, month, day, hour, minute } = wallTime(ms, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
}

/** datetime-local has no zone; interpret its wall time in the same zone as the list. */
function filterInstant(value: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0] = value.split(/[-T:]/u).map(Number)
  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, 0, 0)
  const wallMs = wall.getTime()
  // Try both sides of a possible offset transition. Like datetime-local in the
  // browser zone, repeated times choose the earlier instant and gaps move forward.
  const candidates = [-1, 1].map((day) => wallMs - offsetAt(wallMs + day * 86_400_000, timeZone))
  const exact = candidates.filter((candidate) => {
    const actual = wallTime(candidate, timeZone)
    return (
      actual.year === year &&
      actual.month === month &&
      actual.day === day &&
      actual.hour === hour &&
      actual.minute === minute
    )
  })
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates)).toISOString()
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
  timeZone,
  fromProfile,
}: {
  params: URLSearchParams
  onApply: (params: URLSearchParams) => void
  disabled: boolean
  timeZone: string
  fromProfile: boolean
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
      const value = filterInstant(String(fields.get(name) ?? ''), timeZone)
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
          <TimeZoneNote timeZone={timeZone} fromProfile={fromProfile} />
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
                  defaultValue={localDateTime(params.get(name), timeZone)}
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
  timeZone,
  fromProfile,
  expectedOrganizationId,
  onRevoked,
  conflict,
  onConflict,
}: {
  params: URLSearchParams
  tab: Tab
  timeZone: string
  fromProfile: boolean
  expectedOrganizationId: string
  onRevoked: () => void
  conflict: unknown
  onConflict: (error: unknown) => void
}) {
  const { t, ui, formatLocale } = useI18n()
  const panel = useBookingPanel()
  const { organization, user } = useMe()
  const loadedPages = useRef(1)
  const loadedSnapshot = useRef<LoadedBookingPages | null>(null)
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
  const moreController = useRef<AbortController | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const handleConflict = useCallback(
    (error: unknown) => {
      moreController.current?.abort()
      setLoadingMore(false)
      onConflict(error)
    },
    [onConflict],
  )
  const handleAccessError = useCallback(
    (error: unknown) => {
      if (isOrganizationContextChanged(error)) handleConflict(error)
      else if (isAccessDenied(error)) onRevoked()
      else return false
      return true
    },
    [handleConflict, onRevoked],
  )
  const fetchPage = useCallback(
    (signal: AbortSignal, cursor?: string) =>
      unwrap(
        api.GET('/api/v1/team/bookings', {
          params: {
            query: { ...query, cursor, bulkSelection: 'true' },
            header: { 'x-expected-organization-id': expectedOrganizationId },
          },
          signal,
        }),
      ),
    [expectedOrganizationId, query],
  )
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const first = await fetchPage(signal)
        let page: LoadedBookingPages = { ...first, activePage: first }
        for (let depth = 1; depth < loadedPages.current && page.nextCursor; depth += 1) {
          const next = await fetchPage(signal, page.nextCursor)
          page = {
            data: [...page.data, ...next.data],
            nextCursor: next.nextCursor,
            activePage: next,
          }
        }
        if (!signal.aborted) loadedSnapshot.current = page
        return page
      } catch (error) {
        if (!signal.aborted) {
          const handled = handleAccessError(error)
          if (loadedSnapshot.current) {
            if (!handled) setRefreshError(errorMessage(error))
            return loadedSnapshot.current
          }
        }
        throw error
      } finally {
        if (!signal.aborted) setRefreshing(false)
      }
    },
    [fetchPage, handleAccessError],
  )
  const [first, reload] = useLoad(load)
  const latestSource = useRef<LoadedBookingPages | null>(null)
  if (first.status === 'ready') latestSource.current = first.data
  const [more, setMore] = useState<(LoadedBookingPages & { source: BookingPage }) | null>(null)
  const [moreError, setMoreError] = useState<UiText | null>(null)
  const [status, setStatus] = useState<UiText>('')
  const [selected, setSelected] = useState<Booking | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const list = useRef<HTMLTableSectionElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [focusAfterCancellation, setFocusAfterCancellation] = useState(false)
  const confirmLeave = useConfirmLeave()
  const format = zoned(timeZone, formatLocale)
  const [bulkMode, setBulkMode] = useState(false)
  const [showReceipt, setShowReceipt] = useState(false)
  const bulkOpener = useRef<HTMLButtonElement | null>(null)
  const bulkModeButton = useRef<HTMLButtonElement>(null)
  const bulkRows = useRef<ReadonlyMap<string, Booking>>(new Map())
  const selection = useBulkBookingSelection({
    organizationId: expectedOrganizationId,
    userId: user.id,
    onAccessError: handleAccessError,
  })
  const resetSelection = selection.reset
  const refreshBookings = useCallback(() => {
    resetSelection()
    moreController.current?.abort()
    setLoadingMore(false)
    setMoreError(null)
    setRefreshError(null)
    setRefreshing(true)
    reload()
  }, [reload, resetSelection])
  const readySource = first.status === 'ready' ? first.data : null
  const readyShown = more && more.source === readySource ? more : readySource
  const pageToken = readyShown?.activePage.bulkPageToken
  const bulkEnabled = !!pageToken && !conflict
  const detailOpen = !!(panel?.active || selected)
  const batch = useBulkCancellationReceipt({
    enabled: bulkEnabled && !detailOpen,
    organizationId: expectedOrganizationId,
    userId: user.id,
    onAccessError: handleAccessError,
    refreshBookings,
  })
  const abandonRetry = batch.abandonRetry
  const listBusy = loadingMore || refreshing || !!conflict || !!refreshError
  const batchPending = !!batch.receipt && batch.result?.state !== 'completed'
  const canSelect = bulkEnabled && bulkMode && !batchPending
  const activeIds = new Set(readyShown?.activePage.data.map((row) => row.id))
  const choices = canSelect
    ? (readyShown?.data.filter(
        (row) =>
          activeIds.has(row.id) && row.status === 'confirmed' && Date.parse(row.start) > Date.now(),
      ) ?? [])
    : []
  const choiceIds = new Set(choices.map((row) => row.id))
  const selectedIds = selection.ids.filter((id) => choiceIds.has(id))
  const preview = canSelect && !listBusy ? (selection.confirmation?.preview ?? null) : null
  const restoreBulkFocus = () => {
    setTimeout(() => {
      if (bulkOpener.current?.isConnected && !bulkOpener.current.disabled)
        bulkOpener.current.focus()
      else if (bulkModeButton.current?.isConnected && !bulkModeButton.current.disabled)
        bulkModeButton.current.focus()
      else heading.current?.focus()
    })
  }

  useLayoutEffect(() => {
    if (listBusy || detailOpen) abandonRetry()
    if (conflict || detailOpen) resetSelection()
    if (detailOpen) setShowReceipt(false)
  }, [abandonRetry, conflict, detailOpen, listBusy, resetSelection])
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

  useEffect(() => {
    // Wait for Back to close the modal and restore its inert background first.
    // The cancelled row may no longer exist under a confirmed-only filter.
    if (!focusAfterCancellation || panel?.active) return
    heading.current?.focus()
    setFocusAfterCancellation(false)
  }, [focusAfterCancellation, panel?.active])

  function closeDetails() {
    if (!confirmLeave()) return
    setSelected(null)
    setTimeout(() => opener.current?.focus())
  }

  if (!readySource || !readyShown) {
    if (conflict) return <OrganizationContextConflict error={conflict} />
    if (first.status !== 'error') return <PageSkeleton label="Loading team bookings…" />
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

  const source = readySource
  const shown = readyShown
  const appliedFilters: [MessageKey, string][] = [
    ['Bookings', t(tab === 'past' ? 'Past' : tab === 'all' ? 'All bookings' : 'Upcoming')],
    [
      'Status',
      t(
        query.status === 'confirmed'
          ? 'Confirmed'
          : query.status === 'cancelled'
            ? 'Cancelled'
            : 'All statuses',
      ),
    ],
    ['Order', t(query.order === 'desc' ? 'Newest first' : 'Oldest first')],
  ]
  for (const { name, label } of TIME_FILTERS) {
    const value = instant(params.get(name))
    if (value) appliedFilters.push([label, format.dateTime(value)])
  }

  function reviewCancellation(opener: HTMLButtonElement) {
    if (!pageToken || !canSelect || listBusy || detailOpen) return
    bulkOpener.current = opener
    void selection.review(pageToken, selectedIds)
  }

  function confirmBulkCancellation() {
    if (
      !preview ||
      listBusy ||
      batchPending ||
      batch.retryBlocked ||
      !selection.confirmation ||
      Date.now() >= selection.confirmation.expiresLocallyAt ||
      !preview.items.some(({ code }) => code === 'eligible')
    )
      return
    bulkRows.current = new Map(shown.data.map((booking) => [booking.id, booking]))
    void batch.submit({ id: preview.confirmationId, expiresAt: preview.expiresAt }, true)
    resetSelection()
    setShowReceipt(true)
  }

  function closeBulkDialog() {
    selection.close()
    setShowReceipt(false)
    restoreBulkFocus()
  }

  const selectedId = panel?.active ? panel.location.pathname.split('/').at(-1) : undefined
  const selectedIndex = shown.data.findIndex((booking) => booking.id === selectedId)
  const panelBooking = shown.data[selectedIndex]
  function updateRow(updated: Booking) {
    const patched = {
      ...shown,
      data: shown.data.map((booking) => (booking.id === updated.id ? updated : booking)),
    }
    loadedSnapshot.current = patched
    setMore({ ...patched, source })
  }
  function cancelled(bookingId: string, background = false) {
    const latest = loadedSnapshot.current ?? shown
    const updated: LoadedBookingPages = {
      ...latest,
      data:
        query.status === 'confirmed'
          ? latest.data.filter((booking) => booking.id !== bookingId)
          : latest.data.map((booking) =>
              booking.id === bookingId ? { ...booking, status: 'cancelled' } : booking,
            ),
      nextCursor: latest.nextCursor,
    }
    loadedSnapshot.current = updated
    setMore({ ...updated, source: latestSource.current ?? source })
    if (!background) {
      if (panel?.active) panel.close()
      else setSelected(null)
    }
    setStatus('The booking is cancelled.')
    refreshBookings()
    if (!background) setFocusAfterCancellation(true)
  }
  /** Keeps the list, a later refresh's fallback and the open details showing the same mark. */
  function applyNoShow(bookingId: string, change: NoShowChange, announce: boolean) {
    const latest = loadedSnapshot.current ?? shown
    const patched = {
      ...latest,
      data: latest.data.map((booking) =>
        booking.id === bookingId ? withNoShowChange(booking, change) : booking,
      ),
      nextCursor: latest.nextCursor,
    }
    loadedSnapshot.current = patched
    setMore({ ...patched, source: latestSource.current ?? source })
    setSelected((current) =>
      current?.id === bookingId ? withNoShowChange(current, change) : current,
    )
    if (announce) setStatus('No-show mark updated.')
  }
  async function loadMore(forPanel = false) {
    if (!shown.nextCursor || loadingMore || refreshing || conflict) return
    resetSelection()
    abandonRetry()
    const controller = new AbortController()
    moreController.current = controller
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await fetchPage(controller.signal, shown.nextCursor)
      if (controller.signal.aborted) return
      const data = [...(loadedSnapshot.current ?? shown).data, ...page.data]
      loadedPages.current += 1
      const combined = { data, nextCursor: page.nextCursor, activePage: page }
      loadedSnapshot.current = combined
      setMore({ ...combined, source })
      setStatus(msg('Showing {0} bookings.', { '0': data.length }))
      if (page.data[0] && !forPanel) setFocusId(page.data[0].id)
      return page.data[0]?.id
    } catch (error) {
      if (controller.signal.aborted) return
      if (!handleAccessError(error))
        setMoreError(msg('Could not load more bookings. {0}', { '0': errorMessage(error) }))
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false)
    }
  }

  return (
    <section className="team-bookings-list" aria-labelledby="team-bookings-list-heading">
      <h2
        id="team-bookings-list-heading"
        className="team-bookings-focus-target"
        ref={heading}
        tabIndex={-1}
      >
        {t('Team bookings')}
      </h2>
      <p className="muted zone-note">
        {query.order === 'desc' ? t('Newest first. ') : t('Oldest first. ')}
        <TimeZoneNote timeZone={format.timeZone} fromProfile={fromProfile} />
      </p>
      <p className="flash" role="status">
        {ui(status)}
        {status === 'The booking is cancelled.' && (
          <>
            {' '}
            <span>
              {t('Cancellation notifications are queued. Email delivery is not confirmed.')}
            </span>
          </>
        )}
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
      <BookingExport
        filters={query}
        timeZone={timeZone}
        expectedOrganizationId={expectedOrganizationId}
        disabled={!!conflict}
      />
      {bulkEnabled && (
        <div className="team-bulk-toolbar">
          <div className="form-actions">
            {!batchPending && (
              <button
                type="button"
                className="button"
                ref={bulkModeButton}
                disabled={listBusy}
                onClick={() => {
                  resetSelection()
                  setBulkMode(!bulkMode)
                }}
              >
                {t(bulkMode ? 'Exit selection' : 'Select bookings to cancel')}
              </button>
            )}
            <button
              type="button"
              className="button"
              onClick={refreshBookings}
              disabled={refreshing || loadingMore}
            >
              {t('Refresh bookings')}
            </button>
            {batch.receipt && (
              <button
                type="button"
                className="button"
                onClick={(event) => {
                  bulkOpener.current = event.currentTarget
                  setShowReceipt(true)
                }}
              >
                {t('View bulk cancellation')}
              </button>
            )}
          </div>
          <div role="status" aria-atomic="true">
            {!showReceipt && batch.result && (
              <p>
                {t(bulkResultTitle(batch.result.state))}{' '}
                <BulkCancellationCounts result={batch.result} />
              </p>
            )}
          </div>
          {!showReceipt && batch.issue && (
            <p className="alert alert-error" role="alert">
              {ui(batch.issue)}
            </p>
          )}
          {canSelect && (
            <>
              <p role="status" aria-atomic="true">
                {t('{count} selected on this page (maximum {limit}).', {
                  count: selectedIds.length,
                  limit: MAX_BULK_SELECTION,
                })}
              </p>
              {choices.length === 0 && !listBusy && (
                <p className="hint">{t('No bookings on this page can be selected.')}</p>
              )}
              <div className="form-actions">
                {choices.length > 0 && choices.length <= MAX_BULK_SELECTION && (
                  <button
                    type="button"
                    className="button"
                    disabled={
                      listBusy || selection.loading || selectedIds.length === choices.length
                    }
                    onClick={() => selection.setIds(choices.map((row) => row.id))}
                  >
                    {t('Select this page')}
                  </button>
                )}
                <button
                  type="button"
                  className="button button-primary"
                  disabled={
                    listBusy ||
                    selection.loading ||
                    selection.rateLimited ||
                    selectedIds.length === 0
                  }
                  onClick={(event) => reviewCancellation(event.currentTarget)}
                >
                  {t(selection.loading ? 'Loading…' : 'Review cancellation')}
                </button>
              </div>
              {selection.issue && (
                <p className="alert alert-error" role="alert">
                  {ui(selection.issue)}
                </p>
              )}
            </>
          )}
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
                <th scope="col">{t('Hosts')}</th>
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
                        {choiceIds.has(booking.id) && (
                          <label className="team-bulk-check">
                            <input
                              type="checkbox"
                              aria-label={t('Select booking: {event}, {time}', {
                                event: booking.eventType?.title ?? t('Deleted event type'),
                                time: format.dateTime(booking.start),
                              })}
                              aria-describedby={`select-booking-${booking.id}`}
                              checked={selectedIds.includes(booking.id)}
                              disabled={
                                listBusy ||
                                selection.loading ||
                                (selectedIds.length >= MAX_BULK_SELECTION &&
                                  !selectedIds.includes(booking.id))
                              }
                              onChange={(event) => {
                                if (event.currentTarget.checked)
                                  selection.setIds([...selectedIds, booking.id])
                                else selection.setIds(selectedIds.filter((id) => id !== booking.id))
                              }}
                            />
                            <span className="visually-hidden" id={`select-booking-${booking.id}`}>
                              <bdi>{invitee?.name ?? booking.id}</bdi>
                            </span>
                          </label>
                        )}
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
                        aria-expanded={(selectedId ?? selected?.id) === booking.id}
                        aria-controls={
                          (selectedId ?? selected?.id) === booking.id
                            ? 'team-booking-details'
                            : undefined
                        }
                        onClick={(event) => {
                          if (!confirmLeave()) return
                          if (panel) panel.open(booking.id, event.currentTarget)
                          else {
                            opener.current = event.currentTarget
                            setSelected(booking)
                          }
                        }}
                      >
                        {booking.eventType?.title == null ? (
                          t('Deleted event type')
                        ) : (
                          <bdi>{booking.eventType.title}</bdi>
                        )}
                      </button>
                    </th>
                    <td data-label={t('Invitee')} className="user-content">
                      <div className="table-value">
                        {invitee ? (
                          <>
                            <bdi>{invitee.name}</bdi>
                            <br />
                            <BookingEmail email={invitee.email} />
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
                    <td data-label={t('Hosts')} className="user-content">
                      <div className="table-value">
                        {booking.hosts.length ? (
                          <ul className="plain-list team-booking-hosts">
                            {booking.hosts.map((host) => (
                              <li key={host.userId} dir="auto">
                                {host.name}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          t('None')
                        )}
                      </div>
                    </td>
                    <td data-label={t('Status')} className="fit">
                      <div className="table-value">
                        <span
                          className={`badge ${booking.status === 'cancelled' ? (booking.isRescheduled ? '' : 'badge-danger') : 'badge-success'}`}
                        >
                          {t(bookingStatus(booking))}
                        </span>
                        <NoShowRowControls
                          booking={booking}
                          expectedOrganizationId={expectedOrganizationId}
                          disabled={!!conflict}
                          onChanged={(change) => applyNoShow(booking.id, change, true)}
                          onError={handleAccessError}
                        />
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
            onClick={() => void loadMore()}
            disabled={loadingMore || refreshing || !!conflict}
          >
            {loadingMore ? t('Loading…') : t('Show more bookings')}
          </button>
        </div>
      )}
      {bulkEnabled && !detailOpen && (preview || showReceipt) && (
        <BulkCancellationDialog
          preview={preview}
          result={batch.result}
          issue={batch.issue}
          checking={!!batch.receipt && !batch.stopped}
          unconfirmed={batch.unconfirmed}
          retry={
            batch.canRetry && batch.receipt
              ? () => {
                  if (batch.receipt) void batch.submit(batch.receipt, false)
                }
              : undefined
          }
          retryBlocked={batch.retryBlocked || listBusy}
          busy={listBusy || batch.retryBlocked}
          rows={
            preview
              ? new Map(shown.data.map((booking) => [booking.id, booking]))
              : new Map([
                  ...shown.data.map((booking) => [booking.id, booking] as const),
                  ...bulkRows.current,
                ])
          }
          team={organization.name}
          format={format}
          filters={appliedFilters}
          close={closeBulkDialog}
          confirm={confirmBulkCancellation}
        />
      )}
      {selectedId && panel && (
        <BookingPanel
          name={
            panelBooking
              ? `${panelBooking.eventType?.title ?? t('Deleted event type')} — ${format.dateTime(panelBooking.start)}`
              : t('Booking')
          }
          previous={
            selectedIndex > 0
              ? () => {
                  const previous = shown.data[selectedIndex - 1]
                  if (previous) panel.step(previous.id)
                }
              : undefined
          }
          next={
            selectedIndex >= 0 && (selectedIndex < shown.data.length - 1 || shown.nextCursor)
              ? async () => {
                  const nextId = shown.data[selectedIndex + 1]?.id ?? (await loadMore(true))
                  if (nextId) panel.step(nextId)
                }
              : undefined
          }
        >
          {moreError && (
            <p className="alert alert-error" role="alert">
              {ui(moreError)}
            </p>
          )}
          <TeamBookingDetailPage
            key={selectedId}
            id={selectedId}
            embedded
            onChanged={updateRow}
            rowBooking={panelBooking}
            onClose={panel.close}
            listConflict={conflict}
            onConflict={handleConflict}
            onRevoked={onRevoked}
            onRefresh={refreshBookings}
            onCancelled={(background) => cancelled(selectedId, background)}
            onNoShowChanged={(change) => applyNoShow(selectedId, change, false)}
          />
        </BookingPanel>
      )}
      {selected && (
        <BookingDetail
          key={selected.id}
          booking={selected}
          timeZone={timeZone}
          expectedOrganizationId={expectedOrganizationId}
          conflict={conflict}
          onConflict={handleConflict}
          onRevoked={onRevoked}
          onNoShowChanged={(change) => applyNoShow(selected.id, change, false)}
          onRefresh={refreshBookings}
          onClose={closeDetails}
          onCancelled={(background) => cancelled(selected.id, background)}
        />
      )}
    </section>
  )
}

function BookingEmail({ email }: { email: string }) {
  const separator = email.lastIndexOf('@') + 1
  return (
    <bdi dir="ltr" className="muted team-booking-email">
      <span>{email.slice(0, separator)}</span>
      <wbr />
      <span>{email.slice(separator)}</span>
    </bdi>
  )
}

function bookingStatus(booking: Booking): 'Rescheduled' | 'Cancelled' | 'Confirmed' {
  return booking.status === 'cancelled'
    ? booking.isRescheduled
      ? 'Rescheduled'
      : 'Cancelled'
    : 'Confirmed'
}

export function BookingDetail({
  booking,
  teamsLocation = false,
  timeZone,
  expectedOrganizationId,
  conflict,
  onConflict,
  onRevoked,
  handoff,
  onNoShowChanged,
  onRefresh,
  onClose,
  onCancelled,
  embedded = false,
}: {
  embedded?: boolean
  booking: Booking
  teamsLocation?: boolean
  timeZone: string
  expectedOrganizationId: string
  conflict: unknown
  onConflict: (error: unknown) => void
  onRevoked: () => void
  handoff?: ReactNode
  onNoShowChanged?: (change: NoShowChange) => void
  onRefresh: () => void
  onClose: () => void
  onCancelled: (background?: boolean) => void
}) {
  const { t, formatLocale } = useI18n()
  const me = useMe()
  const heading = useRef<HTMLHeadingElement>(null)
  const format = zoned(timeZone, formatLocale)
  useEffect(() => {
    if (!embedded) heading.current?.focus()
  }, [embedded])
  useBookingPanelTitle(
    `${booking.eventType?.title ?? t('Deleted event type')} — ${format.dateTime(booking.start)}`,
  )
  return (
    <section
      id="team-booking-details"
      className="panel team-booking-detail user-content"
      aria-labelledby="team-booking-detail-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !embedded) {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <div className="team-booking-detail-header">
        <h2 id="team-booking-detail-heading" tabIndex={-1} ref={heading}>
          {t('Team booking details')}
        </h2>
        {!embedded && (
          <button type="button" className="button button-small" onClick={onClose}>
            {t('Close details')}
          </button>
        )}
      </div>
      <dl className="details">
        <dt>{t('Event')}</dt>
        <dd>
          {booking.eventType?.title == null ? (
            t('Deleted event type')
          ) : (
            <bdi>{booking.eventType.title}</bdi>
          )}
        </dd>
        <dt>{t('When')}</dt>
        <dd>
          <time dateTime={booking.start}>{format.dateTime(booking.start)}</time>
          {' – '}
          <time dateTime={booking.end}>{format.dateTime(booking.end)}</time>
        </dd>
        <dt>{t('Status')}</dt>
        <dd>{t(bookingStatus(booking))}</dd>
        {teamsLocation && (
          <>
            <dt>{t('Location')}</dt>
            <dd>
              {t('Microsoft Teams')}
              {booking.hosts.some((host) => host.userId === me.user.id) && (
                <>
                  {' '}
                  <Link to={bookingPath(booking.id)}>{t('Open host booking details')}</Link>
                </>
              )}
            </dd>
          </>
        )}
        {booking.status === 'cancelled' && (
          <>
            <dt>{t(bookingStatus(booking))}</dt>
            <dd>
              {booking.cancelledAt ? (
                <time dateTime={booking.cancelledAt}>{format.dateTime(booking.cancelledAt)}</time>
              ) : (
                t('Not set')
              )}
            </dd>
          </>
        )}
        <dt>{t('Hosts')}</dt>
        <dd>
          {booking.hosts.length ? (
            <ul className="plain-list">
              {booking.hosts.map((host) => (
                <li key={host.userId} dir="auto">
                  {host.name}
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
                  <bdi>{person.name}</bdi>
                  {t(' ({detail})', { detail: person.isBooker ? t('Invitee') : t('Guest') })}
                  <br />
                  <a href={`mailto:${person.email}`}>
                    <bdi dir="ltr">
                      <BreakableText>{person.email}</BreakableText>
                    </bdi>
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
        (booking.paidManagementUnavailable === true ? (
          <p className="hint">
            {t(
              'Changes are unavailable for this paid booking. Contact your instance operator about cancellation or refunds.',
            )}
          </p>
        ) : new Date(booking.start).getTime() > Date.now() ? (
          <CancelBooking
            booking={booking}
            timeZone={timeZone}
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
      {booking.groupSlotId && (
        <GroupOccurrenceAttendees
          key={`${booking.groupSlotId}:${booking.status}`}
          occurrenceId={booking.groupSlotId}
          expectedOrganizationId={expectedOrganizationId}
          disabled={!!conflict}
          onCancelled={() => onCancelled()}
        />
      )}
      <NoShowAttendees
        booking={booking}
        expectedOrganizationId={expectedOrganizationId}
        disabled={!!conflict}
        onChanged={onNoShowChanged}
        onError={(error) => {
          if (isOrganizationContextChanged(error)) onConflict(error)
          else if (isAccessDenied(error)) onRevoked()
          else return false
          return true
        }}
      />
      {handoff}
      <ManualRebooking booking={booking} expectedOrganizationId={expectedOrganizationId} />
    </section>
  )
}

function CancelBooking({
  booking,
  timeZone,
  expectedOrganizationId,
  conflict,
  onConflict,
  onRevoked,
  onRefresh,
  onCancelled,
}: {
  booking: Booking
  timeZone: string
  expectedOrganizationId: string
  conflict: unknown
  onConflict: (error: unknown) => void
  onRevoked: () => void
  onRefresh: () => void
  onCancelled: (background?: boolean) => void
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
  const submitting = useRef(false)
  const [alreadyCancelled, setAlreadyCancelled] = useState(false)
  const [started, setStarted] = useState(false)
  const [completed, setCompleted] = useState(false)
  const reportedCompletion = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const reasonInput = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<AbortController | null>(null)
  const formId = useId()
  const reasonId = useId()
  const cancelHeadingId = useId()
  useUnsavedChanges(open && reason.trim() !== '' && !completed)
  useEffect(() => {
    if (!completed || reportedCompletion.current) return
    reportedCompletion.current = true
    onCancelled()
  }, [completed, onCancelled])
  // Let a submitted cancellation finish after navigation so its result can update the list.

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || conflict || alreadyCancelled || started) return
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
    submitting.current = true
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
      if (!mounted.current) {
        onCancelled(true)
        return
      }
      setReason('')
      setCompleted(true)
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
    if (mounted.current) {
      submitting.current = false
      setBusy(false)
    }
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
          <CancellationSummary booking={booking} timeZone={timeZone} />
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
                dir="auto"
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

function CancellationSummary({ booking, timeZone }: { booking: Booking; timeZone: string }) {
  const { t, formatLocale } = useI18n()
  const format = zoned(timeZone, formatLocale)
  return (
    <div className="team-booking-confirmation">
      <dl className="details">
        <dt>{t('When')}</dt>
        <dd>
          <time dateTime={booking.start}>{format.dateTimeRange(booking.start, booking.end)}</time>
          <br />
          {t('Your time zone: {zone}', { zone: format.timeZone.replaceAll('_', ' ') })}
        </dd>
        <dt>{t('Hosts')}</dt>
        <dd>
          {booking.hosts.length ? (
            <ul className="plain-list">
              {booking.hosts.map((host) => (
                <li key={host.userId}>
                  <bdi>{host.name}</bdi>
                  {host.timeZone && isKnownTimeZone(host.timeZone) ? (
                    host.timeZone !== format.timeZone && (
                      <>
                        <br />
                        <time dateTime={booking.start}>
                          {zoned(host.timeZone, formatLocale).dateTimeRange(
                            booking.start,
                            booking.end,
                          )}
                        </time>
                        <br />
                        {t('Host time zone: {zone}', {
                          zone: host.timeZone.replaceAll('_', ' '),
                        })}
                      </>
                    )
                  ) : (
                    <>
                      <br />
                      <span className="hint">{t('This host’s time zone is unavailable.')}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            t('None')
          )}
        </dd>
        <dt>{t('Cancellation notifications')}</dt>
        <dd>
          <p>
            {t(
              'Cancellation emails go to the invitee and guests below, and saved hosts who are still verified members of this team. Departed hosts are not notified.',
            )}
          </p>
          <ul className="plain-list">
            {booking.attendees.map((person) => (
              <li key={person.email}>
                <bdi>{person.name}</bdi>{' '}
                <bdi dir="ltr">
                  <BreakableText>{person.email}</BreakableText>
                </bdi>
              </li>
            ))}
          </ul>
          <p className="hint">
            {t('Email delivery is not guaranteed. Contact the invitee directly if needed.')}
          </p>
        </dd>
      </dl>
      <p>
        {t(
          'Hourmere does not automatically assign another host. A replacement requires a new booking.',
        )}
      </p>
    </div>
  )
}
