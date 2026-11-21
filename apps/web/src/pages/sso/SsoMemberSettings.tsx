import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, type Schemas } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { useMe, useSession } from '../../session.tsx'
import { completeOidcAttempt } from './member-protocol.ts'
import { SsoFreshProof } from './SsoFreshProof.tsx'
import {
  type SsoProofChallenge,
  SsoProofRequired,
  ssoAuthorizationUrl,
  unwrapSsoWrite,
} from './setup.ts'
import './sso-setup.css'

type Summary = Schemas['MeSso']
type Link = Summary['links'][number]
type Operation =
  | { kind: 'link'; providerId: string }
  | { kind: 'unlink'; providerId: string; link: Link }
type PendingProof = { operation: Operation; challenge: SsoProofChallenge }

const unavailable = 'Your team sign-in settings are unavailable.'
const staleLink = 'This SSO link request is unavailable. Start again.'

export function SsoMemberSettings({
  callbackAttemptId,
  onDismissCallback,
}: {
  callbackAttemptId: string | null | undefined
  onDismissCallback: () => void
}) {
  const { t } = useI18n()
  const { organization, sso } = useMe()
  const { refresh, confirmReload } = useSession()
  const [pending, setPending] = useState<PendingProof | null>(null)
  const [authorization, setAuthorization] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [summaryError, setSummaryError] = useState<MessageKey | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  const [status, setStatus] = useState<MessageKey | null>(null)
  const request = useRef<AbortController | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const authorizeLink = useRef<HTMLAnchorElement>(null)
  const callbackHeading = useRef<HTMLHeadingElement>(null)
  const memberHeading = useRef<HTMLHeadingElement>(null)
  const callbackWasActive = useRef(false)
  const hasCallback = callbackAttemptId !== undefined
  const cannotRead = summaryError ?? (!sso ? unavailable : null)
  const callbackVisible = hasCallback && !refreshing && !cannotRead
  const completion = sso?.attempts.find(
    (attempt) =>
      callbackAttemptId === attempt.id &&
      attempt.phase === 'completion' &&
      attempt.mailboxProven &&
      Date.parse(attempt.expiresAt) > Date.now(),
  )
  const completionProvider = sso?.providers.find(({ id }) => id === completion?.providerId)

  useLayoutEffect(() => {
    function reset() {
      request.current?.abort()
      request.current = null
      opener.current = null
      setPending(null)
      setAuthorization(null)
      setBusy(false)
      setRefreshing(false)
      onDismissCallback()
    }
    window.addEventListener('pagehide', reset)
    return () => {
      request.current?.abort()
      request.current = null
      window.removeEventListener('pagehide', reset)
    }
  }, [onDismissCallback])

  useEffect(() => {
    if (callbackVisible) callbackHeading.current?.focus()
    if (!hasCallback && callbackWasActive.current) memberHeading.current?.focus()
    callbackWasActive.current = hasCallback
  }, [callbackVisible, hasCallback])

  useEffect(() => {
    if (authorization) authorizeLink.current?.focus()
    else if (!pending && !busy && opener.current) {
      const target = opener.current.isConnected ? opener.current : memberHeading.current
      target?.focus()
      opener.current = null
    }
  }, [authorization, pending, busy])

  async function readSummary(signal: AbortSignal) {
    setRefreshing(true)
    const updated = await refresh({ fresh: true })
    if (signal.aborted) return
    setRefreshing(false)
    setSummaryError(updated?.sso ? null : updated ? unavailable : 'Could not load SSO settings.')
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await action(controller.signal)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (isOrganizationContextChanged(cause)) {
        setSummaryError('Your space changed. Reload before making changes.')
      } else if (cause instanceof RequestError) {
        if (cause.status === 403 || cause.code === 'sso_disabled') setSummaryError(unavailable)
        else if (cause.code === 'sso_configuration_changed' || cause.code === 'sso_not_found')
          setSummaryError('These SSO settings changed. Reload before trying again.')
        else if (cause.code === 'sso_recovery_required')
          setError('Verify your Hourmere email before unlinking this sign-in method.')
        else setError('Could not save SSO settings.')
      } else setError('Could not save SSO settings.')
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }

  function changeLink(operation: Operation, proofAttemptId?: string) {
    if (!proofAttemptId && document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement
    }
    return run(async (signal) => {
      const options = {
        headers: { 'X-Expected-Organization-Id': organization.id },
        params: { path: { providerId: operation.providerId } },
        signal,
      }
      const proof = proofAttemptId ? { proofAttemptId } : {}
      const path = '/api/v1/team/sso/providers/{providerId}/link'
      try {
        if (operation.kind === 'link') {
          const result = await unwrapSsoWrite(api.POST(path, { ...options, body: proof }))
          if (signal.aborted) return
          setAuthorization(ssoAuthorizationUrl(result.url))
          setPending(null)
        } else {
          const { id: linkId, generation: expectedLinkGeneration } = operation.link
          await unwrapSsoWrite(
            api.DELETE(path, { ...options, body: { linkId, expectedLinkGeneration, ...proof } }),
          )
          if (signal.aborted) return
          setPending(null)
          setStatus('Sign-in method unlinked.')
          await readSummary(signal)
        }
      } catch (cause) {
        if (signal.aborted) return
        setPending(null)
        if (cause instanceof SsoProofRequired) {
          if (proofAttemptId) setError('This verification request expired. Start again.')
          else if (cause.challenge.proofMethods.join() === 'mailbox')
            setPending({ operation, challenge: cause.challenge })
          else setError('Identity verification is unavailable.')
          return
        }
        throw cause
      }
    })
  }

  function confirmCallback() {
    if (!completion || !completionProvider || Date.parse(completion.expiresAt) <= Date.now()) {
      onDismissCallback()
      setError(staleLink)
      return
    }
    void run(async (signal) => {
      try {
        const result = await completeOidcAttempt(completion.id, signal)
        if (signal.aborted) return
        if (result.kind !== 'redirect' || result.path !== PATHS.settings) {
          setError(staleLink)
        } else {
          setStatus('Sign-in method linked.')
          await readSummary(signal)
        }
      } catch (cause) {
        if (signal.aborted) return
        if (cause instanceof RequestError && cause.status === 429) {
          setError('Too many requests. Wait a minute and try again.')
          return
        }
        if (cause instanceof RequestError && cause.status === 403) setSummaryError(unavailable)
        else setError(staleLink)
      }
      if (!signal.aborted) onDismissCallback()
    })
  }

  const providers = sso?.providers ?? []
  const links = sso?.links ?? []
  const unlinked = providers.filter(({ id }) => !links.some(({ providerId }) => providerId === id))
  const actionsBlocked = busy || pending !== null || authorization !== null || hasCallback

  function methodAction(operation: Operation, name: string) {
    const link = operation.kind === 'link'
    return (
      <ConfirmAction
        label={link ? 'Link account' : 'Unlink account'}
        accessibleLabel={t(link ? 'Link account ({name})' : 'Unlink account ({name})', { name })}
        prompt={link ? 'Link this sign-in method?' : 'Unlink this sign-in method?'}
        confirmLabel={link ? 'Link account' : 'Unlink account'}
        busyLabel="Working…"
        failure="Could not save SSO settings."
        onConfirm={() => changeLink(operation)}
      />
    )
  }

  return (
    <section className="panel stack sso-member-settings" aria-labelledby="sso-member-heading">
      <h2 id="sso-member-heading" ref={memberHeading} tabIndex={-1}>
        {t('Your team sign-in')}
      </h2>
      {status && <p role="status">{t(status)}</p>}
      {error && (
        <p className="alert alert-error" role="alert">
          {t(error)}
        </p>
      )}
      {refreshing ? (
        <PageSkeleton label="Loading SSO settings…" />
      ) : cannotRead ? (
        <div className="alert alert-error notice">
          <p role="status">{t(cannotRead)}</p>
          {cannotRead === 'Your space changed. Reload before making changes.' ? (
            <button className="button" type="button" onClick={confirmReload}>
              {t('Reload team')}
            </button>
          ) : (
            <button className="button" type="button" onClick={() => void run(readSummary)}>
              {t('Try again')}
            </button>
          )}
        </div>
      ) : (
        <>
          {hasCallback && (
            <div className="stack">
              <h3 ref={callbackHeading} tabIndex={-1}>
                {t('Confirm your SSO link')}
              </h3>
              {completionProvider ? (
                <p className="user-content">
                  {t('Link {name} to your Hourmere account for this team?', {
                    name: completionProvider.displayName,
                  })}
                </p>
              ) : (
                <p className="alert alert-error" role="alert">
                  {t(staleLink)}
                </p>
              )}
              <div className="form-actions">
                {completionProvider && (
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={busy}
                    onClick={confirmCallback}
                  >
                    {t('Confirm link')}
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={onDismissCallback}
                >
                  {t('Cancel')}
                </button>
              </div>
            </div>
          )}
          {pending && (
            <SsoFreshProof
              key={pending.challenge.attemptId}
              challenge={pending.challenge}
              organizationId={organization.id}
              stepUpProviders={[]}
              busy={busy}
              onRetry={() => void changeLink(pending.operation, pending.challenge.attemptId)}
              onCancel={() => setPending(null)}
            />
          )}
          {authorization && (
            <div className="form-actions">
              <a
                className="button button-primary"
                href={authorization}
                ref={authorizeLink}
                rel="noreferrer"
                data-private
              >
                {t('Continue to identity provider')}
              </a>
              <button className="button" type="button" onClick={() => setAuthorization(null)}>
                {t('Cancel')}
              </button>
            </div>
          )}
          <fieldset
            className="form-fieldset"
            disabled={actionsBlocked}
            inert={actionsBlocked && !busy}
          >
            <p className="hint">
              {t(
                'Manage how you sign in to this team. You can still use your usual sign-in for your personal space.',
              )}
            </p>
            {unlinked.length === 0 && links.length === 0 ? (
              <p>{t('No team sign-in methods are available.')}</p>
            ) : (
              <ul className="stack sso-member-methods">
                {unlinked.map(({ id, displayName }) => (
                  <li key={id}>
                    <p className="user-content">
                      <BreakableText>{displayName}</BreakableText>
                    </p>
                    {methodAction({ kind: 'link', providerId: id }, displayName)}
                  </li>
                ))}
                {links.map((link) => {
                  const name =
                    providers.find(({ id }) => id === link.providerId)?.displayName ??
                    t('Identity provider ({id})', { id: link.providerId })
                  return (
                    <li key={link.id}>
                      <div className="sso-link-reference">
                        <p className="user-content">
                          <BreakableText>{name}</BreakableText>
                        </p>
                        <p className="hint">
                          {t('Identity link ID')} <code data-private>{link.id}</code>
                        </p>
                      </div>
                      {methodAction({ kind: 'unlink', providerId: link.providerId, link }, name)}
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>
        </>
      )}
    </section>
  )
}
