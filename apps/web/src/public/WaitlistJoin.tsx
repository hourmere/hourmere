import { useId, useRef, useState } from 'react'
import { ErrorSummary, Field, FieldError, type FieldErrors } from '../components/forms.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { codeOf, failureMessage, joinWaitlist, resendWaitlistVerification } from './api.ts'
import { now } from './env.ts'
import { FocusHeading } from './PublicLayout.tsx'
import { formatDate, formatTime } from './time.ts'
import { emailError, nameError } from './validation.ts'
import type { WaitlistWindow } from './waitlist-window.ts'

const UNAVAILABLE =
  'The waitlist is unavailable for this period. Check available times and try again.'

/** One explicit, fixed preference window. Never records contact details in browser storage. */
export function WaitlistJoin({
  handle,
  slug,
  team,
  window: preferredWindow,
  locale,
  onRefresh,
}: {
  handle: string
  slug: string
  team: boolean
  window: WaitlistWindow
  locale: string
  onRefresh?: (() => void) | undefined
}) {
  const { t, locale: emailLocale } = useI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [accepted, setAccepted] = useState(false)
  const [resent, setResent] = useState(false)
  const consentError = errors[`${id}-consent`]
  const start = Date.parse(preferredWindow.start)
  const end = Date.parse(preferredWindow.end)
  const expires = Math.min(now() + 30 * 86_400_000, end)
  const when = (at: number) =>
    t('{date}, {time}', {
      date: formatDate(at, preferredWindow.timeZone, locale),
      time: formatTime(at, preferredWindow.timeZone, locale),
    })

  async function submit(resend = false) {
    if (inFlight.current) return
    setAttempt((v) => v + 1)
    setError(null)
    const found: FieldErrors = {}
    const emailProblem = emailError(email)
    if (emailProblem) found[`${id}-email`] = emailProblem
    if (!resend) {
      const nameProblem = name.trim() ? nameError(name) : null
      if (nameProblem) found[`${id}-name`] = nameProblem
      if (!consent) found[`${id}-consent`] = 'Agree to receive waitlist emails before joining.'
    }
    setErrors(found)
    if (Object.keys(found).length) return
    if (!resend && start < now()) {
      setError(UNAVAILABLE)
      return
    }
    inFlight.current = true
    setBusy(true)
    try {
      if (resend) {
        await resendWaitlistVerification(handle, slug, email.trim(), team)
        setResent(true)
      } else {
        await joinWaitlist(
          handle,
          slug,
          {
            email: email.trim(),
            ...(name.trim() && { name: name.trim() }),
            preferredWindow,
            locale: emailLocale,
            consent: true,
          },
          team,
        )
        setAccepted(true)
      }
    } catch (err) {
      // Never reflect service prose or any mailbox/entry-specific state.
      setError(
        codeOf(err) === 'availability_changed' ||
          codeOf(err)?.startsWith('waitlist_') ||
          codeOf(err)?.startsWith('invalid_waitlist_')
          ? UNAVAILABLE
          : failureMessage(err),
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (accepted)
    return (
      <section className="stack" aria-labelledby={`${id}-accepted`}>
        <FocusHeading level={3} id={`${id}-accepted`}>
          {t('Check your email to confirm')}
        </FocusHeading>
        <p role="status">
          {t(
            'If your request can be accepted, we will send a confirmation link. Limits may prevent delivery. Repeated joins do not resend email.',
          )}
        </p>
        <ErrorSummary errors={{}} message={error} attempt={attempt} />
        {resent && (
          <p role="status">
            {t('Confirmation requested. Check your email; delivery is subject to limits.')}
          </p>
        )}
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          {busy ? t('Sending…') : t('Resend confirmation email')}
        </button>
      </section>
    )
  return (
    <section className="stack" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{t('No available times in this period.')}</h3>
      <p>
        {t(
          'If a time opens, everyone eligible may be notified. Nothing is reserved; the first successful booking wins.',
        )}
      </p>
      {!open ? (
        <button type="button" className="button" onClick={() => setOpen(true)}>
          {t('Join the waitlist')}
        </button>
      ) : (
        <form
          className="stack booking-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <FocusHeading level={3}>{t('Join the waitlist')}</FocusHeading>
          <p id={`${id}-period`}>
            {t('From {start} to {end} ({timeZone})', {
              start: when(start),
              end: when(end),
              timeZone: preferredWindow.timeZone,
            })}
          </p>
          <p>
            {t('Wait until {date}. Unconfirmed requests expire after 24 hours.', {
              date: when(expires),
            })}
          </p>
          <ErrorSummary errors={errors} message={error} attempt={attempt} />
          {error === UNAVAILABLE && onRefresh && (
            <button type="button" className="button button-small" onClick={onRefresh}>
              {t('Try again')}
            </button>
          )}
          <Field id={`${id}-email`} label={t('Email')} error={errors[`${id}-email`]}>
            {(props) => (
              <input
                {...props}
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field id={`${id}-name`} label={t('Your name')} optional error={errors[`${id}-name`]}>
            {(props) => (
              <input
                {...props}
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <div className="field">
            <label className="choice" htmlFor={`${id}-consent`}>
              <input
                id={`${id}-consent`}
                type="checkbox"
                required
                aria-invalid={consentError ? true : undefined}
                aria-describedby={[consentError && `${id}-consent-error`, `${id}-period`]
                  .filter(Boolean)
                  .join(' ')}
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                {t(
                  'I agree to receive waitlist emails for this period. I can leave using the link in any waitlist email.',
                )}
              </span>
            </label>
            {consentError && <FieldError id={`${id}-consent-error`}>{consentError}</FieldError>}
          </div>
          <p className="hint">
            {t(
              'Leaving clears your contact details. Coded records remain for abuse prevention for 2 days and to prevent repeat notifications for up to 64 days.',
            )}
          </p>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? t('Joining…') : t('Join the waitlist')}
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            {t('Cancel')}
          </button>
        </form>
      )}
    </section>
  )
}
