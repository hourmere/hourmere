import { interfaceLanguage } from '@hourmere/core/language'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmailDeliveryHint } from '../components/EmailDeliveryHint.tsx'
import { usePageTitle } from '../hooks.ts'
import { formatDuration } from '../i18n/duration.ts'
import { MemoryLanguage, useI18n } from '../i18n/runtime.tsx'
import { literal, msg, type UiText } from '../i18n/translate.ts'
import { ManageLink } from './AddToCalendar.tsx'
import {
  codeOf,
  createRoutedBooking,
  failureMessage,
  PublicRequestError,
  type RoutedBookingInput,
  type RoutedBookingResult,
  type RoutingContinuation,
  randomKey,
  resolveRoutingContinuation,
  routingContinuationSlots,
  type Slot,
} from './api.ts'
import { DetailList, LocationDetails, locationLabel, When } from './BookingDetails.tsx'
import { BookingForm, type BookingFormValues, selectedLocation } from './BookingForm.tsx'
import { EventDescription } from './EventDescription.tsx'
import { now as currentTime, detectTimeZone, preferredLocale } from './env.ts'
import { FocusHeading, HostAvatar, PublicLayout, PublicStatus } from './PublicLayout.tsx'
import { useRequest } from './paths.ts'
import { SlotPicker, type SlotPickerPosition } from './SlotPicker.tsx'
import { zoneName } from './time.ts'
import {
  bookingErrors,
  bookingLocale,
  type FieldErrors,
  guestsFor,
  responsesFor,
} from './validation.ts'

function unavailable(error: unknown) {
  const code = codeOf(error)
  return code === 'routing_unavailable' || code === 'routing_forms_disabled'
}

function invalidatedSelection(error: unknown) {
  const code = codeOf(error)
  return code === 'invalid_duration' || code === 'invalid_location_choice'
}

function Unavailable() {
  const { t } = useI18n()
  usePageTitle('This booking link is unavailable')
  return (
    <PublicLayout>
      <div className="card public-card">
        <FocusHeading>{t('This booking link is unavailable')}</FocusHeading>
        <p>{t('Open the original form to request a new booking link.')}</p>
      </div>
    </PublicLayout>
  )
}

export function RoutingContinuationPage({ routeToken }: { routeToken: string | null }) {
  return (
    <MemoryLanguage>
      {routeToken ? <ResolvedPage routeToken={routeToken} /> : <Unavailable />}
    </MemoryLanguage>
  )
}

function ResolvedPage({ routeToken }: { routeToken: string }) {
  const { t, uiText } = useI18n()
  const resolve = useCallback(
    (signal: AbortSignal) => resolveRoutingContinuation(routeToken, signal),
    [routeToken],
  )
  const [state, retry] = useRequest(resolve)
  usePageTitle(state.status === 'ready' ? literal(state.data.eventType.title) : 'Booking')

  if (state.status === 'ready')
    return <ContinuationBooking routeToken={routeToken} continuation={state.data} />
  if (state.status === 'error' && unavailable(state.error)) return <Unavailable />
  return (
    <PublicLayout wide={state.status === 'loading'}>
      {state.status === 'loading' ? (
        <PublicStatus>{t('Loading…')}</PublicStatus>
      ) : (
        <div className="card public-card">
          <p role="alert">{uiText(failureMessage(state.error))}</p>
          <button type="button" className="button" onClick={retry}>
            {t('Try again')}
          </button>
        </div>
      )}
    </PublicLayout>
  )
}

