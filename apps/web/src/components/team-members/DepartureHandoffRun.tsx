import {
  DEPARTURE_HANDOFF_ITEM_GAP_SECONDS,
  MAX_DEPARTURE_HANDOFF_RUN_ITEMS,
} from '@hourmere/core/departure-handoff-run'
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import { ConfirmationDialog } from '../ConfirmationDialog.tsx'
import './DepartureHandoffRun.css'

type Booking = Schemas['TeamAdminBookingDetail']
type Run = Schemas['DepartureHandoffRun']
type Control = 'pause' | 'resume' | 'stop'
type Action = Control | 'start' | 'refresh'
type PendingConfirmation = { action: 'start' | 'stop'; run: Run | null }
type SavedRun = { id: string; started: boolean; previousId?: string }

const runPath = '/api/v1/team/bookings/handoff-runs/{runId}'
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const controls = { pause: 'Pause', resume: 'Resume', stop: 'Stop' } as const
const runStates = {
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Completed',
  failed: 'Failed',
} as const satisfies Record<Run['state'], MessageKey>
const runFailures = {
  departed_member_returned: 'The departed member has rejoined this team.',
  authorization_lost: 'The session that started or resumed this run lost access.',
  run_expired: 'The run expired.',
} as const satisfies Record<NonNullable<Run['failureCode']>, MessageKey>
const outcomes = {
  pending: 'Pending',
  applied: 'Applied',
  ineligible: 'No longer eligible',
  processing_failed: 'Processing failed',
  stopped: 'Stopped',
} as const satisfies Record<Run['items'][number]['outcome'], MessageKey>
const requestIssues: Partial<Record<string, MessageKey>> = {
  sso_required: 'Sign in with this team’s SSO to continue.',
  handoff_departing_member_present: runFailures.departed_member_returned,
  handoff_run_active: 'A handoff run is already running or paused for this team.',
  handoff_run_no_eligible_offers: 'No fully approved proposals are eligible for automatic handoff.',
  handoff_run_rate_limited: 'Wait at least one minute between starting handoff runs.',
  handoff_run_not_found: 'This run is no longer available.',
  handoff_run_transition_invalid: 'The run changed. Refresh the run receipt.',
  handoff_run_queue_unavailable: 'The automatic handoff queue is temporarily unavailable.',
}

export const handoffBookingParam = 'handoffBooking'
export const departureHandoffRunPath = (bookingId: string) =>
  `${PATHS.settings}?${new URLSearchParams({ [handoffBookingParam]: bookingId })}#team-members`

/** Use the server-projected switch and original host's current membership on every opening. */
export function departedHandoffHost(booking: Booking) {
  const host = booking.hosts[0]
  return booking.departureHandoffEnabled &&
    booking.hosts.length === 1 &&
    host?.isCurrentMember === false
    ? host
    : undefined
}

function readSavedRun(key: string): SavedRun | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (
      typeof value?.id === 'string' &&
      uuid.test(value.id) &&
      typeof value.started === 'boolean'
    ) {
      const previousId = value.previousId
      return {
        id: value.id,
        started: value.started,
        ...(typeof previousId === 'string' && uuid.test(previousId) && { previousId }),
      }
    }
  } catch {
    // The current view still works when session storage is unavailable.
  }
  return null
}

function saveRun(key: string, entry: SavedRun | null) {
  try {
    if (entry) sessionStorage.setItem(key, JSON.stringify(entry))
    else sessionStorage.removeItem(key)
  } catch {
    // The current view retains the receipt in memory.
  }
}

function requestIssue(error: unknown, action: Action): MessageKey {
  if (isOrganizationContextChanged(error))
    return 'Your team context changed. Reload before making changes.'
  if (error instanceof RequestError) {
    if (error.code && Object.hasOwn(requestIssues, error.code)) {
      const issue = requestIssues[error.code]
      if (issue) return issue
    }
    if (error.status === 401 || error.status === 403) return "You don't have permission to do that."
    if (error.status === 429) return 'Too many requests. Wait a minute and try again.'
  }
  if (action === 'start')
    return 'Could not confirm that automatic handoff started. Try starting again.'
  if (action === 'refresh') return 'Could not load the run receipt. Try refreshing it.'
  return 'Could not update automatic handoff. Refresh the run receipt before trying again.'
}

