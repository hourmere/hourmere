import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ListedOrganizationMember } from '../../api/auth.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { SsoFreshProof } from '../../pages/sso/SsoFreshProof.tsx'
import { type SsoProofChallenge, SsoProofRequired } from '../../pages/sso/setup.ts'
import { BreakableText } from '../BreakableText.tsx'
import { UserContentMessage } from '../UserContent.tsx'
import {
  cancelTransfer,
  confirmTransfer,
  getTransferOffer,
  offerTransfer,
  type TransferOffer,
} from './ownership-transfer-api.ts'
import './TeamOwnershipTransfer.css'

type Intent =
  | { action: 'create'; target: ListedOrganizationMember }
  | { action: 'confirm' | 'decline' | 'revoke'; offer: TransferOffer }

type Snapshot =
  | { status: 'loading' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; offer: TransferOffer | null }

const statuses: Record<TransferOffer['state'], MessageKey> = {
  pending: 'Transfer offer pending.',
  confirmed: 'Ownership transfer completed.',
  revoked: 'The transfer offer was revoked or declined.',
  expired: 'The transfer offer expired.',
  invalidated: 'The transfer offer is no longer valid.',
}

function actionError(cause: unknown): MessageKey {
  if (isOrganizationContextChanged(cause))
    return 'Your team context changed. Reload before making changes.'
  if (cause instanceof RequestError) {
    switch (cause.code) {
      case 'ownership_transfer_pending':
        return 'A transfer offer is already pending.'
      case 'ownership_transfer_unavailable':
        return 'This transfer offer is no longer available.'
      case 'scim_managed_resource':
        return 'Memberships managed by your identity provider cannot be transferred.'
      case 'sso_recovery_required':
        return 'The team needs another accepted SSO recovery owner before transferring ownership.'
    }
    if (cause.status === 403) return 'This ownership transfer action is unavailable to you.'
    if (cause.status === 429) return 'Too many requests. Please wait and try again later.'
  }
  return 'Could not update the transfer. Refresh its status before trying again.'
}

