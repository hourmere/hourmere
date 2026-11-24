import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { useMe, useSession } from '../../session.tsx'
import type { RecoveryNomination } from './recovery-nomination.ts'
import { SsoFreshProof } from './SsoFreshProof.tsx'
import {
  oidcStepUpProviders,
  type SsoProofChallenge,
  SsoProofRequired,
  unwrapSsoWrite,
} from './setup.ts'
import './sso-setup.css'

const unavailable = 'This recovery nomination is unavailable. Ask a team owner to send a new one.'
const couldNotComplete = 'Could not complete the recovery nomination. Try again.'
const teamChanged = 'Your space changed. Reload before making changes.'

type Write<T> = (signal: AbortSignal, proofAttemptId?: string) => Promise<T>

type Failure = { message: MessageKey; blocked?: true }

function useEnrollmentWrite(accepting: boolean) {
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [pending, setPending] = useState<{
    challenge: SsoProofChallenge
    retry: () => Promise<void>
  } | null>(null)

  useLayoutEffect(() => {
    function reset() {
      request.current?.abort()
      request.current = null
      setPending(null)
      setBusy(false)
    }
    window.addEventListener('pagehide', reset)
    return () => {
      request.current?.abort()
      window.removeEventListener('pagehide', reset)
    }
  }, [])

  function start<T>(
    prepare: (signal: AbortSignal) => Promise<Write<T>>,
    done: (result: T) => void,
  ) {
    async function run(confirmedWrite?: Write<T>, proofAttemptId?: string) {
      if (request.current) return
      const controller = new AbortController()
      request.current = controller
      setBusy(true)
      setFailure(null)
      let write = confirmedWrite
      try {
        write ??= await prepare(controller.signal)
        controller.signal.throwIfAborted()
        const result = await write(controller.signal, proofAttemptId)
        if (controller.signal.aborted) return
        setPending(null)
        done(result)
      } catch (cause) {
        if (controller.signal.aborted) return
        if (cause instanceof SsoProofRequired && write) {
          const { challenge } = cause
          if (!accepting || challenge.proofMethods.join() === 'mailbox') {
            const retry: Write<T> = write
            setPending({ challenge, retry: () => run(retry, challenge.attemptId) })
            return
          }
        }
        setPending(null)
        if (isOrganizationContextChanged(cause)) {
          setFailure({ message: teamChanged, blocked: true })
        } else if (
          cause instanceof RequestError &&
          (cause.status === 403 || cause.status === 404 || cause.status === 401)
        ) {
          setFailure({
            message: accepting ? unavailable : 'SSO settings are unavailable in this team.',
            blocked: true,
          })
        } else if (cause instanceof RequestError && cause.code === 'sso_configuration_changed') {
          setFailure(
            accepting
              ? { message: unavailable, blocked: true }
              : {
                  message: 'These SSO settings changed. Reload before trying again.',
                  blocked: true,
                },
          )
        } else setFailure({ message: couldNotComplete })
      } finally {
        if (request.current === controller) {
          request.current = null
          setBusy(false)
        }
      }
    }
    if (!pending && !failure?.blocked) return run()
    return Promise.resolve()
  }

  return { busy, failure, pending, start, cancelProof: () => setPending(null) }
}

export function SsoRecoveryNomination({
  nominee,
  onClose,
}: {
  nominee: { userId: string; name: string }
  onClose: () => void
}) {
  const { locale, t } = useI18n()
  const { organization, sso } = useMe()
  const { confirmReload } = useSession()
  const heading = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const { busy, failure, pending, start, cancelProof } = useEnrollmentWrite(false)
  const headers = { 'X-Expected-Organization-Id': organization.id }
  const stepUpProviders = oidcStepUpProviders(sso)
  const formattedExpiry =
    expiresAt && Number.isFinite(Date.parse(expiresAt))
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(expiresAt),
        )
      : null

  useEffect(() => headingRef.current?.focus(), [])
  useEffect(() => {
    if (expiresAt) status.current?.focus()
  }, [expiresAt])

  function nominate() {
    void start(
      async (signal) => {
        const { policyRevision } = await unwrap(
          api.GET('/api/v1/team/sso/policy', { headers, signal, cache: 'no-store' }),
        )
        return (signal, proofAttemptId) =>
          unwrapSsoWrite(
            api.POST('/api/v1/team/sso/recovery', {
              headers,
              signal,
              body: {
                expectedRevision: policyRevision,
                ownerUserId: nominee.userId,
                proofAttemptId,
              },
            }),
          )
      },
      (result) => setExpiresAt(result.expiresAt),
    )
  }

  return (
    <section className="panel stack sso-recovery-enrollment" aria-labelledby={heading}>
      <h3 id={heading} ref={headingRef} tabIndex={-1}>
        {t('Nominate a recovery owner')}
      </h3>
      {expiresAt ? (
        <div className="stack">
          <p ref={status} role="status" tabIndex={-1}>
            {t('Recovery nomination sent.')}
          </p>
          {formattedExpiry && (
            <p>{t('The nomination expires on {date}.', { date: formattedExpiry })}</p>
          )}
        </div>
      ) : (
        <>
          <p className="user-content">
            {t('Nominate {name} to become a recovery owner.', { name: nominee.name })}
          </p>
          <p>{t('The nominee has 72 hours to accept using their Hourmere email.')}</p>
        </>
      )}
      {failure && (
        <p className="alert alert-error" role="alert">
          {t(failure.message)}
        </p>
      )}
      {pending && (
        <SsoFreshProof
          key={pending.challenge.attemptId}
          challenge={pending.challenge}
          organizationId={organization.id}
          stepUpProviders={stepUpProviders}
          busy={busy}
          onRetry={() => void pending.retry()}
          onCancel={() => {
            cancelProof()
            headingRef.current?.focus()
          }}
        />
      )}
      {!pending && (
        <div className="form-actions">
          {!expiresAt && !failure?.blocked && (
            <button
              type="button"
              className="button button-primary"
              onClick={nominate}
              disabled={busy}
            >
              {t(busy ? 'Saving…' : 'Send nomination')}
            </button>
          )}
          {failure?.message === teamChanged && (
            <button type="button" className="button" onClick={confirmReload}>
              {t('Reload team')}
            </button>
          )}
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t(expiresAt || failure?.blocked ? 'Close' : 'Cancel')}
          </button>
        </div>
      )}
    </section>
  )
}

