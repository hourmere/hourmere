import { type FormEvent, useRef, useState } from 'react'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { loadProfile, type Profile } from '../api/resources.ts'
import { ErrorSummary, Field, type FieldErrors } from '../components/forms.tsx'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { browserLocale, browserTimeZone, isKnownTimeZone } from '../format.ts'
import { useLoad, usePageTitle } from '../hooks.ts'
import { PROFILE } from '../limits.ts'
import { type Me, useMe } from '../session.tsx'
import { useUnsavedChanges } from '../unsaved-changes.tsx'

export function SettingsPage() {
  usePageTitle('Settings')
  const me = useMe()
  const [profile, reload] = useLoad(loadProfile)

  return (
    <>
      <h1>Settings</h1>
      <section className="panel" aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        {profile.status === 'loading' && <p role="status">Loading your profile…</p>}
        {profile.status === 'error' && (
          <div className="alert alert-error" role="alert">
            <p>Could not load your profile. {profile.message}</p>
            <button type="button" className="button button-small" onClick={reload}>
              Try again
            </button>
          </div>
        )}
        {profile.status === 'ready' && <ProfileForm profile={profile.data} me={me} />}
      </section>

      <section className="panel" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <dl className="details">
          <dt>Name</dt>
          <dd>{me.user.name || <span className="muted">Not set</span>}</dd>
          <dt>Email</dt>
          <dd>{me.user.email}</dd>
          <dt>Organization</dt>
          <dd>
            {me.organization.name}
            {me.organization.personal && <span className="muted"> (personal)</span>}
          </dd>
        </dl>
        <p className="hint">Your name and email come from how you sign in.</p>
      </section>
    </>
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

function canonicalLocale(value: string): string | null {
  if (!value.trim() || value.length > PROFILE.localeMaxLength) return null
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null
  } catch {
    return null
  }
}

/** "English (United Kingdom)" for "en-GB", in the browser's language. */
function localeName(locale: string): string | null {
  const canonical = canonicalLocale(locale)
  if (!canonical) return null
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(canonical) ?? null
  } catch {
    return null
  }
}

function validateProfile(draft: ProfileDraft): FieldErrors {
  const errors: FieldErrors = {}
  const handle = draft.handle.trim()
  if (!handle) errors.handle = 'Enter a handle.'
  else if (handle.length > PROFILE.handleMaxLength) {
    errors.handle = `Use at most ${PROFILE.handleMaxLength} characters.`
  } else if (!PROFILE.handlePattern.test(handle)) {
    errors.handle =
      'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.'
  }
  if (!draft.timeZone.trim()) errors.timeZone = 'Choose a time zone.'
  else if (!isKnownTimeZone(draft.timeZone.trim())) {
    errors.timeZone = 'Choose a time zone from the list, e.g. Europe/Berlin.'
  }
  if (!canonicalLocale(draft.locale)) {
    errors.locale = 'Enter a language tag such as en, en-GB or pt-BR.'
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
      return { locale: 'Enter a language tag such as en, en-GB or pt-BR.' }
    default:
      return null
  }
}

const LABELS = { handle: 'Handle', timeZone: 'Time zone', locale: 'Language' }

function ProfileForm({ profile, me }: { profile: Profile | null; me: Me }) {
  const [saved, setSaved] = useState(profile)
  const [baseline, setBaseline] = useState<ProfileDraft>(() =>
    profile
      ? { handle: profile.handle, timeZone: profile.timeZone, locale: profile.locale }
      : {
          handle: suggestHandle(me.user.email),
          timeZone: browserTimeZone(),
          locale: browserLocale(),
        },
  )
  const [draft, setDraft] = useState(baseline)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const statusRef = useRef<HTMLParagraphElement>(null)

  // A new profile is unsaved even with the suggested values: nothing exists yet.
  const dirty =
    saved !== null &&
    (draft.handle !== baseline.handle ||
      draft.timeZone !== baseline.timeZone ||
      draft.locale !== baseline.locale)
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
    setSaving(true)
    try {
      const result = await unwrap(
        api.PUT('/api/v1/profile', {
          body: {
            handle: draft.handle.trim(),
            timeZone: draft.timeZone.trim(),
            locale: canonicalLocale(draft.locale) ?? draft.locale.trim(),
          },
        }),
      )
      const next = { handle: result.handle, timeZone: result.timeZone, locale: result.locale }
      setStatus(saved ? 'Saved.' : 'Profile created. Your booking links are ready.')
      setSaved(result)
      setBaseline(next)
      setDraft(next)
      statusRef.current?.focus()
    } catch (err) {
      const fields = profileServerErrors(err)
      setErrors(fields ?? {})
      setFormError(fields ? null : `Could not save your profile. ${errorMessage(err)}`)
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  const origin = window.location.origin
  const handle = draft.handle.trim()
  const changingHandle = saved !== null && handle !== saved.handle
  const language = localeName(draft.locale)

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {!saved && (
        <p className="alert alert-info">
          Choose a handle to get booking links. Check the suggestions below and save.
        </p>
      )}
      <ErrorSummary errors={errors} labels={LABELS} message={formError} attempt={attempt} />
      <Field
        id="handle"
        label="Handle"
        error={errors.handle}
        hint={
          <>
            Your booking links start with{' '}
            <span className="mono preview">
              {origin}/{handle || 'your-handle'}/
            </span>
            . Lowercase letters, digits and hyphens, up to {PROFILE.handleMaxLength}.
            {changingHandle && (
              <strong className="warning"> Links you have already shared will stop working.</strong>
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
        label="Time zone"
        error={errors.timeZone}
        hint="Bookings are shown in this zone. Type to search, e.g. “Berlin”."
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
        label="Language"
        error={errors.locale}
        hint={
          <>
            A language tag such as en, en-GB or pt-BR
            {language && !errors.locale ? <>: {language}</> : ''}.
          </>
        }
      >
        {(props) => (
          <input
            {...props}
            value={draft.locale}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => set('locale', e.target.value)}
          />
        )}
      </Field>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? 'Saving…' : saved ? 'Save profile' : 'Create profile'}
        </button>
        <p className="form-status" role="status" tabIndex={-1} ref={statusRef}>
          {status || (dirty ? 'Unsaved changes' : '')}
        </p>
      </div>
    </form>
  )
}
