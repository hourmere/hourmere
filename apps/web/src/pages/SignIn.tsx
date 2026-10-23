import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { type SocialProvider, sendSignInLink, startSocialSignIn } from '../api/auth.ts'
import { api, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { goTo } from '../browser.ts'
import { EmailDeliveryHint } from '../components/EmailDeliveryHint.tsx'
import { LegalLinks } from '../components/LegalLinks.tsx'
import { Logo } from '../components/Logo.tsx'
import { SocialSignInButton } from '../components/SocialSignInButton.tsx'
import { useLoad, usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { safeNextPath, signInPath } from '../next-path.ts'
import { emailError } from '../public/validation.ts'
import { PageStatus, useSession } from '../session.tsx'

const PROVIDERS: SocialProvider[] = ['google', 'microsoft']

const loadInstance = (signal: AbortSignal) => unwrap(api.GET('/api/v1/instance', { signal }))

const INTERRUPTED = 'That sign-in attempt expired or was interrupted. Please try again.'
const USE_EMAIL_LINK = 'Sign in with an email link instead.'
const COULD_NOT_CREATE_ACCOUNT = 'Your account could not be created. Please try again.'
const COULD_NOT_SIGN_IN = 'You could not be signed in. Please try again.'
const NO_NEW_ACCOUNT = 'This Hourmere instance does not accept new accounts for that email address.'

// Better Auth sends people back with ?error=CODE (and an error_description, which is never
// shown: anyone can put text in a link to this page). Codes are matched case-insensitively,
// in a Map: the code comes from the URL, and a plain object would answer `constructor` or
// `__proto__` with what it inherits.
const SIGN_IN_ERRORS = new Map<string, UiText>(
  Object.entries({
    invalid_token:
      'That sign-in link is invalid, has expired or was already used. Request a new one below.',
    expired_token: 'That sign-in link has expired. Request a new one below.',
    email_not_verified: msg('Your sign-in provider did not confirm your email address. {0}', {
      '0': msg(USE_EMAIL_LINK),
    }),
    email_not_found: msg('Your sign-in provider did not share your email address. {0}', {
      '0': msg(USE_EMAIL_LINK),
    }),
    access_denied: 'Sign-in was cancelled.',
    state_mismatch: INTERRUPTED,
    state_not_found: INTERRUPTED,
    please_restart_the_process: INTERRUPTED,
    invalid_callback_request: INTERRUPTED,
    invalid_code: INTERRUPTED,
    no_code: INTERRUPTED,
    account_not_linked: msg('This email address already has an account. {0}', {
      '0': msg(USE_EMAIL_LINK),
    }),
    unable_to_link_account: msg('This sign-in could not be connected to your account. {0}', {
      '0': msg(USE_EMAIL_LINK),
    }),
    email_does_not_match: msg("That account's email address does not match yours. {0}", {
      '0': msg(USE_EMAIL_LINK),
    }),
    account_already_linked_to_different_user: msg(
      'That sign-in account is already connected to another Hourmere account. {0}',
      { '0': msg(USE_EMAIL_LINK) },
    ),
    unable_to_get_user_info:
      'Your sign-in provider did not send your account details. Please try again.',
    // The magic link says failed_to_…, the provider callback unable_to_….
    failed_to_create_user: COULD_NOT_CREATE_ACCOUNT,
    unable_to_create_user: COULD_NOT_CREATE_ACCOUNT,
    failed_to_create_session: COULD_NOT_SIGN_IN,
    unable_to_create_session: COULD_NOT_SIGN_IN,
    // Also SIGNUP_DISABLED, the instance's sign-up policy (codes are matched
    // case-insensitively); existing accounts can always sign in.
    signup_disabled: NO_NEW_ACCOUNT,
    new_user_signup_disabled: NO_NEW_ACCOUNT,
  }),
)

/** What to tell someone sent back to sign-in with `?error=code`; null without an error. */
export function describeSignInError(code: string | null): UiText | null {
  if (code === null) return null
  const known = SIGN_IN_ERRORS.get(code.toLowerCase())
  if (known) return known
  // Unknown codes are named so people can report them, but only if they look like codes.
  const shown = /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? ` (${code})` : ''
  return msg('Sign-in did not work{0}. Please try again.', { '0': shown })
}

type Phase =
  | { kind: 'form'; error: UiText | null }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }

export function SignInPage() {
  const { t } = useI18n()

  usePageTitle('Sign in')
  const { state } = useSession()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  if (state.status === 'loading') return <PageStatus>{t('Loading…')}</PageStatus>
  if (state.status === 'signed-in') return <Navigate to={next} replace />
  const expired = state.status === 'signed-out' && state.reason === 'expired'
  return <SignInForm next={next} expired={expired} />
}

/**
 * `next`: where to land once signed in, already checked to be a path on this site.
 * `expired`: the session ended while the app was open (not on a first visit).
 */
function SignInForm({ next, expired }: { next: string; expired: boolean }) {
  const { t, text, ui } = useI18n()

  const [params, setParams] = useSearchParams()
  const [phase, setPhase] = useState<Phase>(() => ({
    kind: 'form',
    error: describeSignInError(params.get('error')),
  }))
  const [email, setEmail] = useState('')
  const [redirecting, setRedirecting] = useState<SocialProvider | null>(null)
  const [instance] = useLoad(loadInstance)
  const sentHeading = useRef<HTMLHeadingElement>(null)

  // The error was read into state above; take it out of the address bar so a reload or a
  // bookmark does not show it again.
  useEffect(() => {
    if (!params.has('error') && !params.has('error_description')) return
    const rest = new URLSearchParams(params)
    rest.delete('error')
    rest.delete('error_description')
    setParams(rest, { replace: true })
  }, [params, setParams])

  useEffect(() => {
    if (phase.kind === 'sent') sentHeading.current?.focus()
  }, [phase.kind])

  // Better Auth comes back here (keeping `next`) when the link or the provider fails.
  const redirects = { callbackURL: next, errorCallbackURL: signInPath(next) }
  const providers =
    instance.status === 'ready' ? PROVIDERS.filter((p) => instance.data.signIn[p] === true) : []

  async function requestLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const address = email.trim()
    const problem = emailError(address)
    if (problem) {
      setPhase({ kind: 'form', error: problem })
      return
    }
    setPhase({ kind: 'sending' })
    try {
      await sendSignInLink(address, redirects)
      setPhase({ kind: 'sent', email: address })
    } catch (err) {
      setPhase({
        kind: 'form',
        error: msg('Could not send the link. {0}', { '0': errorMessage(err) }),
      })
    }
  }

  async function continueWith(provider: SocialProvider) {
    setRedirecting(provider)
    setPhase({ kind: 'form', error: null })
    try {
      goTo(await startSocialSignIn(provider, redirects))
    } catch (err) {
      setRedirecting(null)
      setPhase({
        kind: 'form',
        error: msg('Could not start sign-in. {0}', { '0': errorMessage(err) }),
      })
    }
  }

  if (phase.kind === 'sent') {
    return (
      <main className="centered">
        <div className="card">
          <header className="card-header">
            <Logo size={32} />
            <LanguageSwitcher />
          </header>
          <h1 ref={sentHeading} tabIndex={-1}>
            {t('Check your email')}
          </h1>
          <p>
            {t('We received your sign-in link request for')} <strong>{phase.email}</strong>
            {t(
              '. If this address can sign in, check your inbox for a link. It works once and expires in a few minutes.',
            )}
          </p>
          <EmailDeliveryHint />
          <button
            type="button"
            className="button button-block"
            onClick={() => setPhase({ kind: 'form', error: null })}
          >
            {t('Use a different email or try again')}
          </button>
          <LegalLinks {...(instance.status === 'ready' ? instance.data : {})} />
        </div>
      </main>
    )
  }

  const busy = phase.kind === 'sending' || redirecting !== null
  return (
    <main className="centered">
      <div className="card">
        <header className="card-header">
          <Logo size={32} />
          <LanguageSwitcher />
        </header>
        <h1>{t('Sign in to Hourmere')}</h1>
        {expired && (
          <p className="alert alert-info" role="status">
            {t('Your session ended. Please sign in again.')}
          </p>
        )}
        {phase.kind === 'form' && phase.error && (
          <p className="alert alert-error" role="alert">
            {ui(phase.error)}
          </p>
        )}
        <form className="stack" onSubmit={requestLink} noValidate>
          <div className="field">
            <label htmlFor="email">{t('Email')}</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button type="submit" className="button button-primary button-block" disabled={busy}>
            {phase.kind === 'sending' ? t('Sending…') : t('Email me a sign-in link')}
          </button>
        </form>
        {providers.length > 0 && (
          <>
            <p className="divider">
              <span>{t('or')}</span>
            </p>
            <div className="stack">
              {providers.map((p) => (
                <SocialSignInButton
                  key={p}
                  provider={p}
                  disabled={busy}
                  opening={redirecting === p}
                  onClick={() => continueWith(p)}
                />
              ))}
            </div>
            {providers.includes('google') && (
              <p className="fine-print" id="google-sign-in-explanation">
                {text(
                  'Google sign-in shares your name, email and profile picture with Hourmere. Calendar access is a separate, optional step in Calendars.',
                )}
              </p>
            )}
            {providers.includes('microsoft') && (
              <p className="fine-print" id="microsoft-sign-in-explanation">
                {t('Use a personal Microsoft account or a work or school account.')}
              </p>
            )}
          </>
        )}
        <p className="fine-print">
          {t('No password needed. New account registration depends on this instance’s settings.')}
        </p>
        <LegalLinks {...(instance.status === 'ready' ? instance.data : {})} />
      </div>
    </main>
  )
}
