import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ConferenceNotice } from '../components/ConferenceNotice.tsx'
import { EmailDeliveryHint } from '../components/EmailDeliveryHint.tsx'
import { isKnownTimeZone } from '../format.ts'
import { usePageTitle } from '../hooks.ts'
import { formatList } from '../i18n/formatting.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
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
import { rememberVisitorTimeZone, visitorTimeZone } from './visitor-time-zone.ts'

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
    if (location.hash !== read.current) {
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
  const { t } = useI18n()

  usePageTitle('Your booking')
  return (
    <PublicLayout>
      <div className="card public-card">
        <h1>{t('Open your booking link')}</h1>
        <p>
          {t(
            'To see, reschedule or cancel a booking, open the link from your confirmation email or the one you saved when you booked. For your security it is removed from the address bar once opened, so reloading this page needs the link again.',
          )}
        </p>
      </div>
    </PublicLayout>
  )
}

type Mode =
  | { kind: 'view'; message?: UiText | undefined; emailNotice?: boolean; meetingStarted?: boolean }
  | { kind: 'cancel' }
  | { kind: 'reschedule'; notice?: UiText | undefined }
  | { kind: 'confirm-reschedule'; slot: Slot }

function CalendarResponseNote() {
  const { text } = useI18n()
  return (
    <p className="muted">
      {text(
        'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.',
      )}
    </p>
  )
}

async function followReschedule(
  booking: ManagedBooking,
  token: string,
  signal?: AbortSignal,
): Promise<ManagedBooking> {
  if (booking.status !== 'cancelled' || booking.conference) return booking
  // Token resolution can precede a reschedule while hydration sees its cancelled
  // predecessor. Resolve the same capability once more, using its existing successor
  // rules. The result is final, even when cancelled too; this must not become polling.
  try {
    return await getManagedBooking(token, signal)
  } catch {
    return booking
  }
}

