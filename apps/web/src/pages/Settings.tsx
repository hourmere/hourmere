import { explicitLanguage, interfaceLanguage, registeredLocales } from '@hourmere/core/language'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { getActiveOrganizationMember, type OrganizationMember } from '../api/auth.ts'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { loadProfile, type Profile, updateDisplayName } from '../api/resources.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { ErrorSummary, Field, type FieldErrors } from '../components/forms.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { browserTimeZone, isKnownTimeZone } from '../format.ts'
import { type Loaded, useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { ACCOUNT, PROFILE } from '../limits.ts'
import { PATHS } from '../paths.ts'
import { type Me, useMe, useSession } from '../session.tsx'
import { useUnsavedChanges } from '../unsaved-changes.tsx'
import { TeamMembers } from './TeamMembers.tsx'

export function SettingsPage() {
  const { t, ui } = useI18n()

  usePageTitle('Settings')
  const me = useMe()
  const location = useLocation()
  const navigate = useNavigate()
  // Keep the creation response through a failed read in this view. Consume history state
  // afterwards so reloading cannot replay an old membership as current confirmation.
  const [createdMember] = useState(() => {
    const member = (location.state as { createdMember?: OrganizationMember } | null)?.createdMember
    return member &&
      member.organizationId === me.organization.id &&
      member.userId === me.user.id &&
      typeof member.role === 'string' &&
      member.role.trim()
      ? member
      : null
  })
  useEffect(() => {
    if (
      location.state &&
      typeof location.state === 'object' &&
      Object.hasOwn(location.state, 'createdMember')
    ) {
      const state = { ...location.state }
      delete state.createdMember
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: Object.keys(state).length ? state : null },
      )
    }
  }, [location, navigate])
  const [profile, reload] = useLoad(loadProfile)
  const organizationId = me.organization.id
  const userId = me.user.id
  const personal = me.organization.personal
  const loadRole = useCallback(
    async (signal: AbortSignal) => {
      if (personal) return null
      const member = await getActiveOrganizationMember(signal)
      if (member.organizationId !== organizationId || member.userId !== userId || !member.role) {
        throw new Error('Membership does not match the displayed account and organization')
      }
      return member.role
    },
    [organizationId, userId, personal],
  )
  const [role, reloadRole] = useLoad(loadRole)

  return (
    <>
      <PageHeader title={t('Settings')} lede={t('Manage your profile and booking defaults.')} />
      <section className="panel" aria-labelledby="profile-heading">
        <h2 id="profile-heading">{t('Profile')}</h2>
        {profile.status === 'loading' && <PageSkeleton label="Loading your profile…" />}
        {profile.status === 'error' && (
          <div className="alert alert-error" role="alert">
            <p>
              {t('Could not load your profile.')} {ui(profile.message)}
            </p>
            <button type="button" className="button button-small" onClick={reload}>
              {t('Try again')}
            </button>
          </div>
        )}
        {profile.status === 'ready' && <ProfileForm profile={profile.data} me={me} />}
      </section>

      <section className="panel" aria-labelledby="account-heading">
        <h2 id="account-heading">{t('Account')}</h2>
        <DisplayNameForm name={me.user.name} />
        <dl className="details">
          <dt>{t('Email')}</dt>
          <dd className="user-content">
            <BreakableText>{me.user.email}</BreakableText>
          </dd>
          <dt>{t('Organization')}</dt>
          <dd className="user-content">
            <BreakableText>{me.organization.name}</BreakableText>
            {me.organization.personal && <span className="muted">{t(' (personal)')}</span>}
          </dd>
          {!personal && <TeamRole role={role} reload={reloadRole} createdMember={createdMember} />}
        </dl>
        <p>
          <Link className="button" to={PATHS.newTeam}>
            {t('Create team')}
          </Link>
        </p>
        <p className="hint">{t('Your email comes from how you sign in.')}</p>
      </section>
      {!personal && (
        <TeamMembers
          key={organizationId}
          organizationId={organizationId}
          role={role.status === 'ready' ? role.data : null}
        />
      )}
    </>
  )
}

function TeamRole({
  role,
  reload,
  createdMember,
}: {
  role: Loaded<string | null>
  reload: () => void
  createdMember: OrganizationMember | null
}) {
  const { t } = useI18n()
  const displayedRole = role.status === 'ready' ? role.data : createdMember?.role
  const labels: Record<string, string> = {
    owner: t('Owner'),
    admin: t('Admin'),
    member: t('Member'),
  }

  return (
    <>
      <dt>{t('Your role')}</dt>
      <dd className="user-content">
        {displayedRole && (
          <BreakableText>
            {displayedRole
              .split(',')
              .map((value) => {
                const name = value.trim()
                return Object.hasOwn(labels, name) ? labels[name] : name
              })
              .join(', ')}
          </BreakableText>
        )}
        {displayedRole && role.status !== 'ready' && (
          <p className="hint">{t('Last confirmed role')}</p>
        )}
        {role.status === 'loading' && <span role="status">{t('Loading your team role…')}</span>}
        {role.status === 'error' && (
          <div>
            <p role="alert">{t('Could not load your team role.')}</p>
            <button type="button" className="button button-small" onClick={reload}>
              {t('Try again')}
            </button>
          </div>
        )}
      </dd>
    </>
  )
}

