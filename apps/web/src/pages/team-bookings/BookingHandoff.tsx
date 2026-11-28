import { type MouseEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { bookingPath } from '../../paths.ts'

type Preview = Schemas['DepartureHandoffPreview']
type Receipt = Schemas['DepartureHandoffReceipt']
type Action = 'preview' | 'apply'

const pendingConsent =
  'Participant consent is pending. The booker and every guest must approve. The original booking stays confirmed.'
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
    'This handoff offer is closed. Use manual rebooking if you still need to replace the booking.',
} as const

function failureMessage(error: unknown, action: Action): MessageKey {
  if (error instanceof RequestError) {
    if (error.code && Object.hasOwn(handoffIssues, error.code)) {
      const message = handoffIssues[error.code]
      if (message) return message
    }
    if (isOrganizationContextChanged(error)) {
      return 'Your team context changed. Reload before making changes.'
    }
    if (error.status === 403) return "You don't have permission to do that."
  }
  return action === 'apply'
    ? 'Could not confirm whether the handoff completed. Refresh its status before trying again.'
    : 'Could not check the handoff. Refresh to try again.'
}

export function BookingHandoff({
  bookingId,
  expectedOrganizationId,
  timeZone,
  conflict,
  onConflict,
  onRevoked,
  onApplied,
}: {
  bookingId: string
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
  const moveFocus = useRef(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [result, setResult] = useState<Preview | null>(null)
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
  const expiresAt = offer ? Date.parse(offer.expiresAt) : 0
  const offerState =
    (offer?.state === 'pending' || offer?.state === 'ready') && expiresAt <= Date.now()
      ? 'expired'
      : offer?.state
  useEffect(() => {
    if (offerState !== 'ready' && offerState !== 'pending') return
    const timer = window.setTimeout(() => updateClock((count) => count + 1), expiresAt - Date.now())
    return () => window.clearTimeout(timer)
  }, [expiresAt, offerState])

  const canConfirm =
    !conflict &&
    !failure &&
    !receipt &&
    !issue &&
    offerState === 'ready' &&
    preview?.availability === 'available'

  async function run(action: Action, button: HTMLButtonElement) {
    if (conflict || operation.current) return
    if (action === 'apply') {
      if (!canConfirm || !offer) return
      if (expiresAt <= Date.now()) {
        updateClock((count) => count + 1)
        status.current?.focus()
        return
      }
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    const params = {
      path: { id: bookingId },
      header: { 'x-expected-organization-id': expectedOrganizationId },
    }
    try {
      if (action === 'preview') {
        const current = await unwrap(
          api.GET('/api/v1/team/bookings/{id}/handoff-preview', {
            params,
            signal: controller.signal,
          }),
        )
        if (controller.signal.aborted) return
        setResult(current)
        if (current.receipt) {
          setApplied(current.receipt)
          if (!receipt) onApplied()
        }
      } else if (offer) {
        const committed = await unwrap(
          api.POST('/api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply', {
            params: { ...params, path: { ...params.path, offerId: offer.id } },
            body: { version: offer.version },
            signal: controller.signal,
          }),
        )
        if (controller.signal.aborted) return
        setResult(null)
        setApplied(committed)
        onApplied()
      }
      setFailure(null)
    } catch (error) {
      if (controller.signal.aborted) return
      if (isOrganizationContextChanged(error)) onConflict(error)
      else if (error instanceof RequestError && error.code === 'team_management_access_denied') {
        onRevoked()
      }
      setFailure(failureMessage(error, action))
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null
        moveFocus.current = document.activeElement === button
        setBusy(null)
      }
    }
  }

  function handle(action: Action, event: MouseEvent<HTMLButtonElement>) {
    void run(action, event.currentTarget)
  }

  const statusMessage =
    busy === 'preview'
      ? 'Checking handoff…'
      : busy === 'apply'
        ? 'Confirming handoff…'
        : (failure ??
          (receipt
            ? 'Booking handoff completed.'
            : result &&
              (offerState ? offerMessages[offerState] : 'No handoff offer is available yet.')))
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
          {statusMessage && <p>{t(statusMessage)}</p>}
          {!failure && !receipt && result && (
            <PreviewDetails result={result} offerState={offerState} format={format} />
          )}
          {receipt && (
            <>
              <p>
                {t(
                  'The original booking was cancelled and a replacement was created. Cancellation and confirmation notices were queued.',
                )}
              </p>
              {!failure && result?.receipt && <ConferenceStatus receipt={result.receipt} />}
            </>
          )}
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
          onClick={(event) => handle('preview', event)}
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
            onClick={(event) => handle('apply', event)}
          >
            {t('Confirm handoff')}
          </button>
        )}
      </div>
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