export function useTeamOwnershipTransfer(
  enabled: boolean,
  organizationId: string,
  onRolesChanged: () => void,
) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: 'loading' })
  const [target, setTarget] = useState<ListedOrganizationMember | null>(null)
  const [proof, setProof] = useState<{ intent: Intent; challenge: SsoProofChallenge } | null>(null)
  const [issue, setIssue] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [declinedId, setDeclinedId] = useState<string>()
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const read = useRef<AbortController | null>(null)
  const write = useRef<AbortController | null>(null)
  const observed = useRef<TransferOffer | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled || write.current) return
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    const { signal } = controller
    try {
      const previous = observed.current
      const { offer: current } = await getTransferOffer(organizationId, signal)
      const retired =
        previous?.state === 'pending' && current?.id !== previous.id
          ? (await getTransferOffer(organizationId, signal, previous.id)).offer
          : null
      if (signal.aborted) return
      const offer = current ?? retired ?? (previous?.state === 'pending' ? null : previous)
      if (
        previous?.state === 'pending' &&
        (offer?.state !== 'pending' || offer.id !== previous.id) &&
        heading.current?.parentElement?.contains(document.activeElement)
      )
        heading.current.focus()
      if (offer) observed.current = offer
      if (retired?.state === 'confirmed' || retired?.state === 'invalidated') onRolesChanged()
      if (offer?.state === 'pending') setTarget(null)
      setProof((active) => {
        if (!active) return null
        if (active.intent.action === 'create') return offer?.state === 'pending' ? null : active
        return offer?.state === 'pending' && offer.id === active.intent.offer.id ? active : null
      })
      setSnapshot({ status: 'ready', offer })
      return offer
    } catch (cause) {
      if (!signal.aborted) setSnapshot({ status: 'error', cause })
    } finally {
      if (read.current === controller) read.current = null
    }
  }, [enabled, onRolesChanged, organizationId])

  useLayoutEffect(
    () => () => {
      read.current?.abort()
      write.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (!enabled) return
    const recheck = () => {
      if (!read.current) void refresh()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    void refresh()
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      read.current?.abort()
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  const offer = snapshot.status === 'ready' ? snapshot.offer : null
  const deadline = offer?.state === 'pending' ? offer.expiresAt : undefined
  useEffect(() => {
    if (!deadline) return
    let active = true
    const recheck = async () => {
      const current = await refresh()
      // The server decides expiry. A browser clock ahead of the server can fire early.
      if (active && (current?.state === 'pending' || write.current))
        timer = setTimeout(recheck, 30_000)
    }
    let timer = setTimeout(
      recheck,
      Math.min(2_147_483_647, Math.max(0, Date.parse(deadline) - Date.now())),
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [deadline, refresh])

  function select(member: ListedOrganizationMember, button: HTMLButtonElement) {
    opener.current = button
    setIssue(null)
    setTarget(member)
  }

  function dismiss() {
    const button = opener.current
    opener.current = null
    setIssue(null)
    setProof(null)
    setTarget(null)
    if (button?.isConnected && !button.disabled) button.focus()
    else heading.current?.focus()
  }

  async function submit(intent: Intent, proofAttemptId?: string) {
    if (write.current) return
    read.current?.abort()
    const controller = new AbortController()
    write.current = controller
    const { signal } = controller
    setBusy(true)
    setIssue(null)
    let reconcile = true
    try {
      if (intent.action === 'create') {
        const created = await offerTransfer(
          organizationId,
          intent.target.id,
          signal,
          proofAttemptId,
        )
        if (signal.aborted) return
        const offer: TransferOffer = { ...created, state: 'pending', action: 'revoke' }
        observed.current = offer
        setSnapshot({ status: 'ready', offer })
      } else {
        if (intent.action === 'confirm')
          await confirmTransfer(organizationId, intent.offer.id, signal, proofAttemptId)
        else await cancelTransfer(intent.action, organizationId, intent.offer.id, signal)
        if (signal.aborted) return
        const offer: TransferOffer = {
          id: intent.offer.id,
          expiresAt: intent.offer.expiresAt,
          state: intent.action === 'confirm' ? 'confirmed' : 'revoked',
        }
        observed.current = offer
        setSnapshot({ status: 'ready', offer })
        if (intent.action === 'decline') setDeclinedId(offer.id)
        if (intent.action === 'confirm') onRolesChanged()
        reconcile = false
      }
      dismiss()
    } catch (cause) {
      if (signal.aborted) return
      if (cause instanceof SsoProofRequired) {
        setProof({ intent, challenge: cause.challenge })
        reconcile = false
        return
      }
      setIssue(cause)
      if (isOrganizationContextChanged(cause)) {
        reconcile = false
        setTarget(null)
        setProof(null)
        heading.current?.focus()
      } else if (
        cause instanceof RequestError &&
        (cause.code === 'ownership_transfer_unavailable' ||
          cause.code === 'ownership_transfer_pending')
      ) {
        setTarget(null)
        setProof(null)
        onRolesChanged()
        heading.current?.focus()
      }
    } finally {
      write.current = null
      if (!signal.aborted) {
        setBusy(false)
        if (reconcile) void refresh()
      }
    }
  }

  return {
    snapshot,
    offer,
    target,
    proof,
    issue,
    busy,
    declinedId,
    heading,
    refresh,
    select,
    dismiss,
    submit,
  }
}

export function TeamOwnershipTransfer({
  organizationId,
  owner,
  stepUpProviders,
  transfer,
  onReload,
}: {
  organizationId: string
  owner: boolean
  stepUpProviders: { id: string; displayName: string }[]
  transfer: ReturnType<typeof useTeamOwnershipTransfer>
  onReload: () => void
}) {
  const { t, formatLocale } = useI18n()
  const id = useId()
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const { snapshot, offer, target, proof, issue, busy, heading, refresh, dismiss, submit } =
    transfer
  useEffect(() => {
    if (target && !proof) reviewHeading.current?.focus()
  }, [target, proof])
  const pending = offer?.state === 'pending' ? offer : null
  const stale =
    isOrganizationContextChanged(issue) ||
    (snapshot.status === 'error' && isOrganizationContextChanged(snapshot.cause))
  const inReview = owner && target && !pending && snapshot.status === 'ready'
  const canDecide = snapshot.status === 'ready' && pending?.action === 'confirm'
  const canRevoke = snapshot.status === 'ready' && pending?.action === 'revoke'
  const visibleProof = proof && (inReview || canDecide)
  const name = (value: string) => value.trim() || t('Unnamed team member')

  return (
    <section className="team-ownership-transfer" aria-labelledby={`${id}-heading`} aria-busy={busy}>
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
        {t('Team ownership transfer')}
      </h3>
      {stale ? (
        <div className="alert alert-error" role="alert">
          <p>{t('Your team context changed. Reload before making changes.')}</p>
          <button type="button" className="button button-small button-wrap" onClick={onReload}>
            {t('Reload team')}
          </button>
        </div>
      ) : (
        <>
          <p role="status">
            {snapshot.status === 'loading'
              ? t('Checking ownership transfer status…')
              : snapshot.status === 'error'
                ? t('Could not check the transfer status.')
                : offer
                  ? t(
                      offer.id === transfer.declinedId
                        ? 'You declined the transfer offer.'
                        : statuses[offer.state],
                    )
                  : t('No pending transfer offer.')}
          </p>
          {issue != null && (
            <div className="alert alert-error" role="alert">
              <p>{t(actionError(issue))}</p>
              {issue instanceof RequestError && issue.retryAfterSeconds !== undefined && (
                <p>{t('Try again in {0} seconds.', { '0': issue.retryAfterSeconds })}</p>
              )}
            </div>
          )}
          {pending && (
            <>
              {pending.initiator && pending.recipient && (
                <ul>
                  <li>
                    <UserContentMessage
                      message="{initiator} will become an admin."
                      values={{ initiator: name(pending.initiator.displayName) }}
                    />
                  </li>
                  <li>
                    <UserContentMessage
                      message="{recipient} will become the team owner."
                      values={{ recipient: name(pending.recipient.displayName) }}
                    />
                  </li>
                </ul>
              )}
              <p>
                {t('Transfer deadline')}{' '}
                <time dateTime={pending.expiresAt}>
                  {new Intl.DateTimeFormat(formatLocale, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: 'UTC',
                    timeZoneName: 'short',
                  }).format(new Date(pending.expiresAt))}
                </time>
              </p>
            </>
          )}
          {owner && snapshot.status === 'ready' && !pending && !inReview && (
            <p className="hint">{t('Choose a team member below to offer them ownership.')}</p>
          )}
          {inReview && (
            <div className="team-ownership-transfer-review">
              <h4 ref={reviewHeading} tabIndex={-1}>
                {t('Review ownership transfer')}
              </h4>
              <ul>
                <li>{t('You will become an admin when the recipient accepts.')}</li>
                <li>
                  <UserContentMessage
                    message="{recipient} will become the team owner."
                    values={{ recipient: name(target.user.name) }}
                  />
                  {target.user.email && (
                    <div className="hint user-content" dir="ltr">
                      <BreakableText>{target.user.email}</BreakableText>
                    </div>
                  )}
                </li>
              </ul>
            </div>
          )}
          {(inReview || pending?.initiator) && (
            <p className="hint">
              {t(
                'Personal spaces, calendars and provider connections stay with their current accounts. API keys and agent authorizations are not transferred.',
              )}
            </p>
          )}
          {visibleProof && (
            <SsoFreshProof
              key={proof.challenge.attemptId}
              organizationId={organizationId}
              challenge={proof.challenge}
              stepUpProviders={stepUpProviders}
              busy={busy}
              title="Verify your identity for this ownership transfer."
              headingLevel={4}
              onRetry={() => void submit(proof.intent, proof.challenge.attemptId)}
              onCancel={dismiss}
            />
          )}
          {!visibleProof && (
            <div className="form-actions">
              {inReview && (
                <>
                  <button
                    type="button"
                    className="button button-primary button-wrap"
                    disabled={busy}
                    onClick={() => void submit({ action: 'create', target })}
                  >
                    {t('Send transfer offer')}
                  </button>
                  <button
                    type="button"
                    className="button button-wrap"
                    disabled={busy}
                    onClick={dismiss}
                  >
                    {t('Cancel')}
                  </button>
                </>
              )}
              {canDecide && (
                <>
                  <button
                    type="button"
                    className="button button-primary button-wrap"
                    disabled={busy}
                    onClick={() => void submit({ action: 'confirm', offer: pending })}
                  >
                    {t('Accept ownership')}
                  </button>
                  <button
                    type="button"
                    className="button button-wrap"
                    disabled={busy}
                    onClick={() => void submit({ action: 'decline', offer: pending })}
                  >
                    {t('Decline transfer')}
                  </button>
                </>
              )}
              {canRevoke && (
                <button
                  type="button"
                  className="button button-wrap"
                  disabled={busy}
                  onClick={() => void submit({ action: 'revoke', offer: pending })}
                >
                  {t('Revoke transfer')}
                </button>
              )}
              {snapshot.status !== 'loading' && !inReview && (
                <button
                  type="button"
                  className="button button-wrap"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {t('Refresh transfer status')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