function DisplayNameForm({ name }: { name: string }) {
  const { t, ui } = useI18n()

  const { refresh } = useSession()
  const [baseline, setBaseline] = useState(name)
  const [draft, setDraft] = useState(name)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<UiText>('')
  const statusRef = useRef<HTMLParagraphElement>(null)
  const mounted = useMounted()
  const dirty = draft !== baseline
  useUnsavedChanges(dirty)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setAttempt((n) => n + 1)
    setMessage(null)
    setStatus('')
    const next = draft.trim()
    const invalid =
      !next ||
      next.length > ACCOUNT.nameMaxLength ||
      !next.isWellFormed() ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(next)
    const nameError = msg('Enter a name on one line, up to {0} characters.', {
      '0': ACCOUNT.nameMaxLength,
    })
    setErrors(invalid ? { displayName: nameError } : {})
    if (invalid) return
    setSaving(true)
    setStatus('Saving…')
    statusRef.current?.focus()
    try {
      await updateDisplayName(next)
      // Refreshes session data without unmounting another unsaved settings form.
      await refresh()
      if (!mounted.current) return
      setBaseline(next)
      setDraft(next)
      setStatus('Display name saved.')
      statusRef.current?.focus()
    } catch (err) {
      if (!mounted.current) return
      setStatus('')
      if (err instanceof RequestError && err.code === 'invalid_display_name') {
        setErrors({ displayName: nameError })
      } else setMessage(msg('Could not save your display name. {0}', { '0': errorMessage(err) }))
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={t('Edit display name')}>
      <ErrorSummary
        errors={errors}
        labels={{ displayName: 'Display name' }}
        message={message}
        attempt={attempt}
      />
      <fieldset className="form-fieldset" disabled={saving} role="presentation">
        <Field
          id="displayName"
          label={t('Display name')}
          error={errors.displayName}
          hint={t('Shown on booking pages, in emails and in calendar invitations.')}
        >
          {(props) => (
            <input
              {...props}
              value={draft}
              autoComplete="name"
              maxLength={ACCOUNT.nameMaxLength}
              onChange={(e) => {
                setDraft(e.target.value)
                setStatus('')
              }}
            />
          )}
        </Field>
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? t('Saving…') : t('Save display name')}
        </button>
        <p className="form-status" role="status" tabIndex={-1} ref={statusRef}>
          {ui(status || (dirty ? 'Unsaved changes' : ''))}
        </p>
      </div>
    </form>
  )
}

interface ProfileDraft {
  handle: string
  timeZone: string
  locale: string
}

/** A handle suggestion from the email address: "Ada.Lovelace@…" → "ada-lovelace". */
export function suggestHandle(email: string): string {
  return (email.split('@')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROFILE.handleMaxLength)
    .replace(/-+$/g, '')
}

function validateProfile(draft: ProfileDraft): FieldErrors {
  const errors: FieldErrors = {}
  const handle = draft.handle.trim()
  if (!handle) errors.handle = 'Enter a handle.'
  else if (handle.length > PROFILE.handleMaxLength) {
    errors.handle = msg('Use at most {0} characters.', { '0': PROFILE.handleMaxLength })
  } else if (!PROFILE.handlePattern.test(handle)) {
    errors.handle =
      'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.'
  }
  if (!draft.timeZone.trim()) errors.timeZone = 'Choose a time zone.'
  else if (!isKnownTimeZone(draft.timeZone.trim())) {
    errors.timeZone = 'Choose a time zone from the list, e.g. Europe/Berlin.'
  }
  if (!explicitLanguage(draft.locale)) {
    errors.locale = 'Choose a supported notification language.'
  }
  return errors
}

/** The server's refusal as field messages (codes documented on PUT /api/v1/profile). */
function profileServerErrors(err: unknown): FieldErrors | null {
  if (!(err instanceof RequestError)) return null
  switch (err.code) {
    case 'invalid_handle':
      return {
        handle:
          'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
      }
    case 'handle_reserved':
      return { handle: 'This handle is reserved. Choose another one.' }
    case 'handle_taken':
      return { handle: 'This handle is already taken. Choose another one.' }
    case 'invalid_time_zone':
      return { timeZone: 'This is not a time zone the server knows. Choose one from the list.' }
    case 'invalid_locale':
      return { locale: 'Choose a supported notification language.' }
    default:
      return null
  }
}

