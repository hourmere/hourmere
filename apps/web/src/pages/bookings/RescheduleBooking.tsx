import { useCallback, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, RequestError } from '../../api/errors.ts'
import { flash } from '../../flash.ts'
import { zoned } from '../../format.ts'
import { useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { RULES } from '../../limits.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import type { Slot, SlotLoader } from '../../public/api.ts'
import { SlotPicker } from '../../public/SlotPicker.tsx'

/** Hosts use their session, never the invitee's management capability. */
export function RescheduleBooking({
  booking,
  timeZone: initialTimeZone,
}: {
  booking: Schemas['Booking']
  timeZone: string
}) {
  const { t, ui, locale, formatLocale } = useI18n()
  const navigate = useNavigate()
  const mounted = useMounted()
  const [open, setOpen] = useState(false)
  const [timeZone, setTimeZone] = useState(initialTimeZone)
  const [now] = useState(Date.now)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [error, setError] = useState<UiText | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const format = zoned(timeZone, locale === 'zh-CN' ? locale : formatLocale)
  const loadSlots: SlotLoader = useCallback(
    async (start, end, signal) => {
      const result = await unwrap(
        api.GET('/api/v1/bookings/{id}/slots', {
          params: { path: { id: booking.id }, query: { start, end } },
          signal,
        }),
      )
      return result.data
    },
    [booking.id],
  )

  async function move() {
    // Rescheduling is not idempotent. Only a deliberate confirmation may send one request.
    if (!slot || inFlight.current || blocked) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await unwrap(
        api.POST('/api/v1/bookings/{id}/reschedule', {
          params: { path: { id: booking.id } },
          body: { start: slot.start },
        }),
      )
      if (!mounted.current) return
      navigate(bookingPath(result.booking.id), {
        state: flash(msg('The booking is moved to the new time.')),
      })
    } catch (err) {
      if (!mounted.current) return
      if (
        err instanceof RequestError &&
        ['slot_taken', 'slot_unavailable'].includes(err.code ?? '')
      ) {
        setSlot(null)
        setError(errorMessage(err))
      } else if (!(err instanceof RequestError) || err.status >= 500) {
        // The server may have committed before its answer was lost. Never offer a replay.
        setBlocked(true)
        setError(
          'The response was lost. The booking may have moved. Check your bookings before trying again.',
        )
      } else {
        setError(errorMessage(err))
        if (
          [
            'booking_cancelled',
            'booking_in_past',
            'booking_not_found',
            'event_type_unavailable',
            'booking_hosts_unavailable',
          ].includes(err.code ?? '')
        ) {
          setBlocked(true)
        }
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="reschedule-heading">
      <h2 id="reschedule-heading">{t('Reschedule this booking')}</h2>
      {!open ? (
        <>
          <p>{t('Choose a new time. The invitee and hosts will be notified.')}</p>
          <button
            type="button"
            className="button"
            ref={openButton}
            onClick={() => setOpen(true)}
            aria-expanded={false}
          >
            {t('Reschedule')}
          </button>
        </>
      ) : (
        <div className="stack">
          {error && (
            <p className="alert alert-error" role="alert">
              {ui(error)}
            </p>
          )}
          {blocked ? (
            <p>
              <Link to={PATHS.bookings}>{t('Back to bookings')}</Link>
            </p>
          ) : slot ? (
            <>
              <dl className="details">
                <dt>{t('From')}</dt>
                <dd>{format.dateTimeRange(booking.start, booking.end)}</dd>
                <dt>{t('To')}</dt>
                <dd>{format.dateTimeRange(slot.start, slot.end)}</dd>
                <dt>{t('Time zone')}</dt>
                <dd>{timeZone.replaceAll('_', ' ')}</dd>
              </dl>
              <div className="form-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={move}
                >
                  {busy ? t('Moving…') : t('Confirm new time')}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setSlot(null)}
                >
                  {t('Pick another time')}
                </button>
              </div>
            </>
          ) : (
            <SlotPicker
              load={loadSlots}
              // Event rules can change after booking. Use the legal maximum so a longer
              // current duration cannot fall outside a month request or a split overlap.
              durationMinutes={RULES.durationMinutes.max}
              timeZone={timeZone}
              onTimeZoneChange={setTimeZone}
              locale={formatLocale ?? locale}
              now={now}
              excludeStart={booking.start}
              selected={null}
              onSelect={(value) => {
                setError(null)
                setSlot(value)
              }}
              version={0}
              title="Pick a new time"
              focusTitle
            />
          )}
          {!blocked && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setSlot(null)
                setError(null)
                setTimeout(() => openButton.current?.focus())
              }}
            >
              {t('Keep booking')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
