import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { type MessageKey, msg, type UiMessage } from '../../i18n/translate.ts'
import { randomHex } from '../../random.ts'
import { PollInviteForm } from './PollInviteForm.tsx'
import { PollPublicLink } from './PollPublicLink.tsx'
import { VOTER_STATUS } from './PollResultsMatrix.tsx'
import {
  type InvitePollBody,
  invitePollVoters,
  isUncertainPollWrite,
  removePollVoter,
  removeUnverifiedPollVoters,
  resendPollInvitation,
  rotatePollLink,
} from './poll-host-api.ts'
import type { PollResults } from './poll-results-api.ts'
import './poll-roster.css'

// One active reservation per mailbox counts toward the enrollment limit.
const ENROLLMENT_LIMIT = 40
const INVITATION_BATCH_LIMIT = 40

const CONFIRMATION = {
  remove: {
    confirm: 'Remove voter',
    prompt:
      'Remove this voter? This deletes their details and ballot, revokes their links and stops queued email. Only a new invitation can let them join again.',
  },
  removeUnverified: {
    confirm: 'Remove unverified sign-ups',
    prompt:
      'Remove all unverified public sign-ups? This revokes their links, stops queued email and frees their places. Voters invited by the host are kept.',
  },
  rotate: {
    confirm: 'Replace public link',
    prompt:
      'Replace the public link? The old link stops working immediately. Links already emailed to individual voters still work.',
  },
} as const

type DestructiveAction =
  | { kind: 'remove'; voterId: string; revision: number }
  | { kind: 'removeUnverified'; revision: number }
  | { kind: 'rotate'; revision: number }

type Write =
  | Exclude<DestructiveAction, { kind: 'rotate' }>
  | (Extract<DestructiveAction, { kind: 'rotate' }> & { key: string })
  | { kind: 'resend'; voterId: string; revision: number; key: string }
  | { kind: 'invite'; body: InvitePollBody; key: string }

type RosterIssue = {
  kind: 'refresh' | 'retry' | 'message'
  message: MessageKey
  retryAfterSeconds?: number | undefined
}

function rosterIssue(error: unknown, write: Write, retrying: boolean): RosterIssue {
  if (isUncertainPollWrite(error)) {
    return 'key' in write
      ? {
          kind: 'retry',
          message:
            'We could not confirm the roster update. Retry the same request to check its outcome.',
        }
      : {
          kind: 'refresh',
          message:
            'We could not confirm the removal. Refresh results to check the roster before trying again.',
        }
  }
  if (error instanceof RequestError) {
    if (error.status === 429)
      return {
        kind: retrying ? 'retry' : 'message',
        message: 'Poll mail requests are limited. Try again later.',
        retryAfterSeconds: error.retryAfterSeconds,
      }
    switch (error.code) {
      case 'poll_link_already_rotated':
        return {
          kind: 'refresh',
          message:
            'The public link was already replaced. Refresh results, then replace it again to get a new link.',
        }
      case 'poll_changed':
      case 'poll_closed':
      case 'poll_canceled':
      case 'poll_already_scheduled':
      case 'poll_not_found':
      case 'poll_link_unavailable':
      case 'voter_withdrawn':
      case 'idempotency_key_reused':
        return {
          kind: 'refresh',
          message:
            'This poll or roster changed. Refresh results and review them before trying again.',
        }
      case 'poll_full':
        return {
          kind: 'message',
          message:
            'There aren’t enough places for all new voters in this batch. No invitations were queued.',
        }
      case 'poll_limit_exceeded':
        return {
          kind: 'message',
          message:
            'Add up to {limit} invitees per batch. If there aren’t enough places for all new voters, the entire batch is refused.',
        }
      case 'invalid_voter':
      case 'invalid_request':
        return { kind: 'message', message: 'Check the form and try again.' }
    }
  }
  return { kind: 'message', message: 'Could not update the invitation roster. Try again.' }
}

