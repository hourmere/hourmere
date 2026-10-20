import { interfaceLanguage } from '@hourmere/core/language'
import { type FormEvent, useRef, useState } from 'react'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { loadProfile, type Profile, updateDisplayName } from '../api/resources.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { ErrorSummary, Field, type FieldErrors } from '../components/forms.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { browserTimeZone, isKnownTimeZone } from '../format.ts'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { ACCOUNT, PROFILE } from '../limits.ts'
import { type Me, useMe, useSession } from '../session.tsx'
import { useUnsavedChanges } from '../unsaved-changes.tsx'

export function SettingsPage() {
  const { t, ui } = useI18n()

  usePageTitle('Settings')
  const me = useMe()
  const [profile, reload] = useLoad(loadProfile)

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
          <dd>
            {me.organization.name}
            {me.organization.personal && <span className="muted">{t(' (personal)')}</span>}
          </dd>
        </dl>
        <p className="hint">{t('Your email comes from how you sign in.')}</p>
      </section>
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
  if (!['en', 'zh-CN'].includes(draft.locale)) {
    errors.locale = 'Choose a supported booking language.'
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
      return { locale: 'Choose a supported booking language.' }
    default:
      return null
  }
}

const LABELS = { handle: 'Handle', timeZone: 'Time zone', locale: 'Booking language' }

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
              {t('. Lowercase letters, digits and hyphens, up to')} {PROFILE.handleMaxLength}.
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
          label={t('Booking language')}
          error={errors.locale}
          hint={t(
            'Default language for your booking pages and emails. Change the interface language separately in the top bar.',
          )}
        >
          {(props) => (
            <select {...props} value={draft.locale} onChange={(e) => set('locale', e.target.value)}>
              <option value="en" lang="en">
                English
              </option>
              <option value="zh-CN" lang="zh-CN">
                简体中文
              </option>
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
