import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError, requestError } from '../../api/errors.ts'
import { zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { bookingPath } from '../../paths.ts'
import {
  type ConfirmProposalAction,
  ProposalConfirmation,
  ProposalDraft,
  ProposalStatus,
} from './BookingHandoffProposal.tsx'

type Preview = Schemas['DepartureHandoffPreview']
type Receipt = Schemas['DepartureHandoffReceipt']
type Proposal = Schemas['DepartureHandoffProposal']
type Action =
  | { type: 'preview' | 'apply' }
  | { type: 'create'; start?: string | undefined }
  | ConfirmProposalAction

const loadingMessages = {
  preview: 'Checking handoff…',
  apply: 'Confirming handoff…',
  create: 'Creating proposal…',
  resend: 'Resending…',
  withdraw: 'Withdrawing proposal…',
} as const satisfies Record<Action['type'], MessageKey>

const pendingConsent =
  'Participant consent is pending. The booker and every guest must approve. A single missing reply blocks the handoff. The original booking stays confirmed.'
const slotUnavailable =
  'That time is unavailable for the replacement host. Refresh the preview or use manual rebooking.'

const handoffIssues: Partial<Record<string, MessageKey>> = {
  calendar_sync_unavailable:
    'Calendar availability could not be verified. Ask the replacement host to check calendar sync, then refresh the preview.',
  location_unavailable:
    'The meeting location is unavailable. Ask the replacement host to check their meeting setup, then refresh the preview.',
  handoff_offer_changed: 'This handoff changed. Refresh the preview before confirming.',
  handoff_offer_not_found: 'This handoff changed. Refresh the preview before confirming.',
  handoff_source_ineligible:
    'This booking is no longer eligible for handoff. Refresh the booking or coordinate a replacement manually.',
  booking_not_found:
    'This booking is no longer eligible for handoff. Refresh the booking or coordinate a replacement manually.',
  handoff_candidate_ineligible:
    'The replacement host is no longer eligible. Check the event type’s host setup, then refresh the preview.',
  handoff_consent_required: pendingConsent,
  handoff_send_limit: 'The send limit for this booking has been reached.',
  handoff_delivery_pending: 'A link is already queued for this recipient.',
  handoff_delivery_unavailable: 'The proposal link could not be queued. Try again later.',
  invalid_handoff_start: 'Enter a valid start time in the displayed time zone.',
  handoffs_disabled: 'Booking handoff is unavailable.',
  sso_required: 'Sign in with this team’s SSO to continue.',
  slot_taken: slotUnavailable,
  slot_unavailable: slotUnavailable,
}

const locationLabels = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  phone: 'Phone call',
  in_person: 'In person',
  link: 'Online meeting',
  microsoft_teams: 'Microsoft Teams',
} as const

const offerMessages = {
  unverified: null,
  pending: pendingConsent,
  ready: 'All participants have approved.',
  expired:
    'Consent has expired. The offer leaves the booking unchanged. A new offer needs new approvals.',
  closed:
    'This handoff offer is closed. A new offer needs fresh approvals from everyone. You can also coordinate a replacement manually.',
} as const

function failureMessage(error: unknown, action: Action['type']): MessageKey {
  if (error instanceof RequestError) {
    if (error.code && Object.hasOwn(handoffIssues, error.code)) {
      const message = handoffIssues[error.code]
      if (message) return message
    }
    if (isOrganizationContextChanged(error)) {
      return 'Your team context changed. Reload before making changes.'
    }
    if (error.status === 401) return 'Your session has ended. Sign in again.'
    if (error.status === 403) return "You don't have permission to do that."
    if (error.status === 429) return 'Too many requests. Wait a minute and try again.'
  }
  if (action === 'apply')
    return 'Could not confirm whether the handoff completed. Refresh its status before trying again.'
  if (action === 'preview') return 'Could not check the handoff. Refresh to try again.'
  return 'Could not verify the proposal change. Refresh handoff before trying again.'
}

