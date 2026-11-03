import { interfaceLanguage } from '@hourmere/core/language'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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
  type CreateBooking,
  codeOf,
  createBooking,
  createOneTimeLinkBooking,
  eventSlots,
  failureMessage,
  getEventType,
  getOneTimeBookingPage,
  type OneTimeBookingPage as OneTimeBookingPageData,
  oneTimeLinkSlots,
  type PublicBookingResult,
  type PublicEventType,
  PublicRequestError,
  randomKey,
  type Slot,
  type SlotLoader,
} from './api.ts'
import {
  DetailList,
  LocationDetails,
  locationLabel,
  locationText,
  When,
} from './BookingDetails.tsx'
import { BookingForm, type BookingFormValues } from './BookingForm.tsx'
import { monthOf } from './calendar.ts'
import { EventDescription } from './EventDescription.tsx'
import {
  embedParentRedirectAllowed,
  notifyEmbedBooked,
  notifyEmbedReady,
  useEmbedded,
} from './embed-context.ts'
import { now as currentTime, detectTimeZone, preferredLocale } from './env.ts'
import {
  CreateBookingLink,
  FocusHeading,
  HostAvatar,
  PublicLayout,
  PublicNotFound,
  PublicStatus,
} from './PublicLayout.tsx'
import {
  normalizedHandle,
  normalizedSlug,
  type RequestState,
  teamSlug,
  useRequest,
} from './paths.ts'
import { SlotPicker, type SlotPickerPosition } from './SlotPicker.tsx'
import { parseSlotLink, type SlotIntent } from './slot-link.ts'
import {
  dateKeyIn,
  formatDate,
  formatTime,
  formatTimeRange,
  offsetAt,
  offsetLabel,
  zoneName,
} from './time.ts'
import {
  bookingErrors,
  bookingLocale,
  type FieldErrors,
  guestsFor,
  responsesFor,
} from './validation.ts'
import { rememberVisitorTimeZone, visitorTimeZone } from './visitor-time-zone.ts'
import {
  loadWaitlistSuggestion,
  parseWaitlistLink,
  type WaitlistLink,
  waitlistPreviewActive,
} from './waitlist-link.ts'

/** /{handle}/{slug}: pick a time, fill in the form, get the confirmation. */
export function TeamBookingPage() {
  return <BookingPage team />
}

/** One-time capabilities stay in the path and are never accepted from query parameters. */
export function OneTimeBookingPage() {
  const { token } = useParams()
  const { pathname } = useLocation()
  if (
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    pathname.startsWith('/embed/') ||
    window.parent !== window
  )
    return <OneTimeLinkUnavailable />
  return <OneTimeBookingPageContent key={token} token={token} />
}

function OneTimeLinkUnavailable() {
  const { t } = useI18n()
  usePageTitle('This booking link is unavailable')
  return (
    <PublicLayout>
      <div className="card public-card">
        <FocusHeading>{t('This booking link is unavailable')}</FocusHeading>
        <p>{t('Contact the host for a new booking link.')}</p>
      </div>
    </PublicLayout>
  )
}

