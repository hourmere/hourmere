import { displayConferenceUrl } from '@hourmere/core/conference-url'
import { useEffect, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { isOrganizationContextChanged } from '../api/errors.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { OrganizationContextConflict } from './OrganizationContextConflict.tsx'

type Booking = Schemas['Booking']
/** No session/profile requests on public pages; the capability stays in memory and a header. */
export function ConferenceNotice({
  booking,
  manageToken,
  host = false,
  expectedOrganizationId,
  onChange,
}: {
  booking: Booking
  manageToken?: string | null
  host?: boolean
  expectedOrganizationId?: string
  onChange?: (booking: Booking) => void
}) {
  const { t } = useI18n()
  const [current, setCurrent] = useState(booking)
  const [readError, setReadError] = useState(false)
  const [paused, setPaused] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState(false)
  const [conflict, setConflict] = useState<unknown>(null)
  const [refresh, setRefresh] = useState(0)
  const consumedRefresh = useRef(0)
  // A cancellation can retain the booking id and remain conference-pending. A response
  // started before that lifecycle change must never restore its old confirmed state.
  // Stable fields, rather than the refreshed object, keep the bounded polling budget.
  const lifecycle = `${booking.id}:${booking.status}:${booking.start}:${booking.end}:${booking.conference?.status ?? ''}`
  const currentLifecycle = useRef(lifecycle)
  currentLifecycle.current = lifecycle
  const changed = useRef(onChange)
  changed.current = onChange
  const retryRequest = useRef<AbortController | null>(null)
  useEffect(() => setCurrent(booking), [booking])
  useEffect(() => () => retryRequest.current?.abort(), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: lifecycle deliberately invalidates an in-flight write even if the booking id is unchanged
  useEffect(() => {
    setRetrying(false)
    return () => retryRequest.current?.abort()
  }, [lifecycle])
  const status = current.conference?.status
  const canRead = Boolean(manageToken) || host
  useEffect(() => {
    const forced = refresh !== consumedRefresh.current
    consumedRefresh.current = refresh
    if (!canRead || !status || (status !== 'pending' && !forced)) return
    const request = new AbortController()
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let count = 0
    setPaused(false)
    async function read() {
      try {
        const data = manageToken
          ? await unwrap(
              api.GET('/api/v1/bookings/manage', {
                headers: { 'X-Manage-Token': manageToken },
                signal: request.signal,
              }),
            )
          : await unwrap(
              api.GET('/api/v1/bookings/{id}', {
                params: { path: { id: current.id } },
                signal: request.signal,
              }),
            )
        if (!active || currentLifecycle.current !== lifecycle) return
        setReadError(false)
        setCurrent(data)
        changed.current?.(data)
        count++
        if (data.conference?.status === 'pending' && count < 30)
          timer = setTimeout(read, Math.min(10_000, 2_000 + count * 500))
        else if (data.conference?.status === 'pending') setPaused(true)
      } catch {
        if (active && currentLifecycle.current === lifecycle) {
          setReadError(true)
          setPaused(true)
        }
      }
    }
    timer = setTimeout(read, forced ? 0 : 2_000)
    return () => {
      active = false
      request.abort()
      clearTimeout(timer)
    }
  }, [canRead, current.id, manageToken, status, refresh, lifecycle])

  async function retry() {
    if (retrying || conflict) return
    retryRequest.current?.abort()
    const request = new AbortController()
    const requestLifecycle = lifecycle
    retryRequest.current = request
    setRetrying(true)
    setRetryError(false)
    try {
      await unwrap(
        api.POST('/api/v1/bookings/{id}/conference/retry', {
          headers: expectedOrganizationId
            ? { 'X-Expected-Organization-Id': expectedOrganizationId }
            : undefined,
          params: { path: { id: current.id } },
          body: {},
          signal: request.signal,
        }),
      )
      if (request.signal.aborted || currentLifecycle.current !== requestLifecycle) return
      setCurrent((value) => ({
        ...value,
        conference: value.conference && { ...value.conference, status: 'pending', errorCode: null },
      }))
      setRefresh((n) => n + 1)
    } catch (err) {
      if (!request.signal.aborted && currentLifecycle.current === requestLifecycle) {
        if (isOrganizationContextChanged(err)) setConflict(err)
        else setRetryError(true)
      }
    } finally {
      if (!request.signal.aborted && currentLifecycle.current === requestLifecycle)
        setRetrying(false)
    }
  }

  if (!current.conference) return null
  const cancelled = current.status === 'cancelled'
  const zoom = current.conference.provider === 'zoom'
  const url = displayConferenceUrl(current.conference.provider, current.location?.url)
  const ambiguous = current.conference.errorCode === 'ambiguous_create'
  const pendingTimeout = !zoom && current.conference.errorCode === 'conference_pending_timeout'
  return (
    <section className="alert alert-info" aria-label={t('Meeting link')} aria-live="polite">
      <h2>
        {t(cancelled ? (zoom ? 'Zoom meeting update' : 'Google calendar update') : 'Meeting link')}
      </h2>
      {status === 'pending' ? (
        <p>
          {t(
            cancelled
              ? zoom
                ? 'Your booking is cancelled. The Zoom meeting update is pending.'
                : 'Your booking is cancelled. The Google calendar update is pending.'
              : zoom
                ? 'Your time is reserved. The Zoom link and final calendar invitation are being prepared.'
                : 'Your time is reserved. The Google Meet link and final calendar invitation are being prepared.',
          )}
        </p>
      ) : status === 'ready' ? (
        cancelled ? (
          <p>
            {t(
              zoom
                ? 'The original Zoom meeting has been cancelled.'
                : 'The Google calendar copy is cancelled. Cancelling does not revoke access to an existing Meet link.',
            )}
          </p>
        ) : url ? (
          <p>
            <a href={url} target="_blank" rel="noreferrer noopener">
              {t(zoom ? 'Join Zoom meeting' : 'Join Google Meet')}
            </a>
          </p>
        ) : (
          <p>
            {t('The meeting link could not be displayed. Check its status or contact the host.')}
          </p>
        )
      ) : (
        <>
          <p>
            {t(
              cancelled
                ? zoom
                  ? 'Your booking is cancelled, but Zoom cleanup needs the host’s attention.'
                  : 'Your booking is cancelled, but Google calendar cleanup needs the host’s attention.'
                : 'Your time is reserved, but the meeting link needs the host’s attention. The final calendar invitation has not been sent.',
            )}
          </p>
          {ambiguous && (
            <p>
              {t(
                zoom
                  ? 'Zoom may have created the meeting. The host must inspect their Zoom account and remove any orphan before replacing or rebooking. This booking will never create another meeting.'
                  : 'Google may have created the meeting. Rechecking only looks for that meeting and never creates a replacement.',
              )}
            </p>
          )}
          {pendingTimeout && !cancelled && (
            <p>
              {t(
                'Google is still preparing the Meet link after repeated checks. The host can recheck the existing request; a retry does not create a replacement meeting.',
              )}
            </p>
          )}
          {current.conference.errorCode === 'organizer_unavailable' && (
            <p>
              {t(
                'The original organizer’s verified invitation identity is unavailable. This booking will not switch organizers. Contact the host or cancel the booking.',
              )}
            </p>
          )}
          {current.conference.errorCode === 'calendar_unavailable' && (
            <p>
              {t(
                'The original Google calendar is unavailable. This booking will not switch to a different account or calendar.',
              )}
            </p>
          )}
          {(current.conference.errorCode === 'needs_reauth' ||
            current.conference.errorCode === 'permissions_missing') && (
            <p>
              {t(
                zoom
                  ? 'The host needs to reconnect the original Zoom meetings account before retrying.'
                  : 'The host needs to reconnect the original Google Calendar account before retrying.',
              )}
            </p>
          )}
        </>
      )}
      {readError && (
        <p role="alert">
          {t('Could not check the meeting link. Your booking has not been changed.')}
        </p>
      )}
      {retryError && (
        <p role="alert">
          {t('Could not request a safe retry. Check the booking status before trying again.')}
        </p>
      )}
      {conflict !== null && <OrganizationContextConflict error={conflict} />}
      {host &&
        current.conferenceCanRetry !== false &&
        status === 'failed' &&
        !(zoom && ambiguous) &&
        (cancelled || Date.parse(current.start) > Date.now()) && (
          <button
            type="button"
            className="button button-small"
            onClick={retry}
            disabled={retrying || !!conflict}
          >
            {t(
              retrying
                ? 'Requesting…'
                : cancelled
                  ? zoom
                    ? 'Retry Zoom cleanup'
                    : 'Retry Google calendar cleanup'
                  : ambiguous || pendingTimeout
                    ? 'Recheck existing meeting'
                    : 'Retry meeting link',
            )}
          </button>
        )}
      {canRead && (paused || status === 'failed') && (
        <button
          type="button"
          className="button button-small"
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t('Check meeting link status')}
        </button>
      )}
      {!canRead && status !== 'ready' && (
        <p>{t('Use the booking or failure email to check the meeting link.')}</p>
      )}
    </section>
  )
}
