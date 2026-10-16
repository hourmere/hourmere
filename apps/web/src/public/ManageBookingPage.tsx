import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { ManageLink } from './AddToCalendar.tsx'
import {
  cancelManagedBooking,
  codeOf,
  failureMessage,
  getManagedBooking,
  type ManagedBooking,
  PublicRequestError,
  rescheduleManagedBooking,
  rescheduleSlots,
  type Slot,
} from './api.ts'
import { DetailList, LocationDetails, When } from './BookingDetails.tsx'
import { now as currentTime, detectTimeZone, preferredLocale } from './env.ts'
import { FocusHeading, PublicLayout, PublicStatus } from './PublicLayout.tsx'
import { useRequest } from './paths.ts'
import { SlotPicker } from './SlotPicker.tsx'
import { formatDate, formatTimeRange, offsetLabel, zoneName } from './time.ts'
import { LIMITS, reasonError } from './validation.ts'

type Action = 'cancel' | 'reschedule'

/** What an invitee link carries in its fragment: `#token=…&action=cancel|reschedule`. */
export function parseManageFragment(hash: string): { token: string | null; action: Action | null } {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')
  const action = params.get('action')
  return {
    token: token || null,
    action: action === 'cancel' || action === 'reschedule' ? action : null,
  }
}

/**
 * /booking#token=…: the invitee's page for one booking. The token is read from the fragment
 * (which browsers never send to a server) and then removed from the address bar at once, so
 * it does not linger in history, bookmarks, screenshots or a Referer; from then on it lives
 * only in this page's memory and goes to the API in the X-Manage-Token header.
 */
export function ManageBookingPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [link, setLink] = useState(() => ({ ...parseManageFragment(location.hash), visit: 0 }))
  // The fragment this page started with, already read above. Any other one is a link opened
  // into this tab later (even the same link again), which starts the page over.
  const read = useRef<string | null>(location.hash)

  useEffect(() => {
    if (!location.hash) {
      read.current = null
      return
    }
    const parsed = parseManageFragment(location.hash)
    if (parsed.token && location.hash !== read.current) {
      setLink((current) => ({ ...parsed, visit: current.visit + 1 }))
    }
    navigate({ pathname: location.pathname, search: location.search }, { replace: true })
  }, [location.hash, location.pathname, location.search, navigate])

  if (!link.token) {
    return <NoToken />
  }
  return (
    <ManageBooking key={`${link.visit}:${link.token}`} token={link.token} action={link.action} />
  )
}

function NoToken() {
  usePageTitle('Your booking')
  return (
    <PublicLayout>
      <div className="card public-card">
        <h1>Open your booking link</h1>
        <p>
          To see, reschedule or cancel a booking, open the link from your confirmation email or the
          one you saved when you booked. For your security it is removed from the address bar once
          opened, so reloading this page needs the link again.
        </p>
      </div>
    </PublicLayout>
  )
}

type Mode =
  | { kind: 'view'; message?: string | undefined }
  | { kind: 'cancel' }
  | { kind: 'reschedule'; notice?: string | undefined }
  | { kind: 'confirm-reschedule'; slot: Slot }

function ManageBooking({ token: initialToken, action }: { token: string; action: Action | null }) {
  // A reschedule makes a new booking with a new token; the page then manages that one.
  const [token, setToken] = useState(initialToken)
  const [newToken, setNewToken] = useState<string | null>(null)
  const load = useCallback(
    (signal: AbortSignal) => getManagedBooking(initialToken, signal),
    [initialToken],
  )
  const [state, reload] = useRequest(load)
  const [booking, setBooking] = useState<ManagedBooking | null>(null)
  usePageTitle('Your booking')

  useEffect(() => {
    if (state.status === 'ready') setBooking(state.data)
  }, [state])

  if (state.status === 'loading' && !booking) {
    return (
      <PublicLayout>
        <PublicStatus>Loading your booking…</PublicStatus>
      </PublicLayout>
    )
  }
  if (state.status === 'error' && !booking) {
    const notFound = codeOf(state.error) === 'booking_not_found'
    return (
      <PublicLayout>
        <div className="card public-card">
          <h1>{notFound ? 'This link doesn’t work' : 'Your booking could not be loaded'}</h1>
          {notFound ? (
            <p>
              It may be incomplete or mistyped. Open the link from your email again, or ask your
              host for help.
            </p>
          ) : (
            <>
              <p role="alert">{failureMessage(state.error)}</p>
              <button type="button" className="button" onClick={reload}>
                Try again
              </button>
            </>
          )}
        </div>
      </PublicLayout>
    )
  }
  if (!booking) return null
  return (
    <ManageView
      booking={booking}
      token={token}
      newToken={newToken}
      initialAction={action}
      onCancelled={(cancelled) => setBooking({ ...booking, ...cancelled })}
      onRescheduled={(next, nextToken) => {
        setBooking({ ...booking, ...next })
        if (nextToken) {
          setToken(nextToken)
          setNewToken(nextToken)
        }
      }}
      onStale={async () => {
        // The booking changed elsewhere (cancelled in another tab, say), or an answer was
        // lost: show it as the server has it now.
        try {
          const fresh = await getManagedBooking(token)
          setBooking(fresh)
          return fresh
        } catch {
          return null
        }
      }}
    />
  )
}