function OneTimeBookingPageContent({ token }: { token: string }) {
  const { t, ui } = useI18n()
  const load = useCallback((signal: AbortSignal) => getOneTimeBookingPage(token, signal), [token])
  const [state, reload] = useRequest(load)
  usePageTitle(
    state.status === 'ready'
      ? literal(`${state.data.eventType.title} · ${state.data.eventType.host.name}`)
      : 'Booking',
  )
  if (state.status === 'loading')
    return (
      <PublicLayout wide>
        <PublicStatus>{t('Loading…')}</PublicStatus>
      </PublicLayout>
    )
  if (state.status === 'error') {
    if (codeOf(state.error) === 'one_time_link_not_found') return <OneTimeLinkUnavailable />
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
  const { eventType, prefill } = state.data
  return <BookingFlow event={eventType} oneTimeToken={token} prefill={prefill} />
}

export function BookingPage({ team = false }: { team?: boolean } = {}) {
  const params = useParams()
  const location = useLocation()
  const embedded = useEmbedded()
  const rawHandle = (team ? params.teamSlug : params.handle) ?? ''
  const rawSlug = params.slug ?? ''
  const handle = team ? teamSlug(rawHandle) : normalizedHandle(rawHandle)
  const slug = normalizedSlug(rawSlug)
  const waitlist = useMemo(
    () => parseWaitlistLink(params.waitlistToken, params.suggestedStart, params.previewExpiresAt),
    [params.waitlistToken, params.suggestedStart, params.previewExpiresAt],
  )
  const directLink = useMemo(
    () =>
      !embedded && !params.waitlistToken && window.parent === window
        ? {
            identity: `${location.key}/${location.pathname}${location.search}`,
            intent: parseSlotLink(location.search, window.location.origin + location.pathname),
          }
        : undefined,
    [embedded, params.waitlistToken, location.key, location.pathname, location.search],
  )
  if (handle === undefined || slug === undefined) return <PublicNotFound what="event" />
  if (handle !== rawHandle || slug !== rawSlug)
    return (
      <Navigate
        to={`${embedded ? '/embed' : ''}${team ? '/team' : ''}/${handle}/${slug}${params.waitlistToken !== undefined ? `/waitlist/${encodeURIComponent(params.waitlistToken)}/${encodeURIComponent(params.suggestedStart ?? '')}/${encodeURIComponent(params.previewExpiresAt ?? '')}` : ''}${location.search}`}
        replace
      />
    )
  return (
    <BookingPageContent
      key={`${team}/${handle}/${slug}/${params.waitlistToken !== undefined ? `waitlist/${params.waitlistToken}/${params.suggestedStart}/${params.previewExpiresAt}` : 'ordinary'}`}
      handle={handle}
      slug={slug}
      team={team}
      waitlist={waitlist}
      directLink={directLink}
    />
  )
}

function BookingPageContent({
  handle,
  slug,
  team,
  waitlist,
  directLink,
}: {
  handle: string
  slug: string
  team: boolean
  waitlist?: WaitlistLink | undefined
  directLink?: DirectLink | undefined
}) {
  const { t, ui } = useI18n()

  const requestIdentity = directLink?.identity ?? ''
  const eventLoaded = useRef(false)
  const [retry, setRetry] = useState(0)
  const [initialRead, setInitialRead] = useState<
    RequestState<PublicEventType> & { identity: string }
  >({ status: 'loading', identity: requestIdentity })
  // Once the form exists, it owns refreshes and drafts. Before that point, a new
  // query must supersede even the very first metadata read (including its errors).
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly repeats an unsuccessful initial read
  useEffect(() => {
    if (eventLoaded.current) return
    const controller = new AbortController()
    setInitialRead({ status: 'loading', identity: requestIdentity })
    getEventType(handle, slug, controller.signal, team).then(
      (data) => {
        if (controller.signal.aborted) return
        eventLoaded.current = true
        setInitialRead({ status: 'ready', data, identity: requestIdentity })
      },
      (error) => {
        if (!controller.signal.aborted)
          setInitialRead({ status: 'error', error, identity: requestIdentity })
      },
    )
    return () => controller.abort()
  }, [handle, slug, team, requestIdentity, retry])
  const state =
    initialRead.status === 'ready' || initialRead.identity === requestIdentity
      ? initialRead
      : { status: 'loading' as const }
  const reload = () => setRetry((value) => value + 1)
  const embedded = useEmbedded()
  const allowEmbedParent = state.status === 'ready' && state.data.allowEmbedParentRedirect === true
  const loaded = state.status !== 'loading'
  useEffect(() => {
    if (embedded && loaded) notifyEmbedReady(allowEmbedParent)
  }, [embedded, loaded, allowEmbedParent])
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
          <p role={directLink && directLink.intent.status !== 'none' ? 'status' : 'alert'}>
            {ui(
              directLink && directLink.intent.status !== 'none'
                ? 'We could not check this time. Please try again.'
                : failureMessage(state.error),
            )}
          </p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </PublicLayout>
    )
  }
  return (
    <BookingFlow
      event={state.data}
      handle={handle}
      slug={slug}
      team={team}
      waitlist={waitlist}
      directLink={directLink}
    />
  )
}

const EMPTY_FORM: BookingFormValues = { name: '', email: '', guests: [], answers: {} }

interface Confirmed extends PublicBookingResult {
  /** An earlier attempt made this booking; its manage token cannot be shown again. */
  replayed: boolean
  timeZone: string
}

