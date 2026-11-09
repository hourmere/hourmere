import { type FormEvent, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { Field } from '../../components/forms.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { randomKey } from '../../public/api.ts'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'

/** Retain the same request identity and payload after an uncertain response. */
export function RequestReschedule({
  booking,
  expectedOrganizationId,
  onChange,
}: {
  booking: Schemas['Booking']
  expectedOrganizationId: string
  onChange: (booking: Schemas['Booking']) => void
}) {
  const { t, ui } = useI18n()
  const mounted = useMounted()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<UiText | null>(null)
  const [conflict, setConflict] = useState<unknown>(null)
  const inFlight = useRef(false)
  const attempt = useRef<{ idempotencyKey: string; note: string } | null>(null)
  const [retrying, setRetrying] = useState(false)
  useUnsavedChanges(open && note !== '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || conflict) return
    if (note.length > 2000) {
      setError('Use at most 2000 characters for your note.')
      return
    }
    attempt.current ??= { idempotencyKey: randomKey(), note }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const updated = await unwrap(
        api.POST('/api/v1/bookings/{id}/request-reschedule', {
          headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
          params: { path: { id: booking.id } },
          body: attempt.current,
        }),
      )
      if (!mounted.current) return
      onChange(updated)
      setOpen(false)
      setSent(true)
      setNote('')
      attempt.current = null
      setRetrying(false)
    } catch (err) {
      if (!mounted.current) return
      if (err instanceof RequestError && err.status < 500 && !isOrganizationContextChanged(err)) {
        attempt.current = null
        setRetrying(false)
        setError(
          err.code === 'invalid_notifications' || err.code === 'invalid_request'
            ? 'Use plain text with at most 2000 characters. Tabs and control characters are not allowed.'
            : errorMessage(err),
        )
        return
      }
      if (isOrganizationContextChanged(err)) setConflict(err)
      else setError(msg('Could not request a new time. {0}', { '0': errorMessage(err) }))
      // Keep the original body on retry: a lost response may already have committed.
      setRetrying(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="request-reschedule-heading">
      <h2 id="request-reschedule-heading">{t('Ask the invitee to choose a new time')}</h2>
      <p>
        {t(
          'The original time stays booked. The invitee can choose another time or cancel. If they do not respond within 48 hours or before the meeting starts, the original booking stays in place.',
        )}
      </p>
      {booking.pendingReschedule && (
        <p role="status">{t('Waiting for the invitee to choose a new time.')}</p>
      )}
      {sent && (
        <p role="status">
          {t(
            'The request is saved. The invitee will receive an email, subject to delivery limits.',
          )}
        </p>
      )}
      {!open ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            setOpen(true)
            setSent(false)
          }}
        >
          {t('Request reschedule')}
        </button>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p>{t('A new request replaces any previous request for this booking.')}</p>
          <Field
            id="reschedule-request-note"
            label={t('Note to the invitee')}
            optional
            hint={t('Plain text, up to 2000 characters. Included only in the email body.')}
          >
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={note}
                disabled={busy || retrying}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </Field>
          {error && (
            <p className="alert alert-error" role="alert">
              {ui(error)}
            </p>
          )}
          {conflict !== null && <OrganizationContextConflict error={conflict} />}
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={busy || !!conflict}>
              {busy ? t('Sending…') : retrying ? t('Retry the same request') : t('Send request')}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setNote('')
                setError(null)
                setConflict(null)
                attempt.current = null
                setRetrying(false)
              }}
            >
              {t('Close')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