function ManageView({
  booking,
  token,
  newToken,
  initialAction,
  onCancelled,
  onRescheduled,
  onStale,
}: {
  booking: ManagedBooking
  token: string
  newToken: string | null
  initialAction: Action | null
  onCancelled: (booking: ManagedBooking) => void
  onRescheduled: (booking: ManagedBooking, token: string | null) => void
  /** Loads the booking again; null when that fails too. */
  onStale: () => Promise<ManagedBooking | null>
}) {
  const locale = useMemo(preferredLocale, [])
  const [timeZone, setTimeZone] = useState(detectTimeZone)
  const [now, setNow] = useState(currentTime)
  const [version, setVersion] = useState(0)
  const started = Date.parse(booking.start) <= now
  const changeable = booking.status === 'confirmed' && !started
  const [mode, setMode] = useState<Mode>(() =>
    initialAction && changeable ? { kind: initialAction } : { kind: 'view' },
  )
  const loadSlots = useMemo(() => rescheduleSlots(token), [token])
  const title = booking.eventType?.title ?? booking.title
  const hosts = booking.hosts
    .map((h) => h.name)
    .filter(Boolean)
    .join(', ')
  const durationMinutes =
    booking.eventType?.durationMinutes ??
    Math.round((Date.parse(booking.end) - Date.parse(booking.start)) / 60_000)

  // Why an action from the email link cannot be offered.
  const unavailable =
    initialAction && !changeable
      ? booking.status === 'cancelled'
        ? 'This booking is cancelled, so it can’t be changed.'
        : 'This meeting has already started, so it can’t be changed.'
      : undefined

  /** What to say after a reschedule whose answer never arrived, from the booking as it is now. */
  async function afterUnknownMove(slot: Slot): Promise<string> {
    const fresh = await onStale()
    if (!fresh) {
      return 'We could not confirm whether your booking was moved. Open your link again to check before trying again.'
    }
    if (fresh.status === 'confirmed' && fresh.start === slot.start) {
      return 'Your booking is moved to the new time.'
    }
    if (fresh.status === 'cancelled') {
      return 'We could not confirm the change. This link now shows the booking as cancelled: if it was moved, the email about the new time has its link.'
    }
    return 'Your booking was not moved: the request did not go through. You can try again.'
  }

  async function failed(err: unknown, during: Action) {
    const code = codeOf(err)
    if (code === 'booking_changed') {
      // An email's link follows the meeting, which kept being moved while this waited. Show
      // it as it is now and let people decide; never send the change again by itself.
      await onStale()
      setMode({
        kind: 'view',
        message:
          'This booking just changed. Here it is as it is now; check it before trying again.',
      })
      return true
    }
    if (code === 'booking_cancelled' || code === 'booking_in_past') {
      await onStale()
      setMode({
        kind: 'view',
        message:
          code === 'booking_cancelled'
            ? 'This booking was already cancelled.'
            : 'This meeting has already started, so it can’t be changed.',
      })
      return true
    }
    if (during === 'reschedule' && (code === 'slot_taken' || code === 'slot_unavailable')) {
      setNow(currentTime())
      setVersion((v) => v + 1)
      setMode({
        kind: 'reschedule',
        notice:
          code === 'slot_taken'
            ? 'Someone else just booked that time. Please pick another one.'
            : 'That time is no longer available. Please pick another one.',
      })
      return true
    }
    if (code === 'event_type_unavailable' || code === 'booking_has_no_host') {
      setMode({
        kind: 'view',
        message:
          'This booking can no longer be moved to another time. You can still cancel it, or contact your host.',
      })
      return true
    }
    return false
  }

  return (
    <PublicLayout wide={mode.kind === 'reschedule'}>
      {mode.kind === 'reschedule' ? (
        <div className="reschedule">
          <div className="reschedule-header">
            <p className="muted">
              Rescheduling {title}
              {hosts && ` with ${hosts}`}, now on{' '}
              {formatDate(Date.parse(booking.start), timeZone, locale)},{' '}
              {formatTimeRange(
                Date.parse(booking.start),
                Date.parse(booking.end),
                timeZone,
                locale,
              )}
            </p>
            <button
              type="button"
              className="button button-small"
              onClick={() => setMode({ kind: 'view' })}
            >
              Keep the current time
            </button>
          </div>
          <SlotPicker
            load={loadSlots}
            durationMinutes={durationMinutes}
            timeZone={timeZone}
            onTimeZoneChange={setTimeZone}
            locale={locale}
            now={now}
            selected={null}
            onSelect={(slot) => setMode({ kind: 'confirm-reschedule', slot })}
            version={version}
            title="Pick a new time"
            focusTitle
            notice={mode.notice}
          />
        </div>
      ) : (
        <div className="card public-card manage">
          {mode.kind === 'view' && (
            <BookingSummary
              booking={booking}
              title={title}
              hosts={hosts}
              timeZone={timeZone}
              locale={locale}
              started={started}
              message={mode.message ?? unavailable}
              newToken={newToken}
            />
          )}
          {mode.kind === 'view' && changeable && (
            <div className="manage-actions">
              <button
                type="button"
                className="button button-primary"
                onClick={() => setMode({ kind: 'reschedule' })}
              >
                Reschedule
              </button>
              <button type="button" className="button" onClick={() => setMode({ kind: 'cancel' })}>
                Cancel booking
              </button>
            </div>
          )}
          {mode.kind === 'cancel' && (
            <CancelForm
              title={title}
              when={`${formatDate(Date.parse(booking.start), timeZone, locale)}, ${formatTimeRange(Date.parse(booking.start), Date.parse(booking.end), timeZone, locale)}`}
              onBack={() => setMode({ kind: 'view' })}
              onCancel={async (reason) => {
                try {
                  const cancelled = await cancelManagedBooking(token, reason)
                  onCancelled({ ...booking, ...cancelled })
                  setMode({ kind: 'view', message: 'Your booking is cancelled.' })
                  return null
                } catch (err) {
                  if (await failed(err, 'cancel')) return null
                  if (err instanceof PublicRequestError && err.code === 'invalid_reason') {
                    return {
                      field: `Use at most ${LIMITS.reason} characters, without control characters.`,
                    }
                  }
                  return { form: failureMessage(err) }
                }
              }}
            />
          )}
          {mode.kind === 'confirm-reschedule' && (
            <ConfirmReschedule
              slot={mode.slot}
              current={booking}
              timeZone={timeZone}
              locale={locale}
              onBack={() => setMode({ kind: 'reschedule' })}
              onConfirm={async () => {
                const { slot } = mode
                try {
                  const result = await rescheduleManagedBooking(token, slot.start)
                  onRescheduled({ ...booking, ...result.booking }, result.manageToken)
                  setMode({ kind: 'view', message: 'Your booking is moved to the new time.' })
                  return null
                } catch (err) {
                  if (await failed(err, 'reschedule')) return null
                  if (err instanceof PublicRequestError && err.status < 500) {
                    return failureMessage(err)
                  }
                  // Offline, or the server failed: the booking may have moved all the same, and
                  // moving it again would move it twice (a link from an email follows the
                  // booking to its new time). Never retry: look at it again, and let people
                  // decide.
                  setMode({ kind: 'view', message: await afterUnknownMove(slot) })
                  return null
                }
              }}
            />
          )}
        </div>
      )}
    </PublicLayout>
  )
}

