import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { type SsoProofChallenge, ssoAuthorizationUrl } from './setup.ts'

const unavailable: MessageKey = 'Identity verification is unavailable.'
const startError: MessageKey = 'Could not start identity verification. Try again.'
const linkError: MessageKey = 'Could not verify that link. Check the link or request a new email.'

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function mailboxToken(link: string, attemptId: string) {
  const url = parseAbsoluteUrl(link.trim())
  if (
    !url ||
    url.origin !== window.location.origin ||
    url.pathname !== '/app/mailbox-proof' ||
    url.search ||
    url.username ||
    url.password
  )
    return null
  const params = new URLSearchParams(url.hash.slice(1))
  const attempts = params.getAll('attempt')
  const tokens = params.getAll('token')
  const token = tokens[0]
  return attempts.length === 1 &&
    attempts[0] === attemptId &&
    tokens.length === 1 &&
    token &&
    token.length <= 256
    ? token
    : null
}

export function SsoFreshProof({
  organizationId,
  challenge,
  stepUpProviders,
  busy,
  onRetry,
  onCancel,
}: {
  organizationId: string
  challenge: SsoProofChallenge
  stepUpProviders: { id: string; displayName: string }[]
  busy: boolean
  onRetry: () => void
  onCancel: () => void
}) {
  const { locale, t } = useI18n()
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const sendButton = useRef<HTMLButtonElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const linkInput = useRef<HTMLInputElement>(null)
  const authorizationLink = useRef<HTMLAnchorElement>(null)
  const activeRequest = useRef<AbortController | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)
  const [mailbox, setMailbox] = useState<'start' | 'queued' | 'proven'>('start')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [stepUpUrl, setStepUpUrl] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [submittedChallenge, setSubmittedChallenge] = useState<SsoProofChallenge | null>(null)
  const mailboxRequired = challenge.proofMethods.includes('mailbox')
  const stepUpRequired = challenge.proofMethods.includes('sso')
  const hadMailboxMethod = useRef(mailboxRequired)
  const disabled = busy || working
  const providerId =
    stepUpProviders.find(({ id }) => id === selectedProvider)?.id ?? stepUpProviders[0]?.id
  const canVerify =
    challenge.proofMethods.length > 0 &&
    challenge.proofMethods.every((method) => method === 'mailbox' || method === 'sso') &&
    (!stepUpRequired || !!providerId)
  const canRetry =
    canVerify && (!mailboxRequired || mailbox === 'proven') && (!stepUpRequired || !!stepUpUrl)
  const stepUpPending = stepUpRequired && submittedChallenge && submittedChallenge !== challenge

  useEffect(() => heading.current?.focus(), [])
  useEffect(() => {
    if (mailbox === 'queued') linkInput.current?.focus()
    if (mailbox === 'proven') {
      const button = continueButton.current
      if (button && !button.disabled) button.focus()
      else heading.current?.focus()
    }
  }, [mailbox])
  useEffect(() => {
    if (disabled) return
    if (mailboxRequired && !hadMailboxMethod.current) sendButton.current?.focus()
    hadMailboxMethod.current = mailboxRequired
  }, [disabled, mailboxRequired])
  useEffect(() => {
    if (stepUpUrl) authorizationLink.current?.focus()
  }, [stepUpUrl])
  useLayoutEffect(() => () => activeRequest.current?.abort(), [])
  useEffect(() => {
    const remaining = Date.parse(challenge.expiresAt) - Date.now()
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.min(2_147_483_647, Math.max(0, remaining)),
    )
    return () => window.clearTimeout(timer)
  }, [challenge.expiresAt])

  async function request(action: (signal: AbortSignal) => Promise<void>, failure: MessageKey) {
    if (busy || expired || activeRequest.current) return
    const controller = new AbortController()
    activeRequest.current = controller
    setWorking(true)
    setError(null)
    try {
      await action(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof RequestError && error.status === 403 ? unavailable : failure)
    } finally {
      activeRequest.current = null
      if (!controller.signal.aborted) setWorking(false)
    }
  }

  const { attemptId } = challenge
  const headers = { 'X-Expected-Organization-Id': organizationId }
  const sendEmail = () =>
    request(async (signal) => {
      const { status } = await unwrap(
        api.POST('/api/auth/sso/mailbox-proof/send', { body: { attemptId }, headers, signal }),
      )
      if (status !== 'queued') throw new Error('Invalid mailbox send response')
      if (!signal.aborted) setMailbox('queued')
    }, startError)

  function verifyEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!linkInput.current) return
    const token = mailboxToken(linkInput.current.value, attemptId)
    linkInput.current.value = ''
    if (!token) {
      setError(linkError)
      linkInput.current.focus()
      return
    }
    void request(async (signal) => {
      const { status } = await unwrap(
        api.POST('/api/auth/sso/mailbox-proof/consume', {
          body: { attemptId, token },
          headers,
          signal,
        }),
      )
      if (status !== 'proven') throw new Error('Invalid mailbox proof response')
      if (!signal.aborted) setMailbox('proven')
    }, linkError)
  }

  function startStepUp() {
    if (!providerId) return
    setStepUpUrl(null)
    setSubmittedChallenge(null)
    void request(async (signal) => {
      const { url } = await unwrap(
        api.POST('/api/auth/sign-in/sso', {
          body: { providerId, intent: 'step_up', attemptId, returnTo: PATHS.settings },
          headers,
          signal,
        }),
      )
      if (signal.aborted) return
      setStepUpUrl(ssoAuthorizationUrl(url))
    }, startError)
  }

  return (
    <section className="panel stack sso-fresh-proof" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>
        {t('Confirm your identity before changing SSO settings.')}
      </h2>
      {expired ? (
        <p className="alert alert-error" role="alert">
          {t('This verification request expired. Start again.')}
        </p>
      ) : !canVerify ? (
        <p className="alert alert-error" role="alert">
          {t(unavailable)}
        </p>
      ) : (
        <>
          {error && (
            <p className="alert alert-error" role="alert">
              {t(error)}
            </p>
          )}
          {stepUpPending && (
            <p className="alert alert-error" role="alert">
              {t(
                'Could not confirm your SSO sign-in. Finish signing in or start SSO verification again.',
              )}
            </p>
          )}
          {stepUpRequired && (
            <fieldset className="form-fieldset stack" disabled={disabled}>
              <legend>{t('Verify with single sign-on')}</legend>
              <Field id={`${id}-provider`} label={t('Identity provider')}>
                {(control) => (
                  <select
                    {...control}
                    value={providerId}
                    onChange={(event) => {
                      setSelectedProvider(event.currentTarget.value)
                      setStepUpUrl(null)
                    }}
                  >
                    {stepUpProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div>
                <button type="button" className="button" onClick={startStepUp}>
                  {t('Start SSO verification')}
                </button>
              </div>
              {stepUpUrl && (
                <>
                  <p>
                    <a
                      ref={authorizationLink}
                      href={stepUpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-private
                    >
                      {t('Open identity provider')}
                      {locale === 'zh-CN' ? '' : ' '}
                      {t('(opens in a new tab)')}
                    </a>
                  </p>
                  <p className="hint">
                    {t('After signing in, return to this tab and select Continue.')}
                  </p>
                </>
              )}
            </fieldset>
          )}
          {mailboxRequired && (
            <form onSubmit={verifyEmail}>
              <fieldset className="form-fieldset stack" disabled={disabled}>
                <legend>{t('Verify by email')}</legend>
                {mailbox === 'proven' ? (
                  <p role="status">{t('Email verification complete.')}</p>
                ) : (
                  <>
                    <div>
                      <button
                        ref={sendButton}
                        type="button"
                        className="button"
                        onClick={() => void sendEmail()}
                      >
                        {t('Send verification email')}
                      </button>
                    </div>
                    {mailbox === 'queued' && (
                      <>
                        <Field
                          id={`${id}-email-link`}
                          label={t('Email verification link')}
                          hint={t(
                            'Check your Hourmere email. Copy the verification link and paste it here.',
                          )}
                        >
                          {(control) => (
                            <input
                              {...control}
                              ref={linkInput}
                              type="password"
                              autoComplete="off"
                              maxLength={2048}
                              data-private
                              required
                            />
                          )}
                        </Field>
                        <div>
                          <button type="submit" className="button">
                            {t('Verify email link')}
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </fieldset>
            </form>
          )}
        </>
      )}
      <div className="form-actions">
        <button
          ref={continueButton}
          type="button"
          className="button button-primary"
          disabled={disabled || expired || !canRetry}
          onClick={() => {
            setSubmittedChallenge(challenge)
            onRetry()
          }}
        >
          {t('Continue')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </section>
  )
}
