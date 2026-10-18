import { useEffect, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { useI18n } from '../../i18n/runtime.tsx'

type Booking = Schemas['Booking']
/** Private caller-only copy status. Never loaded or rendered by the public booking page. */
export function CalendarCopyNotice({
  booking,
  onChange,
}: {
  booking: Booking
  onChange: (b: Booking) => void
}) {
  const { t } = useI18n(),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [refresh, setRefresh] = useState(0)
  const callback = useRef(onChange)
  callback.current = onChange
  const request = useRef<AbortController | null>(null)
  const state = booking.calendarCopy
  const copyStatus = state?.status
  const lifecycle = `${booking.id}:${booking.status}:${booking.start}:${booking.end}`
  const currentLifecycle = useRef(lifecycle)
  currentLifecycle.current = lifecycle
  // biome-ignore lint/correctness/useExhaustiveDependencies: lifecycle invalidates an in-flight retry even when the booking id stays the same
  useEffect(() => {
    setBusy(false)
    return () => request.current?.abort()
  }, [lifecycle])
  useEffect(() => {
    if (!copyStatus || (copyStatus !== 'pending' && refresh === 0)) return
    const controller = new AbortController()
    let active = true,
      count = 0,
      timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const current = await unwrap(
          api.GET('/api/v1/bookings/{id}', {
            params: { path: { id: booking.id } },
            signal: controller.signal,
          }),
        )
        if (!active || currentLifecycle.current !== lifecycle) return
        setFailed(false)
        callback.current(current)
        count++
        if (current.calendarCopy?.status === 'pending' && count < 20) timer = setTimeout(read, 3000)
      } catch {
        if (active) setFailed(true)
      }
    }
    timer = setTimeout(read, refresh ? 0 : 2000)
    return () => {
      active = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [booking.id, copyStatus, refresh, lifecycle])
  if (!state) return null
  async function retry() {
    if (busy) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setFailed(false)
    try {
      await unwrap(
        api.POST('/api/v1/bookings/{id}/calendar-copy/retry', {
          params: { path: { id: booking.id } },
          body: {},
          signal: controller.signal,
        }),
      )
      if (!controller.signal.aborted && currentLifecycle.current === lifecycle) {
        callback.current({
          ...booking,
          calendarCopy: { ...state, status: 'pending', errorCode: null, canRetry: false },
        })
        setRefresh((n) => n + 1)
      }
    } catch {
      if (!controller.signal.aborted && currentLifecycle.current === lifecycle) setFailed(true)
    } finally {
      if (!controller.signal.aborted && currentLifecycle.current === lifecycle) setBusy(false)
    }
  }
  return (
    <section className="panel" aria-label={t('My calendar copy')} aria-live="polite">
      <h2>{t('My calendar copy')}</h2>
      <p>
        {t(
          state.status === 'not_configured'
            ? 'No calendar copy was configured when this booking was created. Your invitation still arrives by email. Connecting a calendar later does not add a copy to this meeting.'
            : state.status === 'ready'
              ? 'Your original calendar copy is up to date.'
              : state.status === 'pending'
                ? 'Your calendar copy is waiting for the ready meeting link or a calendar update.'
                : 'Your calendar copy needs attention. The shared meeting link is unaffected; this meeting will not switch calendars.',
        )}
      </p>
      {state.errorCode === 'ambiguous_create' && (
        <p>
          {t(
            'Google may have accepted this copy. Rechecking only looks for the existing copy and never imports another after an unknown result.',
          )}
        </p>
      )}
      {failed && (
        <p role="alert">
          {t('Could not check or retry your calendar copy. Your booking has not been changed.')}
        </p>
      )}
      {state.canRetry && (
        <button type="button" className="button button-small" disabled={busy} onClick={retry}>
          {t(busy ? 'Requesting…' : 'Recheck my calendar copy')}
        </button>
      )}
      {(state.status === 'pending' || state.status === 'failed') && (
        <button type="button" onClick={() => setRefresh((n) => n + 1)}>
          {t('Check my calendar copy status')}
        </button>
      )}
    </section>
  )
}