function BookingSummary({
  booking,
  title,
  hosts,
  timeZone,
  locale,
  started,
  message,
  newToken,
}: {
  booking: ManagedBooking
  title: string
  hosts: string
  timeZone: string
  locale: string
  started: boolean
  message: string | undefined
  newToken: string | null
}) {
  const invitee = booking.attendees.find((a) => a.isBooker)
  const guests = booking.attendees.filter((a) => !a.isBooker)
  const cancelled = booking.status === 'cancelled'
  return (
    <>
      <FocusHeading>{cancelled ? 'Cancelled booking' : 'Your booking'}</FocusHeading>
      {message && (
        <div className="alert alert-info">
          <p role="status">{message}</p>
        </div>
      )}
      {!message && cancelled && (
        <div className="alert alert-info">
          <p>
            This booking is cancelled
            {booking.cancelledAt &&
              ` (since ${formatDate(Date.parse(booking.cancelledAt), timeZone, locale)})`}
            . If it was moved to another time, the new booking has its own link.
          </p>
        </div>
      )}
      {!message && !cancelled && started && (
        <div className="alert alert-info">
          <p>This meeting has already started, so it can’t be changed here.</p>
        </div>
      )}
      <DetailList
        items={[
          ['What', title],
          [
            'When',
            <span key="when" className={cancelled ? 'struck' : undefined}>
              <When start={booking.start} end={booking.end} timeZone={timeZone} locale={locale} />
            </span>,
          ],
          ['Where', <LocationDetails key="where" location={booking.location} />],
          ...(hosts ? ([['Host', hosts]] as [string, string][]) : []),
          ...(invitee
            ? ([['Booked by', `${invitee.name} (${invitee.email})`]] as [string, string][])
            : []),
          ...(guests.length
            ? ([['Guests', guests.map((g) => g.name).join(', ')]] as [string, string][])
            : []),
          ...(cancelled && booking.cancelReason
            ? ([['Reason', booking.cancelReason]] as [string, string][])
            : []),
        ]}
      />
      {newToken && !cancelled && (
        <ManageLink
          token={newToken}
          intro="Moving the booking gave it a new link. Links in Hourmere’s emails keep working; the link shown when you first booked now shows the old, cancelled time."
        />
      )}
    </>
  )
}

