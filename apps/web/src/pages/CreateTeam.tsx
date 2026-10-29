import { isPublicTeamSlug, isReservedName } from '@hourmere/core/reserved'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import {
  createOrganization,
  listOrganizations,
  type Organization,
  type OrganizationMember,
  setActiveOrganization,
} from '../api/auth.ts'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { ErrorSummary, Field, type FieldErrors } from '../components/forms.tsx'
import { OrganizationContextConflict } from '../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { PATHS, publicTeamPageUrl, TEAM_LINK_SLUG_HINT } from '../paths.ts'
import { type Me, useMe, useSession } from '../session.tsx'
import { useUnsavedChanges } from '../unsaved-changes.tsx'

const NAME_ERROR = 'Enter a team name on one line, up to 200 characters.'
const ADDRESS_TAKEN = 'This team address is already in use. Choose another one.'
const LABELS = { teamName: 'Team name', teamSlug: 'Team public address' }
interface Draft {
  name: string
  slug: string
}
interface PendingCreation extends Draft {
  addressTaken: boolean
}

function addressConflictDraft(state: unknown, me: Me): Draft | null {
  if (!state || typeof state !== 'object' || !('teamAddressConflict' in state)) return null
  const draft = state.teamAddressConflict
  return draft &&
    typeof draft === 'object' &&
    'name' in draft &&
    'slug' in draft &&
    'userId' in draft &&
    draft.userId === me.user.id &&
    'organizationId' in draft &&
    draft.organizationId === me.organization.id &&
    me.organization.personal &&
    typeof draft.name === 'string' &&
    typeof draft.slug === 'string'
    ? { name: draft.name, slug: draft.slug }
    : null
}

function validate({ name, slug }: Draft): FieldErrors {
  const errors: FieldErrors = {}
  if (!name || name.length > 200 || !name.isWellFormed() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name))
    errors.teamName = NAME_ERROR
  if (!isPublicTeamSlug(slug))
    errors.teamSlug = isReservedName(slug)
      ? 'This team address is reserved. Choose another one.'
      : TEAM_LINK_SLUG_HINT
  return errors
}

