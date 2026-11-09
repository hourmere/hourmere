import { useEffect, useId, useState } from 'react'
import { isReadOnlyBooking } from '../../api/booking-policy.ts'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'

interface Attendee {
  id?: string
  name: string
  email: string
  noShowMarkedAt?: string | null
  noShowMarkedBy?: string | null
}
interface NoShowBooking {
  id: string
  start: string
  status: string
  source?: string
  managementPolicy?: string
  canManageNoShow?: boolean
  attendees: Attendee[]
}

/** Host-only presentation: never use this component on invitee-facing pages. */
export function NoShowAttendees({
  booking,
  expectedOrganizationId,
  disabled = false,
}: {
  booking: NoShowBooking
  expectedOrganizationId: string
  disabled?: boolean
}) {
  const { t } = useI18n()
  const heading = useId()
  const mounted = useMounted()
  const [attendees, setAttendees] = useState(booking.attendees)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState<unknown>(null)
  useEffect(() => setAttendees(booking.attendees), [booking.attendees])
  const canEdit =
    booking.canManageNoShow === true &&
    !isReadOnlyBooking(booking) &&
    booking.status === 'confirmed' &&
    new Date(booking.start).getTime() < Date.now()
  if (!canEdit && !attendees.some((person) => person.noShowMarkedAt)) return null

  async function change(person: Attendee) {
    if (!canEdit || !person.id || busy || conflict || disabled) return
    setBusy(true)
    setFailed(false)
    setSaved(false)
    try {
      const result = await unwrap(
        api.PATCH('/api/v1/bookings/{id}/attendees/{attendeeId}/no-show', {
          params: { path: { id: booking.id, attendeeId: person.id } },
          headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
          body: { noShow: !person.noShowMarkedAt },
        }),
      )
      if (!mounted.current) return
      setAttendees((current) =>
        current.map((attendee) =>
          attendee.id === result.attendeeId ? { ...attendee, ...result } : attendee,
        ),
      )
      setSaved(true)
    } catch (error) {
      if (!mounted.current) return
      if (isOrganizationContextChanged(error)) setConflict(error)
      else setFailed(true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className="panel" aria-labelledby={heading}>
      <h2 id={heading}>{t('No-shows')}</h2>
      <p className="hint">
        {t(
          'Only hosts and team administrators can see these marks. No email is sent, and scheduled follow-ups stay unchanged.',
        )}
      </p>
      <ul className="plain-list stack">
        {attendees.map((person) => (
          <li key={person.id ?? person.email}>
            <BreakableText>{person.name || person.email}</BreakableText>{' '}
            {person.noShowMarkedAt && <span className="badge">{t('No-show')}</span>}{' '}
            {canEdit && person.id && (
              <button
                type="button"
                className="button button-small"
                disabled={busy || !!conflict || disabled}
                onClick={() => void change(person)}
                aria-label={t(
                  person.noShowMarkedAt ? 'Clear no-show for {name}' : 'Mark {name} as a no-show',
                  { name: person.name || person.email },
                )}
              >
                {person.noShowMarkedAt ? t('Clear no-show') : t('Mark no-show')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {failed && (
        <p className="alert alert-error" role="alert">
          {t('Could not update the no-show mark. Refresh the booking and try again.')}
        </p>
      )}
      <OrganizationContextConflict error={conflict} />
      <p role="status">{saved ? t('No-show mark updated.') : ''}</p>
    </section>
  )
}