function CancelForm({
  title,
  when,
  onBack,
  onCancel,
}: {
  title: string
  when: string
  onBack: () => void
  onCancel: (reason: string) => Promise<{ field?: string; form?: string } | null>
}) {
  const id = useId()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<{ field?: string; form?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const problem = reasonError(reason)
    if (problem) {
      setError({ field: problem })
      document.getElementById(`${id}-reason`)?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const result = await onCancel(reason.trim())
    setBusy(false)
    if (result) setError(result)
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <FocusHeading>Cancel this booking?</FocusHeading>
      <p>
        {title}, {when}
      </p>
      <div className="field">
        <label htmlFor={`${id}-reason`}>
          Reason <span className="optional">(optional, shared with your host)</span>
        </label>
        <textarea
          id={`${id}-reason`}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={error?.field ? true : undefined}
          aria-describedby={error?.field ? `${id}-reason-error` : undefined}
        />
        {error?.field && (
          <p className="field-error" id={`${id}-reason-error`}>
            {error.field}
          </p>
        )}
      </div>
      {error?.form && (
        <div className="alert alert-error">
          <p role="alert">{error.form}</p>
        </div>
      )}
      <div className="manage-actions">
        <button type="submit" className="button button-danger" disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel booking'}
        </button>
        <button type="button" className="button" onClick={onBack} disabled={busy}>
          Keep booking
        </button>
      </div>
    </form>
  )
}

function ConfirmReschedule({
  slot,
  current,
  timeZone,
  locale,
  onBack,
  onConfirm,
}: {
  slot: Slot
  current: ManagedBooking
  timeZone: string
  locale: string
  onBack: () => void
  onConfirm: () => Promise<string | null>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A reschedule is not idempotent: one request at a time, and only when people press.
  const inFlight = useRef(false)
  const start = Date.parse(slot.start)
  return (
    <div className="stack">
      <FocusHeading>Move your booking?</FocusHeading>
      <DetailList
        items={[
          [
            'From',
            <span key="from" className="struck">
              {formatDate(Date.parse(current.start), timeZone, locale)},{' '}
              {formatTimeRange(
                Date.parse(current.start),
                Date.parse(current.end),
                timeZone,
                locale,
              )}
            </span>,
          ],
          [
            'To',
            <strong key="to">
              {formatDate(start, timeZone, locale)},{' '}
              {formatTimeRange(start, Date.parse(slot.end), timeZone, locale)}
            </strong>,
          ],
          ['Time zone', `${zoneName(timeZone)} (${offsetLabel(timeZone, start)})`],
        ]}
      />
      {error && (
        <div className="alert alert-error">
          <p role="alert">{error}</p>
        </div>
      )}
      <div className="manage-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={async () => {
            if (inFlight.current) return
            inFlight.current = true
            setBusy(true)
            setError(null)
            const problem = await onConfirm()
            inFlight.current = false
            setBusy(false)
            if (problem) setError(problem)
          }}
        >
          {busy ? 'Moving…' : 'Confirm new time'}
        </button>
        <button type="button" className="button" onClick={onBack} disabled={busy}>
          Pick another time
        </button>
      </div>
    </div>
  )
}
