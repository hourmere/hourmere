import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { replaceWith } from '../../browser.ts'
import { Field } from '../../components/forms.tsx'
import { useInstance } from '../../components/LegalLinks.tsx'
import { Logo } from '../../components/Logo.tsx'
import { usePageTitle } from '../../hooks.ts'
import '../../i18n/admin.ts'
import { LanguageSwitcher, useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { signInPath } from '../../next-path.ts'
import { PATHS } from '../../paths.ts'
import {
  completeOidcAttempt,
  mailboxToken,
  oidcAttemptId,
  openMailboxProofChannel,
} from './member-protocol.ts'

const unavailable = 'Identity verification is unavailable.'
const invalidLink = 'Could not verify that link. Check the link or request a new email.'
const signInOptions =
  'To continue, sign in with your usual method or use a current team invitation.'
const rateLimited = 'Too many requests. Wait a minute and try again.'
const pasteInstruction =
  'Copy the link from your email and paste it into the tab where you requested verification.'

type MailboxEntry = { attemptId: string; token: string | null }

function parseEntry(hash: string): MailboxEntry | null {
  const params = new URLSearchParams(hash.slice(1))
  const attempts = params.getAll('attempt')
  const tokens = params.getAll('token')
  const attemptId = attempts.length === 1 ? oidcAttemptId(attempts[0]) : null
  const token = tokens[0] ?? null
  if (
    !attemptId ||
    params.size !== 1 + tokens.length ||
    tokens.length > 1 ||
    (token !== null && !/^[A-Za-z0-9_-]{43}$/.test(token))
  )
    return null
  return { attemptId, token }
}

/** The callback link starts a sign-in ceremony. The emailed link confirms possession only. */
export function MailboxProofPage() {
  const { t } = useI18n()
  const { pathname, hash } = useLocation()
  const navigate = useNavigate()
  const instance = useInstance()
  const [visit, setVisit] = useState(() => ({ entry: parseEntry(hash), number: 0 }))
  const read = useRef(hash)
  const heading = useRef<HTMLHeadingElement>(null)
  const oidcAvailable = instance.status === 'ready' && instance.data.ssoOidcEnabled === true
  const confirmationAvailable =
    oidcAvailable ||
    (instance.status === 'ready' &&
      instance.data.scimResourcesEnabled === true &&
      !!visit.entry?.token)
  usePageTitle('Verify your email')

  useLayoutEffect(() => {
    if (hash !== read.current) {
      read.current = hash
      if (hash) {
        setVisit(({ number }) => ({ entry: parseEntry(hash), number: number + 1 }))
        heading.current?.focus()
      }
    }
  }, [hash])

  useEffect(() => {
    if (hash) void navigate(pathname, { replace: true })
  }, [hash, navigate, pathname])

  useEffect(() => heading.current?.focus(), [])

  return (
    <main className="centered">
      <div className="card">
        <header className="card-header">
          <Logo size={32} />
          <LanguageSwitcher />
        </header>
        <h1 ref={heading} tabIndex={-1}>
          {t('Verify your email')}
        </h1>
        {hash || instance.status === 'loading' ? (
          <p role="status">{t('Loading…')}</p>
        ) : confirmationAvailable && visit.entry ? (
          <MailboxAttempt key={visit.number} entry={visit.entry} heading={heading} />
        ) : (
          <>
            <p role="status">{t(confirmationAvailable ? invalidLink : unavailable)}</p>
            <Link to={PATHS.signIn}>{t('Sign in')}</Link>
          </>
        )}
      </div>
    </main>
  )
}

type MailboxPhase = 'start' | 'queued' | 'proven' | 'finished' | 'redirecting'

function MailboxAttempt({
  entry: { attemptId, token },
  heading,
}: {
  entry: MailboxEntry
  heading: RefObject<HTMLHeadingElement | null>
}) {
  const { t } = useI18n()
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const request = useRef<AbortController | null>(null)
  const proofChannel = useRef<BroadcastChannel | null>(null)
  const [phase, setPhase] = useState<MailboxPhase>('start')
  const [canNotifyTab, setCanNotifyTab] = useState<boolean | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)

  useLayoutEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    const channel = openMailboxProofChannel(attemptId)
    if (token) {
      proofChannel.current = channel
      setCanNotifyTab(channel !== null)
    } else if (channel) {
      channel.onmessage = ({ data }) => {
        if (data !== 'proven') return
        setPhase((current) => (current === 'start' || current === 'queued' ? 'proven' : current))
        setError(null)
      }
    }
    return () => {
      proofChannel.current = null
      channel?.close()
    }
  }, [attemptId, token])

  useEffect(() => {
    if (phase === 'queued') input.current?.focus()
    if (phase === 'proven' && !token) continueButton.current?.focus()
    if ((phase === 'proven' && token) || phase === 'finished') heading.current?.focus()
  }, [heading, phase, token])

  async function run(action: (signal: AbortSignal) => Promise<void>, failure: MessageKey) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setWorking(true)
    setError(null)
    try {
      await action(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof RequestError && cause.status === 403 ? unavailable : failure)
    } finally {
      request.current = null
      if (!controller.signal.aborted) setWorking(false)
    }
  }

  function sendEmail() {
    void run(async (signal) => {
      const { status } = await unwrap(
        api.POST('/api/auth/sso/mailbox-proof/send', { body: { attemptId }, signal }),
      )
      if (status !== 'queued') throw new Error('Invalid mailbox send response')
      if (!signal.aborted) setPhase((current) => (current === 'start' ? 'queued' : current))
    }, 'Could not start identity verification. Try again.')
  }

  function verifyEmail(proofToken: string) {
    if (token && !proofChannel.current) return
    void run(async (signal) => {
      const { status } = await unwrap(
        api.POST('/api/auth/sso/mailbox-proof/consume', {
          body: { attemptId, token: proofToken },
          signal,
        }),
      )
      if (status !== 'proven') throw new Error('Invalid mailbox proof response')
      if (signal.aborted) return
      setPhase('proven')
      if (token) proofChannel.current?.postMessage('proven')
    }, invalidLink)
  }

  function verifyPastedLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!input.current) return
    const proofToken = mailboxToken(input.current.value, attemptId)
    input.current.value = ''
    if (!proofToken) {
      setError(invalidLink)
      input.current.focus()
      return
    }
    verifyEmail(proofToken)
  }

  function finishSignIn() {
    void run(async (signal) => {
      const result = await completeOidcAttempt(attemptId, signal).catch((cause: unknown) => {
        if (cause instanceof RequestError && cause.status === 429) throw cause
        return null
      })
      if (signal.aborted) return
      if (result?.kind === 'redirect') {
        setPhase('redirecting')
        replaceWith(result.path)
      } else {
        setPhase('finished')
      }
    }, rateLimited)
  }

  if (phase === 'finished') {
    return (
      <>
        <p role="status">{t(signInOptions)}</p>
        <Link to={signInPath(PATHS.settings)}>{t('Sign in')}</Link>
      </>
    )
  }

  return (
    <div className="stack">
      {error && (
        <p className="alert alert-error" role="alert">
          {t(error)}
        </p>
      )}
      {(working || phase === 'redirecting') && <p role="status">{t('Working…')}</p>}
      {phase === 'proven' ? (
        <>
          <p role="status">{t('Email verification complete.')}</p>
          {token ? (
            <p>{t('Return to the tab where you requested verification to continue.')}</p>
          ) : (
            <button
              ref={continueButton}
              type="button"
              className="button button-primary button-block button-wrap"
              disabled={working}
              onClick={finishSignIn}
            >
              {t('Continue')}
            </button>
          )}
        </>
      ) : phase === 'redirecting' ? null : token ? (
        canNotifyTab ? (
          <button
            type="button"
            className="button button-primary button-block button-wrap"
            disabled={working}
            onClick={() => verifyEmail(token)}
          >
            {t('Verify email link')}
          </button>
        ) : (
          <p role="status">{t(canNotifyTab === null ? 'Loading…' : pasteInstruction)}</p>
        )
      ) : (
        <>
          <button
            type="button"
            className="button button-block button-wrap"
            disabled={working}
            onClick={sendEmail}
          >
            {t('Send verification email')}
          </button>
          {phase === 'queued' && (
            <form className="stack" onSubmit={verifyPastedLink}>
              <Field
                id={inputId}
                label={t('Email verification link')}
                hint={t('Check your Hourmere email. Copy the verification link and paste it here.')}
              >
                {(control) => (
                  <input
                    {...control}
                    ref={input}
                    type="password"
                    autoComplete="off"
                    maxLength={2048}
                    data-private
                    required
                    disabled={working}
                  />
                )}
              </Field>
              <button
                type="submit"
                className="button button-primary button-block button-wrap"
                disabled={working}
              >
                {t('Verify email link')}
              </button>
            </form>
          )}
        </>
      )}
      {!(token && phase === 'proven') && <Link to={PATHS.signIn}>{t('Sign in')}</Link>}
    </div>
  )
}
