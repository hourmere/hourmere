import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useParams } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { literal, msg, type UiText } from '../i18n/translate.ts'
import { AddToCalendar, ManageLink } from './AddToCalendar.tsx'
import {
  type BookingWithToken,
  type CreateBooking,
  codeOf,
  createBooking,
  eventSlots,
  failureMessage,
  getEventType,
  type PublicEventType,
  PublicRequestError,
  randomKey,
  type Slot,
} from './api.ts'
import {
  DetailList,
  LocationDetails,
  locationLabel,
  locationText,
  When,
} from './BookingDetails.tsx'
import { BookingForm, type BookingFormValues } from './BookingForm.tsx'
import { notifyEmbedBooked, useEmbedded } from './embed-context.ts'
import { now as currentTime, detectTimeZone, preferredLocale } from './env.ts'
import { FocusHeading, PublicLayout, PublicNotFound, PublicStatus } from './PublicLayout.tsx'
import { normalizedHandle, normalizedSlug, teamSlug, useRequest } from './paths.ts'
import { SlotPicker } from './SlotPicker.tsx'
import { formatDate, formatDuration, formatTimeRange, offsetLabel, zoneName } from './time.ts'
import { bookingErrors, bookingLocale, type FieldErrors, responsesFor } from './validation.ts'

/** /{handle}/{slug}: pick a time, fill in the form, get the confirmation. */
export function TeamBookingPage() {
  return <BookingPage team />
}

export function BookingPage({ team = false }: { team?: boolean } = {}) {
  const params = useParams()
  const location = useLocation()
  const embedded = useEmbedded()
  const rawHandle = (team ? params.teamSlug : params.handle) ?? ''
  const rawSlug = params.slug ?? ''
  const handle = team ? teamSlug(rawHandle) : normalizedHandle(rawHandle)
  const slug = normalizedSlug(rawSlug)
  if (handle === undefined || slug === undefined) return <PublicNotFound what="event" />
  if (handle !== rawHandle || slug !== rawSlug)
    return (
      <Navigate
        to={`${embedded ? '/embed' : ''}${team ? '/team' : ''}/${handle}/${slug}${embedded ? location.search : ''}`}
        replace
      />
    )
  return (
    <BookingPageContent key={`${team}/${handle}/${slug}`} handle={handle} slug={slug} team={team} />
  )
}

function BookingPageContent({
  handle,
  slug,
  team,
}: {
  handle: string
  slug: string
  team: boolean
}) {
  const { t, ui } = useI18n()

  const load = useCallback(
    (signal: AbortSignal) => getEventType(handle, slug, signal, team),
    [handle, slug, team],
  )
  const [state, reload] = useRequest(load)
  usePageTitle(
    state.status === 'ready' ? literal(`${state.data.title} · ${state.data.host.name}`) : 'Booking',
  )

  if (state.status === 'loading') {
    return (
      <PublicLayout wide>
        <PublicStatus>{t('Loading…')}</PublicStatus>
      </PublicLayout>
    )
  }
  if (state.status === 'error') {
    if (codeOf(state.error) === 'event_type_not_found') return <PublicNotFound what="event" />
    return (
      <PublicLayout>
        <div className="card public-card">
          <p role="alert">{ui(failureMessage(state.error))}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </PublicLayout>
    )
  }
  return <BookingFlow event={state.data} handle={handle} slug={slug} team={team} />
}

const EMPTY_FORM: BookingFormValues = { name: '', email: '', guests: [], answers: {} }

interface Confirmed extends BookingWithToken {
  /** An earlier attempt made this booking; its manage token cannot be shown again. */
  replayed: boolean
  timeZone: string
}