type BookingEvent = PublicEventType | OneTimeBookingPageData['eventType']
interface DirectLink {
  identity: string
  intent: SlotIntent
}
type BookingAddress =
  | { oneTimeToken: string; handle?: never; slug?: never; team?: never }
  | { oneTimeToken?: never; handle: string; slug: string; team: boolean }

function BookingFlow({
  event: initialEvent,
  handle = '',
  slug = '',
  team = !!initialEvent.team,
  oneTimeToken,
  prefill,
  waitlist,
  directLink,
}: {
  event: BookingEvent
  prefill?: { name: string | null; email: string | null }
  waitlist?: WaitlistLink | undefined
  directLink?: DirectLink | undefined
} & BookingAddress) {
  const { t, ui, locale: displayLocale, explicit, formatLocale } = useI18n()

  const embedded = useEmbedded()
  const browserFormatLocale = useMemo(preferredLocale, [])
  const locale = formatLocale ?? browserFormatLocale
  const [timeZone, setTimeZone] = useState(() => visitorTimeZone(detectTimeZone()))
  const [now, setNow] = useState(currentTime)
  const [event, setEvent] = useState(initialEvent)
  const [durationMinutes, setDurationMinutes] = useState(event.durationMinutes)
  const [durationRefresh, setDurationRefresh] = useState<
    { status: 'loading' } | { status: 'error'; message: UiText } | null
  >(null)
  const refreshController = useRef<AbortController | null>(null)
  useEffect(() => () => refreshController.current?.abort(), [])
  const hasDurationChoices = (event.allowedDurationsMinutes?.length ?? 0) > 1
  const [slot, setSlot] = useState<Slot | null>(null)
  const [pickerPosition, setPickerPosition] = useState<SlotPickerPosition | null>(null)
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<UiText | null>(null)
  const [backToPicker, setBackToPicker] = useState(false)
  const [values, setValues] = useState<BookingFormValues>(() => ({
    ...EMPTY_FORM,
    name: prefill?.name ?? '',
    email: prefill?.email ?? '',
  }))
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
  const directController = useRef<AbortController | null>(null)
  const [directState, setDirectState] = useState<{
    identity: string
    status: 'loading' | 'error' | 'selected' | 'done'
  }>({ identity: '', status: 'done' })
  const [directRetry, setDirectRetry] = useState(0)
  const directFlow = directLink !== undefined && directLink.intent.status !== 'none'
  // Hide the previous form synchronously on query navigation, before effects run.
  const directPending =
    !!directLink &&
    (directState.identity !== directLink.identity
      ? directLink.intent.status !== 'none' || directState.identity !== ''
      : directState.status === 'loading')
  const directError =
    directState.identity === directLink?.identity && directState.status === 'error'
  function dismissDirect() {
    directController.current?.abort()
    if (directLink) setDirectState({ identity: directLink.identity, status: 'done' })
  }
  const refreshDurations = useCallback(async () => {
    attempt.current = null
    setSlot(null)
    setBackToPicker(true)
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    setDurationRefresh({ status: 'loading' })
    try {
      const updated = oneTimeToken
        ? (await getOneTimeBookingPage(oneTimeToken, controller.signal)).eventType
        : await getEventType(handle, slug, controller.signal, team)
      if (controller.signal.aborted) return
      // Keep the invitee's draft in this flow while replacing stale choices and slots.
      setEvent(updated)
      setDurationMinutes(updated.durationMinutes)
      setNow(currentTime())
      setVersion((v) => v + 1)
      setDurationRefresh(null)
    } catch (err) {
      if (controller.signal.aborted) return
      if (codeOf(err) === 'event_type_not_found' || codeOf(err) === 'one_time_link_not_found')
        setGone(true)
      else setDurationRefresh({ status: 'error', message: failureMessage(err) })
    }
  }, [handle, slug, team, oneTimeToken])
  const loadSlots = useMemo<SlotLoader>(() => {
    const duration = hasDurationChoices || directFlow ? durationMinutes : undefined
    const load = oneTimeToken
      ? oneTimeLinkSlots(oneTimeToken, duration)
      : eventSlots(handle, slug, team, duration)
    return async (start, end, signal) => {
      try {
        return await load(start, end, signal)
      } catch (err) {
        if (!signal.aborted && codeOf(err) === 'one_time_link_not_found') {
          setGone(true)
          return []
        }
        if (
          signal.aborted ||
          !(err instanceof PublicRequestError) ||
          codeOf(err) !== 'invalid_duration'
        )
          throw err
        setNotice(
          directFlow
            ? 'This meeting length is no longer offered. Please choose a time again.'
            : bookingErrors(err, event.questions).form,
        )
        await refreshDurations()
        return []
      }
    }
  }, [
    handle,
    slug,
    team,
    oneTimeToken,
    durationMinutes,
    hasDurationChoices,
    directFlow,
    event.questions,
    refreshDurations,
  ])

  // Ordinary address links are read-only suggestions. Each navigation gets a fresh
  // public metadata/availability read, with an abort guard even if fetch ignores abort.
  // A manual edit consumes this intent; rerenders and picker refreshes cannot replay it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zone is presentation only; retry explicitly revalidates the same intent
  useEffect(() => {
    if (!directLink) return
    const { identity, intent } = directLink
    const controller = new AbortController()
    directController.current?.abort()
    directController.current = controller
    refreshController.current?.abort()
    setDurationRefresh(null)
    attempt.current = null
    setSlot(null)
    setConfirmed(null)
    setGone(false)
    setFormError(null)
    setNotice(null)
    const done = (message?: UiText) => {
      if (message) setNotice(message)
      setBackToPicker(intent.status !== 'none')
      setDirectState({ identity, status: 'done' })
    }
    if (intent.status === 'none') done()
    else if (intent.status === 'invalid')
      done('We could not use the time details in this link. Please choose a time.')
    else {
      setDirectState({ identity, status: 'loading' })
      // The picker independently bounds the restored date to its navigable window.
      const day = dateKeyIn(Date.parse(intent.start), timeZone)
      setPickerPosition(
        Date.parse(intent.start) >= currentTime() ? { month: monthOf(day), day } : null,
      )
      void (async () => {
        try {
          const updated = await getEventType(handle, slug, controller.signal, team)
          if (controller.signal.aborted) return
          setEvent(updated)
          const allowed = updated.allowedDurationsMinutes ?? [updated.durationMinutes]
          if (!allowed.includes(intent.durationMinutes)) {
            setDurationMinutes(updated.durationMinutes)
            done('This meeting length is no longer offered. Please choose a time again.')
            return
          }
          setDurationMinutes(intent.durationMinutes)
          const slots = await eventSlots(
            handle,
            slug,
            team,
            intent.durationMinutes,
          )(intent.start, intent.end, controller.signal)
          if (controller.signal.aborted) return
          const offered = slots.find(
            (candidate) =>
              Date.parse(candidate.start) === Date.parse(intent.start) &&
              Date.parse(candidate.end) === Date.parse(intent.end),
          )
          if (offered) {
            setSlot(offered)
            setDirectState({ identity, status: 'selected' })
          } else done('That time is no longer available. Please pick another one.')
        } catch (error) {
          if (controller.signal.aborted) return
          if (codeOf(error) === 'event_type_not_found') setGone(true)
          else if (codeOf(error) === 'invalid_duration') {
            done('This meeting length is no longer offered. Please choose a time again.')
            await refreshDurations()
          } else setDirectState({ identity, status: 'error' })
        }
      })()
    }
    return () => controller.abort()
  }, [directLink, directRetry, handle, slug, team, refreshDurations])

  // A suggested time is a preview, never a hold. Read normal availability before
  // opening the ordinary form; the booking transaction checks it again on submit.
  const [suggestion, setSuggestion] = useState(waitlist ? 'loading' : 'done')
  useEffect(() => {
    if (!waitlist) return
    if (!waitlistPreviewActive(waitlist, currentTime())) {
      setNotice('These suggestions have expired. Check the currently available times.')
      setSuggestion('done')
      return
    }
    const controller = new AbortController()
    setSuggestion('loading')
    loadWaitlistSuggestion(
      eventSlots(handle, slug, team),
      waitlist.start,
      initialEvent.durationMinutes,
      controller.signal,
    ).then(
      (offered) => {
        if (controller.signal.aborted) return
        if (!waitlistPreviewActive(waitlist, currentTime())) {
          setNotice('These suggestions have expired. Check the currently available times.')
          setSuggestion('done')
          return
        }
        if (offered) setSlot(offered)
        else setNotice('That time is no longer available. Please pick another one.')
        setSuggestion('done')
      },
      (error) => {
        if (controller.signal.aborted) return
        setNotice(failureMessage(error))
        setSuggestion('done')
      },
    )
    return () => controller.abort()
  }, [waitlist, handle, slug, team, initialEvent.durationMinutes])

  if (gone) return oneTimeToken ? <OneTimeLinkUnavailable /> : <PublicNotFound what="event" />
  if (confirmed && !directPending)
    return <Confirmation event={event} confirmed={confirmed} locale={locale} team={team} />

  function pick(chosen: Slot) {
    dismissDirect()
    // A different time starts a new intent, even if they later return to the old time.
    if (attempt.current && attempt.current.body.start !== chosen.start) attempt.current = null
    setSlot(chosen)
    setNotice(null)
    setFormError(null)
  }

  function changeTime() {
    if (inFlight.current) return
    dismissDirect()
    setSlot(null)
    setNow(currentTime())
    setBackToPicker(true)
  }

  async function submit() {
    if (!slot || inFlight.current || directPending || directError) return
    const guests = guestsFor(values.guests)
    const body: CreateBooking = {
      ...(embedded && { source: 'embed' as const }),
      start: slot.start,
      ...(waitlist && { waitlistToken: waitlist.token }),
      ...((hasDurationChoices || directFlow) && { durationMinutes }),
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
      const { result, replayed } = oneTimeToken
        ? await createOneTimeLinkBooking(oneTimeToken, attempt.current.body, attempt.current.key)
        : await createBooking(handle, slug, attempt.current.body, attempt.current.key, team)
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
          code === 'slot_taken' && !directFlow
            ? 'Someone else just booked that time. Please pick another one.'
            : 'That time is no longer available. Please pick another one.',
        )
        setNow(currentTime())
        setVersion((v) => v + 1)
      } else if (code === 'invalid_duration') {
        setNotice(
          directFlow
            ? 'This meeting length is no longer offered. Please choose a time again.'
            : bookingErrors(err, event.questions, values.guests).form,
        )
        await refreshDurations()
      } else if (code === 'event_type_not_found' || code === 'one_time_link_not_found') {
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
          <h1 className="event-title">{event.title}</h1>
          <div className="host-identity">
            {!team && <HostAvatar name={event.host.name} image={event.host.image} />}
            <p className="event-host">{event.team?.name ?? event.host.name}</p>
          </div>
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
            <li>{formatDuration(durationMinutes, displayLocale)}</li>
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
          {slot && !directPending && !directError && (
            <div className="chosen-time">
              {directFlow ? (
                <p>
                  {[slot.start, slot.end].map((instant, index) => (
                    <span key={instant}>
                      {index > 0 && (
                        <>
                          <br />
                          <span aria-hidden="true">– </span>
                        </>
                      )}
                      <time dateTime={instant}>
                        {t('{date}, {time}', {
                          date: formatDate(Date.parse(instant), timeZone, locale),
                          time: formatTime(Date.parse(instant), timeZone, locale),
                        })}
                      </time>
                      <span className="muted">
                        {t(' ({zone}, {offset})', {
                          zone: zoneName(timeZone),
                          offset: offsetLabel(timeZone, Date.parse(instant)),
                        })}
                      </span>
                    </span>
                  ))}
                </p>
              ) : (
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
              )}
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
          {waitlist && (
            <p className="muted">
              {t(
                'If you are still on the waitlist, you can keep waiting until your original deadline. No time is reserved.',
              )}
            </p>
          )}
          {directPending || directError ? (
            <section className="details-step" aria-label={t('Pick a time')}>
              <PublicStatus>
                {t(
                  directPending
                    ? 'Checking the suggested time…'
                    : 'We could not check this time. Please try again.',
                )}
              </PublicStatus>
              {directError && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setDirectRetry((value) => value + 1)}
                >
                  {t('Try again')}
                </button>
              )}
              <button type="button" className="button" onClick={changeTime} disabled={submitting}>
                {t('Change time')}
              </button>
            </section>
          ) : suggestion === 'loading' ? (
            <PublicStatus>{t('Loading…')}</PublicStatus>
          ) : durationRefresh ? (
            <section className="details-step" aria-labelledby="duration-refresh-heading">
              <FocusHeading level={2} id="duration-refresh-heading" className="step-title">
                {t('Pick a time')}
              </FocusHeading>
              <p role="status">{ui(notice)}</p>
              {durationRefresh.status === 'loading' ? (
                <PublicStatus>{t('Loading…')}</PublicStatus>
              ) : (
                <>
                  <p role="alert">{ui(durationRefresh.message)}</p>
                  <button type="button" className="button" onClick={refreshDurations}>
                    {t('Try again')}
                  </button>
                </>
              )}
            </section>
          ) : slot ? (
            <section className="details-step" aria-labelledby="details-heading">
              <FocusHeading level={2} id="details-heading" className="step-title">
                {t('Your details')}
              </FocusHeading>
              {directState.status === 'selected' && (
                <p role="status">
                  {t(
                    'The suggested time is selected. Review the details and confirm your booking.',
                  )}
                </p>
              )}
              {(prefill?.name || prefill?.email) && (
                <p className="hint">
                  {t('These details were filled in for convenience. You can change them.')}
                </p>
              )}
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
              durationMinutes={durationMinutes}
              afterTitle={
                hasDurationChoices ? (
                  <fieldset className="duration-picker">
                    <legend>{t('Meeting length')}</legend>
                    <div className="duration-options">
                      {event.allowedDurationsMinutes?.map((minutes) => (
                        <label key={minutes} className="duration-option">
                          <input
                            type="radio"
                            name="durationMinutes"
                            value={minutes}
                            checked={durationMinutes === minutes}
                            onChange={() => {
                              dismissDirect()
                              attempt.current = null
                              setSlot(null)
                              setDurationMinutes(minutes)
                              setNotice(null)
                              setFormError(null)
                            }}
                          />
                          <span>{formatDuration(minutes, displayLocale)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : undefined
              }
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
              noticeRole={directFlow ? 'status' : 'alert'}
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
  team,
}: {
  event: BookingEvent
  confirmed: Confirmed
  locale: string
  team: boolean
}) {
  const { t, text, ui, locale: language } = useI18n()

  usePageTitle('Booking confirmed')
  const redirectDescription = useId()
  const embedded = useEmbedded()
  const notified = useRef(false)
  useEffect(() => {
    if (
      embedded &&
      !notified.current &&
      confirmed.booking.source !== 'import' &&
      confirmed.booking.managementPolicy !== 'local_only_read_only'
    ) {
      notified.current = true
      notifyEmbedBooked()
    }
  }, [embedded, confirmed.booking.source, confirmed.booking.managementPolicy])
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
  if (booking.source === 'import' || booking.managementPolicy === 'local_only_read_only') {
    return (
      <PublicLayout>
        <PublicStatus>
          {t('This imported booking is read-only and managed in the original system.')}
        </PublicStatus>
      </PublicLayout>
    )
  }
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
        <div className="host-identity">
          {!team && !event.schedulingType && (
            <HostAvatar name={hostName} image={event.host.image} />
          )}
          <p className="event-host">{hostName}</p>
        </div>
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
            ...((event.allowedDurationsMinutes?.length ?? 0) > 1
              ? ([
                  [
                    'Meeting length',
                    formatDuration(
                      Math.round((Date.parse(booking.end) - Date.parse(booking.start)) / 60_000),
                      language,
                    ),
                  ],
                ] as [string, string][])
              : []),
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
              booking={booking}
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
            <ManageLink
              booking={booking}
              token={manageToken}
              intro={t('Use this link to reschedule or cancel.')}
            />
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
        {booking.status === 'confirmed' && confirmed.successRedirect && (
          <div className="confirmation-secondary stack">
            <p>
              {t('Keep your booking details and link before continuing to the host’s website.')}
            </p>
            <p>
              <a
                className="button button-primary"
                href={confirmed.successRedirect.url}
                aria-describedby={redirectDescription}
                target={
                  embedded
                    ? confirmed.successRedirect.allowEmbedParent && embedParentRedirectAllowed()
                      ? '_top'
                      : '_blank'
                    : undefined
                }
                rel="noopener noreferrer"
              >
                {t('Continue to {host}', { host: new URL(confirmed.successRedirect.url).host })}
              </a>
            </p>
            <p className="hint" id={redirectDescription}>
              {t(
                embedded
                  ? confirmed.successRedirect.allowEmbedParent && embedParentRedirectAllowed()
                    ? 'Opens the host’s website in the parent page.'
                    : 'Opens the host’s website in a new tab.'
                  : 'Opens the host’s website in this tab.',
              )}
            </p>
          </div>
        )}
        <CreateBookingLink />
      </div>
    </PublicLayout>
  )
}