export function CreateTeamPage() {
  const { t, ui } = useI18n()
  usePageTitle('Create team')
  const me = useMe()
  const [openedContext] = useState(me)
  const { refresh, accept } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [restored] = useState(() => addressConflictDraft(location.state, me))
  const mounted = useMounted()
  const [draft, setDraft] = useState<Draft>(restored ?? { name: '', slug: '' })
  const [errors, setErrors] = useState<FieldErrors>(restored ? { teamSlug: ADDRESS_TAKEN } : {})
  const [message, setMessage] = useState<UiText | null>(null)
  const [contextError, setContextError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(restored ? 1 : 0)
  const [focusSlug, setFocusSlug] = useState(Boolean(restored))
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  // Keep the submitted address fixed until reads establish whether creation committed.
  const [uncertain, setUncertain] = useState<PendingCreation | null>(null)
  const [retrySlug, setRetrySlug] = useState<string | null>(null)
  const [created, setCreated] = useState<Organization | null>(null)
  const [createdMember, setCreatedMember] = useState<OrganizationMember | null>(null)
  const createdRole = createdMember?.role
  const [complete, setComplete] = useState(false)
  useUnsavedChanges(!complete && Boolean(draft.name || draft.slug))
  const slugField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const recovered = addressConflictDraft(location.state, me)
    if (recovered) {
      // Router navigation can arrive after the session's keyed remount. Only the page
      // for the confirmed caller/context may apply and consume this handoff.
      setDraft(recovered)
      setErrors({ teamSlug: ADDRESS_TAKEN })
      setFocusSlug(true)
      setAttempt((value) => value + 1)
      const state = { ...location.state }
      delete state.teamAddressConflict
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: Object.keys(state).length ? state : null },
      )
    }
  }, [location, navigate, me])

  // ErrorSummary focuses first; address failures then lead directly to the address control.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each failed submit repeats focus
  useEffect(() => {
    if (focusSlug) slugField.current?.focus()
  }, [attempt, focusSlug])

  function report(err: unknown) {
    setMessage(isOrganizationContextChanged(err) ? null : errorMessage(err))
    setContextError(err)
    setAttempt((value) => value + 1)
  }

  function addressConflict() {
    setCreated(null)
    setCreatedMember(null)
    setUncertain(null)
    setRetrySlug(null)
    setMessage(null)
    setContextError(null)
    setErrors({ teamSlug: ADDRESS_TAKEN })
    setFocusSlug(true)
    setAttempt((value) => value + 1)
  }

  async function openTeam(organization: Organization, member = createdMember, current?: Me) {
    const before = current ?? (await unwrap(api.GET('/api/v1/me')))
    if (!mounted.current) return
    if (
      before.user.id !== openedContext.user.id ||
      (before.organization.id !== openedContext.organization.id &&
        before.organization.id !== organization.id)
    )
      throw new RequestError(409, 'organization_context_changed', '')
    // Activation may have committed even when its confirmation was lost. Confirm that
    // target without switching again; a different live team must never be overwritten.
    let confirmed = before
    if (before.organization.id !== organization.id) {
      await setActiveOrganization(
        { organizationId: organization.id },
        undefined,
        openedContext.organization.id,
      )
      if (!mounted.current) return
      confirmed = await unwrap(api.GET('/api/v1/me'))
      if (!mounted.current) return
    }
    if (confirmed.user.id !== me.user.id || confirmed.organization.id !== organization.id)
      throw new RequestError(409, 'organization_context_changed', '')
    // The list endpoint has no personal marker. A recovered organization must be checked
    // through /me before treating it as a team or publishing a team membership.
    if (confirmed.organization.personal) {
      addressConflict()
      if (confirmed.organization.id !== me.organization.id) {
        // Publishing the new context remounts this page; keep the draft and field error
        // in this history entry just long enough for that remount to consume them.
        navigate(PATHS.newTeam, {
          replace: true,
          state: {
            teamAddressConflict: {
              ...draft,
              userId: confirmed.user.id,
              organizationId: confirmed.organization.id,
            },
          },
        })
        accept(confirmed)
      }
      return
    }
    setComplete(true)
    navigate(PATHS.settings, { replace: true, state: { createdMember: member } })
    accept(confirmed)
  }

  async function reconcile(submitted: PendingCreation) {
    // Both reads must succeed before a new create attempt can be offered. This function
    // never repeats the creation POST, including when a confirmation response was lost.
    const [current, organizations] = await Promise.all([refresh(), listOrganizations()])
    if (!mounted.current) return
    if (!current || current.user.id !== me.user.id) throw new Error('Session not confirmed')
    const found = organizations.find((organization) => organization.slug === submitted.slug)
    if (found?.id === current.organization.id && current.organization.personal) {
      addressConflict()
      return
    }
    if (found) {
      setCreated(found)
      setUncertain(null)
      setMessage('A team with this address is in your teams. Open it to continue.')
    } else if (submitted.addressTaken) {
      // A collision proves the address exists. Only a successful membership check can
      // release it; an empty list alone could still precede the original commit.
      addressConflict()
      return
    } else {
      setUncertain(null)
      setMessage('No team was found at this address. You can try creating it again.')
    }
    setAttempt((value) => value + 1)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current || uncertain || created) return
    const submitted = { name: draft.name.trim(), slug: retrySlug ?? draft.slug.trim() }
    const problems = validate(submitted)
    setErrors(problems)
    setFocusSlug(Boolean(problems.teamSlug))
    setMessage(null)
    setContextError(null)
    setAttempt((value) => value + 1)
    if (Object.keys(problems).length) return
    lock.current = true
    setBusy(true)
    setFocusSlug(false)
    try {
      const result = await createOrganization({
        ...submitted,
        keepCurrentActiveOrganization: true,
      })
      if (!mounted.current) return
      setCreated(result.organization)
      const membership = result.organization.members.find(
        (member: OrganizationMember) =>
          member.userId === me.user.id && member.organizationId === result.organization.id,
      )
      setCreatedMember(membership ?? null)
      // Creation and activation are separate: a failed switch can only retry opening.
      try {
        await openTeam(result.organization, membership ?? null, result.me)
      } catch (err) {
        if (mounted.current) report(err)
      }
    } catch (err) {
      if (!mounted.current) return
      if (
        err instanceof RequestError &&
        (err.code === 'ORGANIZATION_SLUG_RESERVED' ||
          (err.code === 'ORGANIZATION_ALREADY_EXISTS' && retrySlug === null))
      ) {
        setErrors({ teamSlug: errorMessage(err) })
        setFocusSlug(true)
        setAttempt((value) => value + 1)
      } else {
        // Even a successful no-match read can precede a delayed original commit. Reusing
        // this exact address lets server uniqueness protect the explicit retry too.
        setRetrySlug(submitted.slug)
        const pending = {
          ...submitted,
          addressTaken: err instanceof RequestError && err.code === 'ORGANIZATION_ALREADY_EXISTS',
        }
        setUncertain(pending)
        setMessage('Creation could not be confirmed. Checking your teams before retrying…')
        try {
          await reconcile(pending)
        } catch {
          if (mounted.current) {
            setMessage('Could not check your teams. Check team status before trying again.')
            setAttempt((value) => value + 1)
          }
        }
      }
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function recover() {
    if (lock.current || isOrganizationContextChanged(contextError)) return
    lock.current = true
    setBusy(true)
    setMessage(null)
    try {
      if (created) await openTeam(created)
      else if (uncertain) await reconcile(uncertain)
    } catch (err) {
      if (mounted.current)
        if (created) report(err)
        else {
          setMessage('Could not check your teams. Check team status before trying again.')
          setAttempt((value) => value + 1)
        }
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title={t('Create team')}
        lede={t('Choose a name and public address for your team.')}
      />
      <form className="panel stack" aria-label={t('Create team')} onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} labels={LABELS} message={message} attempt={attempt} />
        <OrganizationContextConflict error={contextError} />
        {created && (
          <dl className="details">
            <dt>{t('Team name')}</dt>
            <dd className="user-content">
              <BreakableText>{created.name}</BreakableText>
            </dd>
            {createdRole && (
              <>
                <dt>{t('Your role')}</dt>
                <dd className="user-content">
                  <BreakableText>
                    {createdRole === 'owner'
                      ? t('Owner')
                      : createdRole === 'admin'
                        ? t('Admin')
                        : createdRole === 'member'
                          ? t('Member')
                          : createdRole}
                  </BreakableText>
                </dd>
              </>
            )}
          </dl>
        )}
        <fieldset
          className="form-fieldset stack"
          disabled={busy || Boolean(uncertain || created)}
          role="presentation"
        >
          <Field
            id="teamName"
            label={t('Team name')}
            error={errors.teamName}
            hint={t('Use a name your teammates will recognize, up to 200 characters.')}
          >
            {(props) => (
              <input
                {...props}
                value={draft.name}
                autoComplete="organization"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            )}
          </Field>
          <Field
            id="teamSlug"
            label={t('Team public address')}
            error={errors.teamSlug}
            hint={
              <>
                {t(TEAM_LINK_SLUG_HINT)}{' '}
                {t('Team addresses preserve letter case and are separate from personal handles.')}
                {retrySlug && (
                  <>
                    {' '}
                    {t(
                      'This address is kept for a safe retry. Check the existing team before starting another creation.',
                    )}
                  </>
                )}
              </>
            }
          >
            {(props) => (
              <input
                {...props}
                ref={slugField}
                disabled={retrySlug !== null}
                className="mono"
                value={draft.slug}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
              />
            )}
          </Field>
        </fieldset>
        <div className="stack" aria-live="polite" aria-atomic="true">
          <p className="hint">{t('Team booking URL preview')}</p>
          <p className="mono preview user-content">
            <BreakableText>
              {publicTeamPageUrl(draft.slug.trim() || 'your-team', 'event-link')}
            </BreakableText>
          </p>
          <p className="hint">
            {t(
              'Each team event gets its own address at the end of this URL. Creating a team does not publish a booking page.',
            )}
          </p>
        </div>
        <div className="form-actions">
          {created || uncertain ? (
            <button
              type="button"
              className="button button-primary"
              disabled={busy || isOrganizationContextChanged(contextError)}
              onClick={recover}
            >
              {busy ? t('Working…') : created ? t('Open team') : t('Check team status')}
            </button>
          ) : (
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? t('Creating team…') : t('Create team')}
            </button>
          )}
          <Link to={PATHS.settings} className="button">
            {t('Cancel')}
          </Link>
          <p className="form-status" role="status">
            {busy ? t('Working…') : ui(draft.name || draft.slug ? 'Unsaved changes' : '')}
          </p>
        </div>
      </form>
    </>
  )
}