function ContinuationBooking({
  routeToken,
  continuation: { eventType: event, prefill },
}: {
  routeToken: string
  continuation: RoutingContinuation
}) {
  const { t, ui, locale: language, explicit, formatLocale } = useI18n()
  const browserLocale = useMemo(preferredLocale, [])
  const locale = formatLocale ?? browserLocale
  const [timeZone, setTimeZone] = useState(detectTimeZone)
  const [now, setNow] = useState(currentTime)
  const [durationMinutes, setDurationMinutes] = useState(event.durationMinutes)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [pickerPosition, setPickerPosition] = useState<SlotPickerPosition | null>(null)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState<UiText | null>(null)
  const [values, setValues] = useState<BookingFormValues>(() => ({
    name: prefill.inviteeName ?? '',
    email: prefill.inviteeEmail ?? '',
    answers: prefill.responses,
    guests: [],
  }))
  const [serverErrors, setServerErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [gone, setGone] = useState(false)
  const [confirmed, setConfirmed] = useState<
    (RoutedBookingResult & { replayed: boolean; timeZone: string }) | null
  >(null)
  const request = useRef<AbortController | null>(null)
  const attempt = useRef<{ key: string; details: string; body: RoutedBookingInput } | null>(null)
  const chosenLocation = selectedLocation(event.locations ?? [], values.locationOptionId)
  const locationOptionId = chosenLocation?.id

  const load = useMemo(() => {
    const loadSlots = routingContinuationSlots(routeToken, durationMinutes, locationOptionId)
    return async (start: string, end: string, signal: AbortSignal) => {
      try {
        return await loadSlots(start, end, signal)
      } catch (error) {
        if (!signal.aborted && (unavailable(error) || invalidatedSelection(error))) setGone(true)
        throw error
      }
    }
  }, [routeToken, durationMinutes, locationOptionId])

  useEffect(() => () => request.current?.abort(), [])

  function changeTime(message: UiText | null = null) {
    setSlot(null)
    setNotice(message)
    setNow(currentTime())
  }

  function changeDetails(next: BookingFormValues) {
    if (request.current) return
    if (selectedLocation(event.locations ?? [], next.locationOptionId)?.id !== locationOptionId) {
      attempt.current = null
      setRevision((value) => value + 1)
      changeTime()
    }
    setValues(next)
    setServerErrors({})
    setFormError(null)
  }

  async function submit() {
    if (!slot || request.current) return
    const guests = guestsFor(values.guests)
    const body: RoutedBookingInput = {
      routeToken,
      start: slot.start,
      durationMinutes,
      ...(locationOptionId && { locationOptionId }),
      ...((chosenLocation?.askInvitee || values.smsConsent) && {
        inviteePhone: values.inviteePhone?.replace(/[ ().-]/g, ''),
        smsConsent: values.smsConsent ?? false,
      }),
      invitee: { name: values.name.trim(), email: values.email.trim(), timeZone },
      ...(guests.length > 0 && { guests }),
      ...(event.questions.length > 0 && {
        responses: responsesFor(event.questions, values.answers),
      }),
    }
    // An unchanged retry with a lost response can replay a committed booking after expiry.
    const details = JSON.stringify(body)
    if (attempt.current?.details !== details) {
      const inviteeLocale = bookingLocale(
        explicit ?? (interfaceLanguage(browserLocale) === language ? browserLocale : language),
      )
      if (inviteeLocale) body.invitee.locale = inviteeLocale
      attempt.current = { key: randomKey(), details, body }
    }
    const active = new AbortController()
    request.current = active
    setSubmitting(true)
    setFormError(null)
    setServerErrors({})
    try {
      const { result, replayed } = await createRoutedBooking(
        attempt.current.body,
        attempt.current.key,
        active.signal,
      )
      if (!active.signal.aborted) {
        setConfirmed({
          booking: result.booking,
          manageToken: result.manageToken,
          replayed,
          timeZone,
        })
        attempt.current = null
      }
    } catch (error) {
      if (active.signal.aborted) return
      const code = codeOf(error)
      if (unavailable(error) || invalidatedSelection(error) || code === 'invalid_responses') {
        setGone(true)
      } else if (
        code === 'slot_taken' ||
        code === 'slot_unavailable' ||
        code === 'booking_changed'
      ) {
        attempt.current = null
        changeTime(
          code === 'slot_taken'
            ? 'Someone else just booked that time. Please pick another one.'
            : 'That time is no longer available. Please pick another one.',
        )
      } else if (code === 'idempotency_key_reused') {
        attempt.current = null
        setFormError('Something went wrong with this attempt. Please try again.')
      } else if (!(error instanceof PublicRequestError)) {
        setFormError(msg('{0} Your booking is not confirmed yet.', { '0': failureMessage(error) }))
      } else if (error.status === 429 || error.status >= 500) {
        setFormError(failureMessage(error))
      } else {
        const mapped = bookingErrors(error, event.questions, values.guests)
        const { timeZone: zoneError, ...fields } = mapped.fields
        setServerErrors(fields)
        setFormError(
          zoneError
            ? msg(
                'Your time zone ({0}) was not accepted. Change the time, pick another time zone and try again.',
                { '0': zoneName(timeZone) },
              )
            : typeof mapped.form === 'object' && mapped.form && 'literal' in mapped.form
              ? failureMessage(error)
              : (mapped.form ?? 'Check the highlighted fields.'),
        )
      }
    } finally {
      if (!active.signal.aborted) {
        request.current = null
        setSubmitting(false)
      }
    }
  }

  if (gone) return <Unavailable />
  if (confirmed) return <ContinuationConfirmation result={confirmed} locale={locale} />

  return (
    <PublicLayout wide>
      <div className="booking-layout">
        <aside className="event-info" aria-label={t('About this event')}>
          <h1 className="event-title">{event.title}</h1>
          {event.host && (
            <div className="host-identity">
              <HostAvatar name={event.host.name} image={event.host.image} />
              <p className="event-host">{event.host.name}</p>
            </div>
          )}
          <ul className="event-facts">
            <li>{formatDuration(durationMinutes, language)}</li>
            {chosenLocation ? (
              <li>{chosenLocation.label ?? ui(locationLabel(chosenLocation.kind))}</li>
            ) : event.location ? (
              <li>{ui(locationLabel(event.location.kind))}</li>
            ) : null}
          </ul>
          {event.description && <EventDescription>{event.description}</EventDescription>}
          {slot && (
            <div className="chosen-time">
              <p>
                <When {...slot} timeZone={timeZone} locale={locale} />
              </p>
              <button
                type="button"
                className="button button-small"
                onClick={() => changeTime()}
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
              {(prefill.inviteeName ||
                prefill.inviteeEmail ||
                Object.keys(prefill.responses).length > 0) && (
                <p className="hint">
                  {t('These details were filled in for convenience. You can change them.')}
                </p>
              )}
              <BookingForm
                privateDetails
                locations={event.locations}
                smsRemindersEnabled={event.smsRemindersEnabled}
                allowGuests={event.allowGuests}
                questions={event.questions}
                values={values}
                onChange={changeDetails}
                serverErrors={serverErrors}
                formError={formError}
                submitting={submitting}
                onSubmit={submit}
              />
            </section>
          ) : (
            <SlotPicker
              load={load}
              durationMinutes={durationMinutes}
              timeZone={timeZone}
              onTimeZoneChange={setTimeZone}
              locale={locale}
              now={now}
              selected={null}
              initialPosition={pickerPosition}
              onPositionChange={setPickerPosition}
              onSelect={(next) => {
                if (attempt.current && attempt.current.body.start !== next.start)
                  attempt.current = null
                setSlot(next)
                setNotice(null)
                setFormError(null)
                setServerErrors({})
              }}
              version={revision}
              focusTitle
              notice={notice}
              afterTitle={
                <>
                  {event.locations && event.locations.length > 1 && (
                    <fieldset className="duration-picker">
                      <legend>{t('Meeting location')}</legend>
                      <div className="duration-options">
                        {event.locations.map((option) => (
                          <label key={option.id} className="duration-option">
                            <input
                              type="radio"
                              name="slotLocation"
                              value={option.id}
                              checked={locationOptionId === option.id}
                              onChange={() =>
                                changeDetails({
                                  ...values,
                                  locationOptionId: option.id,
                                  inviteePhone: '',
                                })
                              }
                            />
                            <span>{option.label ?? ui(locationLabel(option.kind))}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  {event.allowedDurationsMinutes && event.allowedDurationsMinutes.length > 1 && (
                    <fieldset className="duration-picker">
                      <legend>{t('Meeting length')}</legend>
                      <div className="duration-options">
                        {event.allowedDurationsMinutes.map((minutes) => (
                          <label key={minutes} className="duration-option">
                            <input
                              type="radio"
                              name="durationMinutes"
                              value={minutes}
                              checked={durationMinutes === minutes}
                              onChange={() => {
                                attempt.current = null
                                setDurationMinutes(minutes)
                                setNotice(null)
                              }}
                            />
                            <span>{formatDuration(minutes, language)}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                </>
              }
            />
          )}
        </div>
      </div>
    </PublicLayout>
  )
}

function ContinuationConfirmation({
  result: { booking, manageToken, replayed, timeZone },
  locale,
}: {
  result: RoutedBookingResult & { replayed: boolean; timeZone: string }
  locale: string
}) {
  const { t } = useI18n()
  const cancelled = booking.status === 'cancelled'
  const ended = Date.parse(booking.end) <= currentTime()
  const conference = booking.conference?.status
  usePageTitle(cancelled ? 'Cancelled booking' : ended ? 'Ended' : 'Booking confirmed')
  return (
    <PublicLayout>
      <div className="card public-card confirmation">
        {!cancelled && !ended && conference !== 'failed' && (
          <span className="confirmation-indicator" aria-hidden="true">
            ✓
          </span>
        )}
        <FocusHeading>
          {t(
            cancelled
              ? 'Cancelled booking'
              : ended
                ? 'Ended'
                : conference === 'failed'
                  ? 'Time reserved; meeting link needs attention'
                  : conference === 'pending'
                    ? 'Time reserved; meeting link pending'
                    : 'You’re booked',
          )}
        </FocusHeading>
        <DetailList
          items={[
            ['What', booking.title],
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
            ...(booking.assignedHost
              ? [['Host', booking.assignedHost.name] as [string, string]]
              : []),
          ]}
        />
        <div className="confirmation-secondary stack">
          {manageToken && (
            <ManageLink
              booking={booking}
              token={manageToken}
              intro={t('Use this link to reschedule or cancel.')}
            />
          )}
          {replayed && !manageToken && (
            <div className="alert alert-info">
              <p>
                {t(
                  'This booking was already made by an earlier attempt, so its link to change or cancel can’t be shown again. Use the link in your confirmation email instead.',
                )}
              </p>
            </div>
          )}
          {!cancelled && (!conference || conference === 'ready') && <EmailDeliveryHint />}
        </div>
      </div>
    </PublicLayout>
  )
}
