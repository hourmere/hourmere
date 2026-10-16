import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { type SocialProvider, sendSignInLink, startSocialSignIn } from '../api/auth.ts'
import { api, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { goTo } from '../browser.ts'
import { Logo } from '../components/Logo.tsx'
import { useLoad, usePageTitle } from '../hooks.ts'
import { safeNextPath, signInPath } from '../next-path.ts'
import { PageStatus, useSession } from '../session.tsx'

const PROVIDERS: { id: SocialProvider; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'microsoft', label: 'Microsoft' },
]

const loadInstance = (signal: AbortSignal) => unwrap(api.GET('/api/v1/instance', { signal }))

const INTERRUPTED = 'That sign-in attempt expired or was interrupted. Please try again.'
const USE_EMAIL_LINK = 'Sign in with an email link instead.'

// Better Auth sends people back with ?error=CODE (and an error_description, which is never
// shown: anyone can put text in a link to this page). Codes are matched case-insensitively,
// in a Map: the code comes from the URL, and a plain object would answer `constructor` or
// `__proto__` with what it inherits.
const SIGN_IN_ERRORS = new Map<string, string>(
  Object.entries({
    invalid_token:
      'That sign-in link is invalid, has expired or was already used. Request a new one below.',
    expired_token: 'That sign-in link has expired. Request a new one below.',
    email_not_verified: `Your sign-in provider did not confirm your email address. ${USE_EMAIL_LINK}`,
    email_not_found: `Your sign-in provider did not share your email address. ${USE_EMAIL_LINK}`,
    access_denied: 'Sign-in was cancelled.',
    state_mismatch: INTERRUPTED,
    state_not_found: INTERRUPTED,
    please_restart_the_process: INTERRUPTED,
    invalid_callback_request: INTERRUPTED,
    invalid_code: INTERRUPTED,
    no_code: INTERRUPTED,
    account_not_linked: `This email address already has an account. ${USE_EMAIL_LINK}`,
    unable_to_link_account: `This sign-in could not be connected to your account. ${USE_EMAIL_LINK}`,
    signup_disabled: 'New accounts cannot be created on this instance.',
    new_user_signup_disabled: 'New accounts cannot be created on this instance.',
  }),
)

/** What to tell someone sent back to sign-in with `?error=code`; null without an error. */
export function describeSignInError(code: string | null): string | null {
  if (code === null) return null
  const known = SIGN_IN_ERRORS.get(code.toLowerCase())
  if (known) return known
  // Unknown codes are named so people can report them, but only if they look like codes.
  const shown = /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? ` (${code})` : ''
  return `Sign-in did not work${shown}. Please try again.`
}

type Phase =
  | { kind: 'form'; error: string | null }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }

export function SignInPage() {
  usePageTitle('Sign in')
  const { state } = useSession()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  if (state.status === 'loading') return <PageStatus>Loading…</PageStatus>
  if (state.status === 'signed-in') return <Navigate to={next} replace />
  return <SignInForm next={next} />
}

/** `next`: where to land once signed in, already checked to be a path on this site. */
function SignInForm({ next }: { next: string }) {
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
    instance.status === 'ready' ? PROVIDERS.filter((p) => instance.data.signIn[p.id] === true) : []

  async function requestLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const address = email.trim()
    setPhase({ kind: 'sending' })
    try {
      await sendSignInLink(address, redirects)
      setPhase({ kind: 'sent', email: address })
    } catch (err) {
      setPhase({ kind: 'form', error: `Could not send the link. ${errorMessage(err)}` })
    }
  }

  async function continueWith(provider: SocialProvider) {
    setRedirecting(provider)
    setPhase({ kind: 'form', error: null })
    try {
      goTo(await startSocialSignIn(provider, redirects))
    } catch (err) {
      setRedirecting(null)
      setPhase({ kind: 'form', error: `Could not start sign-in. ${errorMessage(err)}` })
    }
  }

  if (phase.kind === 'sent') {
    return (
      <main className="centered">
        <div className="card">
          <Logo size={32} />
          <h1 ref={sentHeading} tabIndex={-1}>
            Check your email
          </h1>
          <p>
            We sent a sign-in link to <strong>{phase.email}</strong>. Open it to sign in; it works
            once and expires in a few minutes.
          </p>
          <p className="muted">Nothing there? Check your spam folder, or try again.</p>
          <button
            type="button"
            className="button button-block"
            onClick={() => setPhase({ kind: 'form', error: null })}
          >
            Use a different email
          </button>
        </div>
      </main>
    )
  }

  const busy = phase.kind === 'sending' || redirecting !== null
  return (
    <main className="centered">
      <div className="card">
        <Logo size={32} />
        <h1>Sign in to Hourmere</h1>
        {phase.kind === 'form' && phase.error && (
          <p className="alert alert-error" role="alert">
            {phase.error}
          </p>
        )}
        <form className="stack" onSubmit={requestLink}>
          <div className="field">
            <label htmlFor="email">Email</label>
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
            {phase.kind === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
        {providers.length > 0 && (
          <>
            <p className="divider">
              <span>or</span>
            </p>
            <div className="stack">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="button button-block"
                  disabled={busy}
                  onClick={() => continueWith(p.id)}
                >
                  {redirecting === p.id ? `Opening ${p.label}…` : `Continue with ${p.label}`}
                </button>
              ))}
            </div>
          </>
        )}
        <p className="fine-print">No password needed. New here? Signing in creates your account.</p>
      </div>
    </main>
  )
}