function BookingFlow({
  event,
  handle,
  slug,
  team,
}: {
  event: PublicEventType
  handle: string
  slug: string
  team: boolean
}) {
  const { t, ui, locale: displayLocale, explicit } = useI18n()

  const embedded = useEmbedded()
  const browserFormatLocale = useMemo(preferredLocale, [])
  const locale = explicit ?? browserFormatLocale
  const [requestLocale] = useState(() => bookingLocale(explicit ?? preferredLocale()))
  const [timeZone, setTimeZone] = useState(detectTimeZone)
  const [now, setNow] = useState(currentTime)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<UiText | null>(null)
  const [backToPicker, setBackToPicker] = useState(false)
  const [values, setValues] = useState<BookingFormValues>(EMPTY_FORM)
  const [serverErrors, setServerErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null)
  const [gone, setGone] = useState(false)
  // One Idempotency-Key per booking attempt: resending the same request (after a network
  // error or a lost answer) reuses it, so the server answers with the booking it may already
  // have made instead of booking twice; any change to the request starts a new attempt.
  const attempt = useRef<{ key: string; body: string } | null>(null)
  const loadSlots = useMemo(() => eventSlots(handle, slug, team), [handle, slug, team])

  if (gone) return <PublicNotFound what="event" />
  if (confirmed) return <Confirmation event={event} confirmed={confirmed} locale={locale} />

  function pick(chosen: Slot) {
    setSlot(chosen)
    setNotice(null)
    setFormError(null)
  }

  function changeTime() {
    setSlot(null)
    setBackToPicker(true)
  }

  async function submit() {
    if (!slot) return
    const inviteeLocale = requestLocale
    const guests = values.guests.map((g) => ({ name: g.name.trim(), email: g.email.trim() }))
    const body: CreateBooking = {
      ...(embedded && { source: 'embed' as const }),
      start: slot.start,
      invitee: {
        name: values.name.trim(),
        email: values.email.trim(),
        timeZone,
        ...(inviteeLocale && { locale: inviteeLocale }),
      },
      ...(guests.length > 0 && { guests }),
      ...(event.questions.length > 0 && {
        responses: responsesFor(event.questions, values.answers),
      }),
    }
    const json = JSON.stringify(body)
    if (attempt.current?.body !== json) attempt.current = { key: randomKey(), body: json }
    setSubmitting(true)
    setFormError(null)
    setServerErrors({})
    try {
      const { result, replayed } = await createBooking(
        handle,
        slug,
        body,
        attempt.current.key,
        team,
      )
      setConfirmed({ ...result, replayed, timeZone })
    } catch (err) {
      const code = codeOf(err)
      if (!(err instanceof PublicRequestError)) {
        // Offline, or the answer was lost: the same request will reuse the same key.
        setFormError(msg('{0} Your booking is not confirmed yet.', { '0': failureMessage(err) }))
      } else if (code === 'slot_taken' || code === 'slot_unavailable') {
        attempt.current = null
        setSlot(null)
        setBackToPicker(true)
        setNotice(
          code === 'slot_taken'
            ? 'Someone else just booked that time. Please pick another one.'
            : 'That time is no longer available. Please pick another one.',
        )
        setNow(currentTime())
        setVersion((v) => v + 1)
      } else if (code === 'event_type_not_found') {
        setGone(true)
      } else if (code === 'idempotency_key_reused') {
        attempt.current = null
        setFormError('Something went wrong with this attempt. Please try again.')
      } else if (err.status === 429 || err.status >= 500) {
        setFormError(failureMessage(err))
      } else {
        const mapped = bookingErrors(err, event.questions)
        const { timeZone: zoneError, ...fields } = mapped.fields
        setServerErrors(fields)
        setFormError(
          zoneError
            ? msg(
                'Your time zone ({0}) was not accepted. Change the time, pick another time zone and try again.',
                { '0': zoneName(timeZone) },
              )
            : (mapped.form ??
                (Object.keys(fields).length ? 'Check the highlighted fields.' : null)),
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PublicLayout wide>
      <div className="booking-layout">
        <aside className="event-info" aria-label={t('About this event')}>
          <p className="event-host">{event.team?.name ?? event.host.name}</p>
          <h1 className="event-title">{event.title}</h1>
          <ul className="event-facts">
            <li>{formatDuration(event.durationMinutes, displayLocale)}</li>
            {event.location && <li>{ui(locationLabel(event.location.kind))}</li>}
          </ul>
          {event.description && <p className="event-description">{event.description}</p>}
          {slot && (
            <div className="chosen-time">
              <p>
                <strong>{formatDate(Date.parse(slot.start), timeZone, locale)}</strong>
                <br />
                {formatTimeRange(Date.parse(slot.start), Date.parse(slot.end), timeZone, locale)}
                <br />
                <span className="muted">
                  {zoneName(timeZone)} ({offsetLabel(timeZone, Date.parse(slot.start))})
                </span>
              </p>
              <button type="button" className="button button-small" onClick={changeTime}>
                {t('Change time')}
              </button>
            </div>
          )}
        </aside>
        <div className="booking-main">
          {slot ? (
            <section className="details-step" aria-labelledby="details-heading">
              <FocusHeading level={2} id="details-heading" className="step-title">
                {t('Your details')}
              </FocusHeading>
              <BookingForm
                allowGuests={event.allowGuests}
                questions={event.questions}
                values={values}
                onChange={(next) => {
                  setValues(next)
                  setServerErrors({})
                }}
                serverErrors={serverErrors}
                formError={ui(formError)}
                submitting={submitting}
                onSubmit={submit}
              />
            </section>
          ) : (
            <SlotPicker
              load={loadSlots}
              durationMinutes={event.durationMinutes}
              timeZone={timeZone}
              onTimeZoneChange={setTimeZone}
              locale={locale}
              now={now}
              selected={slot}
              onSelect={pick}
              version={version}
              focusTitle={backToPicker}
              notice={ui(notice)}
            />
          )}
        </div>
      </div>
    </PublicLayout>
  )
}

function Confirmation({
  event,
  confirmed,
  locale,
}: {
  event: PublicEventType
  confirmed: Confirmed
  locale: string
}) {
  const { t, ui } = useI18n()

  usePageTitle('Booking confirmed')
  const embedded = useEmbedded()
  const notified = useRef(false)
  useEffect(() => {
    if (embedded && !notified.current) {
      notified.current = true
      notifyEmbedBooked()
    }
  }, [embedded])
  const { booking, manageToken, replayed, timeZone } = confirmed
  const invitee = booking.attendees.find((a) => a.isBooker)
  const guests = booking.attendees.filter((a) => !a.isBooker)
  const title = t('{event} with {host}', { event: event.title, host: event.host.name })
  return (
    <PublicLayout>
      <div className="card public-card confirmation">
        <FocusHeading>{t('You’re booked')}</FocusHeading>
        <p className="lede">
          {t('Your {event} with {host} is confirmed.', {
            event: event.title,
            host: event.host.name,
          })}
        </p>
        <DetailList
          items={[
            ['What', event.title],
            [
              'When',
              <When
                key="when"
                start={booking.start}
                end={booking.end}
                timeZone={timeZone}
                locale={locale}
              />,
            ],
            ['Where', <LocationDetails key="where" location={booking.location} />],
            ['Host', event.host.name],
            ...(invitee
              ? ([['You', `${invitee.name} (${invitee.email})`]] as [string, string][])
              : []),
            ...(guests.length
              ? ([['Guests', guests.map((g) => g.name).join(', ')]] as [string, string][])
              : []),
          ]}
        />
        <AddToCalendar
          event={{
            id: booking.id,
            title,
            start: Date.parse(booking.start),
            end: Date.parse(booking.end),
            description: event.description ?? undefined,
            location: locationText(booking.location, ui),
          }}
        />
        {manageToken ? (
          <ManageLink token={manageToken} intro={t('Use this link to reschedule or cancel.')} />
        ) : replayed ? (
          <div className="alert alert-info">
            <p>
              {t(
                'This booking was already made by an earlier attempt, so its link to change or cancel can’t be shown again. Use the link in your confirmation email instead.',
              )}
            </p>
          </div>
        ) : null}
      </div>
    </PublicLayout>
  )
}
