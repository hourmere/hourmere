import { type FormEvent, useCallback, useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, RequestError } from '../../api/errors.ts'
import { type Booking, isNotFound, loadProfile } from '../../api/resources.ts'
import { ConferenceNotice } from '../../components/ConferenceNotice.tsx'
import { Field } from '../../components/forms.tsx'
import { useFlash } from '../../flash.ts'
import { zoned } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { BOOKING } from '../../limits.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import { isMultiLineText } from '../../text.ts'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { MissingRecord } from '../NotFound.tsx'
import { answerText, describeLocation, hostZone, SOURCE_LABELS } from './booking-format.ts'
import { CalendarCopyNotice } from './CalendarCopyNotice.tsx'
import { RescheduleBooking } from './RescheduleBooking.tsx'

type Question = Schemas['Question']

interface Loaded {
  booking: Booking
  /** The event type's questions, for labelling answers; [] if it is gone. */
  questions: Question[]
  timeZone: string
  fromProfile: boolean
}

export function BookingDetailPage() {
  const { id = '' } = useParams()
  // Starts over for another booking (e.g. the one it was rescheduled from).
  return <BookingDetail key={id} id={id} />
}

function BookingDetail({ id }: { id: string }) {
  const { t, ui } = useI18n()

  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded | 'missing'> => {
      const [booking, profile] = await Promise.all([
        unwrap(api.GET('/api/v1/bookings/{id}', { params: { path: { id } }, signal })).catch(
          (err: unknown) => {
            // A malformed id is a 400 invalid_request: as missing as an unknown one.
            if (
              isNotFound(err, 'booking_not_found') ||
              (err instanceof RequestError && err.status === 400)
            ) {
              return 'missing' as const
            }
            throw err
          },
        ),
        loadProfile(signal),
      ])
      if (booking === 'missing') return 'missing'
      let questions: Question[] = []
      if (booking.eventTypeId) {
        // The event type may have been deleted since, or belong to another organization's
        // page: the answers are then shown under their ids.
        try {
          const { data } = await api.GET('/api/v1/event-types/{id}', {
            params: { path: { id: booking.eventTypeId } },
            signal,
          })
          questions = data?.questions ?? []
        } catch (err) {
          // Labels are a nicety; the booking itself loaded.
          if (signal.aborted) throw err
        }
      }
      return { booking, questions, ...hostZone(profile) }
    },
    [id],
  )
  const [state, reload] = useLoad(load)
  usePageTitle('Booking')

  if (state.status === 'loading') return <p role="status">{t('Loading the booking…')}</p>
  if (state.status === 'error') {
    return (
      <>
        <h1>{t('Booking')}</h1>
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the booking.')} {ui(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </>
    )
  }
  if (state.data === 'missing') {
    return (
      <MissingRecord
        title={t('Booking not found')}
        message="This booking does not exist, or it is not one of yours."
        back={{ to: PATHS.bookings, label: 'Back to bookings' }}
      />
    )
  }
  return <BookingView {...state.data} />
}

