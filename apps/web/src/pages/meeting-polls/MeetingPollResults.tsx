import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { zoned } from '../../format.ts'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { randomHex } from '../../random.ts'
import { MissingRecord } from '../NotFound.tsx'
import { PollFinalizeForm } from './PollFinalizeForm.tsx'
import { PollLifecycleActions } from './PollLifecycleActions.tsx'
import { PollResultsMatrix } from './PollResultsMatrix.tsx'
import {
  changePoll,
  type FinalizeAttempt,
  type FinalizeBody,
  finalizePoll,
  type LifecycleAction,
  loadPollResults,
  POLL_STATUS,
  type PollResults,
} from './poll-results-api.ts'
import './meeting-poll-results.css'

type Props = {
  id: string
  organizationId: string
  backTo: string
  bookingLink: (id: string) => string
  onDeleted: () => void
}

type WriteIssue =
  | { kind: 'message' | 'refresh' | 'retry'; message: MessageKey }
  | { kind: 'denied' }
  | { kind: 'missing' }
  | { kind: 'context'; error: RequestError }

function readIssue(error: unknown) {
  if (error instanceof RequestError) {
    if (isOrganizationContextChanged(error)) return { kind: 'context', error } as const
    if (error.status === 403) return { kind: 'denied' } as const
    if (error.status === 404) return { kind: 'missing' } as const
  }
}

function writeIssue(error: unknown): WriteIssue {
  const access = readIssue(error)
  if (access) return access
  switch (error instanceof RequestError ? error.code : undefined) {
    case 'poll_changed':
    case 'poll_canceled':
    case 'poll_already_scheduled':
      return {
        kind: 'refresh',
        message: 'This poll changed. Refresh results and review them before continuing.',
      }
    case 'poll_attendee_ineligible':
      return {
        kind: 'refresh',
        message: 'The selected attendees changed. Refresh results and make a new selection.',
      }
    case 'poll_event_changed':
      return {
        kind: 'message',
        message:
          'This event type changed since the poll was created. A new poll is required to schedule it.',
      }
    case 'slot_unavailable':
    case 'slot_taken':
      return {
        kind: 'message',
        message: 'This time is no longer available. Choose another time or refresh results.',
      }
    case 'calendar_sync_unavailable':
      return {
        kind: 'message',
        message: 'Connected calendars could not be checked. Try scheduling again shortly.',
      }
    case 'guests_not_allowed':
      return {
        kind: 'message',
        message: 'This event type does not allow guests. Choose only the booker.',
      }
    case 'too_many_guests':
      return {
        kind: 'message',
        message: 'Too many attendees were selected. Remove an additional attendee and try again.',
      }
    case 'poll_conditional_acknowledgment_required':
      return {
        kind: 'message',
        message: 'Acknowledge the selected conditional votes before scheduling.',
      }
    default:
      return { kind: 'message', message: 'Could not update the meeting poll. Try again.' }
  }
}

const back = (to: string) => ({ to, label: 'Back to meeting polls' })

export function MeetingPollResults(props: Props) {
  const [version, setVersion] = useState(0)
  return (
    <LoadResults
      key={`${props.organizationId}:${props.id}:${version}`}
      {...props}
      refreshed={version > 0}
      refresh={() => setVersion((value) => value + 1)}
    />
  )
}

function LoadResults({
  refreshed,
  refresh,
  ...props
}: Props & { refreshed: boolean; refresh: () => void }) {
  const { t, ui } = useI18n()
  const { id, organizationId, backTo } = props
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return {
          kind: 'results',
          results: await loadPollResults(id, organizationId, signal),
        } as const
      } catch (error) {
        const issue = readIssue(error)
        if (issue) return issue
        throw error
      }
    },
    [id, organizationId],
  )
  const [state, retry] = useLoad(load)
  const title = useRef<HTMLSpanElement>(null)
  usePageTitle('Poll results')
  useEffect(() => {
    if (refreshed && state.status !== 'loading') title.current?.focus()
  }, [refreshed, state.status])

  if (state.status === 'ready' && state.data.kind === 'missing')
    return <MissingPoll backTo={backTo} />
  return (
    <div className="meeting-poll-results">
      <p className="breadcrumb">
        <Link to={backTo}>{t('Back to meeting polls')}</Link>
      </p>
      <PageHeader
        title={
          <span ref={title} tabIndex={-1}>
            {t('Poll results')}
          </span>
        }
      />
      {state.status === 'loading' ? (
        <PageSkeleton label="Loading poll results…" />
      ) : state.status === 'error' ? (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the poll results.')} {ui(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={retry}>
            {t('Try again')}
          </button>
        </div>
      ) : state.data.kind === 'denied' ? (
        <PermissionDenied />
      ) : state.data.kind === 'context' ? (
        <OrganizationContextConflict error={state.data.error} />
      ) : state.data.kind === 'results' ? (
        <ResultsView {...props} results={state.data.results} refresh={refresh} />
      ) : null}
    </div>
  )
}

function MissingPoll({ backTo }: { backTo: string }) {
  return (
    <MissingRecord
      title="Meeting poll unavailable"
      message="This meeting poll is unavailable."
      back={back(backTo)}
    />
  )
}

function PermissionDenied() {
  const { t } = useI18n()
  return (
    <p className="alert alert-error" role="alert">
      {t('Only team owners and admins can manage meeting polls in this space.')}
    </p>
  )
}