export function PollRoster({
  results,
  disabled,
  notice,
  onLockChange,
  onRefresh,
  onAccessError,
}: {
  results: PollResults
  disabled: boolean
  notice: UiMessage | undefined
  onLockChange: (locked: boolean) => void
  onRefresh: (notice?: UiMessage) => void
  onAccessError: (error: RequestError) => void
}) {
  const { t, ui } = useI18n()
  const mounted = useMounted()
  const headingId = useId()
  const resendHintId = useId()
  const inFlight = useRef(false)
  const issueRef = useRef<HTMLDivElement>(null)
  const inviteButton = useRef<HTMLButtonElement>(null)
  const restoreInviteFocus = useRef(false)
  const confirmationTrigger = useRef<HTMLButtonElement>(null)
  const restoreConfirmationFocus = useRef(false)
  const [inviting, setInviting] = useState(false)
  const [confirmation, setConfirmation] = useState<DestructiveAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<Write | null>(null)
  const [issue, setIssue] = useState<RosterIssue | null>(null)
  const [publicLink, setPublicLink] = useState<string | null>(null)
  const { poll, roster } = results
  const { id, organizationId, hostRevision } = poll
  const open = poll.status === 'open'
  const canRemove = open || poll.status === 'closed'
  const publicAdmission = poll.admissionMode === 'public_link'
  const canBulkRemove =
    publicAdmission && canRemove && roster.some((voter) => voter.status === 'pending')
  const canResend = (voter: PollResults['roster'][number]) =>
    open && Boolean(voter.invitedAt) && voter.status !== 'withdrawn'
  const placesUsed = roster.filter((voter) => voter.status !== 'withdrawn').length
  const blocked = busy || Boolean(attempt || publicLink) || issue?.kind === 'refresh'
  const locked = blocked || inviting || Boolean(confirmation)

  useLayoutEffect(() => onLockChange(locked), [locked, onLockChange])
  useLayoutEffect(() => {
    if (!inviting && restoreInviteFocus.current) {
      inviteButton.current?.focus()
      restoreInviteFocus.current = false
    }
  }, [inviting])
  useLayoutEffect(() => {
    if (!confirmation && restoreConfirmationFocus.current) {
      confirmationTrigger.current?.focus()
      restoreConfirmationFocus.current = false
    }
  }, [confirmation])
  useEffect(() => {
    if (issue) issueRef.current?.focus()
  }, [issue])

  async function run(write: Write, retrying = false) {
    if (inFlight.current || disabled || (attempt && !retrying)) return
    inFlight.current = true
    setBusy(true)
    setIssue(null)
    // The attempt contains the original key and payload (including any revision).
    // Keep both through ambiguous responses so the server can return its original receipt.
    if ('key' in write) setAttempt(write)
    try {
      switch (write.kind) {
        case 'invite': {
          const result = await invitePollVoters(id, organizationId, write.body, write.key)
          if (!mounted.current) return
          const unchanged = result.entries.filter(({ outcome }) => outcome === 'unchanged').length
          onRefresh(
            result.replayed
              ? msg('Invitation request recovered. No additional emails were queued.')
              : msg('Invitations queued: {queued}. Existing entries unchanged: {unchanged}.', {
                  queued: result.entries.length - unchanged,
                  unchanged,
                }),
          )
          break
        }
        case 'resend': {
          const result = await resendPollInvitation(
            id,
            organizationId,
            write.voterId,
            write.revision,
            write.key,
          )
          if (mounted.current)
            onRefresh(
              result.replayed
                ? msg('Invitation request recovered. No additional emails were queued.')
                : msg('Invitation queued for delivery.'),
            )
          break
        }
        case 'remove':
          await removePollVoter(id, organizationId, write.voterId, write.revision)
          if (mounted.current) onRefresh(msg('Voter removed.'))
          break
        case 'removeUnverified':
          await removeUnverifiedPollVoters(id, organizationId, write.revision)
          if (mounted.current) onRefresh(msg('Unverified public sign-ups removed.'))
          break
        case 'rotate': {
          const result = await rotatePollLink(id, organizationId, write.revision, write.key)
          if (!mounted.current) return
          if (!result.publicLink) throw new Error('Missing public link in rotation response')
          setPublicLink(result.publicLink)
          break
        }
      }
      if (mounted.current) setAttempt(null)
    } catch (error) {
      if (!mounted.current) return
      if (
        error instanceof RequestError &&
        (error.status === 403 || isOrganizationContextChanged(error))
      ) {
        onAccessError(error)
        return
      }
      const problem = rosterIssue(error, write, retrying)
      if (problem.kind !== 'retry') setAttempt(null)
      setIssue(problem)
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setBusy(false)
        setConfirmation(null)
      }
    }
  }

  function ask(action: DestructiveAction, trigger: HTMLButtonElement) {
    if (disabled || locked || inFlight.current) return
    confirmationTrigger.current = trigger
    setIssue(null)
    setConfirmation(action)
  }

  const confirmationView = confirmation && (
    <RosterConfirmation
      action={confirmation.kind}
      busy={disabled || busy}
      onDismiss={() => {
        restoreConfirmationFocus.current = true
        setConfirmation(null)
      }}
      onConfirm={() =>
        void run(
          confirmation.kind === 'rotate' ? { ...confirmation, key: randomHex(16) } : confirmation,
        )
      }
    />
  )

  return (
    <section
      className="panel poll-roster"
      aria-labelledby={headingId}
      data-testid="meeting-poll-roster"
    >
      <h2 id={headingId}>{t('Invitation roster')}</h2>
      {notice && !locked && !issue && (
        <p className="alert alert-success" role="status" data-testid="meeting-poll-roster-notice">
          {ui(notice)}
        </p>
      )}
      <p>
        {t('Reserved places: {used} of {limit}', { used: placesUsed, limit: ENROLLMENT_LIMIT })}
      </p>
      <p className="hint">
        {t(
          'Verified voters, active invitations and unexpired public sign-ups each reserve a place.',
        )}
      </p>
      {roster.some(canResend) && (
        <p className="hint" id={resendHintId}>
          {t(
            'Resending replaces the invitee’s voting link. You can resend once every 15 minutes, up to three times per address for this poll.',
          )}
        </p>
      )}
      {issue && (
        <div
          ref={issueRef}
          className="alert alert-error"
          role="alert"
          tabIndex={-1}
          data-testid="meeting-poll-roster-error"
        >
          <p>{t(issue.message, { limit: INVITATION_BATCH_LIMIT })}</p>
          {issue.retryAfterSeconds !== undefined && (
            <p>{t('Try again in {0} seconds.', { '0': issue.retryAfterSeconds })}</p>
          )}
          {issue.kind === 'retry' && attempt && (
            <button
              type="button"
              className="button button-small"
              disabled={disabled || busy}
              data-testid="meeting-poll-roster-retry"
              onClick={() => void run(attempt, true)}
            >
              {t('Retry roster request')}
            </button>
          )}
          {issue.kind === 'refresh' && (
            <button
              type="button"
              className="button button-small"
              disabled={disabled || busy}
              data-testid="meeting-poll-roster-refresh"
              onClick={() => onRefresh()}
            >
              {t('Refresh results')}
            </button>
          )}
        </div>
      )}
      {publicLink && (
        <PollPublicLink
          link={publicLink}
          onDismiss={() => {
            setPublicLink(null)
            onRefresh()
          }}
        />
      )}
      <div className="form-actions">
        {open && !inviting && (
          <button
            ref={inviteButton}
            type="button"
            className="button button-primary"
            disabled={disabled || locked}
            data-testid="meeting-poll-invite-open"
            onClick={() => {
              setIssue(null)
              setInviting(true)
            }}
          >
            {t('Invite voters…')}
          </button>
        )}
        {canBulkRemove && (
          <button
            type="button"
            className="button button-small"
            disabled={disabled || locked}
            data-testid="meeting-poll-remove-unverified"
            onClick={(event) =>
              ask({ kind: 'removeUnverified', revision: hostRevision }, event.currentTarget)
            }
          >
            {t('Remove unverified sign-ups…')}
          </button>
        )}
        {publicAdmission && (
          <button
            type="button"
            className="button button-small"
            disabled={disabled || locked}
            data-testid="meeting-poll-rotate-link"
            onClick={(event) =>
              ask({ kind: 'rotate', revision: hostRevision }, event.currentTarget)
            }
          >
            {t('Replace public link…')}
          </button>
        )}
      </div>
      {confirmation?.kind !== 'remove' && confirmationView}
      {inviting && (
        <PollInviteForm
          limit={INVITATION_BATCH_LIMIT}
          publicAdmission={publicAdmission}
          disabled={disabled || blocked || Boolean(confirmation)}
          onSubmit={(body) => void run({ kind: 'invite', body, key: randomHex(16) })}
          onCancel={() => {
            restoreInviteFocus.current = true
            setIssue(null)
            setInviting(false)
          }}
        />
      )}
      {roster.length === 0 ? (
        <p>{t('There are no voters on this poll yet.')}</p>
      ) : (
        <ul className="poll-roster-list">
          {roster.map((voter) => {
            const nameId = `${headingId}-${voter.voterId}`
            return (
              <li key={voter.voterId} className="poll-roster-entry">
                <div data-private>
                  <strong id={nameId} dir="auto">
                    {voter.name}
                  </strong>
                  <div className="meeting-poll-cell-detail">
                    <bdi dir="ltr">
                      <BreakableText>{voter.email}</BreakableText>
                    </bdi>
                  </div>
                  <span className="badge">{t(VOTER_STATUS[voter.status] ?? 'Unknown')}</span>
                </div>
                <div className="form-actions">
                  {canResend(voter) && (
                    <button
                      type="button"
                      className="button button-small"
                      aria-describedby={`${nameId} ${resendHintId}`}
                      disabled={disabled || locked}
                      data-testid="meeting-poll-resend-invitation"
                      onClick={() =>
                        void run({
                          kind: 'resend',
                          voterId: voter.voterId,
                          revision: hostRevision,
                          key: randomHex(16),
                        })
                      }
                    >
                      {t('Resend invitation')}
                    </button>
                  )}
                  {canRemove && (
                    <button
                      type="button"
                      className="button button-small"
                      aria-describedby={nameId}
                      disabled={disabled || locked}
                      data-testid="meeting-poll-remove-voter"
                      onClick={(event) =>
                        ask(
                          { kind: 'remove', voterId: voter.voterId, revision: hostRevision },
                          event.currentTarget,
                        )
                      }
                    >
                      {t('Remove voter…')}
                    </button>
                  )}
                </div>
                {confirmation?.kind === 'remove' &&
                  confirmation.voterId === voter.voterId &&
                  confirmationView}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function RosterConfirmation({
  action,
  busy,
  onDismiss,
  onConfirm,
}: {
  action: DestructiveAction['kind']
  busy: boolean
  onDismiss: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  const promptId = useId()
  const dismiss = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => dismiss.current?.focus(), [])

  return (
    // biome-ignore lint/a11y/useSemanticElements: standalone confirmation buttons need no form
    <div
      className="confirm"
      role="group"
      aria-labelledby={promptId}
      data-testid="meeting-poll-roster-confirmation"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onDismiss()
        }
      }}
    >
      <p id={promptId}>{t(CONFIRMATION[action].prompt)}</p>
      <div className="confirm-buttons">
        <button
          type="button"
          className="button button-small button-danger"
          disabled={busy}
          data-testid="meeting-poll-roster-confirm"
          onClick={onConfirm}
        >
          {t(CONFIRMATION[action].confirm)}
        </button>
        <button
          ref={dismiss}
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={onDismiss}
        >
          {t('Go back')}
        </button>
      </div>
    </div>
  )
}