export function SsoRecoveryAcceptance({
  nomination,
  access,
  onDismiss,
  onReload,
}: {
  nomination: RecoveryNomination | null
  access: 'loading' | 'error' | 'ready' | 'denied' | 'other-team'
  onDismiss: () => void
  onReload: () => void
}) {
  const { t } = useI18n()
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  const [accepted, setAccepted] = useState(false)
  const { busy, failure, pending, start, cancelProof } = useEnrollmentWrite(true)
  const { confirmReload } = useSession()

  useEffect(() => heading.current?.focus(), [])
  useEffect(() => {
    if (accepted) status.current?.focus()
  }, [accepted])

  function accept() {
    if (!nomination || access !== 'ready') return
    const { enrollmentId, expectedRevision, organizationId } = nomination
    void start(
      async () => (signal, proofAttemptId) =>
        unwrapSsoWrite(
          api.POST('/api/v1/team/sso/recovery/{enrollmentId}/accept', {
            headers: { 'X-Expected-Organization-Id': organizationId },
            params: { path: { enrollmentId } },
            body: { expectedRevision, proofAttemptId },
            signal,
          }),
        ),
      () => setAccepted(true),
    )
  }

  return (
    <section className="panel stack sso-recovery-enrollment" aria-labelledby={id}>
      <h2 id={id} ref={heading} tabIndex={-1}>
        {t('Accept recovery nomination')}
      </h2>
      {accepted ? (
        <p ref={status} role="status" tabIndex={-1}>
          {t('You are now a recovery owner for this team.')}
        </p>
      ) : !nomination || access === 'denied' ? (
        <p className="alert alert-error" role="alert">
          {t(unavailable)}
        </p>
      ) : access === 'other-team' ? (
        <p role="status">
          {t('Switch to the nominated team, then reopen the link from your email.')}
        </p>
      ) : access === 'loading' ? (
        <p role="status">{t('Loading recovery nomination…')}</p>
      ) : access === 'error' ? (
        <div className="alert alert-error" role="alert">
          <p>{t('Could not load the recovery nomination.')}</p>
          <button type="button" className="button" onClick={onReload}>
            {t('Try again')}
          </button>
        </div>
      ) : (
        <>
          <p>{t('Use your Hourmere email to accept the nomination within 72 hours.')}</p>
          <p>
            {t(
              'Recovery owners can verify by email to inspect SSO settings, repair a provider or stop requiring SSO. Each change needs a new verification.',
            )}
          </p>
        </>
      )}
      {failure && (
        <p className="alert alert-error" role="alert">
          {t(failure.message)}
        </p>
      )}
      {pending && nomination && access === 'ready' && (
        <SsoFreshProof
          key={pending.challenge.attemptId}
          challenge={pending.challenge}
          organizationId={nomination.organizationId}
          stepUpProviders={[]}
          busy={busy}
          onRetry={() => void pending.retry()}
          onCancel={() => {
            cancelProof()
            heading.current?.focus()
          }}
        />
      )}
      {!pending && (
        <div className="form-actions">
          {nomination && access === 'ready' && !accepted && !failure?.blocked && (
            <button
              type="button"
              className="button button-primary"
              onClick={accept}
              disabled={busy}
            >
              {t(busy ? 'Saving…' : 'Accept nomination')}
            </button>
          )}
          {failure?.message === teamChanged && (
            <button type="button" className="button" onClick={confirmReload}>
              {t('Reload team')}
            </button>
          )}
          <button type="button" className="button" onClick={onDismiss} disabled={busy}>
            {t('Dismiss')}
          </button>
        </div>
      )}
    </section>
  )
}
