import { interfaceLanguage } from '@hourmere/core/language'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router'
import { ConferenceNotice } from '../components/ConferenceNotice.tsx'
import { EmailDeliveryHint } from '../components/EmailDeliveryHint.tsx'
import { TimeZoneName } from '../components/TimeZonePicker.tsx'
import { isKnownTimeZone } from '../format.ts'
import { usePageTitle } from '../hooks.ts'
import { formatDuration } from '../i18n/duration.ts'
import { formatList } from '../i18n/formatting.ts'
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
import { EventDescription } from './EventDescription.tsx'
import { notifyEmbedBooked, useEmbedded } from './embed-context.ts'
import { now as currentTime, detectTimeZone, preferredLocale } from './env.ts'
import {
  CreateBookingLink,
  FocusHeading,
  PublicLayout,
  PublicNotFound,
  PublicStatus,
} from './PublicLayout.tsx'
import { normalizedHandle, normalizedSlug, teamSlug, useRequest } from './paths.ts'
import { SlotPicker, type SlotPickerPosition } from './SlotPicker.tsx'
import { formatDate, formatTime, formatTimeRange, offsetAt, offsetLabel, zoneName } from './time.ts'
import {
  bookingErrors,
  bookingLocale,
  type FieldErrors,
  guestsFor,
  responsesFor,
} from './validation.ts'
import { rememberVisitorTimeZone, visitorTimeZone } from './visitor-time-zone.ts'

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
  const { t, ui, locale: displayLocale, explicit, formatLocale } = useI18n()

  const embedded = useEmbedded()
  const browserFormatLocale = useMemo(preferredLocale, [])
  const locale = formatLocale ?? browserFormatLocale
  const [timeZone, setTimeZone] = useState(() => visitorTimeZone(detectTimeZone()))
  const [now, setNow] = useState(currentTime)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [pickerPosition, setPickerPosition] = useState<SlotPickerPosition | null>(null)
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<UiText | null>(null)
  const [backToPicker, setBackToPicker] = useState(false)
  const [values, setValues] = useState<BookingFormValues>(EMPTY_FORM)
  const [serverErrors, setServerErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null)
  const [gone, setGone] = useState(false)
  // One Idempotency-Key per booking attempt: resending the same request (after a network
  // error or a lost answer) reuses it, so the server answers with the booking it may already
  // have made instead of booking twice. Language changes preserve that attempt; changing
  // booking details starts a new attempt in the interface language selected at submission.
  const attempt = useRef<{ key: string; details: string; body: CreateBooking } | null>(null)
  const loadSlots = useMemo(() => eventSlots(handle, slug, team), [handle, slug, team])

  if (gone) return <PublicNotFound what="event" />
  if (confirmed) return <Confirmation event={event} confirmed={confirmed} locale={locale} />

  function pick(chosen: Slot) {
    // A different time starts a new intent, even if they later return to the old time.
    if (attempt.current && attempt.current.body.start !== chosen.start) attempt.current = null
    setSlot(chosen)
    setNotice(null)
    setFormError(null)
  }

  function changeTime() {
    if (inFlight.current) return
    setSlot(null)
    setNow(currentTime())
    setBackToPicker(true)
  }

  async function submit() {
    if (!slot || inFlight.current) return
    const guests = guestsFor(values.guests)
    const body: CreateBooking = {
      ...(embedded && { source: 'embed' as const }),
      start: slot.start,
      invitee: {
        name: values.name.trim(),
        email: values.email.trim(),
        timeZone,
      },
      ...(guests.length > 0 && { guests }),
      ...(event.questions.length > 0 && {
        responses: responsesFor(event.questions, values.answers),
      }),
    }
    const details = JSON.stringify(body)
    if (attempt.current?.details !== details) {
      const inviteeLocale = bookingLocale(
        explicit ??
          (interfaceLanguage(browserFormatLocale) === displayLocale
            ? browserFormatLocale
            : displayLocale),
      )
      if (inviteeLocale) body.invitee.locale = inviteeLocale
      attempt.current = { key: randomKey(), details, body }
    }
    inFlight.current = true
    setSubmitting(true)
    setFormError(null)
    setServerErrors({})
    try {
      const { result, replayed } = await createBooking(
        handle,
        slug,
        attempt.current.body,
        attempt.current.key,
        team,
      )
      setConfirmed({ ...result, replayed, timeZone })
    } catch (err) {
      const code = codeOf(err)
      if (!(err instanceof PublicRequestError)) {
        // Offline, or the answer was lost: the same request will reuse the same key.
        setFormError(msg('{0} Your booking is not confirmed yet.', { '0': failureMessage(err) }))
      } else if (
        code === 'slot_taken' ||
        code === 'slot_unavailable' ||
        code === 'booking_changed'
      ) {
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
        const mapped = bookingErrors(err, event.questions, values.guests)
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
      inFlight.current = false
      setSubmitting(false)
    }
  }

  // Keep the breakable space and opening bracket outside the no-wrap numeric offset.
  const chosenOffset = slot ? offsetLabel(timeZone, Date.parse(slot.start)) : ''
  const chosenZoneLabel = t(' ({offset})', { offset: chosenOffset })
  const chosenOffsetAt = chosenZoneLabel.lastIndexOf(chosenOffset)
  const hostTimeZone =
    event.schedulingType !== 'round_robin' && !event.hosts ? event.host.timeZone : undefined

  return (
    <PublicLayout wide>
      <div className="booking-layout">
        <aside className="event-info" aria-label={t('About this event')}>
          <p className="event-host">{event.team?.name ?? event.host.name}</p>
          <h1 className="event-title">{event.title}</h1>
          {event.schedulingType === 'round_robin' && (
            <p className="event-description">
              {t('An available team member will be assigned when you book.')}
            </p>
          )}
          {event.hosts && (
            <p className="event-description">
              {t('Required hosts: {hosts}', {
                hosts: formatList(
                  event.hosts.map((host) =>
                    t('{name} ({detail})', { name: host.name, detail: zoneName(host.timeZone) }),
                  ),
                  displayLocale,
                ),
              })}
            </p>
          )}
          <ul className="event-facts">
            <li>{formatDuration(event.durationMinutes, displayLocale)}</li>
            {event.location && <li>{ui(locationLabel(event.location.kind))}</li>}
            {hostTimeZone && (
              <li className="user-content">
                <TimeZoneName
                  className="host-time-zone"
                  name={zoneName(hostTimeZone)}
                  label={t("Host's time zone: {zone}", { zone: zoneName(hostTimeZone) })}
                />
              </li>
            )}
          </ul>
          {event.description && <EventDescription>{event.description}</EventDescription>}
          {slot && (
            <div className="chosen-time">
              <p>
                <strong>{formatDate(Date.parse(slot.start), timeZone, locale)}</strong>
                <br />
                {formatTimeRange(Date.parse(slot.start), Date.parse(slot.end), timeZone, locale)}
                <br />
                <span className="muted">
                  {zoneName(timeZone)}
                  {chosenZoneLabel.slice(0, chosenOffsetAt)}
                  <span className="time-offset">{chosenZoneLabel.slice(chosenOffsetAt)}</span>
                </span>
              </p>
              {hostTimeZone &&
                isKnownTimeZone(hostTimeZone) &&
                offsetAt(Date.parse(slot.start), hostTimeZone) !==
                  offsetAt(Date.parse(slot.start), timeZone) && (
                  <p className="host-local-time user-content">
                    {t("That's {time} for the host", {
                      time: t('{date}, {time}', {
                        date: formatDate(Date.parse(slot.start), hostTimeZone, locale),
                        time: formatTime(Date.parse(slot.start), hostTimeZone, locale),
                      }),
                    })}
                  </p>
                )}
              <button
                type="button"
                className="button button-small"
                onClick={changeTime}
                disabled={submitting}
              >
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
                formError={formError}
                submitting={submitting}
                onSubmit={submit}
              />
            </section>
          ) : (
            <SlotPicker
              load={loadSlots}
              durationMinutes={event.durationMinutes}
              timeZone={timeZone}
              onTimeZoneChange={(zone) => {
                rememberVisitorTimeZone(zone)
                setTimeZone(zone)
              }}
              locale={locale}
              now={now}
              selected={slot}
              initialPosition={pickerPosition}
              onPositionChange={setPickerPosition}
              onSelect={pick}
              version={version}
              focusTitle={backToPicker}
              notice={notice}
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
  const { t, text, ui, locale: language } = useI18n()

  usePageTitle('Booking confirmed')
  const embedded = useEmbedded()
  const notified = useRef(false)
  useEffect(() => {
    if (embedded && !notified.current) {
      notified.current = true
      notifyEmbedBooked()
    }
  }, [embedded])
  const { booking: initialBooking, manageToken, replayed, timeZone } = confirmed
  const [booking, setBooking] = useState(initialBooking)
  const ended = Date.parse(booking.end) <= currentTime()
  const canCancel = booking.status === 'confirmed' && Date.parse(booking.start) > currentTime()
  const invitee = booking.attendees.find((a) => a.isBooker)
  const guests = booking.attendees.filter((a) => !a.isBooker)
  const hostName =
    booking.assignedHost === null
      ? t('Host no longer available')
      : booking.assignedHost
        ? booking.assignedHost.name.trim() || t('Host')
        : event.host.name
  const hostDetail = booking.assignedHost
    ? t('{name} ({detail})', {
        name: hostName,
        detail: zoneName(booking.assignedHost.timeZone),
      })
    : hostName
  const title = t('{event} with {host}', { event: event.title, host: hostName })
  return (
    <PublicLayout>
      <div className="card public-card confirmation">
        {booking.status === 'confirmed' && !ended && booking.conference?.status !== 'failed' && (
          <span className="confirmation-indicator" aria-hidden="true">
            ✓
          </span>
        )}
        <FocusHeading>
          {t(
            booking.status === 'cancelled'
              ? 'Cancelled booking'
              : ended
                ? 'Ended'
                : booking.conference?.status === 'failed'
                  ? 'Time reserved; meeting link needs attention'
                  : booking.conference?.status === 'pending'
                    ? 'Time reserved; meeting link pending'
                    : 'You’re booked',
          )}
        </FocusHeading>
        <p className="lede">
          {text(
            booking.status === 'cancelled'
              ? 'This booking was already cancelled.'
              : ended
                ? 'This meeting has ended.'
                : 'Your {event} with {host} is confirmed.',
            {
              event: event.title,
              host: hostName,
            },
          )}
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
          ]}
        />
        <ConferenceNotice
          key={booking.id}
          booking={booking}
          manageToken={manageToken}
          onChange={setBooking}
        />
        {booking.status === 'confirmed' &&
          (!booking.conference || booking.conference.status === 'ready') && (
            <AddToCalendar
              event={{
                id: booking.id,
                title,
                start: Date.parse(booking.start),
                end: Date.parse(booking.end),
                description: event.description ?? undefined,
                location: locationText(booking.location, ui, t(': ')),
              }}
            />
          )}
        <div className="confirmation-secondary stack">
          <DetailList
            items={[
              ['Host', hostDetail],
              ...(invitee
                ? ([
                    ['You', t('{name} ({detail})', { name: invitee.name, detail: invitee.email })],
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
            ]}
          />
          {manageToken && (
            <ManageLink token={manageToken} intro={t('Use this link to reschedule or cancel.')} />
          )}
          {(canCancel || (!manageToken && replayed)) && (
            <div className="alert alert-info">
              {!manageToken && replayed && (
                <p>
                  {t(
                    canCancel
                      ? 'This booking was already made by an earlier attempt, so its link can’t be shown again.'
                      : 'This booking was already made by an earlier attempt, so its link to change or cancel can’t be shown again. Use the link in your confirmation email instead.',
                  )}
                </p>
              )}
              {canCancel && (
                <p>
                  {text(
                    manageToken
                      ? 'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.'
                      : 'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use the booking link in your Hourmere confirmation email.',
                  )}
                </p>
              )}
              {manageToken && (
                <Link
                  className="button button-small"
                  to={`/booking#token=${encodeURIComponent(manageToken)}&action=cancel`}
                  target={embedded ? '_blank' : undefined}
                  rel={embedded ? 'noopener noreferrer' : undefined}
                >
                  {t('Cancel booking')}
                </Link>
              )}
            </div>
          )}
          {booking.status === 'confirmed' &&
            (!booking.conference || booking.conference.status === 'ready') && <EmailDeliveryHint />}
        </div>
        <CreateBookingLink />
      </div>
    </PublicLayout>
  )
}