function ResultsView({
  id,
  organizationId,
  bookingLink,
  onDeleted,
  results,
  refresh,
}: Props & { results: PollResults; refresh: () => void }) {
  const { t, formatLocale } = useI18n()
  const mounted = useMounted()
  const inflight = useRef(false)
  const issueRef = useRef<HTMLDivElement>(null)
  const bookingRef = useRef<HTMLAnchorElement>(null)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<WriteIssue | null>(null)
  const [confirming, setConfirming] = useState<LifecycleAction | null>(null)
  const [attempt, setAttempt] = useState<FinalizeAttempt | null>(null)
  const [unavailable, setUnavailable] = useState<string[]>([])
  const [finalized, setFinalized] = useState<Awaited<ReturnType<typeof finalizePoll>> | null>(null)
  const poll = finalized?.poll ?? results.poll
  const bookingId = finalized?.booking.id ?? poll.bookingId
  const chosenSlot = results.candidates.find((candidate) => candidate.id === poll.chosenSlotId)
  const booking = finalized?.booking
  const movedBooking =
    booking &&
    chosenSlot &&
    (Date.parse(booking.start) !== Date.parse(chosenSlot.startAt) ||
      Date.parse(booking.end) !== Date.parse(chosenSlot.endAt))
  const canSchedule = poll.status === 'open' || poll.status === 'closed'
  const format = zoned(poll.displayTimeZone, formatLocale)
  const candidates = results.candidates.map((candidate) =>
    unavailable.includes(candidate.id)
      ? { ...candidate, availability: 'unavailable' as const }
      : candidate,
  )

  useEffect(() => {
    if (issue) issueRef.current?.focus()
  }, [issue])
  useEffect(() => {
    if (finalized) bookingRef.current?.focus()
  }, [finalized])

  async function finalize(request: FinalizeAttempt) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setIssue(null)
    setAttempt(request)
    try {
      const response = await finalizePoll(id, organizationId, request)
      if (!mounted.current) return
      setAttempt(null)
      setFinalized(response)
    } catch (error) {
      if (!mounted.current) return
      if (!(error instanceof RequestError) || error.status >= 500 || error.status === 408) {
        // The booking may have committed. Retry the same intent, even if its revisions
        // are now stale, so the service can return its existing booking receipt.
        setIssue({
          kind: 'retry',
          message: 'The booking may have been created. Retry to recover the result.',
        })
        return
      }
      setAttempt(null)
      if (error.code === 'slot_taken' || error.code === 'slot_unavailable')
        setUnavailable((previous) => [...previous, request.body.slotId])
      setIssue(writeIssue(error))
    } finally {
      inflight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function beginFinalization(body: FinalizeBody) {
    if (attempt || confirming || issue?.kind === 'refresh' || inflight.current) return
    void finalize({ key: randomHex(16), body })
  }

  async function lifecycle(action: LifecycleAction) {
    if (attempt || issue?.kind === 'refresh' || inflight.current) return
    inflight.current = true
    setBusy(true)
    setIssue(null)
    try {
      await changePoll(id, organizationId, poll.hostRevision, action)
      if (!mounted.current) return
      if (action === 'delete') onDeleted()
      else refresh()
    } catch (error) {
      if (!mounted.current) return
      const problem = writeIssue(error)
      if (problem.kind !== 'message') setConfirming(null)
      setIssue(problem)
    } finally {
      inflight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (issue?.kind === 'denied') return <PermissionDenied />
  if (issue?.kind === 'missing')
    return (
      <p className="alert alert-error" role="alert">
        {t('This meeting poll is unavailable.')}
      </p>
    )
  if (issue?.kind === 'context') return <OrganizationContextConflict error={issue.error} />

  return (
    <div data-testid="meeting-poll-results">
      <section className="panel" aria-labelledby="meeting-poll-title">
        <h2 id="meeting-poll-title">{poll.title}</h2>
        <p>
          <span className="badge">{t(POLL_STATUS[poll.status] ?? 'Unknown')}</span>
        </p>
        <p>
          {t('Voting deadline: {deadline} ({timeZone})', {
            deadline: format.dateTime(poll.deadlineAt),
            timeZone: format.timeZone,
          })}
        </p>
        {chosenSlot && (
          <p>
            {t('Original scheduled time: {time}', {
              time: format.dateTimeRange(chosenSlot.startAt, chosenSlot.endAt),
            })}
          </p>
        )}
        {movedBooking && (
          <p>
            {t('Current booking time: {time}', {
              time: format.dateTimeRange(booking.start, booking.end),
            })}
          </p>
        )}
        {booking?.status === 'cancelled' && <p>{t('The booking is cancelled.')}</p>}
        {bookingId && (
          <p>
            <Link
              ref={bookingRef}
              to={bookingLink(bookingId)}
              data-testid="meeting-poll-booking-link"
            >
              {t('View booking')}
            </Link>
          </p>
        )}
      </section>
      <PollResultsMatrix results={results} candidates={candidates} showAvailability={canSchedule} />
      {canSchedule && (
        <PollFinalizeForm
          results={results}
          candidates={candidates}
          disabled={busy || Boolean(attempt || confirming) || issue?.kind === 'refresh'}
          busy={busy && Boolean(attempt)}
          onRefresh={issue ? undefined : refresh}
          onFinalize={beginFinalization}
        />
      )}
      {issue && (
        <div ref={issueRef} className="alert alert-error" role="alert" tabIndex={-1}>
          <p>{t(issue.message)}</p>
          {issue.kind === 'retry' && attempt && (
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => void finalize(attempt)}
            >
              {t('Retry scheduling')}
            </button>
          )}
          {issue.kind !== 'retry' && !attempt && (
            <button type="button" className="button button-small" disabled={busy} onClick={refresh}>
              {t('Refresh results')}
            </button>
          )}
        </div>
      )}
      <PollLifecycleActions
        status={poll.status}
        confirmation={confirming}
        busy={busy}
        disabled={Boolean(attempt) || issue?.kind === 'refresh'}
        onChoose={setConfirming}
        onConfirm={(action) => void lifecycle(action)}
      />
    </div>
  )
}
