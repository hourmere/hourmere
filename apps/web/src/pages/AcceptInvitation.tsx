import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import {
  acceptInvitation,
  getInvitation,
  getInvitationSession,
  type InvitationDetails,
  listOrganizations,
  setActiveOrganization,
} from '../api/auth.ts'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { InstanceLegalLinks } from '../components/LegalLinks.tsx'
import { Logo } from '../components/Logo.tsx'
import { useMounted, usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { type MessageKey, msg, type UiText } from '../i18n/translate.ts'
import { signInPath } from '../next-path.ts'
import { PATHS } from '../paths.ts'
import { type Me, PageStatus, useSession } from '../session.tsx'

const UNAVAILABLE =
  'This invitation is unavailable. Ask a team owner or admin to open Settings, check Pending invitations, and resend it or send a new invitation if it expired.'
const WRONG_ACCOUNT =
  'Use the exact email address that received this invitation. Change accounts if you signed in with another address.'
const VERIFY_EMAIL =
  'Confirm your email address by signing in with an email link, then return to this invitation.'

function invitationError(error: unknown): UiText {
  if (error instanceof RequestError) {
    const known: ReadonlyMap<string, MessageKey> = new Map([
      ['YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', WRONG_ACCOUNT],
      ['EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION', VERIFY_EMAIL],
      ['EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION', VERIFY_EMAIL],
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
      me={state.me}
      search={location.search}
    />
  )
}

type Lookup =
  | { status: 'loading' }
  | { status: 'ready'; invitation: InvitationDetails; member: boolean }
  | { status: 'error'; message: UiText }

function Invitation({ me, search }: { me: Me; search: string }) {
  const { t, ui } = useI18n()
  const { accept: acceptSession, beginContextSwitch, refresh, signOut } = useSession()
  const navigate = useNavigate()
  const params = new URLSearchParams(search)
  const id = params.get('invitationId')
  const valid =
    params.getAll('invitationId').length === 1 &&
    !!id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  const [lookup, setLookup] = useState<Lookup>({ status: 'loading' })
  const knownInvitation = useRef<InvitationDetails | null>(null)
  const [version, setVersion] = useState(0)
  const [action, setAction] = useState<'idle' | 'accepting' | 'changing' | 'failed' | 'accepted'>(
    'idle',
  )
  const [error, setError] = useState<UiText>('')
  const [checkingContext, setCheckingContext] = useState(false)
  const busy = useRef(false)
  const handoffRelease = useRef<(() => void) | null>(null)
  const mounted = useMounted()

  useEffect(() => () => handoffRelease.current?.(), [])

  // Reads never accept an invitation, including after a lost acceptance response.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly requests a fresh read
  useEffect(() => {
    if (!valid || !id) {
      setLookup({ status: 'error', message: msg(UNAVAILABLE) })
      return
    }
    const controller = new AbortController()
    setLookup({ status: 'loading' })
    async function load() {
      const identity = await getInvitationSession(controller.signal)
      if (
        !identity ||
        identity.user.id !== me.user.id ||
        identity.user.email.toLowerCase() !== me.user.email.toLowerCase()
      )
        throw new RequestError(403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', '')
      if (identity.user.emailVerified !== true)
        throw new RequestError(403, 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION', '')
      let invitation: InvitationDetails
      try {
        invitation = await getInvitation(id as string, controller.signal)
      } catch (err) {
        // A successful read earlier in this page binds recovery to this invitation's
        // team. Never guess a team from a name, slug or another invitation.
        if (
          !knownInvitation.current ||
          !(err instanceof RequestError) ||
          (err.status !== 400 && err.status !== 404)
        )
          throw err
        const organizations = await listOrganizations(controller.signal)
        if (!organizations.some((team) => team.id === knownInvitation.current?.organizationId))
          throw err
        return { status: 'ready' as const, invitation: knownInvitation.current, member: true }
      }
      if (
        invitation.status !== 'pending' ||
        !Number.isFinite(Date.parse(invitation.expiresAt)) ||
        Date.parse(invitation.expiresAt) <= Date.now()
      )
        throw new RequestError(400, 'INVITATION_NOT_FOUND', '')
      const organizations = await listOrganizations(controller.signal)
      knownInvitation.current = invitation
      return {
        status: 'ready' as const,
        invitation,
        member: organizations.some((team) => team.id === invitation.organizationId),
      }
    }
    load().then(
      (result) => {
        if (!controller.signal.aborted) setLookup(result)
      },
      (err: unknown) => {
        if (!controller.signal.aborted)
          setLookup({ status: 'error', message: invitationError(err) })
      },
    )
    return () => controller.abort()
  }, [id, valid, version, me.user.id, me.user.email])

  async function confirmContext(teamId: string) {
    if (!mounted.current) return true
    if (mounted.current) setCheckingContext(true)
    try {
      const current = await unwrap(api.GET('/api/v1/me'))
      // A later deliberate switch owns the new page. Reconcile with a new read rather
      // than publishing this response after the invitation page has been left.
      if (!mounted.current) return true
      if (
        current.user.id !== me.user.id ||
        current.organization.id !== teamId ||
        current.organization.personal
      )
        throw new Error('The joined team could not be confirmed')
      if (mounted.current) navigate(PATHS.home, { replace: true })
      acceptSession(current)
    } catch {
      if (!mounted.current) return true
      if (mounted.current) setError(msg('Could not check your session. Please reload.'))
    } finally {
      if (mounted.current) setCheckingContext(false)
    }
    return false
  }

  const recipient =
    lookup.status === 'ready' &&
    lookup.invitation.email.toLowerCase() === me.user.email.toLowerCase()

  async function accept() {
    if (busy.current || action !== 'idle' || lookup.status !== 'ready' || !recipient || !id) return
    busy.current = true
    const release = beginContextSwitch()
    handoffRelease.current = release
    let reconcile = false
    setAction('accepting')
    setError('')
    try {
      await acceptInvitation(id)
      if (mounted.current) setAction('accepted')
      reconcile = await confirmContext(lookup.invitation.organizationId)
    } catch (err) {
      reconcile = !mounted.current
      if (mounted.current) {
        setAction('failed')
        if (err instanceof RequestError && err.code === 'INVITATION_RECIPIENT_ALREADY_MEMBER') {
          setLookup({ ...lookup, member: true })
          setAction('idle')
        } else setError(invitationError(err))
      }
    } finally {
      release()
      handoffRelease.current = null
      busy.current = false
      if (reconcile) void refresh({ fresh: true })
    }
  }

  async function openTeam() {
    if (busy.current || lookup.status !== 'ready' || !lookup.member) return
    busy.current = true
    const release = beginContextSwitch()
    handoffRelease.current = release
    let reconcile = false
    setCheckingContext(true)
    setError('')
    try {
      await setActiveOrganization({ organizationId: lookup.invitation.organizationId })
      reconcile = await confirmContext(lookup.invitation.organizationId)
    } catch (err) {
      reconcile = !mounted.current
      if (mounted.current) setError(errorMessage(err))
    } finally {
      release()
      handoffRelease.current = null
      busy.current = false
      if (mounted.current) setCheckingContext(false)
      if (reconcile) void refresh({ fresh: true })
    }
  }

  async function retryContext() {
    if (busy.current || lookup.status !== 'ready') return
    busy.current = true
    const release = beginContextSwitch()
    handoffRelease.current = release
    let reconcile = false
    setError('')
    try {
      reconcile = await confirmContext(lookup.invitation.organizationId)
    } finally {
      release()
      handoffRelease.current = null
      busy.current = false
      if (reconcile) void refresh({ fresh: true })
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
            <BreakableText>{me.user.email}</BreakableText>
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
            <Link className="button" to={PATHS.home}>
              {t('Go to Hourmere')}
            </Link>
          </>
        )}
        {lookup.status === 'ready' && (
          <>
            <h2>{t('Invitation to join {team}', { team: lookup.invitation.organizationName })}</h2>
            <p>
              {t('Invited email')}: <BreakableText>{lookup.invitation.email}</BreakableText>
            </p>
            {!recipient ? (
              <p className="alert alert-error" role="alert">
                {t(WRONG_ACCOUNT)}
              </p>
            ) : action === 'accepted' ? (
              <>
                <p role="status">
                  {t('You joined {team}.', { team: lookup.invitation.organizationName })}
                </p>
                {checkingContext ? (
                  <p>{t('Loading…')}</p>
                ) : (
                  <button type="button" className="button" onClick={retryContext}>
                    {t('Try again')}
                  </button>
                )}
              </>
            ) : lookup.member ? (
              <>
                <p>
                  {t('You are already a member of {team}.', {
                    team: lookup.invitation.organizationName,
                  })}
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={checkingContext}
                  onClick={openTeam}
                >
                  {t('Go to team')}
                </button>
              </>
            ) : (
              <>
                <p>
                  {t(
                    'Accepting this invitation joins the team. Signing in alone does not join it.',
                  )}
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
                    {action === 'accepting' ? t('Accepting…') : t('Join team')}
                  </button>
                )}
              </>
            )}
          </>
        )}
        {error && (
          <p className="alert alert-error" role="alert">
            {ui(error)}
          </p>
        )}
        {action !== 'accepted' && (
          <button
            type="button"
            className="button"
            disabled={action === 'accepting' || action === 'changing' || checkingContext}
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
