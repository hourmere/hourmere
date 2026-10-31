import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { resendInvitation } from '../../api/auth.ts'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { browserTimeZone, zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { type MessageKey, msg, type UiText } from '../../i18n/translate.ts'

type Summary = Schemas['TeamInvitationSummary']
const deliveryLabels: Record<Summary['delivery']['state'], MessageKey> = {
  queued: 'Waiting to send',
  sending: 'Submitting to the mail server',
  smtp_accepted: 'Accepted by the mail server',
  failed: 'Submission failed',
  skipped: 'Submission skipped',
  unknown: 'Submission status unknown',
}
const statusLabels: Record<Summary['status'], MessageKey> = {
  pending: 'Pending',
  accepted: 'Joined',
  canceled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired',
  unknown: 'Invitation status unknown',
}
const denialLabels: Record<NonNullable<Summary['resendDeniedReason']>, MessageKey> = {
  TEAM_MANAGEMENT_ACCESS_DENIED: 'You do not have permission to manage invitations.',
  INVITATION_INELIGIBLE: 'This invitation is no longer available for resending.',
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION:
    'The inviter is no longer a team member. Cancel this invitation and send a fresh invitation in your own name.',
  INVITATION_RECIPIENT_ALREADY_MEMBER: 'This address already belongs to a team member.',
  INVITATION_GENERATION_LIMIT: 'This invitation has reached its resend limit.',
  INVITATION_DELIVERY_BUSY: 'Invitation delivery is in progress. Try again shortly.',
  INVITATION_RESEND_COOLDOWN: 'Wait for the resend cooldown before trying again.',
  INVITATION_RATE_LIMITED: 'Invitation requests are temporarily limited. Try again later.',
  INVITATION_CONFLICT:
    'A newer invitation exists for this address. Review the pending invitations.',
  INVITATION_PENDING_LIMIT:
    'This team has reached its pending invitation limit. Resolve pending invitations before inviting more people.',
}

function actionError(error: unknown): UiText {
  if (!(error instanceof RequestError)) return errorMessage(error)
  if (error.code && Object.hasOwn(denialLabels, error.code))
    return msg(denialLabels[error.code as keyof typeof denialLabels])
  if (error.code === 'INVITATION_DELIVERY_UNAVAILABLE')
    return msg(
      'The invitation was saved, but delivery could not be queued. Retry with the same email address.',
    )
  if (error.status === 403) return msg('You do not have permission to manage invitations.')
  return errorMessage(error)
}

/** Mutations leave the row in place until a separate read confirms its current lifecycle. */
export function InvitationRow({
  invitation,
  organizationId,
  onObserved,
}: {
  invitation: Summary
  organizationId: string
  onObserved: (invitation: Summary) => void
}) {
  const { t, ui, locale } = useI18n()
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [needsCheck, setNeedsCheck] = useState(false)
  const [replacementUncertain, setReplacementUncertain] = useState(false)
  const [checked, setChecked] = useState(false)
  const notice = useMemo(
    () =>
      checked
        ? msg(
            invitation.status === 'accepted'
              ? 'The recipient has joined. Their membership was not changed.'
              : invitation.status === 'canceled'
                ? 'Invitation cancelled. Its link can no longer be used.'
                : invitation.status === 'pending' &&
                    invitation.invalidReason === null &&
                    invitation.delivery.state === 'queued'
                  ? 'Invitation queued for delivery.'
                  : 'Invitation status refreshed.',
          )
        : null,
    [checked, invitation.status, invitation.invalidReason, invitation.delivery.state],
  )
  const [remaining, setRemaining] = useState(invitation.resendRetryAfterSeconds)
  const requestIdentity = useMemo(
    () => ({
      invitationId: invitation.id,
      generation: invitation.generation,
      requestId: crypto.randomUUID(),
    }),
    [invitation.id, invitation.generation],
  )
  const currentInvitationId = useRef(invitation.id)
  const replacementFailure = useRef<unknown>(null)
  const request = useRef<AbortController | null>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const start = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const fmt = zoned(browserTimeZone(), locale)
  const conflict = isOrganizationContextChanged(error)
  const invalid = invitation.invalidReason === 'inviter_left'
  const actionable = invitation.status === 'pending' || invitation.status === 'expired'
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    setRemaining(invitation.resendRetryAfterSeconds)
    if (!invitation.resendRetryAfterSeconds) return
    const deadline = Date.now() + invitation.resendRetryAfterSeconds * 1000
    const timer = setInterval(
      () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))),
      1000,
    )
    return () => clearInterval(timer)
  }, [invitation.resendRetryAfterSeconds])
  useEffect(() => {
    if (confirming) keep.current?.focus()
    else if (wasConfirming.current) start.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])
  useEffect(() => {
    if (!busy && (notice || error)) feedback.current?.focus()
  }, [busy, notice, error])

  async function run(action: 'resend' | 'cancel' | 'check') {
    if (request.current || conflict || (needsCheck && action !== 'check')) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setChecked(false)
    setError(null)
    let failure: unknown = null
    try {
      if (action === 'resend') {
        const result = await resendInvitation(
          invitation,
          organizationId,
          requestIdentity.requestId,
          controller.signal,
        )
        currentInvitationId.current = result.id
        replacementFailure.current = null
      }
      if (action === 'cancel')
        await unwrap(
          api.POST('/api/v1/team/invitations/{invitationId}/cancel', {
            params: {
              path: { invitationId: currentInvitationId.current },
              header: { 'x-expected-organization-id': organizationId },
            },
            body: {},
            signal: controller.signal,
          }),
        )
    } catch (caught) {
      failure = caught
      if (
        action === 'resend' &&
        (!(caught instanceof RequestError) || (caught.status >= 500 && !caught.invitationId))
      )
        replacementFailure.current = caught
      if (caught instanceof RequestError && caught.invitationId)
        currentInvitationId.current = caught.invitationId
    }
    if (controller.signal.aborted) return
    if (isOrganizationContextChanged(failure)) {
      setError(failure)
    } else {
      try {
        const current = await unwrap(
          api.GET('/api/v1/team/invitations/{invitationId}', {
            params: {
              path: { invitationId: currentInvitationId.current },
              header: { 'x-expected-organization-id': organizationId },
            },
            signal: controller.signal,
          }),
        )
        if (controller.signal.aborted) return
        if (current.status === 'canceled' && replacementFailure.current) {
          setNeedsCheck(true)
          setReplacementUncertain(true)
          setError(replacementFailure.current)
        } else {
          replacementFailure.current = null
          setReplacementUncertain(false)
          onObserved(current)
          setNeedsCheck(false)
          setConfirming(false)
          setError(current.status === 'pending' || current.status === 'expired' ? failure : null)
          setChecked(true)
        }
      } catch (caught) {
        if (controller.signal.aborted) return
        setNeedsCheck(true)
        setError(caught)
      }
    }
    request.current = null
    setBusy(false)
  }

  return (
    <li className="invitation-row stack" aria-busy={busy}>
      <h3 className="user-content">
        <BreakableText>{t('Invitation to {email}', { email: invitation.email })}</BreakableText>
      </h3>
      <p className="hint">
        <time dateTime={invitation.createdAt}>
          {t('Invited {time}', { time: fmt.dateTime(invitation.createdAt) })}
        </time>
      </p>
      <dl className="details">
        <dt>{t('Status')}</dt>
        <dd>{t(invalid ? 'No longer valid' : statusLabels[invitation.status])}</dd>
        <dt>{t('Mail submission')}</dt>
        <dd>{t(deliveryLabels[invitation.delivery.state])}</dd>
        <dt>{t('Expires')}</dt>
        <dd>
          <time dateTime={invitation.expiresAt}>{fmt.dateTime(invitation.expiresAt)}</time>
        </dd>
      </dl>
      {invitation.status === 'canceled' && (
        <p className="hint">
          {t(
            'An email already being sent may still arrive. This invitation can no longer be used.',
          )}
        </p>
      )}
      {invalid && (
        <p className="hint" id={`${id}-reason`}>
          {t(
            'The inviter is no longer a team member. Cancel this invitation and send a fresh invitation in your own name.',
          )}
        </p>
      )}
      {actionable && !invalid && !invitation.resendAllowed && (
        <p className="hint" id={`${id}-reason`}>
          {t(
            invitation.resendDeniedReason
              ? denialLabels[invitation.resendDeniedReason]
              : 'This invitation cannot be resent. Check its status again.',
          )}
          {remaining !== null && remaining > 0 && (
            <> {t('Try again in {0} seconds.', { '0': remaining })}</>
          )}
          {remaining === 0 && (
            <> {t('Check invitation status to see whether resending is now allowed.')}</>
          )}
        </p>
      )}
      <div ref={feedback} tabIndex={-1}>
        {conflict ? (
          <OrganizationContextConflict error={error} />
        ) : error && (actionable || needsCheck) ? (
          <div className="alert alert-error" role="alert">
            {needsCheck && (
              <p>
                {t(
                  'Could not confirm the invitation status. Check its status before trying another action.',
                )}
              </p>
            )}
            {replacementUncertain && (
              <p>
                {t(
                  'A new invitation may have been saved. Review Pending invitations before trying another action.',
                )}
              </p>
            )}
            <p>{ui(actionError(error))}</p>
            {error instanceof RequestError && error.retryAfterSeconds !== undefined && (
              <p>{t('Try again in {0} seconds.', { '0': error.retryAfterSeconds })}</p>
            )}
          </div>
        ) : notice ? (
          <p role="status">{ui(notice)}</p>
        ) : null}
      </div>
      <div className="form-actions">
        {actionable && (
          <button
            type="button"
            className="button button-small"
            disabled={busy || conflict || needsCheck || invalid || !invitation.resendAllowed}
            aria-describedby={invalid || !invitation.resendAllowed ? `${id}-reason` : undefined}
            onClick={() => void run('resend')}
          >
            {busy
              ? t('Checking invitation…')
              : t(invitation.status === 'expired' ? 'Send a new invitation' : 'Resend invitation')}
          </button>
        )}
        {actionable && !confirming && (
          <button
            ref={start}
            type="button"
            className="button button-small"
            disabled={busy || conflict || needsCheck}
            onClick={() => setConfirming(true)}
          >
            {t('Cancel invitation')}
          </button>
        )}
        <button
          type="button"
          className="button button-small"
          disabled={busy || conflict}
          onClick={() => void run('check')}
        >
          {t('Check invitation status')}
        </button>
      </div>
      {actionable && confirming && (
        <fieldset
          className="confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.stopPropagation()
              setConfirming(false)
            }
          }}
        >
          <legend>{t('Cancel this invitation?')}</legend>
          <p>
            {t(
              'Cancelling only voids this invitation. It never removes a member who has already joined.',
            )}
          </p>
          <div className="confirm-buttons">
            <button
              type="button"
              className="button button-small button-danger"
              disabled={busy || conflict || needsCheck}
              onClick={() => void run('cancel')}
            >
              {busy ? t('Checking invitation…') : t('Confirm cancellation')}
            </button>
            <button
              ref={keep}
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t('Keep invitation')}
            </button>
          </div>
        </fieldset>
      )}
    </li>
  )
}