function BookingView({ booking: initial, questions, timeZone, fromProfile }: Loaded) {
  const { t, ui, formatLocale: displayLocale } = useI18n()
  const flash = useFlash()

  const [booking, setBooking] = useState(initial)
  const [status, setStatus] = useState<UiText>(flash ?? '')
  const statusRef = useRef<HTMLParagraphElement>(null)
  const format = zoned(timeZone, displayLocale)
  const zoneName = format.timeZone.replaceAll('_', ' ')
  const [invitee, ...guests] = [...booking.attendees].sort(
    (a, b) => Number(b.isBooker) - Number(a.isBooker),
  )
  const location = describeLocation(booking.location)
  const cancelled = booking.status === 'cancelled'
  const started = new Date(booking.start).getTime() <= Date.now()

  // Answers in the order of the questions, then any the event type no longer asks.
  const labels = new Map(questions.map((q) => [q.id, q.label]))
  const answerIds = [
    ...questions.map((q) => q.id).filter((qid) => Object.hasOwn(booking.responses, qid)),
    ...Object.keys(booking.responses).filter((qid) => !labels.has(qid)),
  ]

  return (
    <>
      <p className="breadcrumb">
        <Link to={PATHS.bookings}>{t('Bookings')}</Link>
      </p>
      <h1>
        {booking.title}
        {cancelled && <span className="badge badge-danger heading-badge">{t('Cancelled')}</span>}
      </h1>
      <p className="flash" role="status" tabIndex={-1} ref={statusRef}>
        {ui(status)}
      </p>

      <ConferenceNotice key={booking.id} booking={booking} host onChange={setBooking} />
      <CalendarCopyNotice key={`copy:${booking.id}`} booking={booking} onChange={setBooking} />
      <section className="panel" aria-labelledby="when-heading">
        <h2 id="when-heading">{t('When')}</h2>
        <p className="when">
          <time dateTime={booking.start}>{format.longDate(booking.start)}</time>
          <br />
          {format.timeRange(booking.start, booking.end)} <span className="muted">({zoneName})</span>
        </p>
        {!fromProfile && (
          <p className="hint">
            {t('Shown in this browser’s time zone.')}{' '}
            <Link to={PATHS.settings}>{t('Set your time zone')}</Link>.
          </p>
        )}
        <dl className="details">
          <dt>{t('Location')}</dt>
          <dd>
            {location ? (
              <>
                {ui(location.label)}
                {location.detail && (
                  <>
                    :{' '}
                    {location.href ? (
                      <a href={location.href} target="_blank" rel="noreferrer">
                        {location.detail}
                      </a>
                    ) : (
                      location.detail
                    )}
                  </>
                )}
              </>
            ) : (
              <span className="muted">{t('Not set')}</span>
            )}
          </dd>
          <dt>{t('Booked')}</dt>
          <dd>
            {format.dateTime(booking.createdAt)}
            {t(', through')} {ui(SOURCE_LABELS[booking.source])}
          </dd>
          {booking.rescheduledFromId && (
            <>
              <dt>{t('Rescheduled')}</dt>
              <dd>
                {t('From')}{' '}
                <Link to={bookingPath(booking.rescheduledFromId)}>{t('an earlier booking')}</Link>
              </dd>
            </>
          )}
          {cancelled && (
            <>
              <dt>{t('Cancelled')}</dt>
              <dd>
                {booking.cancelledAt ? format.dateTime(booking.cancelledAt) : t('Yes')}
                {booking.cancelReason && (
                  <>
                    <br />
                    <span className="multiline">
                      {t('Reason:')} {booking.cancelReason}
                    </span>
                  </>
                )}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="panel" aria-labelledby="people-heading">
        <h2 id="people-heading">{t('People')}</h2>
        <dl className="details">
          <dt>{t('Invitee')}</dt>
          <dd>
            {invitee ? (
              <>
                {invitee.name}
                <br />
                <a href={`mailto:${invitee.email}`}>{invitee.email}</a>
                <br />
                <span className="muted">
                  {t('Time zone:')} {invitee.timeZone.replaceAll('_', ' ')}
                  {invitee.timeZone !== format.timeZone && (
                    <>
                      {' '}
                      (
                      {zoned(invitee.timeZone, displayLocale).dateTimeRange(
                        booking.start,
                        booking.end,
                      )}{' '}
                      {t('there)')}
                    </>
                  )}
                </span>
              </>
            ) : (
              <span className="muted">{t('Unknown')}</span>
            )}
          </dd>
          <dt>{t('Guests')}</dt>
          <dd>
            {guests.length === 0 ? (
              <span className="muted">{t('None')}</span>
            ) : (
              <ul className="plain-list">
                {guests.map((g) => (
                  <li key={g.email}>
                    {g.name} <span className="muted">({g.email})</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="answers-heading">
        <h2 id="answers-heading">{t('Answers')}</h2>
        {answerIds.length === 0 ? (
          <p className="muted">{t('No answers to extra questions.')}</p>
        ) : (
          <dl className="details details-stacked">
            {answerIds.map((qid) => (
              <div key={qid} className="detail-pair">
                <dt>{labels.get(qid) ?? qid}</dt>
                <dd className="multiline">
                  {(typeof booking.responses[qid] === 'boolean'
                    ? t(booking.responses[qid] ? 'Yes' : 'No')
                    : answerText(booking.responses[qid])) ?? (
                    <span className="muted">{t('No answer')}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {!cancelled && !started && <RescheduleBooking booking={booking} timeZone={timeZone} />}

      {!cancelled && !started && (
        <CancelBooking
          booking={booking}
          onCancelled={(updated) => {
            setBooking(updated)
            setStatus('The booking is cancelled.')
            statusRef.current?.focus()
          }}
          onAlreadyCancelled={(message) => {
            setStatus(message)
            statusRef.current?.focus()
          }}
        />
      )}
    </>
  )
}

/** The host cancels, with an optional reason the invitee is told. */
function CancelBooking({
  booking,
  onCancelled,
  onAlreadyCancelled,
}: {
  booking: Booking
  onCancelled: (booking: Booking) => void
  onAlreadyCancelled: (message: string) => void
}) {
  const { t, ui } = useI18n()

  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<UiText | undefined>()
  const [error, setError] = useState<UiText | null>(null)
  const [busy, setBusy] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const formId = useId()
  useUnsavedChanges(open && reason.trim() !== '')

  function close() {
    setOpen(false)
    setReason('')
    setReasonError(undefined)
    setError(null)
    // Back to the button that opened the form.
    setTimeout(() => openButton.current?.focus())
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const text = reason.trim()
    if (text.length > BOOKING.cancelReasonMaxLength) {
      setReasonError(
        msg('Use at most {0} characters (now {1}).', {
          '0': BOOKING.cancelReasonMaxLength,
          '1': text.length,
        }),
      )
      document.getElementById('cancel-reason')?.focus()
      return
    }
    if (!isMultiLineText(text)) {
      setReasonError('Remove special control characters (tabs and line breaks are fine).')
      document.getElementById('cancel-reason')?.focus()
      return
    }
    setReasonError(undefined)
    setBusy(true)
    try {
      const updated = await unwrap(
        api.POST('/api/v1/bookings/{id}/cancel', {
          params: { path: { id: booking.id } },
          body: text ? { reason: text } : {},
        }),
      )
      setReason('')
      onCancelled(updated)
      return
    } catch (err) {
      if (err instanceof RequestError && err.code === 'invalid_reason') {
        setReasonError(
          'Use at most 1000 characters, without control characters other than tabs and line breaks.',
        )
        document.getElementById('cancel-reason')?.focus()
      } else if (err instanceof RequestError && err.code === 'booking_cancelled') {
        setReason('')
        onAlreadyCancelled('This booking was already cancelled. Reload to see the details.')
      } else if (err instanceof RequestError && err.code === 'booking_in_past') {
        setError('This booking has already started, so it can no longer be cancelled.')
      } else {
        setError(msg('Could not cancel the booking. {0}', { '0': errorMessage(err) }))
      }
    }
    setBusy(false)
  }

  return (
    <section className="panel panel-danger" aria-labelledby="cancel-heading">
      <h2 id="cancel-heading">{t('Cancel this booking')}</h2>
      {!open ? (
        <>
          <p>
            {t(
              'The time becomes free again. The invitee can see that it is cancelled, and why if you give a reason, with their booking.',
            )}
          </p>
          <button
            ref={openButton}
            type="button"
            className="button"
            onClick={() => {
              setOpen(true)
              setTimeout(() => document.getElementById('cancel-reason')?.focus())
            }}
            aria-controls={formId}
            aria-expanded={false}
          >
            {t('Cancel booking…')}
          </button>
        </>
      ) : (
        <form id={formId} onSubmit={submit} noValidate className="stack">
          <Field
            id="cancel-reason"
            label={t('Reason')}
            optional
            error={reasonError}
            hint={t('The invitee can see it. Up to {0} characters.', {
              '0': BOOKING.cancelReasonMaxLength,
            })}
          >
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          {error && (
            <p className="alert alert-error" role="alert">
              {ui(error)}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="button button-danger" disabled={busy}>
              {busy ? t('Cancelling…') : t('Cancel booking')}
            </button>
            <button type="button" className="button" onClick={close} disabled={busy}>
              {t('Keep booking')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
