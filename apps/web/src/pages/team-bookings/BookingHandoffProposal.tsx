import { type MouseEvent, useId, useRef, useState } from 'react'
import type { Schemas } from '../../api/client.ts'
import { ConfirmationDialog } from '../../components/ConfirmationDialog.tsx'
import { Field } from '../../components/forms.tsx'
import type { zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { instantOf, wallTime } from '../../public/time.ts'

type Proposal = Schemas['DepartureHandoffProposal']
type Recipient = Proposal['recipients'][number]
export type ConfirmProposalAction = { type: 'withdraw' } | { type: 'resend'; recipientId: string }

const proposalLabels = {
  live: 'Active',
  closed: 'Closed',
  expired: 'Expired',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
} as const satisfies Record<Proposal['state'], MessageKey>

const decisionLabels = {
  pending: 'Awaiting decision',
  approved: 'Approved',
  declined: 'Declined',
} as const satisfies Record<Recipient['decision'], MessageKey>

const deliveryLabels = {
  not_requested: 'Not sent',
  queued: 'Queued',
  unknown: 'Delivery unconfirmed',
  sent: 'Accepted by the mail server',
  failed: 'Delivery failed',
  unavailable: 'Email delivery unavailable',
  skipped: 'Skipped',
} as const satisfies Record<Recipient['delivery'], MessageKey>

function selectedStart(value: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return
  const [, y, m, d, h, min] = match
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(min)
  const instant = instantOf({ year, month, day }, hour, minute, timeZone)
  const wall = wallTime(instant, timeZone)
  // A daylight-saving gap must not silently send a proposal for a later wall time.
  if (
    wall.year === year &&
    wall.month === month &&
    wall.day === day &&
    wall.hour === hour &&
    wall.minute === minute
  ) {
    return new Date(instant).toISOString()
  }
}

export function ProposalDraft({
  hostName,
  hostIsCurrentMember,
  timeZone,
  newVersion,
  disabled,
  onSubmit,
}: {
  hostName: string
  hostIsCurrentMember: boolean | null
  timeZone: string
  newVersion: boolean
  disabled: boolean
  onSubmit: (start?: string) => void
}) {
  const { t } = useI18n()
  const startId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [invalid, setInvalid] = useState(false)
  return (
    <form
      className="team-handoff-proposal-draft"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled) return
        const value = input.current?.value
        const start = value ? selectedStart(value, timeZone) : undefined
        if (value && !start) {
          setInvalid(true)
          input.current?.focus()
          return
        }
        onSubmit(start)
      }}
    >
      <dl className="details">
        <dt>{t(hostIsCurrentMember === false ? 'Departed host' : 'Original host')}</dt>
        <dd>
          <bdi>{hostName}</bdi>
        </dd>
      </dl>
      <Field
        id={startId}
        label={t('Start time')}
        optional
        error={invalid ? 'Enter a valid start time in the displayed time zone.' : undefined}
        hint={
          <>
            {t('Your time zone: {zone}', { zone: timeZone.replaceAll('_', ' ') })}
            <br />
            {t('Leave blank to keep the original booking time.')}
          </>
        }
      >
        {(props) => (
          <input
            {...props}
            ref={input}
            type="datetime-local"
            readOnly={disabled}
            onChange={() => setInvalid(false)}
          />
        )}
      </Field>
      <button type="submit" className="button button-primary" aria-disabled={disabled}>
        {t(newVersion ? 'New version' : 'Create proposal')}
      </button>
    </form>
  )
}

export function ProposalStatus({
  proposal,
  bookerAttendeeId,
  format,
  expired,
  live,
  busy,
  onConfirm,
}: {
  proposal: Proposal
  bookerAttendeeId: string | undefined
  format: ReturnType<typeof zoned>
  expired: boolean
  live: boolean
  busy: boolean
  onConfirm: (action: ConfirmProposalAction, trigger: HTMLButtonElement) => void
}) {
  const { t } = useI18n()
  const headingId = useId()
  const state = expired ? 'expired' : proposal.state
  return (
    <section className="team-handoff-proposal-status" aria-labelledby={headingId}>
      <h4 id={headingId}>{t('Handoff proposal')}</h4>
      <p>{t('Version {version}', { version: proposal.version })}</p>
      <dl className="details">
        <dt>{t('Status')}</dt>
        <dd>{t(proposalLabels[state])}</dd>
        <dt>{t('Expires at')}</dt>
        <dd>
          <time dateTime={proposal.expiresAt}>{format.dateTime(proposal.expiresAt)}</time>
        </dd>
      </dl>
      {proposal.recipients.length ? (
        <ul className="plain-list">
          {proposal.recipients.map((recipient) => (
            <li key={recipient.id}>
              <RecipientStatus
                recipient={recipient}
                isBooker={Boolean(
                  bookerAttendeeId && recipient.attendeeIds.includes(bookerAttendeeId),
                )}
                live={live}
                busy={busy}
                onResend={(event) =>
                  onConfirm({ type: 'resend', recipientId: recipient.id }, event.currentTarget)
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('No recipient status is available for this version.')}</p>
      )}
      {live && (
        <div className="form-actions">
          <button
            type="button"
            className="button button-danger"
            aria-disabled={busy}
            onClick={(event) => onConfirm({ type: 'withdraw' }, event.currentTarget)}
          >
            {t('Withdraw')}
          </button>
        </div>
      )}
    </section>
  )
}

function RecipientStatus({
  recipient,
  isBooker,
  live,
  busy,
  onResend,
}: {
  recipient: Recipient
  isBooker: boolean
  live: boolean
  busy: boolean
  onResend: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  const { t } = useI18n()
  const headingId = useId()
  return (
    <article aria-labelledby={headingId}>
      <h5 id={headingId}>{t(isBooker ? 'Booker' : 'Guest')}</h5>
      <dl className="details">
        <dt>{t('Decision')}</dt>
        <dd>{t(decisionLabels[recipient.decision])}</dd>
        <dt>{t('Delivery')}</dt>
        <dd>{t(deliveryLabels[recipient.delivery])}</dd>
      </dl>
      {live && recipient.resendAvailable ? (
        <button type="button" className="button" aria-disabled={busy} onClick={onResend}>
          {t('Resend')}
        </button>
      ) : (
        <p>{t('Resend unavailable')}</p>
      )}
    </article>
  )
}

export function ProposalConfirmation({
  action,
  onCancel,
  onConfirm,
}: {
  action: ConfirmProposalAction
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  const withdrawing = action.type === 'withdraw'

  return (
    <ConfirmationDialog
      heading={t(withdrawing ? 'Withdraw proposal?' : 'Resend proposal link?')}
      description={t(
        withdrawing
          ? 'Withdrawing revokes all links for this version. The original booking stays confirmed.'
          : 'Sending a new link replaces the recipient’s previous link.',
      )}
      confirmLabel={t(withdrawing ? 'Withdraw' : 'Resend')}
      destructive={withdrawing}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