function ManageBooking({ token: initialToken, action }: { token: string; action: Action | null }) {
  const { t, ui } = useI18n()

  // A reschedule makes a new booking with a new token; the page then manages that one.
  const [token, setToken] = useState(initialToken)
  const [newToken, setNewToken] = useState<string | null>(null)
  const load = useCallback(
    async (signal: AbortSignal) =>
      followReschedule(await getManagedBooking(initialToken, signal), initialToken, signal),
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
        <PublicStatus>{t('Loading your booking…')}</PublicStatus>
      </PublicLayout>
    )
  }
  if (state.status === 'error' && !booking) {
    const notFound = codeOf(state.error) === 'booking_not_found'
    return (
      <PublicLayout>
        <div className="card public-card">
          <h1>{notFound ? t('This link doesn’t work') : t('Your booking could not be loaded')}</h1>
          {notFound ? (
            <p>
              {t(
                'It may be incomplete or mistyped. Open the link from your email again, or ask your host for help.',
              )}
            </p>
          ) : (
            <>
              <p role="alert">{ui(failureMessage(state.error))}</p>
              <button type="button" className="button" onClick={reload}>
                {t('Try again')}
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
      onUpdated={async (fresh) => {
        const next = await followReschedule(fresh, token)
        // A later action or snapshot wins over a slow successor lookup.
        setBooking((current) => (current === booking ? next : current))
      }}
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
          const fresh = await followReschedule(await getManagedBooking(token), token)
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
  onUpdated,
  onStale,
}: {
  booking: ManagedBooking
  token: string
  newToken: string | null
  initialAction: Action | null
  onCancelled: (booking: ManagedBooking) => void
  onRescheduled: (booking: ManagedBooking, token: string | null) => void
  onUpdated: (booking: ManagedBooking) => void
  /** Loads the booking again; null when that fails too. */
  onStale: () => Promise<ManagedBooking | null>
}) {
  const { t, explicit, locale: language } = useI18n()

  const browserFormatLocale = useMemo(preferredLocale, [])
  const locale = explicit ?? browserFormatLocale
  const [timeZone, setTimeZone] = useState(() => {
    const stored = booking.attendees.find((attendee) => attendee.isBooker)?.timeZone
    return visitorTimeZone(stored && isKnownTimeZone(stored) ? stored : detectTimeZone())
  })
  const [now, setNow] = useState(currentTime)
  const [version, setVersion] = useState(0)
  const observedNow = currentTime()
  const started = Date.parse(booking.start) <= observedNow
  const ended = Date.parse(booking.end) <= observedNow
  const changeable = booking.status === 'confirmed' && !started
  const [mode, setMode] = useState<Mode>(() =>
    initialAction && changeable ? { kind: initialAction } : { kind: 'view' },
  )
  const loadSlots = useMemo(() => rescheduleSlots(token), [token])
  const title = booking.eventType?.title ?? booking.title
  const hosts = formatList(booking.hosts.map((h) => h.name).filter(Boolean), language)
  const durationMinutes =
    booking.eventType?.durationMinutes ??
    Math.round((Date.parse(booking.end) - Date.parse(booking.start)) / 60_000)

  // Why an action from the email link cannot be offered.
  const unavailable =
    initialAction && !changeable
      ? booking.status === 'cancelled'
        ? 'This booking is cancelled, so it can’t be changed.'
        : ended
          ? 'This meeting has ended.'
          : 'This meeting has already started, so it can’t be changed.'
      : undefined

  /** What to say after a reschedule whose answer never arrived, from the booking as it is now. */
  async function afterUnknownMove(slot: Slot): Promise<UiText> {
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
      setMode(
        code === 'booking_cancelled'
          ? { kind: 'view', message: 'This booking was already cancelled.' }
          : { kind: 'view', meetingStarted: true },
      )
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
    <PublicLayout wide>
      <ConferenceNotice
        key={booking.id}
        booking={booking}
        manageToken={token}
        onChange={(fresh) => {
          // A reschedule can remove the old booking's optional conference entirely.
          // Replace the read state; retain only metadata absent from the base callback type.
          onUpdated({ eventType: booking.eventType, hosts: booking.hosts, ...fresh })
          if (fresh.id !== booking.id || fresh.status !== booking.status) setMode({ kind: 'view' })
        }}
      />
      {mode.kind === 'reschedule' ? (
        <div className="booking-layout reschedule">
          <aside className="event-info reschedule-summary" aria-label={t('Current booking')}>
            <p className="event-host">{t('Current booking')}</p>
            <h1 className="event-title">{title}</h1>
            <DetailList
              items={[
                [
                  'When',
                  <When
                    key="current"
                    start={booking.start}
                    end={booking.end}
                    timeZone={timeZone}
                    locale={locale}
                  />,
                ],
                ...(hosts ? [['Host', hosts] as [string, string]] : []),
              ]}
            />
            <button
              type="button"
              className="button button-small"
              onClick={() => setMode({ kind: 'view' })}
            >
              {t('Keep the current time')}
            </button>
          </aside>
          <div className="booking-main">
            <SlotPicker
              load={loadSlots}
              durationMinutes={durationMinutes}
              timeZone={timeZone}
              onTimeZoneChange={(zone) => {
                rememberVisitorTimeZone(zone)
                setTimeZone(zone)
              }}
              locale={locale}
              now={now}
              selected={null}
              excludeStart={booking.start}
              onSelect={(slot) => setMode({ kind: 'confirm-reschedule', slot })}
              version={version}
              title={t('Pick a new time')}
              focusTitle
              notice={mode.notice}
            />
          </div>
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
              ended={ended}
              message={
                mode.meetingStarted
                  ? ended
                    ? 'This meeting has ended.'
                    : 'This meeting has already started, so it can’t be changed.'
                  : (mode.message ?? unavailable)
              }
              emailNotice={mode.emailNotice ?? false}
              newToken={newToken}
            />
          )}
          {mode.kind === 'view' && changeable && !mode.meetingStarted && (
            <>
              <CalendarResponseNote />
              <div className="manage-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setMode({ kind: 'reschedule' })}
                >
                  {t('Reschedule')}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setMode({ kind: 'cancel' })}
                >
                  {t('Cancel booking')}
                </button>
              </div>
            </>
          )}
          {mode.kind === 'cancel' && (
            <CancelForm
              title={title}
              date={formatDate(Date.parse(booking.start), timeZone, locale)}
              time={formatTimeRange(
                Date.parse(booking.start),
                Date.parse(booking.end),
                timeZone,
                locale,
              )}
              onBack={() => setMode({ kind: 'view' })}
              onCancel={async (reason) => {
                try {
                  const cancelled = await cancelManagedBooking(token, reason)
                  onCancelled({ ...booking, ...cancelled })
                  setMode({
                    kind: 'view',
                    message: 'Your booking is cancelled.',
                    emailNotice: true,
                  })
                  return null
                } catch (err) {
                  if (await failed(err, 'cancel')) return null
                  if (err instanceof PublicRequestError && err.code === 'invalid_reason') {
                    return {
                      field: msg('Use at most {0} characters, without control characters.', {
                        '0': LIMITS.reason,
                      }),
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
                  setMode({
                    kind: 'view',
                    message: 'Your booking is moved to the new time.',
                    emailNotice: true,
                  })
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
  ended,
  message,
  emailNotice,
  newToken,
}: {
  booking: ManagedBooking
  title: string
  hosts: string
  timeZone: string
  locale: string
  started: boolean
  ended: boolean
  message: UiText | undefined
  emailNotice: boolean
  newToken: string | null
}) {
  const { t, ui, locale: language } = useI18n()

  const invitee = booking.attendees.find((a) => a.isBooker)
  const guests = booking.attendees.filter((a) => !a.isBooker)
  const cancelled = booking.status === 'cancelled'
  return (
    <>
      <FocusHeading>{cancelled ? t('Cancelled booking') : t('Your booking')}</FocusHeading>
      {message && (
        <div className="alert alert-info">
          <p role="status">{ui(message)}</p>
        </div>
      )}
      {emailNotice &&
        (cancelled || !booking.conference || booking.conference.status === 'ready') && (
          <EmailDeliveryHint />
        )}
      {!message && cancelled && (
        <div className="alert alert-info">
          <p>
            {t('This booking is cancelled')}
            {booking.cancelledAt &&
              t('(since {0})', {
                '0': formatDate(Date.parse(booking.cancelledAt), timeZone, locale),
              })}
            {t('. If it was moved to another time, the new booking has its own link.')}
          </p>
        </div>
      )}
      {!message && !cancelled && started && (
        <div className="alert alert-info">
          <p>
            {ended
              ? t('This meeting has ended.')
              : t('This meeting has already started, so it can’t be changed here.')}
          </p>
        </div>
      )}
      <DetailList
        items={[
          ['What', title],
          ['Status', cancelled ? t('Cancelled booking') : ended ? t('Ended') : t('Confirmed')],
          [
            'When',
            <span key="when" className={cancelled ? 'struck' : undefined}>
              <When start={booking.start} end={booking.end} timeZone={timeZone} locale={locale} />
            </span>,
          ],
          ['Where', <LocationDetails key="where" location={booking.location} />],
          ...(hosts ? ([['Host', hosts]] as [string, string][]) : []),
          ...(invitee
            ? ([
                [
                  'Booked by',
                  t('{name} ({detail})', { name: invitee.name, detail: invitee.email }),
                ],
              ] as [string, string][])
            : []),
          ...(guests.length
            ? ([
                [
                  'Guests',
                  formatList(
                    guests.map((g) => g.name),
                    language,
                  ),
                ],
              ] as [string, string][])
            : []),
          ...(cancelled && booking.cancelReason
            ? ([['Reason', booking.cancelReason]] as [string, string][])
            : []),
        ]}
      />
      {newToken && !cancelled && (
        <ManageLink
          token={newToken}
          intro={t(
            'Moving the booking gave it a new link. Links in Hourmere’s emails keep working; the link shown when you first booked now shows the old, cancelled time.',
          )}
        />
      )}
    </>
  )
}

function CancelForm({
  title,
  date,
  time,
  onBack,
  onCancel,
}: {
  title: string
  date: string
  time: string
  onBack: () => void
  onCancel: (reason: string) => Promise<{ field?: UiText; form?: UiText } | null>
}) {
  const { t, ui } = useI18n()

  const id = useId()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<{ field?: UiText; form?: UiText } | null>(null)
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
      <FocusHeading>{t('Cancel this booking?')}</FocusHeading>
      <CalendarResponseNote />
      {/* One booking's title, date and time: a sentence, not a list, so no list separators. */}
      <p>{t('{title}, {date}, {time}', { title, date, time })}</p>
      <div className="field">
        <label htmlFor={`${id}-reason`}>
          {t('Reason')}
          <span className="optional">{t(' (optional, shared with your host)')}</span>
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
            {ui(error.field)}
          </p>
        )}
      </div>
      {error?.form && (
        <div className="alert alert-error">
          <p role="alert">{ui(error.form)}</p>
        </div>
      )}
      <div className="manage-actions">
        <button type="submit" className="button button-danger" disabled={busy}>
          {busy ? t('Cancelling…') : t('Cancel booking')}
        </button>
        <button type="button" className="button" onClick={onBack} disabled={busy}>
          {t('Keep booking')}
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
  onConfirm: () => Promise<UiText | null>
}) {
  const { t, ui } = useI18n()

  const [error, setError] = useState<UiText | null>(null)
  const [busy, setBusy] = useState(false)
  // A reschedule is not idempotent: one request at a time, and only when people press.
  const inFlight = useRef(false)
  const start = Date.parse(slot.start)
  // Keep the breakable space and opening bracket outside the no-wrap numeric offset.
  const offset = offsetLabel(timeZone, start)
  const zoneLabel = t(' ({offset})', { offset })
  const offsetAt = zoneLabel.lastIndexOf(offset)
  return (
    <div className="stack">
      <FocusHeading>{t('Move your booking?')}</FocusHeading>

      <DetailList
        items={[
          [
            'From',
            <span key="from" className="struck">
              {t('{date}, {time}', {
                date: formatDate(Date.parse(current.start), timeZone, locale),
                time: formatTimeRange(
                  Date.parse(current.start),
                  Date.parse(current.end),
                  timeZone,
                  locale,
                ),
              })}
            </span>,
          ],
          [
            'To',
            <strong key="to">
              {t('{date}, {time}', {
                date: formatDate(start, timeZone, locale),
                time: formatTimeRange(start, Date.parse(slot.end), timeZone, locale),
              })}
            </strong>,
          ],
          [
            'Time zone',
            <span key="zone">
              {zoneName(timeZone)}
              {zoneLabel.slice(0, offsetAt)}
              <span className="time-offset">{zoneLabel.slice(offsetAt)}</span>
            </span>,
          ],
        ]}
      />
      {error && (
        <div className="alert alert-error">
          <p role="alert">{ui(error)}</p>
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
          {busy ? t('Moving…') : t('Confirm new time')}
        </button>
        <button type="button" className="button" onClick={onBack} disabled={busy}>
          {t('Pick another time')}
        </button>
      </div>
    </div>
  )
}