function readResendKey(attempt: string) {
  try {
    return sessionStorage.getItem(attempt)
  } catch {
    return null
  }
}

function saveResendKey(attempt: string, key: string | null) {
  try {
    if (key) sessionStorage.setItem(attempt, key)
    else sessionStorage.removeItem(attempt)
  } catch {
    // The open view can still retry with its in-memory key.
  }
}

export function BookingHandoff({
  bookingId,
  departingHost,
  bookerAttendeeId,
  expectedOrganizationId,
  timeZone,
  conflict,
  onConflict,
  onRevoked,
  onApplied,
}: {
  bookingId: string
  departingHost: { name: string; userId: string; isCurrentMember: boolean | null } | undefined
  bookerAttendeeId: string | undefined
  expectedOrganizationId: string
  timeZone: string
  conflict: unknown
  onConflict: (error: unknown) => void
  onRevoked: () => void
  onApplied: () => void
}) {
  const { t, formatLocale } = useI18n()
  const headingId = useId()
  const confirmationId = useId()
  const status = useRef<HTMLElement>(null)
  const operation = useRef<AbortController | null>(null)
  const pendingResendKeys = useRef(new Map<string, string>())
  const moveFocus = useRef(false)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const [busy, setBusy] = useState<Action['type'] | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmProposalAction | null>(null)
  const [result, setResult] = useState<Preview | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [resendQueued, setResendQueued] = useState(false)
  const [applied, setApplied] = useState<Receipt | null>(null)
  const [failure, setFailure] = useState<MessageKey | null>(null)
  const [, updateClock] = useState(0)
  const format = zoned(timeZone, formatLocale)

  useLayoutEffect(() => () => operation.current?.abort(), [])
  useLayoutEffect(() => {
    if (busy || !moveFocus.current) return
    moveFocus.current = false
    status.current?.focus()
  })

  const { offer, preview, issue } = result ?? {}
  const receipt = result?.receipt ?? applied
  const mail = result?.receipt?.mail
  const expiresAt = offer
    ? Math.min(Date.parse(offer.expiresAt), Date.parse(proposal?.expiresAt ?? offer.expiresAt))
    : 0
  const offerState =
    proposal?.state === 'expired' || (offer && offer.state !== 'closed' && expiresAt <= Date.now())
      ? 'expired'
      : proposal && proposal.state !== 'live'
        ? 'closed'
        : offer?.state
  useEffect(() => {
    if (!offerState || offerState === 'expired' || offerState === 'closed') return
    const timer = window.setTimeout(() => updateClock((count) => count + 1), expiresAt - Date.now())
    return () => window.clearTimeout(timer)
  }, [expiresAt, offerState])

  const canWrite = !conflict && !failure && !receipt
  const liveProposal =
    proposal?.state === 'live' && offerState !== 'expired' && offerState !== 'closed'
  const hasDraft =
    departingHost &&
    !receipt &&
    !issue &&
    (offer ? proposal && !liveProposal : preview?.availability === 'available')
  const canCreate = hasDraft && canWrite
  const canConfirm =
    canWrite &&
    liveProposal &&
    !issue &&
    offerState === 'ready' &&
    preview?.availability === 'available'

  const params = {
    path: { id: bookingId },
    header: { 'x-expected-organization-id': expectedOrganizationId },
  }

  async function refresh(signal: AbortSignal) {
    const current = await unwrap(
      api.GET('/api/v1/team/bookings/{id}/handoff-preview', { params, signal }),
    )
    const currentOffer = current.offer
    const currentProposal = currentOffer
      ? await unwrap(
          api.GET('/api/v1/team/bookings/{id}/handoff-offers/{offerId}', {
            params: {
              ...params,
              path: { ...params.path, offerId: currentOffer.id },
            },
            signal,
          }),
        )
      : null
    if (signal.aborted) return
    // The proposal may have been superseded between the two reads.
    if (currentOffer && currentProposal?.version !== currentOffer.version) {
      throw new RequestError(409, 'handoff_offer_changed', '')
    }
    setResult(current)
    setProposal(currentProposal)
    if (current.receipt) {
      setApplied(current.receipt)
      if (!receipt) onApplied()
    }
  }

  async function run(action: Action) {
    if (conflict || operation.current) return
    if (action.type === 'create' && !canCreate) return
    if (action.type === 'apply' || action.type === 'resend' || action.type === 'withdraw') {
      if (!canWrite || !liveProposal || !offer) return
      if (action.type === 'apply' && !canConfirm) return
      if (
        action.type === 'resend' &&
        !proposal?.recipients.some(
          (recipient) => recipient.id === action.recipientId && recipient.resendAvailable,
        )
      )
        return
      if (expiresAt <= Date.now()) {
        updateClock((count) => count + 1)
        status.current?.focus()
        return
      }
    }
    const trigger = document.activeElement
    const controller = new AbortController()
    const signal = controller.signal
    operation.current = controller
    setBusy(action.type)
    setResendQueued(false)
    try {
      if (action.type === 'create' && departingHost) {
        await unwrap(
          api.POST('/api/v1/team/bookings/{id}/handoff-offers', {
            params,
            body: {
              departingUserId: departingHost.userId,
              ...(action.start && { start: action.start }),
              ...(offer && { previous: { offerId: offer.id, version: offer.version } }),
            },
            signal,
          }),
        )
      } else if (offer) {
        const offerParams = { ...params, path: { ...params.path, offerId: offer.id } }
        const body = { version: offer.version }
        if (action.type === 'apply') {
          const committed = await unwrap(
            api.POST('/api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply', {
              params: offerParams,
              body,
              signal,
            }),
          )
          if (signal.aborted) return
          setResult(null)
          setProposal(null)
          setApplied(committed)
          setFailure(null)
          onApplied()
          return
        }
        if (action.type === 'withdraw') {
          await unwrap(
            api.POST('/api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw', {
              params: offerParams,
              body,
              signal,
            }),
          )
        } else if (action.type === 'resend') {
          const attempt = `hourmere:departure-handoff-resend:${offer.id}:${offer.version}:${action.recipientId}`
          const key =
            pendingResendKeys.current.get(attempt) ?? readResendKey(attempt) ?? crypto.randomUUID()
          pendingResendKeys.current.set(attempt, key)
          saveResendKey(attempt, key)
          const { response, error } = await api.POST(
            '/api/v1/team/bookings/{id}/handoff-offers/{offerId}/resend',
            {
              params: {
                ...offerParams,
                header: { ...offerParams.header, 'idempotency-key': key },
              },
              body: { ...body, recipientId: action.recipientId },
              signal,
            },
          )
          if (response.ok || (response.status >= 400 && response.status < 500)) {
            pendingResendKeys.current.delete(attempt)
            saveResendKey(attempt, null)
          }
          if (!response.ok) throw requestError(response.status, error)
        }
      }
      if (!signal.aborted) await refresh(signal)
      if (!signal.aborted) {
        setFailure(null)
        setResendQueued(action.type === 'resend')
      }
    } catch (error) {
      if (signal.aborted) return
      if (isOrganizationContextChanged(error)) onConflict(error)
      else if (error instanceof RequestError && error.code === 'team_management_access_denied') {
        onRevoked()
      }
      setFailure(failureMessage(error, action.type))
    } finally {
      if (!signal.aborted) {
        operation.current = null
        moveFocus.current =
          document.activeElement === trigger || document.activeElement === document.body
        setBusy(null)
      }
    }
  }

  function requestConfirmation(action: ConfirmProposalAction, trigger: HTMLButtonElement) {
    if (!canWrite || !liveProposal || operation.current) return
    dialogTrigger.current = trigger
    setConfirmation(action)
  }

  function closeConfirmation() {
    setConfirmation(null)
    const trigger = dialogTrigger.current
    if (trigger?.isConnected) trigger.focus()
    else status.current?.focus()
    dialogTrigger.current = null
  }

  const statusMessage = busy
    ? loadingMessages[busy]
    : (failure ??
      (receipt
        ? 'Booking handoff completed.'
        : result &&
          (offerState
            ? offerMessages[offerState]
            : !issue && 'No handoff offer is available yet.')))
  const currentPreview = offerState === 'expired' || offerState === 'closed' ? null : preview
  const selectedLocation = currentPreview?.locationKind

  return (
    <section className="team-booking-handoff" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('Booking handoff')}</h3>
      {!result && !receipt && !failure && (
        <p>{t('Preview the replacement host and time. A preview does not reserve the slot.')}</p>
      )}
      <section
        className="team-bookings-focus-target"
        aria-label={t('Handoff status')}
        ref={status}
        tabIndex={-1}
      >
        <div role="status">
          {resendQueued && <p>{t('Proposal link queued.')}</p>}
          {statusMessage && <p>{t(statusMessage)}</p>}
          {!failure && !receipt && result && (
            <PreviewDetails result={result} offerState={offerState} format={format} />
          )}
          {!failure && applied && !result?.receipt && (
            <p>
              {t(
                'The original booking was cancelled and a replacement was created. Cancellation and confirmation notices were queued.',
              )}
            </p>
          )}
          {!failure && mail && <MailStatus mail={mail} />}
          {!failure && result?.receipt && <ConferenceStatus receipt={result.receipt} />}
        </div>
        {!failure && currentPreview && !receipt && (
          <dl className="details">
            <dt>{t('Replacement host')}</dt>
            <dd>
              <bdi>{currentPreview.candidateName}</bdi>
            </dd>
            <dt>{t('Proposed time')}</dt>
            <dd>
              <time dateTime={currentPreview.start}>
                {format.dateTimeRange(currentPreview.start, currentPreview.end)}
              </time>
              <br />
              {t('Your time zone: {zone}', { zone: format.timeZone.replaceAll('_', ' ') })}
            </dd>
            {selectedLocation && (
              <>
                <dt>{t('Location')}</dt>
                <dd>{t(locationLabels[selectedLocation])}</dd>
              </>
            )}
            <dt>{t('Previewed at')}</dt>
            <dd>
              <time dateTime={currentPreview.evaluatedAt}>
                {format.dateTime(currentPreview.evaluatedAt)}
              </time>
            </dd>
          </dl>
        )}
        {receipt && (
          <p>
            <Link to={bookingPath(receipt.replacementBookingId)}>
              {t('View replacement booking')}
            </Link>
          </p>
        )}
      </section>
      {(canConfirm || busy === 'apply') && (
        <p id={confirmationId}>
          {t(
            'Confirming checks the time again, cancels the original booking and creates a separate replacement.',
          )}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="button"
          aria-disabled={Boolean(busy || conflict)}
          onClick={() => void run({ type: 'preview' })}
        >
          {t(result || receipt || failure ? 'Refresh handoff' : 'Preview handoff')}
        </button>
        {!receipt && (offer || busy === 'apply') && (
          <button
            type="button"
            className="button button-primary"
            disabled={!canConfirm && busy !== 'apply'}
            aria-disabled={Boolean(busy || conflict)}
            aria-describedby={canConfirm || busy === 'apply' ? confirmationId : undefined}
            onClick={() => void run({ type: 'apply' })}
          >
            {t('Confirm handoff')}
          </button>
        )}
      </div>
      {proposal && !receipt && !conflict && !failure && (
        <ProposalStatus
          proposal={proposal}
          bookerAttendeeId={bookerAttendeeId}
          format={format}
          expired={offerState === 'expired'}
          live={liveProposal}
          busy={Boolean(busy)}
          onConfirm={requestConfirmation}
        />
      )}
      {departingHost && hasDraft && (
        <ProposalDraft
          key={offer?.version ?? 0}
          hostName={departingHost.name}
          hostIsCurrentMember={departingHost.isCurrentMember}
          timeZone={format.timeZone}
          newVersion={Boolean(offer)}
          disabled={!canCreate || Boolean(busy)}
          onSubmit={(start) => void run({ type: 'create', start })}
        />
      )}
      {confirmation && (
        <ProposalConfirmation
          action={confirmation}
          onCancel={closeConfirmation}
          onConfirm={() => {
            closeConfirmation()
            void run(confirmation)
          }}
        />
      )}
    </section>
  )
}

function PreviewDetails({
  result,
  offerState,
  format,
}: {
  result: Preview
  offerState?: NonNullable<Preview['offer']>['state']
  format: ReturnType<typeof zoned>
}) {
  const { t } = useI18n()
  const { offer, preview, issue } = result
  const problem = issue
    ? handoffIssues[issue]
    : offerState !== 'expired' && offerState !== 'closed' && preview?.availability === 'unavailable'
      ? slotUnavailable
      : null
  return (
    <>
      {offer && (
        <p>
          {t('Consent deadline: {time}', { time: format.dateTime(offer.expiresAt) })}
          {offerState === 'pending' && offer.outstandingApprovals !== undefined && (
            <>
              <br />
              {t('Pending approvals: {count}', { count: offer.outstandingApprovals })}
            </>
          )}
        </p>
      )}
      {problem && <p>{t(problem)}</p>}
      {!problem &&
        offerState !== 'expired' &&
        offerState !== 'closed' &&
        preview?.availability === 'available' && <p>{t('The proposed time is available.')}</p>}
    </>
  )
}

type MailReceipt = NonNullable<Preview['receipt']>['mail']

const mailStatusMessages = {
  pending: 'Mail server acceptance unconfirmed',
  accepted: 'Accepted by the mail server',
  incomplete: 'Email delivery incomplete',
  unavailable: 'Email delivery unavailable',
} as const satisfies Record<MailReceipt['cancellation'], MessageKey>

function MailStatus({ mail }: { mail: MailReceipt }) {
  const { t } = useI18n()
  return (
    <dl className="details">
      <dt>{t('Attendee cancellation email')}</dt>
      <dd>{t(mailStatusMessages[mail.cancellation])}</dd>
      <dt>{t('Attendee confirmation email')}</dt>
      <dd>{t(mailStatusMessages[mail.confirmation])}</dd>
    </dl>
  )
}

function ConferenceStatus({ receipt }: { receipt: NonNullable<Preview['receipt']> }) {
  const { t } = useI18n()
  return (
    <>
      {receipt.conference === 'pending' && (
        <p>
          {t(
            'The replacement meeting link is being prepared. Refresh the handoff to check its status.',
          )}
        </p>
      )}
      {receipt.conference === 'ready' && <p>{t('The replacement meeting link is ready.')}</p>}
      {receipt.conference === 'failed' && (
        <p>
          {t(
            'The replacement meeting link could not be verified. The replacement booking is confirmed. Ask its host to check their meeting account, then refresh the handoff.',
          )}
        </p>
      )}
      {receipt.conference === 'unknown' && (
        <p>
          {t('The replacement meeting status is unavailable. Refresh the handoff to check again.')}
        </p>
      )}
      {receipt.oldConferenceCleanup === 'pending' && (
        <p>{t('Cleanup in the original calendar or meeting account is pending.')}</p>
      )}
      {receipt.oldConferenceCleanup === 'complete' && (
        <p>
          {t(
            'Cleanup of the tracked entries in the original calendar or meeting account is complete.',
          )}
        </p>
      )}
      {receipt.oldConferenceCleanup === 'unresolved' && (
        <p>
          {t(
            'Cleanup in the original calendar or meeting account could not be verified. Ask the account owner to check for remaining entries.',
          )}
        </p>
      )}
    </>
  )
}