export function DepartureHandoffRunForBooking({
  organizationId,
  viewerUserId,
  bookingId,
  onReload,
  inRemovalReview = false,
}: {
  organizationId: string
  viewerUserId: string
  bookingId: string
  onReload: () => void
  inRemovalReview?: boolean
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      unwrap(
        api.GET('/api/v1/team/bookings/{id}', {
          params: {
            path: { id: bookingId },
            header: { 'x-expected-organization-id': organizationId },
          },
          signal,
        }),
      ),
    [bookingId, organizationId],
  )
  const [state] = useLoad(load)
  const host = state.status === 'ready' ? departedHandoffHost(state.data) : undefined
  if (!host) return null
  return (
    <DepartureHandoffRun
      key={`${organizationId}:${viewerUserId}:${host.userId}`}
      organizationId={organizationId}
      viewerUserId={viewerUserId}
      host={host}
      inRemovalReview={inRemovalReview}
      onReload={onReload}
    />
  )
}

function DepartureHandoffRun({
  organizationId,
  viewerUserId,
  host,
  onReload,
  inRemovalReview,
}: {
  organizationId: string
  viewerUserId: string
  host: Booking['hosts'][number]
  onReload: () => void
  inRemovalReview: boolean
}) {
  const { t } = useI18n()
  const headingId = useId()
  const Heading = inRemovalReview ? 'h4' : 'h3'
  const ReceiptHeading = inRemovalReview ? 'h5' : 'h4'
  const storageKey = `hourmere:departure-handoff-run:${viewerUserId}:${organizationId}:${host.userId}`
  const [saved, setSaved] = useState(() => readSavedRun(storageKey))
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState<Action | null>(saved ? 'refresh' : null)
  const [issue, setIssue] = useState<MessageKey | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const operation = useRef<AbortController | null>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)

  useLayoutEffect(() => {
    if (busy || !opener.current) return
    if (!opener.current.isConnected && document.activeElement === document.body)
      feedback.current?.focus()
    opener.current = null
  }, [busy])

  const execute = useCallback(
    async (action: Action, entry: SavedRun) => {
      if (operation.current) return
      const controller = new AbortController()
      operation.current = controller
      const { signal } = controller
      const header = { 'x-expected-organization-id': organizationId }
      const params = { path: { runId: entry.id }, header }
      const remember = (next: SavedRun | null) => {
        setSaved(next)
        saveRun(storageKey, next)
      }
      setBusy(action)
      setIssue(null)
      if (action === 'start') {
        // Persist the request ID before submission so an uncertain response can recover the same run.
        remember(entry)
      }
      try {
        const latest = await unwrap(
          action === 'start'
            ? api.POST('/api/v1/team/bookings/handoff-runs', {
                params: { header },
                body: { runId: entry.id, departingUserId: host.userId },
                signal,
              })
            : action === 'refresh'
              ? api.GET(runPath, { params, signal })
              : api.POST(`${runPath}/control`, { params, body: { action }, signal }),
        )
        if (signal.aborted) return
        remember({ id: latest.id, started: true })
        setRun(latest)
      } catch (error) {
        if (signal.aborted) return
        const request = error instanceof RequestError ? error : undefined
        if (request?.code === 'handoffs_disabled') {
          setHidden(true)
        } else if (
          isOrganizationContextChanged(error) ||
          request?.status === 401 ||
          request?.status === 403
        ) {
          setBlocked(true)
          setRun(null)
        } else if (request?.code === 'handoff_run_not_found' && entry.started) {
          remember(null)
          setRun(null)
        } else if (
          action === 'start' &&
          request &&
          request.status < 500 &&
          request.status !== 429
        ) {
          remember(entry.previousId ? { id: entry.previousId, started: true } : null)
        }
        const recoveringStart =
          action === 'refresh' && !entry.started && request?.code === 'handoff_run_not_found'
        setIssue(
          recoveringStart
            ? 'Could not confirm that automatic handoff started. Try starting again.'
            : requestIssue(error, action),
        )
      } finally {
        if (!signal.aborted) {
          operation.current = null
          setBusy(null)
        }
      }
    },
    [organizationId, host.userId, storageKey],
  )

  useEffect(() => {
    const entry = readSavedRun(storageKey)
    if (entry) void execute('refresh', entry)
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [execute, storageKey])

  function submit(action: Action) {
    const entry =
      action === 'start'
        ? saved && !saved.started
          ? saved
          : { id: crypto.randomUUID(), started: false, ...(saved && { previousId: saved.id }) }
        : saved
    if (!entry) return
    void execute(action, entry)
  }

  function handle(action: Action, event: MouseEvent<HTMLButtonElement>) {
    if (blocked || busy || operation.current || confirmation) return
    opener.current = event.currentTarget
    if (action === 'start' || action === 'stop') {
      setConfirmation({ action, run })
      return
    }
    submit(action)
  }

  function closeConfirmation() {
    setConfirmation(null)
    if (opener.current?.isConnected) opener.current.focus()
    else feedback.current?.focus()
  }

  if (hidden) return null
  const active = run?.state === 'running' || run?.state === 'paused'
  const canStart = !active && (!saved?.started || run !== null)
  const stopping = confirmation?.action === 'stop'

  return (
    <section className="departure-handoff-run" aria-labelledby={headingId}>
      <Heading id={headingId}>{t('Automatic handoff')}</Heading>
      <p className="user-content">
        <bdi>{host.name.trim() || t('Unnamed team member')}</bdi>
      </p>
      <div ref={feedback} tabIndex={-1}>
        <div role="status">
          {busy && (
            <p>
              {t(busy === 'refresh' ? 'Checking the run receipt…' : 'Updating automatic handoff…')}
            </p>
          )}
          {run && <p>{t(runStates[run.state])}</p>}
          {run?.failureCode && <p>{t(runFailures[run.failureCode])}</p>}
        </div>
        {issue && (
          <p className="alert alert-error" role="alert">
            {t(issue)}
          </p>
        )}
      </div>
      <div className="form-actions">
        {blocked ? (
          <button type="button" className="button button-small" onClick={onReload}>
            {t('Reload team')}
          </button>
        ) : (
          <>
            {canStart && (
              <button
                type="button"
                className="button button-small"
                aria-disabled={busy !== null}
                onClick={(event) => handle('start', event)}
              >
                {t('Start automatic handoff for this departed member')}
              </button>
            )}
            {active &&
              ([run.state === 'paused' ? 'resume' : 'pause', 'stop'] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  className="button button-small"
                  aria-disabled={busy !== null}
                  onClick={(event) => handle(action, event)}
                >
                  {t(controls[action])}
                </button>
              ))}
            {saved && (
              <button
                type="button"
                className="button button-small"
                aria-disabled={busy !== null}
                onClick={(event) => handle('refresh', event)}
              >
                {t('Refresh run receipt')}
              </button>
            )}
          </>
        )}
      </div>
      {run && (
        <>
          <ReceiptHeading>{t('Run receipt')}</ReceiptHeading>
          <ul className="stack">
            {run.items.map((item) => (
              <li key={item.sourceBookingId}>
                <p>
                  {t('Proposal version {version}', { version: item.version })} ·{' '}
                  {t(outcomes[item.outcome])}
                </p>
                <Link to={bookingPath(item.sourceBookingId)}>{t('View original booking')}</Link>
                {item.replacementBookingId && (
                  <>
                    {' · '}
                    <Link to={bookingPath(item.replacementBookingId)}>
                      {t('View replacement booking')}
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {confirmation && (
        <ConfirmationDialog
          heading={t(stopping ? 'Stop automatic handoff?' : 'Start automatic handoff?')}
          description={
            stopping
              ? t(
                  'Remaining bookings will not be processed. Their original bookings stay unchanged.',
                )
              : t(
                  'This run processes up to {count} fully approved bookings, with at least {seconds} seconds between bookings. You can pause or stop it.',
                  {
                    count: MAX_DEPARTURE_HANDOFF_RUN_ITEMS,
                    seconds: DEPARTURE_HANDOFF_ITEM_GAP_SECONDS,
                  },
                )
          }
          confirmLabel={t(stopping ? 'Stop' : 'Start automatic handoff')}
          destructive={stopping}
          onCancel={() => {
            closeConfirmation()
            opener.current = null
          }}
          onConfirm={() => {
            closeConfirmation()
            if (blocked || busy || operation.current || confirmation.run !== run) return
            submit(confirmation.action)
          }}
        />
      )}
    </section>
  )
}
