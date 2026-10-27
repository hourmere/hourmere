import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { acceptInvitation, getInvitation, type InvitationDetails } from '../api/auth.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { InstanceLegalLinks } from '../components/LegalLinks.tsx'
import { Logo } from '../components/Logo.tsx'
import { useMounted, usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { type MessageKey, msg, type UiText } from '../i18n/translate.ts'
import { signInPath } from '../next-path.ts'
import { PATHS } from '../paths.ts'
import { PageStatus, useSession } from '../session.tsx'

const UNAVAILABLE =
  'This invitation is unavailable. It may have expired, been canceled or already been accepted. Ask the team owner for a new invitation.'
const WRONG_ACCOUNT =
  'Use the exact email address that received this invitation. Change accounts if you signed in with another address.'

function invitationError(error: unknown): UiText {
  if (error instanceof RequestError) {
    const known: ReadonlyMap<string, MessageKey> = new Map([
      ['YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', WRONG_ACCOUNT],
      [
        'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION',
        'Confirm your email address by signing in with an email link, then return to this invitation.',
      ],
      [
        'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
        'Confirm your email address by signing in with an email link, then return to this invitation.',
      ],
      [
        'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED',
        'This team cannot accept more members. Contact the team owner.',
      ],
    ])
    const key = error.code && known.get(error.code)
    if (key) return msg(key)
    if (error.status === 400 || error.status === 404) return msg(UNAVAILABLE)
  }
  return errorMessage(error)
}

/** Session-gated outside AppShell: accepting changes the active organization. */
export function AcceptInvitationPage() {
  const { t } = useI18n()
  usePageTitle('Accept invitation')
  const { state, reload } = useSession()
  const location = useLocation()
  if (state.status === 'loading') return <PageStatus>{t('Loading…')}</PageStatus>
  if (state.status === 'signed-out')
    return <Navigate to={signInPath(location.pathname + location.search)} replace />
  if (state.status === 'error')
    return (
      <PageStatus>
        <p>{t('Could not check your session. Please reload.')}</p>
        <button type="button" className="button" onClick={reload}>
          {t('Try again')}
        </button>
      </PageStatus>
    )
  return (
    <Invitation
      key={`${state.me.user.id}:${location.search}`}
      email={state.me.user.email}
      search={location.search}
    />
  )
}

type Lookup =
  | { status: 'loading' }
  | { status: 'ready'; invitation: InvitationDetails }
  | { status: 'error'; message: UiText }

function Invitation({ email, search }: { email: string; search: string }) {
  const { t, ui } = useI18n()
  const { refresh, signOut } = useSession()
  const params = new URLSearchParams(search)
  const id = params.get('invitationId')
  const valid =
    params.getAll('invitationId').length === 1 &&
    !!id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  const [lookup, setLookup] = useState<Lookup>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const [action, setAction] = useState<'idle' | 'accepting' | 'changing' | 'failed' | 'accepted'>(
    'idle',
  )
  const [error, setError] = useState<UiText>('')
  const [contextReady, setContextReady] = useState(false)
  const [checkingContext, setCheckingContext] = useState(false)
  const busy = useRef(false)
  const mounted = useMounted()

  // Rechecking is read-only. A lost acceptance response never repeats the write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly requests a fresh read
  useEffect(() => {
    if (!valid || !id) {
      setLookup({ status: 'error', message: msg(UNAVAILABLE) })
      return
    }
    const controller = new AbortController()
    setLookup({ status: 'loading' })
    getInvitation(id, controller.signal).then(
      (invitation) => {
        if (!controller.signal.aborted) setLookup({ status: 'ready', invitation })
      },
      (err: unknown) => {
        if (!controller.signal.aborted)
          setLookup({ status: 'error', message: invitationError(err) })
      },
    )
    return () => controller.abort()
  }, [id, valid, version])

  async function confirmContext() {
    if (mounted.current) setCheckingContext(true)
    // Acceptance activates the team on the server even if this page was left meanwhile.
    const current = await refresh({ fresh: true })
    if (mounted.current) {
      setContextReady(current !== null)
      setCheckingContext(false)
    }
  }

  async function accept() {
    if (busy.current || action !== 'idle' || lookup.status !== 'ready' || !id) return
    busy.current = true
    setAction('accepting')
    setError('')
    try {
      await acceptInvitation(id)
      if (mounted.current) setAction('accepted')
      await confirmContext()
    } catch (err) {
      if (mounted.current) {
        setAction('failed')
        setError(invitationError(err))
      }
    } finally {
      busy.current = false
    }
  }

  async function changeAccount() {
    if (busy.current) return
    const previousAction = action
    busy.current = true
    setAction('changing')
    setError('')
    try {
      await signOut()
    } catch (err) {
      if (mounted.current) {
        setAction(previousAction)
        setError(errorMessage(err))
      }
    } finally {
      busy.current = false
    }
  }

  function recheck() {
    if (busy.current) return
    setError('')
    setAction('idle')
    setVersion((v) => v + 1)
  }

  return (
    <main className="centered">
      <section className="card stack">
        <header className="card-header">
          <Logo size={32} />
          <LanguageSwitcher />
        </header>
        <h1>{t('Accept invitation')}</h1>
        <p>
          {t('Signed in as')}{' '}
          <strong>
            <BreakableText>{email}</BreakableText>
          </strong>
          {t('.')}
        </p>
        {lookup.status === 'loading' && <p role="status">{t('Checking invitation…')}</p>}
        {lookup.status === 'error' && (
          <>
            <p className="alert alert-error" role="alert">
              {ui(lookup.message)}
            </p>
            {valid && (
              <button type="button" className="button" onClick={recheck}>
                {t('Check invitation status')}
              </button>
            )}
          </>
        )}
        {lookup.status === 'ready' &&
          (action === 'accepted' ? (
            <>
              <p role="status">
                {t('You joined {team}.', { team: lookup.invitation.organizationName })}
              </p>
              {contextReady ? (
                <Link className="button button-primary" to={PATHS.home}>
                  {t('Go to Hourmere')}
                </Link>
              ) : checkingContext ? (
                <p>{t('Loading…')}</p>
              ) : (
                <>
                  <p role="alert">{t('Could not check your session. Please reload.')}</p>
                  <button type="button" className="button" onClick={confirmContext}>
                    {t('Try again')}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <h2>
                {t('Invitation to join {team}', { team: lookup.invitation.organizationName })}
              </h2>
              <p>
                {t('Accepting this invitation joins the team. Signing in alone does not join it.')}
              </p>
              {action === 'failed' ? (
                <>
                  <p>
                    {t(
                      'Could not confirm acceptance. Check the invitation status before trying again.',
                    )}
                  </p>
                  <button type="button" className="button" onClick={recheck}>
                    {t('Check invitation status')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={action !== 'idle'}
                  onClick={accept}
                >
                  {action === 'accepting' ? t('Accepting…') : t('Accept invitation')}
                </button>
              )}
            </>
          ))}
        {error && (
          <p className="alert alert-error" role="alert">
            {ui(error)}
          </p>
        )}
        {action !== 'accepted' && (
          <button
            type="button"
            className="button"
            disabled={action === 'accepting' || action === 'changing'}
            onClick={changeAccount}
          >
            {action === 'changing' ? t('Changing account…') : t('Change account')}
          </button>
        )}
        <InstanceLegalLinks />
      </section>
    </main>
  )
}
