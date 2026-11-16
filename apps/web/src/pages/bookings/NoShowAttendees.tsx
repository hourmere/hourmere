import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
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

/** The server's answer to one mark or clear: the attendee's current marker. */
export interface NoShowChange {
  attendeeId: string
  noShowMarkedAt: string | null
  noShowMarkedBy: string | null
}

/** Returns true when the caller has handled the failure itself. */
type NoShowErrorHandler = (error: unknown) => boolean

/** Whether this host can mark or clear no-shows on the booking now. */
export function canEditNoShow(booking: NoShowBooking): boolean {
  return (
    booking.canManageNoShow === true &&
    !isReadOnlyBooking(booking) &&
    booking.status === 'confirmed' &&
    new Date(booking.start).getTime() < Date.now()
  )
}

/** The booking with one attendee's marker replaced; other attendees keep their objects. */
export function withNoShowChange<B extends { attendees: readonly Attendee[] }>(
  booking: B,
  change: NoShowChange,
): B {
  if (!booking.attendees.some((attendee) => attendee.id === change.attendeeId)) return booking
  return {
    ...booking,
    attendees: booking.attendees.map((attendee) =>
      attendee.id === change.attendeeId
        ? {
            ...attendee,
            noShowMarkedAt: change.noShowMarkedAt,
            noShowMarkedBy: change.noShowMarkedBy,
          }
        : attendee,
    ),
  } as B
}

// A row and its open detail panel can both write the same booking. Reserve the
// booking synchronously, then notify every mounted control before accepting another write.
const pendingBookings = new Set<string>()
const pendingListeners = new Set<() => void>()
function subscribePending(listener: () => void) {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}
function notifyPending() {
  for (const listener of pendingListeners) listener()
}

/** One booking's mark/clear request, shared by the detail panel and list rows. */
export function useNoShowToggle({
  bookingId,
  expectedOrganizationId,
  onChanged,
  onError,
}: {
  bookingId: string
  expectedOrganizationId: string
  onChanged: (change: NoShowChange) => void
  onError?: NoShowErrorHandler
}) {
  const mounted = useMounted()
  const pendingKey = `${expectedOrganizationId}:${bookingId}`
  const busy = useSyncExternalStore(subscribePending, () => pendingBookings.has(pendingKey))
  // The answer may arrive after later renders; it goes to the latest handlers.
  const handlers = useRef({ onChanged, onError })
  handlers.current = { onChanged, onError }
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState<unknown>(null)

  async function toggle(person: Attendee) {
    if (!person.id || pendingBookings.has(pendingKey) || conflict) return
    pendingBookings.add(pendingKey)
    notifyPending()
    setFailed(false)
    setSaved(false)
    try {
      const result = await unwrap(
        api.PATCH('/api/v1/bookings/{id}/attendees/{attendeeId}/no-show', {
          params: { path: { id: bookingId, attendeeId: person.id } },
          headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
          body: { noShow: !person.noShowMarkedAt },
        }),
      )
      // The mark is saved even if this control has gone; the page still shows it.
      handlers.current.onChanged(result)
      if (mounted.current) setSaved(true)
    } catch (error) {
      if (!mounted.current) return
      if (handlers.current.onError?.(error)) return
      if (isOrganizationContextChanged(error)) setConflict(error)
      else setFailed(true)
    } finally {
      pendingBookings.delete(pendingKey)
      notifyPending()
    }
  }

  return { busy, failed, saved, conflict, toggle }
}

function NoShowButton({
  person,
  disabled,
  onClick,
}: {
  person: Attendee
  disabled: boolean
  onClick: () => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="button button-small"
      disabled={disabled}
      onClick={onClick}
      aria-label={t(
        person.noShowMarkedAt ? 'Clear no-show for {name}' : 'Mark {name} as a no-show',
        { name: person.name || person.email },
      )}
    >
      {person.noShowMarkedAt ? t('Clear no-show') : t('Mark no-show')}
    </button>
  )
}

/** Host-only presentation: never use this component on invitee-facing pages. */
export function NoShowAttendees({
  booking,
  expectedOrganizationId,
  disabled = false,
  onChanged,
  onError,
}: {
  booking: NoShowBooking
  expectedOrganizationId: string
  disabled?: boolean
  onChanged?: (change: NoShowChange) => void
  onError?: NoShowErrorHandler
}) {
  const { t } = useI18n()
  const heading = useId()
  const [attendees, setAttendees] = useState(booking.attendees)
  const { busy, failed, saved, conflict, toggle } = useNoShowToggle({
    bookingId: booking.id,
    expectedOrganizationId,
    onChanged: (change) => {
      setAttendees((current) => withNoShowChange({ attendees: current }, change).attendees)
      onChanged?.(change)
    },
    onError,
  })
  useEffect(() => setAttendees(booking.attendees), [booking.attendees])
  const canEdit = canEditNoShow(booking)
  if (!canEdit && !attendees.some((person) => person.noShowMarkedAt)) return null

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
              <NoShowButton
                person={person}
                disabled={busy || !!conflict || disabled}
                onClick={() => {
                  if (!disabled) void toggle(person)
                }}
              />
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

/**
 * The same controls, compact, for one row of a host or team bookings list. Host-only: the
 * list announces saved changes in its own status region.
 */
export function NoShowRowControls({
  booking,
  expectedOrganizationId,
  disabled = false,
  onChanged,
  onError,
}: {
  booking: NoShowBooking
  expectedOrganizationId: string
  disabled?: boolean
  onChanged: (change: NoShowChange) => void
  onError?: NoShowErrorHandler
}) {
  const { t } = useI18n()
  const { busy, failed, conflict, toggle } = useNoShowToggle({
    bookingId: booking.id,
    expectedOrganizationId,
    onChanged,
    onError,
  })
  const canEdit = canEditNoShow(booking)
  const lines = booking.attendees.filter(
    (person) => person.noShowMarkedAt || (canEdit && person.id),
  )
  if (lines.length === 0) return null
  const named = booking.attendees.length > 1

  return (
    <div className="no-show-row">
      <ul className="plain-list no-show-row-list" aria-label={t('No-shows')}>
        {lines.map((person) => (
          <li key={person.id ?? person.email}>
            {named && (
              <>
                <BreakableText>{person.name || person.email}</BreakableText>{' '}
              </>
            )}
            {person.noShowMarkedAt && (
              <>
                <span className="badge">{t('No-show')}</span>{' '}
              </>
            )}
            {canEdit && person.id && (
              <NoShowButton
                person={person}
                disabled={busy || !!conflict || disabled}
                onClick={() => {
                  if (!disabled) void toggle(person)
                }}
              />
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
    </div>
  )
}