const LABELS = { handle: 'Handle', timeZone: 'Time zone', locale: 'Notification language' }

function ProfileForm({ profile, me }: { profile: Profile | null; me: Me }) {
  const { t, ui, locale } = useI18n()

  const [saved, setSaved] = useState(profile)
  const [baseline, setBaseline] = useState<ProfileDraft>(() =>
    profile
      ? {
          handle: profile.handle,
          timeZone: profile.timeZone,
          locale: interfaceLanguage(profile.locale) ?? 'en',
        }
      : {
          handle: suggestHandle(me.user.email),
          timeZone: browserTimeZone(),
          locale,
        },
  )
  const [draft, setDraft] = useState(baseline)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<UiText>('')
  const statusRef = useRef<HTMLParagraphElement>(null)
  const mounted = useMounted()

  // Before the first save the baseline is the suggestion: changing it is unsaved work too.
  const dirty =
    draft.handle !== baseline.handle ||
    draft.timeZone !== baseline.timeZone ||
    draft.locale !== baseline.locale
  useUnsavedChanges(dirty)

  const set = (name: keyof ProfileDraft, value: string) => {
    setDraft((d) => ({ ...d, [name]: value }))
    setStatus('')
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setAttempt((n) => n + 1)
    setFormError(null)
    setStatus('')
    const problems = validateProfile(draft)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    // Locked until the answer comes, so it cannot overwrite later edits (see EventTypeForm).
    setStatus('Saving…')
    statusRef.current?.focus()
    setSaving(true)
    try {
      const result = await unwrap(
        api.PUT('/api/v1/profile', {
          body: {
            handle: draft.handle.trim(),
            timeZone: draft.timeZone.trim(),
            locale: draft.locale,
          },
        }),
      )
      if (!mounted.current) return
      const next = {
        handle: result.handle,
        timeZone: result.timeZone,
        locale: interfaceLanguage(result.locale) ?? 'en',
      }
      setStatus(saved ? 'Saved.' : 'Profile created. Your booking links are ready.')
      setSaved(result)
      setBaseline(next)
      setDraft(next)
      statusRef.current?.focus()
    } catch (err) {
      if (!mounted.current) return
      setStatus('')
      const fields = profileServerErrors(err)
      setErrors(fields ?? {})
      setFormError(
        fields ? null : msg('Could not save your profile. {0}', { '0': errorMessage(err) }),
      )
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  const handle = draft.handle.trim()
  const changingHandle = saved !== null && handle !== saved.handle

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {!saved && (
        <p className="alert alert-info">
          {t('Choose a handle to get booking links. Check the suggestions below and save.')}
        </p>
      )}
      <ErrorSummary errors={errors} labels={LABELS} message={formError} attempt={attempt} />
      <fieldset className="form-fieldset stack" disabled={saving} role="presentation">
        <Field
          id="handle"
          label={t('Handle')}
          error={errors.handle}
          hint={
            <>
              {t('Your booking links start with')}{' '}
              <span className="mono preview">
                <BreakableText>{`/${handle || t('your-handle')}/`}</BreakableText>
              </span>
              {t('. Lowercase letters, digits and hyphens, up to')} {PROFILE.handleMaxLength}
              {t('.')}
              {changingHandle && (
                <strong className="warning">
                  {' '}
                  {t('Links you have already shared will stop working.')}
                </strong>
              )}
            </>
          }
        >
          {(props) => (
            <input
              {...props}
              className="mono"
              value={draft.handle}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => set('handle', e.target.value)}
            />
          )}
        </Field>
        <Field
          id="timeZone"
          label={t('Time zone')}
          error={errors.timeZone}
          hint={t('Bookings are shown in this zone. Type to search, e.g. “Berlin”.')}
        >
          {(props) => (
            <TimeZonePicker
              value={draft.timeZone}
              onChange={(v) => set('timeZone', v)}
              control={props}
            />
          )}
        </Field>
        <Field
          id="locale"
          label={t('Notification language')}
          error={errors.locale}
          hint={t(
            'Language of your own notification emails and calendar invitations. Booking pages and invitee emails use the visitor’s language. Change the interface language separately in the top bar.',
          )}
        >
          {(props) => (
            <select {...props} value={draft.locale} onChange={(e) => set('locale', e.target.value)}>
              {registeredLocales.map(({ code, nativeName }) => (
                <option key={code} value={code} lang={code}>
                  {nativeName}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? t('Saving…') : saved ? t('Save profile') : t('Create profile')}
        </button>
        <p className="form-status" role="status" tabIndex={-1} ref={statusRef}>
          {ui(status || (dirty ? 'Unsaved changes' : ''))}
        </p>
      </div>
    </form>
  )
}
